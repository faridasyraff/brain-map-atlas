// The hierarchy/tree side panel: loading the full region tree from the
// server, drawing it, expanding and collapsing branches, the small search
// box built into the tree, and picking a region from it (which updates the
// 2D and 3D views the same way clicking a region directly would).
//
// Note: this file and inspectorPanel.js/searchPanel.js each use things from
// the others — see the note at the top of lookup.js for why that's fine.
import { API } from './config.js';
import {
  views, setSuppressSliderReload, setLastParcIdx, setLastHighlight,
  _ontologyRoots, _allTreeRows, setOntologyRoots, setAllTreeRows,
  _activeRowEl, setActiveRowEl,
} from './state.js';
import { setStatus } from './statusBar.js';
import { _sendWarning } from './rateLimiter.js';
import { loadSliceP, syncCanvas, drawHighlight, showNoVoxelNote } from './sliceViewer.js';
import { updatePanel } from './inspectorPanel.js';
import { selectSearchResult } from './searchPanel.js';

const _RAPID_THRESH = 3;     // blocked hits before warning fires (matches rateLimiter.js)

const ontologyTreeEl   = document.getElementById('ontology-tree');
const ontologySearchEl = document.getElementById('ontology-search');

// Build a flat child→parent map from the nested ontology tree. Used by
// window.brain3d.showRegion() to walk up when a structure has no mesh.
function _buildParentMap(roots){
  const parentOf = new Map();
  function walk(node, parentId){
    if (!node || !node.id) return;
    parentOf.set(node.id, parentId);
    if (Array.isArray(node.children)){
      for (const c of node.children) walk(c, node.id);
    }
  }
  for (const r of roots) walk(r, null);
  return parentOf;
}

// Same shape, but id → {name, acronym} — so when showRegion() substitutes
// an ancestor's mesh for a structure that has none of its own, it can say
// clearly which structure is actually on screen instead of just an id number.
function _buildNameMap(roots){
  const nameOf = new Map();
  function walk(node){
    if (!node || !node.id) return;
    nameOf.set(node.id, { name: node.name || '', acronym: node.acronym || '' });
    if (Array.isArray(node.children)){
      for (const c of node.children) walk(c);
    }
  }
  for (const r of roots) walk(r);
  return nameOf;
}

// Fetch the set of structure_ids that have a mesh on disk. Stashed on
// window.brain3d so showRegion() can consult it before issuing a 404-prone
// mesh load. Missing endpoint or network failure → leave set null so showRegion
// falls back to its "try the exact id, else show error" behaviour.
async function _fetchAvailableMeshSet(){
  try {
    const r = await fetch(`${API}/api/available_meshes`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.structure_ids)) return null;
    return new Set(j.structure_ids);
  } catch (_) { return null; }
}

async function loadOntology(){
  try{
    const res=await fetch(`${API}/api/ontology`);
    const data=await res.json();
    if(data.error) throw new Error(data.error);
    setOntologyRoots(data.msg||[]);
    renderOntologyTree(_ontologyRoots);

    // Wire the ancestor-fallback maps on brain3d as soon as the tree is up.
    if (window.brain3d){
      window.brain3d._parentOfStructureId = _buildParentMap(_ontologyRoots);
      window.brain3d._nameOfStructureId = _buildNameMap(_ontologyRoots);
      _fetchAvailableMeshSet().then(set => {
        if (window.brain3d) window.brain3d._availableMeshIds = set;
        if (set) console.log(`[3D] mesh catalog: ${set.size} structures have mesh files`);
      });
    }
  } catch(e){ ontologyTreeEl.innerHTML=`<div class="tree-err">(!) Could not load ontology: ${e.message}</div>`; }
}

