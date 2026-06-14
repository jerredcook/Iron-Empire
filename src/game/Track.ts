import * as THREE from 'three';
import { Heightfield } from '../world/Heightfield';
import { terrainSet } from '../engine/Assets';

const UP = new THREE.Vector3(0, 1, 0);
const GAUGE = 2.6; // rail centre-to-centre within one track
/** Lateral offset of each running line from the corridor centreline — the mainline is
 *  double-tracked, one direction per side, so opposing trains never meet head-on. */
export const TRACK_SIDE = 2.4;
const RAIL_R = 0.16;
const RAIL_HEAD = 0.85; // deck height above ground
const TIE_SPACING = 2.2;

/**
 * A rail line draped over the landscape with an engineered profile: elevations are
 * Laplacian-relaxed and grade-clamped (~3.5%) between fixed endpoints, so the line
 * cuts and fills like a real railroad rather than rollercoasting the terrain.
 * Rendered at full PBR quality: gravel ballast bed, weathered-plank ties, polished
 * steel rails, and timber trestles wherever the deck stands clear of the ground.
 */
export class Track {
  readonly group = new THREE.Group();
  readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;

  /**
   * `visual=false` builds only the geometry/curve (no rails/ballast) — used by a
   * through-service that rides already-rendered track across junctions. `raw=true`
   * (movement-only) takes the given points as the exact curve, skipping the
   * densify+grade pass, so a through-service sits precisely on the rails it traces.
   */
  constructor(private field: Heightfield, waypoints: THREE.Vector3[], visual = true, raw = false) {
    if (raw) {
      this.curve = new THREE.CatmullRomCurve3(waypoints.map((p) => p.clone()), false, 'catmullrom', 0.5);
      this.curve.arcLengthDivisions = waypoints.length * 6;
      this.length = this.curve.getLength();
      this.group.name = 'route';
      return;
    }
    const pts: THREE.Vector3[] = [];
    for (let w = 0; w < waypoints.length - 1; w++) {
      const a = waypoints[w];
      const b = waypoints[w + 1];
      const steps = Math.max(3, Math.floor(a.distanceTo(b) / 14));
      const last = w === waypoints.length - 2;
      for (let i = 0; i < steps + (last ? 1 : 0); i++) {
        const s = i / steps;
        const x = THREE.MathUtils.lerp(a.x, b.x, s);
        const z = THREE.MathUtils.lerp(a.z, b.z, s);
        const y = Math.max(field.height(x, z), field.params.seaLevel + 0.6) + RAIL_HEAD;
        pts.push(new THREE.Vector3(x, y, z));
      }
    }
    this.smoothGrade(pts);

    this.curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    this.curve.arcLengthDivisions = pts.length * 6;
    this.length = this.curve.getLength();

    if (!visual) {
      this.group.name = 'route';
      return;
    }

    this.group.add(this.buildBallast());
    this.group.add(this.buildTies());
    for (const r of this.buildRails()) this.group.add(r);
    this.buildTrestles();
    this.buildTunnels();
    this.group.name = 'track';
  }

