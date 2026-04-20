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

def load_arr(name):
    f = abc_cache.get_file_path(directory='Allen-CCF-2020', file_name=name)
    return sitk.GetArrayFromImage(sitk.ReadImage(f))

annotation_array = load_arr('annotation_10')   # (1320, 800, 1140)
template_array   = load_arr('average_template_10')
boundary_array   = load_arr('annotation_boundary_10')

# Pre-compute which parcellation indices actually have voxels — used to flag
# "no highlight available" regions in search results.
_indices_with_voxels = set(np.unique(annotation_array).tolist())
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

_color_lut_structure,    _MAX_PIDX = _build_lut_from_color_df('structure_color')
_color_lut_substructure, _         = _build_lut_from_color_df('substructure_color')
_color_lut_division,     _         = _build_lut_from_color_df('division_color')

# Default LUT used by colorize() — structure level matches the docs visually
_color_lut = _color_lut_structure
_MAX_STRUCT_ID = _MAX_PIDX

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
X_MAX = annotation_array.shape[0] - 1   # 1319
Y_MAX = annotation_array.shape[1] - 1   #  799
Z_MAX = annotation_array.shape[2] - 1   # 1139

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

    meshes_dir = Path(__file__).parent / 'meshes'
    meshes_dir.mkdir(exist_ok=True)

    # Fast path: if we already have a lot of meshes, assume we're done.
    existing = {p.stem for p in meshes_dir.glob('*.obj') if p.stat().st_size > 0}
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
        try:
            req = urllib.request.Request(
                f'{base}{sid}.obj',
                headers={'User-Agent': 'brain-atlas-downloader/1.0'})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            (meshes_dir / f'{sid}.obj').write_bytes(data)
            return True
        except urllib.error.HTTPError:
            return False    # 404 is normal for abstract groupings
        except Exception:
            return False

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

    total = len(list(meshes_dir.glob('*.obj')))
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
    elif view == 'coronal': return col, row, idx
    elif view == 'transverse': return row, idx, col
    return 0, 0, 0

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
def render_to_b64(tmpl, bnd, annot, colorize_level=None, fw=10, fh=8):
    fig, ax = plt.subplots(figsize=(fw, fh), dpi=100)
    ax.imshow(tmpl, cmap='Greys_r', origin='upper')

    # ── Color mode: overlay official atlas region colors ──────────────────────
    if colorize_level and colorize_level != 'off':
        rgb = colorize(annot, colorize_level)          # (H, W, 3) uint8
        rgba = np.concatenate(
            [rgb, np.where(annot[:, :, None] > 0,
                           np.full((*annot.shape, 1), 178, dtype=np.uint8),   # alpha ~70%
                           np.zeros((*annot.shape, 1), dtype=np.uint8))],
            axis=2)                                    # (H, W, 4) RGBA
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


# ── 3D mesh endpoint ──────────────────────────────────────────────────────────
# Serves CCFv3 structure meshes from the local ./meshes/ folder.
# The meshes/ folder must contain {structure_id}.obj files (Allen CCFv3 format).
# The Allen downloader script (download_meshes.py from the 3D viewer project)
# produces this exact layout.
@app.route('/meshes/<int:struct_id>.obj')
def serve_mesh(struct_id):
    meshes_dir = Path(__file__).parent / 'meshes'
    fname = f'{struct_id}.obj'
    if not (meshes_dir / fname).exists():
        return jsonify({'error': f'mesh {struct_id} not available'}), 404
    return send_from_directory(meshes_dir, fname, mimetype='text/plain')


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
        _render_size_cache[(view, idx)] = (render_w, render_h)  # cache for highlight endpoint
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

        _check_rapid(_rapid_lookup, parcellation_index, matched_name, 'lookup')
        log.info(f'lookup ok — pidx={parcellation_index} name={matched_name}')
        return jsonify(result)
    except KeyError:
        log.warning(f'lookup — no region for parcellation_index={parcellation_index}')
        return jsonify({**base, **colors,
                        'error': f'No region for index {parcellation_index}'})
    except Exception as e:
        log.error(f'lookup exception — {e}\n{traceback.format_exc()}')
        return jsonify({'error': str(e)}), 500


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




