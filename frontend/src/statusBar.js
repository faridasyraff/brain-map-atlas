// This is kept in its own small file (instead of inside toolbar.js, which
// otherwise handles the rest of the status bar's look and behavior) because
// almost every other file needs to update this status message, and
// toolbar.js separately needs something from sliceViewer.js — if setStatus
// also lived in toolbar.js, that would tangle several files up needing each
// other back and forth for no good reason. Keeping it separate avoids that.
//
// Messages are shown in a small toast over the views (#status-toast). The
// old sidebar #status-bar is hidden by CSS but still updated, since a few
// places (and tests) read its text.
const statusBar = document.getElementById('status-bar');
const toast     = document.getElementById('status-toast');
let hideTimer = null;

function hideToast(){ toast?.classList.remove('show'); }
toast?.addEventListener('click', hideToast);

export function setStatus(msg, type = '') {
  statusBar.textContent = msg; statusBar.className = type;
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'status-toast show ' + type;
  clearTimeout(hideTimer);
  // Errors stay until the next message (or a click); successes fade
  // quickly; in-progress messages get a long fallback in case nothing
  // follows them.
  if (type !== 'error') hideTimer = setTimeout(hideToast, type === 'ok' ? 4000 : 15000);
}
