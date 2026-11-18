"""Atlas endpoints: slices, lookups, highlights, search, ontology, meshes
and the 3D click volume."""
import io
import base64
import json as _json
import json
import re
from functools import lru_cache
from pathlib import Path
import numpy as np
from PIL import Image
from flask import Blueprint, request, jsonify, send_from_directory, Response, abort
from extensions import limiter
from common import (_DEBUG_ERRORS, _check_rapid, _json_body, _rapid_group, _rapid_lookup, _safe_error_response, log)
from atlas import (LEVEL_COLS, VIEW_CFG, _MAX_PIDX, _MESH_LUT, _acro_to_term_id, _id_to_label, _collect_leaf_indices, _hist_bbox, _hist_centroid_by_slice, _indices_with_voxels, _load_mesh_volume, _mesh_volume_missing_response, _name_to_term_id, _pidx_to_sid, _render_size_cache, _term_label_to_indices, _term_nodes, _x_hist, acronym_df, annotation_array, color_df, get_hex_for_index, get_slices, name_df, render_to_b64, term_df, world_coords)
from enrichment import (_get_functional_keywords, _get_region_summary, _get_related_regions)

bp = Blueprint('atlas', __name__)

# ── 3D mesh endpoint ──────────────────────────────────────────────────────────
# Serves CCFv3 structure meshes from the local ./meshes/ folder, as .glb —
# a compact binary 3D file format. Allen only publishes these as the much
# larger, plain-text .obj format; _ensure_meshes() (below) downloads that and
# converts it to .glb right away, and convert_meshes_to_glb.py does the same
# one-off conversion for files that were already downloaded previously.
@bp.route('/meshes/<int:struct_id>.glb')
@limiter.exempt   # static files: not worth rate limiting, and a page load fetches many
def serve_mesh(struct_id):
    meshes_dir = Path(__file__).parent / 'meshes'
    fname = f'{struct_id}.glb'
    if not (meshes_dir / fname).exists():
        return jsonify({'error': f'mesh {struct_id} not available'}), 404
    # These almost never change once downloaded, so let browsers reuse their
    # own copy for a day instead of asking again on every visit. Not marked
    # "keep forever" like the website's own files above, since a mesh could
    # in theory get regenerated under the same filename.
    return send_from_directory(meshes_dir, fname, mimetype='model/gltf-binary', max_age=86400)


@bp.route('/api/log_warning', methods=['POST'])
def log_warning():
    data  = _json_body()
    # Anyone can call this, so keep what reaches the log short and on one
    # line (a newline in `label` could otherwise fake extra log entries).
    def clean(v, n):
        return re.sub('\\s+', ' ', str(v))[:n]
    kind  = clean(data.get('kind',  'click'), 40)
    label = clean(data.get('label', '?'), 120)
    try:
        count = int(data.get('count', 0))
    except (TypeError, ValueError):
        count = 0
    log.warning(f'Rapid {kind} — "{label}" blocked after {count} rapid requests')
    return jsonify({'ok': True})

# Remembers the last 256 rendered slice pictures (keyed by which view, which
# slice number, and which color mode) so re-visiting a slice the user has
# already looked at (e.g. dragging the slider back and forth) can hand back
# the picture already made instead of redrawing it from scratch every time.
# The website always adds a "don't use your own cached copy" marker to these
# requests (needed for other reasons — cancelling in-flight requests while
# the slider is being dragged), so this is the only place that actually
# avoids repeating that work.
@lru_cache(maxsize=256)
def _render_slice_cached(view, idx, colorize_level):
    tmpl, bnd, annot = get_slices(view, idx)
    fw, fh = VIEW_CFG[view]['figsize']
    img_b64, render_w, render_h = render_to_b64(tmpl, bnd, annot, colorize_level, fw, fh)
    rows, cols = tmpl.shape
    return img_b64, render_w, render_h, rows, cols

@bp.route('/api/slice')
def get_slice():
    view = request.args.get('view', 'sagittal').lower()
    if view not in VIEW_CFG:
        return jsonify({'error': f'view must be one of {list(VIEW_CFG)}'}), 400

    colorize_level = request.args.get('colorize', 'off').lower()
    if colorize_level not in ('off', 'structure', 'substructure', 'division'):
        colorize_level = 'structure'
    max_idx = VIEW_CFG[view]['max']
    try:
        idx = int(request.args.get('idx', max_idx // 2))
    except (TypeError, ValueError):
        return jsonify({'error': 'invalid idx'}), 400
    idx = max(0, min(idx, max_idx))

    try:
        img_b64, render_w, render_h, rows, cols = _render_slice_cached(view, idx, colorize_level)
        _render_size_cache[(view, idx)] = (render_w, render_h)  # cache for highlight endpoint
    except Exception as e:
        return _safe_error_response(e)

    return jsonify({
        'image':    f'data:image/png;base64,{img_b64}',
        'view':     view,
        'idx':      idx,
        'rows':     rows,
        'cols':     cols,
        'render_w': render_w,
        'render_h': render_h,
    })


@bp.route('/api/lookup', methods=['POST'])
def lookup():
    data = _json_body()
    try:
        view = data['view'].lower()
        idx  = int(data['idx'])
        col  = int(data['col'])
        row  = int(data['row'])
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'view, idx, col, row required'}), 400

    if view not in VIEW_CFG:
        return jsonify({'error': 'invalid view'}), 400

    _, _, annot = get_slices(view, idx)
    arr_rows, arr_cols = annot.shape

    if col < 0 or col >= arr_cols or row < 0 or row >= arr_rows:
        return jsonify({'error': 'coordinates out of bounds'}), 400

    parcellation_index = int(annot[row, col])
    xi, yi, zi = world_coords(view, idx, col, row)

    base = {
        'view': view, 'idx': idx, 'col': col, 'row': row,
        'xi': xi, 'yi': yi, 'zi': zi,
        'parcellation_index': parcellation_index,
        'structure_id': _pidx_to_sid.get(parcellation_index, 0),
    }

    # Attach per-level colors for this region
    colors = {}
    for level, colname in LEVEL_COLS.items():
        try:
            colors[f'{level}_color'] = color_df.loc[parcellation_index, colname]
        except KeyError:
            colors[f'{level}_color'] = '#444444'

    try:
        r = name_df.loc[parcellation_index]
        hier = ['organ','category','division','structure','substructure']
        result = {**base, **colors,
            'organ':        str(r.get('organ',        '—')),
            'category':     str(r.get('category',     '—')),
            'division':     str(r.get('division',     '—')),
            'structure':    str(r.get('structure',    '—')),
            'substructure': str(r.get('substructure', '—')),
        }
        # Add acronyms if available
        if acronym_df is not None and parcellation_index in acronym_df.index:
            a = acronym_df.loc[parcellation_index]
            for f in hier:
                result[f + '_acronym'] = str(a.get(f, ''))

        # matched_label / matched_acronym = most specific non-empty level
        matched_name  = '—'
        matched_acro  = '—'
        for f in reversed(hier):
            v = result.get(f, '—')
            if v and v != '—':
                matched_name = v
                matched_acro = result.get(f + '_acronym', '—') or '—'
                break
        result['matched_label']   = matched_name
        result['matched_acronym'] = matched_acro

        # ── Region enrichment: functional summary, keywords, related regions ─
        # Reads curated brain_regions_kb.json and (as fallback) the persistent
        # AI cache populated by /api/enrich. No live OpenAI calls here — that
        # would block the click. If neither source has an entry yet, the fields
        # come back empty and the frontend fires /api/enrich asynchronously
        # to fill them in.
        result["region_summary"] = _get_region_summary(
            parcellation_index=parcellation_index,
            region_name=matched_name,
            region_acronym=matched_acro,
        )
        result["functional_keywords"] = _get_functional_keywords(
            parcellation_index=parcellation_index,
            region_name=matched_name,
            region_acronym=matched_acro,
        )
        result["related_regions"] = _get_related_regions(
            parcellation_index=parcellation_index,
            region_name=matched_name,
            region_acronym=matched_acro,
        )

        _check_rapid(_rapid_lookup, parcellation_index, matched_name, 'lookup')
        log.info(f'lookup ok — pidx={parcellation_index} name={matched_name}')
        return jsonify(result)
    except KeyError:
        log.warning(f'lookup — no region for parcellation_index={parcellation_index}')
        return jsonify({**base, **colors,
                        'error': f'No region for index {parcellation_index}'})
    except Exception as e:
        return _safe_error_response(e)


