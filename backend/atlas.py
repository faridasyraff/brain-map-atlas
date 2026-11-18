"""The Allen CCFv3 atlas data and everything computed from it: downloading,
memory-mapped volumes, per-slice histograms, the ontology/term tree, color
tables, slice extraction and rendering, mesh download, and the mesh-derived
3D click volume. Loaded once at import.

Volume in memory (SimpleITK reverses the file's axis order): shape (1140, 800, 1320)
  axis-0 (x): left     -> right       size 1140   (sagittal slider)
  axis-1 (y): superior -> inferior    size  800   (transverse slider)
  axis-2 (z): anterior -> posterior   size 1320   (coronal slider)

View slice extraction (ready for display):
  sagittal   fix x -> arr[xi,:,:]                rows=y  cols=z  shape (800, 1320)
  coronal    fix z -> zyx copy [zi] = arr[:,:,zi].T  rows=y  cols=x  shape (800, 1140)
  transverse fix y -> arr[:,yi,:]                rows=x  cols=z  shape (1140, 1320)
"""
import sys as _sys
import io, base64, json
import time as _time
from pathlib import Path
import numpy as np
import SimpleITK as sitk
from PIL import Image
from flask import jsonify
from abc_atlas_access.abc_atlas_cache.abc_project_cache import AbcProjectCache

# ── Load atlas data once ──────────────────────────────────────────────────────
print("Loading ABC Atlas data … this may take a moment.")

DOWNLOAD_BASE = Path(__file__).parent / 'data' / 'abc_atlas'
DOWNLOAD_BASE.mkdir(parents=True, exist_ok=True)

abc_cache = AbcProjectCache.from_cache_dir(DOWNLOAD_BASE)

# ── Pre-flight: download any missing files ────────────────────────────────────
# All files live under Allen-CCF-2020 directory.
# Image volumes (~400 MB total) and metadata CSVs are checked individually.

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

# ── Atlas volumes: memory-mapped, not loaded into RAM ───────────────────────
# The three 10 µm volumes are ~1.2 billion voxels each (≈6 GB together).
# Instead of holding them in process memory, each is converted once to a
# plain .npy file in data/npy/ and memory-mapped: the OS reads in only the
# parts actually used (a few slices per click) and can drop them again under
# memory pressure, so the app no longer needs a machine with 8 GB of RAM.
# The first start pays a one-time conversion (a few minutes, ~12 GB of
# disk: each volume plus a coronal-ordered copy — see load_coronal_copy).
_NPY_DIR = Path(__file__).parent / 'data' / 'npy'

def load_arr(name):
    npy = _NPY_DIR / f'{name}.npy'
    if not npy.is_file():
        _NPY_DIR.mkdir(parents=True, exist_ok=True)
        src = abc_cache.get_file_path(directory='Allen-CCF-2020', file_name=name)
        print(f"Converting {name} to a memory-mappable file (one-time)…")
        img = sitk.ReadImage(str(src))
        tmp = npy.with_name(npy.name + '.tmp')
        with open(tmp, 'wb') as fh:
            np.save(fh, sitk.GetArrayViewFromImage(img))   # a view: no second in-RAM copy
        del img
        tmp.replace(npy)
    return np.load(npy, mmap_mode='r')

annotation_array = load_arr('annotation_10')   # (1140, 800, 1320) = (x, y, z)
template_array   = load_arr('average_template_10')
boundary_array   = load_arr('annotation_boundary_10')

