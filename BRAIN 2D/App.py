"""
Allen CCFv3 Brain Atlas – Flask Backend  (full-color edition)
=============================================================

Volume: 1320 × 800 × 1140 voxels, ASL orientation
  axis-0 (x): anterior → posterior   size 1320
  axis-1 (y): superior → inferior     size  800
  axis-2 (z): left     → right        size 1140

View slice extraction (post-transpose ready for imshow):
  coronal    fix x → arr[xi,:,:]        rows=y  cols=z  shape(800,1140)
  sagittal   fix z → arr[:,:,zi].T      rows=y  cols=x  shape(800,1320)
  transverse fix y → arr[:,yi,:]        rows=x  cols=z  shape(1320,1140)

Endpoints
─────────
  GET  /
  GET  /api/slice?view=coronal&idx=660&colorize=structure
       colorize = off | organ | category | division | structure | substructure
  POST /api/lookup   {view, idx, col, row}
  POST /api/highlight {view, idx, parcellation_index, level}
       level = organ | category | division | structure | substructure
       Returns RGBA mask using the official atlas color for that level.
"""

import io, base64, json as _json, logging, traceback
from datetime import datetime
import numpy as np
from scipy.ndimage import binary_erosion
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import SimpleITK as sitk
from pathlib import Path
from PIL import Image
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from abc_atlas_access.abc_atlas_cache.abc_project_cache import AbcProjectCache

# ── Logging setup ─────────────────────────────────────────────────────────────
def _setup_logger():
    log_dir = Path(__file__).parent / 'logs'
    log_dir.mkdir(exist_ok=True)
    now = datetime.now()
    today = f'{now.month}-{now.day}-{now.year}'  # e.g. 3-16-2026
    log_file = log_dir / f'{today}.log'

    class AtlasFormatter(logging.Formatter):
        def format(self, record):
            _n    = datetime.now()
            now   = f'{_n.month}-{_n.day}-{_n.year} {_n.strftime("%H:%M:%S")}'
            level = f'[{record.levelname}]'
            src   = Path(record.pathname).name
            return f'{level}, {now} {src}, {record.getMessage()}'

    handler = logging.FileHandler(log_file, encoding='utf-8')
    handler.setFormatter(AtlasFormatter())

    logger = logging.getLogger('atlas')
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    # Also echo to console at WARNING+
    ch = logging.StreamHandler()
    ch.setLevel(logging.WARNING)
    ch.setFormatter(AtlasFormatter())
    logger.addHandler(ch)
    return logger

log = _setup_logger()
log.info('Atlas backend starting up')

# ── Rapid-click / spam tracker ────────────────────────────────────────────────
# Fires a WARNING if the same parcellation_index or group name is requested
# more than _RAPID_THRESHOLD times within _RAPID_WINDOW seconds.
import time as _time
_RAPID_WINDOW    = 2.0   # seconds
_RAPID_THRESHOLD = 3     # hits within window before warning

_rapid_lookup = {}   # pidx  → [timestamps]
_rapid_group  = {}   # label → [timestamps]

def _check_rapid(tracker, key, label, kind):
    now = _time.monotonic()
    hits = tracker.setdefault(key, [])
    # Drop timestamps outside the window
    hits[:] = [t for t in hits if now - t < _RAPID_WINDOW]
    hits.append(now)
    if len(hits) >= _RAPID_THRESHOLD:
        log.warning(
            f'Rapid {kind} clicks detected — "{label}" '
            f'requested {len(hits)}x in {_RAPID_WINDOW}s'
        )

# ── Load atlas data once ──────────────────────────────────────────────────────
print("Loading ABC Atlas data … this may take a moment.")

DOWNLOAD_BASE = Path(__file__).parent / 'data' / 'abc_atlas'
DOWNLOAD_BASE.mkdir(parents=True, exist_ok=True)

abc_cache = AbcProjectCache.from_cache_dir(DOWNLOAD_BASE)

# ── Pre-flight: download any missing files ────────────────────────────────────
_IMAGE_VOLUMES = [
    'annotation_10',
    'average_template_10',
    'annotation_boundary_10',
]

_METADATA_FILES = [
    'parcellation_to_parcellation_term_membership_name',
    'parcellation_to_parcellation_term_membership_acronym',
    'parcellation_to_parcellation_term_membership_color',
    'parcellation_to_parcellation_term_membership',
    'parcellation_term',
]

print("\n── Checking required data files ─────────────────────────────────────────")
for vol in _IMAGE_VOLUMES:
    try:
        fpath = abc_cache.get_file_path(directory='Allen-CCF-2020', file_name=vol)
        if Path(fpath).exists():
            print(f"  ✓ {vol}")
        else:
            print(f"  ↓ Downloading {vol} …")
            abc_cache.get_file_path(directory='Allen-CCF-2020', file_name=vol)
    except Exception as e:
        print(f"  ✗ {vol} — {e}")

for meta in _METADATA_FILES:
    try:
        fpath = abc_cache.get_file_path(directory='Allen-CCF-2020', file_name=meta)
        if Path(fpath).exists():
            print(f"  ✓ {meta}")
        else:
            print(f"  ↓ Downloading {meta} …")
            abc_cache.get_metadata_dataframe(directory='Allen-CCF-2020', file_name=meta)
    except Exception as e:
        print(f"  ✗ {meta} — {e}")

print("── Data check complete ───────────────────────────────────────────────────\n")

def load_arr(name):
    f = abc_cache.get_file_path(directory='Allen-CCF-2020', file_name=name)
    return sitk.GetArrayFromImage(sitk.ReadImage(f))

annotation_array = load_arr('annotation_10')   # (1320, 800, 1140)
template_array   = load_arr('average_template_10')
boundary_array   = load_arr('annotation_boundary_10')

# Pre-compute which parcellation indices actually have voxels — used to flag
# "no highlight available" regions in search results.
# FIX: use set comprehension instead of set(... .tolist())
_indices_with_voxels = {int(x) for x in np.unique(annotation_array)}
print(f"Unique parcellation indices with voxels: {len(_indices_with_voxels)}")

# ── Lookup table: parcellation_index → names ──────────────────────────────────
name_df = abc_cache.get_metadata_dataframe(
    directory='Allen-CCF-2020',
    file_name='parcellation_to_parcellation_term_membership_name')
name_df.set_index('parcellation_index', inplace=True)

# ── Acronym table: parcellation_index → per-level acronyms ───────────────────
try:
    acronym_df = abc_cache.get_metadata_dataframe(
        directory='Allen-CCF-2020',
        file_name='parcellation_to_parcellation_term_membership_acronym')
    acronym_df.set_index('parcellation_index', inplace=True)
    print(f"Acronym table loaded. Columns: {list(acronym_df.columns)}")
except Exception as e:
    acronym_df = None
    print(f"Warning: could not load acronym table: {e}")

# ── ABC Atlas Term Tree ────────────────────────────────────────────────────────
try:
    term_df = abc_cache.get_metadata_dataframe(
        directory='Allen-CCF-2020',
        file_name='parcellation_term')
    print(f"parcellation_term: {term_df.shape}  cols: {list(term_df.columns)}")

    membership_df = abc_cache.get_metadata_dataframe(
        directory='Allen-CCF-2020',
        file_name='parcellation_to_parcellation_term_membership')
    print(f"membership: {membership_df.shape}  cols: {list(membership_df.columns)}")

    _term_label_to_indices = {}
    for _, row in membership_df.iterrows():
        pidx   = int(row['parcellation_index'])
        tlabel = str(row['parcellation_term_label']).strip()
        _term_label_to_indices.setdefault(tlabel, set()).add(pidx)
    print(f"term_label→indices: {len(_term_label_to_indices)} terms mapped")

    allen_rows = term_df[term_df['label'].str.startswith('AllenCCF-Ontology-2017')].copy()

    _id_to_label = {}
    for _, row in allen_rows.iterrows():
        tid = str(row.get('identifier') or '').strip()
        if tid:
            _id_to_label[tid] = str(row['label']).strip()

    _term_nodes = {}
    for _, row in allen_rows.iterrows():
        label = str(row['label']).strip()
        tid   = str(row.get('identifier') or '').strip()
        pid   = str(row.get('parent_identifier') or '').strip()
        _term_nodes[label] = {
            'label':        label,
            'id':           tid,
            'acronym':      str(row.get('acronym') or '').strip(),
            'name':         str(row.get('name')    or '').strip(),
            'parent_label': _id_to_label.get(pid, ''),
            'children':     [],
        }

    for label, node in _term_nodes.items():
        plabel = node['parent_label']
        if plabel and plabel in _term_nodes:
            _term_nodes[plabel]['children'].append(label)

    _name_to_term_id = {}
    _acro_to_term_id = {}
    for label, node in _term_nodes.items():
        if node['name']:
            _name_to_term_id[node['name'].lower()] = label
        if node['acronym']:
            _acro_to_term_id[node['acronym'].lower()] = label

    _struct_id_to_rgb = {}
    for _, row in allen_rows.iterrows():
        tid = str(row.get('identifier') or '').strip()
        if not tid.startswith('MBA:'):
            continue
        try:
            sid = int(tid.replace('MBA:', ''))
            r   = int(row.get('red',   0) or 0)
            g   = int(row.get('green', 0) or 0)
            b   = int(row.get('blue',  0) or 0)
            _struct_id_to_rgb[sid] = (r, g, b)
        except (ValueError, TypeError):
            continue
    print(f"struct_id→RGB lookup: {len(_struct_id_to_rgb)} entries")

