// The 3D view: the whole-brain shell (drawn as glass), the selected region's
// mesh, and one plane per 2D view that follows its slider. Picking a region
// flies the camera to it and reports a screen anchor for the page's label. eBrain mode paints the planes
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
import { loadStructureMesh, prefersReducedMotion } from './shared';
import { PLANE_ORDER, PLANES, type Plane } from '../planes';

const REGION_OPACITY = 0.9;
const FLY_MS = 450; // happens on every pick, so it stays short

/** Glass: nearly clear where the surface faces you, brighter toward the
 *  silhouette, so the outline reads without hiding the region inside. */
const GLASS_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const GLASS_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uFace;
uniform float uEdge;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vView)));
  gl_FragColor = vec4(uColor, mix(uFace, uEdge, pow(rim, 2.4)));
  #include <colorspace_fragment>
}`;

const CLICK_SLOP_SQ = 25; // px²: more movement than this is an orbit, not a click

type Vec3 = { x: number; y: number; z: number };

/** Camera presets: the default 3D view, or looking at the brain from one side. */
export type CameraView = '3d' | 'D' | 'V' | 'L' | 'R' | 'A' | 'P';

/** Where the anatomical axes point on screen: x right, y up, z toward the
 *  viewer (all in -1..1). Positive ends: posterior, dorsal, right. */
export interface Orientation {
  p: Vec3;
  d: Vec3;
  r: Vec3;
}

// World axes (see the root group in the constructor): +x posterior, +y dorsal, -z right.
const AXIS_P = new THREE.Vector3(1, 0, 0);
const AXIS_D = new THREE.Vector3(0, 1, 0);
const AXIS_R = new THREE.Vector3(0, 0, -1);
const POLE = 0.01; // looking straight down an axis, OrbitControls needs a nudge to know which way is up

/** Where the camera sits for each side view (from the target), chosen so the
 *  picture has the usual orientation: dorsal up for side views, anterior up
 *  for top and bottom views. */
const SIDE: Record<Exclude<CameraView, '3d'>, THREE.Vector3> = {
  D: new THREE.Vector3(POLE, 1, 0), // nudged posterior, so anterior is up
  V: new THREE.Vector3(-POLE, -1, 0), // nudged anterior, so anterior is up
  L: AXIS_R.clone().negate(),
  R: AXIS_R.clone(),
  A: AXIS_P.clone().negate(),
  P: AXIS_P.clone(),
};

export interface ViewerStatus {
  acronym: string;
  name: string;
}
export interface BrainViewerEvents {
  onStatus: (s: ViewerStatus) => void;
  /** Mesh-space point under the pointer on a plane (eBrain only), or null. */
  onHover: (p: Vec3 | null) => void;
  onPick: (pick: PlanePick) => void;
  /** Where the selected region sits on the canvas (CSS px), for a pinned
   *  label; null when there is none or it is behind the camera. `settled` is
   *  false while the camera flies to a newly picked region. */
  onAnchor?: (a: { x: number; y: number; settled: boolean } | null) => void;
  /** The camera turned: where the anatomical axes now point (for the orientation gizmo). */
  onOrient?: (o: Orientation) => void;
  /** Screen pixels per µm at the centre of rotation (for a scale bar). */
  onScale?: (pxPerUm: number) => void;
  /** The brain outline has loaded and the camera has its home pose (presets work from here). */
  onReady?: () => void;
  /** A preset was applied, or (null) the user moved the camera away from it. */
  onView?: (view: CameraView | null) => void;
}
export interface MeshCatalogMaps {
  available: Set<number> | null;
  parentOf: Map<number, number> | null;
  nameOf: (id: number) => string | undefined;
}

// Each plane is perpendicular to one axis of the mesh frame (x = A–P,
// y = S–I, z = L–R; µm); the slider range maps linearly onto the shell's box.
const SLICE_AXIS: Record<Plane, { axis: 'x' | 'y' | 'z'; color: number }> = {
  sagittal: { axis: 'z', color: 0x6aa6c4 },
  coronal: { axis: 'x', color: 0x9c8cc4 },
  transverse: { axis: 'y', color: 0x74ae8e },
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
    vLocalPos = vec3(worldPos.x, -worldPos.y, -worldPos.z); // undo the root group's half-turn about x
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
  private shell: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null;
  private readonly shellGlass = new THREE.ShaderMaterial({
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    uniforms: { uColor: { value: new THREE.Color('#c9d1d2') }, uFace: { value: 0.03 }, uEdge: { value: 0.5 } },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  /** eBrain: an opaque shell with the camera's octant cut away. */
  private readonly shellSolid = new THREE.MeshPhysicalMaterial({ color: 0x8f9899, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  private region: THREE.Mesh | null = null;
  private readonly surfaceGroup = new THREE.Group();
  private readonly surfaces = new Map<number, THREE.Mesh>();
  private surfaceWanted = new Set<number>();
  private surfaceOpacity = 0.55;
  private axes: THREE.Group | null = null;
  // Display options, kept so ones set before the outline loads still apply.
  private shellVisible = true;
  private planesVisible = true;
  private axesVisible = true;
  /** Where the last preset put the camera; cleared once the camera leaves it. */
  private presetPose: THREE.Vector3 | null = null;
  /** A point on the region's surface (mesh frame) that the label points at. */
  private anchor: THREE.Vector3 | null = null;
  private lastAnchor = '';
  private bounds: Bounds | null = null;
  private home: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  /** A camera flight: the target moves in a line; the camera swings around it on
   *  an arc, its orientation slerped so it never flips passing over a pole. */
  private tween: {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromDir: THREE.Vector3;
    turn: THREE.Quaternion;
    fromLen: number;
    toLen: number;
    fromQuat: THREE.Quaternion;
    toQuat: THREE.Quaternion;
    t0: number;
    ms: number;
  } | null = null;
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
  /** Something in the scene changed: draw the next frame. (Camera motion is tracked separately.) */
  private dirty = true;
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
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
    this.scene.background = new THREE.Color(0x000000);
    this.camera.position.set(14000, 8000, 18000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    const stopTween = () => {
      this.tween = null;
    };
    const leftPreset = () => {
      if (this.presetPose && !this.tween && this.camera.position.distanceToSquared(this.presetPose) > 1) this.releasePreset();
    };
    this.controls.addEventListener('change', leftPreset);
    this.cleanup.push(() => this.controls.removeEventListener('change', leftPreset));
    this.controls.addEventListener('start', stopTween);
    this.cleanup.push(() => this.controls.removeEventListener('start', stopTween));

    // Near-neutral light, so the Allen colours read true.
    this.scene.add(new THREE.AmbientLight(0x30363a, 0.6));
    const lights: [number, number, [number, number, number]][] = [
      // World: +x posterior, +y dorsal, -z right. Key light above-behind-right, where the default camera is.
      [0xf2efe8, 1.15, [1, 1.3, -1]],
      [0x8fa3b0, 0.45, [-1, 0.3, 0.8]],
      [0x9a9286, 0.35, [0, -1, -0.5]],
    ];
    for (const [color, intensity, pos] of lights) {
      const l = new THREE.DirectionalLight(color, intensity);
      l.position.set(...pos);
      this.scene.add(l);
    }
    // Mesh space is PIR (x posterior, y inferior, z right). A half-turn about x
    // puts superior up without mirroring the brain (a y-flip alone would swap
    // left and right). World: +x posterior, +y dorsal, -z right.
    this.root.rotation.x = Math.PI;
    this.root.add(this.surfaceGroup);
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
      this.recenter();
      return;
    }
    if (target.structureId === ROOT_STRUCTURE_ID) {
      this.regionStatus(target.acronym, `${target.name}: the whole brain, shown as the outline`);
      this.recenter();
      return;
    }
    const res = resolveMeshId(target.structureId, this.catalog.available, this.catalog.parentOf);
    if (res.kind === 'none') {
      this.regionStatus(target.acronym, `${target.name}: no 3D model for this structure or any parent`);
      this.recenter();
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
      this.dirty = true;
      this.anchor = surfaceAnchor(mesh.geometry);
      this.flyTo(mesh);
      if (res.substitute) {
        const parent = this.catalog.nameOf(res.id) ?? `structure ${res.id}`;
        this.regionStatus(target.acronym, `${target.name}: not modeled separately in 3D, showing “${parent}”`);
      } else {
        this.regionStatus(target.acronym, target.name);
      }
    } catch {
      if (seq === this.loadSeq) {
        this.regionStatus(target.acronym, `${target.name}: no 3D model to display`);
        this.recenter();
      }
    }
  }

  recenter() {
    this.viewFrom('3d');
  }

  /** Look at the whole brain from one side (or the default 3D view), at the
   *  default distance. */
  viewFrom(view: CameraView) {
    if (!this.home) return;
    const pos =
      view === '3d'
        ? this.home.position.clone()
        : this.home.target.clone().addScaledVector(SIDE[view].clone().normalize(), this.home.position.distanceTo(this.home.target));
    this.moveCamera(pos, this.home.target);
    this.presetPose = pos;
    this.events.onView?.(view);
  }

  private releasePreset() {
    this.presetPose = null;
    this.events.onView?.(null);
  }

  /** Report the orientation and scale again on the next frame (for a listener that just subscribed). */
  refreshOverlays() {
    this.dirty = true;
    this.lastOrient = '';
    this.lastScale = 0;
  }

  /** Draw these structures as surfaces alongside the selection; drops the ones left out. */
  async setSurfaces(list: { id: number; color: string }[]) {
    this.surfaceWanted = new Set(list.map((s) => s.id));
    for (const [id, mesh] of this.surfaces) {
      if (this.surfaceWanted.has(id)) continue;
      this.surfaceGroup.remove(mesh);
      disposeTree(mesh);
      this.surfaces.delete(id);
      this.dirty = true;
    }
    await Promise.all(
      list
        .filter((s) => !this.surfaces.has(s.id))
        .map(async (s) => {
          try {
            const mesh = await this.loadMesh(s.id, s.color, this.surfaceOpacity, false);
            // Dropped, replaced or already loaded by a newer call while this one loaded.
            if (this.disposed || !this.surfaceWanted.has(s.id) || this.surfaces.has(s.id)) {
              disposeTree(mesh);
              return;
            }
            this.styleSurface(mesh);
            this.surfaces.set(s.id, mesh);
            this.surfaceGroup.add(mesh);
            this.dirty = true;
          } catch {
            // no model for this structure: the tree only offers ones that have one
          }
        }),
    );
  }

  /** How solid the extra surfaces are, 0.2 to 1. */
  setSurfaceOpacity(opacity: number) {
    this.surfaceOpacity = THREE.MathUtils.clamp(opacity, 0.2, 1);
    for (const m of this.surfaces.values()) this.styleSurface(m);
  }

  setPlanesVisible(visible: boolean) {
    this.planesVisible = visible;
    this.applyVisibility();
  }

  setAxesVisible(visible: boolean) {
    this.axesVisible = visible;
    this.applyVisibility();
  }

  /** The display options, applied to whatever has loaded. In eBrain mode the
   *  planes stay: they are what you click. */
  private applyVisibility() {
    this.dirty = true;
    if (this.shell) this.shell.visible = this.shellVisible;
    if (this.axes) this.axes.visible = this.axesVisible;
    for (const v of PLANE_ORDER) if (this.planes[v]) this.planes[v].group.visible = this.planesVisible || this.ebrain;
  }

  private styleSurface(mesh: THREE.Mesh) {
    this.dirty = true;
    const mat = mesh.material as THREE.MeshPhysicalMaterial;
    mat.opacity = this.surfaceOpacity; // a uniform: no rebuild needed
    const transparent = this.surfaceOpacity < 1;
    // In eBrain mode, cut the same octant as the shell so the painted planes show.
    const clipped = this.ebrain;
    const wasClipped = !!mat.clippingPlanes?.length;
    mat.depthWrite = !transparent; // render state, not part of the program
    if (mat.transparent !== transparent || clipped !== wasClipped) {
      mat.transparent = transparent;
      mat.clippingPlanes = clipped ? [this.clip.coronal, this.clip.transverse, this.clip.sagittal] : null;
      mat.clipIntersection = true;
      mat.needsUpdate = true; // the shader program changes
    }
  }

  setShellVisible(visible: boolean) {
    this.shellVisible = visible;
    this.applyVisibility();
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
    // Whichever shell material isn't on the mesh right now isn't in the scene.
    this.shellGlass.dispose();
    this.shellSolid.dispose();
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
    const found = await loadStructureMesh(this.loader, id);
    found.material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      roughness: 0.55,
      metalness: 0.05,
      clearcoat: 0.15,
      transparent: true,
      opacity,
      depthWrite: !isShell,
      side: THREE.FrontSide,
    });
    return found;
  }

  private async initShell() {
    try {
      const mesh = (await this.loadMesh(ROOT_STRUCTURE_ID, '#c9d1d2', 1, true)) as NonNullable<BrainViewer['shell']>;
      if (this.disposed) {
        disposeTree(mesh);
        return;
      }
      // Its loaded material is replaced by the glass / solid pair (see applyAppearance).
      mesh.material.dispose();
      mesh.material = this.shellGlass;
      this.shell = mesh;
      this.root.add(mesh);
      this.dirty = true;
      this.frame(mesh);
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox!;
      const center = bb.getCenter(new THREE.Vector3());
      const size = bb.getSize(new THREE.Vector3());
      this.bounds = { center, size, min: bb.min.clone() };
      // The labels are drawn once into a texture: make sure their font is there first.
      await document.fonts?.load('500 24px "JetBrains Mono Variable"').catch(() => undefined);
      if (this.disposed) return;
      this.buildAxes(center, size);
      this.buildPlanes(size);
      for (const v of PLANE_ORDER) this.placePlane(v);
      this.applyAppearance();
      this.applyVisibility();
      this.home = { position: this.camera.position.clone(), target: this.controls.target.clone() };
      this.events.onReady?.();
      if (this.region) this.flyTo(this.region); // it loaded before the shell
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
    this.camera.position.copy(center).addScaledVector(new THREE.Vector3(0.8, 0.5, -1).normalize(), dist);
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
    // Axes are reference, not content: one muted grey (the planes carry colour).
    const AXIS = 0x87918f;
    g.add(line(new THREE.Vector3(1, 0, 0), AXIS), line(new THREE.Vector3(0, 1, 0), AXIS), line(new THREE.Vector3(0, 0, 1), AXIS));
    const label = (text: string, pos: THREE.Vector3, color: number) => {
      const cvs = document.createElement('canvas');
      cvs.width = 192;
      cvs.height = 64;
      const ctx = cvs.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.font = '500 24px "JetBrains Mono Variable", ui-monospace, monospace';
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
    label('Ant', new THREE.Vector3(-off, 0, 0), AXIS);
    label('Post', new THREE.Vector3(off, 0, 0), AXIS);
    label('Sup', new THREE.Vector3(0, -off, 0), AXIS);
    label('Inf', new THREE.Vector3(0, off, 0), AXIS);
    label('Left', new THREE.Vector3(0, 0, -off), AXIS);
    label('Right', new THREE.Vector3(0, 0, off), AXIS);
    this.root.add(g);
    this.axes = g;
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
    this.dirty = true;
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
    this.dirty = true;
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
    for (const m of this.surfaces.values()) this.styleSurface(m);
    this.applyVisibility();
    if (!this.shell) return;
    if (this.ebrain) {
      this.updateClipPlanes();
      this.shellSolid.clippingPlanes = [this.clip.coronal, this.clip.transverse, this.clip.sagittal];
      this.shellSolid.clipIntersection = true; // cut only where all three agree: one octant
      this.shell.material = this.shellSolid;
    } else {
      this.shell.material = this.shellGlass;
    }
  }

  // --- Camera ------------------------------------------------------------------

  /** Glide to a pose (instantly under reduced motion). */
  private moveCamera(position: THREE.Vector3, target: THREE.Vector3) {
    if (prefersReducedMotion()) {
      this.tween = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      return;
    }
    // Drop any inertia left from a recent drag, so it can't push the camera off course.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    const from = this.camera.position.clone().sub(this.controls.target);
    const to = position.clone().sub(target);
    const fromDir = from.clone().normalize();
    const toQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position, target, this.camera.up));
    this.tween = {
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      fromDir,
      turn: new THREE.Quaternion().setFromUnitVectors(fromDir, to.clone().normalize()),
      fromLen: from.length(),
      toLen: to.length(),
      fromQuat: this.camera.quaternion.clone(),
      toQuat,
      t0: performance.now(),
      ms: FLY_MS,
    };
  }

  /** Turn toward a newly picked region and come a little closer, keeping the
   *  current viewing angle and enough of the brain around it for context. */
  private flyTo(mesh: THREE.Object3D) {
    if (!this.home) return;
    if (this.presetPose) this.releasePreset();
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const fit = radius / Math.sin(((this.camera.fov * Math.PI) / 180) / 2);
    const homeDist = this.home.position.distanceTo(this.home.target);
    const dist = THREE.MathUtils.clamp(fit * 1.6, homeDist * 0.55, homeDist);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.moveCamera(center.clone().addScaledVector(dir, dist), center);
  }

  /** Tell the page where the region's anchor is on screen (only when it moved). */
  private emitAnchor() {
    const on = this.events.onAnchor;
    if (!on) return;
    let next: { x: number; y: number; settled: boolean } | null = null;
    if (this.anchor && this.region) {
      const v = this.region.localToWorld(this.anchor.clone()).project(this.camera);
      // In front of the camera and inside the canvas (else no label at all).
      if (v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) {
        next = {
          x: Math.round((v.x * 0.5 + 0.5) * this.canvas.clientWidth * 2) / 2,
          y: Math.round((-v.y * 0.5 + 0.5) * this.canvas.clientHeight * 2) / 2,
          settled: !this.tween,
        };
      }
    }
    const key = next ? `${next.x},${next.y},${next.settled}` : '';
    if (key === this.lastAnchor) return;
    this.lastAnchor = key;
    on(next);
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
      const local = this.root.worldToLocal(h.point.clone());
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
    this.dirty = true;
    this.hover = { view, id };
    for (const v of PLANE_ORDER) {
      const u = this.planes[v]?.volumeMat?.uniforms;
      if (!u) continue;
      u.uHoverId!.value = v === view ? Math.max(0, id | 0) : 0;
      u.uPlaneActive!.value = v === view ? 1 : 0;
    }
  }

  private placeMarker(world: THREE.Vector3, view: Plane) {
    this.dirty = true;
    if (!this.marker) {
      const mat = (opacity: number) => new THREE.MeshBasicMaterial({ color: 0xc4a46a, transparent: true, opacity, depthTest: false });
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
    this.dirty = true;
    if (!this.region) return;
    this.root.remove(this.region);
    disposeTree(this.region);
    this.region = null;
    this.anchor = null;
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
      this.dirty = true;
    }
    const flying = !!this.tween;
    if (this.tween) {
      const t = this.tween;
      const k = Math.min(1, (performance.now() - t.t0) / t.ms);
      const ease = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2; // ease-in-out (cubic)
      this.controls.target.lerpVectors(t.fromTarget, t.toTarget, ease);
      const dir = this.tmpDir.copy(t.fromDir).applyQuaternion(this.tmpQuat.identity().slerp(t.turn, ease));
      this.camera.position.copy(this.controls.target).addScaledVector(dir, THREE.MathUtils.lerp(t.fromLen, t.toLen, ease));
      this.camera.quaternion.slerpQuaternions(t.fromQuat, t.toQuat, ease);
      if (k === 1) {
        this.tween = null;
        this.dirty = true; // one more frame, with OrbitControls back in charge
      }
    }
    // During a flight the camera is posed directly (OrbitControls would re-aim it
    // and flip it over a pole). Otherwise update() reports whether it moved: a
    // drag, or damping settling after one.
    const moved = this.tween ? false : this.controls.update();
    // Nothing moved and nothing changed: skip the frame. A still brain costs no GPU time.
    if (!moved && !flying && !this.dirty) return;
    this.dirty = false;
    if (this.ebrain && this.followCamera()) this.updateClipPlanes();
    this.renderer.render(this.scene, this.camera);
    this.emitAnchor();
    this.emitOrient();
    this.emitScale(h);
  };

  private lastScale = 0;
  /** Pixels per µm at the orbit target (scene units are µm). Reported when it changes by more than 0.5%. */
  private emitScale(heightPx: number) {
    const on = this.events.onScale;
    if (!on) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const visible = 2 * dist * Math.tan(((this.camera.fov * Math.PI) / 180) / 2);
    const pxPerUm = heightPx / visible;
    if (Math.abs(pxPerUm - this.lastScale) <= this.lastScale * 0.005) return;
    this.lastScale = pxPerUm;
    on(pxPerUm);
  }

  private lastOrient = '';
  /** Tell the page where the anatomical axes point on screen (only when they moved). */
  private emitOrient() {
    const on = this.events.onOrient;
    if (!on) return;
    const e = this.camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]);
    const up = new THREE.Vector3(e[4], e[5], e[6]);
    const back = new THREE.Vector3(e[8], e[9], e[10]);
    const screen = (a: THREE.Vector3) => ({ x: a.dot(right), y: a.dot(up), z: a.dot(back) });
    const o: Orientation = { p: screen(AXIS_P), d: screen(AXIS_D), r: screen(AXIS_R) };
    const key = [o.p, o.d, o.r].map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`).join(';');
    if (key === this.lastOrient) return;
    this.lastOrient = key;
    on(o);
  }
}

/** The surface vertex nearest the middle of a mesh's box: on the region even
 *  when it curves around its own centre (the hippocampus does). */
function surfaceAnchor(geometry: THREE.BufferGeometry): THREE.Vector3 | null {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count === 0) return null;
  geometry.computeBoundingBox();
  const mid = geometry.boundingBox!.getCenter(new THREE.Vector3());
  const p = new THREE.Vector3();
  const best = new THREE.Vector3();
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(pos.count / 4000));
  for (let i = 0; i < pos.count; i += step) {
    p.fromBufferAttribute(pos, i);
    const d = p.distanceToSquared(mid);
    if (d < bestD) {
      bestD = d;
      best.copy(p);
    }
  }
  return best;
}
