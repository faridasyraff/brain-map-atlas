// The region-info side panel: the name/short-code/coordinates readout, the
// AI-written summary/keywords/related-region cards, and keeping the 3D view
// showing whatever region is currently displayed here.
//
// Note: this file, ontology.js, and searchPanel.js all use things from each
// other — see the note at the top of lookup.js for why that's fine here.
import { API, LEVELS } from './config.js';
import { _allTreeRows } from './state.js';
import { setStatus } from './statusBar.js';
import { highlightTreeByAcronym } from './ontology.js';
import { selectSearchResult } from './searchPanel.js';

const rIdx=document.getElementById('r-idx'),rStruct=document.getElementById('r-struct'),rAcro=document.getElementById('r-acro');
const regionSummaryText=document.getElementById('region-summary-text');
const keywordCloud=document.getElementById('keyword-cloud');
const relatedRegionList=document.getElementById('related-region-list');
const swDots={organ:document.getElementById('sw-organ'),category:document.getElementById('sw-category'),division:document.getElementById('sw-division'),structure:document.getElementById('sw-structure'),substructure:document.getElementById('sw-substructure')};

function renderRegionSummary(summary){
  if(!regionSummaryText) return;
  const text=String(summary||'').trim();
  if(!text){
    regionSummaryText.classList.add('region-summary-empty');
    regionSummaryText.textContent='No functional summary available for this region.';
    return;
  }
  regionSummaryText.classList.remove('region-summary-empty');
  regionSummaryText.textContent=text;
}

function renderFunctionalKeywords(keywords){
  if(!keywordCloud) return;
  keywordCloud.innerHTML='';

  if(!Array.isArray(keywords)||!keywords.length){
    const empty=document.createElement('span');
    empty.className='keyword-empty';
    empty.textContent='No functional keyword data available for this region.';
    keywordCloud.appendChild(empty);
    return;
  }

  const weights=keywords.map(k=>Number(k.weight)||0);
  const min=Math.min(...weights);
  const max=Math.max(...weights);
  const spread=max-min||1;

  keywords.forEach(k=>{
    const term=String(k.term||'').trim();
    if(!term) return;
    const weight=Number(k.weight)||min;
    const normalized=(weight-min)/spread;
    const chip=document.createElement('span');
    chip.className='keyword-chip';
    chip.textContent=term;
    chip.style.fontSize=`${0.62+normalized*0.42}rem`;
    chip.style.opacity=`${0.72+normalized*0.28}`;
    keywordCloud.appendChild(chip);
  });
}

async function navigateToRelatedRegion(region){
  const q=region.query||region.name||region.label;
  if(!q) return;
  try{
    setStatus(`Finding related region "${q}"...`);
    const res=await fetch(`${API}/api/search?q=${encodeURIComponent(q)}&limit=10`);
    const data=await res.json();
    const match=(data.results||[]).find(r=>!r.is_group)||(data.results||[])[0];
    if(!match){
      setStatus(`Related region "${q}" was not found in the atlas`,'error');
      return;
    }
    await selectSearchResult(document.createElement('div'),match);
  } catch(err){
    setStatus('Related region navigation failed: '+err.message,'error');
  }
}

function renderRelatedRegions(regions){
  if(!relatedRegionList) return;
  relatedRegionList.innerHTML='';

  if(!Array.isArray(regions)||!regions.length){
    const empty=document.createElement('span');
    empty.className='related-region-empty';
    empty.textContent='No related region data available.';
    relatedRegionList.appendChild(empty);
    return;
  }

  regions.forEach(r=>{
    const label=String(r.label||r.name||r.query||'').trim();
    if(!label) return;
    const chip=document.createElement('button');
    chip.type='button';
    chip.className='related-region-chip';
    chip.textContent=label;
    chip.title=r.relationship?`${r.relationship}: ${label}`:label;
    chip.addEventListener('click',()=>navigateToRelatedRegion(r));
    relatedRegionList.appendChild(chip);
  });
}

// In-flight enrichment fetch (AbortController). Canceled whenever the user
// clicks a new region so we don't waste OpenAI tokens on a stale query and
// don't race a late response into the panel showing a different region.
let _enrichAbort = null;