except Exception as e:
    term_df                = None
    membership_df          = None
    _term_nodes            = {}
    _term_label_to_indices = {}
    _name_to_term_id       = {}
    _acro_to_term_id       = {}
    _struct_id_to_rgb      = {}
    print(f"Warning: could not build term tree: {e}")


def _collect_leaf_indices(term_label, visited=None):
    """
    Walk the ABC term tree from term_label downward, collecting all
    parcellation_indices that are members of any descendant term.
    term_label is the AllenCCF-Ontology-2017-xxx label string.
    """
    if visited is None:
        visited = set()
    if term_label in visited:
        return set()
    visited.add(term_label)

    node = _term_nodes.get(term_label)
    if not node:
        return set()

    indices = set()
    if term_label in _term_label_to_indices:
        indices.update(_term_label_to_indices[term_label])

    for child_label in node['children']:
        indices.update(_collect_leaf_indices(child_label, visited))

    return indices


color_df = abc_cache.get_metadata_dataframe(
    directory='Allen-CCF-2020',
    file_name='parcellation_to_parcellation_term_membership_color')
color_df.set_index('parcellation_index', inplace=True)

LEVEL_COLS = {
    'organ':        'organ_color',
    'category':     'category_color',
    'division':     'division_color',
    'structure':    'structure_color',
    'substructure': 'substructure_color',
}

def hex_to_rgb_cols(col_series):
    """Convert a Series of '#RRGGBB' strings to three uint8 Series (r, g, b)."""
    hexvals = col_series.str.lstrip('#')
    r = hexvals.str[0:2].apply(lambda h: int(h, 16) if isinstance(h, str) and len(h)==6 else 0).astype(np.uint8)
    g = hexvals.str[2:4].apply(lambda h: int(h, 16) if isinstance(h, str) and len(h)==6 else 0).astype(np.uint8)
    b = hexvals.str[4:6].apply(lambda h: int(h, 16) if isinstance(h, str) and len(h)==6 else 0).astype(np.uint8)
    return r, g, b

channels = {}
for ch in ['red', 'green', 'blue']:
    channels[ch] = {}

for level, col in LEVEL_COLS.items():
    r, g, b = hex_to_rgb_cols(color_df[col])
    channels['red'][col]   = r
    channels['green'][col] = g
    channels['blue'][col]  = b

def _build_lut_from_color_df(col_name):
    max_idx = int(color_df.index.max()) + 1
    lut = np.zeros((max_idx, 3), dtype=np.uint8)
    hex_series = color_df[col_name].str.lstrip('#')
    for pidx, hexval in hex_series.items():
        i = int(pidx)
        if 0 <= i < max_idx and isinstance(hexval, str) and len(hexval) == 6:
            try:
                lut[i, 0] = int(hexval[0:2], 16)
                lut[i, 1] = int(hexval[2:4], 16)
                lut[i, 2] = int(hexval[4:6], 16)
            except ValueError:
                pass
    return lut, max_idx

_color_lut_structure,    _MAX_PIDX = _build_lut_from_color_df('structure_color')
_color_lut_substructure, _         = _build_lut_from_color_df('substructure_color')
_color_lut_division,     _         = _build_lut_from_color_df('division_color')

_color_lut = _color_lut_structure
_MAX_STRUCT_ID = _MAX_PIDX

print(f"Color LUT built from color_df structure_color: "
      f"{np.any(_color_lut > 0, axis=1).sum()} colored parcellations")
print("Color tables loaded.")

def get_hex_for_index(parcellation_index, level):
    col = LEVEL_COLS.get(level, 'structure_color')
    try:
        return color_df.loc[parcellation_index, col]
    except KeyError:
        return '#00d4ff'

# ── Volume dimensions ─────────────────────────────────────────────────────────
X_MAX = annotation_array.shape[0] - 1   # 1319
Y_MAX = annotation_array.shape[1] - 1   #  799
Z_MAX = annotation_array.shape[2] - 1   # 1139

print(f"Atlas loaded. Shape: {annotation_array.shape}  x:0-{X_MAX}  y:0-{Y_MAX}  z:0-{Z_MAX}")

VIEW_CFG = {
    'sagittal':   {'figsize': (13.2, 8.0),  'max': X_MAX},
    'coronal':    {'figsize': (11.4, 8.0),  'max': Z_MAX},
    'transverse': {'figsize': (11.4, 13.2), 'max': Y_MAX},
}

_render_size_cache = {}

# ── Slice extraction ──────────────────────────────────────────────────────────
def get_slices(view, idx):
    if view == 'sagittal':
        xi = max(0, min(idx, X_MAX))
        return (template_array[xi,:,:],
                boundary_array[xi,:,:],
                annotation_array[xi,:,:])
    elif view == 'coronal':
        zi = max(0, min(idx, Z_MAX))
        return (template_array[:,:,zi].T,
                boundary_array[:,:,zi].T,
                annotation_array[:,:,zi].T)
    elif view == 'transverse':
        yi = max(0, min(idx, Y_MAX))
        return (template_array[:,yi,:],
                boundary_array[:,yi,:],
                annotation_array[:,yi,:])
    raise ValueError(f"Unknown view: {view}")

def world_coords(view, idx, col, row):
    if view == 'sagittal':    return idx, row, col
    elif view == 'coronal':   return col, row, idx
    elif view == 'transverse': return row, idx, col
    return 0, 0, 0

# ── Colorize a 2-D annotation slice using the official color table ───────────
def colorize(annot_slice, level='structure'):
    """
    Fast numpy LUT colorize using parcellation_to_parcellation_term_membership_color.
    """
    lut_map = {
        'structure':    _color_lut_structure,
        'substructure': _color_lut_substructure,
        'division':     _color_lut_division,
    }
    lut  = lut_map.get(level, _color_lut_structure)
    maxn = lut.shape[0]
    flat = annot_slice.ravel().astype(np.int64)
    flat = np.where((flat >= 0) & (flat < maxn), flat, 0)
    return lut[flat].reshape(annot_slice.shape[0], annot_slice.shape[1], 3)

# ── Render a slice to base64 PNG ──────────────────────────────────────────────
def render_to_b64(tmpl, bnd, annot, colorize_level=None, fw=10, fh=8):
    fig, ax = plt.subplots(figsize=(fw, fh), dpi=100)
    ax.imshow(tmpl, cmap='Greys_r', origin='upper')

    if colorize_level and colorize_level != 'off':
        rgb = colorize(annot, colorize_level)
        rgba = np.concatenate(
            [rgb, np.where(annot[:, :, None] > 0,
                           np.full((*annot.shape, 1), 178, dtype=np.uint8),
                           np.zeros((*annot.shape, 1), dtype=np.uint8))],
            axis=2)
        ax.imshow(rgba, origin='upper', interpolation='nearest')

    ax.imshow(bnd, cmap='Greys',
              alpha=np.clip(bnd.astype(float) / 225, 0, 1),
              origin='upper')
    ax.axis('off')
    plt.tight_layout(pad=0)
    buf = io.BytesIO()
    fig.savefig(buf, format='png', bbox_inches='tight', pad_inches=0, facecolor='black')
    plt.close(fig)
    buf.seek(0)
    raw = buf.read()
    import struct
    pw = struct.unpack('>I', raw[16:20])[0]
    ph = struct.unpack('>I', raw[20:24])[0]
    return base64.b64encode(raw).decode('utf-8'), pw, ph

# ── Flask ─────────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder='.')
CORS(app)