function renderOntologyTree(roots){
  ontologyTreeEl.innerHTML=''; setAllTreeRows([]);
  function buildNode(node,parentEl,depth){
    const hasChildren=node.children&&node.children.length>0;
    const color=node._color||('#'+(node.color_hex_triplet||'445a72'));
    const nodeEl=document.createElement('div'); nodeEl.className='tree-node';
    const rowEl=document.createElement('div'); rowEl.className='tree-row'+(node._available===false?' unavailable':''); rowEl.style.paddingLeft=(depth*12)+'px';
    if(node._available===false) rowEl.title='No voxels in the CCFv3 annotation volume -- the 2D views won\'t show this structure, though the 3D view may still show an approximate parent shape';
    const toggleEl=document.createElement('span'); toggleEl.className='tree-toggle'+(hasChildren?'':' leaf'); toggleEl.textContent=hasChildren?'+':'.';
    rowEl.appendChild(toggleEl);
    const dotEl=document.createElement('span'); dotEl.className='tree-dot'; dotEl.style.background=color; rowEl.appendChild(dotEl);
    const nameEl=document.createElement('span'); nameEl.className='tree-name'; nameEl.textContent=node.name||''; rowEl.appendChild(nameEl);
    const acroEl=document.createElement('span'); acroEl.className='tree-acro'; acroEl.textContent=node.acronym||''; rowEl.appendChild(acroEl);
    nodeEl.appendChild(rowEl);
    let childrenEl=null;
    if(hasChildren){
      childrenEl=document.createElement('div'); childrenEl.className='tree-children closed'; childrenEl.style.maxHeight='0'; nodeEl.appendChild(childrenEl);
      for(const child of node.children) buildNode(child,childrenEl,depth+1);
      // Toggle arrow expands/collapses only
      toggleEl.addEventListener('click',e=>{ e.stopPropagation(); toggleNode(childrenEl,toggleEl); });
    }
    // Clicking the dot/name/acronym area navigates the atlas (like search)
    dotEl.addEventListener('click', e=>{ e.stopPropagation(); selectTreeNode(node); });
    nameEl.addEventListener('click', e=>{ e.stopPropagation(); selectTreeNode(node); });
    acroEl.addEventListener('click', e=>{ e.stopPropagation(); selectTreeNode(node); });
    // Clicking the row background still expands if it has children
    rowEl.addEventListener('click', ()=>{ if(hasChildren) toggleNode(childrenEl,toggleEl); });
    parentEl.appendChild(nodeEl);
    _allTreeRows.push({node,rowEl,childrenEl,toggleEl,depth});
  }
  for(const root of roots) buildNode(root,ontologyTreeEl,0);
}

function toggleNode(childrenEl,toggleEl,forceOpen){
  const isOpen=!childrenEl.classList.contains('closed');
  if(forceOpen===true&&!isOpen) return;
  if(isOpen){ childrenEl.classList.add('closed'); childrenEl.style.maxHeight='0'; toggleEl.textContent='+'; }
  else{ childrenEl.classList.remove('closed'); childrenEl.style.maxHeight=childrenEl.scrollHeight+2000+'px'; toggleEl.textContent='−'; }
}

// ── Tree node rate limiter ────────────────────────────────────────────────────
let _treeLastKey   = null;   // label+acro of last successfully loaded node
let _treePending   = false;  // true while a selectTreeNode fetch is in-flight
const _treeRapid   = {};     // key -> rapid-click count for warning tracking

