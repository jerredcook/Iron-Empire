import * as THREE from 'three';

/**
 * A simple boxcar that trails the locomotive. The body material is unique per car so
 * the network can re-livery it to the cargo it's hauling (empty cars ride drab grey).
 * Built +Z forward like the loco; wheels sit at y≈0.38 so the same rail-contact
 * offset used for the engine drops it onto the railhead.
 */
export interface FreightCar {
  group: THREE.Group;
  setLivery(color: number | null): void;
}

const FRAME = new THREE.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.6, roughness: 0.5 });
const WHEEL = new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.7, roughness: 0.4 });
const ROOF = new THREE.MeshStandardMaterial({ color: 0x3b3631, metalness: 0.2, roughness: 0.8 });
const EMPTY = 0x6b6660;

export function buildBoxcar(): FreightCar {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: EMPTY, metalness: 0.25, roughness: 0.7 });

  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.25, 5.0), FRAME);
  frame.position.y = 1.2;
  g.add(frame);

  const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.9, 4.7), body);
  box.position.y = 2.35;
  g.add(box);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.34, 0.18, 4.84), ROOF);
  roof.position.y = 3.4;
  g.add(roof);

  // Sliding-door seam down each side, just trim geometry for read.
  for (const sx of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.6, 1.6), FRAME);
    door.position.set(sx * 1.12, 2.35, 0);
    g.add(door);
  }

  const wheel = new THREE.CylinderGeometry(0.38, 0.38, 0.18, 16);
  wheel.rotateZ(Math.PI / 2);
  for (const z of [-1.7, 1.7]) {
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(wheel, WHEEL);
      w.position.set(sx * 0.92, 0.38, z);
      g.add(w);
    }
  }

  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return {
    group: g,
    setLivery(color: number | null) {
      body.color.setHex(color ?? EMPTY);
    },
  };
}
