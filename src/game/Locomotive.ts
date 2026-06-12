import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Hero locomotive: a classic American 4-4-0 built at prop quality — tapered boiler
 * with cladding bands, balloon stack, brass domes/bell, glazed cab, spoked driving
 * wheels with animated side + main rods, leading bogie, and a coal tender. PBR
 * satin-metal materials pick up the HDRI so it reads like painted steel.
 *
 * The +Z axis is forward. Wheels/rods animate via setWheelAngle().
 */

const MAT = {
  iron: new THREE.MeshStandardMaterial({ color: 0x16181c, metalness: 0.78, roughness: 0.38 }),
  boiler: new THREE.MeshStandardMaterial({ color: 0x101418, metalness: 0.7, roughness: 0.3 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 1.0, roughness: 0.22 }),
  cab: new THREE.MeshStandardMaterial({ color: 0x5e1f1a, metalness: 0.35, roughness: 0.45 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x2a3942, metalness: 0.2, roughness: 0.08 }),
  rod: new THREE.MeshStandardMaterial({ color: 0x9aa2ab, metalness: 0.95, roughness: 0.22 }),
  coal: new THREE.MeshStandardMaterial({ color: 0x0c0c0e, metalness: 0.1, roughness: 0.95 }),
  red: new THREE.MeshStandardMaterial({ color: 0x7e2a20, metalness: 0.4, roughness: 0.4 }),
};

function spokedWheel(radius: number, spokes: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rim = new THREE.TorusGeometry(radius - 0.05, 0.085, 10, 28);
  parts.push(rim);
  const tyre = new THREE.CylinderGeometry(radius + 0.045, radius + 0.045, 0.12, 28, 1, true);
  tyre.rotateX(Math.PI / 2);
  parts.push(tyre);
  const hub = new THREE.CylinderGeometry(0.14, 0.14, 0.18, 14);
  hub.rotateX(Math.PI / 2);
  parts.push(hub);
  for (let i = 0; i < spokes; i++) {
    const s = new THREE.BoxGeometry(0.055, radius - 0.12, 0.05);
    s.translate(0, (radius - 0.1) / 2, 0);
    s.rotateZ((i / spokes) * Math.PI * 2);
    parts.push(s);
  }
  // Crank boss offset from centre (rod attachment).
  const crank = new THREE.CylinderGeometry(0.09, 0.09, 0.24, 10);
  crank.rotateX(Math.PI / 2);
  crank.translate(0, -(radius * 0.55), 0.1);
  parts.push(crank);
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false)!;
}

export interface LocomotiveRig {
  group: THREE.Group;
  /** Drive-wheel radius (for wheel-speed sync). */
  driverRadius: number;
  /** World-space chimney tip (recomputed each call). */
  chimneyTip(target: THREE.Vector3): THREE.Vector3;
  setWheelAngle(angle: number): void;
}

