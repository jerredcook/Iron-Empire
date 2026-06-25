import * as THREE from 'three';
import { CarType } from './Cargo';

/**
 * The rolling stock that trails the locomotive. Each car TYPE has its own silhouette —
 * a closed boxcar, an open bulk hopper, a slatted stock car, a windowed passenger coach,
 * or a low flatcar with a load — so a moving consist reads its manifest at a glance. The
 * body material is unique per car so the network can re-livery it to the cargo it hauls
 * (empty cars ride drab grey). Built +Z forward like the loco; wheels sit at y≈0.38 so
 * the same rail-contact offset used for the engine drops it onto the railhead.
 */
export interface FreightCar {
  group: THREE.Group;
  setLivery(color: number | null): void;
  /** Show how full the car is (0..1): a heap in the hopper, a stack on the flat, lit windows in
   *  the coach. Eased internally so a load fills in and empties out smoothly. */
  setLoad(fraction: number): void;
  /** Free this car's unique materials (its geometry is freed by Train.dispose). */
  dispose(): void;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// Shared, app-lifetime materials — never disposed per car (only per-car body is unique).
const FRAME = new THREE.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.6, roughness: 0.5 });
const WHEEL = new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.7, roughness: 0.4 });
const ROOF = new THREE.MeshStandardMaterial({ color: 0x3b3631, metalness: 0.2, roughness: 0.8 });
const SLAT = new THREE.MeshStandardMaterial({ color: 0x6e5a3e, metalness: 0.1, roughness: 0.85 });
const EMPTY = 0x6b6660;

function addUnderframe(g: THREE.Group, halfBase = 0.92): void {
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.25, 5.0), FRAME);
  frame.position.y = 1.2;
  g.add(frame);
  // Per-car wheel geometry (shared across this car's four wheels) — Train.dispose frees
  // per-instance geometry, so this must NOT be hoisted to a module-level singleton.
  const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.18, 16);
  wheelGeo.rotateZ(Math.PI / 2);
  for (const z of [-1.7, 1.7]) {
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, WHEEL);
      w.position.set(sx * halfBase, 0.38, z);
      g.add(w);
    }
  }
}

function finish(
  g: THREE.Group,
  body: THREE.MeshStandardMaterial,
  setLoad: (fraction: number) => void = () => {},
  extraMats: THREE.Material[] = []
): FreightCar {
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
    setLoad,
    dispose() {
      body.dispose();
      for (const m of extraMats) m.dispose();
    },
  };
}

/** A load visual that eases toward its target each call (so it fills/empties smoothly). */
function eased(apply: (shown: number) => void): (target: number) => void {
  let shown = 0;
  apply(0);
  return (target: number) => {
    shown += (clamp01(target) - shown) * 0.12;
    apply(shown);
  };
}

/** Closed boxcar with a pitched roof and a sliding-door seam — packaged goods, steel… */
function boxcar(): FreightCar {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: EMPTY, metalness: 0.25, roughness: 0.7 });
  addUnderframe(g);
  const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.9, 4.7), body);
  box.position.y = 2.35;
  g.add(box);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.34, 0.18, 4.84), ROOF);
  roof.position.y = 3.4;
  g.add(roof);
  for (const sx of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.6, 1.6), FRAME);
    door.position.set(sx * 1.12, 2.35, 0);
    g.add(door);
  }
  return finish(g, body);
}

/** Open-topped bulk hopper with sloped ends — coal, iron ore, grain. No roof reads as
 *  "open", and the inward-sloped end panels read as the discharge bays. */
function hopper(): FreightCar {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: EMPTY, metalness: 0.3, roughness: 0.7 });
  addUnderframe(g);
  // Sidewalls (tall, open top).
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.7, 4.6), body);
    side.position.set(sx * 1.05, 2.25, 0);
    g.add(side);
  }
  // Sloped end bays angled toward the centre discharge.
  for (const z of [-1, 1]) {
    const end = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.7, 0.16), body);
    end.position.set(0, 2.25, z * 2.2);
    end.rotation.x = z * 0.32;
    g.add(end);
  }
  // Dark interior load bed (shows the bulk sitting low in the bin).
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 4.2), FRAME);
  bed.position.y = 1.65;
  g.add(bed);
  // Heaped bulk in the bin (the livery-coloured cargo) — grows with the load.
  const FLOOR = 1.9, FULL = 1.25;
  const heap = new THREE.Mesh(new THREE.BoxGeometry(1.92, FULL, 4.3), body);
  g.add(heap);
  return finish(
    g,
    body,
    eased((s) => {
      heap.visible = s > 0.02;
      heap.scale.y = Math.max(0.001, s);
      heap.position.y = FLOOR + (FULL * s) / 2;
    })
  );
}