@app.errorhandler(Exception)
def handle_exception(e):
    tb = traceback.format_exc()
    log.error(f'Unhandled exception on {request.method} {request.path} — {e}\n{tb}')
    return jsonify({'error': str(e)}), 500

@app.errorhandler(404)
def handle_404(e):
    log.warning(f'404 {request.method} {request.path}')
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(405)
def handle_405(e):
    log.warning(f'405 Method Not Allowed {request.method} {request.path}')
    return jsonify({'error': 'Method not allowed'}), 405

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/api/log_warning', methods=['POST'])
def log_warning():
    data  = request.get_json(force=True)
    kind  = str(data.get('kind',  'click'))
    label = str(data.get('label', '?'))
    count = int(data.get('count', 0))
    log.warning(f'Rapid {kind} — "{label}" blocked after {count} rapid requests')
    return jsonify({'ok': True})

@app.route('/api/slice')
def get_slice():
    view = request.args.get('view', 'sagittal').lower()
    if view not in VIEW_CFG:
        return jsonify({'error': f'view must be one of {list(VIEW_CFG)}'}), 400

    colorize_level = request.args.get('colorize', 'off').lower()
    max_idx = VIEW_CFG[view]['max']
    try:
        idx = int(request.args.get('idx', max_idx // 2))
    except (TypeError, ValueError):
        return jsonify({'error': 'invalid idx'}), 400
    idx = max(0, min(idx, max_idx))

    try:
        tmpl, bnd, annot = get_slices(view, idx)
        fw, fh = VIEW_CFG[view]['figsize']
        img_b64, render_w, render_h = render_to_b64(tmpl, bnd, annot, colorize_level, fw, fh)
        _render_size_cache[(view, idx)] = (render_w, render_h)
    except Exception as e:
        log.error(f'slice render failed — view={view} idx={idx} colorize={colorize_level} — {e}\n{traceback.format_exc()}')
        return jsonify({'error': str(e)}), 500

    rows, cols = tmpl.shape
    return jsonify({
        'image':    f'data:image/png;base64,{img_b64}',
        'view':     view,
        'idx':      idx,
        'rows':     rows,
        'cols':     cols,
        'render_w': render_w,
        'render_h': render_h,
    })


# ── Lookup helpers ────────────────────────────────────────────────────────────

def _get_region_colors(parcellation_index):
    """Return a dict of per-level color hex strings for a parcellation index."""
    colors = {}
    for level, colname in LEVEL_COLS.items():
        try:
            colors[f'{level}_color'] = color_df.loc[parcellation_index, colname]
        except KeyError:
            colors[f'{level}_color'] = '#444444'
    return colors


def _get_region_names(parcellation_index):
    """Return name and acronym fields for a parcellation index, or None if missing."""
    hier = ['organ', 'category', 'division', 'structure', 'substructure']
    try:
        r = name_df.loc[parcellation_index]
    except KeyError:
        return None, None

    result = {f: str(r.get(f, '—')) for f in hier}

    if acronym_df is not None and parcellation_index in acronym_df.index:
        a = acronym_df.loc[parcellation_index]
        for f in hier:
            result[f + '_acronym'] = str(a.get(f, ''))

    matched_name = '—'
    matched_acro = '—'
    for f in reversed(hier):
        v = result.get(f, '—')
        if v and v != '—':
            matched_name = v
            matched_acro = result.get(f + '_acronym', '—') or '—'
            break

    result['matched_label']   = matched_name
    result['matched_acronym'] = matched_acro
    return result, matched_name


@app.route('/api/lookup', methods=['POST'])
def lookup():
    data = request.get_json(force=True)
    try:
        view = data['view'].lower()
        idx  = int(data['idx'])
        col  = int(data['col'])
        row  = int(data['row'])
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'view, idx, col, row required'}), 400

    if view not in VIEW_CFG:
        return jsonify({'error': _INVALID_VIEW}), 400

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
    }
    colors = _get_region_colors(parcellation_index)

    names, matched_name = _get_region_names(parcellation_index)
    if names is None:
        log.warning(f'lookup — no region for parcellation_index={parcellation_index}')
        return jsonify({**base, **colors,
                        'error': f'No region for index {parcellation_index}'})

    try:
        _check_rapid(_rapid_lookup, parcellation_index, matched_name, 'lookup')
        log.info(f'lookup ok — pidx={parcellation_index} name={matched_name}')
        return jsonify({**base, **colors, **names})
    except Exception as e:
        log.error(f'lookup exception — {e}\n{traceback.format_exc()}')
        return jsonify({'error': str(e)}), 500


# ── Highlight helpers ─────────────────────────────────────────────────────────

def _parse_highlight_color(data, target, level, color_mode):
    """Resolve the RGB fill color for a highlight request."""
    if color_mode:
        return 108, 52, 196  # muted dark purple
    hex_color = get_hex_for_index(target, level).lstrip('#')
    try:
        return int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
    except Exception:
        return 0, 212, 255


def _build_highlight_mask(annot, region_mask):
    """Build RGBA mask with fill + thick black outline for highlighted region."""
    from scipy.ndimage import binary_dilation
    rows, cols = annot.shape
    struct3 = np.ones((3, 3), dtype=bool)
    struct5 = np.ones((5, 5), dtype=bool)
    dilated = binary_dilation(region_mask, structure=struct5, iterations=2)
    eroded  = binary_erosion(region_mask,  structure=struct3, iterations=1)
    outline = dilated & ~eroded
    return outline, rows, cols


def _mask_to_png_b64(mask_array):
    """Convert an RGBA numpy array to a base64-encoded PNG string."""
    img = Image.fromarray(mask_array, 'RGBA')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()


@app.route('/api/highlight', methods=['POST'])
def highlight():
    data = request.get_json(force=True)
    try:
        view   = data['view'].lower()
        idx    = int(data['idx'])
        target = int(data['parcellation_index'])
        level  = data.get('level', 'structure')
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'view, idx, parcellation_index required'}), 400

    if view not in VIEW_CFG:
        return jsonify({'error': _INVALID_VIEW}), 400

    _, _, annot = get_slices(view, idx)
    color_mode = bool(data.get('color_mode', False))
    r, g, b = _parse_highlight_color(data, target, level, color_mode)

    region = (annot == target)
    outline, rows, cols = _build_highlight_mask(annot, region)

    mask = np.zeros((rows, cols, 4), dtype=np.uint8)
    mask[region]  = [r, g, b, 180]
    mask[outline] = [10, 10, 10, 230]

    used_color = 'a020f0' if color_mode else get_hex_for_index(target, level).lstrip('#')
    return jsonify({
        'mask':  f'data:image/png;base64,{_mask_to_png_b64(mask)}',
        'color': f'#{used_color}',
    })


@app.route('/api/resolve_acronyms', methods=['POST'])
def resolve_acronyms():
    """
    POST { acronyms: [...] }
    Resolves a list of acronyms to parcellation_indices in one shot.
    """
    data = request.get_json(force=True)
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


def _build_group_mask(annot, indices):
    """Build RGBA highlight mask for a set of parcellation indices."""
    from scipy.ndimage import binary_dilation
    rows, cols = annot.shape
    member_arr = np.array(sorted(set(indices)), dtype=annot.dtype)
    in_group   = np.isin(annot, member_arr)

    struct3 = np.ones((3, 3), dtype=bool)
    struct5 = np.ones((5, 5), dtype=bool)
    dilated = binary_dilation(in_group, structure=struct5, iterations=2)
    eroded  = binary_erosion(in_group,  structure=struct3, iterations=1)
    outline = dilated & ~eroded

    mask = np.zeros((rows, cols, 4), dtype=np.uint8)
    mask[in_group] = [108, 52, 196, 180]
    mask[outline]  = [10, 10, 10, 230]
    return mask


@app.route('/api/highlight_indices', methods=['POST'])
def highlight_indices():
    data = request.get_json(force=True)
    try:
        view    = data['view'].lower()
        idx     = int(data['idx'])
        indices = [int(i) for i in data['parcellation_indices']]
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'view, idx, parcellation_indices required'}), 400
    if view not in VIEW_CFG or not indices:
        return jsonify({'error': 'invalid input'}), 400

    _, _, annot = get_slices(view, idx)
    mask = _build_group_mask(annot, indices)

    return jsonify({
        'mask':         f'data:image/png;base64,{_mask_to_png_b64(mask)}',
        'color':        '#6c34c4',
        'member_count': len(indices),
    })