@app.route('/api/resolve_acronyms', methods=['POST'])
def resolve_acronyms():
    """
    POST { acronyms: [...] }
    Resolves a list of acronyms to parcellation_indices in one shot.
    Used for Allen-tree container nodes (e.g. Cerebrum) not in name_df.
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

    xi = int(np.argmax(np.bincount(voxels[:,0], minlength=annotation_array.shape[0])))
    yi = int(np.argmax(np.bincount(voxels[:,1], minlength=annotation_array.shape[1])))
    zi = int(np.argmax(np.bincount(voxels[:,2], minlength=annotation_array.shape[2])))
    xi = max(0, min(xi, VIEW_CFG['sagittal']['max']))
    yi = max(0, min(yi, VIEW_CFG['transverse']['max']))
    zi = max(0, min(zi, VIEW_CFG['coronal']['max']))
    return jsonify({'xi': xi, 'yi': yi, 'zi': zi,
                    'voxel_count': int(len(voxels)), 'member_count': len(indices)})


@app.route('/api/group_by_term', methods=['POST'])
def group_by_term():
    """
    POST { name, acronym }
    Looks up the term in parcellation_term.csv tree, collects all leaf
    parcellation_indices under it, and returns centroid + member count.
    This is the ground-truth grouping path — works for ANY named term
    including container nodes like Cerebrum, Vermal regions, Piriform area.
    """
    data    = request.get_json(force=True)
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


@app.route('/api/highlight_group', methods=['POST'])
def highlight_group():
    """
    POST { view, idx, group_level, group_name }
    Highlights ALL parcellation indices whose name_df[group_level] == group_name.
    Renders a semi-transparent purple fill so the underlying template is still
    readable, then draws bright boundary lines on top of the fill so internal
    region separations remain clearly visible.
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


@app.route('/api/debug_name')
def debug_name():
    name = request.args.get('q','').strip().lower()
    result = {}
    for col in ['organ','category','division','structure','substructure']:
        if col not in name_df.columns: continue
        hits = name_df[name_df[col].fillna('').str.lower().str.contains(name, regex=False)]
        if not hits.empty:
            result[col] = hits[col].dropna().unique().tolist()[:20]
    # Also show full rows for exact match
    exact_rows = []
    for col in ['organ','category','division','structure','substructure']:
        if col not in name_df.columns: continue
        hits = name_df[name_df[col].fillna('').str.lower() == name]
        for idx, row in hits.iterrows():
            exact_rows.append({'parcellation_index': int(idx), **{c: str(row.get(c,'')) for c in ['organ','category','division','structure','substructure']}})
    result['_exact_rows'] = exact_rows[:10]
    return jsonify(result)


@app.route('/api/find_group_level', methods=['POST'])
def find_group_level():
    """
    POST { name }
    Finds which hierarchy level (organ/category/division/structure/substructure)
    contains the given name, so the frontend can route to the correct group endpoint.
    Returns { group_level, group_name, member_count }.
    """
    data = request.get_json(force=True)
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


@app.route('/api/region_center_group', methods=['POST'])
def region_center_group():
    """
    POST { group_level, group_name }
    Finds the best slice indices to view a whole anatomical group (all member
    parcellation indices combined).  Returns xi, yi, zi, voxel_count, and the
    group colour.
    """
    data = request.get_json(force=True)
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
    in_group   = np.isin(annotation_array, member_arr)
    voxels     = np.argwhere(in_group)

    if len(voxels) == 0:
        return jsonify({'error': 'No voxels found for this group'}), 404

    # Pick the slice with the most group voxels for each view axis
    xi_counts = np.bincount(voxels[:, 0], minlength=annotation_array.shape[0])
    yi_counts = np.bincount(voxels[:, 1], minlength=annotation_array.shape[1])
    zi_counts = np.bincount(voxels[:, 2], minlength=annotation_array.shape[2])

    xi = int(np.argmax(xi_counts))
    yi = int(np.argmax(yi_counts))
    zi = int(np.argmax(zi_counts))

    xi = max(0, min(xi, VIEW_CFG['sagittal']['max']))
    yi = max(0, min(yi, VIEW_CFG['transverse']['max']))
    zi = max(0, min(zi, VIEW_CFG['coronal']['max']))

    # Representative colour
    sample_idx = next(iter(member_indices))
    hex_color  = get_hex_for_index(sample_idx, group_lv)

    return jsonify({
        'xi': xi, 'yi': yi, 'zi': zi,
        'voxel_count':   int(len(voxels)),
        'member_count':  len(member_indices),
        'group_level':   group_lv,
        'group_name':    group_name,
        f'{group_lv}_color': hex_color,
        'structure_color':   hex_color,
    })