// Drop a greyed-out "Loading…" hint into one of the three enrichment panels
// (summary / keywords / related). Used while the background /api/enrich
// fetch is in flight. Uses each panel's empty-state CSS class for styling.
function _showLoadingPlaceholder(target, msg){
  if(!target) return;
  target.innerHTML = '';
  const span = document.createElement('span');
  span.className = target === regionSummaryText ? 'region-summary-empty' :
                   target === keywordCloud      ? 'keyword-empty' :
                                                  'related-region-empty';
  span.textContent = msg;
  if(target === regionSummaryText){
    target.classList.add('region-summary-empty');
    target.textContent = msg;
  } else {
    target.appendChild(span);
  }
}

async function _enrichInBackground(pidx, name, acronym){
  // Cancel any prior in-flight enrich. The old one's awaited fetch will
  // reject with AbortError and its catch block will bail without overwriting
  // the panel (it has also just been superseded, so the guard at the top of
  // the try block would catch it anyway).
  if(_enrichAbort){ try { _enrichAbort.abort(); } catch(e){} }
  const controller = new AbortController();
  _enrichAbort = controller;

  // Build URL
  const qs = new URLSearchParams();
  if(pidx != null) qs.set('pidx', String(pidx));
  if(name)         qs.set('name', name);
  if(acronym && acronym !== '--') qs.set('acronym', acronym);

  try {
    const res = await fetch(`${API}/api/enrich?${qs.toString()}`, { signal: controller.signal });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    // If a newer click already superseded us, don't overwrite its panel.
    if(controller !== _enrichAbort) return;
    if(d.region_summary)      renderRegionSummary(d.region_summary);
    else                      renderRegionSummary('');
    if(Array.isArray(d.functional_keywords)) renderFunctionalKeywords(d.functional_keywords);
    else                      renderFunctionalKeywords([]);
    if(Array.isArray(d.related_regions))     renderRelatedRegions(d.related_regions);
  } catch(err){
    if(err.name === 'AbortError') return;   // expected when user clicks another region
    console.warn('[enrich]', err);
    // leave whatever placeholders are showing
  } finally {
    if(controller === _enrichAbort){ _enrichAbort = null; }
  }
}

export function updatePanel(data){
  // matched_label is always the exact clicked region name from the backend
  // Fall back through hierarchy only if matched_label not present
  const name = data.matched_label ||
    [data.substructure, data.structure, data.division, data.category]
      .find(v => v && v !== '—' && v !== '--') || '--';
  const acronym = data.matched_acronym ||
    [data.substructure_acronym, data.structure_acronym,
     data.division_acronym, data.category_acronym, data.acronym]
      .find(v => v && v !== '—' && v !== '--') || '--';

  rIdx.textContent = data.parcellation_index ?? '—';
  rStruct.textContent = name; rStruct.classList.remove('placeholder');
  rAcro.textContent = acronym;
  LEVELS.forEach(f=>{ const col=data[f+'_color']; if(col&&swDots[f]){ swDots[f].style.background=col; swDots[f].parentElement.style.color=col; } });

  // Render whatever enrichment came back with the click. /api/lookup is kept
  // fast — it never calls OpenAI itself — but it DOES return previously-cached
  // AI results (so regions you've visited before will already have summary
  // and keywords filled in here). If any field is still empty, show a
  // "Loading…" placeholder and fire /api/enrich in the background to fill it;
  // the render functions will run again when the response arrives.
  const haveSummary  = typeof data.region_summary === 'string' && data.region_summary.trim();
  const haveKeywords = Array.isArray(data.functional_keywords) && data.functional_keywords.length > 0;
  const haveRelated  = Array.isArray(data.related_regions) && data.related_regions.length > 0;

  if(haveSummary)  renderRegionSummary(data.region_summary);
  else             _showLoadingPlaceholder(regionSummaryText, 'Loading functional summary…');

  if(haveKeywords) renderFunctionalKeywords(data.functional_keywords);
  else             _showLoadingPlaceholder(keywordCloud, 'Loading keywords…');

  if(haveRelated)  renderRelatedRegions(data.related_regions);
  else             _showLoadingPlaceholder(relatedRegionList, 'Loading related regions…');

  // Kick off async enrichment if anything's missing. Runs in parallel with
  // the 2D highlights and 3D mesh load that follow this function.
  if(!(haveSummary && haveKeywords && haveRelated) && name && name !== '--'){
    _enrichInBackground(data.parcellation_index, name, acronym);
  } else if(_enrichAbort){
    // We have everything already — cancel any older in-flight enrich.
    try { _enrichAbort.abort(); } catch(e){}
    _enrichAbort = null;
  }

  if(acronym&&acronym!=='--') highlightTreeByAcronym(acronym);

  // Sync the 3D view — find the structure id in the already-loaded ontology tree
  syncThreeD({ name, acronym, data });
}

