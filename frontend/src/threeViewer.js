import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';

// This file used to be able to freely use things defined in the site's other
// old script file, back when everything was one big page. Now that
// everything is split into separate files, each file has to clearly say
// what it needs from where — so the out-of-bounds click handler further
// down imports exactly what it needs, from wherever that thing ended up
// after the split. (One exception on purpose: `setStatus` is NOT imported
// here, because this file already has its own function also called
// setStatus doing something slightly different further below — and that's
// the one that should be used here, matching how the original code behaved.)
import { API } from './config.js';
import {
  views, highlightLevel,
  setLastLookupData, setLastParcIdx, setLastHighlight, setSuppressSliderReload,
} from './state.js';
import { updatePanel } from './inspectorPanel.js';
import { loadSliceP, fetchAndDrawHighlight } from './sliceViewer.js';

// Flask serves meshes at /meshes/{id}.glb (see App.py route). Meshes are
// downloaded from Allen as the much larger .obj format and converted to
// this smaller one — see convert_meshes_to_glb.py and _ensure_meshes() in
// App.py.
const MESH_BASE = '/meshes/';
const ROOT_STRUCTURE_ID = 997;      // whole-brain root
const CONTEXT_OPACITY = 0.28;        // visible shell (was 0.10 — too faint)
const REGION_OPACITY  = 0.85;

// --- Scene setup ----------------------------------------------------
const canvas = document.getElementById('three-canvas');
const wrap   = document.getElementById('three-wrap');
const statusAcro = document.querySelector('#three-status .three-status-acro');
const statusName = document.querySelector('#three-status .three-status-name');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.localClippingEnabled = true; // per-material clipping planes (eBrain cutaway)

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1012);

const camera = new THREE.PerspectiveCamera(38, 1, 100, 200000);
camera.position.set(14000, 8000, 18000);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.zoomSpeed = 1.0;

// Lighting — matches the 3D-only viewer we built
scene.add(new THREE.AmbientLight(0x3a3428, 0.35));
const key  = new THREE.DirectionalLight(0xfff0d4, 1.1); key.position.set(1, 1.3, 1);  scene.add(key);
const fill = new THREE.DirectionalLight(0x6a88b0, 0.45); fill.position.set(-1, 0.3, -0.8); scene.add(fill);
const rim  = new THREE.DirectionalLight(0xc89f65, 0.5); rim.position.set(0, -1, 0.5); scene.add(rim);

// PIR → Three: flip Y so Superior points up
const rootGroup = new THREE.Group();
rootGroup.scale.y = -1;
scene.add(rootGroup);

let contextMesh = null;   // whole-brain shell
let regionMeshes = [];    // currently-selected region mesh(es)
let initialView = null;   // captured after first framing, for recenter
let axesGroup   = null;

// Slice-plane state. Each view's plane is perpendicular to its "fix" axis:
//   sagittal   fixes Z (L→R)          → plane has normal +Z
//   coronal    fixes X (A→P)          → plane has normal +X
//   transverse fixes Y (S→I, local)   → plane has normal +Y  (rootGroup y-flip handles screen up)
// Slider indices 0..max map linearly onto the mesh's bounding box along that axis.
const slicePlanes  = { sagittal: null, coronal: null, transverse: null };
let   sliceBoundsRef = { value: null }; // { center, size, min, max } in rootGroup-local coords
let   ebrainMode = false; // eBrain-style mode: textured planes + octant cutaway

// Three clipping planes (world-space) used to carve one octant out of the shell
// in eBrain mode. Each is perpendicular to the matching slice plane.
// Normals point toward the REMOVED side; with material.clipIntersection=true,
// a fragment is cut only where ALL three tests fail => carves one octant.
const clipPlanes = {
  coronal:    new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), // normal ±X
  transverse: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), // normal ±Y (world, post y-flip)
  sagittal:   new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), // normal ±Z
};
// Signs: +1 means "cut geometry where that axis is larger than the slice plane".
// Defaults carve the +X / +Y(world, = -Y local post-flip = Superior side) / +Z octant.
let clipSigns = { x: +1, y: +1, z: +1 };

const loader = new GLTFLoader();

// --- Camera framing --------------------------------------------------
function frameMesh(mesh, padding = 1.4) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  if (box.isEmpty()) return;
  const center = new THREE.Vector3();
  const size   = new THREE.Vector3();
  box.getCenter(center); box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * Math.PI / 180;
  const dist = (maxDim / 2) / Math.tan(fov / 2) * padding;

  controls.target.copy(center);
  const dir = new THREE.Vector3(0.8, 0.5, 1.0).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.updateProjectionMatrix();

  const boxRadius = size.length() / 2;
  controls.minDistance = boxRadius * 0.25;   // allow close-in inspection
  controls.maxDistance = boxRadius * 8;      // pull back for full context
  controls.update();
}

// --- Simple axes + anatomical labels --------------------------------
function buildAxes(centerLocal, sizeLocal) {
  if (axesGroup) {
    axesGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    rootGroup.remove(axesGroup);
  }
  axesGroup = new THREE.Group();
  axesGroup.position.copy(centerLocal);
  const len = Math.max(sizeLocal.x, sizeLocal.y, sizeLocal.z) * 0.55;

  const mkLine = (dir, col) => {
    const g = new THREE.BufferGeometry().setFromPoints([
      dir.clone().multiplyScalar(-len),
      dir.clone().multiplyScalar( len),
    ]);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.30, depthTest: false }));
  };
  axesGroup.add(mkLine(new THREE.Vector3(1, 0, 0), 0xc89f65));
  axesGroup.add(mkLine(new THREE.Vector3(0, 1, 0), 0x8fa8c8));
  axesGroup.add(mkLine(new THREE.Vector3(0, 0, 1), 0x8aa882));

  const label = (text, pos, col) => {
    const cvs = document.createElement('canvas');
    cvs.width = 192; cvs.height = 64;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#' + col.toString(16).padStart(6, '0');
    ctx.font = 'italic 34px Georgia, serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 96, 34);
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.position.copy(pos);
    const s = len * 0.22;
    spr.scale.set(s * 3, s, 1);
    axesGroup.add(spr);
  };
  const off = len * 1.08;
  // Axis labels match the visible 3D scene orientation (verified with the
  // user at the default camera). The slice planes and voxel math elsewhere
  // in this file use the mesh-coord convention lp.x=L-R, lp.y=S-I, lp.z=A-P;
  // these sprites are just UI hints placed at the ends of each world axis.
  // Plain abbreviated words, no +/- signs — matches the 2D view headers.
  label('Ant',   new THREE.Vector3(-off, 0, 0), 0x8aa882);
  label('Post',  new THREE.Vector3( off, 0, 0), 0x8aa882);
  label('Sup',   new THREE.Vector3(0, -off, 0), 0x8fa8c8);
  label('Inf',   new THREE.Vector3(0,  off, 0), 0x8fa8c8);
  label('Left',  new THREE.Vector3(0, 0, -off), 0xc89f65);
  label('Right', new THREE.Vector3(0, 0,  off), 0xc89f65);

  rootGroup.add(axesGroup);
}

// --- Slice planes (one per 2D view) ---------------------------------
// Each plane lives in rootGroup's local frame so it inherits the Y-flip.
// Axis mapping (volume ASL per backend docstring):
//   sagittal   idx ∈ [0..Zmax]  → position along +Z (Left→Right),   plane ⟂ Z
//   coronal    idx ∈ [0..Xmax]  → position along +X (Anterior→Post), plane ⟂ X
//   transverse idx ∈ [0..Ymax]  → position along +Y (Superior→Inf),  plane ⟂ Y
const SLICE_AXIS = {
  sagittal:   { axis: 'z', color: 0x00d4ff },  // cyan
  coronal:    { axis: 'x', color: 0xb47aff },  // purple
  transverse: { axis: 'y', color: 0x00e676 },  // green
};

// --- Volume data (for the eBrain cross-section feature) --------------------
// Not fetched until the user turns eBrain on for the first time.
// Left blank on purpose so requests go to whichever address the page itself
// is being served from, instead of a hardcoded address — that way it works
// the same whether you're testing locally or it's live somewhere else.
// While testing locally, Vite (see vite.config.js) forwards these requests
// on to the backend automatically.
const API_BASE = '';
const VOLUME = {
  ready: false,
  loading: null,          // Promise while loading; null when idle
  shape: null,            // [X, Y, Z] voxel counts at the downsampled stride
  stride: 3,              // sampling stride vs. original 10µm array
  originalShape: null,    // [1320, 800, 1140] for world-space scaling
  data: null,             // Uint16Array of parcellation IDs (for JS sampling)
  texture: null,          // THREE.Data3DTexture for shader sampling
  lut: null,              // THREE.DataTexture (RGB per parcellation id)
  maxId: 0,               // largest parcellation id + 1
};