/** Slatted livestock car — a boxcar frame with gapped horizontal slats and an open roof
 *  vent, so it reads woody and airy rather than sealed. Cattle. */
function stock(): FreightCar {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: EMPTY, metalness: 0.1, roughness: 0.85 });
  addUnderframe(g);
  // Posts at the corners.
  for (const sx of [-1, 1]) {
    for (const z of [-2.1, 2.1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.9, 0.18), SLAT);
      post.position.set(sx * 1.05, 2.3, z);
      g.add(post);
    }
  }
  // Horizontal slats (the visible livery body) with gaps between them.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 4.5), body);
      slat.position.set(sx * 1.05, 1.75 + i * 0.42, 0);
      g.add(slat);
    }
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.16, 4.8), ROOF);
  roof.position.y = 3.45;
  g.add(roof);
  return finish(g, body);
}

/** Passenger coach — longer, taller, with a window band and a raised clerestory roof.
 *  Passengers & mail. */
function coach(): FreightCar {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: EMPTY, metalness: 0.3, roughness: 0.5 });
  addUnderframe(g);
  const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.1, 5.0), body);
  box.position.y = 2.45;
  g.add(box);
  // Continuous window band down each side — its own material so the lights can come on with
  // passengers aboard and fade out as the coach empties at the platform.
  const windows = new THREE.MeshStandardMaterial({ color: 0x1c2630, emissive: 0xffdf9e, emissiveIntensity: 0, metalness: 0.3, roughness: 0.3 });
  for (const sx of [-1, 1]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 4.2), windows);
    band.position.set(sx * 1.12, 2.7, 0);
    g.add(band);
  }
  // Raised clerestory roof.
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.16, 5.1), ROOF);
  roof.position.y = 3.55;
  g.add(roof);
  const clerestory = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.26, 4.4), ROOF);
  clerestory.position.y = 3.74;
  g.add(clerestory);
  return finish(
    g,
    body,
    eased((s) => { windows.emissiveIntensity = s * 2.4; }), // lights brighten with passengers
    [windows]
  );
}

/** Low flatcar carrying a stacked load (the livery-coloured cargo) — lumber, steel. */
function flat(): FreightCar {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: EMPTY, metalness: 0.2, roughness: 0.75 });
  addUnderframe(g);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.2, 5.0), FRAME);
  deck.position.y = 1.5;
  g.add(deck);
  // Two stacked rows of the load (the livery-coloured cargo), banded by stakes — the rows
  // appear as the flat is loaded and clear off when it's emptied, so a bare deck reads "empty".
  const rows: THREE.Mesh[] = [];
  for (let row = 0; row < 2; row++) {
    const load = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.4), body);
    load.position.y = 1.95 + row * 0.6;
    g.add(load);
    rows.push(load);
  }
  for (const sx of [-1, 1]) {
    for (const z of [-1.6, 0, 1.6]) {
      const stake = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), FRAME);
      stake.position.set(sx * 1.05, 2.05, z);
      g.add(stake);
    }
  }
  return finish(
    g,
    body,
    eased((s) => {
      rows[0].visible = s > 0.06;
      rows[1].visible = s > 0.5; // second tier only when more than half loaded
    })
  );
}

const BUILDERS: Record<CarType, () => FreightCar> = {
  boxcar,
  hopper,
  stock,
  coach,
  flat,
};

/** Build the rolling stock for a cargo's car type. */
export function buildCar(type: CarType): FreightCar {
  return BUILDERS[type]();
}

/** Back-compat: a plain boxcar. */
export function buildBoxcar(): FreightCar {
  return boxcar();
}
