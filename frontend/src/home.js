// The home/landing page's account UI is exactly the same sign in / sign up
// flow as the sidebar inside the atlas view — same element IDs, so the same
// module drives both; this file only adds the one thing unique to showing
// it as a modal here: clicking outside the card closes it.
import './auth.js';

document.getElementById('account-modal-backdrop')?.addEventListener('click', () => {
  document.getElementById('account-cancel-btn')?.click();
});