# ── Diagnostic: compare a mesh's vertex bounding box vs the voxel
#    bounding box of the same structure in the annotation volume. Used to
#    investigate the offset observed between region meshes and plane voxels.
# GET /api/debug_mesh_alignment?struct_id=672
@bp.route('/api/debug_mesh_alignment')
def debug_mesh_alignment():
    if not _DEBUG_ERRORS:   # developer-only diagnostic; hidden unless FLASK_DEBUG=1
        abort(404)
    try:
        sid = int(request.args.get('struct_id', '672'))  # default = CP
    except ValueError:
        return jsonify({'error': 'struct_id must be an integer'}), 400

    meshes_dir = Path(__file__).parent / 'meshes'
    mesh_path = meshes_dir / f'{sid}.glb'
    if not mesh_path.exists():
        return jsonify({'error': f'mesh {sid} not on disk'}), 404

    # 1) Get the mesh's vertex bounding box. .glb is a binary format, so we
    # load it properly with trimesh instead of reading it as text.
    import trimesh
    mesh = trimesh.load(mesh_path, force='mesh')
    if len(mesh.vertices) == 0:
        return jsonify({'error': 'no vertices parsed'}), 500
    (x_min, y_min, z_min), (x_max, y_max, z_max) = mesh.bounds
    mesh_bounds = {
        'x_min': float(x_min), 'x_max': float(x_max),
        'y_min': float(y_min), 'y_max': float(y_max),
        'z_min': float(z_min), 'z_max': float(z_max),
        'vertex_count': len(mesh.vertices),
    }

    # 2) Find all parcellation_indices for this struct_id via MBA:sid → term label → pidxs
    pidxs = []
    mba = f'MBA:{sid}'
    try:
        # _id_to_label maps "MBA:672" → "AllenCCF-Ontology-2017: Caudoputamen"
        label = _id_to_label.get(mba)
        if label and label in _term_label_to_indices:
            pidxs = sorted(_term_label_to_indices[label])
    except NameError:
        pass

    # Fallback: any pidx where the structure_color lookup works via color_df
    # (color_df is indexed by parcellation_index). We also try directly
    # scanning `term_df` for matching identifier → label → indices.
    if not pidxs:
        try:
            rows = term_df[term_df['identifier'].astype(str).str.strip() == mba]
            labels = rows['label'].astype(str).str.strip().tolist()
            for lab in labels:
                if lab in _term_label_to_indices:
                    pidxs.extend(_term_label_to_indices[lab])
            pidxs = sorted(set(pidxs))
        except Exception:
            pass

    # 3) Compute voxel bounding box for all matching parcellation_indices
    voxel_bounds = None
    if pidxs:
        member_arr = np.array(pidxs, dtype=annotation_array.dtype)
        bbox = _hist_bbox(member_arr)
        if bbox:
            x_min, x_max, y_min, y_max, z_min, z_max = bbox
            voxel_bounds = {
                # Voxel indices
                'vox_x_min': int(x_min), 'vox_x_max': int(x_max),
                'vox_y_min': int(y_min), 'vox_y_max': int(y_max),
                'vox_z_min': int(z_min), 'vox_z_max': int(z_max),
                # Converted to µm assuming 10µm voxels
                'um_x_min': int(x_min) * 10, 'um_x_max': int(x_max) * 10,
                'um_y_min': int(y_min) * 10, 'um_y_max': int(y_max) * 10,
                'um_z_min': int(z_min) * 10, 'um_z_max': int(z_max) * 10,
                'voxel_count': int(_x_hist[:, member_arr].sum()),
            }

    # 4) Report differences if we have both
    comparison = None
    if voxel_bounds:
        comparison = {
            'mesh_minus_voxel_um': {
                'x_min_diff': mesh_bounds['x_min'] - voxel_bounds['um_x_min'],
                'x_max_diff': mesh_bounds['x_max'] - voxel_bounds['um_x_max'],
                'y_min_diff': mesh_bounds['y_min'] - voxel_bounds['um_y_min'],
                'y_max_diff': mesh_bounds['y_max'] - voxel_bounds['um_y_max'],
                'z_min_diff': mesh_bounds['z_min'] - voxel_bounds['um_z_min'],
                'z_max_diff': mesh_bounds['z_max'] - voxel_bounds['um_z_max'],
            },
            'mesh_size_vs_voxel_size_um': {
                'x_size_ratio': (mesh_bounds['x_max'] - mesh_bounds['x_min']) /
                                max(1, voxel_bounds['um_x_max'] - voxel_bounds['um_x_min']),
                'y_size_ratio': (mesh_bounds['y_max'] - mesh_bounds['y_min']) /
                                max(1, voxel_bounds['um_y_max'] - voxel_bounds['um_y_min']),
                'z_size_ratio': (mesh_bounds['z_max'] - mesh_bounds['z_min']) /
                                max(1, voxel_bounds['um_z_max'] - voxel_bounds['um_z_min']),
            },
        }

    return jsonify({
        'struct_id': sid,
        'mesh_bounds': mesh_bounds,
        'matching_parcellation_indices': pidxs,
        'voxel_bounds': voxel_bounds,
        'comparison': comparison,
    })


