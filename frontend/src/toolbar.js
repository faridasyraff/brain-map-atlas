// The parts of the page that aren't tied to any one specific panel: the
// sidebar tab switcher (inspector vs. hierarchy view), the sidebar resize
// handle, the button that collapses the sidebar, and the buttons that
// switch between sagittal/coronal/transverse/3D/all views.
import { views } from './state.js';
import { syncCanvas } from './sliceViewer.js';

// -- Sidebar tab switcher --------------------------------------
(function(){
  const tabs     = document.querySelectorAll('.sidebar-tab');
  const paneMain = document.getElementById('pane-main');
  const paneTree = document.getElementById('pane-tree');
  const statusBar= document.getElementById('status-bar');

  function activatePane(paneName) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.pane === paneName));

    if (paneName === 'tree') {
      paneMain.classList.remove('active');
      paneTree.classList.add('active');
      // status bar must sit after pane-tree inside info-panel
      statusBar.parentElement.appendChild(statusBar);
    } else {
      paneTree.classList.remove('active');
      paneMain.classList.add('active');
      statusBar.parentElement.appendChild(statusBar);
    }
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => activatePane(tab.dataset.pane));
  });
})();

// -- Sidebar resize ------------------------------------------------------------
(function(){
  const handle = document.getElementById('sidebar-resize-handle');
  const root   = document.querySelector('.root');
  const MIN_W  = 240, MAX_W = 600;
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e=>{
    dragging = true;
    startX   = e.clientX;
    startW   = document.getElementById('info-panel').offsetWidth;
    handle.classList.add('dragging');
    // Kill the eased right-transition on the toggle so it tracks the handle 1:1
    document.getElementById('panel-toggle')?.classList.add('no-transition');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e=>{
    if(!dragging) return;
    const delta = startX - e.clientX;   // dragging left = making wider
    const newW  = Math.min(MAX_W, Math.max(MIN_W, startW + delta));
    document.getElementById('info-panel').style.width = newW + 'px';
    // (The Menu tab sits in its own grid column now, so it follows the
    // panel's edge automatically — no need to move it here.)
    // Resyncing canvases after resize keeps highlight overlay aligned
    requestAnimationFrame(()=>Object.keys(views).forEach(v=>syncCanvas(v)));
    // positionSearchDropdown()/positionOntologyDropdown() used to be called
    // here too, but both already reposition themselves continuously via
    // their own requestAnimationFrame loop (see searchPanel.js/ontology.js),
    // so calling them again on every mousemove here was redundant.
  });

  document.addEventListener('mouseup', ()=>{
    if(!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.getElementById('panel-toggle')?.classList.remove('no-transition');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Final sync after drag ends
    requestAnimationFrame(()=>Object.keys(views).forEach(v=>syncCanvas(v)));
  });
})();

// -- Collapsible sidebar --------------------------------------------------------
// Click the Menu tab to show/hide the side panel; clicking a view opens it.
// Layouts (see the @media blocks at the end of styles.css):
//   tablet+ (>=761px) views | Menu rail | docked panel. Panel starts open
//                     on wide screens (>=1100px), closed on narrower ones.
//   phone  (<=760px)  panel covers the screen; floating Menu button
(function(){
  const panel  = document.getElementById('info-panel');
  const toggle = document.getElementById('panel-toggle');
  const label  = toggle.querySelector('.panel-toggle-label');
  const isWide  = () => window.matchMedia('(min-width:1100px)').matches;
  const isPhone = () => window.matchMedia('(max-width:760px)').matches;
  const STORE_KEY = 'atlas.panelOpen';   // remembers the user's own choice

  function placeToggle(){
    const open = !panel.classList.contains('collapsed');
    // Position is pure CSS (own grid column, or bottom-right on phones).
    toggle.style.right = '';
    if(label) label.textContent = !open ? 'Menu' : (isPhone() ? 'Close' : 'Hide');
  }

  function setCollapsed(collapsed, remember){
    panel.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    placeToggle();
    if(remember){ try{ localStorage.setItem(STORE_KEY, collapsed ? '0' : '1'); }catch(e){} }
    // Canvases should resync after the slide animation finishes (and, when
    // docked, after the views change width) so crosshairs and highlight
    // overlays stay aligned to whatever's visible behind.
    requestAnimationFrame(()=>Object.keys(views).forEach(v=>syncCanvas(v)));
    setTimeout(()=>{ Object.keys(views).forEach(v=>syncCanvas(v)); }, 340);
  }
  toggle.addEventListener('click', ()=>{
    setCollapsed(!panel.classList.contains('collapsed'), true);
  });

  // Initial state: the user's last choice if they made one, otherwise open
  // only where it doesn't cover anything (wide screens). Phones always start
  // on the views.
  let saved = null;
  try{ saved = localStorage.getItem(STORE_KEY); }catch(e){}
  const startOpen = isPhone() ? false : (saved !== null ? saved === '1' : isWide());
  setCollapsed(!startOpen, false);
  window.addEventListener('resize', placeToggle);

  // Called on any view click. On phones the panel would cover the view the
  // user just tapped, so leave it closed there (the status toast shows what
  // was selected).
  window.openInfoPanel = ()=>{
    if(!isPhone() && panel.classList.contains('collapsed')) setCollapsed(false, false);
  };
})();

// -- Fullscreen button: focus a view full-screen, click again to go back --
const viewsArea=document.getElementById('views-area');
let currentViewMode='all';

function setViewMode(mode){
  if(mode===currentViewMode) return;
  currentViewMode=mode;
  viewsArea.classList.remove('focus-sagittal','focus-coronal','focus-transverse','focus-three-d');
  if(mode!=='all') viewsArea.classList.add('focus-'+mode);
  // The button on the expanded view says how to get back.
  document.querySelectorAll('.view-cell').forEach(c=>{
    const b=c.querySelector('.fullscreen-btn');
    if(b) b.textContent = (mode!=='all' && c.dataset.view===mode) ? 'Show all views' : 'Expand';
  });
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    // Only 2D views need syncCanvas — the 3D view resizes itself in its animate loop
    const twoDviews = Object.keys(views);  // sagittal, coronal, transverse
    const av = mode === 'all'
      ? twoDviews
      : (twoDviews.includes(mode) ? [mode] : []);
    av.forEach(v => syncCanvas(v));
  }));
}

document.querySelectorAll('.view-cell').forEach(cell=>{
  const fsBtn=cell.querySelector('.fullscreen-btn');
  if(fsBtn) fsBtn.addEventListener('click',e=>{
    e.stopPropagation();
    const mode=cell.dataset.view;
    setViewMode(mode===currentViewMode ? 'all' : mode);
  });
});
