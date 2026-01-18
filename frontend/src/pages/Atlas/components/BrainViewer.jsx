import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";

function BrainModel({ url }) {
  const { scene } = useGLTF(url);
  scene.traverse((child) => {
    if (child.isMesh) {
      const color = 0xc88d94;
      child.material = new THREE.MeshStandardMaterial({ color });
    }
  });
  return <primitive object={scene} scale={1} />;
}

export function BrainViewer({ modelUrl = "/models/human_brain.glb" }) {
  return (
    <div style={{ width: "100%", height: "80vh" }}>
      <Canvas>
        <ambientLight intensity={1.5} />
        <directionalLight position={[5, 5, 5]} intensity={1} />
        <BrainModel url={modelUrl} />
        <OrbitControls enableZoom={true} />
      </Canvas>
    </div>
  );
}