async function loadVolumeIfNeeded() {
  if (VOLUME.ready) return VOLUME;
  if (VOLUME.loading) return VOLUME.loading;
  VOLUME.loading = (async () => {
    // 1) Metadata — from the mesh-derived volume now.
    const metaRes = await fetch(`${API_BASE}/api/mesh_volume_meta`);
    if (!metaRes.ok) throw new Error(`meta HTTP ${metaRes.status}`);
    const meta = await metaRes.json();
    VOLUME.shape = meta.shape;
    VOLUME.stride = meta.stride;
    VOLUME.originalShape = meta.original_shape;
    VOLUME.sceneOrigin = meta.scene_origin_um || null;
    VOLUME.sceneSize   = meta.scene_size_um   || null;
    console.log('[volume] meta:', meta);

    // 2) Volume binary
    const volRes = await fetch(`${API_BASE}/api/mesh_volume`);
    if (!volRes.ok) throw new Error(`volume HTTP ${volRes.status}`);
    const buf = await volRes.arrayBuffer();
    VOLUME.data = new Uint16Array(buf);
    console.log(`[volume] loaded ${(buf.byteLength/1024/1024).toFixed(1)}MB, ${VOLUME.data.length} voxels`);

    // 3) Build Data3DTexture. NumPy C-order (X,Y,Z) with Z fastest;
    // WebGL 3D texture expects width fastest, so width=Z makes byte layouts match.
    const [X, Y, Z] = VOLUME.shape;
    const tex3d = new THREE.Data3DTexture(VOLUME.data, Z, Y, X);
    tex3d.format = THREE.RedIntegerFormat;
    tex3d.internalFormat = 'R16UI';
    tex3d.type = THREE.UnsignedShortType;
    tex3d.minFilter = THREE.NearestFilter;
    tex3d.magFilter = THREE.NearestFilter;
    tex3d.wrapS = THREE.ClampToEdgeWrapping;
    tex3d.wrapT = THREE.ClampToEdgeWrapping;
    tex3d.wrapR = THREE.ClampToEdgeWrapping;
    tex3d.unpackAlignment = 1;
    tex3d.needsUpdate = true;
    VOLUME.texture = tex3d;

    // 4) LUT (color table) — keyed by structure_id now, not parcellation_index.
    const lutRes = await fetch(`${API_BASE}/api/mesh_lut`);
    if (!lutRes.ok) throw new Error(`lut HTTP ${lutRes.status}`);
    const lutBuf = await lutRes.arrayBuffer();
    const lutBytes = new Uint8Array(lutBuf);
    VOLUME.maxId = lutBytes.length / 3;
    const lutRGBA = new Uint8Array(VOLUME.maxId * 4);
    for (let i = 0; i < VOLUME.maxId; i++) {
      lutRGBA[i*4+0] = lutBytes[i*3+0];
      lutRGBA[i*4+1] = lutBytes[i*3+1];
      lutRGBA[i*4+2] = lutBytes[i*3+2];
      lutRGBA[i*4+3] = 255;
    }
    const lutTex = new THREE.DataTexture(lutRGBA, VOLUME.maxId, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    lutTex.minFilter = THREE.NearestFilter;
    lutTex.magFilter = THREE.NearestFilter;
    lutTex.wrapS = THREE.ClampToEdgeWrapping;
    lutTex.wrapT = THREE.ClampToEdgeWrapping;
    lutTex.unpackAlignment = 1;
    lutTex.needsUpdate = true;
    VOLUME.lut = lutTex;
    console.log(`[volume] LUT loaded, ${VOLUME.maxId} entries (structure_id-keyed)`);

    VOLUME.ready = true;
    return VOLUME;
  })().catch(err => {
    VOLUME.loading = null;
    console.error('[volume] load failed:', err);
    throw err;
  });
  return VOLUME.loading;
}

// JavaScript-side voxel sampling: given a world-space point (in rootGroup-local
// coords), return the parcellation_id at that voxel, or 0 if out of range.
// Uses the mesh bounding box as the world-to-voxel transform basis.
function sampleVolumeAtLocal(localPt) {
  if (!VOLUME.ready) return 0;
  const sMin  = VOLUME.sceneOrigin || (sliceBoundsRef.value
    ? [sliceBoundsRef.value.min.x, sliceBoundsRef.value.min.y, sliceBoundsRef.value.min.z] : null);
  const sSize = VOLUME.sceneSize   || (sliceBoundsRef.value
    ? [sliceBoundsRef.value.size.x, sliceBoundsRef.value.size.y, sliceBoundsRef.value.size.z] : null);
  if (!sMin || !sSize) return 0;
  const tx = (localPt.x - sMin[0]) / sSize[0];
  const ty = (localPt.y - sMin[1]) / sSize[1];
  const tz = (localPt.z - sMin[2]) / sSize[2];
  if (tx < 0 || tx > 1 || ty < 0 || ty > 1 || tz < 0 || tz > 1) return 0;
  const [X, Y, Z] = VOLUME.shape;
  const wi = Math.min(Z - 1, Math.floor(tx * Z));
  const hi = Math.min(Y - 1, Math.floor(ty * Y));
  const di = Math.min(X - 1, Math.floor(tz * X));
  const pidx = VOLUME.data[di * Y * Z + hi * Z + wi];
  console.log(`[volume sample] local=(${localPt.x.toFixed(0)},${localPt.y.toFixed(0)},${localPt.z.toFixed(0)}) t=(${tx.toFixed(2)},${ty.toFixed(2)},${tz.toFixed(2)}) numpy_idx=(${di},${hi},${wi}) pidx=${pidx}`);
  return pidx;
}

// --- Mesh-slab cross-sections (eBrain mode) -------------------------------
// On eBrain toggle, preload every region mesh we have on disk. For each
// mesh, build 3 instances (one per slice plane) sharing the same BufferGeometry
// but each with its own 2-plane clipping pair. Then as sliders move, we just
// update the clipping-plane constants — geometry stays resident, visibility
// updates are instant.
let SLAB_HALF = 30;  // world-units half-thickness per slab
const SLAB = {
  ready: false,
  loading: null,
  // view name → pair of THREE.Plane objects bracketing the slice plane
  clipPlanes: {
    sagittal:   [new THREE.Plane(new THREE.Vector3(0,0, 1), 0),
                 new THREE.Plane(new THREE.Vector3(0,0,-1), 0)],
    coronal:    [new THREE.Plane(new THREE.Vector3( 1,0,0), 0),
                 new THREE.Plane(new THREE.Vector3(-1,0,0), 0)],
    transverse: [new THREE.Plane(new THREE.Vector3(0, 1,0), 0),
                 new THREE.Plane(new THREE.Vector3(0,-1,0), 0)],
  },
  // structure_id → { geometry, instances: {sagittal, coronal, transverse} }
  pool: new Map(),
};

// Update the slab-clip planes for one view based on its slice plane's world
// position. Called whenever a slider moves.
function updateSlabForView(view) {
  const g = slicePlanes[view];
  if (!g) return;
  g.updateMatrixWorld(true);
  const wp = new THREE.Vector3();
  wp.setFromMatrixPosition(g.matrixWorld);
  const axis = g.userData.axis;
  const pair = SLAB.clipPlanes[view];
  if (axis === 'x') {
    pair[0].normal.set( 1, 0, 0); pair[0].constant = -(wp.x - SLAB_HALF);
    pair[1].normal.set(-1, 0, 0); pair[1].constant =  (wp.x + SLAB_HALF);
  } else if (axis === 'y') {
    pair[0].normal.set(0,  1, 0); pair[0].constant = -(wp.y - SLAB_HALF);
    pair[1].normal.set(0, -1, 0); pair[1].constant =  (wp.y + SLAB_HALF);
  } else { // z
    pair[0].normal.set(0, 0,  1); pair[0].constant = -(wp.z - SLAB_HALF);
    pair[1].normal.set(0, 0, -1); pair[1].constant =  (wp.z + SLAB_HALF);
  }
}

// Load every available region mesh and add 3 clipped instances per mesh.
// Called once on first eBrain toggle.
async function loadSlabsIfNeeded() {
  if (SLAB.ready) return SLAB;
  if (SLAB.loading) return SLAB.loading;
  SLAB.loading = (async () => {
    console.log('[slab] fetching mesh id list…');
    const r = await fetch(`${API_BASE}/api/available_meshes`);
    const { structure_ids: ids } = await r.json();
    console.log(`[slab] loading ${ids.length} meshes…`);

    let loaded = 0, failed = 0;
    const LIMIT = 12;                 // concurrent mesh fetches
    let i = 0;
    async function worker() {
      while (i < ids.length) {
        const id = ids[i++];
        try {
          const proto = await loadMesh(id, { color: '#c89f65', opacity: 1.0, isContext: false });
          const geom = proto.geometry;
          const entry = { geometry: geom, instances: {} };
          for (const v of Object.keys(SLICE_AXIS)) {
            const mat = new THREE.MeshPhysicalMaterial({
              color: 0xffffff,   // overwritten below per-region
              roughness: 0.55, metalness: 0.05,
              side: THREE.DoubleSide,
              clippingPlanes: SLAB.clipPlanes[v],
              clipIntersection: false,
            });
            // Try to use the region's structure color if we already have the LUT
            if (VOLUME.ready && VOLUME.lut) {
              // Look up from VOLUME.data by first finding a pidx for this sid —
              // not guaranteed. Fallback: keep a neutral tan color.
            }
            const m = new THREE.Mesh(geom, mat);
            m.userData = { structureId: id, view: v, isSlab: true };
            rootGroup.add(m);
            entry.instances[v] = m;
          }
          SLAB.pool.set(id, entry);
          loaded++;
          if (loaded % 20 === 0) console.log(`[slab] ${loaded}/${ids.length}`);
        } catch (e) {
          failed++;
        }
      }
    }
    await Promise.all(Array.from({length: LIMIT}, worker));
    console.log(`[slab] done: ${loaded} loaded, ${failed} failed`);

    // Initial clip-plane positions and color assignment
    for (const v of Object.keys(SLICE_AXIS)) updateSlabForView(v);
    SLAB.ready = true;
    return SLAB;
  })().catch(e => {
    SLAB.loading = null;
    console.error('[slab] load failed:', e);
    throw e;
  });
  return SLAB.loading;
}


function buildSlicePlanes(centerLocal, sizeLocal) {
  // Dispose any previous planes
  for (const v of Object.keys(slicePlanes)) {
    const p = slicePlanes[v];
    if (p) {
      p.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
      rootGroup.remove(p);
    }
    slicePlanes[v] = null;
  }

  // Cache bounds so per-slider updates can compute positions in local space.
  const halfX = sizeLocal.x / 2, halfY = sizeLocal.y / 2, halfZ = sizeLocal.z / 2;
  sliceBoundsRef.value = {
    center: centerLocal.clone(),
    size:   sizeLocal.clone(),
    min:    new THREE.Vector3(centerLocal.x - halfX, centerLocal.y - halfY, centerLocal.z - halfZ),
    max:    new THREE.Vector3(centerLocal.x + halfX, centerLocal.y + halfY, centerLocal.z + halfZ),
  };

  // Match the shell's bounding box exactly so planes don't stick out past it.
  const pad = 1.00;

  for (const v of Object.keys(SLICE_AXIS)) {
    const { axis, color } = SLICE_AXIS[v];
    // Plane dimensions = the two axes orthogonal to the fix axis, padded
    let w, h; // plane geometry is in its local XY
    if (axis === 'x') { w = sizeLocal.z * pad; h = sizeLocal.y * pad; }
    else if (axis === 'y') { w = sizeLocal.x * pad; h = sizeLocal.z * pad; }
    else /* z */      { w = sizeLocal.x * pad; h = sizeLocal.y * pad; }

    const geom = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.18,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);

    // Orient the plane. PlaneGeometry is built on +Z-normal by default.
    if (axis === 'x') mesh.rotation.y =  Math.PI / 2;  // normal → +X
    if (axis === 'y') mesh.rotation.x = -Math.PI / 2;  // normal → +Y

    // Outline so the plane is legible when viewed edge-on
    const edgeGeom = new THREE.EdgesGeometry(geom);
    const edgeMat  = new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.85, depthTest: false,
    });
    const edges = new THREE.LineSegments(edgeGeom, edgeMat);
    mesh.add(edges);

    const group = new THREE.Group();
    group.add(mesh);
    group.userData.axis  = axis;
    group.userData.mesh  = mesh;   // the quad itself (for texture swaps)
    group.userData.tint  = color;  // base tint color for non-eBrain mode
    group.userData.edges = edges;
    rootGroup.add(group);
    slicePlanes[v] = group;
  }
}