@app.route('/api/region_center', methods=['POST'])
def region_center():
    """
    POST { parcellation_index }
    Finds the centroid voxel (xi, yi, zi) of the given region in the annotation volume.
    Returns the best slice index for each view so the frontend can navigate to it.
    Also returns per-level colors for the region.
    """
    data = request.get_json(force=True)
    try:
        target = int(data['parcellation_index'])
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'parcellation_index required'}), 400

    # Find all voxels belonging to this region
    voxels = np.argwhere(annotation_array == target)   # shape (N, 3) → each row is (xi, yi, zi)

    if len(voxels) == 0:
        return jsonify({'error': f'No voxels found for parcellation_index={target}'}), 404

    # For each view, find the slice index that contains the MOST voxels of this region.
    # This guarantees the highlight will actually be visible (centroid can land on a
    # thin slice with very few or zero voxels for elongated structures).
    xi_counts = np.bincount(voxels[:, 0], minlength=annotation_array.shape[0])
    yi_counts = np.bincount(voxels[:, 1], minlength=annotation_array.shape[1])
    zi_counts = np.bincount(voxels[:, 2], minlength=annotation_array.shape[2])

    xi = int(np.argmax(xi_counts))
    yi = int(np.argmax(yi_counts))
    zi = int(np.argmax(zi_counts))

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
        'voxel_count': len(voxels),
        **colors, **names,
    })

@app.route('/api/search')
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

    limit   = min(int(request.args.get('limit', 50)), 200)
    q_lower = q.lower()

    import re as _re
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
            group_candidates[key]['member_count'] += 1

    # Use term tree for accurate leaf counts where available
    for key, g in group_candidates.items():
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

        if len(leaf_results) >= limit * 3:
            break

    def leaf_sort_key(r):
        name    = r['matched_label'].lower()
        acro    = r['matched_acronym'].lower()
        no_vox  = 1 if r.get('no_voxels') else 0   # 0 = has voxels (sorts first)
        if acro == q_lower or name == q_lower:          return (no_vox, 0, name)
        if acro.startswith(q_lower) or name.startswith(q_lower): return (no_vox, 1, name)
        if q_lower in acro:                              return (no_vox, 2, name)
        return                                                  (no_vox, 3, name)

    leaf_results.sort(key=leaf_sort_key)

    # Groups first, then leaves (has-voxels before no-voxels); trim to limit
    combined = (group_results + leaf_results)[:limit]
    return jsonify({'results': combined, 'query': q, 'total': len(combined)})




@app.route('/api/resolve_region', methods=['GET'])
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
                most_spec = col; most_name = v; break
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
                    if r: return jsonify(r)

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
                if r: return jsonify(r)
                break

    # ── P4: Term-tree exact name or acronym (finds container groups) ──────────
    term_label = _name_to_term_id.get(lo) or _acro_to_term_id.get(lo)
    if term_label:
        node = _term_nodes.get(term_label)
        if node and node['children']:
            r = term_node_result(term_label, node)
            if r: return jsonify(r)

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
                    if r: return jsonify(r)
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
                    if r: return jsonify(r)
                    break

    return jsonify({})

@app.route('/api/ontology')
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
        for child in node.get('children', []):
            enrich(child)
        return node

    if isinstance(raw, dict) and 'msg' in raw:
        for root_node in raw['msg']:
            enrich(root_node)

    get_ontology._cache = raw
    return jsonify(raw)


# ── Brain Atlas RAG Chatbot ───────────────────────────────────────────────────
import json as _json, shutil as _shutil, threading as _threading
import urllib.request as _urllib_req
import urllib.error   as _urllib_err

_chat_ready   = False
_vectorstore  = None
_chat_llm     = None
_kb_documents = []   # raw docs for exact-match fallback

