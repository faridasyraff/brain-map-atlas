"""The atlas assistant: local answers via Ollama (with CortexMap research
summaries when available) and OpenAI GPT answers."""
import json as _json
import os as _os
import urllib.request as _urllib_req
import urllib.error as _urllib_err
from pathlib import Path
from common import (_get_openai_api_key, _load_openai, log)
from atlas import (LEVEL_COLS, _acro_to_term_id, _name_to_term_id, _term_nodes, color_df, name_df)
from enrichment import (_get_functional_keywords, _get_region_summary, _get_related_regions)

# ── Brain Atlas RAG Chatbot ───────────────────────────────────────────────────

# Local AI = Ollama (https://ollama.com) running separately. Talked to over
# its plain HTTP API, so no extra Python packages are needed. Inside Docker,
# "localhost" is the container itself — point OLLAMA_URL at the host instead
# (http://host.docker.internal:11434, see .env.example).
_IN_DOCKER    = Path('/.dockerenv').exists()
_OLLAMA_URL   = (_os.environ.get('OLLAMA_URL') or
                 ('http://host.docker.internal:11434' if _IN_DOCKER else 'http://localhost:11434')
                 ).rstrip('/')
_OLLAMA_MODEL = _os.environ.get('OLLAMA_MODEL') or 'gemma3:4b'

class _OllamaUnavailable(Exception):
    pass

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

class _KbDoc:
    def __init__(self, content, metadata):
        self.page_content = content
        self.metadata = metadata

def _load_kb_documents():
    """One text document per region in brain_regions_kb.json, used as the
    local assistant's context. (This used to also build a Chroma vector
    store + download an embedding model on every start, but nothing ever
    queried it — the lookup below is, and always was, an exact match on the
    selected region's name / acronym / parcellation index.)"""
    kb_file = Path(__file__).parent / 'brain_regions_kb.json'
    try:
        regions = _json.loads(kb_file.read_text('utf-8')).get('regions', [])
    except Exception as e:
        log.warning(f'local assistant KB load failed: {e}')
        return []
    docs = []
    for r in regions:
        lines = []
        for field in ['structure','substructure','division','category','organ','acronym']:
            if r.get(field):
                lines.append(f"{field.title()}: {r[field]}")
        if r.get('parcellation_index'):
            lines.append(f"Parcellation Index: {r['parcellation_index']}")
        for field in ['function','connectivity','clinical_relevance','notes']:
            if r.get(field):
                lines.append(f"\n{field.replace('_',' ').title()}:\n{r[field]}")
        docs.append(_KbDoc('\n'.join(lines), {
            'structure':          str(r.get('structure','')).lower(),
            'parcellation_index': str(r.get('parcellation_index','')),
            'acronym':            str(r.get('acronym','')).lower(),
        }))
    return docs

_kb_documents = _load_kb_documents()