def load_coronal_copy(name, arr):
    """The same volume stored z-major, shape (z, y, x). A coronal slice is
    arr[:, :, z] — in the x-major file those voxels are spread over every
    page, so with memory mapping each coronal slice would touch all ~2.4 GB.
    In this copy it's one contiguous 1.8 MB block (and already in the
    rows=y, cols=x orientation the views use). Costs disk, not RAM."""
    npy = _NPY_DIR / f'{name}_zyx.npy'
    if not npy.is_file():
        print(f"Building coronal-ordered copy of {name} (one-time)…")
        tmp = npy.with_name(npy.name + '.tmp')
        X, Y, Z = arr.shape
        out = np.lib.format.open_memmap(tmp, mode='w+', dtype=arr.dtype, shape=(Z, Y, X))
        for z0 in range(0, Z, 64):            # 64 slices at a time keeps RAM use small
            z1 = min(Z, z0 + 64)
            out[z0:z1] = np.transpose(arr[:, :, z0:z1], (2, 1, 0))
        out.flush(); del out
        tmp.replace(npy)
    return np.load(npy, mmap_mode='r')

annotation_zyx = load_coronal_copy('annotation_10', annotation_array)
template_zyx   = load_coronal_copy('average_template_10', template_array)
boundary_zyx   = load_coronal_copy('annotation_boundary_10', boundary_array)

# ── Per-axis "which slice has how many voxels of this region" lookup ─────────
# Finding where to center the view on a region (or a whole group of them, like
# clicking "Cerebrum" in the tree) used to mean scanning the entire ~1.2
# billion-voxel volume on every single click — a few seconds each time, and
# the biggest groups took close to 10.
#
# Instead, we count this ONCE: for every slice along every axis, how many
# voxels of each parcellation_index are in it. That table (axis_length x
# number_of_regions, a few MB) lets any future request — one region or
# hundreds combined — get its answer by adding up a handful of
# already-computed numbers instead of rescanning the volume. Looking up a
# 339-region group this way takes about a hundredth of a second.
#
# All three tables are built in ONE sequential pass over the volume (one
# x-slab at a time), which is what a memory-mapped file reads fastest, and
# cached to data/npy/ so later starts skip it entirely.
def _build_histograms():
    cache = _NPY_DIR / 'annotation_10_hist.npz'
    if cache.is_file():
        h = np.load(cache)
        return h['x'], h['y'], h['z']
    print("Building per-slice region histograms (one-time, cached afterwards)…")
    t0 = _time.time()
    X, Y, Z = annotation_array.shape
    k = int(annotation_array.max()) + 1
    xh = np.zeros((X, k), dtype=np.int32)
    yh = np.zeros((Y, k), dtype=np.int64)
    zh = np.zeros((Z, k), dtype=np.int64)
    rows = np.repeat(np.arange(Y, dtype=np.int64), Z) * k   # flat (y, z) -> y*k
    cols = np.tile(np.arange(Z, dtype=np.int64), Y) * k     # flat (y, z) -> z*k
    for x in range(X):
        v = np.asarray(annotation_array[x], dtype=np.int64).ravel()
        xh[x] = np.bincount(v, minlength=k)
        yh += np.bincount(rows + v, minlength=Y * k).reshape(Y, k)
        zh += np.bincount(cols + v, minlength=Z * k).reshape(Z, k)
    yh, zh = yh.astype(np.int32), zh.astype(np.int32)
    tmp = cache.with_name('annotation_10_hist.tmp.npz')
    np.savez(tmp, x=xh, y=yh, z=zh)
    tmp.replace(cache)
    print(f"Region histograms built in {_time.time() - t0:.1f}s")
    return xh, yh, zh

_x_hist, _y_hist, _z_hist = _build_histograms()
_MAX_PIDX = _x_hist.shape[1] - 1

