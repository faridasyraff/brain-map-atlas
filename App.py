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

import io, base64
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import SimpleITK as sitk
from pathlib import Path
from PIL import Image
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from abc_atlas_access.abc_atlas_cache.abc_project_cache import AbcProjectCache

# ── Load atlas data once ──────────────────────────────────────────────────────
print("Loading ABC Atlas data … this may take a moment.")

DOWNLOAD_BASE = Path('../../data/abc_atlas')   # ← adjust to your data path
abc_cache = AbcProjectCache.from_cache_dir(DOWNLOAD_BASE)

def load_arr(name):
    f = abc_cache.get_file_path(directory='Allen-CCF-2020', file_name=name)
    return sitk.GetArrayFromImage(sitk.ReadImage(f))

annotation_array = load_arr('annotation_10')   # (1320, 800, 1140)
template_array   = load_arr('average_template_10')
boundary_array   = load_arr('annotation_boundary_10')

# ── Lookup table: parcellation_index → names ──────────────────────────────────
name_df = abc_cache.get_metadata_dataframe(
    directory='Allen-CCF-2020',
    file_name='parcellation_to_parcellation_term_membership_name')
name_df.set_index('parcellation_index', inplace=True)

# ── Color pivot tables: parcellation_index → per-level hex & RGB ──────────────
# color_df columns: organ_color, category_color, division_color,
#                   structure_color, substructure_color  (hex strings)
color_df = abc_cache.get_metadata_dataframe(
    directory='Allen-CCF-2020',
    file_name='parcellation_to_parcellation_term_membership_color')
color_df.set_index('parcellation_index', inplace=True)

# Pre-build RGB channel arrays for fast vectorized colorization
# channels[c][level_col] gives an array of uint8 values indexed by parcellation_index
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

# Build channels dict: channels['red']['organ_color'] = Series indexed by parcellation_index
channels = {}
for ch in ['red', 'green', 'blue']:
    channels[ch] = {}

for level, col in LEVEL_COLS.items():
    r, g, b = hex_to_rgb_cols(color_df[col])
    channels['red'][col]   = r
    channels['green'][col] = g
    channels['blue'][col]  = b

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

# ── Colorize a 2-D annotation slice using the official atlas colors ────────────
def colorize(annot_slice, level):
    """
    Implements the colorize() function from Note1.pdf.
    annot_slice: 2D array of parcellation_index values
    level: one of organ / category / division / structure / substructure
    Returns: (rows, cols, 3) uint8 RGB array
    """
    col = LEVEL_COLS[level]
    sshape = annot_slice.shape
    colorized = np.zeros((sshape[0], sshape[1], 3), dtype=np.uint8)
    flat = annot_slice.flat[:]
    for i, c in enumerate(['red', 'green', 'blue']):
        temp = np.zeros(sshape[0] * sshape[1], dtype=np.uint8)
        # vectorized lookup: channels[c][col] is a Series indexed by parcellation_index
        ch_series = channels[c][col]
        # reindex to flat voxel values; fill missing with 0
        temp[:] = ch_series.reindex(flat, fill_value=0).values
        colorized[:, :, i] = temp.reshape(sshape)
    return colorized

# ── Render a slice to base64 PNG ──────────────────────────────────────────────
def render_to_b64(tmpl, bnd, annot, colorize_level=None, fw=10, fh=8):
    # Returns (b64_string, pixel_width, pixel_height)
    fig, ax = plt.subplots(figsize=(fw, fh), dpi=100)

    if colorize_level and colorize_level != 'off':
        colored = colorize(annot, colorize_level)
        ax.imshow(colored, origin='upper')
        ax.imshow(bnd, cmap='Greys',
                  alpha=np.clip(bnd.astype(float) / 225, 0, 1),
                  origin='upper')
    else:
        ax.imshow(tmpl, cmap='Greys_r', origin='upper')
        ax.imshow(bnd, cmap='Greys',
                  alpha=np.clip(bnd.astype(float) / 225, 0, 1),
                  origin='upper')

    ax.axis('off')
    plt.tight_layout(pad=0)
    buf = io.BytesIO()
    fig.savefig(buf, format='png', bbox_inches='tight', pad_inches=0)
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

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

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

    tmpl, bnd, annot = get_slices(view, idx)
    fw, fh = VIEW_CFG[view]['figsize']
    img_b64, render_w, render_h = render_to_b64(tmpl, bnd, annot, colorize_level, fw, fh)
    _render_size_cache[(view, idx)] = (render_w, render_h)  # cache for highlight endpoint

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
        return jsonify({**base, **colors,
            'organ':        str(r.get('organ',        '—')),
            'category':     str(r.get('category',     '—')),
            'division':     str(r.get('division',     '—')),
            'structure':    str(r.get('structure',    '—')),
            'substructure': str(r.get('substructure', '—')),
        })
    except KeyError:
        return jsonify({**base, **colors,
                        'error': f'No region for index {parcellation_index}'})


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

    hex_color = get_hex_for_index(target, level).lstrip('#')
    try:
        r = int(hex_color[0:2], 16)
        g = int(hex_color[2:4], 16)
        b = int(hex_color[4:6], 16)
    except Exception:
        r, g, b = 0, 212, 255

    # Build a raw RGBA mask at annotation resolution — fully transparent except
    # where the target region is. The frontend canvas stretches this over the image.
    mask = np.zeros((rows, cols, 4), dtype=np.uint8)
    mask[annot == target] = [r, g, b, 180]

    img = Image.fromarray(mask, 'RGBA')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return jsonify({'mask': f'data:image/png;base64,{base64.b64encode(buf.read()).decode()}',
                    'color': f'#{hex_color}'})




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

    return jsonify({
        'parcellation_index': target,
        'xi': xi, 'yi': yi, 'zi': zi,
        'voxel_count': len(voxels),
        **colors, **names,
    })