# ── Resolve a compact index from the mesh volume (3D click path) ──
# The mesh volume stores compact indices 1..N; meta['idx_to_sid'] maps to real
# Allen structure_ids. Takes either `idx` (compact) or `sid` (raw).
@bp.route('/api/resolve_structure_id')
def resolve_structure_id():
    try:
        sid_arg = request.args.get('sid', '').strip()
        idx_arg = request.args.get('idx', '').strip()
    except Exception:
        return jsonify({'error': 'bad args'}), 400

    sid = None
    if idx_arg:
        # Compact index path
        try:
            idx = int(idx_arg)
        except ValueError:
            return jsonify({'error': 'idx must be an integer'}), 400
        mv = _load_mesh_volume()
        if mv is None:
            return _mesh_volume_missing_response()
        idx_to_sid = mv['meta'].get('idx_to_sid', [0])
        if 0 < idx < len(idx_to_sid):
            sid = int(idx_to_sid[idx])
        else:
            return jsonify({'error': f'idx {idx} out of range'}), 400
    elif sid_arg:
        try:
            sid = int(sid_arg)
        except ValueError:
            return jsonify({'error': 'sid must be an integer'}), 400
    else:
        return jsonify({'error': 'pass ?idx=N or ?sid=N'}), 400

    if sid is None or sid <= 0:
        return jsonify({'error': f'invalid sid={sid}'}), 400

    # Find a parcellation_index for this structure_id via MBA identifier
    pidx = None
    mba = f'MBA:{sid}'
    try:
        label = _id_to_label.get(mba)
        if label and label in _term_label_to_indices:
            candidates = sorted(_term_label_to_indices[label])
            if candidates:
                pidx = candidates[0]
    except NameError:
        pass

    if pidx is None:
        return jsonify({'error': f'no parcellation_index found for structure_id={sid}',
                        'structure_id': sid}), 404

    base = {'parcellation_index': pidx, 'structure_id': sid}
    colors = {}
    for level, colname in LEVEL_COLS.items():
        try:
            colors[f'{level}_color'] = color_df.loc[pidx, colname]
        except KeyError:
            colors[f'{level}_color'] = '#444444'
    try:
        r = name_df.loc[pidx]
        hier = ['organ','category','division','structure','substructure']
        result = {**base, **colors,
            'organ':        str(r.get('organ',        '—')),
            'category':     str(r.get('category',     '—')),
            'division':     str(r.get('division',     '—')),
            'structure':    str(r.get('structure',    '—')),
            'substructure': str(r.get('substructure', '—')),
        }
        if acronym_df is not None and pidx in acronym_df.index:
            a = acronym_df.loc[pidx]
            for f in hier:
                result[f + '_acronym'] = str(a.get(f, ''))
        matched_name, matched_acro = '—', '—'
        for f in reversed(hier):
            v = result.get(f, '—')
            if v and v != '—':
                matched_name = v
                matched_acro = result.get(f + '_acronym', '—') or '—'
                break
        result['matched_label']   = matched_name
        result['matched_acronym'] = matched_acro

        # Same fast enrichment as /api/lookup — reads curated KB + AI cache.
        # No live OpenAI calls; the frontend fires /api/enrich asynchronously
        # if fields come back empty.
        result["region_summary"] = _get_region_summary(
            parcellation_index=pidx,
            region_name=matched_name,
            region_acronym=matched_acro,
        )
        result["functional_keywords"] = _get_functional_keywords(
            parcellation_index=pidx,
            region_name=matched_name,
            region_acronym=matched_acro,
        )
        result["related_regions"] = _get_related_regions(
            parcellation_index=pidx,
            region_name=matched_name,
            region_acronym=matched_acro,
        )

        return jsonify(result)
    except KeyError:
        return jsonify({**base, **colors, 'error': f'No region for pidx {pidx}'})


# ── Resolve a parcellation_index directly (for 3D click via volume sampling)
# No view/idx/col/row indirection — caller already knows the pidx from sampling
# the volume on the client. Returns the same metadata as /api/lookup.
@bp.route('/api/resolve_parcellation')
def resolve_parcellation():
    try:
        pidx = int(request.args.get('pidx', '0'))
    except ValueError:
        return jsonify({'error': 'pidx must be an integer'}), 400
    if pidx <= 0:
        return jsonify({'error': 'pidx must be > 0', 'parcellation_index': pidx}), 400
    base = {'parcellation_index': pidx}
    colors = {}
    for level, colname in LEVEL_COLS.items():
        try:
            colors[f'{level}_color'] = color_df.loc[pidx, colname]
        except KeyError:
            colors[f'{level}_color'] = '#444444'
    try:
        r = name_df.loc[pidx]
        hier = ['organ','category','division','structure','substructure']
        result = {**base, **colors,
            'organ':        str(r.get('organ',        '—')),
            'category':     str(r.get('category',     '—')),
            'division':     str(r.get('division',     '—')),
            'structure':    str(r.get('structure',    '—')),
            'substructure': str(r.get('substructure', '—')),
        }
        if acronym_df is not None and pidx in acronym_df.index:
            a = acronym_df.loc[pidx]
            for f in hier:
                result[f + '_acronym'] = str(a.get(f, ''))
        matched_name, matched_acro = '—', '—'
        for f in reversed(hier):
            v = result.get(f, '—')
            if v and v != '—':
                matched_name = v
                matched_acro = result.get(f + '_acronym', '—') or '—'
                break
        result['matched_label']   = matched_name
        result['matched_acronym'] = matched_acro
        return jsonify(result)
    except KeyError:
        return jsonify({**base, **colors, 'error': f'No region for pidx {pidx}'})


# ── eBrain 3D slicing helper ──────────────────────────────────────────────────
# For a given view + slice index, return the list of unique parcellation indices
# present in that slice, along with their most-specific acronyms so the frontend
# can resolve them to Allen structure IDs and load the matching region meshes.
# GET /api/structures_in_slice?view=coronal&idx=660
@bp.route('/api/structures_in_slice')
def structures_in_slice():
    view = request.args.get('view', 'coronal').lower()
    try:
        idx = int(request.args.get('idx', '0'))
    except ValueError:
        return jsonify({'error': 'idx must be an integer'}), 400
    if view not in VIEW_CFG:
        return jsonify({'error': 'invalid view'}), 400

    try:
        _, _, annot = get_slices(view, idx)
    except Exception as e:
        return jsonify({'error': f'slice extraction failed: {e}'}), 500

    # Unique non-zero parcellation indices in this slice
    uniq = np.unique(annot)
    uniq = uniq[uniq > 0]

    items = []
    hier = ['substructure', 'structure', 'division', 'category', 'organ']
    for pidx in uniq.tolist():
        pidx = int(pidx)
        # Most specific non-empty acronym for this parcellation index
        acro = ''
        name = ''
        if acronym_df is not None and pidx in acronym_df.index:
            arow = acronym_df.loc[pidx]
            for f in hier:
                v = str(arow.get(f, '')).strip()
                if v and v != '—' and v != '--':
                    acro = v
                    break
        if pidx in name_df.index:
            nrow = name_df.loc[pidx]
            for f in hier:
                v = str(nrow.get(f, '')).strip()
                if v and v != '—' and v != '--':
                    name = v
                    break
        items.append({'parcellation_index': pidx, 'acronym': acro, 'name': name})

    return jsonify({
        'view': view, 'idx': idx,
        'count': len(items),
        'items': items,
    })


@bp.route('/api/highlight', methods=['POST'])
def highlight():
    data = _json_body()
    try:
        view   = data['view'].lower()
        idx    = int(data['idx'])
        target = int(data['parcellation_index'])
        level  = data.get('level', 'structure')
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'view, idx, parcellation_index required'}), 400

    if view not in VIEW_CFG:
        return jsonify({'error': 'invalid view'}), 400

    _, _, annot = get_slices(view, idx)
    rows, cols = annot.shape

    # In color mode, use purple so highlight stands out over the colorized atlas
    color_mode = bool(data.get('color_mode', False))
    if color_mode:
        r, g, b = 108, 52, 196  # muted dark purple
    else:
        hex_color = get_hex_for_index(target, level).lstrip('#')
        try:
            r = int(hex_color[0:2], 16)
            g = int(hex_color[2:4], 16)
            b = int(hex_color[4:6], 16)
        except Exception:
            r, g, b = 0, 212, 255

    # Build RGBA mask: muted dark fill + thick black outline
    region = (annot == target)

    from scipy.ndimage import binary_dilation, binary_erosion
    struct3 = np.ones((3, 3), dtype=bool)
    struct5 = np.ones((5, 5), dtype=bool)
    dilated = binary_dilation(region, structure=struct5, iterations=2)
    eroded  = binary_erosion(region,  structure=struct3, iterations=1)
    outline = dilated & ~eroded   # thick band around region boundary

    mask = np.zeros((rows, cols, 4), dtype=np.uint8)
    # Muted dark fill — alpha 180, darkened color
    mask[region]  = [r, g, b, 180]
    # Thick black outline
    mask[outline] = [10, 10, 10, 230]

    img = Image.fromarray(mask, 'RGBA')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    used_color = 'a020f0' if color_mode else hex_color
    return jsonify({'mask': f'data:image/png;base64,{base64.b64encode(buf.read()).decode()}',
                    'color': f'#{used_color}'})




