// This is the starting point — it just loads every other file so the whole
// app sets itself up. The order they're listed in below doesn't actually
// matter (the browser is smart enough to load each file's own requirements
// first, regardless of order); it's just written top-to-bottom to roughly
// match how the site's original single-file version used to read.
import './config.js';
import './statusBar.js';
import './state.js';
import './rateLimiter.js';
import './auth.js';
import './toolbar.js';
import './sliceViewer.js';
import './lookup.js';
import './inspectorPanel.js';
import './ontology.js';
import './searchPanel.js';
import './chatPanel.js';
import './threeViewer.js';
