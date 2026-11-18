// Shareable links: the address bar always describes what's on screen, so a
// copied URL reopens the same view.
//
//   /app?region=565&sag=491&cor=660&tra=340     a single region
//   /app?group=Hippocampal%20formation&...      a group of regions
//
// Writes happen from two central places: loadSlice() (every slice move) and
// setLastHighlight() (every selection). restoreFromLink() in searchPanel.js
// replays a link once the views have loaded.

const SLICE_PARAM = { sagittal: 'sag', coronal: 'cor', transverse: 'tra' };

// What the link said when the page opened. Snapshotted now because the
// first slice loads immediately start writing their own positions back
// into the address bar.
const INITIAL = new URLSearchParams(window.location.search);

function update(mutate){
  const url = new URL(window.location.href);
  mutate(url.searchParams);
  // replaceState: moving a slider shouldn't fill the back-button history.
  window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
}

export function recordSlice(view, idx){
  const key = SLICE_PARAM[view];
  if (key) update(p => p.set(key, String(idx)));
}

export function recordSelection(highlight){
  update(p => {
    p.delete('region'); p.delete('group');
    if (!highlight) return;
    if (highlight.type === 'single' && highlight.parcIdx != null) p.set('region', String(highlight.parcIdx));
    else if (highlight.label) p.set('group', highlight.label);
  });
}

// Slice positions from the URL, applied to the sliders before the first load.
export function initialSlices(){
  const p = INITIAL;
  const out = {};
  for (const [view, key] of Object.entries(SLICE_PARAM)) {
    const n = parseInt(p.get(key), 10);
    if (Number.isFinite(n)) out[view] = n;
  }
  return out;
}

export function initialSelection(){
  const p = INITIAL;
  const region = parseInt(p.get('region'), 10);
  if (Number.isFinite(region) && region > 0) return { type: 'single', parcIdx: region };
  const group = (p.get('group') || '').trim();
  if (group) return { type: 'group', name: group.slice(0, 200) };
  return null;
}

export async function copyCurrentLink(){
  try {
    await navigator.clipboard.writeText(window.location.href);
    return true;
  } catch (e) {
    return false;   // e.g. clipboard blocked on plain http — caller says so
  }
}
