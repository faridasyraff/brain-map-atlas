// The 2D slice viewer: zooming/panning each view, the picture and the
// highlighted-region overlay on top of it, the sliders, and clicking to pick
// a region in the sagittal/coronal/transverse panels. The 3D view has no
// slider and takes care of itself in threeViewer.js.
//
// Note: this file and lookup.js each use things from the other one — see
// the note at the top of lookup.js for why that's fine here.
import { API } from './config.js';
import { views, _lastHighlight, suppressSliderReload } from './state.js';
import { setStatus } from './statusBar.js';
import { resolveLookup } from './lookup.js';
import { _clickCache, _clickPending, _resetClickTracker, _trackRapidClick } from './rateLimiter.js';

const ZOOM_MIN  = 0.5;   // 50%  -- most zoomed out
const ZOOM_MAX  = 10;    // 1000% -- most zoomed in
const ZOOM_STEP = 0.12;  // 12% per scroll tick

// Only used within this module (the /api/slice colorize param and the
// /api/highlight color_mode flag) — unlike highlightLevel etc. nothing
// outside sliceViewer.js ever reads or writes this. Always on — there used
// to be a toggle button for this, but colored slices are just better by
// default, so the toggle was removed and this stays permanently 'structure'.
const colorMode = 'structure';

export async function redrawHighlightForView(v){
  if(!_lastHighlight) return;
  const s = views[v];
  const myGen = s.generation;   // see drawHighlight's expectedGen param for why this is captured up front
  try{
    if(_lastHighlight.type === 'single'){
      await fetchAndDrawHighlight(v, _lastHighlight.parcIdx, _lastHighlight.level);
    } else if(_lastHighlight.type === 'group_indices'){
      const res = await fetch(`${API}/api/highlight_indices`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({view:v, idx:s.idx, parcellation_indices:_lastHighlight.indices})});
      const hData = await res.json();
      if(hData.mask) await drawHighlight(v, hData.mask, myGen);
    } else if(_lastHighlight.type === 'group_level'){
      const res = await fetch(`${API}/api/highlight_group`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({view:v, idx:s.idx, group_level:_lastHighlight.group_level, group_name:_lastHighlight.group_name})});
      const hData = await res.json();
      if(hData.mask) await drawHighlight(v, hData.mask, myGen);
    }
  }catch(e){ console.error('[redrawHighlight]', e); }
}

export function applyZoom(v, skipSync){
  const s=views[v];
  s.zoomLayer.style.transform=`translate(${s.panX}px,${s.panY}px) scale(${s.zoom})`;
  if(s.zoomDisp){
    s.zoomDisp.textContent=Math.round(s.zoom*100)+'%';
    s.zoomDisp.classList.toggle('at-limit', s.zoom<=ZOOM_MIN||s.zoom>=ZOOM_MAX);
    s.zoomDisp.title = s.zoom<=ZOOM_MIN ? 'Minimum zoom reached' : s.zoom>=ZOOM_MAX ? 'Maximum zoom reached' : '';
  }
  // Canvas is outside zoom-layer so must always reposition to follow the image
  requestAnimationFrame(()=>syncCanvas(v));
}

export function resetZoom(v){
  const s=views[v];
  s.zoom=1; s.panX=0; s.panY=0;
  applyZoom(v);
  syncCanvas(v);
}