@bp.route('/api/resolve_acronyms', methods=['POST'])
def resolve_acronyms():
    """
    POST { acronyms: [...] }
    Resolves a list of acronyms to parcellation_indices in one shot.
    Used for Allen-tree container nodes (e.g. Cerebrum) not in name_df.
    """
    data = _json_body()
    acros = {str(a).lower().strip() for a in (data.get('acronyms') or [])}
    if not acros:
        return jsonify({'parcellation_indices': [], 'count': 0})

    matched = set()
    hier_cols = ['organ', 'category', 'division', 'structure', 'substructure']

    if acronym_df is not None:
        for pidx in acronym_df.index:
            try:
                a = acronym_df.loc[pidx]
            except KeyError:
                continue
            for col in hier_cols:
                val = str(a.get(col, '') or '').lower().strip()
                if val and val in acros:
                    matched.add(int(pidx))
                    break

    return jsonify({'parcellation_indices': list(matched), 'count': len(matched)})


@bp.route('/api/highlight_indices', methods=['POST'])
def highlight_indices():
    data = _json_body()
    try:
        view    = data['view'].lower()
        idx     = int(data['idx'])
        indices = [int(i) for i in data['parcellation_indices']]
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'view, idx, parcellation_indices required'}), 400
    if view not in VIEW_CFG or not indices:
        return jsonify({'error': 'invalid input'}), 400

    _, _, annot = get_slices(view, idx)
    rows, cols = annot.shape
    member_arr = np.array(sorted(set(indices)), dtype=annot.dtype)
    in_group   = np.isin(annot, member_arr)

    from scipy.ndimage import binary_dilation, binary_erosion
    struct3  = np.ones((3, 3), dtype=bool)
    struct5  = np.ones((5, 5), dtype=bool)
    dilated  = binary_dilation(in_group, structure=struct5, iterations=2)
    eroded   = binary_erosion(in_group,  structure=struct3, iterations=1)
    outline  = dilated & ~eroded

    mask = np.zeros((rows, cols, 4), dtype=np.uint8)
    mask[in_group] = [108, 52, 196, 180]   # muted dark purple fill
    mask[outline]  = [10, 10, 10, 230]     # thick black outline

    img = Image.fromarray(mask, 'RGBA')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return jsonify({'mask': f'data:image/png;base64,{base64.b64encode(buf.read()).decode()}',
                    'color': '#6c34c4', 'member_count': len(indices)})


@bp.route('/api/region_center_indices', methods=['POST'])
def region_center_indices():
    data = _json_body()
    try:
        indices = [int(i) for i in data['parcellation_indices']]
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'parcellation_indices required'}), 400
    # Drop anything that couldn't possibly be a real parcellation_index before
    # it reaches the uint16 cast below — a negative or huge number there
    # raises OverflowError instead of just being "not found" like it should.
    indices = [i for i in indices if 0 <= i <= _MAX_PIDX]
    if not indices:
        return jsonify({'error': 'empty'}), 400

    member_arr = np.array(sorted(set(indices)), dtype=annotation_array.dtype)
    result = _hist_centroid_by_slice(member_arr)
    if result is None:
        return jsonify({'error': 'No voxels found'}), 404

    xi, yi, zi, voxel_count = result
    xi = max(0, min(xi, VIEW_CFG['sagittal']['max']))
    yi = max(0, min(yi, VIEW_CFG['transverse']['max']))
    zi = max(0, min(zi, VIEW_CFG['coronal']['max']))
    return jsonify({'xi': xi, 'yi': yi, 'zi': zi,
                    'voxel_count': voxel_count, 'member_count': len(indices)})


@bp.route('/api/group_by_term', methods=['POST'])
def group_by_term():
    """
    POST { name, acronym }
    Looks up the term in parcellation_term.csv tree, collects all leaf
    parcellation_indices under it, and returns centroid + member count.
    This is the ground-truth grouping path — works for ANY named term
    including container nodes like Cerebrum, Vermal regions, Piriform area.
    """
    data    = _json_body()
    name    = (data.get('name')    or '').strip()
    acronym = (data.get('acronym') or '').strip()

    # Find the term label (now _term_nodes is keyed by label)
    term_label = None
    if acronym:
        term_label = _acro_to_term_id.get(acronym.lower())
    if not term_label and name:
        term_label = _name_to_term_id.get(name.lower())
    if not term_label:
        return jsonify({'error': f'Term not found: {name or acronym}'}), 404

    indices = _collect_leaf_indices(term_label)
    if not indices:
        return jsonify({'error': f'No voxels found for {name or acronym}'}), 404

    _check_rapid(_rapid_group, term_label,
                 _term_nodes[term_label]['name'], 'hierarchy')
    return jsonify({
        'term_id':     term_label,
        'name':        _term_nodes[term_label]['name'],
        'acronym':     _term_nodes[term_label]['acronym'],
        'index_count': len(indices),
        'parcellation_indices': list(indices),
    })


@bp.route('/api/highlight_group', methods=['POST'])
def highlight_group():
    """
    POST { view, idx, group_level, group_name }
    Highlights ALL parcellation indices whose name_df[group_level] == group_name.
    Renders a semi-transparent purple fill so the underlying template is still
    readable, then draws bright boundary lines on top of the fill so internal
    region separations remain clearly visible.
    """
    data = _json_body()
    try:
        view       = data['view'].lower()
        idx        = int(data['idx'])
        group_lv   = data['group_level']
        group_name = data['group_name'].strip()
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'view, idx, group_level, group_name required'}), 400

    if view not in VIEW_CFG:
        return jsonify({'error': 'invalid view'}), 400
    if group_lv not in LEVEL_COLS:
        return jsonify({'error': f'group_level must be one of {list(LEVEL_COLS)}'}), 400

    col_name = group_lv
    if col_name not in name_df.columns:
        return jsonify({'error': f'column {group_lv} not in name table'}), 400

    member_mask    = name_df[col_name].fillna('').str.lower() == group_name.lower()
    member_indices = set(name_df.index[member_mask].tolist())

    if not member_indices:
        return jsonify({'error': f'No regions found for {group_lv}={group_name}'}), 404

    _, bnd, annot = get_slices(view, idx)
    rows, cols = annot.shape

    member_arr = np.array(sorted(member_indices), dtype=annot.dtype)
    in_group   = np.isin(annot, member_arr)

    from scipy.ndimage import binary_dilation, binary_erosion
    struct3  = np.ones((3, 3), dtype=bool)
    struct5  = np.ones((5, 5), dtype=bool)
    dilated  = binary_dilation(in_group, structure=struct5, iterations=2)
    eroded   = binary_erosion(in_group,  structure=struct3, iterations=1)
    outline  = dilated & ~eroded

    mask = np.zeros((rows, cols, 4), dtype=np.uint8)
    mask[in_group] = [108, 52, 196, 180]   # muted dark purple fill
    mask[outline]  = [10, 10, 10, 230]     # thick black outline

    img = Image.fromarray(mask, 'RGBA')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)

    return jsonify({
        'mask':  f'data:image/png;base64,{base64.b64encode(buf.read()).decode()}',
        'color': '#6c34c4',
        'member_count': len(member_indices),
    })


@bp.route('/api/debug_name')
def debug_name():
    if not _DEBUG_ERRORS:   # developer-only diagnostic; hidden unless FLASK_DEBUG=1
        abort(404)
    name = request.args.get('q','').strip().lower()
    result = {}
    for col in ['organ','category','division','structure','substructure']:
        if col not in name_df.columns:
            continue
        hits = name_df[name_df[col].fillna('').str.lower().str.contains(name, regex=False)]
        if not hits.empty:
            result[col] = hits[col].dropna().unique().tolist()[:20]
    # Also show full rows for exact match
    exact_rows = []
    for col in ['organ','category','division','structure','substructure']:
        if col not in name_df.columns:
            continue
        hits = name_df[name_df[col].fillna('').str.lower() == name]
        for idx, row in hits.iterrows():
            exact_rows.append({'parcellation_index': int(idx), **{c: str(row.get(c,'')) for c in ['organ','category','division','structure','substructure']}})
    result['_exact_rows'] = exact_rows[:10]
    return jsonify(result)