def _best_slice_indices(voxels):
    """Return (xi, yi, zi) slice indices with the most voxels for each axis."""
    xi_counts = np.bincount(voxels[:, 0], minlength=annotation_array.shape[0])
    yi_counts = np.bincount(voxels[:, 1], minlength=annotation_array.shape[1])
    zi_counts = np.bincount(voxels[:, 2], minlength=annotation_array.shape[2])
    xi = int(np.argmax(xi_counts))
    yi = int(np.argmax(yi_counts))
    zi = int(np.argmax(zi_counts))
    xi = max(0, min(xi, VIEW_CFG['sagittal']['max']))
    yi = max(0, min(yi, VIEW_CFG['transverse']['max']))
    zi = max(0, min(zi, VIEW_CFG['coronal']['max']))
    return xi, yi, zi


@app.route('/api/region_center_indices', methods=['POST'])
def region_center_indices():
    data = request.get_json(force=True)
    try:
        indices = [int(i) for i in data['parcellation_indices']]
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'parcellation_indices required'}), 400
    if not indices:
        return jsonify({'error': 'empty'}), 400

    member_arr = np.array(sorted(set(indices)), dtype=annotation_array.dtype)
    voxels = np.argwhere(np.isin(annotation_array, member_arr))
    if len(voxels) == 0:
        return jsonify({'error': 'No voxels found'}), 404

    xi, yi, zi = _best_slice_indices(voxels)
    return jsonify({'xi': xi, 'yi': yi, 'zi': zi,
                    'voxel_count': int(len(voxels)), 'member_count': len(indices)})


@app.route('/api/group_by_term', methods=['POST'])
def group_by_term():
    """
    POST { name, acronym }
    Looks up the term in parcellation_term.csv tree, collects all leaf
    parcellation_indices under it, and returns centroid + member count.
    """
    data    = request.get_json(force=True)
    name    = (data.get('name')    or '').strip()
    acronym = (data.get('acronym') or '').strip()

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


@app.route('/api/highlight_group', methods=['POST'])
def highlight_group():
    """
    POST { view, idx, group_level, group_name }
    Highlights ALL parcellation indices whose name_df[group_level] == group_name.
    """
    data = request.get_json(force=True)
    try:
        view       = data['view'].lower()
        idx        = int(data['idx'])
        group_lv   = data['group_level']
        group_name = data['group_name'].strip()
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'view, idx, group_level, group_name required'}), 400

    if view not in VIEW_CFG:
        return jsonify({'error': _INVALID_VIEW}), 400
    if group_lv not in LEVEL_COLS:
        return jsonify({'error': f'group_level must be one of {list(LEVEL_COLS)}'}), 400

    col_name = group_lv
    if col_name not in name_df.columns:
        return jsonify({'error': f'column {group_lv} not in name table'}), 400

    member_mask    = name_df[col_name].fillna('').str.lower() == group_name.lower()
    member_indices = {int(i) for i in name_df.index[member_mask]}

    if not member_indices:
        return jsonify({'error': f'No regions found for {group_lv}={group_name}'}), 404

    # FIX: bnd is unused — replaced with _
    _, _, annot = get_slices(view, idx)
    mask = _build_group_mask(annot, member_indices)

    return jsonify({
        'mask':         f'data:image/png;base64,{_mask_to_png_b64(mask)}',
        'color':        '#6c34c4',
        'member_count': len(member_indices),
    })


@app.route('/api/debug_name')
def debug_name():
    name = request.args.get('q', '').strip().lower()
    result = {}
    for col in ['organ', 'category', 'division', 'structure', 'substructure']:
        if col not in name_df.columns:
            continue
        hits = name_df[name_df[col].fillna('').str.lower().str.contains(name, regex=False)]
        if not hits.empty:
            result[col] = hits[col].dropna().unique().tolist()[:20]
    exact_rows = []
    for col in ['organ', 'category', 'division', 'structure', 'substructure']:
        if col not in name_df.columns:
            continue
        hits = name_df[name_df[col].fillna('').str.lower() == name]
        for idx, row in hits.iterrows():
            exact_rows.append({'parcellation_index': int(idx),
                                **{c: str(row.get(c, '')) for c in ['organ', 'category', 'division', 'structure', 'substructure']}})
    result['_exact_rows'] = exact_rows[:10]
    return jsonify(result)


# ── find_group_level helpers ──────────────────────────────────────────────────

def _find_single_level_match(name_lo, hier_cols):
    """
    Search each hierarchy column for an exact match on name_lo.
    Returns (group_level, group_name, member_count) or None.
    """
    for i, lv in enumerate(hier_cols):
        if lv not in name_df.columns:
            continue
        col_vals = name_df[lv].fillna('').str.lower()
        mask  = col_vals == name_lo
        count = int(mask.sum())
        if count == 0:
            continue
        if count > 1:
            actual_name = name_df[lv][mask].iloc[0]
            return lv, actual_name, count
        # count == 1: check finer levels for children
        result = _check_children_at_finer_levels(name_lo, mask, hier_cols, i)
        if result:
            return result
    return None


def _check_children_at_finer_levels(name_lo, parent_mask, hier_cols, parent_idx):
    """
    For a single-row match, check whether finer levels have children.
    Returns (group_level, group_name, child_count) or None.
    """
    lv = hier_cols[parent_idx]
    for child_lv in hier_cols[parent_idx + 1:]:
        if child_lv not in name_df.columns:
            continue
        child_mask  = parent_mask & name_df[child_lv].fillna('').ne('')
        child_count = int(child_mask.sum())
        if child_count > 1:
            actual_name = name_df[lv][parent_mask].iloc[0]
            return lv, actual_name, child_count
    return None


@app.route('/api/find_group_level', methods=['POST'])
def find_group_level():
    """
    POST { name }
    Finds which hierarchy level contains the given name and how many members it has.
    Returns { group_level, group_name, member_count }.
    """
    data = request.get_json(force=True)
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400

    hier_cols = ['organ', 'category', 'division', 'structure', 'substructure']
    result = _find_single_level_match(name.lower(), hier_cols)
    if result:
        lv, actual_name, count = result
        return jsonify({'group_level': lv, 'group_name': actual_name, 'member_count': count})

    return jsonify({'error': f'"{name}" not found in any hierarchy level'}), 404


# ── region_center_group helpers ───────────────────────────────────────────────

def _resolve_group_member_indices(group_lv, group_name):
    """
    Return set of parcellation indices belonging to the group.
    Falls back to prefix matching if exact match yields nothing.
    """
    col_vals = name_df[group_lv].fillna('').str.lower()
    name_lo  = group_name.lower()
    member_mask = col_vals == name_lo
    if member_mask.sum() == 0:
        member_mask = col_vals.str.startswith(name_lo) | col_vals.str.startswith(name_lo.rstrip('s'))
    return {int(i) for i in name_df.index[member_mask].tolist()}


@app.route('/api/region_center_group', methods=['POST'])
def region_center_group():
    """
    POST { group_level, group_name }
    Finds the best slice indices to view a whole anatomical group.
    """
    data = request.get_json(force=True)
    try:
        group_lv   = data['group_level']
        group_name = data['group_name'].strip()
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'group_level and group_name required'}), 400

    if group_lv not in LEVEL_COLS:
        return jsonify({'error': f'group_level must be one of {list(LEVEL_COLS)}'}), 400
    if group_lv not in name_df.columns:
        return jsonify({'error': f'column {group_lv} not in name table'}), 400

    member_indices = _resolve_group_member_indices(group_lv, group_name)
    if not member_indices:
        return jsonify({'error': f'No regions found for {group_lv}={group_name}'}), 404

    member_arr = np.array(sorted(member_indices), dtype=annotation_array.dtype)
    voxels     = np.argwhere(np.isin(annotation_array, member_arr))
    if len(voxels) == 0:
        return jsonify({'error': 'No voxels found for this group'}), 404

    xi, yi, zi = _best_slice_indices(voxels)
    sample_idx = next(iter(member_indices))
    hex_color  = get_hex_for_index(sample_idx, group_lv)

    return jsonify({
        'xi': xi, 'yi': yi, 'zi': zi,
        'voxel_count':          int(len(voxels)),
        'member_count':         len(member_indices),
        'group_level':          group_lv,
        'group_name':           group_name,
        f'{group_lv}_color':    hex_color,
        'structure_color':      hex_color,
    })


