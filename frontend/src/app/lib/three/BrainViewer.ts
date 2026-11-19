// The 3D view: the whole-brain shell, the selected region's mesh, and one
// plane per 2D view that follows its slider. eBrain mode paints the planes
// from a label volume (so they can be clicked to identify a region) and
// cuts away the octant of the shell facing the camera.
//
// Ported from the old frontend/src/threeViewer.js. No React and no app state
// in here: the component drives it through the public methods and hears back
// through the callbacks.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshLut, getMeshVolume, getMeshVolumeMeta, type MeshVolumeMeta } from '../api';
import { resolveMeshId, ROOT_STRUCTURE_ID, type MeshTarget } from '../meshTarget';
import type { PlanePick } from '../navigate';
import { PLANE_ORDER, PLANES, type Plane } from '../planes';

const MESH_BASE = '/meshes/';
const SHELL_OPACITY = 0.28;
const REGION_OPACITY = 0.85;
const CLICK_SLOP_SQ = 25; // px²: more movement than this is an orbit, not a click

type Vec3 = { x: number; y: number; z: number };
export interface ViewerStatus {
  acronym: string;
  name: string;
}
export interface BrainViewerEvents {
  onStatus: (s: ViewerStatus) => void;
  /** Mesh-space point under the pointer on a plane (eBrain only), or null. */
  onHover: (p: Vec3 | null) => void;
  onPick: (pick: PlanePick) => void;
}
export interface MeshCatalogMaps {
  available: Set<number> | null;
  parentOf: Map<number, number> | null;
  nameOf: (id: number) => string | undefined;
}

// Each plane is perpendicular to one axis of the mesh frame (x = A–P,
// y = S–I, z = L–R; µm); the slider range maps linearly onto the shell's box.
const SLICE_AXIS: Record<Plane, { axis: 'x' | 'y' | 'z'; color: number }> = {
  sagittal: { axis: 'z', color: 0x00d4ff },
  coronal: { axis: 'x', color: 0xb47aff },
  transverse: { axis: 'y', color: 0x00e676 },
};

interface PlaneObj {
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial | THREE.ShaderMaterial>;
  preview: THREE.MeshBasicMaterial;
  volumeMat: THREE.ShaderMaterial | null;
  axis: 'x' | 'y' | 'z';
  tint: number;
}
interface Bounds {
  center: THREE.Vector3;
  size: THREE.Vector3;
  min: THREE.Vector3;
}

// --- The eBrain label volume: fetched once per page, shared by every viewer ---
interface VolumeData {
  shape: [number, number, number];
  origin: [number, number, number] | null;
  size: [number, number, number] | null;
  data: Uint16Array<ArrayBuffer>;
  lut: Uint8Array<ArrayBuffer>; // RGBA per label
  lutSize: number;
}
let volumePromise: Promise<VolumeData> | null = null;
function loadVolume(): Promise<VolumeData> {
  volumePromise ??= (async () => {
    const meta: MeshVolumeMeta = await getMeshVolumeMeta();
    const [buf, lutBuf] = await Promise.all([getMeshVolume(), getMeshLut()]);
    const rgb = new Uint8Array(lutBuf);
    const lutSize = rgb.length / 3;
    const lut = new Uint8Array(lutSize * 4);
    for (let i = 0; i < lutSize; i++) {
      lut[i * 4] = rgb[i * 3]!;
      lut[i * 4 + 1] = rgb[i * 3 + 1]!;
      lut[i * 4 + 2] = rgb[i * 3 + 2]!;
      lut[i * 4 + 3] = 255;
    }
    return {
      shape: meta.shape,
      origin: meta.scene_origin_um ?? null,
      size: meta.scene_size_um ?? null,
      data: new Uint16Array(buf),
      lut,
      lutSize,
    };
  })().catch((err: unknown) => {
    volumePromise = null; // allow a retry (the server may still be generating it)
    throw err;
  });
  return volumePromise;
}

