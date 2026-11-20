// The home page's brain: the major divisions of the Allen CCFv3 as surfaces
// in their atlas colours, turned by dragging, named on hover. A plain class
// like BrainViewer (no React), loaded on demand so the page itself stays light.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadStructureMesh, prefersReducedMotion } from './shared';

export interface HomeRegion {
  id: number;
  acronym: string;
  name: string;
  color: string;
}

export interface HomeBrainEvents {
  /** The region under the pointer and where the pointer is (CSS px in the canvas), or null. */
  onHover: (h: { region: HomeRegion; x: number; y: number } | null) => void;
  /** Every surface has loaded and the first frame is drawn. */
  onReady: () => void;
  /** Nothing could be shown (no WebGL, or no surfaces loaded). */
  onError: (err: unknown) => void;
}

const ENTER_MS = 900;

export class HomeBrain {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 100, 200000);
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  /** Sits at the brain's centre; the entrance turns this, so the brain turns in place. */
  private readonly pivot = new THREE.Group();
  private readonly ray = new THREE.Raycaster();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly regionOf = new Map<THREE.Object3D, HomeRegion>();
  private hovered: THREE.Mesh | null = null;
  private raf = 0; // the one requested frame, 0 when none is pending
  private probeRaf = 0;
  private resize: ResizeObserver | null = null;
  private disposed = false;
  private enterAt = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    regions: HomeRegion[],
    private readonly events: HomeBrainEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);

    // Darkfield: one warm key light from above-front, a cool rim from behind.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x202226, 0.9));
    const key = new THREE.DirectionalLight(0xfff4e6, 1.5);
    key.position.set(-1, 1.4, 0.8);
    const rim = new THREE.DirectionalLight(0xbcd2ff, 0.6);
    rim.position.set(1, 0.2, -1.2);
    this.scene.add(key, rim);

    // Mesh space is PIR; a half-turn about x puts dorsal up without mirroring.
    this.root.rotation.x = Math.PI;
    this.pivot.add(this.root);
    this.scene.add(this.pivot);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enableZoom = false; // the page scrolls; the brain doesn't zoom
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.7;
    // OrbitControls sets touch-action: none; let a vertical swipe scroll the page
    // on a phone (a sideways drag still turns the brain).
    canvas.style.touchAction = 'pan-y';
    // Draw only when something changed: a drag, damping settling, the entrance,
    // a hover, a resize. A still brain costs nothing.
    const onChange = () => this.requestRender();
    this.controls.addEventListener('change', onChange);
    this.cleanup.push(() => this.controls.removeEventListener('change', onChange));
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.requestRender());
      this.resize.observe(canvas);
    }

    // One raycast per frame at most, however fast the pointer reports.
    let last: PointerEvent | null = null;
    const move = (e: PointerEvent) => {
      last = e;
      if (this.probeRaf) return;
      this.probeRaf = requestAnimationFrame(() => {
        this.probeRaf = 0;
        if (last && !this.disposed) this.probe(last);
      });
    };
    const leave = () => {
      cancelAnimationFrame(this.probeRaf);
      this.probeRaf = 0;
      this.setHover(null, 0, 0);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    this.cleanup.push(() => canvas.removeEventListener('pointermove', move), () => canvas.removeEventListener('pointerleave', leave));

    this.load(regions).catch((err: unknown) => {
      if (!this.disposed) this.events.onError(err);
    });
  }

  private async load(regions: HomeRegion[]) {
    const loader = new GLTFLoader();
    const loaded = await Promise.all(
      regions.map(async (r) => {
        try {
          return { r, mesh: await loadStructureMesh(loader, r.id) };
        } catch {
          return null; // one missing surface doesn't stop the rest
        }
      }),
    );
    if (this.disposed) return;
    for (const item of loaded) {
      if (!item) continue;
      const { r, mesh } = item;
      mesh.material = new THREE.MeshStandardMaterial({ color: new THREE.Color(r.color), roughness: 0.55, metalness: 0 });
      this.root.add(mesh);
      this.meshes.push(mesh);
      this.regionOf.set(mesh, r);
    }
    if (this.meshes.length === 0) throw new Error('No brain surfaces could be loaded.');
    this.syncSize();
    this.frame();
    this.enterAt = prefersReducedMotion() ? 0 : performance.now();
    this.requestRender();
    this.events.onReady();
  }

  private radius = 0;

  /** Look from anterior-left-dorsal, the whole brain in view. */
  private frame() {
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    const center = box.getCenter(new THREE.Vector3());
    // Move the pivot to the centre and the brain back by as much: same place, new turning point.
    this.pivot.position.copy(center);
    this.root.position.sub(center);
    this.radius = box.getSize(new THREE.Vector3()).length() / 2;
    this.controls.target.copy(center);
    // World: +x posterior, +y dorsal, +z left.
    this.camera.position.copy(center).addScaledVector(new THREE.Vector3(-0.75, 0.6, 0.95).normalize(), this.fitDistance());
    this.controls.update();
  }

  /** How far back the camera stands so the brain fills the canvas, whichever of
   *  its width or height is the tighter fit (a phone's canvas is narrow). */
  private fitDistance() {
    const vHalf = ((this.camera.fov * Math.PI) / 180) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    // The bounding sphere is loose around the brain's flat shape: 0.62 fills the frame well.
    return (this.radius / Math.sin(Math.min(vHalf, hHalf))) * 0.62;
  }

  private probe(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObjects(this.meshes, false)[0];
    this.setHover((hit?.object as THREE.Mesh | undefined) ?? null, x, y);
  }

  private setHover(mesh: THREE.Mesh | null, x: number, y: number) {
    if (mesh !== this.hovered) {
      if (this.hovered) (this.hovered.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
      if (mesh) (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x1c1c1c);
      this.hovered = mesh;
      this.requestRender();
    }
    const region = mesh ? this.regionOf.get(mesh) : undefined;
    this.events.onHover(region ? { region, x, y } : null);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.probeRaf);
    this.cleanup.forEach((f) => f());
    this.resize?.disconnect();
    this.controls.dispose();
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.renderer.dispose();
  }

  /** Match the drawing buffer and camera to the canvas; on a size change, keep the
   *  viewing angle and refit the distance. False while the canvas has no size. */
  private syncSize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return false;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.radius) {
        const dir = this.camera.position.clone().sub(this.controls.target).normalize();
        this.camera.position.copy(this.controls.target).addScaledVector(dir, this.fitDistance());
      }
    }
    return true;
  }

  private requestRender() {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(this.render);
  }

  private render = () => {
    this.raf = 0;
    if (this.disposed) return;
    if (!this.syncSize()) return;
    // The entrance: the brain turns into place once, easing out.
    let moving = false;
    if (this.enterAt) {
      const k = Math.min(1, (performance.now() - this.enterAt) / ENTER_MS);
      this.pivot.rotation.y = -0.6 * (1 - k) ** 3;
      if (k === 1) this.enterAt = 0;
      else moving = true;
    }
    // With damping, update() keeps moving the camera after a drag ends; its
    // 'change' event asks for the next frame until it settles.
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (moving) this.requestRender();
  };
}