@app.route('/api/region_center', methods=['POST'])
def region_center():
    """
    POST { parcellation_index }
    Finds the centroid voxel (xi, yi, zi) of the given region.
    """
    data = request.get_json(force=True)
    try:
        target = int(data['parcellation_index'])
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'parcellation_index required'}), 400

    voxels = np.argwhere(annotation_array == target)
    if len(voxels) == 0:
        return jsonify({'error': f'No voxels found for parcellation_index={target}'}), 404

    xi, yi, zi = _best_slice_indices(voxels)
    colors = _get_region_colors(target)

    names = {}
    try:
        r = name_df.loc[target]
        for f in ['organ', 'category', 'division', 'structure', 'substructure']:
            names[f] = str(r.get(f, '—'))
    except KeyError:
        pass

    if acronym_df is not None and target in acronym_df.index:
        a = acronym_df.loc[target]
        for f in ['organ', 'category', 'division', 'structure', 'substructure']:
            names[f + '_acronym'] = str(a.get(f, ''))

    return jsonify({
        'parcellation_index': target,
        'xi': xi, 'yi': yi, 'zi': zi,
        'voxel_count': len(voxels),
        **colors, **names,
    })


# ── Search helpers ────────────────────────────────────────────────────────────

_HIER_COLS_ASC  = ['organ', 'category', 'division', 'structure', 'substructure']
_HIER_COLS_DESC = list(reversed(_HIER_COLS_ASC))
_INVALID_VIEW   = 'invalid view'


def _name_matches(text, q_lower):
    return text.lower().startswith(q_lower)


def _acro_matches(acro, q_lower):
    a = acro.lower()
    return a == q_lower or a.startswith(q_lower)


def _match_rank(name_lo, acro_lo, q_lower):
    """Return sort rank (0=exact, 1=prefix, 2=substring, 3=none)."""
    if acro_lo == q_lower or name_lo == q_lower:
        return 0
    if acro_lo.startswith(q_lower) or name_lo.startswith(q_lower):
        return 1
    if q_lower in acro_lo:
        return 2
    return 3


def _build_level_acronym_map():
    """Return dict: level → {name.lower(): acronym}."""
    level_acronym = {lv: {} for lv in _HIER_COLS_ASC}
    if acronym_df is None:
        return level_acronym
    for pidx in acronym_df.index:
        try:
            a   = acronym_df.loc[pidx]
            row = name_df.loc[pidx] if pidx in name_df.index else None
            if row is None:
                continue
            for lv in _HIER_COLS_ASC:
                nm = str(row.get(lv, '') or '').strip()
                ac = str(a.get(lv, '') or '').strip()
                if nm and ac:
                    level_acronym[lv][nm.lower()] = ac
        except Exception:
            pass
    return level_acronym


def _get_most_specific(row):
    """Return (col, name) for the finest non-empty hierarchy level."""
    for col in _HIER_COLS_DESC:
        val = str(row.get(col, '') or '').strip()
        if val and val != '—':
            return col, val
    return None, ''


def _collect_group_candidates(q_lower, level_acronym):
    """
    Pass 1: scan name_df for group-level matches (parent columns).
    Returns dict keyed by (level, name_lower).
    """
    parent_levels    = ['organ', 'category', 'division', 'structure']
    group_candidates = {}

    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue

        most_spec, _ = _get_most_specific(row)
        if not most_spec:
            continue

        for lv in parent_levels:
            if lv == most_spec:
                continue
            val = str(row.get(lv, '') or '').strip()
            if not val or val == '—':
                continue
            acro = level_acronym[lv].get(val.lower(), '')
            if not _name_matches(val, q_lower) and not _acro_matches(acro, q_lower):
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
            group_candidates[key]['member_count'] += 1

    return group_candidates


def _enrich_group_counts(group_candidates):
    """Use term tree for accurate leaf counts where available."""
    for key, g in group_candidates.items():
        term_label = _name_to_term_id.get(g['group_name'].lower())
        if term_label:
            indices    = _collect_leaf_indices(term_label)
            real_count = len(indices & _indices_with_voxels)
            if real_count > 0:
                g['member_count'] = real_count


def _build_group_result(key, g, q_lower):
    """Convert a group candidate dict into a result dict."""
    lv, name_lo = key
    acro = g['group_acronym']
    rank = _match_rank(name_lo, acro.lower(), q_lower)
    return {
        'is_group':       True,
        'group_level':    lv,
        'group_name':     g['group_name'],
        'group_acronym':  acro,
        'member_count':   g['member_count'],
        'parcellation_index': g['sample_idx'],
        'structure_color':    g['structure_color'],
        'matched_label':  g['group_name'],
        'matched_acronym': acro,
        'matched_level':  lv,
        'organ':    '—', 'category': '—', 'division': '—',
        'structure': '—', 'substructure': '—',
        '_rank': rank,
    }


