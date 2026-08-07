// The region search box: the dropdown of matching results (combining
// results from the server with a quick check against the region tree
// already loaded in the browser), and what happens when you pick a result —
// updates the 2D/3D views and the info panel. Also used directly by the
// "related region" buttons in inspectorPanel.js and by picking a region in
// ontology.js's tree.
//
// Note: this file, ontology.js, and inspectorPanel.js each use things from
// the others — see the note at the top of lookup.js for why that's fine.
import { API } from './config.js';
import {
  views, highlightLevel, _allTreeRows,
  setSuppressSliderReload, setLastParcIdx, setLastHighlight,
} from './state.js';
import { setStatus } from './statusBar.js';
import { loadSliceP, drawHighlight, syncCanvas, fetchAndDrawHighlight, showNoVoxelNote } from './sliceViewer.js';
import { updatePanel, syncThreeD } from './inspectorPanel.js';
import { selectTreeNode, highlightTreeByAcronym } from './ontology.js';

const searchInput=document.getElementById('search-input'),searchClear=document.getElementById('search-clear'),searchStatus=document.getElementById('search-status');
let searchTimer=null, activeSearchItem=null;

// Cap on how many rows the dropdown ever renders, matching the server's
// own `limit=50` in the /api/search call below -- see the comment at the
// merged-results slice in runSearch for why this is needed even though the
// server already caps its own results.
const MAX_DROPDOWN_RESULTS = 50;

// Fixed dropdown for search results
const searchDropdown=document.createElement('div');
searchDropdown.id='search-dropdown';
searchDropdown.className='search-dropdown';
searchDropdown.style.display='none';
document.body.appendChild(searchDropdown);

function clearSearchDropdown(){
  searchDropdown.innerHTML=''; searchDropdown.style.display='none';
  searchStatus.textContent=''; searchStatus.className='search-status';
  activeSearchItem=null;
}

function positionSearchDropdown(){
  const rect=searchInput.getBoundingClientRect();
  searchDropdown.style.top=(rect.bottom+2)+'px';
  searchDropdown.style.left=rect.left+'px';
  searchDropdown.style.width=rect.width+'px';
}

// Keep dropdown anchored continuously whenever it is visible
(function(){
  let _rafId=null;
  function _trackDropdown(){
    if(searchDropdown.style.display!=='none') positionSearchDropdown();
    _rafId=requestAnimationFrame(_trackDropdown);
  }
  _trackDropdown();
})();

searchInput.addEventListener('input',()=>{
  const q=searchInput.value.trim(); searchClear.style.display=q?'block':'none';
  clearTimeout(searchTimer);
  if(!q){ clearSearchDropdown(); return; }
  searchStatus.textContent='Searching...'; searchStatus.className='search-status';
  searchTimer=setTimeout(()=>runSearch(q),280);
});
searchClear.addEventListener('click',()=>{
  searchInput.value=''; searchClear.style.display='none';
  clearSearchDropdown(); searchInput.focus();
});
searchInput.addEventListener('blur',()=>{ setTimeout(clearSearchDropdown,150); });