@bp.route('/api/find_group_level', methods=['POST'])
def find_group_level():
    """
    POST { name }
    Finds which hierarchy level (organ/category/division/structure/substructure)
    contains the given name, so the frontend can route to the correct group endpoint.
    Returns { group_level, group_name, member_count }.
    """
    data = _json_body()
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400

    name_lo = name.lower()
    hier_cols = ['organ', 'category', 'division', 'structure', 'substructure']

    # For each level, check if name_lo appears as a VALUE in a COARSER column
    # — meaning rows that BELONG TO this group as children.
    # e.g. "Piriform area" at structure level: look for rows where structure=="Piriform area"
    # and count how many distinct substructure values exist under it.
    for i, lv in enumerate(hier_cols):
        if lv not in name_df.columns:
            continue
        col_vals = name_df[lv].fillna('').str.lower()
        mask = col_vals == name_lo
        count = int(mask.sum())
        if count == 0:
            continue
        # Check if there are child rows at the next finer level
        if count > 1:
            # Multiple rows share this value → it's already a group at this level
            actual_name = name_df[lv][mask].iloc[0]
            return jsonify({'group_level': lv, 'group_name': actual_name, 'member_count': count})
        # count == 1: could be a leaf OR a parent with children at finer level
        # Check finer levels for child rows
        for child_lv in hier_cols[i+1:]:
            if child_lv not in name_df.columns:
                continue
            # Find all rows where parent level == name AND child level is populated
            child_mask = mask & name_df[child_lv].fillna('').ne('')
            child_count = int(child_mask.sum())
            if child_count > 1:
                actual_name = name_df[lv][mask].iloc[0]
                return jsonify({'group_level': lv, 'group_name': actual_name, 'member_count': child_count})

    return jsonify({'error': f'"{name}" not found in any hierarchy level'}), 404


@bp.route('/api/region_center_group', methods=['POST'])
def region_center_group():
    """
    POST { group_level, group_name }
    Finds the best slice indices to view a whole anatomical group (all member
    parcellation indices combined).  Returns xi, yi, zi, voxel_count, and the
    group colour.
    """
    data = _json_body()
    try:
        group_lv   = data['group_level']
        group_name = data['group_name'].strip()
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'group_level and group_name required'}), 400

    if group_lv not in LEVEL_COLS:
        return jsonify({'error': f'group_level must be one of {list(LEVEL_COLS)}'}), 400

    col_name = group_lv
    if col_name not in name_df.columns:
        return jsonify({'error': f'column {group_lv} not in name table'}), 400

    col_vals = name_df[col_name].fillna('').str.lower()
    member_mask = col_vals == group_name.lower()
    if member_mask.sum() == 0:
        # Fallback: startswith (handles minor naming differences)
        name_lo = group_name.lower()
        member_mask = col_vals.str.startswith(name_lo) | col_vals.str.startswith(name_lo.rstrip('s'))
    member_indices = set(int(i) for i in name_df.index[member_mask].tolist())

    if not member_indices:
        return jsonify({'error': f'No regions found for {group_lv}={group_name}'}), 404

    # Find all voxels belonging to any member
    member_arr = np.array(sorted(member_indices), dtype=annotation_array.dtype)
    result = _hist_centroid_by_slice(member_arr)

    if result is None:
        return jsonify({'error': 'No voxels found for this group'}), 404

    xi, yi, zi, voxel_count = result
    xi = max(0, min(xi, VIEW_CFG['sagittal']['max']))
    yi = max(0, min(yi, VIEW_CFG['transverse']['max']))
    zi = max(0, min(zi, VIEW_CFG['coronal']['max']))

    # Representative colour
    sample_idx = next(iter(member_indices))
    hex_color  = get_hex_for_index(sample_idx, group_lv)

    return jsonify({
        'xi': xi, 'yi': yi, 'zi': zi,
        'voxel_count':   voxel_count,
        'member_count':  len(member_indices),
        'group_level':   group_lv,
        'group_name':    group_name,
        f'{group_lv}_color': hex_color,
        'structure_color':   hex_color,
    })


@bp.route('/api/region_center', methods=['POST'])
def region_center():
    """
    POST { parcellation_index }
    Finds the centroid voxel (xi, yi, zi) of the given region in the annotation volume.
    Returns the best slice index for each view so the frontend can navigate to it.
    Also returns per-level colors for the region.
    """
    data = _json_body()
    try:
        target = int(data['parcellation_index'])
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'parcellation_index required'}), 400

    # Find the slice index that contains the MOST voxels of this region, for
    # each view. This guarantees the highlight will actually be visible
    # (a plain centroid can land on a thin slice with very few or zero
    # voxels for elongated structures).
    if target < 0 or target > _MAX_PIDX:
        return jsonify({'error': f'No voxels found for parcellation_index={target}'}), 404
    result = _hist_centroid_by_slice(np.array([target]))

    if result is None:
        return jsonify({'error': f'No voxels found for parcellation_index={target}'}), 404
    xi, yi, zi, voxel_count = result

    # Clamp to view bounds
    xi = max(0, min(xi, VIEW_CFG['sagittal']['max']))
    yi = max(0, min(yi, VIEW_CFG['transverse']['max']))
    zi = max(0, min(zi, VIEW_CFG['coronal']['max']))

    # Attach per-level colors
    colors = {}
    for level, colname in LEVEL_COLS.items():
        try:
            colors[f'{level}_color'] = color_df.loc[target, colname]
        except KeyError:
            colors[f'{level}_color'] = '#444444'

    # Attach names
    names = {}
    try:
        r = name_df.loc[target]
        for f in ['organ','category','division','structure','substructure']:
            names[f] = str(r.get(f, '—'))
    except KeyError:
        pass

    # Attach acronyms
    if acronym_df is not None and target in acronym_df.index:
        a = acronym_df.loc[target]
        for f in ['organ','category','division','structure','substructure']:
            names[f + '_acronym'] = str(a.get(f, ''))

    return jsonify({
        'parcellation_index': target,
        'xi': xi, 'yi': yi, 'zi': zi,
        'voxel_count': voxel_count,
        **colors, **names,
    })