def _collect_term_tree_groups(q_lower, existing_group_results):
    """Search the term tree directly for group matches (catches acronyms like CNU)."""
    existing_names = {g['group_name'].lower() for g in existing_group_results}
    extra = []
    for term_label, node in _term_nodes.items():
        acro = node['acronym']
        nm   = node['name']
        if not acro and not nm:
            continue
        if not _acro_matches(acro, q_lower) and not _name_matches(nm, q_lower):
            continue
        if not node['children']:
            continue
        indices    = _collect_leaf_indices(term_label)
        real_count = len(indices & _indices_with_voxels)
        if real_count <= 1:
            continue
        if nm.lower() in existing_names:
            continue
        try:
            sample_idx = next(iter(indices & _indices_with_voxels))
            grp_color  = color_df.loc[sample_idx, 'division_color']
        except (StopIteration, KeyError):
            grp_color  = '#00d4ff'
        rank = _match_rank(nm.lower(), acro.lower(), q_lower)
        extra.append({
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
    return extra


def _get_leaf_color(parc_idx, most_specific_col):
    """Return the best available color hex for a leaf parcellation index."""
    for col in [f'{most_specific_col}_color', 'structure_color']:
        try:
            return color_df.loc[parc_idx, col]
        except KeyError:
            continue
    return '#444444'


def _collect_leaf_results(q_lower, limit, level_acronym):
    """Pass 2: find leaf-level matches (most-specific column)."""
    leaf_results = []
    seen_label   = set()

    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue

        most_specific_col, most_specific_name = _get_most_specific(row)
        if not most_specific_col:
            continue

        acronyms              = {}
        most_specific_acronym = ''
        if acronym_df is not None and parc_idx in acronym_df.index:
            a = acronym_df.loc[parc_idx]
            for f in _HIER_COLS_ASC:
                acronyms[f + '_acronym'] = str(a.get(f, '') or '')
            most_specific_acronym = str(a.get(most_specific_col, '') or '').strip()

        name_hit = _name_matches(most_specific_name, q_lower)
        acro_hit = most_specific_acronym and _acro_matches(most_specific_acronym, q_lower)
        if not name_hit and not acro_hit:
            continue

        dedup_key = (most_specific_name.lower(), most_specific_acronym.lower())
        if dedup_key in seen_label:
            continue
        seen_label.add(dedup_key)

        struct_color = _get_leaf_color(parc_idx, most_specific_col)

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

        if len(leaf_results) >= limit * 3:
            break

    return leaf_results


def _leaf_sort_key(r, q_lower):
    """Sort key for leaf results: voxel availability, then match quality."""
    name   = r['matched_label'].lower()
    acro   = r['matched_acronym'].lower()
    no_vox = 1 if r.get('no_voxels') else 0
    rank   = _match_rank(name, acro, q_lower)
    return (no_vox, rank, name)


@app.route('/api/search')
def search():
    """
    GET /api/search?q=fiber+tracts&limit=50

    Two-tier results:
      1. GROUP entries  — when the query matches a parent-level column value.
      2. LEAF entries   — rows where the query matches the most-specific label/acronym.

    Groups always sort above leaf matches.
    """
    q = request.args.get('q', '').strip()
    if len(q) < 1:
        return jsonify({'results': [], 'query': q})

    limit   = min(int(request.args.get('limit', 50)), 200)
    q_lower = q.lower()

    level_acronym = _build_level_acronym_map()

    # Pass 1 — groups
    group_candidates = _collect_group_candidates(q_lower, level_acronym)
    _enrich_group_counts(group_candidates)

    group_results = [
        _build_group_result(key, g, q_lower)
        for key, g in group_candidates.items()
        if g['member_count'] > 1
    ]
    group_results += _collect_term_tree_groups(q_lower, group_results)
    group_results.sort(key=lambda r: (r['_rank'], r['group_name']))

    # Pass 2 — leaves
    leaf_results = _collect_leaf_results(q_lower, limit, level_acronym)
    leaf_results.sort(key=lambda r: _leaf_sort_key(r, q_lower))

    combined = (group_results + leaf_results)[:limit]
    return jsonify({'results': combined, 'query': q, 'total': len(combined)})


# ── resolve_region helpers ────────────────────────────────────────────────────

def _term_node_result(term_label, node):
    """Build a group result dict from a term-tree node."""
    indices    = _collect_leaf_indices(term_label)
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


def _leaf_result(parc_idx):
    """Build a leaf result dict from name_df row."""
    hier_cols = ['organ', 'category', 'division', 'structure', 'substructure']
    try:
        row = name_df.loc[parc_idx]
    except KeyError:
        return None
    most_spec, most_name = _get_most_specific(row)
    if not most_spec:
        return None
    most_acro = ''
    if acronym_df is not None and parc_idx in acronym_df.index:
        most_acro = str(acronym_df.loc[parc_idx].get(most_spec, '') or '').strip()
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
        'organ':        str(row.get('organ',        '') or '—'),
        'category':     str(row.get('category',     '') or '—'),
        'division':     str(row.get('division',     '') or '—'),
        'structure':    str(row.get('structure',    '') or '—'),
        'substructure': str(row.get('substructure', '') or '—'),
    }


def _resolve_exact_group(lo):
    """P1: Exact group match from name_df parent columns."""
    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue
        for lv in ['category', 'division', 'structure']:
            val = str(row.get(lv, '') or '').strip()
            if val.lower() != lo:
                continue
            member_mask    = name_df[lv].fillna('').str.lower() == lo
            member_indices = list({int(i) for i in name_df.index[member_mask]} & _indices_with_voxels)
            if len(member_indices) <= 1:
                break
            try:
                grp_color = color_df.loc[parc_idx, f'{lv}_color']
            except KeyError:
                grp_color = '#00d4ff'
            acro = ''
            if acronym_df is not None and parc_idx in acronym_df.index:
                acro = str(acronym_df.loc[parc_idx].get(lv, '') or '').strip()
            return {
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
            }
    return None


def _resolve_exact_acronym(lo):
    """P2: Exact acronym match on any leaf column."""
    hier_cols = ['organ', 'category', 'division', 'structure', 'substructure']
    if acronym_df is None:
        return None
    for parc_idx in acronym_df.index:
        try:
            a = acronym_df.loc[parc_idx]
        except KeyError:
            continue
        for col in hier_cols:
            if str(a.get(col, '') or '').strip().lower() == lo:
                return _leaf_result(parc_idx)
    return None


def _resolve_exact_leaf_name(lo):
    """P3: Exact leaf name match on most-specific column."""
    hier_cols = ['organ', 'category', 'division', 'structure', 'substructure']
    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue
        for col in reversed(hier_cols):
            val = str(row.get(col, '') or '').strip()
            if val.lower() == lo:
                r = _leaf_result(parc_idx)
                if r:
                    return r
                break
    return None


def _resolve_prefix_group(lo):
    """P5: Prefix match on group names (>=5 chars)."""
    for lv in ['division', 'structure', 'category']:
        if lv not in name_df.columns:
            continue
        for val in name_df[lv].dropna().unique():
            if not str(val).lower().startswith(lo):
                continue
            member_mask    = name_df[lv].fillna('').str.lower() == str(val).lower()
            member_indices = list({int(i) for i in name_df.index[member_mask]} & _indices_with_voxels)
            if len(member_indices) <= 1:
                continue
            sample_idx = member_indices[0]
            try:
                grp_color = color_df.loc[sample_idx, f'{lv}_color']
            except KeyError:
                grp_color = '#00d4ff'
            return {
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
            }
    return None


def _resolve_prefix_leaf(lo):
    """P6: Prefix match on leaf names (>=5 chars)."""
    hier_cols = ['organ', 'category', 'division', 'structure', 'substructure']
    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue
        for col in reversed(hier_cols):
            val = str(row.get(col, '') or '').strip()
            if val.lower().startswith(lo):
                r = _leaf_result(parc_idx)
                if r:
                    return r
                break
    return None


def _resolve_substring_leaf(lo):
    """P7: Substring match covering >45% of leaf name (>=5 chars)."""
    hier_cols = ['organ', 'category', 'division', 'structure', 'substructure']
    for parc_idx in name_df.index:
        try:
            row = name_df.loc[parc_idx]
        except KeyError:
            continue
        for col in reversed(hier_cols):
            val = str(row.get(col, '') or '').strip().lower()
            if val and lo in val and len(lo) / len(val) > 0.45:
                r = _leaf_result(parc_idx)
                if r:
                    return r
                break
    return None


@app.route('/api/resolve_region', methods=['GET'])
def resolve_region():
    """
    GET /api/resolve_region?name=hippocampus
    Finds the single best matching atlas region for a candidate name.
    """
    name = request.args.get('name', '').strip()
    if len(name) < 2:
        return jsonify({})

    lo = name.lower()

    # P1: Exact group match
    result = _resolve_exact_group(lo)
    if result:
        return jsonify(result)

    # P2: Exact acronym match
    result = _resolve_exact_acronym(lo)
    if result:
        return jsonify(result)

    # P3: Exact leaf name match
    result = _resolve_exact_leaf_name(lo)
    if result:
        return jsonify(result)

    # P4: Term-tree exact name or acronym
    term_label = _name_to_term_id.get(lo) or _acro_to_term_id.get(lo)
    if term_label:
        node = _term_nodes.get(term_label)
        if node and node['children']:
            result = _term_node_result(term_label, node)
            if result:
                return jsonify(result)

    if len(lo) >= 5:
        # P5: Prefix match on group names
        result = _resolve_prefix_group(lo)
        if result:
            return jsonify(result)

        # P6: Prefix match on leaf names
        result = _resolve_prefix_leaf(lo)
        if result:
            return jsonify(result)

        # P7: Substring match
        result = _resolve_substring_leaf(lo)
        if result:
            return jsonify(result)

    return jsonify({})


@app.route('/api/ontology')
def _build_acronym_color_map():
    """Build a name/acronym → hex color lookup from name_df and color_df."""
    acronym_color = {}
    if 'structure' not in name_df.columns:
        return acronym_color
    for pidx, row in name_df.iterrows():
        for field in ['structure', 'substructure', 'division', 'category', 'organ']:
            val = str(row.get(field, '')).strip()
            if not val or val == '—':
                continue
            try:
                col = color_df.loc[pidx, f'{field}_color']
                if col and col != '#000000':
                    acronym_color[val.lower()] = col
            except Exception:
                pass
    return acronym_color


def _enrich_ontology_node(node, acronym_color):
    """Recursively inject atlas color into an Allen ontology tree node."""
    color = '#' + node.get('color_hex_triplet', '445a72')
    for key in [node.get('name', '').lower(), node.get('acronym', '').lower()]:
        if key in acronym_color:
            color = acronym_color[key]
            break
    node['_color'] = color
    for child in node.get('children', []):
        _enrich_ontology_node(child, acronym_color)


def get_ontology():
    """
    GET /api/ontology
    Fetches the full Allen CCFv3 mouse brain structure tree from the Allen API
    and enriches each node with the official atlas color from our local color_df.
    """
    import urllib.request as _urlreq

    if hasattr(get_ontology, '_cache'):
        return jsonify(get_ontology._cache)

    try:
        url = 'http://api.brain-map.org/api/v2/structure_graph_download/1.json'
        with _urlreq.urlopen(url, timeout=15) as resp:
            raw = _json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        return jsonify({'error': f'Failed to fetch Allen ontology: {e}'}), 502

    acronym_color = _build_acronym_color_map()
    if isinstance(raw, dict) and 'msg' in raw:
        for root_node in raw['msg']:
            _enrich_ontology_node(root_node, acronym_color)

    get_ontology._cache = raw
    return jsonify(raw)


# ── Brain Atlas RAG Chatbot ───────────────────────────────────────────────────
import json as _json, shutil as _shutil, threading as _threading
import urllib.request as _urllib_req
import urllib.error   as _urllib_err

_chat_ready   = False
_vectorstore  = None
_chat_llm     = None
_kb_documents = []

# ── CortexMap API integration ─────────────────────────────────────────────────
import os as _os_rag
_CORTEXMAP_BASE = _os_rag.environ.get(
    'CORTEXMAP_URL', 'https://capstone.ssdd.dev'
).rstrip('/')

def _cortexmap_fetch(path, method='GET', body=None, timeout=8):
    """HTTP wrapper for the CortexMap orch REST API."""
    url = f"{_CORTEXMAP_BASE}{path}"
    try:
        data_bytes = _json.dumps(body).encode('utf-8') if body is not None else None
        req = _urllib_req.Request(
            url,
            data=data_bytes,
            headers={
                'Accept':       'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'Origin':       'https://capstone.ssdd.dev',
                'Referer':      'https://capstone.ssdd.dev/',
                'User-Agent':   'Mozilla/5.0 (compatible; BrainAtlasClient/1.0)',
            },
            method=method,
        )
        with _urllib_req.urlopen(req, timeout=timeout) as resp:
            return _json.loads(resp.read().decode('utf-8')), ''
    except _urllib_err.HTTPError as e:
        if e.code == 404:
            msg = f"CortexMap 404 at {url} — endpoint may not be deployed yet"
        else:
            msg = f"CortexMap HTTP {e.code} at {url}"
        print(f"[CortexMap] \u26a0 {msg}")
        log.warning(msg)
        return None, msg
    except _urllib_err.URLError as e:
        msg = f"CortexMap unreachable at {_CORTEXMAP_BASE} — {e.reason}"
        print(f"[CortexMap] \u2717 {msg}")
        log.warning(msg)
        return None, msg
    except Exception as e:
        msg = f"CortexMap fetch error for {url} — {e}"
        print(f"[CortexMap] \u2717 {msg}")
        log.warning(msg)
        return None, msg


def _is_exact_cortexmap_match(result, region_name, region_acronym):
    """Return True if a CortexMap search result is an exact name or acronym match."""
    name_match = result.get('name', '').lower() == region_name.lower()
    acro_match = region_acronym and result.get('acronym', '').lower() == region_acronym.lower()
    return name_match or acro_match


def _cortexmap_find_region_id(region_name, region_acronym=''):
    """
    Find a CortexMap region UUID using POST /orch/api/search (ReverseSearch).
    Returns (region_id, error_msg).
    """
    best_id   = None
    best_rank = -1.0
    queries   = [q for q in [region_name.strip(), region_acronym.strip()] if q]

    for query in queries:
        data, err = _cortexmap_fetch('/orch/api/search', method='POST', body={'query': query})
        if err:
            return None, err
        if not data:
            continue
        for r in data.get('results', []):
            rank = float(r.get('rank', 0))
            rid  = r.get('region_id') or r.get('regionId')
            name = r.get('name', '')
            if rid and rank > best_rank:
                best_rank = rank
                best_id   = rid
                print(f"[CortexMap] \u2139 ReverseSearch '{query}' → '{name}' rank={rank:.2f} id={rid}")
            name_match = _is_exact_cortexmap_match(r, region_name, region_acronym)
            if name_match:
                print(f"[CortexMap] \u2139 Exact match: '{query}' → '{name}' id={rid}")
                return rid, ''

    return best_id, ''


def _cortexmap_get_summaries(region_id):
    """
    GET /orch/api/regions/{id}/summaries
    Returns (summary_text, pmc_ids, error_msg).
    """
    import re as _re
    data, err = _cortexmap_fetch(f'/orch/api/regions/{region_id}/summaries')
    if not data:
        return '', [], err
    summaries   = data.get('summaries', [])
    text_parts  = []
    all_pmc_ids = []
    seen_pmc    = set()
    for s in summaries:
        text = s.get('summary', '')
        if text:
            text = _re.sub(r'\[chunk:[a-f0-9\-]+\]', '', text).strip()
            text_parts.append(text)
        for src in s.get('sources', []):
            pid = src.get('pmc_id')
            if pid and pid not in seen_pmc:
                seen_pmc.add(pid)
                all_pmc_ids.append(pid)
    return '\n\n'.join(text_parts), all_pmc_ids, ''


class _Doc:
    """Lightweight document wrapper for the local knowledge base."""
    def __init__(self, content, metadata=None):
        self.page_content = content
        self.metadata = metadata or {}


def _build_kb_docs(regions):
    """Convert raw KB region dicts into _Doc objects for embedding."""
    docs = []
    for r in regions:
        lines = []
        for field in ['structure', 'substructure', 'division', 'category', 'organ', 'acronym']:
            if r.get(field):
                lines.append(f"{field.title()}: {r[field]}")
        if r.get('parcellation_index'):
            lines.append(f"Parcellation Index: {r['parcellation_index']}")
        for field in ['function', 'connectivity', 'clinical_relevance', 'notes']:
            if r.get(field):
                lines.append(f"\n{field.replace('_', ' ').title()}:\n{r[field]}")
        doc = _Doc('\n'.join(lines), {
            'structure':          r.get('structure', '').lower(),
            'parcellation_index': str(r.get('parcellation_index', '')),
            'acronym':            r.get('acronym', '').lower(),
        })
        docs.append(doc)
    return docs


def _build_vectorstore(docs, chroma_path):
    """Rebuild ChromaDB from scratch and return the vectorstore."""
    from langchain_chroma import Chroma
    from langchain_huggingface import HuggingFaceEmbeddings
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    if chroma_path.exists():
        _shutil.rmtree(chroma_path)
        print("Brain Atlas RAG: old ChromaDB deleted — rebuilding…")

    splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=100)
    chunks   = splitter.split_documents(docs)
    print(f"Brain Atlas RAG: embedding {len(chunks)} chunks…")

    embeddings = HuggingFaceEmbeddings(model_name='all-MiniLM-L6-v2')
    store = Chroma.from_documents(
        documents=chunks,
        embedding=embeddings,
        persist_directory=str(chroma_path),
    )
    print("Brain Atlas RAG: vector store ready ✓")
    return store