export function buildLocomotive(): LocomotiveRig {
  const g = new THREE.Group();
  const driverR = 0.85;

  // ---- frame & running boards ----
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.28, 7.6), MAT.iron);
  frame.position.set(0, 1.05, 0.4);
  g.add(frame);
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 5.4), MAT.iron);
  board.position.set(0, 1.66, 1.2);
  g.add(board);

  // ---- boiler: tapered courses + smokebox ----
  const boiler = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.84, 3.6, 24), MAT.boiler);
  boiler.rotation.x = Math.PI / 2;
  boiler.position.set(0, 2.18, 1.4);
  g.add(boiler);
  const smokebox = new THREE.Mesh(new THREE.CylinderGeometry(0.86, 0.86, 1.1, 24), MAT.iron);
  smokebox.rotation.x = Math.PI / 2;
  smokebox.position.set(0, 2.18, 3.7);
  g.add(smokebox);
  const door = new THREE.Mesh(new THREE.SphereGeometry(0.86, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), MAT.iron);
  door.rotation.x = Math.PI / 2;
  door.position.set(0, 2.18, 4.25);
  g.add(door);
  for (const bz of [0.2, 1.2, 2.2]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.815, 0.022, 8, 28), MAT.brass);
    band.position.set(0, 2.18, bz);
    g.add(band);
  }

  // ---- stack, domes, bell, whistle ----
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.7, 14), MAT.iron);
  stack.position.set(0, 3.15, 3.7);
  g.add(stack);
  const balloon = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.18, 0.62, 18), MAT.iron);
  balloon.position.set(0, 3.7, 3.7);
  g.add(balloon);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.1, 18), MAT.brass);
  cap.position.set(0, 4.04, 3.7);
  g.add(cap);
  const steamDome = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 12), MAT.brass);
  steamDome.position.set(0, 3.0, 1.0);
  steamDome.scale.y = 1.15;
  g.add(steamDome);
  const sandDome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 10), MAT.boiler);
  sandDome.position.set(0, 2.98, 2.2);
  g.add(sandDome);
  const bell = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.26, 12), MAT.brass);
  bell.position.set(0, 3.06, 2.95);
  g.add(bell);

  // ---- headlight ----
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.45), MAT.brass);
  lamp.position.set(0, 3.0, 4.25);
  g.add(lamp);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.18, 16),
    new THREE.MeshStandardMaterial({ color: 0xfff7d8, emissive: 0xffe9a8, emissiveIntensity: 2.2 })
  );
  lens.position.set(0, 3.0, 4.49);
  g.add(lens);

  // ---- cab ----
  const cabWall = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), MAT.cab);
    m.position.set(x, y, z);
    g.add(m);
  };
  cabWall(2.3, 0.1, 1.9, 0, 1.74, -2.1); // floor
  cabWall(0.1, 1.9, 1.9, -1.1, 2.7, -2.1); // left
  cabWall(0.1, 1.9, 1.9, 1.1, 2.7, -2.1); // right
  cabWall(2.3, 1.9, 0.1, 0, 2.7, -1.18); // front (boiler side)
  for (const sx of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.62, 0.8), MAT.glass);
    win.position.set(sx * 1.11, 3.05, -2.0);
    g.add(win);
  }
  const fwin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.06), MAT.glass);
  fwin.position.set(0.6, 3.1, -1.16);
  g.add(fwin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 2.3), MAT.red);
  roof.position.set(0, 3.68, -2.1);
  g.add(roof);

  // ---- pilot (cowcatcher) ----
  const pilot = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.15 - Math.abs(t - 0.5) * 0.7, 0.07), MAT.red);
    bar.position.set((t - 0.5) * 1.7, 0.62 - Math.abs(t - 0.5) * 0.3, 0);
    bar.rotation.x = -0.45;
    pilot.add(bar);
  }
  pilot.position.set(0, 0.35, 4.85);
  g.add(pilot);

  // ---- wheels ----
  const driverGeo = spokedWheel(driverR, 12);
  const bogieGeo = spokedWheel(0.38, 8);
  const drivers: THREE.Mesh[] = [];
  const driverZ = [-0.5, 1.4];
  for (const z of driverZ) {
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(driverGeo, MAT.iron);
      w.position.set(sx * 0.92, driverR, z);
      w.rotation.y = sx > 0 ? 0 : Math.PI;
      g.add(w);
      drivers.push(w);
    }
  }
  const bogies: THREE.Mesh[] = [];
  for (const z of [3.4, 4.3]) {
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(bogieGeo, MAT.iron);
      w.position.set(sx * 0.92, 0.38, z);
      w.rotation.y = sx > 0 ? 0 : Math.PI;
      g.add(w);
      bogies.push(w);
    }
  }

  // ---- rods (animated): side rod links the two crank bosses ----
  const crankR = driverR * 0.55;
  const rods: { mesh: THREE.Mesh; sx: number }[] = [];
  for (const sx of [-1, 1]) {
    const rod = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, driverZ[1] - driverZ[0] + 0.3), MAT.rod);
    rod.castShadow = true;
    g.add(rod);
    rods.push({ mesh: rod, sx });
  }

  // ---- cylinders + main rod (visual, near front) ----
  for (const sx of [-1, 1]) {
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 1.1, 14), MAT.iron);
    cyl.rotation.x = Math.PI / 2;
    cyl.position.set(sx * 0.95, 1.05, 3.2);
    g.add(cyl);
  }

  // ---- tender ----
  const tender = new THREE.Group();
  const tub = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.5, 3.2), MAT.cab);
  tub.position.y = 2.1;
  tender.add(tub);
  const tFrame = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.25, 3.4), MAT.iron);
  tFrame.position.y = 1.2;
  tender.add(tFrame);
  const coal = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 2.4), MAT.coal);
  coal.position.y = 2.95;
  coal.rotation.z = 0.04;
  tender.add(coal);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.34, 0.12, 3.24), MAT.brass);
  stripe.position.y = 2.62;
  tender.add(stripe);
  for (const z of [-1.05, 1.05]) {
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(bogieGeo, MAT.iron);
      w.position.set(sx * 0.92, 0.38, z);
      w.rotation.y = sx > 0 ? 0 : Math.PI;
      tender.add(w);
    }
  }
  tender.position.set(0, 0, -4.6);
  g.add(tender);

  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  const tip = new THREE.Vector3();
  return {
    group: g,
    driverRadius: driverR,
    chimneyTip(target: THREE.Vector3) {
      tip.set(0, 4.1, 3.7);
      return target.copy(tip.applyMatrix4(g.matrixWorld));
    },
    setWheelAngle(angle: number) {
      for (const w of drivers) w.rotation.x = angle;
      for (const w of bogies) w.rotation.x = angle * (driverR / 0.38);
      // Side rods ride the crank circle (90° phase offset per side, like the prototype).
      for (const { mesh, sx } of rods) {
        const ph = angle + (sx > 0 ? 0 : Math.PI / 2);
        mesh.position.set(sx * 1.1, driverR - Math.cos(ph) * crankR, (driverZ[0] + driverZ[1]) / 2 + Math.sin(ph) * crankR);
      }
    },
  };
}
