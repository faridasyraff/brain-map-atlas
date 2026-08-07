"""
Allen CCFv3 Brain Atlas – Flask Backend  (full-color edition)
=============================================================

Volume: 1320 × 800 × 1140 voxels, ASL orientation
  axis-0 (x): anterior → posterior   size 1320
  axis-1 (y): superior → inferior     size  800
  axis-2 (z): left     → right        size 1140

View slice extraction (post-transpose ready for imshow):
  sagittal   fix x → arr[xi,:,:]        rows=y  cols=z  shape(800,1140)
  coronal    fix z → arr[:,:,zi].T      rows=y  cols=x  shape(800,1320)
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

import sys as _sys

# Windows consoles default stdout/stderr to the system codepage (cp1252),
# which chokes on characters like the em-dashes/arrows used in this file's
# print()s and docstring — that's a real crash risk any time this runs
# somewhere the console assumption doesn't hold (a process manager, a
# redirected log file, a container). Force UTF-8 unconditionally so it can't
# bite regardless of how App.py gets launched. Same fix as voxelize_meshes.py.
if hasattr(_sys.stdout, 'reconfigure'):
    _sys.stdout.reconfigure(encoding='utf-8')
    _sys.stderr.reconfigure(encoding='utf-8')

import io, base64, json as _json, logging, os as _os, re, traceback, uuid
from functools import lru_cache
from collections import Counter
from datetime import datetime
import numpy as np
from scipy.ndimage import binary_erosion
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import SimpleITK as sitk
from pathlib import Path
from PIL import Image
from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS
from flask_compress import Compress
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv
import json
from abc_atlas_access.abc_atlas_cache.abc_project_cache import AbcProjectCache

# ── Environment / secrets ──────────────────────────────────────────────────────
# Single source of truth for config: a .env file next to App.py (untracked —
# see .gitignore) is loaded into the process environment once at startup.
# Everything downstream just reads os.environ; no more re-parsing .env by hand.
load_dotenv(Path(__file__).parent / '.env')

def _get_openai_api_key():
    """Return OPENAI_API_KEY from the environment (populated from .env above)."""
    return _os.environ.get('OPENAI_API_KEY', '')

def _load_openai():
    """Try to load the OpenAI package. Three different places in this file
    talk to OpenAI, and someone running this app might not have that package
    installed (it's optional) — so instead of the whole app crashing on
    startup, each of those three places calls this first and just shows a
    "not installed" message if it comes back empty. Returns the OpenAI class
    to use, or None if the package isn't installed."""
    try:
        from openai import OpenAI
        return OpenAI
    except ImportError:
        log.warning('openai package not installed; run: pip install openai')
        return None

def _allowed_origins():
    """Comma-separated ALLOWED_ORIGINS env var, e.g. 'https://myapp.com,http://localhost:5000'.
    Defaults to localhost-only so a misconfigured deploy fails closed, not open."""
    raw = _os.environ.get('ALLOWED_ORIGINS', 'http://localhost:5000,http://127.0.0.1:5000')
    return [o.strip() for o in raw.split(',') if o.strip()]

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

_KEYWORD_STOPWORDS = {
    'about', 'above', 'after', 'also', 'among', 'and', 'are', 'areas',
    'brain', 'can', 'cell', 'cells', 'from', 'for', 'has', 'have', 'into',
    'its', 'may', 'more', 'most', 'other', 'outputs', 'region', 'regions',
    'role', 'roles', 'system', 'that', 'the', 'their', 'these', 'this',
    'through', 'via', 'with'
}

def _load_functional_kb():
    kb_path = Path(__file__).parent / 'brain_regions_kb.json'
    if not kb_path.exists():
        log.warning(f'functional keyword KB not found: {kb_path}')
        return {}

    try:
        kb = _json.loads(kb_path.read_text(encoding='utf-8'))
    except Exception as e:
        log.warning(f'functional keyword KB load failed: {e}')
        return {}

    lookup = {}
    for region in kb.get('regions', []):
        keys = [
            str(region.get('parcellation_index', '')).strip(),
            str(region.get('structure', '')).lower().strip(),
            str(region.get('substructure', '')).lower().strip(),
            str(region.get('acronym', '')).lower().strip(),
        ]
        for key in keys:
            if key:
                lookup[key] = region
    return lookup

_functional_kb = _load_functional_kb()

# ── AI-generated region enrichment cache ─────────────────────────────────────
# Persists OpenAI responses so a region is only generated once. First click on
# an uncached region takes ~1-3s (blocking on OpenAI), later clicks are instant.
# The slow work happens in /api/enrich (called asynchronously from the
# frontend), NOT in /api/lookup — so the click itself never stalls.
_OPENAI_REGION_CACHE_PATH = Path(__file__).parent / 'openai_region_cache.json'

def _load_openai_region_cache():
    empty = {'functional_keywords': {}, 'region_summaries': {}}
    if not _OPENAI_REGION_CACHE_PATH.exists():
        return empty
    try:
        data = _json.loads(_OPENAI_REGION_CACHE_PATH.read_text(encoding='utf-8'))
    except Exception as e:
        log.warning(f'AI region cache load failed: {e}')
        return empty
    kw = data.get('functional_keywords', {})
    su = data.get('region_summaries', {})
    if not isinstance(kw, dict): kw = {}
    if not isinstance(su, dict): su = {}
    log.info(f'AI region cache loaded: {len(kw)} keyword entries, {len(su)} summaries')
    return {'functional_keywords': kw, 'region_summaries': su}

def _save_openai_region_cache():
    data = {
        'functional_keywords': _functional_keyword_cache,
        'region_summaries':    _region_summary_cache,
    }
    try:
        tmp = _OPENAI_REGION_CACHE_PATH.with_suffix('.tmp')
        tmp.write_text(_json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
        tmp.replace(_OPENAI_REGION_CACHE_PATH)
    except Exception as e:
        log.warning(f'AI region cache save failed: {e}')

_openai_region_cache      = _load_openai_region_cache()
_functional_keyword_cache = _openai_region_cache['functional_keywords']
_region_summary_cache     = _openai_region_cache['region_summaries']

def _cache_key(region_name, region_acronym):
    """Stable key used for both caches. Prefers acronym (short, stable),
    falls back to lowercased name."""
    acro = (region_acronym or '').lower().strip()
    if acro and acro not in {'', '--', '—'}:
        return acro
    return (region_name or '').lower().strip()


def _get_functional_keywords(parcellation_index=None, region_name='', region_acronym='', limit=14):
    keys = [
        str(parcellation_index or '').strip(),
        str(region_name or '').lower().strip(),
        str(region_acronym or '').lower().strip(),
    ]

    region = None
    for key in keys:
        if key and key in _functional_kb:
            region = _functional_kb[key]
            break
    if not region:
        # Not in curated KB — check AI cache next (populated by /api/enrich).
        ck = _cache_key(region_name, region_acronym)
        if ck and ck in _functional_keyword_cache:
            return _functional_keyword_cache[ck][:limit]
        return []

    curated = region.get('functional_keywords')
    if isinstance(curated, list):
        keywords = []
        for item in curated:
            if isinstance(item, dict):
                term = str(item.get('term', '')).strip()
                try:
                    weight = float(item.get('weight', 1.0))
                except (TypeError, ValueError):
                    weight = 1.0
            else:
                term = str(item).strip()
                weight = 1.0
            if term:
                keywords.append({'term': term, 'weight': weight})
        return keywords[:limit]

    weighted_fields = [
        ('function', 3),
        ('connectivity', 2),
        ('clinical_relevance', 1),
        ('notes', 1),
    ]
    counts = Counter()
    for field, multiplier in weighted_fields:
        text = str(region.get(field, '') or '').lower()
        for word in re.findall(r'[a-z][a-z-]{3,}', text):
            if word not in _KEYWORD_STOPWORDS:
                counts[word] += multiplier

    if not counts:
        return []

    max_count = max(counts.values())
    return [
        {
            'term': term,
            'weight': round(0.55 + (count / max_count) * 0.45, 2),
        }
        for term, count in counts.most_common(limit)
    ]

def _get_region_summary(parcellation_index=None, region_name='', region_acronym=''):
    keys = [
        str(parcellation_index or '').strip(),
        str(region_name or '').lower().strip(),
        str(region_acronym or '').lower().strip(),
    ]

    region = None
    for key in keys:
        if key and key in _functional_kb:
            region = _functional_kb[key]
            break
    if not region:
        # Not in curated KB — check AI cache next (populated by /api/enrich).
        ck = _cache_key(region_name, region_acronym)
        if ck and ck in _region_summary_cache:
            return _region_summary_cache[ck]
        return ''

    function_text = str(region.get('function', '') or '').strip()
    connectivity_text = str(region.get('connectivity', '') or '').strip()
    notes_text = str(region.get('notes', '') or '').strip()

    candidate_texts = []
    if function_text:
        candidate_texts.append(function_text)
    if connectivity_text and re.search(r'\b(input|inputs|output|outputs|project|projects|projection|connect|connectivity)\b', connectivity_text, re.IGNORECASE):
        candidate_texts.append('Connectivity: ' + connectivity_text)
    if not function_text and notes_text:
        candidate_texts.append(notes_text)

    seen = set()
    clean_sentences = []
    for sentence in re.split(r'(?<=[.!?])\s+', ' '.join(candidate_texts)):
        sentence = re.sub(r'\s+', ' ', sentence).strip()
        if not sentence:
            continue
        key = re.sub(r'[^a-z0-9]+', ' ', sentence.lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        clean_sentences.append(sentence)
        if len(clean_sentences) >= 3:
            break

    return ' '.join(clean_sentences[:3]).strip()

def _get_related_regions(parcellation_index=None, region_name='', region_acronym='', limit=8):
    keys = [
        str(parcellation_index or '').strip(),
        str(region_name or '').lower().strip(),
        str(region_acronym or '').lower().strip(),
    ]

    region = None
    for key in keys:
        if key and key in _functional_kb:
            region = _functional_kb[key]
            break

    related = []
    seen = set()

    def _selected_names():
        vals = {str(region_name or '').lower().strip(), str(region_acronym or '').lower().strip()}
        if region:
            for f in ['structure', 'substructure', 'division', 'category', 'acronym']:
                vals.add(str(region.get(f, '') or '').lower().strip())
        return {v for v in vals if v and v not in {'--', 'â€”', '—'}}

    selected = _selected_names()

    def _add_related(name, relationship, query=None):
        clean = re.sub(r'\([^)]*\)', '', str(name or ''))
        clean = re.sub(r'\b(from|to|via|with|and|also)\b', '', clean, flags=re.IGNORECASE).strip(" .")
        clean = re.sub(r'\s+', ' ', clean)
        key = clean.lower()
        if len(clean) < 3 or key in seen or key in selected:
            return False
        seen.add(key)
        related.append({
            'name': clean,
            'label': clean,
            'relationship': relationship,
            'query': query or clean,
        })
        return len(related) >= limit

    # 1. Explicit connectivity from brain_regions_kb.json.
    connectivity = str(region.get('connectivity', '') or '') if region else ''
    if connectivity:
        parts = re.split(r'(?i)\b(inputs?|outputs?)\s*:', connectivity)
        chunks = []
        if len(parts) > 1:
            for i in range(1, len(parts), 2):
                rel = parts[i].lower().rstrip('s')
                text = parts[i + 1] if i + 1 < len(parts) else ''
                chunks.append((rel, text))
        else:
            chunks.append(('related', connectivity))

        for relationship, text in chunks:
            text = re.sub(r'\([^)]*\)', '', text)
            for raw in re.split(r',|;|\band\b|\u2192|->', text):
                if _add_related(raw, relationship):
                    print('related regions parsed', related)
                    return related

    row = None
    pidx = None
    try:
        pidx = int(parcellation_index) if parcellation_index not in (None, '') else None
    except (TypeError, ValueError):
        pidx = None

    if pidx is not None and pidx in name_df.index:
        row = name_df.loc[pidx]
    elif region_name:
        rn = str(region_name).lower().strip()
        for col in ['substructure', 'structure', 'division', 'category']:
            hits = name_df[name_df[col].fillna('').str.lower() == rn]
            if not hits.empty:
                row = hits.iloc[0]
                pidx = int(hits.index[0])
                break

    if row is None:
        print('related regions parsed', related)
        return related[:limit]

    # 2. Child/parent hierarchy matches from the selected row.
    hierarchy = ['category', 'division', 'structure', 'substructure']
    row_vals = {f: str(row.get(f, '') or '').strip() for f in hierarchy}
    for parent, child in [('structure', 'substructure'), ('division', 'structure'), ('category', 'division')]:
        parent_val = row_vals.get(parent)
        child_val = row_vals.get(child)
        if parent_val and child_val and parent_val not in {'--', 'â€”', '—'}:
            if parent_val.lower() != child_val.lower():
                if _add_related(parent_val, 'parent'):
                    print('related regions parsed', related)
                    return related

        if parent_val and parent_val not in {'--', 'â€”', '—'}:
            try:
                siblings = name_df[name_df[parent].fillna('').str.lower() == parent_val.lower()]
                for _, sib in siblings.head(80).iterrows():
                    sib_name = str(sib.get(child, '') or '').strip()
                    if sib_name and sib_name.lower() != row_vals.get(child, '').lower():
                        if _add_related(sib_name, 'sibling'):
                            print('related regions parsed', related)
                            return related
            except Exception:
                pass

    # 3. Nearby atlas groups by structure/division/category.
    for level in ['structure', 'division', 'category']:
        val = row_vals.get(level)
        if not val or val in {'--', 'â€”', '—'}:
            continue
        if _add_related(val, level):
            print('related regions parsed', related)
            return related

        try:
            matches = name_df[name_df[level].fillna('').str.lower() == val.lower()]
            for _, m in matches.head(100).iterrows():
                candidate = (
                    str(m.get('substructure', '') or '').strip()
                    or str(m.get('structure', '') or '').strip()
                    or str(m.get('division', '') or '').strip()
                )
                if _add_related(candidate, f'same {level}'):
                    print('related regions parsed', related)
                    return related
        except Exception:
            pass

    print('related regions parsed', related)
    return related[:limit]

# ── OpenAI-backed generators (for /api/enrich) ────────────────────────────────
# These only run when /api/enrich is called, which the website does in the
# background after a region's info panel is already showing — so the user
# sees the region's basic info right away, and the AI-written parts (summary,
# keywords) just fill themselves in a moment later once they're ready. Once
# generated, the results get saved so the same region never needs asking
# OpenAI again.

def _parse_keyword_json(content):
    """Parse OpenAI's response into [{term, weight}] entries. The model
    sometimes wraps output in ```json fences or prose; strip that."""
    content = (content or '').strip()
    content = re.sub(r'^```(?:json)?\s*', '', content)
    content = re.sub(r'\s*```$', '', content).strip()
    try:
        parsed = _json.loads(content)
    except Exception:
        # Try to find the first [...] in the text
        m = re.search(r'\[.*\]', content, re.DOTALL)
        if not m:
            return []
        try:
            parsed = _json.loads(m.group(0))
        except Exception:
            return []

    out = []
    if isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict):
                term = str(item.get('term', '')).strip()
                try:
                    weight = float(item.get('weight', 1.0))
                except (TypeError, ValueError):
                    weight = 1.0
                if term:
                    out.append({'term': term, 'weight': weight})
            elif isinstance(item, str) and item.strip():
                out.append({'term': item.strip(), 'weight': 1.0})
    return out


def _generate_region_summary(region_name, region_acronym):
    """Return a 2-3 sentence functional summary for the region. Blocks on
    OpenAI. Caches the result. Returns '' on any failure."""
    ck = _cache_key(region_name, region_acronym)
    if not ck:
        return ''
    if ck in _region_summary_cache:
        return _region_summary_cache[ck]

    api_key = _get_openai_api_key()
    if not api_key:
        return ''

    OpenAI = _load_openai()
    if not OpenAI:
        return ''

    try:
        client = OpenAI(api_key=api_key, timeout=8.0)
        response = client.chat.completions.create(
            model='gpt-4o-mini',
            messages=[
                {'role': 'system', 'content': 'You are a concise neuroscience assistant.'},
                {'role': 'user', 'content': (
                    'Write a concise 2-3 sentence functional summary for this mouse brain region.\n\n'
                    f'Name: {region_name}\n'
                    f'Acronym: {region_acronym}\n\n'
                    'Rules:\n'
                    '- Focus on function and connectivity\n'
                    '- Plain readable neuroscience language\n'
                    '- No bullet points\n'
                    '- Do not invent precise experimental claims'
                )},
            ],
            max_tokens=220,
            temperature=0.2,
        )
        summary = (response.choices[0].message.content or '').strip()
        if summary:
            _region_summary_cache[ck] = summary
            _save_openai_region_cache()
        return summary
    except Exception as e:
        log.warning(f'OpenAI summary generation failed for "{region_name}" ({region_acronym}): {e}')
        return ''


def _generate_functional_keywords(region_name, region_acronym):
    """Return [{term, weight}] keyword list. Blocks on OpenAI. Caches result.
    Returns [] on any failure."""
    ck = _cache_key(region_name, region_acronym)
    if not ck:
        return []
    if ck in _functional_keyword_cache:
        return _functional_keyword_cache[ck]

    api_key = _get_openai_api_key()
    if not api_key:
        return []

    OpenAI = _load_openai()
    if not OpenAI:
        return []

    try:
        client = OpenAI(api_key=api_key, timeout=10.0)
        response = client.chat.completions.create(
            model='gpt-4o-mini',
            messages=[
                {'role': 'system', 'content': 'You return compact JSON only.'},
                {'role': 'user', 'content': (
                    'List up to 12 functional keywords for this mouse brain region. '
                    'Terms should be short (1-2 words), lowercase, functionally distinctive. '
                    'Return ONLY a JSON array of {"term": string, "weight": number 0..1} '
                    'with no code fences and no prose.\n\n'
                    f'Name: {region_name}\n'
                    f'Acronym: {region_acronym}'
                )},
            ],
            max_tokens=350,
            temperature=0.2,
        )
        keywords = _parse_keyword_json(response.choices[0].message.content)
        if keywords:
            _functional_keyword_cache[ck] = keywords
            _save_openai_region_cache()
        return keywords
    except Exception as e:
        log.warning(f'OpenAI keyword generation failed for "{region_name}" ({region_acronym}): {e}')
        return []


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

annotation_array = load_arr('annotation_10')   # (1140, 800, 1320) = (x, y, z)
template_array   = load_arr('average_template_10')
boundary_array   = load_arr('annotation_boundary_10')

# Pre-compute which parcellation indices actually have voxels — used to flag
# "no highlight available" regions in search results.
_indices_with_voxels = set(np.unique(annotation_array).tolist())
print(f"Unique parcellation indices with voxels: {len(_indices_with_voxels)}")

# ── Per-axis "which slice has how many voxels of this region" lookup ─────────
# Finding where to center the view on a region (or a whole group of them, like
# clicking "Cerebrum" in the tree) used to mean scanning the entire ~1.2
# billion-voxel volume on every single click — a few seconds each time, and
# the biggest groups took close to 10.
#
# Instead, we count this ONCE at startup: for every slice along every axis,
# how many voxels of each parcellation_index are in it. That table
# (axis_length x number_of_regions, a few MB) lets any future request —
# one region or hundreds combined — get its answer by adding up a handful of
# already-computed numbers instead of rescanning the volume. Looking up a
# 339-region group this way takes about a hundredth of a second.
print("Pre-computing per-slice region histograms (one-time cost, speeds up all future region lookups)…")
_hist_t0 = _time.time()
_MAX_PIDX = int(annotation_array.max())
_x_hist = np.zeros((annotation_array.shape[0], _MAX_PIDX + 1), dtype=np.int32)
_y_hist = np.zeros((annotation_array.shape[1], _MAX_PIDX + 1), dtype=np.int32)
_z_hist = np.zeros((annotation_array.shape[2], _MAX_PIDX + 1), dtype=np.int32)
for _x in range(annotation_array.shape[0]):
    _x_hist[_x] = np.bincount(annotation_array[_x].ravel(), minlength=_MAX_PIDX + 1)
for _y in range(annotation_array.shape[1]):
    _y_hist[_y] = np.bincount(annotation_array[:, _y, :].ravel(), minlength=_MAX_PIDX + 1)
for _z in range(annotation_array.shape[2]):
    _z_hist[_z] = np.bincount(annotation_array[:, :, _z].ravel(), minlength=_MAX_PIDX + 1)
print(f"Region histograms ready in {_time.time() - _hist_t0:.1f}s")

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
# static_folder=None turns off Flask's built-in "serve any file in this
# folder" feature. Without this line, Flask would happily hand out ANY file
# sitting in this project over the web to anyone who asks for it — including
# this App.py source file itself, the logs, the OpenAI cache, and eventually
# our .env file with secrets in it. Every file we actually want people to be
# able to fetch (the website itself, the 3D meshes, etc.) already has its own
# specific route written below, so we don't need this catch-all shortcut.
app = Flask(__name__, static_folder=None)
# supports_credentials lets the browser send the login session cookie along
# with cross-origin requests (e.g. the Vite dev server on a different port
# than Flask) — without it, /api/auth/me etc. would never see who's logged in.
CORS(app, origins=_allowed_origins(), supports_credentials=True)

# Automatically shrinks responses before sending them, when the visitor's
# browser says it can handle a compressed reply (basically every browser
# does). Was measured completely off before this — a checked response
# showed the raw, uncompressed file being sent even though the browser
# asked for compression. The website's own build tools already show the
# expected saving: the main JS file is 581KB normally but only 151KB
# compressed — that's the difference this turns on.
Compress(app)

# ── Rate limiting ─────────────────────────────────────────────────────────────
# Limits how many requests one visitor can make per minute, so nobody can
# hammer the site with requests and slow it down or run up a big bill.
# /api/chat and /api/enrich get an even tighter limit than everything else,
# since each of those calls costs real money (they talk to OpenAI).
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=['60 per minute'],
    storage_uri='memory://',  # Keeps the request counts in this app's own
                               # memory. That's fine as long as you're only
                               # running one copy of the app. If you ever run
                               # several copies at once to handle more
                               # traffic, they'd each count separately and
                               # this limit would stop working properly — at
                               # that point you'd want a shared place to keep
                               # the count instead (a small database called
                               # Redis is the usual choice).
)

# ── User accounts (sign up / sign in) ─────────────────────────────────────────
# Accounts live in a small SQLite database (db.py) — one file on disk,
# nothing extra to run. Sessions are the plain cookie-based kind Flask
# already knows how to do (via Flask-Login), which is simpler to reason
# about than token-based auth for an app that isn't a distributed API.
app.secret_key = _os.environ.get('SECRET_KEY')
if not app.secret_key:
    raise RuntimeError(
        'SECRET_KEY is missing from backend/.env — login sessions can\'t be '
        'signed without one. Generate one with:\n'
        '  python -c "import secrets; print(secrets.token_hex(32))"\n'
        'and add it to .env as SECRET_KEY=<the value it printed>.'
    )
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_HTTPONLY'] = True

from db import init_db, create_user, get_user_by_email, get_user_by_id, user_count
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash

init_db()

# The account matching this email is always admin, however they sign up —
# set it in .env once and you never need a separate "make me admin" step.
# If it's left blank, the first account ever created becomes admin instead.
_ADMIN_EMAIL = _os.environ.get('ADMIN_EMAIL', '').strip().lower()

def _should_be_admin(email):
    if _ADMIN_EMAIL:
        return email == _ADMIN_EMAIL
    return user_count() == 0

login_manager = LoginManager()
login_manager.init_app(app)

class User(UserMixin):
    """Thin adapter so Flask-Login can track who's signed in. The actual
    account data lives in the users table (db.py) — this just wraps one row
    of it in the shape Flask-Login expects (an object with .id etc.)."""
    def __init__(self, row):
        self.id = str(row['id'])
        self.email = row['email']
        self.is_admin = bool(row['is_admin'])

@login_manager.user_loader
def load_user(user_id):
    row = get_user_by_id(int(user_id))
    return User(row) if row else None

@login_manager.unauthorized_handler
def unauthorized():
    # Default Flask-Login behavior is to redirect to a login page, which
    # doesn't exist here — this is a JSON API, so a plain 401 is correct.
    return jsonify({'error': 'Not signed in'}), 401

def _user_public(u):
    return {'email': u.email, 'is_admin': u.is_admin}

@app.route('/api/auth/signup', methods=['POST'])
@limiter.limit('5 per minute')
def auth_signup():
    data = request.get_json(force=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    if not email or '@' not in email:
        return jsonify({'error': 'A valid email is required'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400
    if get_user_by_email(email):
        return jsonify({'error': 'An account with that email already exists'}), 409

    is_admin = _should_be_admin(email)
    user_id = create_user(email, generate_password_hash(password), is_admin=is_admin)
    user = User(get_user_by_id(user_id))
    login_user(user)
    return jsonify(_user_public(user)), 201

@app.route('/api/auth/login', methods=['POST'])
@limiter.limit('10 per minute')
def auth_login():
    data = request.get_json(force=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    row = get_user_by_email(email)
    # A Google-only account has an empty password_hash (nothing to check
    # against) — `not row['password_hash']` catches that before it ever
    # reaches check_password_hash, which expects a real hash string.
    if not row or not row['password_hash'] or not check_password_hash(row['password_hash'], password):
        # Same message either way — confirming "that email doesn't exist"
        # vs "wrong password" tells an attacker which emails have accounts.
        return jsonify({'error': 'Incorrect email or password'}), 401

    user = User(row)
    login_user(user)
    return jsonify(_user_public(user))

@app.route('/api/auth/logout', methods=['POST'])
@login_required
def auth_logout():
    logout_user()
    return jsonify({'ok': True})

@app.route('/api/auth/me')
def auth_me():
    if not current_user.is_authenticated:
        return jsonify({'user': None})
    return jsonify({'user': _user_public(current_user)})

_DEBUG_ERRORS = _os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes')

@app.errorhandler(Exception)
def handle_exception(e):
    tb = traceback.format_exc()
    error_id = uuid.uuid4().hex[:8]
    log.error(f'[{error_id}] Unhandled exception on {request.method} {request.path} — {e}\n{tb}')
    # The full error details always get written to the log file on the
    # server. But we only send a short, generic message back to whoever made
    # the request, plus a short id code — showing them the real error text
    # could accidentally reveal things about how the app works internally
    # that we don't want strangers to see. If they tell us the id code, we
    # can look up exactly what went wrong in the log ourselves.
    if _DEBUG_ERRORS:
        return jsonify({'error': str(e), 'error_id': error_id}), 500
    return jsonify({'error': 'Internal server error', 'error_id': error_id}), 500

def _safe_error_response(e, status=500):
    """Does the same safe error handling as handle_exception above, but for
    use inside a route's own try/except block (instead of writing
    jsonify({'error': str(e)}) directly, which would leak the real error
    message to whoever made the request)."""
    error_id = uuid.uuid4().hex[:8]
    log.error(f'[{error_id}] {request.method} {request.path} — {e}\n{traceback.format_exc()}')
    if _DEBUG_ERRORS:
        return jsonify({'error': str(e), 'error_id': error_id}), status
    return jsonify({'error': 'Internal server error', 'error_id': error_id}), status

@app.errorhandler(404)
def handle_404(e):
    log.warning(f'404 {request.method} {request.path}')
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(405)
def handle_405(e):
    log.warning(f'405 Method Not Allowed {request.method} {request.path}')
    return jsonify({'error': 'Method not allowed'}), 405

# A hosting service checks this page again and again to make sure the app
# is still working, and can restart it automatically if it ever stops
# answering. This page doesn't actually do anything — it just says "yes,
# I'm here." All the slow work of loading the brain atlas data happens
# earlier, before the app can even respond to requests at all, so if this
# page is answering, that slow part has already finished.
@limiter.exempt
@app.route('/health')
def health():
    return jsonify({'status': 'ok'}), 200


# ── Website files ────────────────────────────────────────────────────────────
# This serves the finished, built version of the website, not the raw source
# code you'd edit. The actual source lives in frontend/ and gets turned into
# the finished version by running `npm run build` there, which creates a
# frontend/dist folder — that's what gets served here. If you're actively
# changing the website's code, use `npm run dev` in frontend/ instead, which
# shows your changes immediately without needing a rebuild each time.
_FRONTEND_DIST = Path(__file__).parent.parent / 'frontend' / 'dist'

def _serve_built_page(filename):
    if not (_FRONTEND_DIST / filename).exists():
        return jsonify({'error': "Frontend build not found. Run 'npm run build' in frontend/."}), 500
    return send_from_directory(_FRONTEND_DIST, filename)

@app.route('/')
def home_page():
    return _serve_built_page('home.html')

@app.route('/app')
def index():
    return _serve_built_page('index.html')

# This only hands out files from inside frontend/dist/assets — nothing else
# on the computer. See the static_folder=None note above for why we're
# careful never to just hand out "any file you ask for."
#
# These files get a new, unique name every time their content changes
# (Vite does this automatically when building the website), so it's
# completely safe to tell browsers "keep your own copy of this and never
# bother asking me again" — if the content ever changes, it'll show up under
# a brand new name instead, and old cached copies just quietly stop being
# used. That's what max_age (1 year) and "immutable" below are doing.
@app.route('/assets/<path:filename>')
def frontend_assets(filename):
    response = send_from_directory(_FRONTEND_DIST / 'assets', filename, max_age=31536000)
    response.headers['Cache-Control'] += ', immutable'
    return response


# ── 3D mesh endpoint ──────────────────────────────────────────────────────────
# Serves CCFv3 structure meshes from the local ./meshes/ folder, as .glb —
# a compact binary 3D file format. Allen only publishes these as the much
# larger, plain-text .obj format; _ensure_meshes() (below) downloads that and
# converts it to .glb right away, and convert_meshes_to_glb.py does the same
# one-off conversion for files that were already downloaded previously.
@app.route('/meshes/<int:struct_id>.glb')
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


@app.route('/api/log_warning', methods=['POST'])
def log_warning():
    data  = request.get_json(force=True)
    kind  = str(data.get('kind',  'click'))
    label = str(data.get('label', '?'))
    count = int(data.get('count', 0))
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
@app.route('/api/debug_mesh_alignment')
def debug_mesh_alignment():
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
@app.route('/api/resolve_structure_id')
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
            return jsonify({'error': 'mesh volume not loaded'}), 404
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


# ── Asynchronous region enrichment (called by frontend after panel is already
# rendered). Takes pidx OR name/acronym. Returns region_summary,
# functional_keywords, related_regions. Blocks on OpenAI if neither the
# curated KB nor the AI cache have entries yet; instant on subsequent calls
# thanks to the persistent cache.
@app.route('/api/enrich')
@limiter.limit('20 per minute')
def api_enrich():
    try:
        pidx_arg = request.args.get('pidx', '').strip()
        name_arg = request.args.get('name', '').strip()
        acro_arg = request.args.get('acronym', '').strip()
    except Exception:
        return jsonify({'error': 'bad args'}), 400

    pidx = None
    if pidx_arg:
        try:
            pidx = int(pidx_arg)
        except ValueError:
            pass

    # If only pidx was given, look up the name/acronym so OpenAI gets a useful
    # prompt (pidx alone is opaque).
    matched_name = name_arg
    matched_acro = acro_arg
    if (not matched_name or not matched_acro) and pidx is not None and pidx in name_df.index:
        try:
            r = name_df.loc[pidx]
            hier = ['organ','category','division','structure','substructure']
            for f in reversed(hier):
                v = str(r.get(f, '') or '').strip()
                if v and v != '—':
                    if not matched_name:
                        matched_name = v
                    if not matched_acro and acronym_df is not None and pidx in acronym_df.index:
                        a = acronym_df.loc[pidx]
                        matched_acro = str(a.get(f, '') or '').strip()
                    break
        except Exception as e:
            log.warning(f'/api/enrich name lookup failed for pidx={pidx}: {e}')

    if not matched_name and not matched_acro:
        return jsonify({'error': 'need pidx or name/acronym'}), 400

    # Step 1: try curated KB + existing cache (fast).
    summary  = _get_region_summary(parcellation_index=pidx,
                                   region_name=matched_name, region_acronym=matched_acro)
    keywords = _get_functional_keywords(parcellation_index=pidx,
                                        region_name=matched_name, region_acronym=matched_acro)

    # Step 2: anything still empty → generate via OpenAI (blocking, but this
    # endpoint is called async so only this HTTP response is held up).
    if not summary:
        summary = _generate_region_summary(matched_name, matched_acro)
    if not keywords:
        try:
            keywords = _generate_functional_keywords(matched_name, matched_acro)
        except Exception as e:
            log.warning(f'enrich keywords failed: {e}')
            keywords = []

    related = _get_related_regions(parcellation_index=pidx,
                                   region_name=matched_name, region_acronym=matched_acro)

    return jsonify({
        'parcellation_index': pidx,
        'matched_label':   matched_name,
        'matched_acronym': matched_acro,
        'region_summary':      summary,
        'functional_keywords': keywords,
        'related_regions':     related,
    })


# ── Resolve a parcellation_index directly (for 3D click via volume sampling)
# No view/idx/col/row indirection — caller already knows the pidx from sampling
# the volume on the client. Returns the same metadata as /api/lookup.
@app.route('/api/resolve_parcellation')
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
@app.route('/api/structures_in_slice')
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
            # Only count rows that actually have voxels -- otherwise this
            # raw count (used whenever the term tree below doesn't have a
            # match for this group name) can overstate how many regions a
            # group really has, inconsistently with the term-tree path a
            # few lines down, which already filters by _indices_with_voxels.
            if int(parc_idx) in _indices_with_voxels:
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
        if acro == q_lower or name == q_lower:          return (no_vox, 0, name)
        if acro.startswith(q_lower) or name.startswith(q_lower): return (no_vox, 1, name)
        if q_lower in acro:                              return (no_vox, 2, name)
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


# ── Brain Atlas RAG Chatbot ───────────────────────────────────────────────────
import shutil as _shutil, threading as _threading
import urllib.request as _urllib_req
import urllib.error   as _urllib_err

_chat_ready   = False
_vectorstore  = None
_chat_llm     = None
_kb_documents = []   # raw docs for exact-match fallback

# ── CortexMap API integration ─────────────────────────────────────────────────
# Live deployed orchestrator.  Override via CORTEXMAP_URL env var if needed.
_CORTEXMAP_BASE = _os.environ.get(
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
@limiter.limit('15 per minute')
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
            return _safe_error_response(e)

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
        return _safe_error_response(e)


# ── ChatGPT (OpenAI) handler ───────────────────────────────────────────────────
def _gpt_answer(question, region_name='', parcellation_index=''):
    """
    Sends the question to OpenAI GPT with region context built from the atlas
    name/color data frames. Uses GPT's own knowledge — no RAG KB required.
    """
    OpenAI = _load_openai()
    if not OpenAI:
        return "OpenAI package not installed. Run: pip install openai"

    api_key = _get_openai_api_key()
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

# ── eBrain volume rendering: serve the annotation array for GPU-side sampling
# The frontend fetches this once, uploads it as a Data3DTexture, and samples it
# in a custom fragment shader on each slice-plane quad. This gives pixel-perfect
# cross-sections matching the 2D PNGs, with zero mesh loading.
#
# Downsample stride of 3 (~30µm voxels) gives ~440x267x380 × 2 bytes ≈ 90MB raw.
# Gzipped over the wire it's usually 15-25MB.
_VOLUME_CACHE = {}  # stride -> bytes

@app.route('/api/annotation_volume_meta')
def annotation_volume_meta():
    stride = int(request.args.get('res', 3))
    shape  = annotation_array[::stride, ::stride, ::stride].shape
    return jsonify({
        'shape': list(shape),              # (X, Y, Z) after stride
        'stride': stride,
        'dtype': 'uint16',
        'original_shape': list(annotation_array.shape),
        'byte_length': int(np.prod(shape) * 2),
    })

@app.route('/api/annotation_volume')
def annotation_volume():
    stride = int(request.args.get('res', 3))
    if stride not in _VOLUME_CACHE:
        vol = annotation_array[::stride, ::stride, ::stride].astype(np.uint16)
        _VOLUME_CACHE[stride] = np.ascontiguousarray(vol).tobytes()
    data = _VOLUME_CACHE[stride]
    resp = Response(data, mimetype='application/octet-stream')
    resp.headers['Content-Length'] = str(len(data))
    resp.headers['X-Volume-Stride'] = str(stride)
    resp.headers['Cache-Control'] = 'public, max-age=86400'  # this data doesn't change while the app is running
    return resp

# Color lookup table: parcellation_id -> [R,G,B] as uint8 triples.
# Packed binary (3 bytes per id), zero-filled for missing ids.
@app.route('/api/annotation_lut')
def annotation_lut():
    # Use the structure-level color column from color_df (same indexing as
    # the annotation volume voxels). This matches how /api/slice colorizes.
    max_id = int(annotation_array.max()) + 1
    lut = np.zeros((max_id, 3), dtype=np.uint8)
    if color_df is not None and 'structure_color' in color_df.columns:
        for pidx, row in color_df.iterrows():
            try:
                pidx_i = int(pidx)
                if pidx_i < 0 or pidx_i >= max_id: continue
                hx = str(row.get('structure_color', '')).strip().lstrip('#')
                if len(hx) == 6:
                    lut[pidx_i, 0] = int(hx[0:2], 16)
                    lut[pidx_i, 1] = int(hx[2:4], 16)
                    lut[pidx_i, 2] = int(hx[4:6], 16)
            except Exception:
                pass
    data = np.ascontiguousarray(lut).tobytes()
    resp = Response(data, mimetype='application/octet-stream')
    resp.headers['Content-Length'] = str(len(data))
    resp.headers['X-LUT-Max-Id']   = str(max_id)
    resp.headers['Cache-Control'] = 'public, max-age=86400'
    return resp


# ── Mesh-slab approach: list every structure_id we have a mesh file for.
# Frontend uses this to preload all meshes on eBrain toggle so cross-section
# slabs are immediately ready regardless of which slice the user visits.
@app.route('/api/available_meshes')
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


# ── Mesh-derived volume (from voxelize_meshes.py) ─────────────────────────
# Loaded lazily on first request. meshes_volume.npy is uint16, voxels = structure_id
# (Allen structure_id, NOT parcellation_index).
_MESH_VOL = {'array': None, 'meta': None, 'bytes': None}
_MESH_LUT = {'bytes': None, 'max_id': 0}


def _load_mesh_volume():
    if _MESH_VOL['array'] is not None:
        return _MESH_VOL
    base = Path(__file__).parent
    npy  = base / 'meshes_volume.npy'
    jsn  = base / 'meshes_volume.json'
    if not npy.exists() or not jsn.exists():
        return None
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


@app.route('/api/mesh_volume_meta')
def mesh_volume_meta():
    mv = _load_mesh_volume()
    if mv is None:
        return jsonify({'error': 'meshes_volume.npy not found; run voxelize_meshes.py'}), 404
    meta = dict(mv['meta'])
    meta['byte_length'] = len(mv['bytes'])
    return jsonify(meta)


@app.route('/api/mesh_volume')
def mesh_volume():
    mv = _load_mesh_volume()
    if mv is None:
        return jsonify({'error': 'meshes_volume.npy not found'}), 404
    resp = Response(mv['bytes'], mimetype='application/octet-stream')
    resp.headers['Content-Length'] = str(len(mv['bytes']))
    resp.headers['Cache-Control'] = 'public, max-age=86400'
    return resp


@app.route('/api/mesh_lut')
def mesh_lut():
    """Color table keyed by COMPACT INDEX (not raw Allen structure_id).
    meta['idx_to_sid'][i] = the real structure_id at compact index i.
    Returns a packed RGB array, one entry per compact index (index 0 = empty).
    """
    mv = _load_mesh_volume()
    if mv is None:
        return jsonify({'error': 'mesh volume not loaded'}), 404
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


if __name__ == '__main__':
    print("\nOpen your browser at: http://localhost:5000\n")
    app.run(debug=False, port=5000)