# ── CortexMap API integration ─────────────────────────────────────────────────
# Live deployed orchestrator.  Override via CORTEXMAP_URL env var if needed.
import os as _os_rag
_CORTEXMAP_BASE = _os_rag.environ.get(
    'CORTEXMAP_URL', 'https://capstone.ssdd.dev'
).rstrip('/')

def _cortexmap_fetch(path, method='GET', body=None, timeout=8):
    """
    HTTP wrapper for the CortexMap orch REST API.
    Returns (data, error_msg).
    Sends browser-like headers to pass CORS checks on the server.
    """
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


def _cortexmap_find_region_id(region_name, region_acronym=''):
    """
    Find a CortexMap region UUID using POST /orch/api/search (ReverseSearch).

    The ReverseSearch endpoint searches across region names, acronyms, AND
    summary text with relevance ranking — it handles name mismatches between
    the Allen Atlas and CortexMap's naming (e.g. "CA1" → "Field CA1",
    "Primary motor area, layer 5" vs "Primary motor area, Layer 5").

    We try two queries and take the highest-ranked result:
      1. Full structure name  (e.g. "Lateral visual area, layer 6a")
      2. Acronym if available (e.g. "VISl6a") — acronym is more precise

    Returns (region_id, error_msg).
    """
    best_id   = None
    best_rank = -1.0

    queries = [q for q in [region_name.strip(), region_acronym.strip()] if q]

    for query in queries:
        data, err = _cortexmap_fetch('/orch/api/search', method='POST', body={'query': query})
        if err:
            return None, err
        if not data:
            continue
        results = data.get('results', [])
        for r in results:
            rank = float(r.get('rank', 0))
            rid  = r.get('region_id') or r.get('regionId')
            name = r.get('name', '')
            if rid and rank > best_rank:
                best_rank = rank
                best_id   = rid
                print(f"[CortexMap] \u2139 ReverseSearch '{query}' → '{name}' rank={rank:.2f} id={rid}")
            # Exact name or acronym match overrides rank — stop immediately
            if (name.lower() == region_name.lower() or
                    (region_acronym and r.get('acronym', '').lower() == region_acronym.lower())):
                print(f"[CortexMap] \u2139 Exact match: '{query}' → '{name}' id={rid}")
                return rid, ''

    return best_id, ''

def _cortexmap_get_summaries(region_id):
    """
    GET /orch/api/regions/{id}/summaries
    Returns (summary_text, pmc_ids, error_msg).
    - summary_text: clean text with [chunk:uuid] markers stripped, for Ollama context
    - pmc_ids: deduplicated list of PMC IDs, returned separately for frontend link rendering
    """
    import re as _re
    data, err = _cortexmap_fetch(f'/orch/api/regions/{region_id}/summaries')
    if not data:
        return '', [], err
    summaries = data.get('summaries', [])
    text_parts = []
    all_pmc_ids = []
    seen_pmc = set()
    for s in summaries:
        text = s.get('summary', '')
        if text:
            # Strip internal [chunk:uuid] markers — CortexMap internal refs, not useful to Ollama
            text = _re.sub(r'\[chunk:[a-f0-9\-]+\]', '', text).strip()
            text_parts.append(text)
        # Collect deduplicated PMC IDs
        for src in s.get('sources', []):
            pid = src.get('pmc_id')
            if pid and pid not in seen_pmc:
                seen_pmc.add(pid)
                all_pmc_ids.append(pid)
    return '\n\n'.join(text_parts), all_pmc_ids, ''

