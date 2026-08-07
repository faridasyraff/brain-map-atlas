// The small account bar pinned above the sidebar tabs: shows who's signed
// in (or a sign in / sign up prompt if nobody is), and the sign in / sign
// up form itself. Talks to the /api/auth/* routes in App.py.
import { API } from './config.js';

const bar        = document.getElementById('account-bar');
const loggedOut  = document.getElementById('account-logged-out');
const loggedIn   = document.getElementById('account-logged-in');
const form       = document.getElementById('account-form');
const emailEl    = document.getElementById('account-email');
const adminBadge = document.getElementById('account-admin-badge');
const emailInput = document.getElementById('account-email-input');
const passInput  = document.getElementById('account-password-input');
const errorEl    = document.getElementById('account-error');
const submitBtn  = document.getElementById('account-submit-btn');
const toggleLink   = document.getElementById('account-toggle-link');
const togglePrompt = document.getElementById('account-toggle-prompt');

let mode = 'login';   // 'login' or 'signup' — which one the open form submits as

function showLoggedOut() {
  loggedOut.style.display = 'flex';
  loggedIn.style.display  = 'none';
  form.style.display      = 'none';
}

function showLoggedIn(user) {
  emailEl.textContent = user.email;
  adminBadge.style.display = user.is_admin ? 'inline' : 'none';
  loggedOut.style.display = 'none';
  loggedIn.style.display  = 'flex';
  form.style.display      = 'none';
}

function openForm(newMode) {
  mode = newMode;
  errorEl.textContent = '';
  emailInput.value = '';
  passInput.value = '';
  submitBtn.textContent = mode === 'login' ? 'Sign in' : 'Sign up';
  togglePrompt.textContent = mode === 'login' ? 'Need an account?' : 'Already have one?';
  toggleLink.textContent   = mode === 'login' ? 'Sign up' : 'Sign in';
  loggedOut.style.display = 'none';
  loggedIn.style.display  = 'none';
  form.style.display      = 'flex';
  emailInput.focus();
}

async function refreshAccountState() {
  try {
    const res  = await fetch(`${API}/api/auth/me`);
    const data = await res.json();
    if (data.user) showLoggedIn(data.user);
    else showLoggedOut();
  } catch (e) {
    console.error('[auth] could not check login state', e);
  }
}

document.getElementById('account-signin-btn').addEventListener('click', () => openForm('login'));
document.getElementById('account-signup-btn').addEventListener('click', () => openForm('signup'));
document.getElementById('account-cancel-btn').addEventListener('click', showLoggedOut);
document.getElementById('account-toggle-link').addEventListener('click', e => {
  e.preventDefault();
  openForm(mode === 'login' ? 'signup' : 'login');
});

document.getElementById('account-logout-btn').addEventListener('click', async () => {
  await fetch(`${API}/api/auth/logout`, { method: 'POST' });
  showLoggedOut();
});

async function submitForm() {
  errorEl.textContent = '';
  const email = emailInput.value.trim();
  const password = passInput.value;
  const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';
  try {
    const res = await fetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Something went wrong';
      return;
    }
    showLoggedIn(data);
  } catch (e) {
    errorEl.textContent = 'Could not reach the server';
  }
}

submitBtn.addEventListener('click', submitForm);
passInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitForm(); });

refreshAccountState();