// Build (once) a ShaderMaterial per plane that samples the 3D volume texture
// and looks up the color in the LUT. Called the first time eBrain mode needs
// a volume-rendering plane, after VOLUME.ready == true.
function _makeVolumeMaterial(view) {
  if (!VOLUME.ready || !sliceBoundsRef.value) return null;
  // Use the volume's recorded scene bounds (from meshes_volume.json) so the
  // shader samples exactly where the voxelizer placed the data — even when
  // the voxel grid doesn't fill the shell's bounding box.
  const sMin  = VOLUME.sceneOrigin || [sliceBoundsRef.value.min.x,
                                       sliceBoundsRef.value.min.y,
                                       sliceBoundsRef.value.min.z];
  const sSize = VOLUME.sceneSize   || [sliceBoundsRef.value.size.x,
                                       sliceBoundsRef.value.size.y,
                                       sliceBoundsRef.value.size.z];
  const uniforms = {
    uVolume:   { value: VOLUME.texture },
    uLUT:      { value: VOLUME.lut },
    uLUTSize:  { value: VOLUME.maxId },
    uBoundsMin:  { value: new THREE.Vector3(sMin[0], sMin[1], sMin[2]) },
    uBoundsSize: { value: new THREE.Vector3(sSize[0], sSize[1], sSize[2]) },
    uShape:      { value: new THREE.Vector3(VOLUME.shape[0], VOLUME.shape[1], VOLUME.shape[2]) },
    uTint:     { value: new THREE.Color(g_userDataTintOf(view)) },
    uTintAmt:  { value: 0.0 },
    // Hover highlight — set by the 3D pointermove handler. When uHoverId > 0,
    // fragments whose parcellation idx == uHoverId are brightened / tinted.
    uHoverId:     { value: 0 },
    uHoverColor:  { value: new THREE.Color(0xffffff) },
    uHoverAmt:    { value: 0.55 },
    // Whole-plane wash when the pointer is over this plane (so the active
    // plane stands out even before a region-hit resolves).
    uPlaneActive: { value: 0.0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: false,
    side: THREE.DoubleSide,
    glslVersion: THREE.GLSL3,  // needed for usampler3D
    vertexShader: `
      out vec3 vLocalPos;
      void main() {
        // Plane is a child of rootGroup; we want the position in rootGroup-local
        // coords (which matches the volume's ASL frame). 'position' is the
        // geometry vertex in plane-local space; plane's modelMatrix in Three.js
        // already includes translation/rotation within rootGroup. So the local
        // position we want is (modelMatrix * position).xyz — but Three.js's
        // 'modelMatrix' is the full world transform (includes rootGroup).
        // rootGroup only applies scale.y = -1, which we undo below.
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vLocalPos = vec3(worldPos.x, -worldPos.y, worldPos.z); // undo y-flip
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      precision highp float;
      precision highp int;
      precision highp usampler3D;
      in vec3 vLocalPos;
      uniform usampler3D uVolume;
      uniform sampler2D  uLUT;
      uniform float      uLUTSize;
      uniform vec3       uBoundsMin;
      uniform vec3       uBoundsSize;
      uniform vec3       uShape;
      uniform vec3       uTint;
      uniform float      uTintAmt;
      uniform uint       uHoverId;
      uniform vec3       uHoverColor;
      uniform float      uHoverAmt;
      uniform float      uPlaneActive;
      out vec4 fragColor;

      // Outline: sample 4 neighboring pixels along the plane's in-plane axes.
      // If any neighbor has a different id, this pixel is on a region boundary.
      // The neighbor offset is 1 voxel worth of texcoord along each of the
      // two in-plane axes. We approximate by stepping in every direction and
      // keeping the max id-difference.
      uint sampleId(vec3 t) {
        if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return 0u;
        return texture(uVolume, vec3(t.x, t.y, t.z)).r;
      }

      void main() {
        vec3 t = (vLocalPos - uBoundsMin) / uBoundsSize;
        if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) {
          fragColor = vec4(0.0); discard;
        }
        uint id = texture(uVolume, vec3(t.x, t.y, t.z)).r;
        if (id == 0u) { fragColor = vec4(0.0, 0.0, 0.0, 0.0); discard; }

        float u = (float(id) + 0.5) / uLUTSize;
        vec3 col = texture(uLUT, vec2(u, 0.5)).rgb;
        if (dot(col, vec3(1.0)) < 0.01) col = vec3(0.25, 0.25, 0.28);

        // Region-boundary outlines: sample 4 neighbors at 1-voxel offsets
        // in each axis. If any neighbor has a different id, darken this pixel.
        vec3 texel = 1.0 / uShape;   // 1 voxel in normalized coords (per axis)
        // Sample along each axis; planes are axis-aligned so two of these
        // offsets end up "on" the plane and one "through" it, but that's fine.
        uint a = sampleId(t + vec3( texel.x, 0.0, 0.0));
        uint b = sampleId(t + vec3(-texel.x, 0.0, 0.0));
        uint c = sampleId(t + vec3(0.0,  texel.y, 0.0));
        uint d = sampleId(t + vec3(0.0, -texel.y, 0.0));
        uint e = sampleId(t + vec3(0.0, 0.0,  texel.z));
        uint f = sampleId(t + vec3(0.0, 0.0, -texel.z));
        bool edge = (a != id) || (b != id) || (c != id) || (d != id) || (e != id) || (f != id);
        if (edge) col *= 0.35;   // darken the pixel into a thin line

        col = mix(col, uTint, uTintAmt);

        // Hover highlight: when the pointer is over this plane and we've
        // resolved an idx under it, light up every fragment whose idx matches.
        if (uHoverId > 0u && id == uHoverId) {
          col = mix(col, uHoverColor, uHoverAmt);
        }
        // Subtle wash over the whole plane so the "active" plane is obvious
        // even before the hover-id lookup resolves.
        if (uPlaneActive > 0.0) {
          col = mix(col, uTint, uPlaneActive * 0.12);
        }
        fragColor = vec4(col, 1.0);
      }
    `,
  });
  return mat;
}

