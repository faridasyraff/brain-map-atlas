// Self-hosted UI typeface (bundled by Vite; no third-party font request).
import '@fontsource-variable/instrument-sans';
// The landing page's account UI is the same sign in / create account flow as
// the atlas sidebar — same element IDs, so auth.js drives both. This file
// adds what's specific to showing it as a dialog here, plus the hero image.
import './auth.js';

const cancel = () => document.getElementById('account-cancel-btn')?.click();
document.getElementById('account-modal-backdrop')?.addEventListener('click', cancel);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('account-form')?.hidden) cancel();
});

// Hero: a real section from the atlas, rendered by the same endpoint the
// atlas views use. If the backend isn't reachable, say so plainly.
(async () => {
  const img = document.getElementById('home-slice');
  const msg = document.getElementById('home-plate-msg');
  try {
    const res = await fetch('/api/slice?view=coronal&idx=660&colorize=structure');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    img.onload = () => { img.hidden = false; msg.hidden = true; };
    img.src = data.image;
  } catch (e) {
    msg.textContent = 'The atlas preview could not be loaded. The atlas server may still be starting up.';
  }
})();