def _ollama_generate(prompt, timeout=120):
    """Ask the local Ollama server for a completion. Raises
    _OllamaUnavailable with a user-facing explanation if it can't."""
    body = _json.dumps({'model': _OLLAMA_MODEL, 'prompt': prompt, 'stream': False,
                        'options': {'temperature': 0.3}}).encode('utf-8')
    req = _urllib_req.Request(f'{_OLLAMA_URL}/api/generate', data=body,
                              headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with _urllib_req.urlopen(req, timeout=timeout) as resp:
            payload = _json.loads(resp.read().decode('utf-8'))
        return (payload.get('response') or '').strip()
    except _urllib_err.HTTPError as e:
        if e.code == 404:
            raise _OllamaUnavailable(
                f"Ollama is running but doesn't have the '{_OLLAMA_MODEL}' model. "
                f"Run: ollama pull {_OLLAMA_MODEL}") from e
        raise _OllamaUnavailable(f'Ollama returned HTTP {e.code}.') from e
    except TimeoutError as e:
        # Reachable but slow — usually the model loading for the first time.
        raise _OllamaUnavailable(
            f'The local AI took longer than {timeout}s to answer (the first question '
            'after starting Ollama can be slow while the model loads). Try again.') from e
    except (_urllib_err.URLError, OSError) as e:
        raise _OllamaUnavailable(_OLLAMA_UNREACHABLE) from e
    except (ValueError, AttributeError) as e:
        # 200 but not Ollama's JSON — OLLAMA_URL points at something else.
        raise _OllamaUnavailable(
            f"Something answered at {_OLLAMA_URL}, but it isn't Ollama. Check OLLAMA_URL.") from e

_OLLAMA_UNREACHABLE = (
    f"The local AI (Ollama) isn't reachable at {_OLLAMA_URL}. Start it with "
    f"'ollama serve' (and 'ollama pull {_OLLAMA_MODEL}'), or switch to GPT. "
    "If Ollama runs somewhere else, set OLLAMA_URL in backend/.env.")

def _ollama_reachable():
    """Cheap (2 s) check before doing the slower CortexMap lookups that only
    matter if Ollama can answer afterwards."""
    try:
        with _urllib_req.urlopen(f'{_OLLAMA_URL}/api/tags', timeout=2):
            return True
    except Exception:
        return False

def _atlas_context(region_name='', parcellation_index='', region_acronym=''):
    """Plain-text facts the atlas itself has about a region, for the local
    assistant's prompt. Empty string if the region can't be found."""
    levels = ['organ', 'category', 'division', 'structure', 'substructure']
    row, pidx, depth = None, None, len(levels)
    try:
        pidx = int(parcellation_index) if str(parcellation_index).strip() else None
    except ValueError:
        pidx = None
    if pidx is not None and pidx in name_df.index:
        row = name_df.loc[pidx]
    elif region_name:
        # Matched by name (e.g. a group): any member row works for the levels
        # ABOVE the match, but must stop at the matched level — the rows
        # below it describe one particular member, not the group.
        rn = region_name.lower().strip()
        for col in ['substructure', 'structure', 'division', 'category']:
            hits = name_df[name_df[col].fillna('').str.lower() == rn]
            if not hits.empty:
                row, depth = hits.iloc[0], levels.index(col) + 1
                pidx = int(hits.index[0]) if col == 'substructure' else None
                break

    lines = []
    if region_name:
        lines.append(f"Selected region: {region_name}" + (f" ({region_acronym})" if region_acronym else ''))
    if row is not None:
        path = []
        for c in levels[:depth]:
            v = str(row.get(c) or '').strip()
            if v and v not in ('—', '--', 'nan') and (not path or path[-1] != v):   # skip repeats
                path.append(v)
        if path:
            lines.append("Position in the Allen hierarchy (broad to specific): " + " > ".join(path))
    else:
        term = _name_to_term_id.get((region_name or '').lower()) or _acro_to_term_id.get((region_acronym or '').lower())
        if term:
            node = _term_nodes.get(term, {})
            parent = _term_nodes.get(node.get('parent_label', ''), {})
            n_children = len(node.get('children', []))
            lines.append("This is a grouping in the Allen hierarchy"
                         + (f" under {parent.get('name')}" if parent.get('name') else '')
                         + (f", with {n_children} direct subdivisions" if n_children else '') + ".")
    if not lines:
        return ''

    related = _get_related_regions(parcellation_index=pidx, region_name=region_name,
                                   region_acronym=region_acronym, limit=8)
    if related:
        lines.append("Related regions in the atlas: " + "; ".join(
            f"{r['label']} ({r['relationship']})" for r in related))
    summary = _get_region_summary(parcellation_index=pidx, region_name=region_name, region_acronym=region_acronym)
    if summary:
        lines.append(f"Summary: {summary}")
    keywords = _get_functional_keywords(parcellation_index=pidx, region_name=region_name, region_acronym=region_acronym)
    if keywords:
        lines.append("Functional keywords: " + ", ".join(k['term'] for k in keywords[:12]))
    return "\n".join(lines)


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
                print("[CortexMap]   Falling back to local knowledge base.")
                log.info(f"CortexMap: '{region_name}' not found in regions list")
                cortexmap_status = 'region_not_found'

            else:
                # Step 2: Fetch summaries
                print(f"[CortexMap] \u2139 Found UUID {region_id} for '{region_name}' — fetching summaries...")
                cortexmap_summary, pmc_ids, sum_err = _cortexmap_get_summaries(region_id)

                if sum_err:
                    print(f"[CortexMap] \u2717 Could not fetch summaries for '{region_name}' — {sum_err}")
                    print("[CortexMap]   Falling back to local knowledge base.")
                    log.warning(f"CortexMap summaries fetch failed for '{region_name}': {sum_err}")
                    cortexmap_status = 'summaries_error'

                elif cortexmap_summary:
                    print(f"[CortexMap] \u2713 Summaries loaded for '{region_name}' (id={region_id}) — enriching RAG context.")
                    log.info(f"CortexMap: summaries loaded for '{region_name}' (id={region_id})")
                    cortexmap_status = 'enriched'

                else:
                    print(f"[CortexMap] \u2139 No summaries yet for '{region_name}' — pipeline may still be generating.")
                    print("[CortexMap]   Falling back to local knowledge base.")
                    log.info(f"CortexMap: '{region_name}' has no summaries yet")
                    cortexmap_status = 'generating'

        except Exception as _e:
            print(f"[CortexMap] \u2717 Unexpected error for '{region_name}': {_e}")
            print("[CortexMap]   Falling back to local knowledge base.")
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
    else:
        # No literature from CortexMap: answer from what the atlas itself
        # knows about the region (hierarchy, acronym, related regions, any
        # cached summary/keywords, and the curated KB entry if there is one).
        # The curated KB only covers a handful of regions, so the old "KB
        # only" rule meant the local assistant refused for almost every click.
        facts = _atlas_context(region_name, parcellation_index, region_acronym)
        if selected_doc:
            facts += f"\n\nCurated notes:\n{selected_doc}"
        if facts:
            prompt = (
                "You are a neuroscience assistant for the Allen MOUSE Brain Common "
                "Coordinate Framework v3 (CCFv3). Every question is about the mouse "
                "brain (Mus musculus) unless the user clearly says otherwise.\n\n"
                "The ATLAS FACTS below are authoritative for names, acronyms and where "
                "the region sits in the hierarchy. For function and connectivity, use "
                "the facts when they cover it; otherwise you may use well-established "
                "knowledge of mouse neuroanatomy, and say plainly when something is "
                "uncertain or not well characterised. Use Allen CCFv3 region names. "
                "Keep the answer under about 200 words.\n\n"
                f"ATLAS FACTS\n{facts}\n\n"
                f"Question: {question}\n"
                "Answer:"
            )
        else:
            prompt = (
                "You are a neuroscience assistant for the Allen MOUSE Brain Common "
                "Coordinate Framework v3 (CCFv3). Assume questions are about the mouse "
                "brain. No region is selected, so answer generally, use Allen CCFv3 "
                "region names, and keep it under about 200 words.\n\n"
                f"Question: {question}\n"
                "Answer:"
            )
    return _ollama_generate(prompt), cortexmap_status, pmc_ids


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