def _rag_init():
    global _chat_ready, _vectorstore, _chat_llm, _kb_documents
    try:
        from langchain_community.llms import Ollama as _Ollama

        print("=" * 60)
        print("Brain Atlas RAG: starting up…")
        print("Make sure Ollama is running:  ollama serve")
        print("And the model is pulled:      ollama pull gemma3:4b")
        print("=" * 60)

        base    = Path(__file__).parent
        kb_file = base / 'brain_regions_kb.json'

        if not kb_file.exists():
            print(f"ERROR: {kb_file} not found — chat will be unavailable.")
            return

        kb      = _json.loads(kb_file.read_text('utf-8'))
        regions = kb.get('regions', [])
        print(f"Brain Atlas RAG: loaded {len(regions)} regions from brain_regions_kb.json")

        _kb_documents = _build_kb_docs(regions)
        _vectorstore  = _build_vectorstore(_kb_documents, base / 'chroma_db')

        _chat_llm = _Ollama(model='gemma3:4b', temperature=0.3)
        print("Brain Atlas RAG: connecting to Ollama…")
        _chat_llm.invoke("Hello")
        _chat_ready = True
        print("Brain Atlas RAG: fully ready ✓  Open http://localhost:5000")

    except Exception as e:
        print(f"Brain Atlas RAG: FAILED — {e}")

_threading.Thread(target=_rag_init, daemon=True).start()


# ── _rag_answer helpers ───────────────────────────────────────────────────────

def _fetch_cortexmap_context(region_name, region_acronym):
    """
    Try to retrieve a CortexMap summary for region_name.
    Returns (summary_text, pmc_ids, cortexmap_status).
    """
    region_id, fetch_err = _cortexmap_find_region_id(region_name, region_acronym)

    if fetch_err:
        print(f"[CortexMap] \u2717 Could not reach CortexMap — {fetch_err}")
        log.warning(f"CortexMap unreachable for '{region_name}': {fetch_err}")
        return '', [], 'unreachable'

    if not region_id:
        print(f"[CortexMap] \u2139 '{region_name}' not found in /orch/api/regions.")
        log.info(f"CortexMap: '{region_name}' not found in regions list")
        return '', [], 'region_not_found'

    print(f"[CortexMap] \u2139 Found UUID {region_id} for '{region_name}' — fetching summaries...")
    summary, pmc_ids, sum_err = _cortexmap_get_summaries(region_id)

    if sum_err:
        print(f"[CortexMap] \u2717 Could not fetch summaries for '{region_name}' — {sum_err}")
        log.warning(f"CortexMap summaries fetch failed for '{region_name}': {sum_err}")
        return '', [], 'summaries_error'

    if summary:
        print(f"[CortexMap] \u2713 Summaries loaded for '{region_name}' (id={region_id}).")
        log.info(f"CortexMap: summaries loaded for '{region_name}' (id={region_id})")
        return summary, pmc_ids, 'enriched'

    print(f"[CortexMap] \u2139 No summaries yet for '{region_name}' — pipeline may still be generating.")
    log.info(f"CortexMap: '{region_name}' has no summaries yet")
    return '', [], 'generating'


