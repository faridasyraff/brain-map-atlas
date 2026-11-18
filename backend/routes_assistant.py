"""Assistant endpoints: /api/chat and /api/enrich."""
from flask import Blueprint, request, jsonify
from extensions import limiter
from common import (_get_openai_api_key, _json_body, _safe_error_response, log)
from atlas import (acronym_df, name_df)
from enrichment import (_generate_functional_keywords, _generate_region_summary, _get_functional_keywords, _get_region_summary, _get_related_regions)
from assistant import (_OLLAMA_UNREACHABLE, _OllamaUnavailable, _gpt_answer, _ollama_reachable, _rag_answer)

bp = Blueprint('assistant', __name__)

# ── Asynchronous region enrichment (called by frontend after panel is already
# rendered). Takes pidx OR name/acronym. Returns region_summary,
# functional_keywords, related_regions. Blocks on OpenAI if neither the
# curated KB nor the AI cache have entries yet; instant on subsequent calls
# thanks to the persistent cache.
@bp.route('/api/enrich')
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

    # Say WHY the AI parts are empty when it's a config problem, so the
    # panel doesn't claim "no summary exists" for a region that has one.
    ai_note = ''
    if not summary and not _get_openai_api_key():
        ai_note = ('AI summaries are turned off: no OPENAI_API_KEY is set in '
                   'backend/.env.')

    return jsonify({
        'parcellation_index': pidx,
        'matched_label':   matched_name,
        'matched_acronym': matched_acro,
        'ai_note':             ai_note,
        'region_summary':      summary,
        'functional_keywords': keywords,
        'related_regions':     related,
    })



@bp.route('/api/chat', methods=['POST'])
@limiter.limit('15 per minute')
def chat():
    data               = _json_body()
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
    if not _ollama_reachable():
        return jsonify({'answer': _OLLAMA_UNREACHABLE, 'provider': 'ollama',
                        'error_kind': 'ollama_unavailable'})
    try:
        answer, cortexmap_status, pmc_ids = _rag_answer(question, region_name, parcellation_index, region_acronym)
    except _OllamaUnavailable as e:
        return jsonify({'answer': str(e), 'provider': 'ollama', 'error_kind': 'ollama_unavailable'})
    except Exception as e:
        return _safe_error_response(e)

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
