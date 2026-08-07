// This is kept in its own small file (instead of inside toolbar.js, which
// otherwise handles the rest of the status bar's look and behavior) because
// almost every other file needs to update this status message, and
// toolbar.js separately needs something from sliceViewer.js — if setStatus
// also lived in toolbar.js, that would tangle several files up needing each
// other back and forth for no good reason. Keeping it separate avoids that.
const statusBar = document.getElementById('status-bar');
export function setStatus(msg, type = '') { statusBar.textContent = msg; statusBar.className = type; }