@bp.route('/api/search')
def search():
    """
    GET /api/search?q=fiber+tracts&limit=50

    Two-tier results:
      1. GROUP entries  — when the query matches a parent-level column value
         (organ/category/division) that is NOT the most-specific level for any
         row.  These represent a whole anatomical group and are highlighted as
         such.  Returned with is_group=True, group_level, group_name.
      2. LEAF entries   — rows where the query matches the region's own
         most-specific label or acronym.  These are individual regions.

    Groups always sort above leaf matches so the intended target appears first.
    """
    q = request.args.get('q', '').strip()
    if len(q) < 1:
        return jsonify({'results': [], 'query': q})

    try:
        limit = max(1, min(int(request.args.get('limit', 50)), 200))
    except ValueError:
        return jsonify({'error': 'limit must be an integer'}), 400
    q_lower = q.lower()
    # Name matching: the region's own label must START with the query.
    # Acronym matching: must be exact or a prefix.
    # This mirrors the hierarchy search behaviour — left-to-right matching only.

    def name_matches(text):
        return text.lower().startswith(q_lower)

    def acro_matches(acro):
        a = acro.lower()
        return a == q_lower or a.startswith(q_lower)

    # Hierarchy coarse→fine
    hier_cols_asc  = ['organ', 'category', 'division', 'structure', 'substructure']
    # Hierarchy fine→coarse (for most-specific lookup)
    hier_cols_desc = list(reversed(hier_cols_asc))

    # ── Pre-build acronym lookup: level → {name.lower(): acronym} ────────────
    level_acronym = {lv: {} for lv in hier_cols_asc}
    if acronym_df is not None:
        for pidx in acronym_df.index:
            try:
                a   = acronym_df.loc[pidx]
                row = name_df.loc[pidx] if pidx in name_df.index else None
                if row is None:
                    continue
                for lv in hier_cols_asc:
                    nm = str(row.get(lv, '') or '').strip()
                    ac = str(a.get(lv, '') or '').strip()
                    if nm and ac:
                        level_acronym[lv][nm.lower()] = ac
            except Exception:
                pass

    # ── PASS 1 — find GROUP matches (parent levels) ───────────────────────────
    group_candidates = {}   # (level, name_lower) → {name, member_count, sample_idx, color}
    parent_levels = ['organ', 'category', 'division', 'structure']

    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue

        most_spec = None
        for col in hier_cols_desc:
            val = str(row.get(col, '') or '').strip()
            if val and val != '—':
                most_spec = col
                break
        if not most_spec:
            continue

        for lv in parent_levels:
            if lv == most_spec:
                continue
            val = str(row.get(lv, '') or '').strip()
            if not val or val == '—':
                continue
            acro = level_acronym[lv].get(val.lower(), '')
            if not name_matches(val) and not acro_matches(acro):
                continue
            key = (lv, val.lower())
            if key not in group_candidates:
                try:
                    grp_color = color_df.loc[parc_idx, f'{lv}_color']
                except KeyError:
                    grp_color = '#00d4ff'
                group_candidates[key] = {
                    'group_level':   lv,
                    'group_name':    val,
                    'group_acronym': acro,
                    'member_count':  0,
                    'sample_idx':    int(parc_idx),
                    'structure_color': grp_color,
                }
            # Only count rows that actually have voxels -- otherwise this
            # raw count (used whenever the term tree below doesn't have a
            # match for this group name) can overstate how many regions a
            # group really has, inconsistently with the term-tree path a
            # few lines down, which already filters by _indices_with_voxels.
            if int(parc_idx) in _indices_with_voxels:
                group_candidates[key]['member_count'] += 1

    # Use term tree for accurate leaf counts where available
    for _key, g in group_candidates.items():
        term_label = _name_to_term_id.get(g['group_name'].lower())
        if term_label:
            indices = _collect_leaf_indices(term_label)
            real_count = len(indices & _indices_with_voxels)
            if real_count > 0:
                g['member_count'] = real_count

    group_results = []
    for key, g in group_candidates.items():
        lv, name_lo = key
        acro = g['group_acronym']
        # Skip groups with only 1 member — they'll appear as leaves in pass 2
        if g['member_count'] <= 1:
            continue
        if acro.lower() == q_lower or name_lo == q_lower:
            rank = 0
        elif acro.lower().startswith(q_lower) or name_lo.startswith(q_lower):
            rank = 1
        else:
            rank = 2
        group_results.append({
            'is_group':       True,
            'group_level':    lv,
            'group_name':     g['group_name'],
            'group_acronym':  acro,
            'member_count':   g['member_count'],
            'parcellation_index': g['sample_idx'],
            'structure_color':   g['structure_color'],
            'matched_label':  g['group_name'],
            'matched_acronym': acro,
            'matched_level':  lv,
            'organ':    '—', 'category': '—', 'division': '—',
            'structure': '—', 'substructure': '—',
            '_rank': rank,
        })

    # Also search the term tree directly for acronym matches (catches CNU, etc.)
    # that may not appear via name_df column scanning
    for term_label, node in _term_nodes.items():
        acro = node['acronym']
        nm   = node['name']
        if not acro and not nm:
            continue
        if not acro_matches(acro) and not name_matches(nm):
            continue
        # Only add if has children (otherwise it's a leaf, handled in pass 2)
        if not node['children']:
            continue
        indices = _collect_leaf_indices(term_label)
        real_count = len(indices & _indices_with_voxels)
        if real_count <= 1:
            continue
        key = ('term', nm.lower())
        if any(g['group_name'].lower() == nm.lower() for g in group_results):
            continue  # already found via name_df
        try:
            sample_idx = next(iter(indices & _indices_with_voxels))
            grp_color  = color_df.loc[sample_idx, 'division_color']
        except (StopIteration, KeyError):
            grp_color  = '#00d4ff'
        if acro.lower() == q_lower or nm.lower() == q_lower:
            rank = 0
        elif acro.lower().startswith(q_lower) or nm.lower().startswith(q_lower):
            rank = 1
        else:
            rank = 2
        group_results.append({
            'is_group':       True,
            'group_level':    'term',
            'group_name':     nm,
            'group_acronym':  acro,
            'member_count':   real_count,
            'parcellation_index': int(sample_idx),
            'structure_color': grp_color,
            'matched_label':  nm,
            'matched_acronym': acro,
            'matched_level':  'term',
            'organ':    '—', 'category': '—', 'division': '—',
            'structure': '—', 'substructure': '—',
            '_rank': rank,
        })

    group_results.sort(key=lambda r: (r['_rank'], r['group_name']))

    # ── PASS 2 — find LEAF matches (most-specific level) ─────────────────────
    leaf_results  = []
    seen_label    = set()

    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue

        most_specific_col  = None
        most_specific_name = ''
        for col in hier_cols_desc:
            val = str(row.get(col, '') or '').strip()
            if val and val != '—':
                most_specific_col  = col
                most_specific_name = val
                break
        if not most_specific_col:
            continue

        acronyms = {}
        most_specific_acronym = ''
        if acronym_df is not None and parc_idx in acronym_df.index:
            a = acronym_df.loc[parc_idx]
            for f in hier_cols_asc:
                acronyms[f + '_acronym'] = str(a.get(f, '') or '')
            most_specific_acronym = str(a.get(most_specific_col, '') or '').strip()

        name_hit = name_matches(most_specific_name)
        acro_hit = most_specific_acronym and acro_matches(most_specific_acronym)
        if not name_hit and not acro_hit:
            continue

        dedup_key = (most_specific_name.lower(), most_specific_acronym.lower())
        if dedup_key in seen_label:
            continue
        seen_label.add(dedup_key)

        try:
            struct_color = color_df.loc[parc_idx, f'{most_specific_col}_color']
        except KeyError:
            try:
                struct_color = color_df.loc[parc_idx, 'structure_color']
            except KeyError:
                struct_color = '#444444'

        leaf_results.append({
            'is_group':     False,
            'no_voxels':    int(parc_idx) not in _indices_with_voxels,
            'parcellation_index': int(parc_idx),
            'organ':        str(row.get('organ',        '') or '—'),
            'category':     str(row.get('category',     '') or '—'),
            'division':     str(row.get('division',     '') or '—'),
            'structure':    str(row.get('structure',    '') or '—'),
            'substructure': str(row.get('substructure', '') or '—'),
            'structure_color':    struct_color,
            'matched_label':      most_specific_name,
            'matched_acronym':    most_specific_acronym,
            'matched_level':      most_specific_col,
            **acronyms,
        })

    # (No early-exit cap here.) There used to be a `break` once leaf_results
    # hit limit*3, but it ran during this raw, unsorted scan of name_df --
    # before leaf_sort_key below ever runs. For a query with more matches
    # than that cap, whichever rows happened to sit later in name_df's
    # storage order could get silently dropped before they were ever
    # considered for ranking, even if one of them was the actual exact
    # match. Pass 1 above already scans all of name_df unconditionally, so
    # this isn't a new cost -- just bringing pass 2 in line with it.

    def leaf_sort_key(r):
        name    = r['matched_label'].lower()
        acro    = r['matched_acronym'].lower()
        no_vox  = 1 if r.get('no_voxels') else 0   # 0 = has voxels (sorts first)
        if acro == q_lower or name == q_lower:
            return (no_vox, 0, name)
        if acro.startswith(q_lower) or name.startswith(q_lower):
            return (no_vox, 1, name)
        if q_lower in acro:
            return (no_vox, 2, name)
        return                                                  (no_vox, 3, name)

    leaf_results.sort(key=leaf_sort_key)

    # Groups first, then leaves (has-voxels before no-voxels) -- but groups
    # aren't capped in number, so a broad query (e.g. a single letter) can
    # produce more group matches than `limit` and crowd out every individual
    # region: a search for "p" was returning 35 groups and only 15 of the
    # 158 matching regions, all clustered at the start of the alphabet.
    # Reserving at least half of `limit` for leaves guarantees individual
    # regions always show up alongside groups instead of only when few
    # enough groups happen to match.
    max_group_slots = limit - max(1, limit // 2)
    group_slice = group_results[:max_group_slots]
    leaf_slice  = leaf_results[:limit - len(group_slice)]
    combined = group_slice + leaf_slice
    return jsonify({'results': combined, 'query': q, 'total': len(combined)})




@bp.route('/api/resolve_region', methods=['GET'])
def resolve_region():
    """
    GET /api/resolve_region?name=hippocampus

    Dedicated endpoint for the semantic region parser (chat region cloud).
    Given a candidate name extracted from AI text, finds the single best
    matching atlas region — prioritising group matches over leaf matches.

    Priority order:
      1. Exact group_name match (whole anatomical group → highlight_indices)
      2. Exact acronym match (group or leaf)
      3. Exact leaf match on any hierarchy column (structure/substructure/division)
      4. Term-tree node exact name or acronym match with children (→ group)
      5. Prefix match on group_name (≥5 chars)
      6. Prefix match on leaf name (≥5 chars)
      7. Substring match covering >45% of leaf name (≥5 chars)

    Returns one result object (same schema as /api/search results) or {} if no match.
    """
    name = request.args.get('name', '').strip()
    if len(name) < 2:
        return jsonify({})

    lo = name.lower()

    # ── Helper: build a group result dict from term-tree node ─────────────────
    def term_node_result(term_label, node):
        indices = _collect_leaf_indices(term_label)
        real_count = len(indices & _indices_with_voxels)
        if real_count == 0:
            return None
        try:
            sample_idx = next(iter(indices & _indices_with_voxels))
            grp_color  = color_df.loc[sample_idx, 'division_color']
        except (StopIteration, KeyError):
            grp_color  = '#00d4ff'
        return {
            'is_group':     True,
            'group_level':  'term',
            'group_name':   node['name'],
            'group_acronym': node['acronym'],
            'member_count': real_count,
            'parcellation_index': int(sample_idx),
            'structure_color': grp_color,
            'matched_label': node['name'],
            'matched_acronym': node['acronym'],
            'matched_level': 'term',
            'organ': '—', 'category': '—', 'division': '—',
            'structure': '—', 'substructure': '—',
            'parcellation_indices': list(indices & _indices_with_voxels),
        }

    # ── Helper: build a leaf result dict from name_df row ────────────────────
    def leaf_result(parc_idx):
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            return None
        hier_cols = ['organ','category','division','structure','substructure']
        most_spec = None
        most_name = ''
        for col in reversed(hier_cols):
            v = str(row.get(col,'') or '').strip()
            if v and v != '—':
                most_spec = col
                most_name = v
                break
        if not most_spec:
            return None
        most_acro = ''
        if acronym_df is not None and parc_idx in acronym_df.index:
            most_acro = str(acronym_df.loc[parc_idx].get(most_spec,'') or '').strip()
        try:
            struct_color = color_df.loc[parc_idx, f'{most_spec}_color']
        except KeyError:
            struct_color = '#444444'
        return {
            'is_group': False,
            'parcellation_index': int(parc_idx),
            'matched_label': most_name,
            'matched_acronym': most_acro,
            'matched_level': most_spec,
            'structure_color': struct_color,
            'organ':        str(row.get('organ','') or '—'),
            'category':     str(row.get('category','') or '—'),
            'division':     str(row.get('division','') or '—'),
            'structure':    str(row.get('structure','') or '—'),
            'substructure': str(row.get('substructure','') or '—'),
        }

    hier_cols = ['organ','category','division','structure','substructure']

    # ── P1: Exact group match from name_df parent columns ────────────────────
    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue
        for lv in ['category','division','structure']:
            val = str(row.get(lv,'') or '').strip()
            if val.lower() == lo:
                # Find all members of this group
                member_mask = name_df[lv].fillna('').str.lower() == lo
                member_indices = list(set(name_df.index[member_mask].tolist()) & _indices_with_voxels)
                if len(member_indices) <= 1:
                    break
                try:
                    grp_color = color_df.loc[parc_idx, f'{lv}_color']
                except KeyError:
                    grp_color = '#00d4ff'
                acro = ''
                if acronym_df is not None and parc_idx in acronym_df.index:
                    acro = str(acronym_df.loc[parc_idx].get(lv,'') or '').strip()
                return jsonify({
                    'is_group': True,
                    'group_level': lv,
                    'group_name': val,
                    'group_acronym': acro,
                    'member_count': len(member_indices),
                    'parcellation_index': int(parc_idx),
                    'structure_color': grp_color,
                    'matched_label': val,
                    'matched_acronym': acro,
                    'matched_level': lv,
                    'organ': '—', 'category': '—', 'division': '—',
                    'structure': '—', 'substructure': '—',
                })

    # ── P2: Exact acronym match on any leaf column ────────────────────────────
    if acronym_df is not None:
        for parc_idx in acronym_df.index:
            try:
                a = acronym_df.loc[parc_idx]
            except KeyError:
                continue
            for col in hier_cols:
                if str(a.get(col,'') or '').strip().lower() == lo:
                    r = leaf_result(parc_idx)
                    if r:
                        return jsonify(r)

    # ── P3: Exact leaf name match on most-specific column ────────────────────
    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue
        for col in reversed(hier_cols):
            val = str(row.get(col,'') or '').strip()
            if val.lower() == lo:
                r = leaf_result(parc_idx)
                if r:
                    return jsonify(r)
                break

    # ── P4: Term-tree exact name or acronym (finds container groups) ──────────
    term_label = _name_to_term_id.get(lo) or _acro_to_term_id.get(lo)
    if term_label:
        node = _term_nodes.get(term_label)
        if node and node['children']:
            r = term_node_result(term_label, node)
            if r:
                return jsonify(r)

    # ── P5: Prefix match on group names (≥5 chars) ────────────────────────────
    if len(lo) >= 5:
        for lv in ['division','structure','category']:
            if lv not in name_df.columns:
                continue
            for val in name_df[lv].dropna().unique():
                if str(val).lower().startswith(lo):
                    member_mask = name_df[lv].fillna('').str.lower() == str(val).lower()
                    member_indices = list(set(name_df.index[member_mask].tolist()) & _indices_with_voxels)
                    if len(member_indices) <= 1:
                        continue
                    sample_idx = member_indices[0]
                    try:
                        grp_color = color_df.loc[sample_idx, f'{lv}_color']
                    except KeyError:
                        grp_color = '#00d4ff'
                    return jsonify({
                        'is_group': True,
                        'group_level': lv,
                        'group_name': str(val),
                        'group_acronym': '',
                        'member_count': len(member_indices),
                        'parcellation_index': int(sample_idx),
                        'structure_color': grp_color,
                        'matched_label': str(val),
                        'matched_acronym': '',
                        'matched_level': lv,
                        'organ': '—', 'category': '—', 'division': '—',
                        'structure': '—', 'substructure': '—',
                    })

    # ── P6: Prefix match on leaf names (≥5 chars) ────────────────────────────
    if len(lo) >= 5:
        for parc_idx in name_df.index:
            try:
                row = name_df.loc[parc_idx]
            except KeyError:
                continue
            for col in reversed(hier_cols):
                val = str(row.get(col,'') or '').strip()
                if val.lower().startswith(lo):
                    r = leaf_result(parc_idx)
                    if r:
                        return jsonify(r)
                    break

    # ── P7: Substring match covering >45% of leaf name ───────────────────────
    if len(lo) >= 5:
        for parc_idx in name_df.index:
            try:
                row = name_df.loc[parc_idx]
            except KeyError:
                continue
            for col in reversed(hier_cols):
                val = str(row.get(col,'') or '').strip().lower()
                if val and lo in val and len(lo)/len(val) > 0.45:
                    r = leaf_result(parc_idx)
                    if r:
                        return jsonify(r)
                    break

    return jsonify({})

@bp.route('/api/ontology')
def get_ontology():
    """
    Fetches the full Allen CCFv3 mouse brain structure tree from the Allen API
    and enriches each node with the official atlas color from our local color_df.
    The tree is fetched once, cached in memory, and served to the frontend.
    GET /api/ontology
    Returns the full JSON structure graph (id=1, Mouse Brain Atlas).
    """
    import urllib.request as _urlreq

    # ── In-memory cache so we only hit the Allen API once per server run ──────
    if hasattr(get_ontology, '_cache'):
        return jsonify(get_ontology._cache)

    try:
        url = 'http://api.brain-map.org/api/v2/structure_graph_download/1.json'
        with _urlreq.urlopen(url, timeout=15) as resp:
            raw = _json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        return jsonify({'error': f'Failed to fetch Allen ontology: {e}'}), 502

    # ── Walk the tree and inject our atlas color for every node ───────────────
    # Build a fast lookup: acronym.lower() → structure_color hex
    # We use the ABC name_df / color_df which are already loaded at startup.
    # name_df has columns: organ, category, division, structure, substructure
    # We'll match by acronym from the Allen tree to name_df 'structure' column,
    # but the Allen tree also carries acronym directly so we build from color_df.

    # Build acronym → hex color map from all levels of name_df
    # Allen structure IDs don't map directly, so we match by acronym string.
    # We store one color per acronym — prefer 'structure_color' if available.
    acronym_color = {}
    if 'structure' in name_df.columns:
        for pidx, row in name_df.iterrows():
            for field in ['structure', 'substructure', 'division', 'category', 'organ']:
                val = str(row.get(field, '')).strip()
                if val and val != '—':
                    try:
                        col = color_df.loc[pidx, f'{field}_color']
                        if col and col != '#000000':
                            acronym_color[val.lower()] = col
                    except Exception:
                        pass

    def enrich(node):
        """Recursively enrich Allen tree nodes with color data."""
        name = node.get('name', '')
        acronym = node.get('acronym', '')
        # Use Allen's own color first; fall back to our atlas color
        color = '#' + node.get('color_hex_triplet', '445a72')
        # Try to find a richer match from our ABC color tables
        for key in [name.lower(), acronym.lower()]:
            if key in acronym_color:
                color = acronym_color[key]
                break
        node['_color'] = color

        # Whether clicking this node would actually show anything: does its
        # name/acronym resolve to a term in the ABC term tree (a separate
        # tree from this Allen one -- see /api/group_by_term), and does that
        # term have any descendant with voxels actually delineated in this
        # atlas's CCFv3 volume? Same resolution + intersection this exact
        # node's click would use, computed once here so the frontend can
        # grey it out up front instead of the user discovering a dead click.
        term_label = None
        if acronym:
            term_label = _acro_to_term_id.get(acronym.lower())
        if not term_label and name:
            term_label = _name_to_term_id.get(name.lower())
        node['_available'] = bool(term_label and (_collect_leaf_indices(term_label) & _indices_with_voxels))

        for child in node.get('children', []):
            enrich(child)
        return node

    if isinstance(raw, dict) and 'msg' in raw:
        for root_node in raw['msg']:
            enrich(root_node)

    get_ontology._cache = raw
    return jsonify(raw)


# ── Mesh-slab approach: list every structure_id we have a mesh file for.
# Frontend uses this to preload all meshes on eBrain toggle so cross-section
# slabs are immediately ready regardless of which slice the user visits.
@bp.route('/api/available_meshes')
def available_meshes():
    meshes_dir = Path(__file__).parent / 'meshes'
    ids = []
    for p in meshes_dir.glob('*.glb'):
        try:
            if p.stat().st_size > 0:
                ids.append(int(p.stem))
        except ValueError:
            continue
    ids.sort()
    return jsonify({'count': len(ids), 'structure_ids': ids})


@bp.route('/api/mesh_volume_meta')
def mesh_volume_meta():
    mv = _load_mesh_volume()
    if mv is None:
        return _mesh_volume_missing_response()
    meta = dict(mv['meta'])
    meta['byte_length'] = len(mv['bytes'])
    return jsonify(meta)


@bp.route('/api/mesh_volume')
def mesh_volume():
    mv = _load_mesh_volume()
    if mv is None:
        return _mesh_volume_missing_response()
    resp = Response(mv['bytes'], mimetype='application/octet-stream')
    resp.headers['Content-Length'] = str(len(mv['bytes']))
    resp.headers['Cache-Control'] = 'public, max-age=86400'
    return resp


@bp.route('/api/mesh_lut')
def mesh_lut():
    """Color table keyed by COMPACT INDEX (not raw Allen structure_id).
    meta['idx_to_sid'][i] = the real structure_id at compact index i.
    Returns a packed RGB array, one entry per compact index (index 0 = empty).
    """
    mv = _load_mesh_volume()
    if mv is None:
        return _mesh_volume_missing_response()
    if _MESH_LUT['bytes'] is not None:
        resp = Response(_MESH_LUT['bytes'], mimetype='application/octet-stream')
        resp.headers['Content-Length'] = str(len(_MESH_LUT['bytes']))
        resp.headers['X-LUT-Max-Id']   = str(_MESH_LUT['max_id'])
        resp.headers['Cache-Control'] = 'public, max-age=86400'
        return resp

    import urllib.request
    id_to_color = {}
    try:
        with urllib.request.urlopen(
            'http://api.brain-map.org/api/v2/structure_graph_download/1.json',
            timeout=20) as r:
            data = json.loads(r.read().decode('utf-8'))
        def walk(node):
            hx = (node.get('color_hex_triplet') or '').strip()
            if hx:
                id_to_color[int(node['id'])] = hx
            for c in node.get('children') or []:
                walk(c)
        walk(data['msg'][0])
    except Exception as e:
        return jsonify({'error': f'ontology fetch failed: {e}'}), 500

    idx_to_sid = mv['meta'].get('idx_to_sid', [0])
    max_idx = len(idx_to_sid)
    lut = np.zeros((max_idx, 3), dtype=np.uint8)
    for i, sid in enumerate(idx_to_sid):
        if i == 0:
            continue  # empty / 0
        hx = id_to_color.get(sid, '')
        if len(hx) == 6:
            try:
                lut[i, 0] = int(hx[0:2], 16)
                lut[i, 1] = int(hx[2:4], 16)
                lut[i, 2] = int(hx[4:6], 16)
            except ValueError:
                pass
    _MESH_LUT['bytes']  = np.ascontiguousarray(lut).tobytes()
    _MESH_LUT['max_id'] = max_idx
    print(f"mesh_lut built: {max_idx} compact entries")
    resp = Response(_MESH_LUT['bytes'], mimetype='application/octet-stream')
    resp.headers['Content-Length'] = str(len(_MESH_LUT['bytes']))
    resp.headers['X-LUT-Max-Id']   = str(max_idx)
    return resp