# Which parcellation indices actually have voxels — used to flag "no
# highlight available" regions in search results. Read off the histograms
# (np.unique over the full volume would make a 2.4 GB sorted copy).
_indices_with_voxels = set(np.nonzero(_x_hist.sum(axis=0))[0].tolist())
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
# From the official docs:
#
# parcellation_term.csv
#   label, acronym, name, identifier, parent_identifier, ...
#   — defines all named anatomical terms and their parent→child hierarchy
#   — identifier = "MBA:997", parent_identifier = "MBA:8"
#
# parcellation_to_parcellation_term_membership.csv
#   parcellation_index, parcellation_term_label, parcellation_term_set_label, ...
#   — directly maps each parcellation_index to every term it belongs to
#   — parcellation_term_label matches parcellation_term.label
#
# Pipeline:
#   1. Build term tree from parcellation_term.csv (identifier → children)
#   2. Build term_label → set of parcellation_indices from membership CSV
#   3. _collect_leaf_indices(term_id) walks the tree and unions all indices

try:
    # Load parcellation_term.csv
    term_df = abc_cache.get_metadata_dataframe(
        directory='Allen-CCF-2020',
        file_name='parcellation_term')
    print(f"parcellation_term: {term_df.shape}  cols: {list(term_df.columns)}")

    # Load the direct membership mapping
    membership_df = abc_cache.get_metadata_dataframe(
        directory='Allen-CCF-2020',
        file_name='parcellation_to_parcellation_term_membership')
    print(f"membership: {membership_df.shape}  cols: {list(membership_df.columns)}")

    # Build term_label → set of parcellation_indices
    _term_label_to_indices = {}
    for _, row in membership_df.iterrows():
        pidx   = int(row['parcellation_index'])
        tlabel = str(row['parcellation_term_label']).strip()
        _term_label_to_indices.setdefault(tlabel, set()).add(pidx)
    print(f"term_label→indices: {len(_term_label_to_indices)} terms mapped")

    # Use ONLY AllenCCF-Ontology-2017 rows — they have proper parent_identifier links.
    # ABC-Ontology-2023 rows share identifiers but have no parent_identifier so they
    # would break the tree structure.
    allen_rows = term_df[term_df['label'].str.startswith('AllenCCF-Ontology-2017')].copy()

    # Build identifier → label so we can resolve parent_identifier → parent label
    _id_to_label = {}
    for _, row in allen_rows.iterrows():
        tid = str(row.get('identifier') or '').strip()
        if tid:
            _id_to_label[tid] = str(row['label']).strip()

    # Build label → node (label is unique and matches membership CSV)
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

    # Wire parent → children using labels
    for label, node in _term_nodes.items():
        plabel = node['parent_label']
        if plabel and plabel in _term_nodes:
            _term_nodes[plabel]['children'].append(label)

    # Lookups: name.lower() → label,  acronym.lower() → label
    _name_to_term_id = {}
    _acro_to_term_id = {}
    for label, node in _term_nodes.items():
        if node['name']:
            _name_to_term_id[node['name'].lower()] = label
        if node['acronym']:
            _acro_to_term_id[node['acronym'].lower()] = label

    # Also build struct_id → RGB lookup for direct colorize from annotation volume
    # annotation_array voxel values are numeric Allen structure IDs (e.g. 997, 567)
    # parcellation_term.csv identifier = "MBA:997" → strip prefix → int → RGB
    _struct_id_to_rgb = {}  # int struct_id → (r, g, b)
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

    # pidx → Allen structure_id (MBA identifier, int). Needed so /api/lookup
    # can tell the frontend which mesh to load when a user clicks a 2D
    # pixel. Built by walking membership_df and mapping each pidx's
    # term_label → MBA identifier via _term_nodes.
    _pidx_to_sid = {}
    for label, node in _term_nodes.items():
        tid = (node.get('id') or '').strip()
        if not tid.startswith('MBA:'):
            continue
        try:
            sid = int(tid.replace('MBA:', ''))
        except ValueError:
            continue
        if label in _term_label_to_indices:
            for pidx in _term_label_to_indices[label]:
                # If multiple sids map to the same pidx, keep the first (ordering
                # is stable; collisions are rare).
                _pidx_to_sid.setdefault(int(pidx), sid)
    print(f"pidx→sid lookup: {len(_pidx_to_sid)} entries")

