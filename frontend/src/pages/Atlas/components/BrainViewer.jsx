import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { useRef, useEffect, useState } from "react";
//raycasting to handle clicks on 3D objects
function BrainModel({ url }) {
  const groupRef = useRef();//
  const { scene } = useGLTF(url);//load the brain model
  const [materialsInitialized, setMaterialsInitialized] = useState(false);//state to track if materials are cloned (to multiple clones issue)

  // Initialize/clone materials only once (multiple objects share same material instance by default to save memory,if don't clone, changing one object changes all)
  useEffect(() => {//(why useEffect? to run after initial render)
    if (!materialsInitialized) {
      scene.traverse((child) => {// traverse all meshes in brain model
        if (child.isMesh) {//only process mesh objects
          child.material = child.material.clone();//clone material to avoid shared instance issues
          child.material.color.set(0xc88d94);//set base color
          child.material.emissive = new THREE.Color(0x000000);//set glow to black initially
          child.material.needsUpdate = true;//tell GPU to update material base of click changes
        }
      });
      setMaterialsInitialized(true);//prevent from recloning on re-renders
    }
  }, [scene, materialsInitialized]);

  // Handle click
  const { camera, gl } = useThree();//camera and renderer
  
  useEffect(() => {
    const raycaster = new THREE.Raycaster();//to cast rays from camera through mouse position
    const mouse = new THREE.Vector2();//to store mouse coordinates
    
    function onClick(event) {
      // return an object with size and position of the canvas(html element)
      const rect = gl.domElement.getBoundingClientRect();
      
      // Calculate mouse position in normalized device coordinates
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      
      raycaster.setFromCamera(mouse, camera);//ray from camera(0,0,200)towards the brain (0,0,0) through mouse position
      
      // Check which objects intersect with the ray(returns array of intersected objects, closest first)
      const intersects = raycaster.intersectObjects(scene.children, true);
      
      if (intersects.length > 0) {//if ray hit something
        const intersected = intersects[0].object;//get closest intersected object
        
        //  This loops through ALL brain meshes and resets them to the base pink color with no glow.
        //  This ensures only the newly clicked mesh is highlighted (not multiple meshes at once)
        //  if remove multiple brain parts can stay highlighted
        scene.traverse((child) => {
          if (child.isMesh) {
            child.material.color.set(0xc88d94);
            child.material.emissive.set(0x000000);
          }
        });
        
        // Highlight clicked mesh
        intersected.material.color.set(0xff0000);//change color to red
        intersected.material.emissive.set(0x330000); // add subtle dark glow
        intersected.material.needsUpdate = true;
        
        console.log("Clicked on mesh:", intersected.name || "unnamed mesh");//log clicked mesh name
      }
    }
    
    gl.domElement.addEventListener("click", onClick);//add click listener to canvas
    return () => gl.domElement.removeEventListener("click", onClick);//prevent memory leaks(good practice)
  }, [camera, gl, scene]);

  return <primitive ref={groupRef} object={scene} scale={1} />;//render the loaded brain model
}

export function BrainViewer({ modelUrl = "/models/brain.glb" }) {
  return (
    <div style={{ width: "100%", height: "80vh" }}>
      <Canvas camera={{ position: [0, 0, 200], fov: 50 }}>
        <ambientLight intensity={1.5} />
        <directionalLight position={[5, 5, 5]} intensity={1} />
        <BrainModel url={modelUrl} />
        <OrbitControls
          enableZoom={true}
          minDistance={150}
          maxDistance={300}
        />
      </Canvas>
    </div>
  );
}