// Wheel zoom -- zoom toward cursor position, sync all views
Object.keys(views).forEach(v=>{
  const s=views[v];
  s.wrap.addEventListener('wheel', e=>{
    e.preventDefault();
    const factor = e.deltaY<0 ? (1+ZOOM_STEP) : 1/(1+ZOOM_STEP);
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.zoom*factor));
    if(newZoom===s.zoom) return;

    // Zoom toward mouse cursor for the hovered view
    const wr=s.wrap.getBoundingClientRect();
    const mx=e.clientX-wr.left-wr.width/2;
    const my=e.clientY-wr.top-wr.height/2;
    const scale=newZoom/s.zoom;
    s.panX=(s.panX-mx)*scale+mx;
    s.panY=(s.panY-my)*scale+my;
    s.zoom=newZoom;
    applyZoom(v);

    // Sync zoom level to all other views (pan stays independent per view)
    Object.keys(views).forEach(ov=>{
      if(ov===v) return;
      const os=views[ov];
      const prevZoom=os.zoom;
      os.zoom=newZoom;
      // Scale existing pan proportionally
      os.panX=os.panX*(newZoom/prevZoom);
      os.panY=os.panY*(newZoom/prevZoom);
      applyZoom(ov);
      os.wrap.style.cursor=os.zoom>1?'grab':'default';
    });

    s.wrap.style.cursor=s.zoom>1?'grab':'default';
  },{passive:false});

  // Pan by dragging -- active while mouse button is held
  let _panDrag=false, _panMoved=false, _panStart={x:0,y:0}, _panOrigin={x:0,y:0};
  s._wasDragging=false;
  s.wrap.addEventListener('mousedown', e=>{
    if(e.button!==0) return;
    _panDrag=true; _panMoved=false; s._wasDragging=false;
    _panStart={x:e.clientX,y:e.clientY}; _panOrigin={x:s.panX,y:s.panY};
    s.wrap.style.cursor='grabbing';
  });
  document.addEventListener('mousemove', e=>{
    if(!_panDrag||views[v]!==s) return;
    const dx=e.clientX-_panStart.x, dy=e.clientY-_panStart.y;
    if(!_panMoved&&Math.hypot(dx,dy)<4) return;
    _panMoved=true; s._wasDragging=true;
    s.panX=_panOrigin.x+dx; s.panY=_panOrigin.y+dy;
    applyZoom(v);
  });
  document.addEventListener('mouseup', ()=>{
    if(!_panDrag||views[v]!==s) return;
    _panDrag=false;
    s.wrap.style.cursor=s.zoom>1?'grab':'default';
  });
  document.addEventListener('mouseleave', ()=>{
    if(!_panDrag||views[v]!==s) return;
    _panDrag=false; _panMoved=false; s._wasDragging=false;
    s.wrap.style.cursor=s.zoom>1?'grab':'default';
  });
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden&&_panDrag&&views[v]===s){
      _panDrag=false; _panMoved=false; s._wasDragging=false;
      s.wrap.style.cursor=s.zoom>1?'grab':'default';
    }
  });

  // Double-click to reset zoom on all views
  // dblclick zoom reset removed — use the Reset button instead
});

export function syncCanvas(v){
  const s=views[v];
  const ir=s.img.getBoundingClientRect();
  const wr=s.wrap.getBoundingClientRect();
  if(!ir.width||!ir.height) return;
  // Position canvas in canvas-wrap space to exactly cover the visible image
  const ox=ir.left-wr.left, oy=ir.top-wr.top;
  s.canvas.style.left  = ox+'px';
  s.canvas.style.top   = oy+'px';
  s.canvas.style.width = ir.width+'px';
  s.canvas.style.height= ir.height+'px';
  // Set canvas resolution to match screen pixels for crisp rendering
  const W=Math.round(ir.width), H=Math.round(ir.height);
  if(s.canvas.width!==W||s.canvas.height!==H){
    s.canvas.width=W; s.canvas.height=H;
  }
  if(s.lastMask){
    const mi=new Image();
    mi.onload=()=>{ s.ctx.clearRect(0,0,W,H); s.ctx.drawImage(mi,0,0,W,H); };
    mi.src=s.lastMask;
  }
}
window.addEventListener('resize', ()=>Object.keys(views).forEach(syncCanvas));

export function imgCoords(e,v){
  const s=views[v];
  const ir=s.img.getBoundingClientRect(), wr=s.wrap.getBoundingClientRect();
  const px=e.clientX-ir.left, py=e.clientY-ir.top;
  if(px<0||py<0||px>ir.width||py>ir.height) return null;
  return {
    col:Math.round((px/ir.width)*s.cols),
    row:Math.round((py/ir.height)*s.rows),
    markerX:e.clientX-wr.left,   // relative to canvas-wrap for click-marker
    markerY:e.clientY-wr.top,
  };
}