except Exception as e:
    term_df               = None
    membership_df         = None
    _term_nodes           = {}
    _term_label_to_indices = {}
    _name_to_term_id      = {}
    _acro_to_term_id      = {}
    _struct_id_to_rgb     = {}
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

    # Add parcellation_indices directly associated with this term's label
    if term_label in _term_label_to_indices:
        indices.update(_term_label_to_indices[term_label])

    # Recurse into children
    for child_label in node['children']:
        indices.update(_collect_leaf_indices(child_label, visited))

    return indices



# color_df columns: organ_color, category_color, division_color,
#                   structure_color, substructure_color  (hex strings)
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

# Build channels exactly as the Allen CCFv3 docs show:
# channels['red'] is a DataFrame indexed by parcellation_index,
# columns = [organ_color, category_color, division_color, structure_color, substructure_color]
# This mirrors the docs: channels[c].loc[zslice.flat[:], '%s_color' % term_set]
channels = {}
for ch in ['red', 'green', 'blue']:
    channels[ch] = {}

for level, col in LEVEL_COLS.items():
    r, g, b = hex_to_rgb_cols(color_df[col])
    channels['red'][col]   = r
    channels['green'][col] = g
    channels['blue'][col]  = b

# ── Pre-build LUT from parcellation_to_parcellation_term_membership_color ────
# This is exactly what the Allen CCFv3 docs use for colorize():
#   channels[c].loc[zslice.flat[:], 'structure_color']
# color_df is indexed by parcellation_index (same values as annotation_array voxels).
# We build a dense numpy array _color_lut_structure[parcellation_index] = (r,g,b)
# using the 'structure_color' column — this gives the clean region-level coloring
# shown in the docs (big green cortex, pink thalamus, red brainstem etc.).

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

# (The second return value is the color table's size. It used to be assigned
# to _MAX_PIDX here, silently replacing the histogram bound set above — so
# the range checks let index 1328 through and /api/region_center_indices
# crashed with IndexError.)
_color_lut_structure,    _ = _build_lut_from_color_df('structure_color')
_color_lut_substructure, _         = _build_lut_from_color_df('substructure_color')
_color_lut_division,     _         = _build_lut_from_color_df('division_color')

# Default LUT used by colorize() — structure level matches the docs visually
_color_lut = _color_lut_structure

print(f"Color LUT built from color_df structure_color: "
      f"{np.any(_color_lut > 0, axis=1).sum()} colored parcellations")
print("Color tables loaded.")

# Also store the raw hex for highlight use
def get_hex_for_index(parcellation_index, level):
    col = LEVEL_COLS.get(level, 'structure_color')
    try:
        return color_df.loc[parcellation_index, col]
    except KeyError:
        return '#00d4ff'

# ── Volume dimensions ─────────────────────────────────────────────────────────
X_MAX = annotation_array.shape[0] - 1   # 1139 (L-R)
Y_MAX = annotation_array.shape[1] - 1   #  799 (S-I)
Z_MAX = annotation_array.shape[2] - 1   # 1319 (A-P)

print(f"Atlas loaded. Shape: {annotation_array.shape}  x:0-{X_MAX}  y:0-{Y_MAX}  z:0-{Z_MAX}")


