import * as THREE from 'three';
import { terrainSet } from '../engine/Assets';
import { mulberry32 } from '../world/Heightfield';

/**
 * Period architecture built face-by-face so every wall gets correctly-scaled
 * texture UVs (brick courses and roof slates read at true size): gabled houses
 * with eaves, inset glazed windows, doors and chimneys, in brick or painted
 * plaster; plus the railroad station with platform and canopy.
 */

let MATS: {
  brick: THREE.MeshStandardMaterial;
  plaster: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  door: THREE.MeshStandardMaterial;
  platform: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
} | null = null;

function mats() {
  if (MATS) return MATS;
  const brick = terrainSet('brick_wall_005', 8);
  const plaster = terrainSet('painted_plaster_wall', 8);
  const roof = terrainSet('red_slate_roof_tiles_01', 8);
  const planks = terrainSet('weathered_planks', 8);
  MATS = {
    brick: new THREE.MeshStandardMaterial({ map: brick.map, normalMap: brick.normalMap, roughnessMap: brick.roughnessMap }),
    plaster: new THREE.MeshStandardMaterial({ map: plaster.map, normalMap: plaster.normalMap, roughnessMap: plaster.roughnessMap }),
    roof: new THREE.MeshStandardMaterial({
      map: roof.map,
      normalMap: roof.normalMap,
      roughnessMap: roof.roughnessMap,
      color: 0x8a4438, // keep the slates reading warm red even at deep mips
    }),
    trim: new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x20303a, roughness: 0.05, metalness: 0.4 }),
    door: new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.7 }),
    platform: new THREE.MeshStandardMaterial({ map: planks.map, normalMap: planks.normalMap, roughness: 0.9 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.85 }),
  };
  return MATS;
}

const WALL_TILE = 3.2; // world units per wall-texture tile
const ROOF_TILE = 2.6;

/** A wall plane with world-scaled UVs, facing +Z before rotation. */
function wall(w: number, h: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / WALL_TILE, (uv.getY(i) * h) / WALL_TILE);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Gable roof: two slate slopes + trim gable triangles, with eaves overhang. */
function gableRoof(w: number, d: number, rise: number): THREE.Group {
  const m = mats();
  const g = new THREE.Group();
  const ow = w / 2 + 0.35; // eaves overhang
  const od = d / 2 + 0.35;
  const slopeLen = Math.hypot(ow, rise);
  for (const s of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(d + 0.7, slopeLen);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (d + 0.7)) / ROOF_TILE, (uv.getY(i) * slopeLen) / ROOF_TILE);
    const mesh = new THREE.Mesh(geo, m.roof);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = (Math.PI / 2) * s;
    mesh.rotation.x = -(Math.PI / 2 - Math.atan2(rise, ow));
    mesh.position.set((s * ow) / 2, rise / 2, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    void od;
  }
  // Gable triangles (trim colour).
  const tri = new THREE.Shape();
  tri.moveTo(-w / 2, 0);
  tri.lineTo(w / 2, 0);
  tri.lineTo(0, rise);
  tri.closePath();
  const triGeo = new THREE.ShapeGeometry(tri);
  for (const s of [-1, 1]) {
    const t = new THREE.Mesh(triGeo, m.trim);
    t.position.set(0, 0, (s * d) / 2);
    if (s < 0) t.rotation.y = Math.PI;
    t.castShadow = true;
    g.add(t);
  }
  return g;
}

export interface HouseOpts {
  w: number;
  d: number;
  floors: number;
  brick: boolean;
  chimney: boolean;
}