const VERTEX_SHADER = /* glsl */ `
  out vec3 vLocalPos;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vLocalPos = vec3(worldPos.x, -worldPos.y, worldPos.z); // undo the root group's y-flip
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp usampler3D;
  in vec3 vLocalPos;
  uniform usampler3D uVolume;
  uniform sampler2D uLUT;
  uniform float uLUTSize;
  uniform vec3 uBoundsMin;
  uniform vec3 uBoundsSize;
  uniform vec3 uShape;
  uniform vec3 uTint;
  uniform uint uHoverId;
  uniform vec3 uHoverColor;
  uniform float uHoverAmt;
  uniform float uPlaneActive;
  out vec4 fragColor;

  uint sampleId(vec3 t) {
    if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return 0u;
    return texture(uVolume, t).r;
  }

  void main() {
    vec3 t = (vLocalPos - uBoundsMin) / uBoundsSize;
    if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) discard;
    uint id = texture(uVolume, t).r;
    if (id == 0u) discard;
    vec3 col = texture(uLUT, vec2((float(id) + 0.5) / uLUTSize, 0.5)).rgb;
    if (dot(col, vec3(1.0)) < 0.01) col = vec3(0.25, 0.25, 0.28);
    // Darken region boundaries into thin outlines.
    vec3 px = 1.0 / uShape;
    bool edge = sampleId(t + vec3(px.x, 0.0, 0.0)) != id || sampleId(t - vec3(px.x, 0.0, 0.0)) != id
             || sampleId(t + vec3(0.0, px.y, 0.0)) != id || sampleId(t - vec3(0.0, px.y, 0.0)) != id
             || sampleId(t + vec3(0.0, 0.0, px.z)) != id || sampleId(t - vec3(0.0, 0.0, px.z)) != id;
    if (edge) col *= 0.35;
    if (uHoverId > 0u && id == uHoverId) col = mix(col, uHoverColor, uHoverAmt);
    if (uPlaneActive > 0.0) col = mix(col, uTint, uPlaneActive * 0.12);
    fragColor = vec4(col, 1.0);
  }
`;

function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

