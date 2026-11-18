// Fixed settings shared by every file — nothing here ever changes while the
// app is running. Values that DO change over time live in state.js instead.

// Left blank on purpose (a "relative" address) — see API_BASE in
// threeViewer.js for the full explanation of why.
export const API = '';

export const LEVELS = ['organ','category','division','structure','substructure'];

// Anything that came from the server, the Allen API, CortexMap or an AI
// answer must go through this before being put into innerHTML — otherwise
// text like `<img src=x onerror=...>` inside it would run as code.
export function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

// Region colors get inserted into style="" attributes; only let real hex
// colors through so a malformed value can't break out of the attribute.
export function safeColor(value, fallback = '#445a72'){
  return /^#[0-9a-fA-F]{3,8}$/.test(String(value || '')) ? value : fallback;
}