# ── 3D mesh auto-downloader ──────────────────────────────────────────────────
# On startup, ensures ./meshes/ exists and is populated with Allen CCFv3 OBJ
# files. If the folder is missing or near-empty, downloads them in parallel
# from Allen's public archive. Skips anything already on disk, so the first
# launch takes ~2-5 minutes and subsequent launches are instant.
def _ensure_meshes():
    import json
    import urllib.request, urllib.error
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import time
    import trimesh

    meshes_dir = Path(__file__).parent / 'meshes'
    meshes_dir.mkdir(exist_ok=True)

    # Fast path: if we already have a lot of meshes, assume we're done.
    existing = {p.stem for p in meshes_dir.glob('*.glb') if p.stat().st_size > 0}
    if len(existing) >= 800:
        print(f"3D meshes: {len(existing)} already present in {meshes_dir.name}/, skipping download.")
        return

    # Otherwise, walk the Allen ontology and try to fetch every structure id.
    # Most ontology nodes have a mesh; some (abstract groupings) return 404.
    print(f"3D meshes: only {len(existing)} present, fetching from Allen…")
    try:
        with urllib.request.urlopen(
            'http://api.brain-map.org/api/v2/structure_graph_download/1.json', timeout=20) as r:
            ontology = json.loads(r.read().decode('utf-8'))
    except Exception as e:
        print(f"3D meshes: could NOT fetch ontology ({e}). The 3D view will be empty.")
        return

    ids = []
    def _collect(n):
        ids.append(n['id'])
        for c in n.get('children') or []:
            _collect(c)
    _collect(ontology['msg'][0])
    ids = sorted(set(ids))

    todo = [i for i in ids if str(i) not in existing]
    if not todo:
        print(f"3D meshes: {len(existing)} on disk, all ontology IDs covered.")
        return
    print(f"3D meshes: {len(existing)} on disk, trying {len(todo)} more…")

    base = ('https://download.alleninstitute.org/informatics-archive/current-release/'
            'mouse_ccf/annotation/ccf_2017/structure_meshes/')
    done = [0]; ok = [0]; missing = [0]; started = time.time()

    def _grab(sid):
        obj_path = meshes_dir / f'{sid}.obj'
        try:
            req = urllib.request.Request(
                f'{base}{sid}.obj',
                headers={'User-Agent': 'brain-atlas-downloader/1.0'})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            obj_path.write_bytes(data)
            # Allen only serves this large, plain-text format — convert it to
            # the much smaller .glb right away and don't keep the .obj around
            # (see convert_meshes_to_glb.py for the equivalent one-off script).
            mesh = trimesh.load(obj_path, force='mesh')
            mesh.export(meshes_dir / f'{sid}.glb')
            return True
        except urllib.error.HTTPError:
            return False    # 404 is normal for abstract groupings
        except Exception:
            return False
        finally:
            obj_path.unlink(missing_ok=True)  # never leave the temporary .obj behind, success or not

    with ThreadPoolExecutor(max_workers=16) as ex:
        futures = [ex.submit(_grab, i) for i in todo]
        for fut in as_completed(futures):
            done[0] += 1
            if fut.result():
                ok[0] += 1
            else:
                missing[0] += 1
            if done[0] % 100 == 0 or done[0] == len(todo):
                rate = done[0] / max(time.time() - started, 0.1)
                print(f"  3D meshes: {done[0]}/{len(todo)} "
                      f"(got {ok[0]}, missing {missing[0]}) {rate:.1f}/s")

    total = len(list(meshes_dir.glob('*.glb')))
    print(f"3D meshes: {total} now on disk in {meshes_dir.name}/.")


_ensure_meshes()


VIEW_CFG = {
    'sagittal':   {'figsize': (13.2, 8.0),  'max': X_MAX},
    'coronal':    {'figsize': (11.4, 8.0),  'max': Z_MAX},
    'transverse': {'figsize': (11.4, 13.2), 'max': Y_MAX},
}

# Cache of (view, idx) -> (render_w, render_h) so highlight doesn't re-render
_render_size_cache = {}

# ── Slice extraction ──────────────────────────────────────────────────────────
def get_slices(view, idx):
    if view == 'sagittal':
        xi = max(0, min(idx, X_MAX))
        return (template_array[xi,:,:],
                boundary_array[xi,:,:],
                annotation_array[xi,:,:])
    elif view == 'coronal':
        # From the z-major copies (see load_coronal_copy): same values as
        # arr[:,:,zi].T, but one contiguous read instead of the whole file.
        zi = max(0, min(idx, Z_MAX))
        return (template_zyx[zi],
                boundary_zyx[zi],
                annotation_zyx[zi])
    elif view == 'transverse':
        yi = max(0, min(idx, Y_MAX))
        return (template_array[:,yi,:],
                boundary_array[:,yi,:],
                annotation_array[:,yi,:])
    raise ValueError(f"Unknown view: {view}")