export async function runSearch(q){
  try{
    const res=await fetch(`${API}/api/search?q=${encodeURIComponent(q)}&limit=50`);
    const data=await res.json();
    searchDropdown.innerHTML=''; activeSearchItem=null;

    // -- Also search the Allen ontology tree in memory ---------------------
    const qLo=q.toLowerCase();
    const ontologyExtras=[];
    if(_allTreeRows.length){
      const seen=new Set((data.results||[]).map(r=>(r.matched_label||'').toLowerCase()));
      for(const {node} of _allTreeRows){
        const name=(node.name||'').toLowerCase();
        const acro=(node.acronym||'').toLowerCase();
        const nameHit = name.startsWith(qLo);
        const acroHit = acro===qLo||acro.startsWith(qLo);
        if((nameHit||acroHit) && !seen.has(name)){
          seen.add(name);
          ontologyExtras.push({
            _ontologyOnly: true,
            _hasChildren: !!(node.children && node.children.length > 0),
            matched_label: node.name,
            matched_acronym: node.acronym||'',
            structure_color: node._color||('#'+(node.color_hex_triplet||'445a72')),
            node,
          });
        }
      }
    }

    // Sort: available regions first, unavailable/ontology-only last
    const allResults=[...(data.results||[]),...ontologyExtras].sort((a,b)=>{
      const aUnavail = (a.no_voxels || (a._ontologyOnly && !a._hasChildren)) ? 1 : 0;
      const bUnavail = (b.no_voxels || (b._ontologyOnly && !b._hasChildren)) ? 1 : 0;
      return aUnavail - bUnavail;
    });
    if(allResults.length===0){
      searchStatus.textContent='No regions found for "'+q+'"';
      searchStatus.className='search-status none';
      searchDropdown.style.display='none'; return;
    }
    // The server already caps its own results to 50, but ontologyExtras
    // above has no limit of its own -- for a broad query (a single letter
    // matches hundreds of ontology tree nodes across every level, not just
    // leaves) that could mean rendering hundreds of dropdown rows. Capping
    // the merged, sorted list here keeps the dropdown to a sane size no
    // matter how broad the query is.
    const shownResults=allResults.slice(0,MAX_DROPDOWN_RESULTS);
    searchStatus.textContent=allResults.length+' result'+(allResults.length>1?'s':'')+' found'
      +(allResults.length>shownResults.length?` (showing top ${shownResults.length})`:'');
    searchStatus.className='search-status found';

    shownResults.forEach(r=>{
      const item=document.createElement('div'); item.className='search-result-item'; item.dataset.parcIdx=r.parcellation_index||'';
      const label=r.matched_label||(r.structure!=='--'?r.structure:(r.division!=='--'?r.division:r.category));
      const acro=r.matched_acronym||r.structure_acronym||r.division_acronym||r.category_acronym||'';
      const acroBadge=acro?`<span class="sr-acro">${acro}</span>`:'';

      if(r._ontologyOnly && !r._hasChildren){
        // Truly absent from atlas -- greyed out, AI-only
        item.classList.add('unavailable');
        item.innerHTML=`<div class="sr-dot" style="background:${r.structure_color}"></div><div class="sr-text"><div class="sr-name">${label}${acroBadge}</div><div class="sr-unavail">(!) Not in CCFv3 annotation volume</div></div>`;
        item.addEventListener('mousedown',ev=>{ ev.preventDefault();
          document.querySelectorAll('.search-result-item').forEach(i=>i.classList.remove('active'));
          item.classList.add('active');
          document.getElementById('r-idx').textContent='N/A';
          document.getElementById('r-struct').textContent=label; document.getElementById('r-struct').classList.remove('placeholder');
          document.getElementById('r-acro').textContent=acro||'--';
          setStatus(`"${label}" — no 2D data`,'error');
          showNoVoxelNote(label);
          highlightTreeByAcronym(acro||label);
          if(window.notifyChatRegion) window.notifyChatRegion(label,{parcellation_index:null,structure:label,acronym:acro,_unavailable:true});
          searchInput.value=''; clearSearchDropdown();
        });
      } else if(r._ontologyOnly && r._hasChildren){
        // Has children -- use selectTreeNode which resolves leaf descendants
        item.innerHTML=`<div class="sr-dot" style="background:${r.structure_color}"></div><div class="sr-text"><div class="sr-name">${label}${acroBadge}</div></div>`;
        item.addEventListener('mousedown',ev=>{ ev.preventDefault(); searchInput.value=''; clearSearchDropdown(); selectTreeNode(r.node); });
      } else if(r.is_group){
        item.innerHTML=`<div class="sr-dot" style="background:${r.structure_color}"></div><div class="sr-text"><div class="sr-name">${label}${acroBadge}</div><div class="sr-sub"><span class="sr-group-count">${r.member_count} regions</span></div></div>`;
        item.addEventListener('mousedown',ev=>{ ev.preventDefault(); searchInput.value=''; clearSearchDropdown(); selectSearchResult(item,r); });
      } else {
        item.innerHTML=`<div class="sr-dot" style="background:${r.structure_color}"></div><div class="sr-text"><div class="sr-name">${label}${acroBadge}</div></div>`;
        item.addEventListener('mousedown',ev=>{ ev.preventDefault(); searchInput.value=''; clearSearchDropdown(); selectSearchResult(item,r); });
      }
      searchDropdown.appendChild(item);
    });

    // Scroll hint
    if(shownResults.length>=8){
      const hint=document.createElement('div'); hint.className='ontology-dd-scroll-hint'; hint.textContent='scroll for more';
      searchDropdown.appendChild(hint);
      requestAnimationFrame(()=>{
        if(searchDropdown.scrollHeight<=searchDropdown.clientHeight) hint.style.display='none';
        searchDropdown.addEventListener('scroll',()=>{ if(searchDropdown.scrollTop>10) hint.style.display='none'; },{once:true});
      });
    }

    positionSearchDropdown();
    searchDropdown.style.display='block';
  } catch(err){ searchStatus.textContent='Search error: '+err.message; searchStatus.className='search-status none'; }
}

