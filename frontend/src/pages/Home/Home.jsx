import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";

function Model({ url }) {
  const { scene } = useGLTF(url);
  scene.traverse((child) => console.log(child.name, child.isMesh));
  scene.traverse((child) => {
    if (child.isMesh) {
      const color = 0xc88d94;
      child.material = new THREE.MeshStandardMaterial({ color });
    }
  });
  return <primitive object={scene} scale={1} />;
}

function Home() {
  return (
    <div>
      <h1>Welcome to the Brain Atlas</h1>
      <p>Explore brain regions using the Allen Brain Atlas API.</p>
      <div style={{width: "100%", height: "80vh"}}>
        <Canvas>
          <ambientLight intensity={1.5}/>
          <directionalLight position={[5, 5, 5]} intensity={1}/>
          <Model url="/models/human_brain.glb"/>
          <OrbitControls enableZoom={true}/>
        </Canvas>
      </div>
    </div>
  );
}

export default Home;