// Helper to read a plane's tint without depending on object lookup order.
function g_userDataTintOf(view) {
  return (slicePlanes[view]?.userData?.tint) || 0xffffff;
}

// Swap a plane between tinted-preview (normal mode) and volume-rendered
// cross-section (eBrain mode). Clicks still work on both (transparent mode
// mesh still blocks raycasts; volume mode is opaque).
function applyPlaneAppearance(view) {
  const g = slicePlanes[view];
  if (!g) return;
  const mesh = g.userData.mesh;
  const tint = g.userData.tint;
  if (ebrainMode) {
    if (VOLUME.ready) {
      if (!g.userData.volumeMat) g.userData.volumeMat = _makeVolumeMaterial(view);
      if (!g.userData.previewMat) g.userData.previewMat = mesh.material;
      if (g.userData.volumeMat) mesh.material = g.userData.volumeMat;
    } else {
      // Volume not yet loaded: keep the plane pickable but invisible
      mesh.material.color.set(tint);
      mesh.material.map = null;
      mesh.material.opacity = 0.0;
      mesh.material.transparent = true;
      mesh.material.depthWrite = false;
      mesh.material.needsUpdate = true;
    }
    if (g.userData.edges) g.userData.edges.visible = true;
  } else {
    if (g.userData.previewMat) mesh.material = g.userData.previewMat;
    mesh.material.color.set(tint);
    mesh.material.opacity = 0.18;
    mesh.material.transparent = true;
    mesh.material.depthWrite = false;
    mesh.material.map = null;
    mesh.material.needsUpdate = true;
    if (g.userData.edges) g.userData.edges.visible = true;
  }
}

function applyShellAppearance() {
  if (!contextMesh) return;
  const mat = contextMesh.material;
  if (ebrainMode) {
    // Solid opaque shell. Use DoubleSide so the cutaway reveals the interior
    // walls cleanly regardless of rootGroup's y-flip winding quirk.
    mat.color.set(0xeef0f4);
    mat.opacity = 1.0;
    mat.transparent = false;
    mat.depthWrite = true;
    mat.side = THREE.DoubleSide;
    mat.emissiveIntensity = 0.0;
    mat.roughness = 0.6;
  } else {
    // Translucent ghost look (original BackSide after y-flip = outer surface)
    mat.color.set(0xe8ecf2);
    mat.opacity = CONTEXT_OPACITY;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.BackSide;
    mat.emissiveIntensity = 0.35;
    mat.roughness = 0.55;
  }
  mat.needsUpdate = true;
}

// Per-view cache for the composited texture: offscreen canvas, cached slice
// image, cached highlight image. Reused on highlight changes without re-fetching.
const _planeComposite = {
  sagittal:   { canvas: null, ctx: null, sliceImg: null, maskImg: null, texture: null },
  coronal:    { canvas: null, ctx: null, sliceImg: null, maskImg: null, texture: null },
  transverse: { canvas: null, ctx: null, sliceImg: null, maskImg: null, texture: null },
};

function _getPlaneCanvas(view, w, h) {
  const pc = _planeComposite[view];
  if (!pc.canvas) {
    pc.canvas = document.createElement('canvas');
    pc.ctx = pc.canvas.getContext('2d');
  }
  if (pc.canvas.width !== w || pc.canvas.height !== h) {
    pc.canvas.width = w; pc.canvas.height = h;
  }
  return pc;
}

function _redrawPlaneComposite(view) {
  const pc = _planeComposite[view];
  if (!pc.canvas || !pc.sliceImg) return;
  const w = pc.canvas.width, h = pc.canvas.height;
  pc.ctx.clearRect(0, 0, w, h);
  pc.ctx.drawImage(pc.sliceImg, 0, 0, w, h);
  if (pc.maskImg && pc.maskImg.naturalWidth) {
    pc.ctx.drawImage(pc.maskImg, 0, 0, w, h);
  }
  if (pc.texture) pc.texture.needsUpdate = true;
}

// Update the slice image for a plane (called when a new /api/slice PNG loads).
function updatePlaneTexture(view, imgEl) {
  if (!ebrainMode) return;
  const g = slicePlanes[view];
  if (!g) return;
  if (!imgEl) {
    imgEl = document.querySelector(`.view-cell[data-view="${view}"] .atlas-img`);
  }
  if (!imgEl || !imgEl.src || !imgEl.naturalWidth) return;

  const pc = _getPlaneCanvas(view, imgEl.naturalWidth, imgEl.naturalHeight);
  pc.sliceImg = imgEl;
  _redrawPlaneComposite(view);

  // First time: build a CanvasTexture that reads from our offscreen canvas.
  if (!pc.texture) {
    const tex = new THREE.CanvasTexture(pc.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    if (view === 'coronal' || view === 'sagittal') {
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.set(1, -1);
      tex.offset.set(0, 1);
    }
    pc.texture = tex;
    const mesh = g.userData.mesh;
    if (mesh.material.map && mesh.material.map !== tex) mesh.material.map.dispose();
    mesh.material.map = tex;
    mesh.material.needsUpdate = true;
  }
  pc.texture.needsUpdate = true;
}

// Update the highlight overlay for a plane (called when a new highlight mask
// is drawn on the matching 2D .hl-canvas). Accepts a data-URL or an Image.
function updatePlaneHighlight(view, maskSrc) {
  if (!ebrainMode) return;
  const pc = _planeComposite[view];
  if (!pc) return;
  if (!maskSrc) {
    pc.maskImg = null;
    _redrawPlaneComposite(view);
    return;
  }
  const img = new Image();
  img.onload = () => {
    pc.maskImg = img;
    _redrawPlaneComposite(view);
  };
  img.src = (typeof maskSrc === 'string') ? maskSrc : maskSrc.src;
}

function updateSlicePlane(view, idx, sliderMax, sliderMin = 0) {
  const g = slicePlanes[view];
  const b = sliceBoundsRef.value;
  if (!g || !b || sliderMax === sliderMin) return;
  const t = Math.max(0, Math.min(1, (idx - sliderMin) / (sliderMax - sliderMin)));
  const axis = g.userData.axis;
  // Start from the shell center, then override only the fix axis
  g.position.copy(b.center);
  if (axis === 'x') g.position.x = b.min.x + t * b.size.x;
  if (axis === 'y') g.position.y = b.min.y + t * b.size.y;
  if (axis === 'z') g.position.z = b.min.z + t * b.size.z;
  // Update slab clipping to follow the plane
  updateSlabForView(view);
  // Cutaway follows the slice plane intersection (eBrain mode)
  if (ebrainMode) updateClipPlanes();
}

function setSlicePlaneVisible(view, visible) {
  const g = slicePlanes[view];
  if (g) g.visible = visible;
}

// Recompute the three clipping planes from the current slice plane positions.
// Convention: clipSigns.{x,y,z} = +1 means "cut the positive-axis side"
// (+x = P, +y = S-world, +z = R). -1 cuts the opposite side.
// Plane equation: normal·p + constant < 0 => fragment clipped.
// To clip where (sign * coord > sign * pos), we set:
//   normal = (-sign, 0, 0), constant = sign * pos   for the X plane, etc.
function updateClipPlanes() {
  if (!sliceBoundsRef.value) return;
  const worldPos = new THREE.Vector3();
  for (const v of ['coronal', 'transverse', 'sagittal']) {
    const g = slicePlanes[v];
    const p = clipPlanes[v];
    if (!g) continue;
    g.updateMatrixWorld(true);
    worldPos.setFromMatrixPosition(g.matrixWorld);
    if (v === 'coronal')    { p.normal.set(-clipSigns.x, 0, 0); p.constant = clipSigns.x * worldPos.x; }
    if (v === 'transverse') { p.normal.set(0, -clipSigns.y, 0); p.constant = clipSigns.y * worldPos.y; }
    if (v === 'sagittal')   { p.normal.set(0, 0, -clipSigns.z); p.constant = clipSigns.z * worldPos.z; }
  }
}

// Camera-following cutaway: pick the octant (relative to the slice-plane
// intersection) that the camera is currently looking from, and cut that one.
// For each axis, sign is +1 if the camera sits on the +axis side of the
// corresponding slice plane, else -1. Returns true if any sign changed.
const _cornerTmp = new THREE.Vector3();
const _camTmp    = new THREE.Vector3();
function updateClipSignsFromCamera() {
  const g = slicePlanes.coronal && slicePlanes.transverse && slicePlanes.sagittal;
  if (!g) return false;
  // World position of the cut corner = intersection of the three slice planes.
  // Each plane's group has a position; combine the axis we care about from each.
  slicePlanes.coronal.updateMatrixWorld(true);
  slicePlanes.transverse.updateMatrixWorld(true);
  slicePlanes.sagittal.updateMatrixWorld(true);
  const cx = new THREE.Vector3().setFromMatrixPosition(slicePlanes.coronal.matrixWorld).x;
  const cy = new THREE.Vector3().setFromMatrixPosition(slicePlanes.transverse.matrixWorld).y;
  const cz = new THREE.Vector3().setFromMatrixPosition(slicePlanes.sagittal.matrixWorld).z;
  _cornerTmp.set(cx, cy, cz);
  _camTmp.copy(camera.position);

  const nx = _camTmp.x > _cornerTmp.x ? +1 : -1;
  const ny = _camTmp.y > _cornerTmp.y ? +1 : -1;
  const nz = _camTmp.z > _cornerTmp.z ? +1 : -1;

  if (nx !== clipSigns.x || ny !== clipSigns.y || nz !== clipSigns.z) {
    clipSigns.x = nx; clipSigns.y = ny; clipSigns.z = nz;
    return true;
  }
  return false;
}

// Attach the three clip planes to the shell material (eBrain mode) or detach.
function applyShellClipping() {
  if (!contextMesh) return;
  const mat = contextMesh.material;
  if (ebrainMode) {
    updateClipPlanes(); // set plane normals + constants first
    mat.clippingPlanes = [clipPlanes.coronal, clipPlanes.transverse, clipPlanes.sagittal];
    mat.clipIntersection = true;  // cut only the octant where ALL 3 tests fail
    mat.clipShadows = false;
    console.log('[eBrain] clipping ON; planes =', mat.clippingPlanes.map(pl => ({
      n: pl.normal.toArray(), c: pl.constant
    })));
  } else {
    mat.clippingPlanes = [];
    mat.clipIntersection = false;
    console.log('[eBrain] clipping OFF');
  }
  mat.needsUpdate = true;
}

// --- Mesh loading ---------------------------------------------------
function makeMaterial(hex, opacity, isContext) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(hex),
    roughness: 0.55, metalness: 0.05, clearcoat: 0.15,
    transparent: true, opacity,
    depthWrite: !isContext,
    side: isContext ? THREE.BackSide : THREE.FrontSide,
    // Shell uses BackSide which can look dim; a soft emissive keeps it readable.
    emissive: isContext ? new THREE.Color(hex) : new THREE.Color(0x000000),
    emissiveIntensity: isContext ? 0.35 : 0,
  });
}