export function loadSlice(v, onDone){
  const s = views[v];
  if(s.abortCtrl) s.abortCtrl.abort();
  s.abortCtrl = new AbortController();
  const myGen = ++s.generation;
  s.loading.style.display='flex'; s.errEl.style.display='none';
  if(s.noVoxelNote) s.noVoxelNote.style.display='none';
  s.img.src=''; s.img.style.opacity='0.3';
  s.marker.style.display='none';
  s.ctx.clearRect(0,0,s.canvas.width,s.canvas.height);
  s.lastMask=null;
  // Clear the 3D plane highlight too; will be re-applied when fetchAndDrawHighlight runs
  if (window.brain3d?.refreshPlaneHighlight) window.brain3d.refreshPlaneHighlight(v, null);
  (async()=>{
    try{
      const res=await fetch(`${API}/api/slice?view=${v}&idx=${s.idx}&colorize=${colorMode}&_=${Date.now()}`,{signal:s.abortCtrl.signal});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      if(s.generation!==myGen) return;
      s.cols=data.cols; s.rows=data.rows;
      const freshImg=new Image();
      freshImg.onload=()=>{
        if(s.generation!==myGen) return;
        s.img.src=freshImg.src; s.img.style.opacity='1'; s.loading.style.display='none';
        // Keep the 3D eBrain plane texture in sync with the 2D view
        if (window.brain3d?.refreshPlaneTexture) window.brain3d.refreshPlaneTexture(v, freshImg);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{ if(s.generation!==myGen) return; syncCanvas(v); if(onDone) onDone(); }));
      };
      freshImg.onerror=()=>{ if(s.generation!==myGen) return; s.loading.style.display='none'; };
      freshImg.src=data.image;
    } catch(err){
      if(err.name==='AbortError'||s.generation!==myGen) return;
      s.loading.style.display='none'; s.errEl.style.display='flex';
      s.errEl.querySelector('.err-msg').textContent='Backend error: '+err.message;
    }
  })();
}
export function loadSliceP(v){ return new Promise(resolve=>loadSlice(v,resolve)); }

// A small note shown directly on top of each 2D view's picture when the
// last-selected region has no voxels in the CCFv3 annotation volume -- the
// picture itself is still perfectly valid, it's just that the requested
// region isn't anywhere in it. Deliberately not the same as .err-overlay
// (which hides the whole picture; wrong here, since nothing failed to
// load) or a status-bar-only message (easy to miss, and doesn't say WHERE
// the problem is when three 2D views plus a 3D view are all on screen).
// Cleared automatically at the top of every loadSlice call, so a stale
// note never lingers once a genuinely available region is selected next.
export function showNoVoxelNote(label){
  Object.keys(views).forEach(v=>{
    const s = views[v];
    if(!s.noVoxelNote) return;
    s.noVoxelNote.textContent = `"${label}" has no voxels here — not in the 2D annotation data`;
    s.noVoxelNote.style.display = 'block';
  });
}
export function hideNoVoxelNote(){
  Object.keys(views).forEach(v=>{
    if(views[v].noVoxelNote) views[v].noVoxelNote.style.display='none';
  });
}

// expectedGen: the view's s.generation at the moment the highlight fetch
// that produced maskDataUrl was STARTED (every caller here captures this
// before its own await). Highlight fetches race against loadSlice, which
// bumps s.generation and blanks the image the instant a newer slice load
// starts (slider drag, search/tree/click jump). Without this check, a
// highlight fetch that was already in flight when the view moved on would
// still land and get painted once it resolves -- on a canvas sitting over
// an image that's now blank/mid-reload, which looks like the view going
// solid black except for a stray highlight-colored blob. Skipping a stale
// result here is what the equivalent generation check in loadSlice already
// does for the image itself.
export function drawHighlight(v,maskDataUrl,expectedGen){
  const s=views[v];
  if(expectedGen!==undefined && s.generation!==expectedGen) return Promise.resolve();
  s.lastMask=maskDataUrl;
  // Mirror the highlight onto the matching 3D plane in eBrain mode
  if (window.brain3d?.refreshPlaneHighlight) window.brain3d.refreshPlaneHighlight(v, maskDataUrl);
  return new Promise(resolve=>{
    const mi=new Image();
    mi.onload=()=>{ syncCanvas(v); s.ctx.clearRect(0,0,s.canvas.width,s.canvas.height); s.ctx.drawImage(mi,0,0,s.canvas.width,s.canvas.height); resolve(); };
    mi.onerror=()=>resolve();
    mi.src=maskDataUrl;
  });
}
export async function fetchAndDrawHighlight(v,parcIdx,level){
  const s=views[v];
  const myGen=s.generation;
  try{
    const res=await fetch(`${API}/api/highlight`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view:v,idx:s.idx,parcellation_index:parcIdx,level:level,color_mode:colorMode!=='off'})});
    const data=await res.json();
    if(data.mask) await drawHighlight(v,data.mask,myGen);
  } catch(e){ console.error(`[fetchHighlight] ${v}`,e); }
}

