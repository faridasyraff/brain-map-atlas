// The signed-in user's library: saved regions (with private notes) and
// recently viewed regions, backed by /api/me/*. Also the "Save" button and
// notes box in the inspector, the Saved tab, and account deletion.
//
// Items are {kind:'region', ref:<parcellation index>} or
// {kind:'group', ref:<group name>}, plus label / acronym / color for display.
import { API, escapeHtml, safeColor } from './config.js';
import { setStatus } from './statusBar.js';
import { openRegionRef } from './searchPanel.js';

const saveBtn     = document.getElementById('save-region-btn');
const noteWrap    = document.getElementById('region-note-wrap');
const noteInput   = document.getElementById('region-note');
const noteState   = document.getElementById('region-note-state');
const savedList   = document.getElementById('saved-list');
const historyList = document.getElementById('history-list');
const signedOutEl = document.getElementById('library-signed-out');
const signedInEl  = document.getElementById('library-signed-in');

let user = null;
let saved = [];
let history = [];
let current = null;     // the item currently shown in the inspector

const keyOf = it => `${it.kind}:${it.ref}`;
const findSaved = it => it && saved.find(s => keyOf(s) === keyOf(it));

async function api(method, path, body){
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// --- Inspector: Save button + note ------------------------------------------
function renderInspector(){
  if (!saveBtn) return;
  const entry = findSaved(current);
  saveBtn.disabled = !current;
  saveBtn.textContent = entry ? 'Saved' : 'Save';
  saveBtn.setAttribute('aria-pressed', entry ? 'true' : 'false');
  saveBtn.title = !user ? 'Sign in to save regions and keep notes'
                : entry ? 'Remove from your saved regions' : 'Add to your saved regions';
  noteWrap.hidden = !(user && entry);
  if (entry && document.activeElement !== noteInput) noteInput.value = entry.note || '';
  noteState.textContent = '';
}

saveBtn?.addEventListener('click', async () => {
  if (!current) return;
  if (!user) { window.openSignIn?.(); setStatus('Sign in to save regions and keep notes.'); return; }
  try {
    if (findSaved(current)) {
      ({ saved } = await api('DELETE', '/api/me/saved', { kind: current.kind, ref: current.ref }));
      setStatus(`Removed ${current.label} from saved regions`, 'ok');
    } else {
      ({ saved } = await api('PUT', '/api/me/saved', current));
      setStatus(`Saved ${current.label}`, 'ok');
    }
    renderInspector(); renderLibrary();
  } catch (e) { setStatus('Could not update saved regions: ' + e.message, 'error'); }
});

// Notes save automatically shortly after typing stops.
let noteTimer = null;
noteInput?.addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteState.textContent = 'Unsaved changes';
  const item = current;
  noteTimer = setTimeout(async () => {
    try {
      ({ saved } = await api('PUT', '/api/me/saved', { ...item, note: noteInput.value }));
      if (current && keyOf(current) === keyOf(item)) noteState.textContent = 'Note saved';
      renderLibrary();
    } catch (e) { noteState.textContent = 'Could not save note: ' + e.message; }
  }, 700);
});

// --- Saved tab ---------------------------------------------------------------
function itemRow(it, { removable }){
  const li = document.createElement('li');
  li.className = 'library-item';
  const color = safeColor(it.color, 'var(--color-border-strong)');
  li.innerHTML =
    `<button class="library-open" type="button">` +
      `<span class="library-swatch" style="background:${color}"></span>` +
      `<span class="library-text"><span class="library-label">${escapeHtml(it.label)}</span>` +
      (it.acronym ? `<span class="library-acro">${escapeHtml(it.acronym)}</span>` : '') +
      (it.kind === 'group' ? `<span class="library-acro">Group</span>` : '') +
      (it.note ? `<span class="library-note">${escapeHtml(it.note)}</span>` : '') +
      `</span></button>`;
  li.querySelector('.library-open').addEventListener('click', () => openRegionRef(it));
  if (removable) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn-ghost btn-sm library-remove';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove ${it.label} from saved regions`);
    rm.addEventListener('click', async () => {
      try {
        ({ saved } = await api('DELETE', '/api/me/saved', { kind: it.kind, ref: it.ref }));
        renderLibrary(); renderInspector();
      } catch (e) { setStatus('Could not remove: ' + e.message, 'error'); }
    });
    li.appendChild(rm);
  }
  return li;
}

function renderList(el, items, emptyText, opts){
  el.innerHTML = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'library-empty';
    p.textContent = emptyText;
    el.appendChild(p);
    return;
  }
  items.forEach(it => el.appendChild(itemRow(it, opts)));
}

function renderLibrary(){
  if (!savedList) return;
  signedOutEl.hidden = !!user;
  signedInEl.hidden = !user;
  if (!user) return;
  renderList(savedList, saved, 'Nothing saved yet. Use Save in the inspector to keep a region here.', { removable: true });
  renderList(historyList, history.slice(0, 15), 'Regions you open will appear here.', { removable: false });
}

async function refresh(){
  if (!user) { saved = []; history = []; renderLibrary(); renderInspector(); return; }
  try {
    const [s, h] = await Promise.all([api('GET', '/api/me/saved'), api('GET', '/api/me/history')]);
    saved = s.saved; history = h.history;
  } catch (e) { /* signed out elsewhere, or server down — keep what we have */ }
  renderLibrary(); renderInspector();
}

// --- Called by inspectorPanel.updatePanel for every region shown ------------
export function onRegionShown(item){
  current = item && item.ref ? item : null;
  renderInspector();
  if (!user || !current) return;
  api('POST', '/api/me/history', current).then(() => {
    history = [current, ...history.filter(h => keyOf(h) !== keyOf(current))].slice(0, 50);
    renderLibrary();
  }).catch(() => {});
}

// --- Account deletion (Saved tab footer) ------------------------------------
const delStart   = document.getElementById('delete-account-start');
const delForm    = document.getElementById('delete-account-form');
const delPass    = document.getElementById('delete-account-password');
const delConfirm = document.getElementById('delete-account-confirm');
const delCancel  = document.getElementById('delete-account-cancel');
const delError   = document.getElementById('delete-account-error');

delStart?.addEventListener('click', () => { delForm.hidden = false; delStart.hidden = true; delPass.value = ''; delError.textContent = ''; delPass.focus(); });
delCancel?.addEventListener('click', () => { delForm.hidden = true; delStart.hidden = false; });
delConfirm?.addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/auth/account', { password: delPass.value });
    window.location.reload();   // simplest way to reset every panel to signed-out
  } catch (e) { delError.textContent = e.message; }
});

document.getElementById('library-signin-btn')?.addEventListener('click', () => window.openSignIn?.());

window.addEventListener('auth-change', e => { user = e.detail.user; refresh(); });
window.addEventListener('pane-shown', e => { if (e.detail.pane === 'saved') refresh(); });