def _find_local_doc(region_name, parcellation_index):
    """Find the best matching local KB document for region_name / parcellation_index."""
    rn = region_name.lower().strip()
    for doc in _kb_documents:
        kb_name = doc.metadata.get('structure', '').lower()
        kb_acro = doc.metadata.get('acronym', '').lower()
        kb_pidx = doc.metadata.get('parcellation_index', '')
        if kb_name == rn or kb_acro == rn or (parcellation_index and kb_pidx == str(parcellation_index)):
            return doc.page_content
    return None


def _build_rag_prompt(question, cortexmap_summary, local_doc):
    """Build the LLM prompt from available context."""
    if cortexmap_summary:
        context = f"=== Research Summaries (CortexMap) ===\n{cortexmap_summary}"
        return (
            "You are a brain atlas assistant. Answer ONLY using the research summary below.\n"
            "Do NOT use your own knowledge. Do NOT guess or infer anything not in the summary.\n\n"
            f"Research summary:\n{context}\n\n"
            f"Question: {question}\n"
            "Answer:"
        )
    if local_doc:
        context = f"=== Local Knowledge Base ===\n{local_doc}"
        return (
            "You are a brain atlas assistant. Answer ONLY using the context below.\n"
            "Do NOT use your own knowledge. Do NOT guess or infer anything not in the context.\n\n"
            f"Region context:\n{context}\n\n"
            f"Question: {question}\n"
            "Answer:"
        )
    return None


def _rag_answer(question, region_name='', parcellation_index='', region_acronym=''):
    """
    CortexMap-first RAG.
    Returns (answer_text, cortexmap_status, pmc_ids).
    """
    cortexmap_summary = ''
    cortexmap_status  = 'local_only'
    pmc_ids           = []

    if region_name:
        try:
            cortexmap_summary, pmc_ids, cortexmap_status = _fetch_cortexmap_context(
                region_name, region_acronym
            )
        except Exception as _e:
            print(f"[CortexMap] \u2717 Unexpected error for '{region_name}': {_e}")
            log.warning(f"CortexMap exception for '{region_name}': {_e}")
            cortexmap_status = 'error'

    local_doc = _find_local_doc(region_name, parcellation_index) if region_name else None

    prompt = _build_rag_prompt(question, cortexmap_summary, local_doc)
    if prompt is None:
        if region_name:
            return (
                f"I don't have any information about '{region_name}' yet. "
                "CortexMap has been notified to generate a summary — try again shortly. "
                "To add it locally now, open brain_regions_kb.json, add an entry with "
                f'"structure": "{region_name}", fill in the fields, then restart the app.'
            ), cortexmap_status, []
        return (
            "No region is currently selected. Click a region in the atlas first, "
            "then ask your question."
        ), cortexmap_status, []

    return _chat_llm.invoke(prompt), cortexmap_status, pmc_ids


@app.route('/api/chat', methods=['POST'])
def chat():
    data               = request.get_json(force=True)
    question           = (data.get('message') or '').strip()
    region_name        = (data.get('region_name') or '').strip()
    region_acronym     = (data.get('region_acronym') or '').strip()
    parcellation_index = str(data.get('parcellation_index') or '').strip()
    ai_provider        = (data.get('ai_provider') or 'ollama').strip().lower()

    if not question:
        return jsonify({'error': 'message required'}), 400

    if ai_provider == 'openai':
        try:
            answer = _gpt_answer(question, region_name, parcellation_index)
            return jsonify({'answer': answer, 'provider': 'openai'})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    if not _chat_ready:
        return jsonify({'answer': 'Still building the knowledge base — please wait a moment and try again.'})

    try:
        answer, cortexmap_status, pmc_ids = _rag_answer(
            question, region_name, parcellation_index, region_acronym
        )
        _notices = {
            'enriched':         None,
            'local_only':       None,
            'unreachable':      '⚠ CortexMap could not be reached. Ollama is using the local knowledge base.',
            'region_not_found': 'ℹ This region was not found in CortexMap. Ollama is using the local knowledge base.',
            'generating':       '⏳ CortexMap is generating summaries for this region. Try again shortly.',
            'summaries_error':  '⚠ CortexMap summaries could not be fetched. Ollama is using the local knowledge base.',
            'no_summaries':     'ℹ CortexMap has no summaries for this region yet. Ollama is using the local knowledge base.',
            'error':            '⚠ CortexMap returned an unexpected error. Ollama is using the local knowledge base.',
        }
        return jsonify({
            'answer':           answer,
            'provider':         'ollama',
            'cortexmap_status': cortexmap_status,
            'cortexmap_notice': _notices.get(cortexmap_status),
            'pmc_sources':      pmc_ids,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── ChatGPT (OpenAI) handler ───────────────────────────────────────────────────
import os as _os


def _gpt_find_region_row(region_name, parcellation_index):
    """Locate a name_df row by parcellation index or region name."""
    pidx = None
    try:
        pidx = int(parcellation_index) if parcellation_index else None
    except (TypeError, ValueError):
        pass

    if pidx is not None and pidx in name_df.index:
        return name_df.loc[pidx], pidx

    if region_name:
        rn = region_name.lower()
        for col in ['structure', 'substructure', 'division', 'category']:
            if col in name_df.columns:
                hits = name_df[name_df[col].fillna('').str.lower() == rn]
                if not hits.empty:
                    return hits.iloc[0], hits.index[0]
    return None, None


def _gpt_build_region_context(region_name, parcellation_index):
    """Build a textual region context string for the GPT prompt."""
    if not region_name and not parcellation_index:
        return ''
    try:
        row, pidx_used = _gpt_find_region_row(region_name, parcellation_index)
        if row is not None:
            parts = []
            for f in ['organ', 'category', 'division', 'structure', 'substructure']:
                val = row.get(f, '—')
                if val and val != '—':
                    parts.append(f"{f.title()}: {val}")
            if pidx_used:
                parts.append(f"Parcellation Index: {pidx_used}")
                try:
                    for level, colname in LEVEL_COLS.items():
                        parts.append(f"{level.title()} Color: {color_df.loc[pidx_used, colname]}")
                except Exception:
                    pass
            return '\n'.join(parts)
        if region_name:
            return (
                f"Region name: {region_name}\n"
                "Note: This region is named in the Allen ontology but is not present "
                "as annotated voxels in the CCFv3 annotation volume."
            )
    except Exception:
        pass
    return f"Region: {region_name}"


def _gpt_answer(question, region_name='', parcellation_index=''):
    """
    Sends the question to OpenAI GPT with region context built from atlas data frames.
    """
    try:
        from openai import OpenAI
    except ImportError:
        return "OpenAI package not installed. Run: pip install openai"

    api_key = _os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        env_path = Path(__file__).parent / '.env'
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith('OPENAI_API_KEY='):
                    api_key = line.split('=', 1)[1].strip()
                    break
    if not api_key:
        return "OpenAI API key not found. Set OPENAI_API_KEY in your .env file."

    client = OpenAI(api_key=api_key)
    region_context = _gpt_build_region_context(region_name, parcellation_index)

    system_prompt = (
        "You are an expert neuroscientist and brain atlas assistant specializing in the "
        "Allen Mouse Brain Common Coordinate Framework v3 (CCFv3). "
        "You have deep knowledge of mouse neuroanatomy, brain region functions, "
        "connectivity, cytoarchitecture, and the Allen Brain Atlas data. "
        "Be concise, accurate, and helpful. When discussing a specific brain region, "
        "explain its function, connectivity, and significance. "
        "If you refer to atlas coordinates, use the CCFv3 voxel space (10 µm resolution)."
    )

    if region_context and 'not present as annotated voxels' in region_context:
        user_content = (
            "The user has selected the following brain region by name. "
            "It is listed in the Allen ontology but has no annotated voxels in the CCFv3 volume:\n"
            f"{region_context}\n\n"
            "Please answer the question using your neuroscience knowledge about this region.\n"
            f"Question: {question}"
        )
    elif region_context:
        user_content = (
            "The user is currently viewing the following brain region in the Allen CCFv3 atlas:\n"
            f"{region_context}\n\n"
            f"Question: {question}"
        )
    else:
        user_content = question

    response = client.chat.completions.create(
        model='gpt-4o-mini',
        messages=[
            {'role': 'system', 'content': system_prompt},
            {'role': 'user',   'content': user_content},
        ],
        max_tokens=600,
        temperature=0.4,
    )
    return response.choices[0].message.content.strip()


if __name__ == '__main__':
    print("\nOpen your browser at: http://localhost:5000\n")
    app.run(debug=False, port=5000)