Object.keys(views).forEach(v=>{
  const s=views[v];
  s.slider.addEventListener('input',()=>{
    s.idx=parseInt(s.slider.value); s.idxDisp.textContent=s.idx;
    // Live-update the 3D slice plane while dragging (cheap; no API call)
    if (window.brain3d?.setSlice) window.brain3d.setSlice(v, s.idx, parseInt(s.slider.max), parseInt(s.slider.min));
  });
  s.slider.addEventListener('change',()=>{
    if(suppressSliderReload) return;
    s.idx=parseInt(s.slider.value); views[v].lastMask=null;
    _resetClickTracker(v);   // new slice position resets repeat-click counter
    if (window.brain3d?.setSlice) window.brain3d.setSlice(v, s.idx, parseInt(s.slider.max), parseInt(s.slider.min));
    loadSlice(v, ()=>{ redrawHighlightForView(v); });
  });
  // Recenter button
  const recenterBtn = s.cell.querySelector('.recenter-btn');
  if(recenterBtn) recenterBtn.addEventListener('click', ()=>resetZoom(v));
  s.cell.querySelectorAll('.slider-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const dir=parseInt(btn.dataset.dir);
      const min=parseInt(s.slider.min), max=parseInt(s.slider.max);
      const newVal=Math.min(max, Math.max(min, s.idx+dir));
      if(newVal===s.idx) return;
      s.slider.value=newVal; s.idx=newVal; s.idxDisp.textContent=newVal;
      views[v].lastMask=null;
      if (window.brain3d?.setSlice) window.brain3d.setSlice(v, s.idx, max, min);
      loadSlice(v, ()=>{ redrawHighlightForView(v); });
    });
  });
  s.wrap.addEventListener('mousemove',e=>{
    if(!s.cols) return;
    const c=imgCoords(e,v);
    if(!c){ s.xhairH.style.display=s.xhairV.style.display='none'; s.cxDisp.textContent=s.cyDisp.textContent='--'; return; }
    s.xhairH.style.display=s.xhairV.style.display='block';
    s.xhairH.style.top=c.markerY+'px'; s.xhairV.style.left=c.markerX+'px';
    s.cxDisp.textContent=c.col; s.cyDisp.textContent=c.row;
  });
  s.wrap.addEventListener('mouseleave',()=>{ s.xhairH.style.display=s.xhairV.style.display='none'; });
  s.wrap.addEventListener('click', e=>{
    if(!s.cols) return;
    if(s._wasDragging){ s._wasDragging=false; return; }
    const c=imgCoords(e,v); if(!c) return;
    const {col,row,markerX,markerY}=c;
    if(col<0||col>=s.cols||row<0||row>=s.rows) return;

    // Auto-open the info panel when the user clicks any view
    if(typeof window.openInfoPanel === 'function') window.openInfoPanel();

    // -- Pre-fetch cache check ---------------------------------------------
    const cached = _clickCache[v];
    if(cached && cached.col===col && cached.row===row && cached.sliceIdx===s.idx){
      // Same pixel, same slice — track as rapid click, no API call
      _trackRapidClick(v, cached.data.structure || 'parcellation '+cached.data.parcellation_index);
      s.marker.style.left=markerX+'px'; s.marker.style.top=markerY+'px'; s.marker.style.display='block';
      setStatus(`${cached.data.structure||'parcellation '+cached.data.parcellation_index} — cached`,'ok');
      return;
    }

    // -- Debounce — ignore if a fetch is already in-flight for this view --
    if(_clickPending[v]){
      if(cached) _trackRapidClick(v, cached.data?.structure || '?');
      return;
    }

    s.marker.style.left=markerX+'px'; s.marker.style.top=markerY+'px'; s.marker.style.display='block';
    resolveLookup(v, col, row);
  });
});

Promise.all(Object.keys(views).map(v=>loadSlice(v))).then(()=>{
  Object.keys(views).forEach(v=>{ resetZoom(v); syncCanvas(v); });
  setStatus('All views loaded -- click any image to identify regions','ok');
});