@app.route('/api/search')
def search():
    """
    GET /api/search?q=hippocampus&limit=50
    Case-insensitive substring search across all name hierarchy columns.
    Returns list of matching regions with parcellation_index and colors.
    """
    q = request.args.get('q', '').strip()
    if len(q) < 2:
        return jsonify({'results': [], 'query': q})

    limit = min(int(request.args.get('limit', 50)), 200)
    q_lower = q.lower()

    cols_to_search = ['organ', 'category', 'division', 'structure', 'substructure']
    mask = None
    for col in cols_to_search:
        if col in name_df.columns:
            col_mask = name_df[col].fillna('').str.lower().str.contains(q_lower, regex=False)
            mask = col_mask if mask is None else (mask | col_mask)

    if mask is None or mask.sum() == 0:
        return jsonify({'results': [], 'query': q})

    matched = name_df[mask].copy()
    results = []
    seen = set()
    for parc_idx, row in matched.iterrows():
        if parc_idx in seen:
            continue
        seen.add(parc_idx)
        try:
            struct_color = color_df.loc[parc_idx, 'structure_color']
        except KeyError:
            struct_color = '#444444'
        results.append({
            'parcellation_index': int(parc_idx),
            'organ':        str(row.get('organ',        '—')),
            'category':     str(row.get('category',     '—')),
            'division':     str(row.get('division',     '—')),
            'structure':    str(row.get('structure',    '—')),
            'substructure': str(row.get('substructure', '—')),
            'structure_color': struct_color,
        })
        if len(results) >= limit:
            break

    results.sort(key=lambda r: (
        0 if r['structure'].lower() == q_lower else
        1 if r['structure'].lower().startswith(q_lower) else
        2 if q_lower in r['structure'].lower() else 3
    ))

    return jsonify({'results': results, 'query': q, 'total': len(results)})

# ── Brain Atlas RAG Chatbot ───────────────────────────────────────────────────
import json as _json, shutil as _shutil, threading as _threading

_chat_ready   = False
_vectorstore  = None
_chat_llm     = None
_kb_documents = []   # raw docs for exact-match fallback

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

def _rag_answer(question, region_name='', parcellation_index=''):
    # Look up the currently selected region in the knowledge base by name or parcellation index
    selected_doc = None
    if region_name:
        rn = region_name.lower().strip()
        for doc in _kb_documents:
            kb_name = doc.metadata.get('structure','').lower()
            kb_acro = doc.metadata.get('acronym','').lower()
            kb_pidx = doc.metadata.get('parcellation_index','')
            if kb_name == rn or kb_acro == rn or (parcellation_index and kb_pidx == str(parcellation_index)):
                selected_doc = doc.page_content
                break

    # If the selected region is NOT in the knowledge base, refuse immediately
    if region_name and not selected_doc:
        return (f"I don't have any information about '{region_name}' yet. "
                f"To add it, open brain_regions_kb.json, add an entry with "
                f"\"structure\": \"{region_name}\", fill in the fields, then restart the app.")

    # Build context from the selected region doc only
    context_parts = []
    if selected_doc:
        context_parts.append(selected_doc)

    if not context_parts:
        return "No region is currently selected. Click a region in the atlas first, then ask your question."

    context = '\n\n'.join(context_parts)

    prompt = (
        "You are a brain atlas assistant. Answer ONLY using the context below.\n"
        "Do NOT use your own knowledge. Do NOT guess or infer anything not in the context.\n\n"
        f"Region context:\n{context}\n\n"
        f"Question: {question}\n"
        "Answer:"
    )
    return _chat_llm.invoke(prompt)

@app.route('/api/chat', methods=['POST'])
def chat():
    data               = request.get_json(force=True)
    question           = (data.get('message') or '').strip()
    region_name        = (data.get('region_name') or '').strip()
    parcellation_index = str(data.get('parcellation_index') or '').strip()
    if not question:
        return jsonify({'error': 'message required'}), 400
    if not _chat_ready:
        return jsonify({'answer': 'Still building the knowledge base — please wait a moment and try again.'})
    try:
        answer = _rag_answer(question, region_name, parcellation_index)
        return jsonify({'answer': answer})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("\nOpen your browser at: http://localhost:5000\n")
    app.run(debug=False, port=5000)