export async function selectSearchResult(item,r){
  document.querySelectorAll('.search-result-item').forEach(i=>i.classList.remove('active'));
  item.classList.add('active'); activeSearchItem=r;
  const label=r.matched_label||(r.structure!=='--'?r.structure:(r.division!=='--'?r.division:r.category));

  // Sync 3D view — resolves this name/acronym to a structure id via ontology tree
  syncThreeD({ name: label, acronym: r.matched_acronym || r.group_acronym || '', data: r });

  // -- GROUP path ------------------------------------------------------------
  if(r.is_group){
    setStatus(`Finding centroid for group "${label}"...`);
    try{
      // Term-tree groups use group_by_term + highlight_indices
      if(r.group_level==='term'){
        const gtRes=await fetch(`${API}/api/group_by_term`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:r.group_name,acronym:r.group_acronym})});
        const gtData=await gtRes.json();
        if(gtData.error){ setStatus(`"${label}" -- ${gtData.error}`,'error'); return; }
        const idxList=gtData.parcellation_indices||[];
        const cRes=await fetch(`${API}/api/region_center_indices`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parcellation_indices:idxList})});
        const cData=await cRes.json();
        if(cData.error){ setStatus(`"${label}" -- ${cData.error}`,'error'); return; }
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

        // Drive the full inspector via updatePanel so enrichment fires for
        // the group. No single parcellation_index for a group, so we synthesize
        // a minimal panel payload with the group's own name/acronym.
        updatePanel({
          parcellation_index: null,
          xi, yi, zi,
          organ: '—', category: '—', division: '—',
          structure: label, substructure: '—',
          matched_label: label,
          matched_acronym: r.group_acronym || '—',
          region_summary: '',
          functional_keywords: [],
          related_regions: [],
        });
        document.getElementById('r-idx').textContent='(group)';

        setStatus('Loading all views...');
        await Promise.all(Object.keys(views).map(v=>loadSliceP(v)));
        setStatus('Highlighting group...');
        await Promise.all(Object.keys(views).map(async v=>{
          const s=views[v];
          const myGen=s.generation;   // see drawHighlight's expectedGen param
          const res=await fetch(`${API}/api/highlight_indices`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view:v,idx:s.idx,parcellation_indices:idxList})});
          const hData=await res.json(); if(hData.mask) await drawHighlight(v,hData.mask,myGen);
        }));
        for(const vv of['sagittal','coronal','transverse']){const sv=views[vv];if(sv.lastMask){syncCanvas(vv);await new Promise(res=>{const mi=new Image();mi.onload=()=>{sv.ctx.clearRect(0,0,sv.canvas.width,sv.canvas.height);sv.ctx.drawImage(mi,0,0,sv.canvas.width,sv.canvas.height);res();};mi.onerror=()=>res();mi.src=sv.lastMask;});}}
        setStatus(`"${label}" -- ${idxList.length} regions . ${cData.voxel_count?.toLocaleString()||'?'} voxels`,'ok');
        return;
      }
      const cRes=await fetch(`${API}/api/region_center_group`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group_level:r.group_level,group_name:r.group_name})});
      const cData=await cRes.json();
      if(cData.error){
        item.classList.add('unavailable');
        const unavailNote=document.createElement('div'); unavailNote.className='sr-unavail'; unavailNote.textContent='(!) Region not found in annotation volume';
        item.querySelector('.sr-text').appendChild(unavailNote);
        setStatus(`"${label}" — no 2D data`,'error');
        showNoVoxelNote(label);
        return;
      }
      const{xi,yi,zi}=cData;
      const VIEW_IDX={sagittal:xi,coronal:zi,transverse:yi};
      setSuppressSliderReload(true);
      Object.keys(views).forEach(v=>{
        const newIdx=VIEW_IDX[v];
        views[v].idx=newIdx; views[v].slider.value=newIdx; views[v].idxDisp.textContent=newIdx;
        views[v].marker.style.display='none';
        views[v].ctx.clearRect(0,0,views[v].canvas.width,views[v].canvas.height);
        if (window.brain3d?.setSlice) {
          window.brain3d.setSlice(v, newIdx, parseInt(views[v].slider.max), parseInt(views[v].slider.min));
        }
      });
      setSuppressSliderReload(false);
      setLastParcIdx(null);   // no single index for a group
      setLastHighlight({type:'group_level', group_level:r.group_level, group_name:r.group_name});

      // Same inspector-via-updatePanel treatment as the term-tree group above.
      updatePanel({
        parcellation_index: null,
        xi, yi, zi,
        organ: '—', category: '—', division: '—',
        structure: label, substructure: '—',
        matched_label: label,
        matched_acronym: r.group_acronym || r.matched_acronym || '—',
        region_summary: '',
        functional_keywords: [],
        related_regions: [],
      });
      document.getElementById('r-idx').textContent='(group)';

      setStatus('Loading all views...');
      await Promise.all(Object.keys(views).map(v=>loadSliceP(v)));
      setStatus('Highlighting group...');
      await Promise.all(Object.keys(views).map(async v=>{
        const s=views[v];
        const myGen=s.generation;   // see drawHighlight's expectedGen param
        try{
          const res=await fetch(`${API}/api/highlight_group`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view:v,idx:s.idx,group_level:r.group_level,group_name:r.group_name})});
          const hData=await res.json();
          if(hData.mask) await drawHighlight(v,hData.mask,myGen);
        } catch(e){ console.error('[group highlight]',e); }
      }));
      for(const vv of['sagittal','coronal','transverse']){
        const sv=views[vv];
        if(sv.lastMask){ syncCanvas(vv); await new Promise(res=>{ const mi=new Image(); mi.onload=()=>{ sv.ctx.clearRect(0,0,sv.canvas.width,sv.canvas.height); sv.ctx.drawImage(mi,0,0,sv.canvas.width,sv.canvas.height); res(); }; mi.onerror=()=>res(); mi.src=sv.lastMask; }); }
      }
      setStatus(`"${label}" (${r.group_level} group) -- ${cData.member_count} regions . ${cData.voxel_count?.toLocaleString()||'?'} voxels`,'ok');
      if(window.notifyChatRegion) window.notifyChatRegion(label,{parcellation_index:null,division:r.group_level==='division'?label:'',structure:label,xi,yi,zi});
    } catch(err){ setStatus('Group navigation error: '+err.message,'error'); }
    return;
  }
  setStatus(`Finding centroid for "${label}"...`);
  try{
    const cRes=await fetch(`${API}/api/region_center`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parcellation_index:r.parcellation_index})});
    const cData=await cRes.json();
    if(cData.error){
      // Region exists in the atlas metadata but has no voxels -- grey it out
      item.classList.add('unavailable');
      const unavailNote=document.createElement('div'); unavailNote.className='sr-unavail'; unavailNote.textContent='(!) Region not found in annotation volume';
      item.querySelector('.sr-text').appendChild(unavailNote);
      setStatus(`"${label}" — no 2D data`,'error');
      showNoVoxelNote(label);
      return;
    }
    const{xi,yi,zi}=cData;
    const VIEW_IDX={sagittal:xi,coronal:zi,transverse:yi};
    setSuppressSliderReload(true);
    Object.keys(views).forEach(v=>{
      const newIdx=VIEW_IDX[v];
      views[v].idx=newIdx; views[v].slider.value=newIdx; views[v].idxDisp.textContent=newIdx;
      views[v].marker.style.display='none';
      views[v].ctx.clearRect(0,0,views[v].canvas.width,views[v].canvas.height);
      // Drive the 3D slice planes too — otherwise they stay at their previous
      // positions even though the 2D sliders and highlights jumped to the
      // search hit. setSlice() is a no-op if brain3d isn't wired up yet.
      if (window.brain3d?.setSlice) {
        window.brain3d.setSlice(v, newIdx, parseInt(views[v].slider.max), parseInt(views[v].slider.min));
      }
    });
    setSuppressSliderReload(false);
    setLastParcIdx(r.parcellation_index);
    setLastHighlight({type:'single', parcIdx:r.parcellation_index, level:highlightLevel});

    // Drive the whole side panel through updatePanel so the Functional
    // Summary / Keywords / Related Regions blocks render their "Loading…"
    // placeholders and fire /api/enrich in the background, same as for 2D
    // clicks. Without this call the inspector only shows the name/acronym
    // and the AI sections stay stuck on whatever the previous click left.
    const panelData = {
      parcellation_index: r.parcellation_index,
      xi, yi, zi,
      organ:        cData.organ        || r.organ        || '—',
      category:     cData.category     || r.category     || '—',
      division:     cData.division     || r.division     || '—',
      structure:    cData.structure    || r.structure    || '—',
      substructure: cData.substructure || r.substructure || '—',
      organ_acronym:        cData.organ_acronym        || r.organ_acronym        || '',
      category_acronym:     cData.category_acronym     || r.category_acronym     || '',
      division_acronym:     cData.division_acronym     || r.division_acronym     || '',
      structure_acronym:    cData.structure_acronym    || r.structure_acronym    || '',
      substructure_acronym: cData.substructure_acronym || r.substructure_acronym || '',
      matched_label:   r.matched_label   || r.structure || '—',
      matched_acronym: r.matched_acronym || cData.substructure_acronym || cData.structure_acronym || '—',
      // Per-level colors for the swatches
      organ_color:        cData.organ_color,
      category_color:     cData.category_color,
      division_color:     cData.division_color,
      structure_color:    cData.structure_color,
      substructure_color: cData.substructure_color,
      // Enrichment fields — /api/region_center doesn't return these, so they
      // start empty and updatePanel() will auto-fire /api/enrich to fill them.
      region_summary:      '',
      functional_keywords: [],
      related_regions:     [],
    };
    updatePanel(panelData);

    setStatus('Loading all views...');
    await Promise.all(Object.keys(views).map(v=>loadSliceP(v)));
    setStatus('Highlighting all views...');
    await Promise.all(Object.keys(views).map(v=>fetchAndDrawHighlight(v,r.parcellation_index,highlightLevel)));
    for(const vv of['sagittal','coronal','transverse']){
      const sv=views[vv];
      if(sv.lastMask){ syncCanvas(vv); await new Promise(res=>{ const mi=new Image(); mi.onload=()=>{ sv.ctx.clearRect(0,0,sv.canvas.width,sv.canvas.height); sv.ctx.drawImage(mi,0,0,sv.canvas.width,sv.canvas.height); res(); }; mi.onerror=()=>res(); mi.src=sv.lastMask; }); }
    }
    setStatus(`"${label}" -- xi=${xi} yi=${yi} zi=${zi} . ${cData.voxel_count?.toLocaleString()||'?'} voxels`,'ok');
    if(window.notifyChatRegion) window.notifyChatRegion(label,{parcellation_index:r.parcellation_index,organ:cData.organ||r.organ,category:cData.category||r.category,division:cData.division||r.division,structure:cData.structure||r.structure,substructure:cData.substructure||r.substructure,xi,yi,zi});
  } catch(err){ setStatus('Search navigation error: '+err.message,'error'); }
}
