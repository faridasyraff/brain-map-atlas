// The chat panel (local Ollama RAG or OpenAI) plus the "Semantic Region
// Cloud" — parses region names out of a list-style answer and resolves each
// one to a clickable atlas chip via /api/resolve_region.
import { API } from './config.js';
import { selectSearchResult } from './searchPanel.js';

// -- Chat + Semantic Region Cloud -----------------------------
(function(){
  const msgs    = document.getElementById('chat-messages');
  const input   = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  let _aiProvider = 'ollama';

  document.getElementById('ai-provider-btns').addEventListener('click', e => {
    const btn = e.target.closest('.ai-btn'); if(!btn) return;
    _aiProvider = btn.dataset.ai;
    document.querySelectorAll('.ai-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  function addMsg(text, role) {
    const d = document.createElement('div');
    d.className = 'chat-msg ' + role;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  let _currentRegion = null;
  window.setCurrentRegion = function(rd){ _currentRegion = rd; };

  // -- Semantic region parser ---------------------------------------------------
  const NON_REGION_WORDS = new Set([
    'function','connectivity','overview','summary','note','notes',
    'description','introduction','background','context','clinical',
    'relevance','anatomy','structure','substructure','division','category',
    'organ','region','area','pathway','circuit','system','network',
    'projection','input','output','afferent','efferent','axon','neuron',
    'yes','no','also','here','these','those','this','that','the','and',
    'associated','related','connected','involved','including','such',
    'important','major','key','primary','secondary','main','central',
    'role','part','side','left','right','layer','layers','regions',
    'areas','pathways','circuits','systems','nuclei','nucleus',
  ]);

  function extractCandidateNames(text) {
    const candidates = new Set();
    const clean = n => n
      .replace(/\*\*/g,'').replace(/[_`*]/g,'')
      .replace(/\s*[:\(\[].*/, '').replace(/[,;.!?]+$/, '').trim();
    const valid = n => {
      if (!n || n.length < 3 || n.length > 60) return false;
      const lo = n.toLowerCase();
      if (NON_REGION_WORDS.has(lo)) return false;
      if (/^(the |a |an |of |in |for |to |with |by |from |and |or )/i.test(n)) return false;
      if (/\b(process|involve|play|send|receive|project|connect|control|regulate|modulat|integrat|includ|compris)\b/i.test(n)) return false;
      return true;
    };
    const lines = text.split(/\n/);
    for (const line of lines) {
      // 1. Numbered / bulleted list items
      const listM = line.match(/^\s*(?:\d+[.)]\s*|[-*•]\s+)(.+)/);
      if (listM) { const n = clean(listM[1]); if (valid(n)) candidates.add(n); }
      // 2. Bold **Name** or *Name*
      for (const m of line.matchAll(/\*{1,2}([A-Z][^*]{2,55})\*{1,2}/g)) {
        const n = clean(m[1]); if (valid(n)) candidates.add(n);
      }
      // 3. Quoted "Name"
      for (const m of line.matchAll(/["']([A-Z][^"']{2,55})["']/g)) {
        const n = clean(m[1]); if (valid(n)) candidates.add(n);
      }
      // 4. Inline capitalized multi-word proper nouns (2-4 words, each Capitalized)
      for (const m of line.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,3})\b/g)) {
        const n = clean(m[1]); if (valid(n)) candidates.add(n);
      }
    }
    return [...candidates];
  }

  // Returns true if the question is likely to produce a list of regions
  function isListQuery(q) {
    // Must explicitly ask for a list/enumeration of brain regions
    return /\b(list|enumerate|what\s+are|which\s+are|name\s+(all|the)|give\s+me|show\s+me)\b.*(region|area|structure|nucleus|nuclei|part|subdivision|connected|projection|input|output)/i.test(q)
        || /\b(region|area|structure|nucleus|nuclei|subdivision)s?\s+(of|in|for|connected|related|involved|associated)/i.test(q)
        || /\bconnected\s+to\b|\bprojects?\s+to\b|\binput.*from\b|\boutput.*to\b/i.test(q);
  }

  // Resolver: calls dedicated /api/resolve_region endpoint (never touches /api/search).
  // Tries the full name, then strips parentheticals, then first two words.
  async function resolveRegion(name) {
    const tryResolve = async (q) => {
      try {
        const res  = await fetch(`${API}/api/resolve_region?name=${encodeURIComponent(q)}`);
        const data = await res.json();
        return (data && data.matched_label) ? data : null;
      } catch { return null; }
    };

    // Attempt 1: full name as-is
    let r = await tryResolve(name);
    if (r) return r;

    // Attempt 2: strip parenthetical "(LC)" or "(CA1)" suffixes
    const stripped = name.replace(/\s*\([^)]*\)/, '').trim();
    if (stripped !== name && stripped.length >= 3) {
      r = await tryResolve(stripped);
      if (r) return r;
    }

    // Attempt 3: first two words only (e.g. "Locus Coeruleus, dorsal part" -> "Locus Coeruleus")
    const words = (stripped || name).split(/\s+/);
    if (words.length >= 3) {
      r = await tryResolve(words.slice(0, 2).join(' '));
      if (r) return r;
    }

    return null;
  }


  // -- Build and inject the region cloud card -----------------------------------
  async function buildRegionCloud(answerText, topic) {
    const candidates = extractCandidateNames(answerText);
    if (candidates.length < 2) return false; // not a list response

    // Create the card immediately (chips start as "resolving")
    const card = document.createElement('div');
    card.className = 'region-cloud-card';

    card.innerHTML = `
      <div class="cloud-header">
        <div class="cloud-title"><span class="cloud-title-dot"></span>Semantic Region Map</div>
        <span class="cloud-count" id="cloud-count-badge">resolving...</span>
      </div>
      <div class="cloud-topic">${topic.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
      <div class="cloud-chips" id="cloud-chips-wrap"></div>
      <div class="cloud-footer">
        <span class="cloud-footer-hint">click any chip above to navigate atlas</span>
      </div>`;

    msgs.appendChild(card);
    msgs.scrollTop = msgs.scrollHeight;

    const chipsWrap  = card.querySelector('#cloud-chips-wrap');
    const countBadge = card.querySelector('#cloud-count-badge');

    // Resolve all candidates in parallel, rendering chips as they arrive
    const resolved = [];
    const promises = candidates.map(async name => {
      // Placeholder chip while resolving
      const chip = document.createElement('div');
      chip.className = 'cloud-chip chip-resolving';
      chip.style.cssText = 'background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1);color:var(--text-dim);';
      chip.innerHTML = `<span class="cloud-chip-dot" style="background:var(--text-dim)"></span>${name}`;
      chipsWrap.appendChild(chip);

      const r = await resolveRegion(name);

      if (!r) {
        // Not found in atlas -- show as clickable "not in volume" chip
        // so users can still ask GPT about it via the chat
        chip.classList.remove('chip-resolving');
        chip.className = 'cloud-chip';
        chip.style.cssText = 'background:rgba(80,80,80,.12);border-color:rgba(120,120,120,.3);color:#777;cursor:pointer;';
        chip.innerHTML = `<span class="cloud-chip-dot" style="background:#555"></span>${name}<span style="font-size:.65em;opacity:.6;margin-left:4px;font-style:italic">not in volume</span>`;
        // Clicking sets it as current region by name so GPT can answer about it
        chip.addEventListener('click', () => {
          if(window.setCurrentRegion) window.setCurrentRegion({
            structure: name, parcellation_index: null, _unavailable: true
          });
          if(window.notifyChatRegion) window.notifyChatRegion(name, {
            structure: name, parcellation_index: null, _unavailable: true
          });
        });
        return;
      }

      // Style with the region's official color
      const col    = r.structure_color || '#445a72';
      const colRgb = col.replace('#','');
      const ri = parseInt(colRgb.substring(0,2),16);
      const gi = parseInt(colRgb.substring(2,4),16);
      const bi = parseInt(colRgb.substring(4,6),16);

      chip.className = 'cloud-chip';
      chip.style.cssText = `background:rgba(${ri},${gi},${bi},0.12);border-color:rgba(${ri},${gi},${bi},0.45);color:rgb(${Math.min(ri+80,255)},${Math.min(gi+80,255)},${Math.min(bi+80,255)});`;

      // Label: use group_name for groups, most-specific name for leaves
      const chipLabel = r.is_group
        ? (r.group_name || r.matched_label || name)
        : (r.matched_label || r.structure || name);
      const chipLabel2 = chipLabel !== '--' ? chipLabel : name;
      const groupBadge = r.is_group
        ? `<span style="font-size:.6em;opacity:.6;margin-left:3px">(${r.member_count||''})</span>`
        : (r.no_voxels ? `<span style="font-size:.65em;opacity:.6;margin-left:4px;font-style:italic">not in volume</span>` : '');
      chip.innerHTML = `<span class="cloud-chip-dot" style="background:${col};box-shadow:0 0 4px ${col}"></span>${chipLabel2}${groupBadge}`;

      chip.addEventListener('click', () => {
        selectSearchResult(chip, r);
      });

      resolved.push(r);
      countBadge.textContent = `${resolved.length} found`;
    });

    await Promise.all(promises);
    countBadge.textContent = `${resolved.length} / ${candidates.length} regions`;



    return resolved.length > 0;
  }

  // -- Main send handler -------------------------------------------------------
  async function send() {
    const q = input.value.trim(); if (!q) return;
    input.value = ''; sendBtn.disabled = true;
    addMsg(q, 'user');
    const thinking = addMsg(_aiProvider==='openai' ? 'GPT thinking...' : 'Thinking...', 'bot thinking');

    try {
      const res  = await fetch(API + '/api/chat', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          message: q,
          region_name: _currentRegion?._unavailable
            ? _currentRegion.structure   // unavailable: send name only, no parcellation lookup
            : (_currentRegion?.structure || ''),
          region_acronym: _currentRegion?.acronym || _currentRegion?.structure_acronym || '',
          parcellation_index: _currentRegion?._unavailable ? '' : (_currentRegion?.parcellation_index || ''),
          ai_provider: _aiProvider,
        })
      });
      const data = await res.json();
      thinking.remove();

      const answer = data.answer || data.error || 'No response.';
      const badge  = _aiProvider === 'openai'
        ? '<span class="ai-provider-badge openai">GPT</span> '
        : '<span class="ai-provider-badge ollama">Local</span> ';

      // Always show the text answer
      const d = document.createElement('div');
      d.className = 'chat-msg bot';
      d.innerHTML = badge + answer.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

      // Show CortexMap status notice beneath the answer (Ollama only)
      if (_aiProvider !== 'openai' && data.cortexmap_notice) {
        const statusClass = {
          // ⚠ warn (amber) — something went wrong, using local KB
          unreachable:      'warn',
          summaries_error:  'warn',
          error:            'warn',
          // ℹ info (blue) — pipeline running or region not known yet
          region_not_found: 'info',
          no_summaries:     'info',
          generating:       'info',
          // ✓ ok (green) — CortexMap enrichment succeeded
          enriched:         'ok',
        }[data.cortexmap_status] || 'info';
        const notice = document.createElement('div');
        notice.className = `cortexmap-notice ${statusClass}`;
        notice.textContent = data.cortexmap_notice;
        d.appendChild(notice);
      }

      // Show PMC source links if CortexMap returned any
      if (data.pmc_sources && data.pmc_sources.length > 0) {
        const srcDiv = document.createElement('div');
        srcDiv.className = 'pmc-sources';
        srcDiv.innerHTML = '<span>PubMed Sources (CortexMap):</span>' +
          data.pmc_sources.map(pid =>
            `<a href="https://www.ncbi.nlm.nih.gov/pmc/articles/${pid}/" target="_blank" rel="noopener">${pid}</a>`
          ).join('');
        d.appendChild(srcDiv);
      }

      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;

      // Only build region cloud if the user explicitly asked for a list of regions
      if (isListQuery(q)) {
        await buildRegionCloud(answer, q);
      }

    } catch(e) {
      thinking.remove();
      addMsg('Error: ' + e.message, 'bot');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') send(); });

  // Just updates which region the chat should answer questions about —
  // no chat message for this anymore, the inspector panel above already
  // shows what's selected.
  window.notifyChatRegion = function(regionName, regionData) {
    if(regionData) window.setCurrentRegion(regionData);
  };
})();