export async function selectTreeNode(node){
  const label = node.name||node.acronym||'';
  const acro  = node.acronym||'';
  if(!label) return;

  // Sync the 3D view immediately — we already have the numeric Allen id from
  // the ontology node, no need to wait for 2D highlight + updatePanel.
  if (window.brain3d && node.id) {
    const color = node._color || ('#' + (node.color_hex_triplet || 'ffb74a'));
    window.brain3d.showRegion(node.id, { acronym: acro, name: node.name || label, color });
  }

  const key = `${label}||${acro}`;

  // Same node as last successfully loaded — track as rapid click
  if(key === _treeLastKey){
    if(!_treeRapid[key]) _treeRapid[key] = 0;
    _treeRapid[key]++;
    // Fire warning ONCE at threshold only
    if(_treeRapid[key] === _RAPID_THRESH) {
      _sendWarning('hierarchy click', label, _treeRapid[key]);
    }
    setStatus(`"${label}" — already loaded`,'ok');
    return;
  }

  // A request is already in-flight — drop this click, wait for current to finish
  if(_treePending){
    if(!_treeRapid[key]) _treeRapid[key] = 0;
    _treeRapid[key]++;
    // Fire warning ONCE at threshold only
    if(_treeRapid[key] === _RAPID_THRESH) {
      _sendWarning('hierarchy click', label, _treeRapid[key]);
    }
    return;
  }
  _treeRapid[key] = 0;  // reset counter when request actually goes through

  _treePending = true;
  highlightTreeByAcronym(acro||label);

  try {
    const hasChildren = node.children && node.children.length > 0;

    // -- LEAF ----------------------------------------------------------------
    if(!hasChildren){
      setStatus(`Looking up "${label}"...`);
      let results=[];
      try{
        const res=await fetch(`${API}/api/search?q=${encodeURIComponent(acro||label)}&limit=20`);
        const d=await res.json(); results=d.results||[];
      }catch(e){ setStatus('Lookup error: '+e.message,'error'); return; }
      const nameLo=label.toLowerCase(), acroLo=acro.toLowerCase();
      const leaf=results.find(x=>!x.is_group&&
        ((x.matched_label||'').toLowerCase()===nameLo||(x.matched_acronym||'').toLowerCase()===acroLo));
      if(leaf){
        _treeLastKey = key;
        await selectSearchResult(document.createElement('div'),leaf);
        return;
      }
      setStatus(`"${label}" — no 2D data`,'error');
      showNoVoxelNote(label);
      if(window.notifyChatRegion) window.notifyChatRegion(label,{parcellation_index:null,structure:label,acronym:acro,_unavailable:true});
      _treeLastKey = null;
      return;
    }

    // -- GROUP: use ABC parcellation_term tree --------------------------------
    setStatus(`Resolving "${label}" from ABC term tree...`);
    let idxList=[], termName=label;
    try{
      const res=await fetch(`${API}/api/group_by_term`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:label,acronym:acro})});
      const d=await res.json();
      if(!d.error){ idxList=d.parcellation_indices||[]; termName=d.name||label; }
    }catch(e){}

    if(!idxList.length){
      setStatus(`"${label}" — no 2D data`,'error');
      showNoVoxelNote(label);
      if(window.notifyChatRegion) window.notifyChatRegion(label,{parcellation_index:null,structure:label,_unavailable:true});
      _treeLastKey = null;
      return;
    }

    setStatus(`Finding centroid for ${idxList.length} regions...`);
    const cRes=await fetch(`${API}/api/region_center_indices`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parcellation_indices:idxList})});
    const cData=await cRes.json();
    if(cData.error){ setStatus(`"${label}" — ${cData.error}`,'error'); _treeLastKey=null; return; }
    const{xi,yi,zi}=cData;
    setSuppressSliderReload(true);
    Object.keys(views).forEach(v=>{
      const newIdx={sagittal:xi,coronal:zi,transverse:yi}[v];
      views[v].idx=newIdx; views[v].slider.value=newIdx; views[v].idxDisp.textContent=newIdx;
      views[v].marker.style.display='none';
      views[v].ctx.clearRect(0,0,views[v].canvas.width,views[v].canvas.height);
      if (window.brain3d?.setSlice) {
        window.brain3d.setSlice(v, newIdx, parseInt(views[v].slider.max), parseInt(views[v].slider.min));
      }
    });
    setSuppressSliderReload(false);
    setLastParcIdx(null);
    setLastHighlight({type:'group_indices', indices:idxList});

    // Populate the inspector for the group. No single parcellation_index to
    // pin colors/metadata on, so we pass through whatever we have from the
    // ontology node and let updatePanel fire /api/enrich against the group
    // name for Functional Summary / Keywords / Related Regions.
    const groupPanelData = {
      parcellation_index: null,
      xi, yi, zi,
      organ:        '—',
      category:     '—',
      division:     (node && (node.name || '')) || termName,
      structure:    termName,
      substructure: '—',
      matched_label:   termName,
      matched_acronym: acro || (node && node.acronym) || '—',
      region_summary:      '',
      functional_keywords: [],
      related_regions:     [],
    };
    updatePanel(groupPanelData);

    setStatus('Loading all views...');
    await Promise.all(Object.keys(views).map(v=>loadSliceP(v)));
    setStatus('Highlighting group...');
    await Promise.all(Object.keys(views).map(async v=>{
      const s=views[v];
      const myGen=s.generation;   // see drawHighlight's expectedGen param in sliceViewer.js
      const res=await fetch(`${API}/api/highlight_indices`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view:v,idx:s.idx,parcellation_indices:idxList})});
      const hData=await res.json();
      if(hData.mask) await drawHighlight(v,hData.mask,myGen);
    }));
    for(const vv of['sagittal','coronal','transverse']){const sv=views[vv];if(sv.lastMask){syncCanvas(vv);await new Promise(res=>{const mi=new Image();mi.onload=()=>{sv.ctx.clearRect(0,0,sv.canvas.width,sv.canvas.height);sv.ctx.drawImage(mi,0,0,sv.canvas.width,sv.canvas.height);res();};mi.onerror=()=>res();mi.src=sv.lastMask;});}}
    _treeLastKey = key;
    setStatus(`"${termName}" — ${idxList.length} regions · ${cData.voxel_count?.toLocaleString()||'?'} voxels`,'ok');
    if(window.notifyChatRegion) window.notifyChatRegion(termName,{parcellation_index:null,structure:termName,xi,yi,zi});

  } catch(err) {
    _treeLastKey = null;
    setStatus('Error: '+err.message,'error');
  } finally {
    // Always release the lock — guaranteed even if an early return throws
    _treePending = false;
  }
}