def world_coords(view, idx, col, row):
    if view == 'sagittal':    return idx, row, col
    elif view == 'coronal': return col, row, idx
    elif view == 'transverse': return row, idx, col
    return 0, 0, 0

# Both helpers below answer "which slice(s) contain these regions" using the
# _x_hist/_y_hist/_z_hist tables computed once at startup, instead of
# rescanning the full ~1.2 billion-voxel volume on every request. Summing a
# handful of pre-counted columns together is what used to take several
# seconds (or, before that, crashed the server outright for big groups —
# see the histogram pre-compute comment near where annotation_array loads).
def _hist_centroid_by_slice(member_arr):
    """Returns (xi, yi, zi, voxel_count): the slice index along each axis
    with the most voxels belonging to any index in `member_arr`, and the
    total voxel count. Returns None if none of them have any voxels."""
    # member_arr sometimes comes straight from a request body — drop anything
    # outside the histogram's column range instead of letting it index-error.
    # (Real parcellation_index values never exceed _MAX_PIDX; this only
    # matters for a bad/malicious value slipping through the request.)
    member_arr = member_arr[(member_arr >= 0) & (member_arr <= _MAX_PIDX)]
    if member_arr.size == 0:
        return None
    x_counts = _x_hist[:, member_arr].sum(axis=1)
    voxel_count = int(x_counts.sum())
    if voxel_count == 0:
        return None
    y_counts = _y_hist[:, member_arr].sum(axis=1)
    z_counts = _z_hist[:, member_arr].sum(axis=1)
    xi = int(np.argmax(x_counts))
    yi = int(np.argmax(y_counts))
    zi = int(np.argmax(z_counts))
    return xi, yi, zi, voxel_count

def _hist_bbox(member_arr):
    """Returns (x_min, x_max, y_min, y_max, z_min, z_max): the bounding box
    of every voxel belonging to any index in `member_arr`. Returns None if
    none of them have any voxels."""
    member_arr = member_arr[(member_arr >= 0) & (member_arr <= _MAX_PIDX)]
    if member_arr.size == 0:
        return None
    x_idx = np.where(_x_hist[:, member_arr].sum(axis=1) > 0)[0]
    if x_idx.size == 0:
        return None
    y_idx = np.where(_y_hist[:, member_arr].sum(axis=1) > 0)[0]
    z_idx = np.where(_z_hist[:, member_arr].sum(axis=1) > 0)[0]
    return (int(x_idx.min()), int(x_idx.max()),
            int(y_idx.min()), int(y_idx.max()),
            int(z_idx.min()), int(z_idx.max()))