export class BrainViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 100, 200000);
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group(); // mesh frame (PIR), y flipped so superior is up
  private readonly loader = new GLTFLoader();
  private readonly planes = {} as Record<Plane, PlaneObj>;
  private readonly clip: Record<Plane, THREE.Plane> = {
    coronal: new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
    transverse: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    sagittal: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
  };
  private clipSigns = { x: 1, y: 1, z: 1 };
  private shell: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial> | null = null;
  private region: THREE.Mesh | null = null;
  private bounds: Bounds | null = null;
  private home: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private tween: { fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3; t0: number } | null = null;
  private slices: Record<Plane, number> = { sagittal: PLANES.sagittal.initial, coronal: PLANES.coronal.initial, transverse: PLANES.transverse.initial };
  private ebrain = false;
  private volume: VolumeData | null = null;
  private volumeTex: { tex3d: THREE.Data3DTexture; lut: THREE.DataTexture } | null = null;
  private catalog: MeshCatalogMaps = { available: null, parentOf: null, nameOf: () => undefined };
  private target: MeshTarget | null = null;
  private loadSeq = 0;
  private marker: THREE.Mesh | null = null;
  private ring: THREE.Mesh | null = null;
  private hover: { view: Plane | null; id: number } = { view: null, id: 0 };
  private raf = 0;
  private probeRaf = 0;
  private downAt: { x: number; y: number } | null = null;
  private disposed = false;
  private lastRegionStatus: ViewerStatus = { acronym: '—', name: 'Select a region to see it in 3D' };
  private readonly ray = new THREE.Raycaster();
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: BrainViewerEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.localClippingEnabled = true;
    this.scene.background = new THREE.Color(0x0e1012);
    this.camera.position.set(14000, 8000, 18000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    const stopTween = () => {
      this.tween = null;
    };
    this.controls.addEventListener('start', stopTween);
    this.cleanup.push(() => this.controls.removeEventListener('start', stopTween));

    this.scene.add(new THREE.AmbientLight(0x3a3428, 0.35));
    const lights: [number, number, [number, number, number]][] = [
      [0xfff0d4, 1.1, [1, 1.3, 1]],
      [0x6a88b0, 0.45, [-1, 0.3, -0.8]],
      [0xc89f65, 0.5, [0, -1, 0.5]],
    ];
    for (const [color, intensity, pos] of lights) {
      const l = new THREE.DirectionalLight(color, intensity);
      l.position.set(...pos);
      this.scene.add(l);
    }
    this.root.scale.y = -1;
    this.scene.add(this.root);

    this.listen(canvas, 'pointerdown', (e) => {
      if (e.button === 0) this.downAt = { x: e.clientX, y: e.clientY };
    });
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e));
    this.listen(canvas, 'pointermove', (e) => {
      if (this.probeRaf) return;
      this.probeRaf = requestAnimationFrame(() => {
        this.probeRaf = 0;
        this.probe(e);
      });
    });
    this.listen(canvas, 'pointerleave', () => {
      cancelAnimationFrame(this.probeRaf);
      this.probeRaf = 0;
      this.clearProbe();
    });

    this.status('—', 'Loading the brain…');
    void this.initShell();
    this.animate();
  }

  // --- Public API -------------------------------------------------------

  /** Move the slice planes to match the 2D views. */
  setSlices(slices: Record<Plane, number>) {
    this.slices = { ...slices };
    for (const v of PLANE_ORDER) this.placePlane(v);
  }

  /** Which meshes exist and the tree to walk up; used by the next showRegion(). */
  setCatalog(c: MeshCatalogMaps) {
    this.catalog = c;
  }

  /** Show a structure's mesh (or its nearest parent that has one); null clears it. */
  async showRegion(target: MeshTarget | null) {
    this.target = target;
    const seq = ++this.loadSeq;
    this.clearRegion();
    if (!target) {
      this.regionStatus('—', 'Select a region to see it in 3D');
      return;
    }
    if (target.structureId === ROOT_STRUCTURE_ID) {
      this.regionStatus(target.acronym, `${target.name} · the whole brain, shown as the outline`);
      return;
    }
    const res = resolveMeshId(target.structureId, this.catalog.available, this.catalog.parentOf);
    if (res.kind === 'none') {
      this.regionStatus(target.acronym, `${target.name} · no 3D model for this structure or any parent`);
      return;
    }
    this.status(target.acronym, `Loading ${target.name}…`);
    try {
      const mesh = await this.loadMesh(res.id, target.color, REGION_OPACITY, false);
      if (seq !== this.loadSeq || this.disposed) {
        disposeTree(mesh);
        return;
      }
      this.region = mesh;
      this.root.add(mesh);
      if (res.substitute) {
        const parent = this.catalog.nameOf(res.id) ?? `structure ${res.id}`;
        this.regionStatus(target.acronym, `${target.name} · not modeled separately in 3D, showing “${parent}”`);
      } else {
        this.regionStatus(target.acronym, target.name);
      }
    } catch {
      if (seq === this.loadSeq) this.regionStatus(target.acronym, `${target.name} · no 3D model to display`);
    }
  }

  recenter() {
    if (!this.home) return;
    this.tween = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: this.home.position.clone(),
      toTarget: this.home.target.clone(),
      t0: performance.now(),
    };
  }

  setShellVisible(visible: boolean) {
    if (this.shell) this.shell.visible = visible;
  }

  /** eBrain mode on/off. Resolves once the label volume is ready (or rejects). */
  async setEbrain(on: boolean): Promise<void> {
    this.ebrain = on;
    this.applyAppearance();
    if (!on) {
      this.clearProbe();
      if (this.marker) this.marker.visible = false;
      this.status(this.lastRegionStatus.acronym, this.lastRegionStatus.name);
      return;
    }
    await this.ensureVolume();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.probeRaf);
    for (const fn of this.cleanup) fn();
    this.controls.dispose();
    disposeTree(this.scene);
    // Each plane's other material (glass or volume) isn't in the scene right now.
    for (const v of PLANE_ORDER) {
      this.planes[v]?.preview.dispose();
      this.planes[v]?.volumeMat?.dispose();
    }
    this.volumeTex?.tex3d.dispose();
    this.volumeTex?.lut.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // --- Scene building ------------------------------------------------------

  private listen<K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) {
    el.addEventListener(type, fn);
    this.cleanup.push(() => el.removeEventListener(type, fn));
  }

  private status(acronym: string, name: string) {
    if (!this.disposed) this.events.onStatus({ acronym: acronym || '—', name });
  }

  /** A status about the selected region (or the lack of one); restored when eBrain is turned off. */
  private regionStatus(acronym: string, name: string) {
    this.lastRegionStatus = { acronym, name };
    this.status(acronym, name);
  }

  private async loadMesh(id: number, color: string, opacity: number, isShell: boolean) {
    const gltf = await this.loader.loadAsync(`${MESH_BASE}${id}.glb`);
    let mesh: THREE.Mesh | null = null;
    gltf.scene.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    const found = mesh as THREE.Mesh | null;
    if (!found) throw new Error('empty mesh');
    if (!found.geometry.attributes.normal) found.geometry.computeVertexNormals();
    found.material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      roughness: 0.55,
      metalness: 0.05,
      clearcoat: 0.15,
      transparent: true,
      opacity,
      depthWrite: !isShell,
      // The y-flip turns the shell inside out: BackSide is its outer surface.
      side: isShell ? THREE.BackSide : THREE.FrontSide,
      emissive: new THREE.Color(isShell ? color : 0x000000),
      emissiveIntensity: isShell ? 0.35 : 0,
    });
    found.removeFromParent();
    return found;
  }

  private async initShell() {
    try {
      const mesh = (await this.loadMesh(ROOT_STRUCTURE_ID, '#e8ecf2', SHELL_OPACITY, true)) as NonNullable<BrainViewer['shell']>;
      if (this.disposed) {
        disposeTree(mesh);
        return;
      }
      this.shell = mesh;
      this.root.add(mesh);
      this.frame(mesh);
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox!;
      const center = bb.getCenter(new THREE.Vector3());
      const size = bb.getSize(new THREE.Vector3());
      this.bounds = { center, size, min: bb.min.clone() };
      this.buildAxes(center, size);
      this.buildPlanes(size);
      for (const v of PLANE_ORDER) this.placePlane(v);
      this.applyAppearance();
      this.home = { position: this.camera.position.clone(), target: this.controls.target.clone() };
      // (A region requested meanwhile loads on its own and reports its own status.)
      if (!this.target) this.regionStatus('—', 'Select a region to see it in 3D');
    } catch {
      this.status('—', 'The 3D brain model is unavailable (meshes missing on the server?)');
    }
  }

  private frame(mesh: THREE.Object3D, padding = 1.4) {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (Math.max(size.x, size.y, size.z) / 2 / Math.tan(fov / 2)) * padding;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(new THREE.Vector3(0.8, 0.5, 1).normalize(), dist);
    this.camera.updateProjectionMatrix();
    const radius = size.length() / 2;
    this.controls.minDistance = radius * 0.25;
    this.controls.maxDistance = radius * 8;
    this.controls.update();
  }

  private buildAxes(center: THREE.Vector3, size: THREE.Vector3) {
    const g = new THREE.Group();
    g.position.copy(center);
    const len = Math.max(size.x, size.y, size.z) * 0.55;
    const line = (dir: THREE.Vector3, color: number) =>
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([dir.clone().multiplyScalar(-len), dir.clone().multiplyScalar(len)]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3, depthTest: false }),
      );
    g.add(line(new THREE.Vector3(1, 0, 0), 0xc89f65), line(new THREE.Vector3(0, 1, 0), 0x8fa8c8), line(new THREE.Vector3(0, 0, 1), 0x8aa882));
    const label = (text: string, pos: THREE.Vector3, color: number) => {
      const cvs = document.createElement('canvas');
      cvs.width = 192;
      cvs.height = 64;
      const ctx = cvs.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.font = '600 28px "Instrument Sans Variable", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 96, 34);
      const tex = new THREE.CanvasTexture(cvs);
      tex.colorSpace = THREE.SRGBColorSpace;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      spr.position.copy(pos);
      const s = len * 0.18;
      spr.scale.set(s * 3, s, 1);
      g.add(spr);
    };
    const off = len * 1.08;
    label('Ant', new THREE.Vector3(-off, 0, 0), 0x8aa882);
    label('Post', new THREE.Vector3(off, 0, 0), 0x8aa882);
    label('Sup', new THREE.Vector3(0, -off, 0), 0x8fa8c8);
    label('Inf', new THREE.Vector3(0, off, 0), 0x8fa8c8);
    label('Left', new THREE.Vector3(0, 0, -off), 0xc89f65);
    label('Right', new THREE.Vector3(0, 0, off), 0xc89f65);
    this.root.add(g);
  }

  private buildPlanes(size: THREE.Vector3) {
    for (const v of PLANE_ORDER) {
      const { axis, color } = SLICE_AXIS[v];
      const [w, h] = axis === 'x' ? [size.z, size.y] : axis === 'y' ? [size.x, size.z] : [size.x, size.y];
      const geom = new THREE.PlaneGeometry(w, h);
      const preview = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial | THREE.ShaderMaterial>(geom, preview);
      if (axis === 'x') mesh.rotation.y = Math.PI / 2;
      if (axis === 'y') mesh.rotation.x = -Math.PI / 2;
      // An outline keeps the plane visible edge-on.
      mesh.add(
        new THREE.LineSegments(
          new THREE.EdgesGeometry(geom),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }),
        ),
      );
      const group = new THREE.Group();
      group.add(mesh);
      this.root.add(group);
      this.planes[v] = { group, mesh, preview, volumeMat: null, axis, tint: color };
    }
  }

  private placePlane(v: Plane) {
    const p = this.planes[v];
    const b = this.bounds;
    if (!p || !b) return;
    const { min, max } = PLANES[v];
    const t = Math.max(0, Math.min(1, (this.slices[v] - min) / (max - min)));
    p.group.position.copy(b.center);
    p.group.position[p.axis] = b.min[p.axis] + t * b.size[p.axis];
    if (this.ebrain) this.updateClipPlanes();
  }

  // --- eBrain ---------------------------------------------------------------

  private async ensureVolume() {
    if (this.volume) return;
    this.status('eBrain', 'Loading the click volume…');
    try {
      const vol = await loadVolume();
      if (this.disposed) return;
      this.volume = vol;
      if (!this.volumeTex) {
        const [X, Y, Z] = vol.shape;
        // NumPy C order (X, Y, Z), Z fastest = WebGL width.
        const tex3d = new THREE.Data3DTexture(vol.data, Z, Y, X);
        tex3d.format = THREE.RedIntegerFormat;
        tex3d.internalFormat = 'R16UI';
        tex3d.type = THREE.UnsignedShortType;
        tex3d.minFilter = tex3d.magFilter = THREE.NearestFilter;
        tex3d.unpackAlignment = 1;
        tex3d.needsUpdate = true;
        const lut = new THREE.DataTexture(vol.lut, vol.lutSize, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
        lut.minFilter = lut.magFilter = THREE.NearestFilter;
        lut.needsUpdate = true;
        this.volumeTex = { tex3d, lut };
      }
      if (this.ebrain) {
        this.applyAppearance();
        this.status('eBrain', 'Click a slice plane to identify a region');
      }
    } catch (err) {
      if (this.ebrain) this.status('eBrain', `Click-to-identify unavailable: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /** Scene-space box the volume covers (falls back to the shell's box). */
  private volumeBox(): { min: [number, number, number]; size: [number, number, number] } | null {
    const b = this.bounds;
    const vol = this.volume;
    if (!vol) return null;
    const min = vol.origin ?? (b ? [b.min.x, b.min.y, b.min.z] : null);
    const size = vol.size ?? (b ? [b.size.x, b.size.y, b.size.z] : null);
    return min && size ? { min, size } : null;
  }

  private makeVolumeMaterial(v: Plane): THREE.ShaderMaterial | null {
    const box = this.volumeBox();
    if (!this.volume || !this.volumeTex || !box) return null;
    const [X, Y, Z] = this.volume.shape;
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      uniforms: {
        uVolume: { value: this.volumeTex.tex3d },
        uLUT: { value: this.volumeTex.lut },
        uLUTSize: { value: this.volume.lutSize },
        uBoundsMin: { value: new THREE.Vector3(...box.min) },
        uBoundsSize: { value: new THREE.Vector3(...box.size) },
        uShape: { value: new THREE.Vector3(X, Y, Z) },
        uTint: { value: new THREE.Color(this.planes[v].tint) },
        uHoverId: { value: 0 },
        uHoverColor: { value: new THREE.Color(0xffffff) },
        uHoverAmt: { value: 0.55 },
        uPlaneActive: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });
  }

  /** Planes: tinted glass, or (eBrain, volume loaded) painted from the volume. Shell: ghost, or solid with a cutaway. */
  private applyAppearance() {
    for (const v of PLANE_ORDER) {
      const p = this.planes[v];
      if (!p) continue;
      if (this.ebrain && this.volume) {
        p.volumeMat ??= this.makeVolumeMaterial(v);
        p.mesh.material = p.volumeMat ?? p.preview;
      } else {
        p.mesh.material = p.preview;
        // eBrain before the volume arrives: invisible but still clickable.
        p.preview.opacity = this.ebrain ? 0 : 0.18;
      }
    }
    const mat = this.shell?.material;
    if (!mat) return;
    if (this.ebrain) {
      mat.color.set(0xeef0f4);
      mat.opacity = 1;
      mat.transparent = false;
      mat.depthWrite = true;
      mat.side = THREE.DoubleSide;
      mat.emissiveIntensity = 0;
      mat.roughness = 0.6;
      this.updateClipPlanes();
      mat.clippingPlanes = [this.clip.coronal, this.clip.transverse, this.clip.sagittal];
      mat.clipIntersection = true; // cut only where all three agree: one octant
    } else {
      mat.color.set(0xe8ecf2);
      mat.opacity = SHELL_OPACITY;
      mat.transparent = true;
      mat.depthWrite = false;
      mat.side = THREE.BackSide;
      mat.emissiveIntensity = 0.35;
      mat.roughness = 0.55;
      mat.clippingPlanes = [];
      mat.clipIntersection = false;
    }
    mat.needsUpdate = true;
  }

  private planeWorld(v: Plane) {
    const g = this.planes[v].group;
    g.updateMatrixWorld(true);
    return new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
  }

  /** Clip planes through the slice planes; clipSigns pick which side of each is cut. */
  private updateClipPlanes() {
    if (!this.bounds || !this.planes.coronal) return;
    const s = this.clipSigns;
    this.clip.coronal.normal.set(-s.x, 0, 0);
    this.clip.coronal.constant = s.x * this.planeWorld('coronal').x;
    this.clip.transverse.normal.set(0, -s.y, 0);
    this.clip.transverse.constant = s.y * this.planeWorld('transverse').y;
    this.clip.sagittal.normal.set(0, 0, -s.z);
    this.clip.sagittal.constant = s.z * this.planeWorld('sagittal').z;
  }

  /** Cut the octant the camera is looking from. True if it changed. */
  private followCamera() {
    if (!this.planes.coronal) return false;
    const corner = new THREE.Vector3(this.planeWorld('coronal').x, this.planeWorld('transverse').y, this.planeWorld('sagittal').z);
    const cam = this.camera.position;
    const next = { x: cam.x > corner.x ? 1 : -1, y: cam.y > corner.y ? 1 : -1, z: cam.z > corner.z ? 1 : -1 };
    const s = this.clipSigns;
    if (next.x === s.x && next.y === s.y && next.z === s.z) return false;
    this.clipSigns = next;
    return true;
  }

  // --- Picking -----------------------------------------------------------------

  /**
   * The plane under a client point, in mesh space, with the volume label
   * there. Empty (label 0) parts of a plane aren't drawn in eBrain mode, so
   * the nearest hit with a label wins; failing that, the nearest hit.
   */
  private hitPlane(clientX: number, clientY: number): { view: Plane; local: THREE.Vector3; world: THREE.Vector3; voxel: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const meshes = PLANE_ORDER.flatMap((v) => (this.planes[v]?.group.visible ? [this.planes[v].mesh] : []));
    const hits = this.ray.intersectObjects(meshes, false).map((h) => {
      const local = new THREE.Vector3(h.point.x, -h.point.y, h.point.z);
      const view = PLANE_ORDER.find((v) => this.planes[v].mesh === h.object)!;
      return { view, local, world: h.point, voxel: this.sample(local) };
    });
    return hits.find((h) => h.voxel !== 0) ?? hits[0] ?? null;
  }

  /** The volume label at a mesh-space point (0 outside). */
  private sample(lp: Vec3): number {
    const vol = this.volume;
    const box = this.volumeBox();
    if (!vol || !box) return 0;
    const t = [(lp.x - box.min[0]) / box.size[0], (lp.y - box.min[1]) / box.size[1], (lp.z - box.min[2]) / box.size[2]];
    if (t.some((c) => c < 0 || c > 1)) return 0;
    const [X, Y, Z] = vol.shape;
    const wi = Math.min(Z - 1, Math.floor(t[0]! * Z));
    const hi = Math.min(Y - 1, Math.floor(t[1]! * Y));
    const di = Math.min(X - 1, Math.floor(t[2]! * X));
    return vol.data[di * Y * Z + hi * Z + wi] ?? 0;
  }

  private onPointerUp(e: PointerEvent) {
    const down = this.downAt;
    this.downAt = null;
    if (e.button !== 0 || !down) return;
    if ((e.clientX - down.x) ** 2 + (e.clientY - down.y) ** 2 > CLICK_SLOP_SQ) return; // an orbit
    if (!this.ebrain) return;
    if (!this.volume) {
      this.ensureVolume().catch(() => {}); // retry; status explains
      return;
    }
    const hit = this.hitPlane(e.clientX, e.clientY);
    if (!hit) return;
    this.placeMarker(hit.world, hit.view);
    this.events.onPick({ view: hit.view, local: { x: hit.local.x, y: hit.local.y, z: hit.local.z }, voxel: hit.voxel });
  }

  private probe(e: PointerEvent) {
    if (this.disposed) return;
    const hit = this.ebrain && this.volume ? this.hitPlane(e.clientX, e.clientY) : null;
    if (!hit) {
      this.clearProbe();
      return;
    }
    this.events.onHover({ x: hit.local.x, y: hit.local.y, z: hit.local.z });
    if (hit.view !== this.hover.view || hit.voxel !== this.hover.id) this.setHover(hit.view, hit.voxel);
  }

  private clearProbe() {
    if (this.hover.view !== null || this.hover.id !== 0) this.setHover(null, 0);
    if (!this.disposed) this.events.onHover(null);
  }

  /** Light up the hovered region on the hovered plane. */
  private setHover(view: Plane | null, id: number) {
    this.hover = { view, id };
    for (const v of PLANE_ORDER) {
      const u = this.planes[v]?.volumeMat?.uniforms;
      if (!u) continue;
      u.uHoverId!.value = v === view ? Math.max(0, id | 0) : 0;
      u.uPlaneActive!.value = v === view ? 1 : 0;
    }
  }

  private placeMarker(world: THREE.Vector3, view: Plane) {
    if (!this.marker) {
      const mat = (opacity: number) => new THREE.MeshBasicMaterial({ color: 0xffb74a, transparent: true, opacity, depthTest: false });
      this.marker = new THREE.Mesh(new THREE.SphereGeometry(45, 16, 12), mat(0.95));
      this.marker.renderOrder = 999;
      this.ring = new THREE.Mesh(new THREE.TorusGeometry(80, 6, 8, 32), mat(0.85));
      this.ring.renderOrder = 998;
      this.marker.add(this.ring);
      this.root.add(this.marker);
    }
    const ring = this.ring!;
    this.marker.position.copy(this.root.worldToLocal(world.clone()));
    this.marker.visible = true;
    // Lay the ring flat on the clicked plane, in that plane's color.
    ring.rotation.set(view === 'transverse' ? Math.PI / 2 : 0, view === 'coronal' ? Math.PI / 2 : 0, 0);
    const tint = this.planes[view].tint;
    (this.marker.material as THREE.MeshBasicMaterial).color.setHex(tint);
    (ring.material as THREE.MeshBasicMaterial).color.setHex(tint);
  }

  private clearRegion() {
    if (!this.region) return;
    this.root.remove(this.region);
    disposeTree(this.region);
    this.region = null;
  }

  // --- Render loop ---------------------------------------------------------------

  private animate = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return; // hidden (another view is expanded)
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.t0) / 600);
      const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, ease);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, ease);
      if (k === 1) this.tween = null;
    }
    this.controls.update();
    if (this.ebrain && this.followCamera()) this.updateClipPlanes();
    this.renderer.render(this.scene, this.camera);
  };
}