export function highlightTreeByAcronym(acronym){
  if(!acronym||!_allTreeRows.length) return;
  const target=acronym.trim().toLowerCase();
  const entry=_allTreeRows.find(e=>(e.node.acronym||'').toLowerCase()===target)||_allTreeRows.find(e=>(e.node.name||'').toLowerCase()===target);
  if(!entry) return;
  if(_activeRowEl){ _activeRowEl.classList.remove('hl-active'); _allTreeRows.forEach(e=>e.rowEl.classList.remove('hl-ancestor')); }
  entry.rowEl.classList.add('hl-active'); setActiveRowEl(entry.rowEl);
  const targetId=entry.node.id; const ancestorIds=new Set();
  function findAncestors(nodes,childId){ for(const n of nodes){ if(n.id===childId) return true; if(n.children&&n.children.length){ if(findAncestors(n.children,childId)){ ancestorIds.add(n.id); return true; } } } return false; }
  findAncestors(_ontologyRoots,targetId);
  _allTreeRows.forEach(e=>{ if(ancestorIds.has(e.node.id)){ e.rowEl.classList.add('hl-ancestor'); if(e.childrenEl){ e.childrenEl.classList.remove('closed'); e.childrenEl.style.maxHeight=e.childrenEl.scrollHeight+2000+'px'; e.toggleEl.textContent='−'; } } });
  setTimeout(()=>entry.rowEl.scrollIntoView({behavior:'smooth',block:'nearest'}),60);
}

