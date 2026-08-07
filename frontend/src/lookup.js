// These functions take a click (or a saved ID) and figure out which brain
// region it belongs to. Some of them end with `window.resolveX = resolveX`
// because the 3D viewer file (threeViewer.js) needs to call these too — this
// is how the two separate files reach each other.
//
// Note: this file and sliceViewer.js each use things from the other one.
// Normally that's something to avoid, but it's fine here — none of those
// calls actually happen until the user clicks or types something, and by
// then every file has already finished loading anyway.
import { API } from './config.js';
import {
  views, highlightLevel,
  setLastLookupData, setLastParcIdx, setLastHighlight, setSuppressSliderReload,
} from './state.js';
import { setStatus } from './statusBar.js';
import { _clickPending, _clickCache } from './rateLimiter.js';
import { updatePanel } from './inspectorPanel.js';
import { loadSliceP, fetchAndDrawHighlight, hideNoVoxelNote } from './sliceViewer.js';

// Resolve a (view, col, row) click into a region: calls the backend lookup,
// updates the info panel, syncs other slice indices, draws highlights, and
// notifies chat. Shared by both 2D canvas clicks and 3D plane clicks.
// opts.skipSync = true leaves all slider positions alone (used by 3D clicks).
export async function resolveLookup(v, col, row, opts = {}){
  const s = views[v];
  if (_clickPending[v]) return;
  _clickPending[v] = true;
  try {
    // The 2D click path supplies s.idx (current slider). The 3D click path
    // passes its own idx via opts.idxOverride because its atlas slice may
    // differ from wherever the 2D slider is currently parked.
    const lookupIdx = (opts.idxOverride != null) ? opts.idxOverride : s.idx;
    setStatus(`Querying ${v} view -- col=${col} row=${row}...`);
    const res = await fetch(`${API}/api/lookup`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({view:v, idx:lookupIdx, col, row}),
    });
    const data = await res.json();
    if (data.error && !data.parcellation_index){ setStatus('Lookup error: '+data.error,'error'); return; }

    // A successful click always has voxels right where you clicked, by
    // definition -- so any stale "no voxels here" note can go now. This
    // can't rely on loadSlice doing it (like every other navigation path):
    // the clicked view's own picture already shows the right slice, so
    // loadSlice deliberately never reloads it (see viewsToSync below) --
    // meaning a note left over on THIS specific view from an earlier
    // unrelated unavailable-region click would otherwise never clear,
    // even though the other two views (which do call loadSlice, to sync
    // their position) correctly clear theirs.
    hideNoVoxelNote();

    _clickCache[v] = { col, row, sliceIdx:lookupIdx, parcIdx:data.parcellation_index, data };
    if (!opts.skipSync) {
      Object.keys(views).forEach(ov=>{ if(ov!==v) delete _clickCache[ov]; });
    }

    setLastLookupData(data); setLastParcIdx(data.parcellation_index);
    setLastHighlight({type:'single', parcIdx:data.parcellation_index, level:highlightLevel});
    updatePanel(data);

    if (!opts.skipSync) {
      const VIEW_IDX_FROM_WORLD = {sagittal:data.xi, coronal:data.zi, transverse:data.yi};
      // 2D click path: move only the OTHER two views (the clicked view is
      // already showing the right slice).
      // 3D click path (opts.syncAll): move all three views, because the
      // click happened on a 3D plane that may not match any 2D slider's
      // current position.
      const viewsToSync = opts.syncAll
        ? Object.keys(views)
        : Object.keys(views).filter(ov=>ov!==v);
      setStatus(`Syncing views to xi=${data.xi} yi=${data.yi} zi=${data.zi} ...`);
      setSuppressSliderReload(true);
      viewsToSync.forEach(ov=>{
        const os = views[ov]; const newIdx = VIEW_IDX_FROM_WORLD[ov];
        if (newIdx == null) return;
        os.idx = newIdx; os.slider.value = newIdx; os.idxDisp.textContent = newIdx;
        os.marker.style.display = 'none';
        if (window.brain3d?.setSlice) window.brain3d.setSlice(ov, newIdx, parseInt(os.slider.max), parseInt(os.slider.min));
      });
      setSuppressSliderReload(false);
      await Promise.all(viewsToSync.map(ov=>loadSliceP(ov)));
    }
    await Promise.all(Object.keys(views).map(vv=>fetchAndDrawHighlight(vv,data.parcellation_index,highlightLevel)));
    setStatus(`${data.matched_label||data.structure||'parcellation '+data.parcellation_index} -- xi=${data.xi} yi=${data.yi} zi=${data.zi}${opts.skipSync ? '' : ' . all views synced'}`,'ok');

    if (window.notifyChatRegion){
      const regionName = data.matched_label ||
        [data.substructure, data.structure, data.division, data.category]
          .find(x => x && x !== '—' && x !== '--') ||
        'Region '+data.parcellation_index;
      const regionAcro = data.matched_acronym ||
        [data.substructure_acronym, data.structure_acronym,
         data.division_acronym, data.category_acronym, data.acronym]
          .find(x => x && x !== '—' && x !== '--') || '';
      window.notifyChatRegion(regionName, {...data, structure: regionName, acronym: regionAcro});
    }
  } catch(err){ setStatus('Lookup failed: '+err.message,'error'); }
  finally{ _clickPending[v] = false; }
}
window.resolveLookup = resolveLookup; // called by the 3D plane raycast handler