  /** Arc-length fraction (0..1) of the point on the curve nearest a world position —
   *  used to place a station stop along the route. */
  nearestU(p: THREE.Vector3): number {
    const tmp = new THREE.Vector3();
    let bu = 0;
    let bd = Infinity;
    const n = 300;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      this.curve.getPointAt(u, tmp);
      const d = (tmp.x - p.x) ** 2 + (tmp.z - p.z) ** 2;
      if (d < bd) {
        bd = d;
        bu = u;
      }
    }
    return bu;
  }

  /** Free this track's GPU resources (call after removing the group from the scene).
   *  Geometries and materials are per-track; their texture maps come from the shared
   *  Assets cache, so we don't dispose those. */
  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
      }
    });
  }

  /** Laplacian relax + grade clamp, endpoints fixed. */
  private smoothGrade(pts: THREE.Vector3[]): void {
    const n = pts.length;
    if (n < 3) return;
    const ys = pts.map((p) => p.y);
    for (let it = 0; it < 70; it++) {
      const prev = ys.slice();
      for (let i = 1; i < n - 1; i++) ys[i] = prev[i] + 0.6 * ((prev[i - 1] + prev[i + 1]) * 0.5 - prev[i]);
    }
    const MAX = 0.035;
    for (let i = 1; i < n - 1; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      ys[i] = THREE.MathUtils.clamp(ys[i], ys[i - 1] - MAX * d, ys[i - 1] + MAX * d);
    }
    for (let i = n - 2; i >= 1; i--) {
      const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
      ys[i] = THREE.MathUtils.clamp(ys[i], ys[i + 1] - MAX * d, ys[i + 1] + MAX * d);
    }
    const floor = this.field.params.seaLevel + 0.4 + RAIL_HEAD;
    for (let i = 0; i < n; i++) pts[i].y = Math.max(ys[i], floor);
  }

  /** Trapezoid-profile gravel bed with length-wise UVs — skipped over open water,
   *  where the trestle carries bare ties + rails instead. */
  private buildBallast(): THREE.Mesh {
    const n = Math.max(60, Math.floor(this.length / 3));
    const topW = TRACK_SIDE + GAUGE * 0.65;
    const botW = TRACK_SIDE + GAUGE * 1.0;
    const depth = 0.55;
    const pos = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const perp = new THREE.Vector3();
    const verts: number[] = [];
    const uvs: number[] = [];
    const onLand: boolean[] = [];
    // Profile: 4 points (bottom-left, top-left, top-right, bottom-right).
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      this.curve.getPointAt(u, pos);
      this.curve.getTangentAt(u, tan);
      perp.crossVectors(tan, UP).normalize();
      // Ballast belongs where the deck hugs the ground; over water/gaps the
      // structure is an open trestle.
      const ground = this.field.height(pos.x, pos.z);
      onLand.push(ground >= this.field.params.seaLevel - 0.2 && pos.y - RAIL_HEAD - ground < 1.6);
      const yTop = pos.y - 0.42;
      const yBot = yTop - depth;
      const v = (u * this.length) / 9;
      const px = [-botW, -topW, topW, botW];
      const py = [yBot, yTop, yTop, yBot];
      for (let k = 0; k < 4; k++) {
        verts.push(pos.x + perp.x * px[k], py[k], pos.z + perp.z * px[k]);
        uvs.push(k / 3, v);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!onLand[i] || !onLand[i + 1]) continue; // open trestle here
      const a = i * 4;
      for (let k = 0; k < 3; k++) {
        idx.push(a + k, a + k + 1, a + k + 4, a + k + 1, a + k + 5, a + k + 4);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const g = terrainSet('gravel_ground_01', 8);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: g.map, normalMap: g.normalMap, roughnessMap: g.roughnessMap, roughness: 1 })
    );
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  private buildTies(): THREE.InstancedMesh {
    const count = Math.max(4, Math.floor(this.length / TIE_SPACING));
    const geo = new THREE.BoxGeometry(2 * TRACK_SIDE + GAUGE + 1.0, 0.18, 0.5);
    const w = terrainSet('weathered_planks', 8);
    const mat = new THREE.MeshStandardMaterial({ map: w.map, normalMap: w.normalMap, roughness: 0.92 });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    const pos = new THREE.Vector3();
    const tan = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      this.curve.getPointAt(u, pos);
      this.curve.getTangentAt(u, tan);
      dummy.position.set(pos.x, pos.y - 0.3, pos.z);
      dummy.rotation.set(0, Math.atan2(tan.x, tan.z), 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildRails(): THREE.Mesh[] {
    const n = Math.max(80, Math.floor(this.length / 2));
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8bdc4, metalness: 0.92, roughness: 0.32 });
    const out: THREE.Mesh[] = [];
    // Four rails: two running lines (±TRACK_SIDE), each a pair at ±GAUGE/2.
    const offsets: number[] = [];
    for (const c of [-TRACK_SIDE, TRACK_SIDE]) for (const s of [-1, 1]) offsets.push(c + s * GAUGE * 0.5);
    for (const off of offsets) {
      const line: THREE.Vector3[] = [];
      const pos = new THREE.Vector3();
      const tan = new THREE.Vector3();
      const perp = new THREE.Vector3();
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        this.curve.getPointAt(u, pos);
        this.curve.getTangentAt(u, tan);
        perp.crossVectors(tan, UP).normalize();
        line.push(new THREE.Vector3(pos.x + perp.x * off, pos.y - 0.08, pos.z + perp.z * off));
      }
      const c = new THREE.CatmullRomCurve3(line, false, 'catmullrom', 0.5);
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(c, n, RAIL_R, 8, false), mat);
      mesh.castShadow = true;
      out.push(mesh);
    }
    return out;
  }

  /** Timber trestle bents wherever the deck stands well above the ground/water. */
  private buildTrestles(): void {
    const w = terrainSet('weathered_planks', 4);
    const timber = new THREE.MeshStandardMaterial({ map: w.map, normalMap: w.normalMap, roughness: 0.95 });
    const bents = new THREE.Group();
    const spacing = 7;
    const count = Math.floor(this.length / spacing);
    const pos = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const perp = new THREE.Vector3();
    for (let i = 1; i < count; i++) {
      const u = (i * spacing) / this.length;
      this.curve.getPointAt(u, pos);
      const ground = Math.min(this.field.height(pos.x, pos.z), this.field.params.seaLevel + 0.2);
      const groundReal = this.field.height(pos.x, pos.z);
      const base = groundReal < this.field.params.seaLevel ? ground - 2 : groundReal;
      const deckUnder = pos.y - 0.45;
      const clear = deckUnder - base;
      if (clear < 2.2) continue;
      this.curve.getTangentAt(u, tan);
      perp.crossVectors(tan, UP).normalize();
      const yaw = Math.atan2(tan.x, tan.z);
      const legOff = TRACK_SIDE + GAUGE * 0.5;
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, clear, 0.5), timber);
        leg.position.set(pos.x + perp.x * legOff * s, base + clear / 2, pos.z + perp.z * legOff * s);
        leg.rotation.y = yaw;
        leg.castShadow = true;
        bents.add(leg);
      }
      // Cap under the deck + a horizontal cross-girt at mid-height on taller bents.
      const cap = new THREE.Mesh(new THREE.BoxGeometry(2 * TRACK_SIDE + GAUGE + 0.8, 0.4, 0.7), timber);
      cap.position.set(pos.x, deckUnder - 0.18, pos.z);
      cap.rotation.y = yaw;
      cap.castShadow = true;
      bents.add(cap);
      if (clear > 5) {
        const girt = new THREE.Mesh(new THREE.BoxGeometry(2 * TRACK_SIDE + GAUGE * 0.5, 0.3, 0.4), timber);
        girt.position.set(pos.x, base + clear * 0.5, pos.z);
        girt.rotation.y = yaw;
        girt.castShadow = true;
        bents.add(girt);
      }
    }
    if (bents.children.length) this.group.add(bents);
  }

  /** Where the graded line runs well below the surface (a cut through a ridge), the
   *  terrain mesh already occludes it — we just frame each mouth with a stone portal so
   *  it reads as a deliberate tunnel. Hysteresis + a minimum length avoid stray portals
   *  on noisy ground. */
  private buildTunnels(): void {
    const r = terrainSet('rock_face', 4);
    const stone = new THREE.MeshStandardMaterial({ map: r.map, normalMap: r.normalMap, roughnessMap: r.roughnessMap, roughness: 1 });
    const portals = new THREE.Group();
    const n = Math.max(80, Math.floor(this.length / 4));
    const pos = new THREE.Vector3();
    const tan = new THREE.Vector3();
    let inTunnel = false;
    let startIdx = 0;
    const startPos = new THREE.Vector3();
    const startTan = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      this.curve.getPointAt(u, pos);
      const ground = this.field.height(pos.x, pos.z);
      const depth = ground - pos.y; // how far the railhead sits below the surface
      if (!inTunnel && depth > 2.5) {
        inTunnel = true;
        startIdx = i;
        startPos.copy(pos);
        this.curve.getTangentAt(u, startTan);
      } else if (inTunnel && depth < 0.8) {
        inTunnel = false;
        if (i - startIdx >= 3) {
          this.curve.getTangentAt(u, tan);
          portals.add(this.makePortal(startPos, startTan, stone));
          portals.add(this.makePortal(pos, tan, stone));
        }
      }
    }
    if (portals.children.length) this.group.add(portals);
  }

  /** A stone arch facade at a tunnel mouth: two jambs and a lintel, framing the bore. */
  private makePortal(pos: THREE.Vector3, tan: THREE.Vector3, mat: THREE.Material): THREE.Group {
    const g = new THREE.Group();
    g.position.set(pos.x, 0, pos.z);
    g.rotation.y = Math.atan2(tan.x, tan.z);
    const w = (2 * TRACK_SIDE + GAUGE) * 0.92;
    const h = 3.6;
    const th = 1.0;
    const y0 = pos.y - 0.85; // rail base
    for (const s of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.9, h, th), mat);
      jamb.position.set((s * w) / 2, y0 + h / 2, 0);
      jamb.castShadow = true;
      g.add(jamb);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(w + 1.7, 1.1, th), mat);
    lintel.position.set(0, y0 + h + 0.35, 0);
    lintel.castShadow = true;
    g.add(lintel);
    const keystone = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, th + 0.15), mat);
    keystone.position.set(0, y0 + h + 0.2, 0);
    keystone.castShadow = true;
    g.add(keystone);
    return g;
  }
}