async function loadMesh(id, { color = '#c89f65', opacity = REGION_OPACITY, isContext = false } = {}) {
  return new Promise((resolve, reject) => {
    loader.load(
      MESH_BASE + id + '.glb',
      gltf => {
        let mesh = null;
        gltf.scene.traverse(o => { if (o.isMesh && !mesh) mesh = o; });
        if (!mesh) { reject(new Error('empty mesh')); return; }
        if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
        mesh.material = makeMaterial(color, opacity, isContext);
        mesh.userData.structureId = id;
        resolve(mesh);
      },
      undefined,
      err => reject(err)
    );
  });
}

// Set the whole-brain shell on startup (if the file is available)
async function initShell() {
  try {
    const mesh = await loadMesh(ROOT_STRUCTURE_ID, { color: '#e8ecf2', opacity: CONTEXT_OPACITY, isContext: true });
    contextMesh = mesh;
    rootGroup.add(mesh);

    // Frame camera on whole brain, also build axes
    frameMesh(mesh);
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const c = new THREE.Vector3(), s = new THREE.Vector3();
    bb.getCenter(c); bb.getSize(s);
    buildAxes(c, s);
    buildSlicePlanes(c, s);

    // Seed each plane from the DOM's current slider value
    document.querySelectorAll('.view-cell').forEach(cell => {
      const v = cell.dataset.view;
      if (!v || !SLICE_AXIS[v]) return;
      const sl = cell.querySelector('.idx-slider');
      if (sl) updateSlicePlane(v, parseInt(sl.value), parseInt(sl.max), parseInt(sl.min));
    });

    // Capture initial view for recenter
    initialView = { position: camera.position.clone(), target: controls.target.clone() };
  } catch (e) {
    console.warn('3D: root shell unavailable', e);
    setStatus('—', 'shell unavailable — meshes/ folder missing?');
  }
}

// --- Smooth camera tween --------------------------------------------
let tween = null;
function tweenTo(toPos, toTarget, dur = 600) {
  tween = {
    fromPos: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toPos: toPos.clone(), toTarget: toTarget.clone(),
    t0: performance.now(), dur,
  };
}
controls.addEventListener('start', () => { tween = null; });

// --- Public API ------------------------------------------------------
function setStatus(acro, name) {
  statusAcro.textContent = acro || '—';
  statusName.textContent = name || '';
}

function clearRegionMeshes(){
  for (const m of regionMeshes) {
    rootGroup.remove(m);
    m.geometry?.dispose();
    m.material?.dispose();
  }
  regionMeshes = [];
}