// 3D volume-sample path: caller already has a parcellation_index from sampling
// the volume texture in JS. Fetch metadata + highlight + load mesh, skipping
// the (view, col, row) coordinate dance.
export async function resolveParcellation(pidx){
  if (!pidx) return;
  try {
    setStatus(`Resolving parcellation ${pidx}...`);
    const res = await fetch(`${API}/api/resolve_parcellation?pidx=${pidx}`);
    if (!res.ok) { setStatus(`resolve HTTP ${res.status}`,'error'); return; }
    const data = await res.json();
    if (data.error && !data.parcellation_index){ setStatus('Resolve error: '+data.error,'error'); return; }

    // See the matching comment in resolveLookup above -- this path never
    // calls loadSlice for any view (it doesn't move sliders), so it has to
    // clear a stale note itself too.
    hideNoVoxelNote();

    setLastLookupData(data); setLastParcIdx(data.parcellation_index);
    setLastHighlight({type:'single', parcIdx:data.parcellation_index, level:highlightLevel});
    updatePanel(data);

    // Draw highlights on all three 2D views (doesn't move any slider)
    await Promise.all(Object.keys(views).map(vv =>
      fetchAndDrawHighlight(vv, data.parcellation_index, highlightLevel)
    ));

    setStatus(`${data.matched_label||'parcellation '+data.parcellation_index}`,'ok');

    if (window.notifyChatRegion){
      const regionName = data.matched_label ||
        [data.substructure, data.structure, data.division, data.category]
          .find(x => x && x !== '—' && x !== '--') || 'Region '+data.parcellation_index;
      const regionAcro = data.matched_acronym ||
        [data.substructure_acronym, data.structure_acronym,
         data.division_acronym, data.category_acronym, data.acronym]
          .find(x => x && x !== '—' && x !== '--') || '';
      window.notifyChatRegion(regionName, {...data, structure: regionName, acronym: regionAcro});
    }
  } catch(err){ setStatus('Resolve failed: '+err.message,'error'); }
}
window.resolveParcellation = resolveParcellation;

// 3D click via mesh volume: caller has a compact index (1..N), not the real
// Allen structure_id. Backend maps idx -> sid -> pidx -> metadata.
export async function resolveStructureId(idx){
  if (!idx) return;
  try {
    setStatus(`Resolving idx ${idx}...`);
    const res = await fetch(`${API}/api/resolve_structure_id?idx=${idx}`);
    if (!res.ok) { setStatus(`resolve HTTP ${res.status}`,'error'); return; }
    const data = await res.json();
    if (data.error && !data.parcellation_index){ setStatus('Resolve error: '+data.error,'error'); return; }

    // See the matching comment in resolveLookup above.
    hideNoVoxelNote();

    setLastLookupData(data); setLastParcIdx(data.parcellation_index);
    setLastHighlight({type:'single', parcIdx:data.parcellation_index, level:highlightLevel});
    updatePanel(data);

    await Promise.all(Object.keys(views).map(vv =>
      fetchAndDrawHighlight(vv, data.parcellation_index, highlightLevel)
    ));

    setStatus(`${data.matched_label||'parcellation '+data.parcellation_index}`,'ok');

    if (window.notifyChatRegion){
      const regionName = data.matched_label ||
        [data.substructure, data.structure, data.division, data.category]
          .find(x => x && x !== '—' && x !== '--') || 'Region '+data.parcellation_index;
      const regionAcro = data.matched_acronym ||
        [data.substructure_acronym, data.structure_acronym,
         data.division_acronym, data.category_acronym, data.acronym]
          .find(x => x && x !== '—' && x !== '--') || '';
      window.notifyChatRegion(regionName, {...data, structure: regionName, acronym: regionAcro});
    }
  } catch(err){ setStatus('Resolve failed: '+err.message,'error'); }
}
window.resolveStructureId = resolveStructureId;
