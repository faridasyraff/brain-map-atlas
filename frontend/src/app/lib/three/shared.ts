// Shared by the atlas viewer (BrainViewer) and the home page brain (HomeBrain).
import type * as THREE from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Where the backend serves one GLB surface per Allen structure ID. */
export const MESH_BASE = '/meshes/';

export const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Load a structure's surface: the first mesh in its GLB (each file holds one). */
export async function loadStructureMesh(loader: GLTFLoader, id: number): Promise<THREE.Mesh> {
  const gltf = await loader.loadAsync(`${MESH_BASE}${id}.glb`);
  let mesh: THREE.Mesh | null = null;
  gltf.scene.traverse((o) => {
    if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
  });
  const found = mesh as THREE.Mesh | null;
  if (!found) throw new Error(`No surface in ${id}.glb`);
  if (!found.geometry.attributes.normal) found.geometry.computeVertexNormals();
  found.removeFromParent();
  return found;
}