window.brain3d = {
  // Populated by _initMeshCatalog() on startup. Set of Allen structure_ids
  // for which a mesh is actually on disk. Used by showRegion() to walk
  // up the ontology tree if the requested id has no mesh (e.g. CCFv3 doesn't
  // delineate MOBgr as a separate 3D mesh, so we fall back to its parent MOB).
  _availableMeshIds: null,
  _parentOfStructureId: null,  // Map<id, parentId>

  async showRegion(id, info = {}) {
    if (!id) return;
    clearRegionMeshes();
    setStatus(info.acronym || '...', 'loading ' + (info.name || `structure ${id}`));

    // ── Forced collapse ──────────────────────────────────────────────────
    // Certain structures should ALWAYS show their own mesh, never a child's,
    // regardless of how specifically the click resolved. Main Olfactory Bulb
    // (MOB, sid 507) is the canonical case: its layered children (MOBgl,
    // MOBopl, MOBmi, MOBipl, MOBgr) don't have CCFv3 meshes individually —
    // and even if future atlas versions add them, we want MOB-level fidelity
    // rather than a confusing flash of a single layer.
    //
    // Before the ancestor walk runs, check whether `id` is in (or a
    // descendant of) any forced-collapse ancestor; if so, snap `id` up to
    // that ancestor first.
    const FORCED_COLLAPSE_ANCESTORS = [507];   // MOB; extend with more sids if needed
    if (this._parentOfStructureId) {
      const walkAncestors = sid => {
        const out = [sid];
        let cur = sid;
        const seen = new Set([sid]);
        while (true) {
          const p = this._parentOfStructureId.get(cur);
          if (!p || p === cur || seen.has(p)) break;
          out.push(p);
          seen.add(p);
          cur = p;
        }
        return out;
      };
      const chain = walkAncestors(id);
      const collapseTarget = chain.find(sid => FORCED_COLLAPSE_ANCESTORS.includes(sid));
      if (collapseTarget && collapseTarget !== id) {
        console.log(`[3D] forced collapse: ${id} → ${collapseTarget} ` +
                    `(${id} is a descendant of a forced-collapse ancestor)`);
        id = collapseTarget;
      }
    }

    // ── Ancestor fallback ────────────────────────────────────────────────
    // If the requested id has no mesh on disk, walk up the ontology until we
    // hit an ancestor that does, and show that as an approximation (e.g.
    // MOBgr → MOB). A parent's shape is still real, useful spatial context —
    // the actual problem with this isn't showing it, it's showing it without
    // making the substitution obvious. So this always names the substitute
    // structure explicitly in the status line below, not just a generic note.
    //
    // Stop short of the root node: root's mesh IS the context shell that's
    // already displayed, so "falling back to root" just re-loads the shell
    // on top of itself and looks like nothing happened. Better to say so.
    //
    // This is 3D-only. Whether the 2D views can show the EXACT structure is
    // a separate, unrelated fact (voxels in the CCFv3 annotation volume or
    // not) reported elsewhere (the ontology tree's grey-out, the "no voxels
    // in the CCFv3 annotation volume" status messages in ontology.js/
    // searchPanel.js) — it doesn't change based on whether 3D found a parent
    // mesh to approximate with, and this fallback doesn't change whether
    // those messages fire.
    const originalId = id;
    const fallbackTrail = [];
    let walkedToRoot = false;
    if (this._availableMeshIds && this._parentOfStructureId) {
      let cur = id;
      const seen = new Set();   // cycle guard; the tree shouldn't have cycles but better safe
      while (cur && cur !== ROOT_STRUCTURE_ID && !this._availableMeshIds.has(cur)) {
        if (seen.has(cur)) break;
        seen.add(cur);
        fallbackTrail.push(cur);
        const parent = this._parentOfStructureId.get(cur);
        if (!parent || parent === cur) { cur = null; break; }
        cur = parent;
      }
      if (cur === ROOT_STRUCTURE_ID) {
        walkedToRoot = true;
      } else if (cur && cur !== originalId) {
        id = cur;
        console.log(`[3D] mesh ${originalId} not on disk; falling back to ancestor ${cur} ` +
                    `(trail: ${fallbackTrail.join(' → ')} → ${cur})`);
      }
    }

    if (walkedToRoot) {
      console.log(`[3D] no mesh available for ${originalId} or any non-root ancestor ` +
                  `(trail: ${fallbackTrail.join(' → ')} → root)`);
      setStatus(info.acronym || '—',
        (info.name || `structure ${originalId}`) + ' · no 3D mesh for this structure or any parent');
      return;
    }

    try {
      const color = info.color || '#ffb74a';
      const mesh = await loadMesh(id, { color, opacity: REGION_OPACITY, isContext: false });
      regionMeshes.push(mesh);
      rootGroup.add(mesh);
      if (id !== originalId) {
        const sub = this._nameOfStructureId?.get(id);
        const subLabel = sub ? (sub.name || sub.acronym || `structure ${id}`) : `structure ${id}`;
        setStatus(info.acronym || '—',
          `${info.name || 'structure ' + originalId} · not modeled separately in 3D — showing parent shape "${subLabel}" instead`);
      } else {
        setStatus(info.acronym || '—', info.name || `structure ${id}`);
      }
    } catch (err) {
      const is404 = err && err.target && err.target.status === 404;
      const msg = is404 ? 'no 3D mesh to display' : 'failed to load mesh';
      setStatus(info.acronym || '—', msg);
    }
  },
  recenter() {
    if (initialView) tweenTo(initialView.position, initialView.target);
  },
  toggleShell() {
    if (!contextMesh) return false;
    contextMesh.visible = !contextMesh.visible;
    return contextMesh.visible;
  },
  clear() {
    clearRegionMeshes();
    setStatus('idle', 'click a region to load its mesh');
  },
  // Drive the 3D slice planes from the 2D sliders.
  // view: 'sagittal' | 'coronal' | 'transverse'
  setSlice(view, idx, sliderMax, sliderMin) {
    updateSlicePlane(view, idx, sliderMax, sliderMin);
  },
  showSlicePlane(view, visible) {
    setSlicePlaneVisible(view, visible);
  },
  // Called by the 2D code after a slice image finishes loading,
  // so the 3D textured plane (in eBrain mode) refreshes to match.
  // Optionally accepts the freshly-loaded <img> to avoid DOM read races.
  refreshPlaneTexture(view, imgEl) {
    updatePlaneTexture(view, imgEl);
  },
  // Called by the 2D code after a highlight mask is drawn on .hl-canvas,
  // so the 3D plane composites the same mask on top of its slice texture.
  refreshPlaneHighlight(view, maskSrc) {
    updatePlaneHighlight(view, maskSrc);
  },
  isEbrain() { return ebrainMode; },
  // eBrain mode: volume-rendered slice planes (from the mesh-derived volume)
  // + octant cutaway on the shell.
  toggleEbrain() {
    ebrainMode = !ebrainMode;
    for (const v of Object.keys(slicePlanes)) applyPlaneAppearance(v);
    applyShellAppearance();
    applyShellClipping();
    if (ebrainMode) {
      loadVolumeIfNeeded().then(() => {
        if (!ebrainMode) return;
        for (const v of Object.keys(slicePlanes)) applyPlaneAppearance(v);
      }).catch(err => console.error('[ebrain] volume load failed:', err));
    } else {
      // Leaving ebrain mode — clear all pointer-driven state so nothing looks
      // stale (click marker, hover highlight, coord strip, last-click).
      if (typeof _hideClickMarker === 'function') _hideClickMarker();
      if (typeof _hideProbe === 'function') _hideProbe();
      if (typeof _voxelMarker !== 'undefined' && _voxelMarker) _voxelMarker.visible = false;
      const cclick = document.getElementById('three-cclick');
      if (cclick) { cclick.textContent = '—'; cclick.classList.remove('has-data'); }
    }
    return ebrainMode;
  },
};

// --- Animation loop + resize ----------------------------------------
function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
function animate() {
  resize();
  if (tween) {
    const k = Math.min(1, (performance.now() - tween.t0) / tween.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    if (k === 1) tween = null;
  }
  controls.update();
  // Camera-following cutaway: recompute which octant faces the camera and
  // refresh the clip planes only if that octant changed.
  if (ebrainMode) {
    if (updateClipSignsFromCamera()) updateClipPlanes();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
window.addEventListener('resize', resize);

// Toolbar wiring
document.getElementById('three-recenter').addEventListener('click', () => window.brain3d.recenter());
document.getElementById('three-shell-toggle').addEventListener('click', (e) => {
  const visible = window.brain3d.toggleShell();
  e.currentTarget.classList.toggle('active', visible);
});
document.getElementById('three-ebrain-toggle').addEventListener('click', (e) => {
  const on = window.brain3d.toggleEbrain();
  e.currentTarget.classList.toggle('active', on);
});

// --- 3D click → volume sample → region lookup (eBrain mode only) ----------
// Raycast to the plane hit point, convert to rootGroup-local space, sample
// the in-memory annotation volume at that voxel to get the parcellation_id
// directly. No UV math, no axis flips — just world coords → voxel → id.
const _rayMouse = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
let _mouseDownPos = null;

// Pointer-coord strip elements (beneath the 3D canvas)
const _coordElX = document.getElementById('three-cx');
const _coordElY = document.getElementById('three-cy');
const _coordElZ = document.getElementById('three-cz');
const _coordElClick = document.getElementById('three-cclick');

function _setCoordStripLocal(lp) {
  if (!_coordElX) return;
  if (lp) {
    _coordElX.textContent = lp.x.toFixed(0);
    _coordElY.textContent = lp.y.toFixed(0);
    _coordElZ.textContent = lp.z.toFixed(0);
    _coordElX.classList.add('has-data');
    _coordElY.classList.add('has-data');
    _coordElZ.classList.add('has-data');
  } else {
    _coordElX.textContent = '—';
    _coordElY.textContent = '—';
    _coordElZ.textContent = '—';
    _coordElX.classList.remove('has-data');
    _coordElY.classList.remove('has-data');
    _coordElZ.classList.remove('has-data');
  }
}

// --- Click marker: a small wireframe sphere in the scene that marks the
// last-click position on whichever plane was clicked. Parented to rootGroup
// so it inherits the y-flip and stays glued to the brain as the camera moves.
let _clickMarker = null;
let _clickMarkerRing = null;   // outer ring on the plane's surface
function _ensureClickMarker() {
  if (_clickMarker) return _clickMarker;
  // Solid inner sphere
  const geom = new THREE.SphereGeometry(45, 16, 12);
  const mat  = new THREE.MeshBasicMaterial({
    color: 0xffb74a, transparent: true, opacity: 0.95, depthTest: false,
  });
  _clickMarker = new THREE.Mesh(geom, mat);
  _clickMarker.renderOrder = 999;
  _clickMarker.visible = false;
  rootGroup.add(_clickMarker);

  // Outer ring (drawn as a thin torus) so the marker reads on any background
  const ringGeom = new THREE.TorusGeometry(80, 6, 8, 32);
  const ringMat  = new THREE.MeshBasicMaterial({
    color: 0xffb74a, transparent: true, opacity: 0.85, depthTest: false,
  });
  _clickMarkerRing = new THREE.Mesh(ringGeom, ringMat);
  _clickMarkerRing.renderOrder = 998;
  _clickMarkerRing.visible = false;
  _clickMarker.add(_clickMarkerRing);
  return _clickMarker;
}

function _placeClickMarker(worldPoint, view) {
  const m = _ensureClickMarker();
  // worldPoint is in three.js world space; rootGroup has scale.y = -1, so
  // we convert to rootGroup-local once and set position in that frame.
  const local = rootGroup.worldToLocal(worldPoint.clone());
  m.position.copy(local);
  m.visible = true;
  _clickMarkerRing.visible = true;
  // Orient the ring so its plane matches the slice plane (flat on the plane)
  // TorusGeometry lies in the XY plane (normal = +Z). We rotate it so its
  // normal matches the slice axis.
  _clickMarkerRing.rotation.set(0, 0, 0);
  if (view === 'coronal')    _clickMarkerRing.rotation.y =  Math.PI / 2; // normal → X
  else if (view === 'transverse') _clickMarkerRing.rotation.x =  Math.PI / 2; // normal → Y
  // sagittal: TorusGeometry normal is already +Z → no rotation needed
  // Color the marker in the plane's tint so it's obvious which plane owns it
  const tint = (slicePlanes[view]?.userData?.tint) ?? 0xffb74a;
  m.material.color.setHex(tint);
  _clickMarkerRing.material.color.setHex(tint);

  // --- Diagnostic: also place a SECOND marker at the back-computed center
  // of the voxel the JS sampler picked. If the painted color under the cursor
  // differs from where this marker lands, the shader and the JS sampler are
  // reading different voxels for the same world point → alignment bug.
  _placeVoxelCenterMarker(local);
}

// Diagnostic marker: positions a small cross at the mesh-space center of the
// voxel that the JS sampler believes was hit. Call with lp = rootGroup-local
// point. Marker becomes a child of rootGroup so it inherits the y-flip, just
// like the click-marker sphere.
let _voxelMarker = null;
function _ensureVoxelMarker() {
  if (_voxelMarker) return _voxelMarker;
  const g = new THREE.Group();
  // Three tiny orthogonal lines (a 3D "+") so the marker is visible from any angle
  const makeLine = (dx, dy, dz, col) => {
    const L = 120;
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-dx*L, -dy*L, -dz*L),
      new THREE.Vector3( dx*L,  dy*L,  dz*L),
    ]);
    return new THREE.Line(geom, new THREE.LineBasicMaterial({
      color: col, transparent: true, opacity: 0.95, depthTest: false,
    }));
  };
  g.add(makeLine(1, 0, 0, 0xff4444));  // x = L-R
  g.add(makeLine(0, 1, 0, 0x44ff44));  // y = S-I
  g.add(makeLine(0, 0, 1, 0x4488ff));  // z = A-P
  g.traverse(o => { o.renderOrder = 1000; });
  g.visible = false;
  rootGroup.add(g);
  _voxelMarker = g;
  return g;
}
function _placeVoxelCenterMarker(lp) {
  if (!VOLUME.ready) return;
  const sMin  = VOLUME.sceneOrigin, sSize = VOLUME.sceneSize;
  if (!sMin || !sSize) return;
  const [X, Y, Z] = VOLUME.shape;
  const tx = (lp.x - sMin[0]) / sSize[0];
  const ty = (lp.y - sMin[1]) / sSize[1];
  const tz = (lp.z - sMin[2]) / sSize[2];
  if (tx < 0 || tx > 1 || ty < 0 || ty > 1 || tz < 0 || tz > 1) return;
  const wi = Math.min(Z - 1, Math.floor(tx * Z));  // L-R idx
  const hi = Math.min(Y - 1, Math.floor(ty * Y));  // S-I idx
  const di = Math.min(X - 1, Math.floor(tz * X));  // A-P idx
  // Center of that voxel in scene coords
  const cx = sMin[0] + (wi + 0.5) / Z * sSize[0];
  const cy = sMin[1] + (hi + 0.5) / Y * sSize[1];
  const cz = sMin[2] + (di + 0.5) / X * sSize[2];
  const m = _ensureVoxelMarker();
  m.position.set(cx, cy, cz);
  m.visible = true;
  const pidx = VOLUME.data[di * Y * Z + hi * Z + wi];
  console.log(
    `[diag] lp=(${lp.x.toFixed(0)},${lp.y.toFixed(0)},${lp.z.toFixed(0)}) ` +
    `→ voxel[${di},${hi},${wi}] idx=${pidx}  ` +
    `voxel-center=(${cx.toFixed(0)},${cy.toFixed(0)},${cz.toFixed(0)})`
  );
}