# ── Colorize a 2-D annotation slice using the official color table ───────────
def colorize(annot_slice, level='structure'):
    """
    Fast numpy LUT colorize using parcellation_to_parcellation_term_membership_color.
    annot_slice voxels ARE parcellation_index values (same index as color_df).
    Uses structure_color by default — matches the clean Allen CCFv3 doc colorization
    (big uniform regions: green cortex, pink thalamus, red brainstem, etc.).
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
def render_to_b64(tmpl, bnd, annot, colorize_level=None, fw=None, fh=None):
    """Composite one slice into a PNG at the atlas's native resolution:
      1. the grey template, contrast-stretched to this slice's own min..max
      2. the region colors at ~70% opacity wherever there is a region
      3. the region boundary lines on top (black, opacity = boundary/225)
    This is exactly what the old matplotlib version drew (imshow with the
    Greys_r / RGBA / Greys layers), done directly with numpy + Pillow — about
    10x faster, which matters because every click re-renders 2-3 slices.
    It also needs no shared plotting state, so it's safe across threads.
    fw/fh are ignored (kept so old call sites still work)."""
    t = tmpl.astype(np.float32)
    lo, hi = float(t.min()), float(t.max())
    grey = (t - lo) * (255.0 / (hi - lo)) if hi > lo else np.zeros_like(t)
    out = np.repeat(grey[:, :, None], 3, axis=2)              # (H, W, 3) float

    if colorize_level and colorize_level != 'off':
        rgb = colorize(annot, colorize_level).astype(np.float32)
        a = np.where(annot > 0, 178.0 / 255.0, 0.0).astype(np.float32)[:, :, None]
        out = out * (1.0 - a) + rgb * a

    b = bnd.astype(np.float32)
    b_lo, b_hi = float(b.min()), float(b.max())
    # 'Greys' colormap: low values white, high values black
    b_col = 255.0 * (1.0 - (b - b_lo) / (b_hi - b_lo)) if b_hi > b_lo else np.full_like(b, 255.0)
    b_a = np.clip(b / 225.0, 0.0, 1.0)[:, :, None]
    out = out * (1.0 - b_a) + b_col[:, :, None] * b_a

    img = Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), 'RGB')
    buf = io.BytesIO()
    img.save(buf, format='PNG', compress_level=3)   # 3: much faster than the default 6, ~same size
    h, w = annot.shape
    return base64.b64encode(buf.getvalue()).decode('utf-8'), w, h


# ── Mesh-derived volume (from voxelize_meshes.py) ─────────────────────────
# Loaded lazily on first request. meshes_volume.npy is uint16, voxels = structure_id
# (Allen structure_id, NOT parcellation_index).
_MESH_VOL = {'array': None, 'meta': None, 'bytes': None}
_MESH_LUT = {'bytes': None, 'max_id': 0}

# Where the volume lives. The primary location is inside data/, which Docker
# keeps in the persistent `atlas-data` volume, so it survives restarts. The
# old location (next to App.py) is still checked so an existing local copy
# made by running voxelize_meshes.py by hand keeps working.
_MESH_VOL_PRIMARY = Path(__file__).parent / 'data' / 'meshes_volume'
_MESH_VOL_LEGACY  = Path(__file__).parent / 'meshes_volume'
# While voxelize_meshes.py runs, this file holds its pid + start time. It's
# on disk (not just in memory) so that if gunicorn restarts its worker
# mid-build, the new worker sees the build already running instead of
# starting a second one writing to the same files.
_MESH_VOL_LOCK = _MESH_VOL_PRIMARY.with_suffix('.lock')
_MESH_VOL_LOG  = Path(__file__).parent / 'logs' / 'voxelize.log'


def _mesh_volume_paths():
    """Return (npy, json) for the first location where BOTH files exist as
    real files, or None. `is_file()` (not `exists()`) matters: when Docker
    bind-mounts a path that doesn't exist on the host, it creates an empty
    directory there, which `exists()` would happily accept."""
    for stem in (_MESH_VOL_PRIMARY, _MESH_VOL_LEGACY):
        npy, jsn = stem.with_suffix('.npy'), stem.with_suffix('.json')
        if npy.is_file() and jsn.is_file():
            return npy, jsn
    return None


def _voxelizer_job():
    """(pid, started_at) of a voxelize_meshes.py run that is still alive, or
    None. A lock left behind by a run that crashed or was killed (or by an
    earlier container whose pid now belongs to something else) is ignored."""
    try:
        pid_s, started_s = _MESH_VOL_LOCK.read_text().split()
        pid, started = int(pid_s), float(started_s)
    except (OSError, ValueError):
        return None
    proc = _MESH_VOL_PROC['proc']
    if proc is not None and proc.pid == pid:          # started by this process
        return (pid, started) if proc.poll() is None else None
    if Path('/proc').is_dir():                         # Linux / Docker
        try:
            alive = b'voxelize_meshes.py' in Path(f'/proc/{pid}/cmdline').read_bytes()
        except OSError:
            alive = False
        return (pid, started) if alive else None
    # Windows/macOS dev fallback (os.kill(pid, 0) would send Ctrl+C on
    # Windows): trust the lock only while it's young enough to be a live run.
    return (pid, started) if _time.time() - started < 30 * 60 else None


_MESH_VOL_PROC = {'proc': None}


def _ensure_mesh_volume():
    """If the mesh volume doesn't exist yet, build it in the background by
    running voxelize_meshes.py as a separate process (takes ~7 minutes).
    A separate process keeps that CPU-heavy work from slowing down the web
    server, and the rest of the app works normally in the meantime — only
    clicking inside the 3D eBrain view waits for it."""
    import subprocess
    if _mesh_volume_paths() is not None or _voxelizer_job() is not None:
        return
    meshes_dir = Path(__file__).parent / 'meshes'
    if not any(meshes_dir.glob('*.glb')):
        print('mesh volume: no meshes on disk, skipping voxelization.')
        return
    _MESH_VOL_PRIMARY.parent.mkdir(parents=True, exist_ok=True)
    print(f'mesh volume: not found, generating in the background (log: logs/{_MESH_VOL_LOG.name})…')
    with open(_MESH_VOL_LOG, 'w', encoding='utf-8') as log_fh:   # child keeps its own copy
        proc = subprocess.Popen(
            # -u: unbuffered, so logs/voxelize.log shows progress as it happens
            [_sys.executable, '-u', str(Path(__file__).parent / 'voxelize_meshes.py'),
             '--meshes-dir', str(meshes_dir), '--out', str(_MESH_VOL_PRIMARY)],
            stdout=log_fh, stderr=subprocess.STDOUT, cwd=str(Path(__file__).parent))
    _MESH_VOL_PROC['proc'] = proc
    _MESH_VOL_LOCK.write_text(f'{proc.pid} {_time.time()}')


_ensure_mesh_volume()


def _mesh_volume_missing_response():
    job = _voxelizer_job()
    if job is not None:
        mins = (_time.time() - job[1]) / 60
        return jsonify({'error': 'The 3D click volume is still being generated '
                                 f'(started {mins:.0f} min ago, usually takes ~7). Try again shortly.',
                        'status': 'generating'}), 503
    if _MESH_VOL_LOCK.exists():
        # A run was started but is gone without producing the files.
        return jsonify({'error': 'Generating the 3D click volume failed — see '
                                 'logs/voxelize.log. Restart the app to try again.',
                        'status': 'failed'}), 500
    return jsonify({'error': 'meshes_volume.npy not found; run voxelize_meshes.py',
                    'status': 'missing'}), 404


def _load_mesh_volume():
    if _MESH_VOL['array'] is not None:
        return _MESH_VOL
    paths = _mesh_volume_paths()
    if paths is None or _voxelizer_job() is not None:   # don't read mid-write
        return None
    npy, jsn = paths
    _MESH_VOL_LOCK.unlink(missing_ok=True)   # build finished; lock no longer needed
    arr = np.load(npy)
    meta = json.loads(jsn.read_text())
    _MESH_VOL['array'] = arr
    _MESH_VOL['meta']  = meta
    # Volume is uint16 compact indices (1..N); 0 = empty
    _MESH_VOL['bytes'] = np.ascontiguousarray(arr, dtype=np.uint16).tobytes()
    print(f"mesh_volume loaded: shape={arr.shape} dtype={arr.dtype} "
          f"compact-ids={len(meta.get('ids_written', []))} "
          f"size={len(_MESH_VOL['bytes'])/1024/1024:.1f}MB")
    return _MESH_VOL
