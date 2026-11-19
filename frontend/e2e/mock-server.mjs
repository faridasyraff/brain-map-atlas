// A stand-in for the Flask app for end-to-end tests in CI, where the real
// atlas (hundreds of MB of data) isn't available. It serves the production
// build (dist/) on the same routes as backend/App.py and answers /api with a
// tiny dataset: every slice is an ellipse ("the brain"), a click inside it is
// the lateral dorsal nucleus (LD), and search knows a handful of regions.
//
//   node e2e/mock-server.mjs [port]      (default 4173; run `npm run build` first)
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.argv[2] ?? 4173);

// Pages, as App.py routes them.
const PAGES = { '/': 'home.html', '/next': 'next.html', '/app': 'index.html' };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Slice image size per view (cols × rows) and the voxel a slice pixel is.
const SHAPE = { sagittal: [1320, 800], coronal: [1140, 800], transverse: [1320, 1140] };
const voxel = (view, idx, col, row) =>
  view === 'sagittal' ? { xi: idx, yi: row, zi: col } : view === 'coronal' ? { xi: col, yi: row, zi: idx } : { xi: row, yi: idx, zi: col };
const insideBrain = (view, col, row) => {
  const [w, h] = SHAPE[view];
  return ((col - w / 2) / (w * 0.4)) ** 2 + ((row - h / 2) / (h * 0.4)) ** 2 <= 1;
};
const svg = (view, body) => {
  const [w, h] = SHAPE[view];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)}`;
};

const REGIONS = {
  150: { name: 'Lateral dorsal nucleus of thalamus', acronym: 'LD', sid: 155, division: 'Thalamus', color: '#FF909F', center: { xi: 707, yi: 319, zi: 660 } },
  662: { name: 'Caudoputamen', acronym: 'CP', sid: 672, division: 'Striatum', color: '#98D6F9', center: { xi: 400, yi: 350, zi: 600 } },
};
const leaf = (pidx) => {
  const r = REGIONS[pidx];
  return { is_group: false, parcellation_index: pidx, matched_label: r.name, matched_acronym: r.acronym, structure_color: r.color, no_voxels: false };
};
const HIPPOCAMPUS = {
  is_group: true, group_level: 'division', group_name: 'Hippocampal formation', group_acronym: 'HPF', member_count: 40,
  parcellation_index: 17, matched_label: 'Hippocampal formation', matched_acronym: 'HPF', structure_color: '#7ED04B',
};
const ONTOLOGY = [{
  id: 997, name: 'root', acronym: 'root', _color: '#FFFFFF', _available: false,
  children: [
    { id: 549, name: 'Thalamus', acronym: 'TH', _color: '#FF7080', _available: true,
      children: [{ id: 155, name: REGIONS[150].name, acronym: 'LD', _color: '#FF909F', _available: true, children: [] }] },
    { id: 672, name: 'Caudoputamen', acronym: 'CP', _color: '#98D6F9', _available: true, children: [] },
  ],
}];

// 3D meshes: a GLB octahedron per structure, in the mesh frame (µm; x = A–P, y = S–I, z = L–R).
function octahedronGlb([cx, cy, cz], [rx, ry, rz]) {
  const pos = new Float32Array([cx + rx, cy, cz, cx - rx, cy, cz, cx, cy + ry, cz, cx, cy - ry, cz, cx, cy, cz + rz, cx, cy, cz - rz]);
  const idx = new Uint16Array([0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [cx - rx, cy - ry, cz - rz], max: [cx + rx, cy + ry, cz + rz] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const data = pad(bin, 0);
  const chunk = (type, body) => Buffer.concat([Buffer.from(Uint32Array.of(body.length, type).buffer), body]);
  const body = Buffer.concat([chunk(0x4e4f534a, json), chunk(0x004e4942, data)]);
  return Buffer.concat([Buffer.from(Uint32Array.of(0x46546c67, 2, 12 + body.length).buffer), body]);
}
const MESHES = {
  997: octahedronGlb([6600, 4000, 5700], [6000, 3500, 5000]), // the whole brain (the outline)
  672: octahedronGlb([6000, 3500, 4000], [900, 700, 700]), // CP
};

// Accounts, with a cookie session per browser context, so parallel tests
// don't see each other's sign-ins.
const users = new Map(); // email -> { password, saved: [], history: [] }
const sessions = new Map(); // sid -> email

async function api(method, path, q, body, sid) {
  const email = sessions.get(sid);
  const me = email ? users.get(email) : null;
  const user = email ? { email, is_admin: false } : null;
  switch (`${method} ${path}`) {
    case 'GET /api/slice': {
      const view = q.get('view');
      const brain = '<rect width="100%" height="100%" fill="#000"/><ellipse cx="50%" cy="50%" rx="40%" ry="40%" fill="#3b7a8c" stroke="#9cd" stroke-width="4"/>';
      const [cols, rows] = SHAPE[view];
      return [200, { view, idx: Number(q.get('idx')), image: svg(view, brain), cols, rows }];
    }
    case 'POST /api/highlight':
    case 'POST /api/highlight_indices':
    case 'POST /api/highlight_group':
      return [200, { mask: svg(body.view, '<ellipse cx="50%" cy="50%" rx="10%" ry="10%" fill="#ff909f" fill-opacity="0.8"/>') }];
    case 'POST /api/lookup': {
      const { view, idx, col, row } = body;
      const [w, h] = SHAPE[view] ?? [0, 0];
      if (!(col >= 0 && row >= 0 && col < w && row < h)) return [400, { error: 'coordinates out of bounds' }];
      if (!insideBrain(view, col, row)) return [200, { parcellation_index: 0, error: 'No region for index 0', ...voxel(view, idx, col, row) }];
      const r = REGIONS[150];
      return [200, {
        parcellation_index: 150, structure_id: r.sid, matched_label: r.name, matched_acronym: r.acronym,
        structure_color: r.color, division: r.division, ...voxel(view, idx, col, row),
      }];
    }
    case 'GET /api/search': {
      const s = (q.get('q') ?? '').toLowerCase();
      const hits = [HIPPOCAMPUS, ...Object.keys(REGIONS).map(Number).map(leaf)].filter(
        (r) => r.matched_label.toLowerCase().includes(s) || r.matched_acronym.toLowerCase() === s,
      );
      return [200, { results: hits }];
    }
    case 'GET /api/resolve_region': {
      const n = (q.get('name') ?? '').toLowerCase();
      if (n === 'hippocampal formation') return [200, HIPPOCAMPUS];
      return [200, Object.keys(REGIONS).map(Number).map(leaf).find((r) => r.matched_label.toLowerCase() === n) ?? {}];
    }
    case 'POST /api/region_center': {
      const r = REGIONS[body.parcellation_index];
      return r ? [200, r.center] : [404, { error: 'No voxels found' }];
    }
    case 'POST /api/region_center_group':
    case 'POST /api/region_center_indices':
      return [200, { xi: 380, yi: 300, zi: 830 }];
    case 'POST /api/group_by_term':
      return [404, { error: `Term not found: ${body.name}` }];
    case 'GET /api/resolve_parcellation': {
      const pidx = Number(q.get('pidx'));
      const r = REGIONS[pidx];
      if (!r) return [200, { parcellation_index: pidx, error: 'No region' }];
      return [200, {
        parcellation_index: pidx, matched_label: r.name, matched_acronym: r.acronym, structure_color: r.color, structure_id: r.sid,
        organ: 'brain', category: 'Basic cell groups and regions', division: r.division, structure: r.name, substructure: r.name,
      }];
    }
    case 'GET /api/resolve_structure_id':
      return [200, { error: 'Unknown structure' }];
    case 'GET /api/enrich':
      return [200, { region_summary: '', functional_keywords: [], related_regions: [], ai_note: 'AI summaries are turned off in the e2e mock.' }];
    case 'GET /api/ontology':
      return [200, { msg: ONTOLOGY }];
    case 'GET /api/available_meshes':
      return [200, { structure_ids: Object.keys(MESHES).map(Number) }];
    case 'GET /api/mesh_volume_meta':
      return [404, { error: 'meshes_volume.npy not found' }];

    case 'GET /api/auth/me':
      return [200, { user }];
    case 'POST /api/auth/signup': {
      if (users.has(body.email)) return [409, { error: 'An account with that email already exists' }];
      users.set(body.email, { password: body.password, saved: [], history: [] });
      const newSid = randomUUID();
      sessions.set(newSid, body.email);
      return [201, { email: body.email, is_admin: false }, newSid];
    }
    case 'POST /api/auth/login': {
      if (users.get(body.email)?.password !== body.password) return [401, { error: 'Incorrect email or password' }];
      const newSid = randomUUID();
      sessions.set(newSid, body.email);
      return [200, { email: body.email, is_admin: false }, newSid];
    }
    case 'POST /api/auth/logout':
      sessions.delete(sid);
      return [200, { ok: true }];
  }
  // Everything under /api/me needs a session, as in routes_accounts.py.
  if (path.startsWith('/api/me/') && !me) return [401, { error: 'Not signed in' }];
  switch (`${method} ${path}`) {
    case 'GET /api/me/saved':
      return [200, { saved: me.saved }];
    case 'PUT /api/me/saved': {
      const key = `${body.kind}:${body.ref}`;
      me.saved = [{ note: '', ...body, updated_at: new Date().toISOString() }, ...me.saved.filter((s) => `${s.kind}:${s.ref}` !== key)];
      return [200, { saved: me.saved }];
    }
    case 'DELETE /api/me/saved':
      me.saved = me.saved.filter((s) => !(s.kind === body.kind && s.ref === body.ref));
      return [200, { saved: me.saved }];
    case 'GET /api/me/history':
      return [200, { history: me.history }];
    case 'POST /api/me/history':
      me.history = [{ ...body, viewed_at: new Date().toISOString() }, ...me.history].slice(0, 50);
      return [200, { ok: true }];
    case 'POST /api/chat':
      return [200, { answer: 'LD connects with the retrosplenial cortex.', provider: body.ai_provider }];
  }
  return [404, { error: `mock: no route for ${method} ${path}` }];
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') return send(res, 200, 'text/plain', 'ok');
    const mesh = /^\/meshes\/(\d+)\.glb$/.exec(url.pathname);
    if (mesh) return MESHES[mesh[1]] ? send(res, 200, 'model/gltf-binary', MESHES[mesh[1]]) : send(res, 404, 'text/plain', 'no mesh');
    if (url.pathname.startsWith('/api/')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let json = {};
      try {
        if (raw) json = JSON.parse(raw);
      } catch {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'Request body must be JSON' }));
      }
      const sid = /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
      const [status, body, newSid] = await api(req.method, url.pathname, url.searchParams, json, sid);
      if (newSid) res.setHeader('Set-Cookie', `sid=${newSid}; Path=/; HttpOnly; SameSite=Lax`);
      return send(res, status, 'application/json', JSON.stringify(body));
    }
    const file = PAGES[url.pathname] ?? normalize(url.pathname).replace(/^[/\\]+/, '');
    if (file.includes('..')) return send(res, 400, 'text/plain', 'bad path');
    const data = await readFile(join(DIST, file));
    send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', data);
  } catch {
    send(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
  }
}).listen(PORT, () => console.log(`e2e mock server on http://localhost:${PORT}`));

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