function _hideClickMarker() {
  if (_clickMarker) _clickMarker.visible = false;
  if (_clickMarkerRing) _clickMarkerRing.visible = false;
}

// Update the hover uniforms on every plane's shader material. Pass view=null
// to clear all hover highlights. Pass an id of 0 to keep the active-plane
// wash but not highlight a specific region.
function _setPlaneHover(view, hoverId) {
  for (const v of ['sagittal', 'coronal', 'transverse']) {
    const g = slicePlanes[v];
    const mat = g?.userData?.mesh?.material;
    const u = mat?.uniforms;
    if (!u || !u.uHoverId) continue;  // volume material not yet installed
    if (v === view) {
      u.uHoverId.value    = Math.max(0, hoverId | 0);
      u.uPlaneActive.value = 1.0;
    } else {
      u.uHoverId.value    = 0;
      u.uPlaneActive.value = 0.0;
    }
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  _mouseDownPos = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !_mouseDownPos) return;
  const dx = e.clientX - _mouseDownPos.x;
  const dy = e.clientY - _mouseDownPos.y;
  _mouseDownPos = null;
  if (dx*dx + dy*dy > 25) return;  // orbit drag, ignore
  if (!ebrainMode) return;
  if (!VOLUME.ready) { console.log('[3D click] volume not yet loaded'); return; }

  const rect = canvas.getBoundingClientRect();
  _rayMouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  _rayMouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_rayMouse, camera);

  const targets = [];
  const meshToView = new Map();
  for (const v of ['sagittal', 'coronal', 'transverse']) {
    const g = slicePlanes[v];
    if (g?.userData?.mesh && g.visible) {
      targets.push(g.userData.mesh);
      meshToView.set(g.userData.mesh, v);
    }
  }
  const hits = _raycaster.intersectObjects(targets, false);
  if (!hits.length) return;
  const hit = hits[0];
  const view = meshToView.get(hit.object) || '?';

  // Convert world-space hit point into rootGroup-local coords (undo y-flip).
  const lp = new THREE.Vector3(hit.point.x, -hit.point.y, hit.point.z);
  const idx = sampleVolumeAtLocal(lp);

  // Always place the click marker (even for empty voxels) so the user gets
  // visual confirmation that their click registered.
  _placeClickMarker(hit.point, view);

  // Last-click readout (coord strip)
  if (_coordElClick) {
    _coordElClick.textContent =
      `${view} · (${lp.x.toFixed(0)}, ${lp.y.toFixed(0)}, ${lp.z.toFixed(0)})`;
    _coordElClick.classList.add('has-data');
  }

  if (!idx) { console.log('[3D click] voxel sample returned 0 (outside mesh volume)'); return; }

  console.log(`[3D click] compact_idx=${idx} at local (${lp.x.toFixed(0)}, ${lp.y.toFixed(0)}, ${lp.z.toFixed(0)})`);

  // ── 3D click → ontology tree → mesh + 2D/3D view sync ─────────────────
  // We delegate to window.resolveLookup (defined in the 2D-view script
  // below). That function:
  //   1. POSTs to /api/lookup to identify the voxel from annotation_10
  //      (ground truth — the mesh-derived volume we sample in JS is only
  //      for rendering and can mis-label boundaries).
  //   2. Calls updatePanel(data), which fires syncThreeD → ontology tree
  //      lookup → window.brain3d.showRegion(id). showRegion has ancestor
  //      fallback (MOBgr → MOB) for regions not delineated as meshes.
  //   3. With skipSync:false it also moves all 2D sliders + 3D slice
  //      planes to the clicked voxel's xi/yi/zi.
  //
  // Convert the clicked point (mesh-µm, origin (0,0,0) per
  // voxelize_meshes.py) into atlas voxel indices at 10-µm resolution.
  // lp.x→L-R, lp.y→S-I, lp.z→A-P.
  const BASE_UM = 10;
  const X_MAX = 1319, Y_MAX = 799, Z_MAX = 1139;  // annotation_10 shape - 1
  // Compute atlas indices UNCLAMPED so we can detect when the click falls
  // outside the annotation volume (meshes for cerebellum, retina, etc. can
  // extend past annotation_10's bounds).
  const xiRaw = Math.round(lp.z / BASE_UM);  // A-P
  const yiRaw = Math.round(lp.y / BASE_UM);  // S-I
  const ziRaw = Math.round(lp.x / BASE_UM);  // L-R
  const outOfAtlas =
    xiRaw < 0 || xiRaw > X_MAX ||
    yiRaw < 0 || yiRaw > Y_MAX ||
    ziRaw < 0 || ziRaw > Z_MAX;

  if (outOfAtlas) {
    // The click landed outside annotation_10's bounds (common for cerebellum
    // lobules like Uvula, retina, etc.). Two problems to handle:
    //
    //  1. Mesh identification: /api/lookup would clamp to the edge and
    //     return the wrong region, so use the mesh-volume sample `idx`
    //     directly via /api/resolve_structure_id.
    //
    //  2. View sync: using the CLAMPED click position as the slider target
    //     can produce a slice where the region has no voxels — the edge of
    //     the annotation volume often doesn't contain the cerebellar lobule
    //     we clicked on. Fetch the region's actual centroid from the
    //     annotation (region_center) and use that instead, so the 2D slices
    //     will genuinely contain the highlighted region.
    console.log(`[3D click] atlas OOB (xi=${xiRaw} yi=${yiRaw} zi=${ziRaw}); ` +
                `resolving mesh-volume idx=${idx} with annotation-centroid sync`);
    (async () => {
      try {
        // Step 1: resolve idx -> parcellation_index via /api/resolve_structure_id
        const r1 = await fetch(`${API}/api/resolve_structure_id?idx=${idx}`);
        if (!r1.ok) { console.warn(`[3D click] resolve HTTP ${r1.status}`); return; }
        const data = await r1.json();
        if (data.error && !data.parcellation_index) {
          console.warn('[3D click] resolve error:', data.error);
          return;
        }

        setLastLookupData(data);
        setLastParcIdx(data.parcellation_index);
        setLastHighlight({type:'single', parcIdx:data.parcellation_index, level:highlightLevel});
        updatePanel(data);

        // Step 2: get centroid (xi, yi, zi) in annotation space so we can
        // drive the sliders to a slice that actually contains the region.
        let cxi, cyi, czi;
        if (data.parcellation_index) {
          try {
            const r2 = await fetch(`${API}/api/region_center`, {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({parcellation_index: data.parcellation_index}),
            });
            if (r2.ok) {
              const cData = await r2.json();
              if (!cData.error) { cxi = cData.xi; cyi = cData.yi; czi = cData.zi; }
            }
          } catch (e) { console.warn('[3D click] region_center fetch failed:', e); }
        }

        // Fall back to the clamped click position for any axis where the
        // centroid didn't come back. The clicked view's own axis keeps the
        // click position, since that's where the user actually clicked and
        // the click view already shows the right slice.
        const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
        const xi = (view === 'sagittal')   ? clamp(xiRaw, X_MAX) : (cxi != null ? cxi : clamp(xiRaw, X_MAX));
        const yi = (view === 'transverse') ? clamp(yiRaw, Y_MAX) : (cyi != null ? cyi : clamp(yiRaw, Y_MAX));
        const zi = (view === 'coronal')    ? clamp(ziRaw, Z_MAX) : (czi != null ? czi : clamp(ziRaw, Z_MAX));
        const VIEW_IDX = { sagittal: xi, coronal: zi, transverse: yi };

        console.log(`[3D click] OOB sync: click=(${xiRaw},${yiRaw},${ziRaw}) ` +
                    `centroid=(${cxi},${cyi},${czi}) → used=(${xi},${yi},${zi})`);

        setSuppressSliderReload(true);
        Object.keys(views).forEach(ov => {
          const os = views[ov];
          const newIdx = VIEW_IDX[ov];
          if (newIdx == null) return;
          os.idx = newIdx;
          os.slider.value = newIdx;
          os.idxDisp.textContent = newIdx;
          os.marker.style.display = 'none';
          if (window.brain3d?.setSlice) {
            window.brain3d.setSlice(ov, newIdx, parseInt(os.slider.max), parseInt(os.slider.min));
          }
        });
        setSuppressSliderReload(false);

        await Promise.all(Object.keys(views).map(ov => loadSliceP(ov)));
        await Promise.all(Object.keys(views).map(vv =>
          fetchAndDrawHighlight(vv, data.parcellation_index, highlightLevel)
        ));
        setStatus(`${data.matched_label||'parcellation '+data.parcellation_index} ` +
                  `-- xi=${xi} yi=${yi} zi=${zi} . all views synced`,'ok');

        if (window.notifyChatRegion) {
          const regionName = data.matched_label ||
            [data.substructure, data.structure, data.division, data.category]
              .find(x => x && x !== '—' && x !== '--') || 'Region '+data.parcellation_index;
          const regionAcro = data.matched_acronym ||
            [data.substructure_acronym, data.structure_acronym,
             data.division_acronym, data.category_acronym, data.acronym]
              .find(x => x && x !== '—' && x !== '--') || '';
          window.notifyChatRegion(regionName, {...data, structure: regionName, acronym: regionAcro});
        }
      } catch (err) {
        console.error('[3D click] OOB flow failed:', err);
      }
    })();
    return;
  }

  const xi = xiRaw, yi = yiRaw, zi = ziRaw;

  // world_coords inverse for each view (see app.py):
  //   sagittal:  xi=idx, yi=row, zi=col   → idx=xi, col=zi, row=yi
  //   coronal :  xi=col, yi=row, zi=idx   → idx=zi, col=xi, row=yi
  //   transverse: xi=row, yi=idx, zi=col  → idx=yi, col=zi, row=xi
  let lookupView, lookupIdx, lookupCol, lookupRow;
  if (view === 'sagittal')       { lookupView = 'sagittal';   lookupIdx = xi; lookupCol = zi; lookupRow = yi; }
  else if (view === 'coronal')   { lookupView = 'coronal';    lookupIdx = zi; lookupCol = xi; lookupRow = yi; }
  else                           { lookupView = 'transverse'; lookupIdx = yi; lookupCol = zi; lookupRow = xi; }

  console.log(`[3D click] delegate to resolveLookup: ${lookupView} idx=${lookupIdx} ` +
              `col=${lookupCol} row=${lookupRow} (atlas xi=${xi} yi=${yi} zi=${zi})`);

  if (typeof window.resolveLookup === 'function') {
    // skipSync:false → move all 2D sliders + 3D slice planes to the click,
    // just like a 2D click would move the OTHER views. The syncAll:true
    // flag tells resolveLookup to ALSO move the clicked view (which a 2D
    // click leaves alone because it was already at the right slice).
    window.resolveLookup(lookupView, lookupCol, lookupRow, {
      skipSync: false,
      syncAll:  true,
      idxOverride: lookupIdx,
    });
  } else if (typeof window.resolveStructureId === 'function') {
    window.resolveStructureId(idx);
  }
});