(function(){
  const hint = document.getElementById('ontology-search-hint');
  let _debounceTimer = null;

  // -- Dropdown list rendered above the tree --------------------------------
  const dropdown = document.createElement('div');
  dropdown.id = 'ontology-dropdown';
  dropdown.className = 'ontology-dropdown';
  dropdown.style.display = 'none';
  document.body.appendChild(dropdown);

  function clearDropdown(){
    dropdown.innerHTML = '';
    dropdown.style.display = 'none';
    hint.textContent = '';
  }

  function showDropdown(q){
    if(!q || !_allTreeRows.length){ clearDropdown(); return; }
    const qLo = q.toLowerCase();
    const matches = [];
    for(const e of _allTreeRows){
      const name  = (e.node.name   || '').toLowerCase();
      const acro  = (e.node.acronym|| '').toLowerCase();
      const acroHit      = acro === qLo || acro.startsWith(qLo);
      const nameStartHit = name.startsWith(qLo);
      if(acroHit || nameStartHit) matches.push(e);
      if(matches.length >= 30) break;
    }

    if(!matches.length){
      hint.textContent = 'No matches';
      hint.style.color = 'var(--warm)';
      dropdown.style.display = 'none';
      return;
    }

    hint.textContent = matches.length+(matches.length===30?'+ ':' ')+'match'+(matches.length!==1?'es':'');
    hint.style.color = 'var(--text-dim)';

    // Position fixed below the input
    const rect = ontologySearchEl.getBoundingClientRect();
    dropdown.style.top   = (rect.bottom + 2) + 'px';
    dropdown.style.left  = rect.left + 'px';
    dropdown.style.width = rect.width + 'px';

    dropdown.innerHTML = '';
    matches.forEach(e=>{
      const item = document.createElement('div');
      item.className = 'ontology-dd-item'+(e.node._available===false?' unavailable':'');
      if(e.node._available===false) item.title='No voxels in the CCFv3 annotation volume -- the 2D views won\'t show this structure, though the 3D view may still show an approximate parent shape';
      const color = e.node._color || ('#'+(e.node.color_hex_triplet||'445a72'));
      const acro  = e.node.acronym ? `<span class="ontology-dd-acro">${e.node.acronym}</span>` : '';
      item.innerHTML = `<span class="ontology-dd-dot" style="background:${color}"></span><span class="ontology-dd-name">${e.node.name||''}</span>${acro}`;
      item.addEventListener('mousedown', ev=>{
        ev.preventDefault();
        ontologySearchEl.value = '';
        clearDropdown();
        selectTreeNode(e.node);
      });
      dropdown.appendChild(item);
    });

    // Add scroll hint only when content actually overflows
    if(matches.length >= 8){
      const hint = document.createElement('div');
      hint.className = 'ontology-dd-scroll-hint';
      hint.textContent = 'scroll for more';
      dropdown.appendChild(hint);
      // Check after render if it actually overflows, hide if not
      requestAnimationFrame(()=>{
        if(dropdown.scrollHeight <= dropdown.clientHeight) hint.style.display='none';
        dropdown.addEventListener('scroll', ()=>{ if(dropdown.scrollTop>10) hint.style.display='none'; }, {once:true});
      });
    }
    dropdown.style.display = 'block';
  }

  ontologySearchEl.addEventListener('input', ()=>{
    const q = ontologySearchEl.value.trim();
    if(!q){ clearDropdown(); hint.textContent=''; return; }
    hint.textContent = 'Searching...'; hint.style.color = 'var(--text-dim)';
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(()=>showDropdown(q), 300);
  });

  ontologySearchEl.addEventListener('blur', ()=>{
    // Small delay so mousedown on item fires first
    setTimeout(clearDropdown, 150);
  });

  ontologySearchEl.addEventListener('keydown', e=>{
    if(e.key==='Escape'){ ontologySearchEl.value=''; clearDropdown(); ontologySearchEl.blur(); }
    if(e.key==='Enter'){
      const first = dropdown.querySelector('.ontology-dd-item');
      if(first) first.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    }
  });
})();

// Anchors the #ontology-dropdown under the search input on every animation
// frame (originally lived next to the near-identical search-panel version of
// this pattern; moved here since it's this module's dropdown). Runs
// continuously rather than only on resize/scroll, same as the original.
export function positionOntologyDropdown(){
  const el=document.getElementById('ontology-search');
  const dd=document.getElementById('ontology-dropdown');
  if(!el||!dd||dd.style.display==='none') return;
  const rect=el.getBoundingClientRect();
  dd.style.top=(rect.bottom+2)+'px';
  dd.style.left=rect.left+'px';
  dd.style.width=rect.width+'px';
}
(function(){
  function _trackOntoDd(){
    positionOntologyDropdown();
    requestAnimationFrame(_trackOntoDd);
  }
  _trackOntoDd();
})();

loadOntology();
