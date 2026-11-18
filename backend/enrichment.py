"""Region enrichment: the curated knowledge base, the persistent AI cache,
functional summaries/keywords, related regions, and the OpenAI generators
behind /api/enrich."""
import json as _json, json, re
from collections import Counter
from pathlib import Path
from common import (_get_openai_api_key, _load_openai, log)
from atlas import (name_df)

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
# Lives in data/ so Docker keeps it in the persistent atlas-data volume —
# otherwise every redeploy would throw away the cache and pay OpenAI again.
_OPENAI_REGION_CACHE_PATH   = Path(__file__).parent / 'data' / 'openai_region_cache.json'
_OPENAI_REGION_CACHE_LEGACY = Path(__file__).parent / 'openai_region_cache.json'  # old location

def _load_openai_region_cache():
    empty = {'functional_keywords': {}, 'region_summaries': {}}
    src = _OPENAI_REGION_CACHE_PATH
    if not src.exists() and _OPENAI_REGION_CACHE_LEGACY.exists():
        src = _OPENAI_REGION_CACHE_LEGACY   # read once from the old spot; saves go to data/
    if not src.exists():
        return empty
    try:
        data = _json.loads(src.read_text(encoding='utf-8'))
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
        _OPENAI_REGION_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
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
                    return related

        if parent_val and parent_val not in {'--', 'â€”', '—'}:
            try:
                siblings = name_df[name_df[parent].fillna('').str.lower() == parent_val.lower()]
                for _, sib in siblings.head(80).iterrows():
                    sib_name = str(sib.get(child, '') or '').strip()
                    if sib_name and sib_name.lower() != row_vals.get(child, '').lower():
                        if _add_related(sib_name, 'sibling'):
                            return related
            except Exception:
                pass

    # 3. Nearby atlas groups by structure/division/category.
    for level in ['structure', 'division', 'category']:
        val = row_vals.get(level)
        if not val or val in {'--', 'â€”', '—'}:
            continue
        if _add_related(val, level):
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
                    return related
        except Exception:
            pass
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