// Resolve a region {name, acronym} to a numeric Allen structure_id by
// looking it up in the ontology tree we already loaded.
//
// We prefer name/acronym matching against the Allen CCFv3 ontology tree
// (which is what /api/ontology returns and what _availableMeshIds is
// keyed by) over the `data.structure_id` carried by the backend, because
// that sid comes from ABC's term tree via MBA identifiers — which can
// include ABC-fine-grained sids that don't correspond to any CCFv3 mesh
// file. Name-match lands us on the correct Allen CCFv3 node that owns
// the mesh (e.g. Caudoputamen → sid 672 → /meshes/672.glb).
//
// Before matching we strip ABC's ", unassigned" suffix. ABC tags the
// leftover voxels of a structure that wasn't further subdivided with
// "<Name>, unassigned" (e.g. "Periaqueductal gray, unassigned"); that
// exact string is NOT a node in the CCFv3 ontology tree, but the parent
// "Periaqueductal gray" is, and that's the mesh we want to show.
//
// Falls back to `data.structure_id` only when name-match still fails.
export function syncThreeD({ name, acronym, data }){
  if (!window.brain3d) return;

  // Strip ABC's ", unassigned" / ", mixed" / "-un" style suffixes so the
  // remaining string matches a real Allen CCFv3 ontology node. Acronyms
  // get suffix-stripped too ("PAG-un" → "PAG").
  const stripAbcSuffix = s => (s || '')
    .replace(/,\s*unassigned\s*$/i, '')
    .replace(/,\s*mixed\s*$/i, '')
    .replace(/[\s\-_]+un(assigned)?\s*$/i, '')
    .trim();
  const cleanName    = stripAbcSuffix(name);
  const cleanAcronym = stripAbcSuffix(acronym);

  let entry = null;
  if (Array.isArray(_allTreeRows) && _allTreeRows.length > 0) {
    const acroLo = cleanAcronym.toLowerCase();
    const nameLo = cleanName.toLowerCase();
    if (acroLo && acroLo !== '--'){
      entry = _allTreeRows.find(e => (e.node.acronym || '').toLowerCase() === acroLo);
    }
    if (!entry && nameLo && nameLo !== '--'){
      entry = _allTreeRows.find(e => (e.node.name || '').toLowerCase() === nameLo);
    }
    // Last-chance: try the ORIGINAL (unstripped) values in case the ABC
    // label happens to be a legitimate ontology name that contains a
    // comma (rare, but safer than falling through to structure_id).
    if (!entry) {
      const rawAcro = (acronym || '').toLowerCase();
      const rawName = (name || '').toLowerCase();
      if (rawAcro && rawAcro !== '--'){
        entry = _allTreeRows.find(e => (e.node.acronym || '').toLowerCase() === rawAcro);
      }
      if (!entry && rawName && rawName !== '--'){
        entry = _allTreeRows.find(e => (e.node.name || '').toLowerCase() === rawName);
      }
    }
  }

  if (entry) {
    const node = entry.node;
    if (!node.id) return;
    console.log(`[syncThreeD] name-matched "${name}" / "${acronym}" → ` +
                `"${node.name}" / "${node.acronym}" (id=${node.id})`);
    const color = node._color || ('#' + (node.color_hex_triplet || 'ffb74a'));
    window.brain3d.showRegion(node.id, {
      acronym: node.acronym || cleanAcronym || acronym,
      name:    node.name    || cleanName    || name,
      color,
    });
    return;
  }

  // Name-match still failed. Fall back to the backend-supplied structure_id
  // (showRegion's ancestor walk may still find a displayable parent mesh).
  const directSid = data && data.structure_id;
  if (directSid) {
    console.log(`[syncThreeD] name "${name}" / "${acronym}" (cleaned "${cleanName}" / ` +
                `"${cleanAcronym}") not in ontology tree; falling back to ` +
                `structure_id=${directSid}`);
    window.brain3d.showRegion(directSid, {
      acronym: cleanAcronym || acronym,
      name:    cleanName    || name,
      color:   '#ffb74a',
    });
  } else {
    console.warn(`[syncThreeD] no match for "${name}" / "${acronym}" and no structure_id`);
  }
}
