// The handful of values that more than one panel/file genuinely needs to
// read or change. Everything else stays local to whichever file owns it
// (e.g. colorMode is only used inside sliceViewer.js, so it lives there
// instead of here).

// Other files can read these values directly and always see the latest
// version, but they can't change them directly — for that, each one has its
// own small "setter" function below (e.g. setLastParcIdx). That's just a
// rule of how these separate files are allowed to share values safely.
export let highlightLevel        = 'structure';
export let lastParcIdx           = null;
export let lastLookupData        = null;
export let suppressSliderReload  = false;
export function setLastParcIdx(v) { lastParcIdx = v; }
export function setLastLookupData(v) { lastLookupData = v; }
export function setSuppressSliderReload(v) { suppressSliderReload = v; }

// -- Persistent highlight state ------------------------------------------------
// Stores what is currently highlighted so sliders can re-fetch it.
// type: 'single' | 'group_indices' | null
// single:        { type:'single', parcIdx, level }
// group_indices: { type:'group_indices', indices:[] }
export let _lastHighlight = null;
export function setLastHighlight(v) { _lastHighlight = v; }

// -- Per-view state --------------------------------------------
// Only the 2D slice views (sagittal/coronal/transverse) are handled here.
// The 3D view has no slice slider and manages itself in its own module.
export const views = {};
window.views = views; // the 3D view's click handling needs to read this too
document.querySelectorAll('.view-cell').forEach(cell => {
  const v = cell.dataset.view;
  if (v === 'three-d') return;   // 3D cell is owned by the Three.js module
  views[v] = {
    cell, img:cell.querySelector('.atlas-img'), canvas:cell.querySelector('.hl-canvas'),
    zoomLayer:cell.querySelector('.zoom-layer'),
    marker:cell.querySelector('.click-marker'), xhairH:cell.querySelector('.xhair-h'),
    xhairV:cell.querySelector('.xhair-v'), wrap:cell.querySelector('.canvas-wrap'),
    loading:cell.querySelector('.loading-overlay'), errEl:cell.querySelector('.err-overlay'),
    noVoxelNote:cell.querySelector('.no-voxel-note'),
    slider:cell.querySelector('.idx-slider'), idxDisp:cell.querySelector('.idx-display'),
    zoomDisp:cell.querySelector('.zoom-display'),
    cxDisp:cell.querySelector('.cx'), cyDisp:cell.querySelector('.cy'),
    idx:parseInt(cell.querySelector('.idx-slider').value), cols:0, rows:0,
    zoom:1, panX:0, panY:0,
  };
  views[v].ctx = views[v].canvas.getContext('2d');
  views[v].img.addEventListener('dragstart', e=>e.preventDefault());
  views[v].canvas.addEventListener('dragstart', e=>e.preventDefault());
  views[v].abortCtrl = null;
  views[v].generation = 0;
  views[v].lastMask   = null;
});

// -- Ontology tree data (populated once by ontology.js, read by several) ------
export let _ontologyRoots = [], _allTreeRows = [], _activeRowEl = null;
export function setOntologyRoots(v) { _ontologyRoots = v; }
export function setAllTreeRows(v) { _allTreeRows = v; }
export function setActiveRowEl(v) { _activeRowEl = v; }