def _rag_init():
    global _chat_ready, _vectorstore, _chat_llm, _kb_documents
    try:
        from langchain_community.llms import Ollama as _Ollama
        from langchain_chroma import Chroma
        from langchain_huggingface import HuggingFaceEmbeddings
        from langchain_text_splitters import RecursiveCharacterTextSplitter

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

        # ── Load knowledge base JSON ──
        kb = _json.loads(kb_file.read_text('utf-8'))
        regions = kb.get('regions', [])
        print(f"Brain Atlas RAG: loaded {len(regions)} regions from brain_regions_kb.json")

        class _Doc:
            def __init__(self, content, metadata=None):
                self.page_content = content
                self.metadata = metadata or {}

        docs = []
        for r in regions:
            # Build a rich text document for each region
            lines = []
            for field in ['structure','substructure','division','category','organ','acronym']:
                if r.get(field): lines.append(f"{field.title()}: {r[field]}")
            if r.get('parcellation_index'):
                lines.append(f"Parcellation Index: {r['parcellation_index']}")
            for field in ['function','connectivity','clinical_relevance','notes']:
                if r.get(field): lines.append(f"\n{field.replace('_',' ').title()}:\n{r[field]}")
            doc = _Doc('\n'.join(lines), {
                'structure':           r.get('structure','').lower(),
                'parcellation_index':  str(r.get('parcellation_index','')),
                'acronym':             r.get('acronym','').lower(),
            })
            docs.append(doc)

        _kb_documents = docs

        # ── Rebuild ChromaDB fresh every restart ──
        chroma_path = base / 'chroma_db'
        if chroma_path.exists():
            _shutil.rmtree(chroma_path)
            print("Brain Atlas RAG: old ChromaDB deleted — rebuilding…")

        splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=100)
        chunks   = splitter.split_documents(docs)
        print(f"Brain Atlas RAG: embedding {len(chunks)} chunks…")

        embeddings  = HuggingFaceEmbeddings(model_name='all-MiniLM-L6-v2')
        _vectorstore = Chroma.from_documents(
            documents=chunks,
            embedding=embeddings,
            persist_directory=str(chroma_path)
        )
        print("Brain Atlas RAG: vector store ready ✓")

        # ── Connect to Ollama ──
        _chat_llm   = _Ollama(model='gemma3:4b', temperature=0.3)
        print("Brain Atlas RAG: connecting to Ollama…")
        _chat_llm.invoke("Hello")
        _chat_ready = True
        print("Brain Atlas RAG: fully ready ✓  Open http://localhost:5000")

    except Exception as e:
        print(f"Brain Atlas RAG: FAILED — {e}")

_threading.Thread(target=_rag_init, daemon=True).start()