/** A gabled period house with inset windows and a door. */
export function buildHouse(o: HouseOpts): THREE.Group {
  const m = mats();
  const g = new THREE.Group();
  const floorH = 2.9;
  const h = o.floors * floorH;
  const wallMat = o.brick ? m.brick : m.plaster;

  // Four walls (front/back face ±Z, sides ±X).
  const front = wall(o.w, h, wallMat);
  front.position.set(0, h / 2, o.d / 2);
  const back = wall(o.w, h, wallMat);
  back.position.set(0, h / 2, -o.d / 2);
  back.rotation.y = Math.PI;
  const left = wall(o.d, h, wallMat);
  left.position.set(-o.w / 2, h / 2, 0);
  left.rotation.y = -Math.PI / 2;
  const right = wall(o.d, h, wallMat);
  right.position.set(o.w / 2, h / 2, 0);
  right.rotation.y = Math.PI / 2;
  g.add(front, back, left, right);

  // Roof.
  const roof = gableRoof(o.w, o.d, o.w * 0.42);
  roof.position.y = h;
  g.add(roof);

  // Windows: columns across the front/back, one row per floor (skip door slot).
  const cols = Math.max(2, Math.floor(o.w / 2.4));
  const winW = 0.78;
  const winH = 1.25;
  const doorCol = Math.floor(cols / 2);
  for (const side of [1, -1]) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5 - cols / 2) * (o.w / cols);
      for (let f = 0; f < o.floors; f++) {
        const isDoor = side === 1 && f === 0 && c === doorCol;
        const y = f * floorH + (isDoor ? 1.05 : 1.7);
        const frame = new THREE.Mesh(
          new THREE.BoxGeometry(isDoor ? winW + 0.3 : winW + 0.22, isDoor ? 2.1 : winH + 0.22, 0.12),
          m.trim
        );
        frame.position.set(x, y, side * (o.d / 2 + 0.02));
        g.add(frame);
        const pane = new THREE.Mesh(
          new THREE.BoxGeometry(isDoor ? winW : winW - 0.12, isDoor ? 2.0 : winH - 0.12, 0.1),
          isDoor ? m.door : m.glass
        );
        pane.position.set(x, y, side * (o.d / 2 + 0.06));
        g.add(pane);
      }
    }
  }

  if (o.chimney) {
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.6, 0.7), m.brick);
    ch.position.set(o.w * 0.22, h + o.w * 0.42 * 0.6 + 0.5, o.d * 0.18);
    ch.castShadow = true;
    g.add(ch);
  }

  g.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) {
      x.castShadow = true;
      x.receiveShadow = true;
    }
  });
  return g;
}

/** The railroad station: depot house, plank platform along the track, canopy. */
export function buildStation(): THREE.Group {
  const m = mats();
  const g = new THREE.Group();

  const depot = buildHouse({ w: 7.5, d: 5, floors: 1, brick: true, chimney: true });
  depot.position.set(-5.4, 0, 0);
  g.add(depot);

  // Platform along +X edge (track side), long in Z.
  const plat = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.65, 22), m.platform);
  plat.position.set(0, 0.32, 0);
  plat.castShadow = true;
  plat.receiveShadow = true;
  g.add(plat);

  // Canopy on posts over the platform.
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.14, 14), m.roof);
  canopy.position.set(-0.4, 3.5, 0);
  canopy.rotation.z = 0.06;
  canopy.castShadow = true;
  g.add(canopy);
  for (const z of [-6, 0, 6]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.9, 8), m.wood);
    post.position.set(-1.6, 2.05, z);
    post.castShadow = true;
    g.add(post);
  }
  return g;
}

/** A small town: houses on a jittered grid facing a green, near the station. */
export function buildTown(seed: number, count: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const taken: { x: number; z: number; r: number }[] = [];
  let placed = 0;
  for (let attempt = 0; attempt < count * 30 && placed < count; attempt++) {
    const ang = rng() * Math.PI * 2;
    const rad = 13 + rng() * 34;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const w = 5 + rng() * 4;
    const d = 6 + rng() * 4;
    const r = Math.hypot(w, d) * 0.62; // footprint clearance incl. eaves
    if (taken.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r + 1.2)) continue;
    taken.push({ x, z, r });
    const house = buildHouse({
      w,
      d,
      floors: rng() > 0.55 ? 2 : 1,
      brick: rng() > 0.5,
      chimney: rng() > 0.3,
    });
    house.position.set(x, 0, z);
    house.rotation.y = -ang + Math.PI / 2 + (rng() - 0.5) * 0.4;
    g.add(house);
    placed++;
  }
  return g;
}
