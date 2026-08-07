import { API } from './config.js';

// -- Click rate limiter --------------------------------------------------------
// Remembers what the last click in each view resolved to, so clicking the
// exact same spot again doesn't need to ask the server again. Also ignores
// a new click while a previous one is still waiting on a server response.
// Shared with other files on purpose: sliceViewer.js's click handling and
// lookup.js's resolveLookup both read and change these directly.
export const _clickCache   = {};   // view -> { col, row, sliceIdx, parcIdx, data }
export const _clickPending = {};   // view -> true while we're waiting on the server
const _clickTimer   = {};   // view -> timer id used to reset the above after a pause
const _clickRapid   = {};   // view -> { label, count, timer } for warning tracking

const _RAPID_WINDOW = 2000;  // ms — window to count rapid clicks
const _RAPID_THRESH = 3;     // blocked hits before warning fires

export function _resetClickTracker(view) {
  delete _clickCache[view];
  delete _clickPending[view];
  delete _clickRapid[view];
  clearTimeout(_clickTimer[view]);
}

// Also used directly by ontology.js's own (separate) tree-click rate limiter.
export function _sendWarning(kind, label, count) {
  fetch(`${API}/api/log_warning`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ kind, label, count })
  }).catch(()=>{});   // don't care if this fails, just let it go
}

export function _trackRapidClick(view, label) {
  const r = _clickRapid[view];
  if (r && r.label === label) {
    r.count++;
    clearTimeout(r.timer);
    // Fire warning ONCE when threshold is first hit — not on every subsequent click
    if (r.count === _RAPID_THRESH) {
      _sendWarning('view click', label, r.count);
    }
    r.timer = setTimeout(() => delete _clickRapid[view], _RAPID_WINDOW);
  } else {
    clearTimeout(r?.timer);
    _clickRapid[view] = {
      label, count: 1,
      timer: setTimeout(() => delete _clickRapid[view], _RAPID_WINDOW)
    };
  }
}