// --- 3D hover: highlights the region under the pointer (on the plane
// shader, across the whole plane) and keeps the coord strip's live X/Y/Z
// updated. (This used to also show a raw voxel/index debug readout overlay
// — removed since it was internal state, not something a user needs to see.)
let _probePending = null;       // last pointer event awaiting rAF
let _probeRafId = null;
let _probeLastHoverId = -1;     // cache for shader uniform updates
let _probeLastView = null;

function _hideProbe() {
  // Clear hover highlight on all planes
  if (_probeLastHoverId !== 0 || _probeLastView !== null) {
    _setPlaneHover(null, 0);
    _probeLastHoverId = 0;
    _probeLastView = null;
  }
  // Clear coord strip
  _setCoordStripLocal(null);
}

function _runProbe(e) {
  if (!ebrainMode || !VOLUME.ready) { _hideProbe(); return; }

  const rect = canvas.getBoundingClientRect();
  _rayMouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  _rayMouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_rayMouse, camera);

  // Build targets and remember which view each mesh belongs to.
  const targets = [];
  const meshToView = new Map();
  for (const v of ['sagittal', 'coronal', 'transverse']) {
    const g = slicePlanes[v];
    if (g?.userData?.mesh && g.visible) {
      targets.push(g.userData.mesh);
      meshToView.set(g.userData.mesh, v);
    }
  }
  if (!targets.length) { _hideProbe(); return; }

  const hits = _raycaster.intersectObjects(targets, false);
  if (!hits.length) { _hideProbe(); return; }

  const hit = hits[0];
  const view = meshToView.get(hit.object) || '?';
  const lp = new THREE.Vector3(hit.point.x, -hit.point.y, hit.point.z);

  // Live coord-strip update every frame (cheap — just three DOM writes)
  _setCoordStripLocal(lp);

  // Figure out which voxel this point falls in so we know what to highlight.
  const sMin  = VOLUME.sceneOrigin;
  const sSize = VOLUME.sceneSize;
  let idx = 0;
  if (sMin && sSize) {
    const tx = (lp.x - sMin[0]) / sSize[0];
    const ty = (lp.y - sMin[1]) / sSize[1];
    const tz = (lp.z - sMin[2]) / sSize[2];
    if (tx >= 0 && tx <= 1 && ty >= 0 && ty <= 1 && tz >= 0 && tz <= 1) {
      const [X, Y, Z] = VOLUME.shape;
      const wi = Math.min(Z - 1, Math.floor(tx * Z));
      const hi = Math.min(Y - 1, Math.floor(ty * Y));
      const di = Math.min(X - 1, Math.floor(tz * X));
      idx = VOLUME.data[di * Y * Z + hi * Z + wi];
    }
  }

  // Update plane-hover shader uniforms (only when the (view, idx) pair changes)
  if (view !== _probeLastView || idx !== _probeLastHoverId) {
    _setPlaneHover(view, idx);
    _probeLastView = view;
    _probeLastHoverId = idx;
  }
}

canvas.addEventListener('pointermove', (e) => {
  _probePending = e;
  if (_probeRafId != null) return;
  _probeRafId = requestAnimationFrame(() => {
    _probeRafId = null;
    const ev = _probePending;
    _probePending = null;
    if (ev) _runProbe(ev);
  });
});
canvas.addEventListener('pointerleave', _hideProbe);

// Go!
initShell();