def _rag_answer(question, region_name='', parcellation_index='', region_acronym=''):
    """
    CortexMap-first RAG.
    Returns (answer_text, cortexmap_status, pmc_ids).
    pmc_ids is a list of PMC IDs to display as clickable links in the frontend.
    """
    cortexmap_summary = ''
    cortexmap_status  = 'local_only'
    pmc_ids           = []

    if region_name:
        try:
            # Step 1: Find region UUID
            region_id, fetch_err = _cortexmap_find_region_id(region_name, region_acronym)

            if fetch_err:
                print(f"[CortexMap] \u2717 Could not reach CortexMap — {fetch_err}")
                print(f"[CortexMap]   Falling back to local knowledge base for '{region_name}'.")
                log.warning(f"CortexMap unreachable for '{region_name}': {fetch_err}")
                cortexmap_status = 'unreachable'

            elif not region_id:
                print(f"[CortexMap] \u2139 '{region_name}' not found in /orch/api/regions.")
                print(f"[CortexMap]   Falling back to local knowledge base.")
                log.info(f"CortexMap: '{region_name}' not found in regions list")
                cortexmap_status = 'region_not_found'

            else:
                # Step 2: Fetch summaries
                print(f"[CortexMap] \u2139 Found UUID {region_id} for '{region_name}' — fetching summaries...")
                cortexmap_summary, pmc_ids, sum_err = _cortexmap_get_summaries(region_id)

                if sum_err:
                    print(f"[CortexMap] \u2717 Could not fetch summaries for '{region_name}' — {sum_err}")
                    print(f"[CortexMap]   Falling back to local knowledge base.")
                    log.warning(f"CortexMap summaries fetch failed for '{region_name}': {sum_err}")
                    cortexmap_status = 'summaries_error'

                elif cortexmap_summary:
                    print(f"[CortexMap] \u2713 Summaries loaded for '{region_name}' (id={region_id}) — enriching RAG context.")
                    log.info(f"CortexMap: summaries loaded for '{region_name}' (id={region_id})")
                    cortexmap_status = 'enriched'

                else:
                    print(f"[CortexMap] \u2139 No summaries yet for '{region_name}' — pipeline may still be generating.")
                    print(f"[CortexMap]   Falling back to local knowledge base.")
                    log.info(f"CortexMap: '{region_name}' has no summaries yet")
                    cortexmap_status = 'generating'

        except Exception as _e:
            print(f"[CortexMap] \u2717 Unexpected error for '{region_name}': {_e}")
            print(f"[CortexMap]   Falling back to local knowledge base.")
            log.warning(f"CortexMap exception for '{region_name}': {_e}")
            cortexmap_status = 'error'

    # Step 3: Local KB fallback
    selected_doc = None
    if region_name:
        rn = region_name.lower().strip()
        for doc in _kb_documents:
            kb_name = doc.metadata.get('structure', '').lower()
            kb_acro = doc.metadata.get('acronym', '').lower()
            kb_pidx = doc.metadata.get('parcellation_index', '')
            if kb_name == rn or kb_acro == rn or (parcellation_index and kb_pidx == str(parcellation_index)):
                selected_doc = doc.page_content
                break

    # Build context:
    # — CortexMap summary available → use ONLY CortexMap (ignore local KB)
    # — CortexMap unavailable/empty → use ONLY local KB
    if cortexmap_summary:
        context = f"=== Research Summaries (CortexMap) ===\n{cortexmap_summary}"
        prompt = (
            "You are an expert neuroscientist assistant for the Allen MOUSE Brain "
            "Common Coordinate Framework v3 (CCFv3). Every question is about the "
            "mouse brain (Mus musculus), never human or any other species. "
            "Even if the user does not specify, assume mouse.\n\n"
            "Answer ONLY using the research summary below.\n"
            "Do NOT use your own knowledge. Do NOT guess or infer anything not in the summary.\n\n"
            f"Research summary:\n{context}\n\n"
            f"Question: {question}\n"
            "Answer:"
        )
    elif selected_doc:
        context = f"=== Local Knowledge Base ===\n{selected_doc}"
        prompt = (
            "You are an expert neuroscientist assistant for the Allen MOUSE Brain "
            "Common Coordinate Framework v3 (CCFv3). Every question is about the "
            "mouse brain (Mus musculus), never human or any other species. "
            "Even if the user does not specify, assume mouse.\n\n"
            "Answer ONLY using the context below.\n"
            "Do NOT use your own knowledge. Do NOT guess or infer anything not in the context.\n\n"
            f"Region context:\n{context}\n\n"
            f"Question: {question}\n"
            "Answer:"
        )
    else:
        if region_name:
            return (
                f"I don't have any information about '{region_name}' yet. "
                f"CortexMap has been notified to generate a summary — try again shortly. "
                f"To add it locally now, open brain_regions_kb.json, add an entry with "
                f"\"structure\": \"{region_name}\", fill in the fields, then restart the app."
            ), cortexmap_status, []
        return "No region is currently selected. Click a region in the atlas first, then ask your question.", cortexmap_status, []
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

    # ── Route to ChatGPT (OpenAI) ──────────────────────────────────────────────
    if ai_provider == 'openai':
        try:
            answer = _gpt_answer(question, region_name, parcellation_index)
            return jsonify({'answer': answer, 'provider': 'openai'})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    # ── Route to local Ollama RAG ──────────────────────────────────────────────
    if not _chat_ready:
        return jsonify({'answer': 'Still building the knowledge base — please wait a moment and try again.'})
    try:
        answer, cortexmap_status, pmc_ids = _rag_answer(question, region_name, parcellation_index, region_acronym)

        # Build a human-readable notice about which data source was used
        _notices = {
            'enriched':         None,   # all good — no notice needed
            'local_only':       None,   # normal local-only path — no notice needed
            'unreachable':      '⚠ CortexMap could not be reached (network error or route not deployed yet). Ollama is answering from the local knowledge base only.',
            'region_not_found': 'ℹ This region was not found in CortexMap. Ollama is answering from the local knowledge base.',
            'generating':       '⏳ CortexMap is fetching papers and generating summaries for this region (auto-queued). Try again in a moment — Ollama is using the local knowledge base for now.',
            'summaries_error':  '⚠ CortexMap summaries could not be fetched. Ollama is answering from the local knowledge base only.',
            'no_summaries':     'ℹ CortexMap has no summaries for this region yet. Ollama is answering from the local knowledge base.',
            'error':            '⚠ CortexMap returned an unexpected error. Ollama is answering from the local knowledge base only.',
        }
        notice = _notices.get(cortexmap_status)

        return jsonify({
            'answer':            answer,
            'provider':          'ollama',
            'cortexmap_status':  cortexmap_status,
            'cortexmap_notice':  notice,        # None when CortexMap worked fine
            'pmc_sources':       pmc_ids,       # list of PMC IDs for frontend link rendering
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── ChatGPT (OpenAI) handler ───────────────────────────────────────────────────
import os as _os

def _gpt_answer(question, region_name='', parcellation_index=''):
    """
    Sends the question to OpenAI GPT with region context built from the atlas
    name/color data frames. Uses GPT's own knowledge — no RAG KB required.
    """
    try:
        from openai import OpenAI
    except ImportError:
        return "OpenAI package not installed. Run: pip install openai"

    api_key = _os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        # Try loading from .env file next to App.py
        env_path = Path(__file__).parent / '.env'
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith('OPENAI_API_KEY='):
                    api_key = line.split('=', 1)[1].strip()
                    break
    if not api_key:
        return "OpenAI API key not found. Set OPENAI_API_KEY in your .env file."

    client = OpenAI(api_key=api_key)

    # Build a rich region context from the atlas data frames (no KB required)
    region_context = ''
    if region_name or parcellation_index:
        try:
            pidx = int(parcellation_index) if parcellation_index else None

            # Try to find the region by parcellation index first, then by name
            row = None
            if pidx is not None and pidx in name_df.index:
                row = name_df.loc[pidx]
                pidx_used = pidx
            elif region_name:
                rn = region_name.lower()
                for col in ['structure', 'substructure', 'division', 'category']:
                    if col in name_df.columns:
                        hits = name_df[name_df[col].fillna('').str.lower() == rn]
                        if not hits.empty:
                            pidx_used = hits.index[0]
                            row = hits.iloc[0]
                            break

            if row is not None:
                parts = []
                for f in ['organ', 'category', 'division', 'structure', 'substructure']:
                    val = row.get(f, '—')
                    if val and val != '—':
                        parts.append(f"{f.title()}: {val}")
                if pidx_used:
                    parts.append(f"Parcellation Index: {pidx_used}")
                    # Attach colors
                    try:
                        for level, colname in LEVEL_COLS.items():
                            hex_col = color_df.loc[pidx_used, colname]
                            parts.append(f"{level.title()} Color: {hex_col}")
                    except Exception:
                        pass
                region_context = '\n'.join(parts)
            elif region_name:
                # Region not found in the ABC atlas annotation volume —
                # still tell GPT the name so it can answer from its own knowledge
                region_context = (
                    f"Region name: {region_name}\n"
                    f"Note: This region is named in the Allen ontology but is not present "
                    f"as annotated voxels in the CCFv3 annotation volume."
                )
        except Exception:
            region_context = f"Region: {region_name}"

    system_prompt = (
        "You are an expert neuroscientist and brain atlas assistant specializing in the "
        "Allen MOUSE Brain Common Coordinate Framework v3 (CCFv3). "
        "EVERY question is about the mouse brain (Mus musculus), never human or any "
        "other species. Even if the user does not specify a species (e.g. 'list all "
        "areas connected to Alzheimer'), assume mouse brain and answer about mouse "
        "neuroanatomy. When naming regions, use the Allen CCFv3 ontology names. "
        "You have deep knowledge of mouse neuroanatomy, brain region functions, "
        "connectivity, cytoarchitecture, and the Allen Brain Atlas data. "
        "Be concise, accurate, and helpful. When discussing a specific brain region, "
        "explain its function, connectivity, and significance. "
        "If you refer to atlas coordinates, use the CCFv3 voxel space (10 µm resolution)."
    )

    user_content = question
    if region_context:
        if 'not present as annotated voxels' in region_context:
            user_content = (
                f"The user has selected the following brain region by name. "
                f"It is listed in the Allen ontology but has no annotated voxels in the CCFv3 volume:\n"
                f"{region_context}\n\n"
                f"Please answer the question using your neuroscience knowledge about this region.\n"
                f"Question: {question}"
            )
        else:
            user_content = (
                f"The user is currently viewing the following brain region in the Allen CCFv3 atlas:\n"
                f"{region_context}\n\n"
                f"Question: {question}"
            )

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
