import * as THREE from 'three';
import { Heightfield } from '../world/Heightfield';
import { terrainSet } from '../engine/Assets';

const UP = new THREE.Vector3(0, 1, 0);
const GAUGE = 2.6; // rail centre-to-centre within one track
/** Centre-to-centre spacing of a parallel (double) track from the main running line. Shared with
 *  Train.DOUBLE_OFFSET so a train riding the second rail lines up with the rendered rail. */
export const DOUBLE_OFFSET = 7;
/** Lateral tolerance used by the cross-line signaller to decide two trains share a rail. */
export const TRACK_SIDE = 2.4;
const RAIL_R = 0.16;
const RAIL_HEAD = 0.85; // deck height above ground
const TIE_SPACING = 2.2;
const BED_DROP = 1.0; // ground sits this far below the rail head — just under the ballast
const BED_HALF = 4.5; // half-width of the level roadbed shelf the ground is graded to
// A grade-separation ramp half-length: where this line must ride OVER another track, the deck
// climbs to clearance across this distance on each side (must match Network.BRIDGE_APPROACH so
// the build only commits where there's room for the slope).
const BRIDGE_RAMP = 110;

/** A point where this line must bridge OVER existing track: the deck is lifted to `deckY` here. */
export interface BridgeSpan {
  pos: THREE.Vector3;
  deckY: number;
}

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
  /** Rendered parallel-rail geometry for the doubled stretches, rebuilt by setDoubled(). */
  private doubleGroup: THREE.Group | null = null;

  /**
   * `visual=false` builds only the geometry/curve (no rails/ballast) — used by a
   * through-service that rides already-rendered track across junctions. `raw=true`
   * (movement-only) takes the given points as the exact curve, skipping the
   * densify+grade pass, so a through-service sits precisely on the rails it traces.
   */
  constructor(
    private field: Heightfield,
    waypoints: THREE.Vector3[],
    visual = true,
    raw = false,
    private tint?: number,
    private bridges: BridgeSpan[] = [],
    private doubled: { u0: number; u1: number; lanes: number; side: number }[] = []
  ) {
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
    // Remember the ground-hugging profile BEFORE any bridge lift — the LAND is graded to this, so
    // where the deck rides up over another track the ground stays low and the deck spans it on
    // trestles (a real bridge), instead of the whole hump becoming a solid embankment.
    const baseY = pts.map((p) => p.y);
    this.raiseBridges(pts);

    this.curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    this.curve.arcLengthDivisions = pts.length * 6;
    this.length = this.curve.getLength();

    if (!visual) {
      this.group.name = 'route';
      return;
    }

    // Cut and fill the land to the engineered bed BEFORE building the structure, so the ballast,
    // trestles and tunnels read the graded ground: embankments replace stilts over dips, cuttings
    // replace track buried in a rise.
    field.addCorridor(pts.map((p, i) => ({ x: p.x, z: p.z, y: baseY[i] - BED_DROP })), BED_HALF);

    this.group.add(this.buildBallast());
    this.group.add(this.buildTies());
    for (const r of this.buildRails()) this.group.add(r);
    this.buildDoubleRails();
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

  /** Lift the deck up and over each grade-separation crossing: a smooth hump that reaches the
   *  required clearance right at the crossing and eases back to the ground profile over BRIDGE_RAMP
   *  on each side. Applied AFTER the grade pass so the bridge approaches read as a deliberate
   *  climb, not the rolling terrain. */
  private raiseBridges(pts: THREE.Vector3[]): void {
    for (const br of this.bridges) {
      for (const p of pts) {
        const dist = Math.hypot(p.x - br.pos.x, p.z - br.pos.z);
        if (dist >= BRIDGE_RAMP) continue;
        const t = 1 - dist / BRIDGE_RAMP; // 1 at the crossing, 0 at the ramp ends
        const ease = t * t * (3 - 2 * t); // smoothstep — gentle slope, no kink
        const lift = (br.deckY - p.y) * ease;
        if (lift > 0) p.y += lift;
      }
    }
  }

  /** Engineer the vertical profile like a real railroad: a near-constant grade between the
   *  fixed endpoints, cutting through rises and filling dips, so grades ease in gently over a
   *  long distance instead of ramping abruptly off a hill. Endpoints stay pinned to their
   *  city pads. */
  private smoothGrade(pts: THREE.Vector3[]): void {
    const n = pts.length;
    if (n < 3) return;
    const ys = pts.map((p) => p.y);

    // Cumulative horizontal distance, for an arc-length-correct straight-grade reference.
    const d: number[] = [0];
    for (let i = 1; i < n; i++) d[i] = d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const total = d[n - 1] || 1;

    // Bias the draped profile toward the straight grade line end-to-end. This is the cut-and-
    // fill: the line stops hugging every undulation and runs a steady gradient instead.
    const y0 = ys[0];
    const yN = ys[n - 1];
    for (let i = 1; i < n - 1; i++) {
      ys[i] = THREE.MathUtils.lerp(ys[i], y0 + (yN - y0) * (d[i] / total), 0.45);
    }

    // Laplacian relaxation rounds it out (endpoints fixed).
    for (let it = 0; it < 110; it++) {
      const prev = ys.slice();
      for (let i = 1; i < n - 1; i++) ys[i] = prev[i] + 0.6 * ((prev[i - 1] + prev[i + 1]) * 0.5 - prev[i]);
    }

    // Clamp to a gentle ruling grade, forward then backward — but never tighter than the
    // unavoidable end-to-end gradient, or the residual climb would all pile into the last
    // (un-clamped) segment at the city, which is exactly the abrupt ramp we're removing. A
    // genuinely steep corridor then runs an even steep grade rather than flat-then-cliff.
    const MAX = Math.max(0.026, (Math.abs(yN - y0) / total) * 1.05);
    for (let i = 1; i < n - 1; i++) {
      const dx = Math.max(1e-3, d[i] - d[i - 1]);
      ys[i] = THREE.MathUtils.clamp(ys[i], ys[i - 1] - MAX * dx, ys[i - 1] + MAX * dx);
    }
    for (let i = n - 2; i >= 1; i--) {
      const dx = Math.max(1e-3, d[i + 1] - d[i]);
      ys[i] = THREE.MathUtils.clamp(ys[i], ys[i + 1] - MAX * dx, ys[i + 1] + MAX * dx);
    }

    // A final gentle relaxation rounds off the knees the clamp leaves, so the grade changes
    // smoothly rather than kinking from flat to ramp (smoothing only lowers local slope).
    for (let it = 0; it < 28; it++) {
      const prev = ys.slice();
      for (let i = 1; i < n - 1; i++) ys[i] = prev[i] + 0.4 * ((prev[i - 1] + prev[i + 1]) * 0.5 - prev[i]);
    }

    const floor = this.field.params.seaLevel + 0.4 + RAIL_HEAD;
    for (let i = 0; i < n; i++) pts[i].y = Math.max(ys[i], floor);
  }

  /** Trapezoid-profile gravel bed with length-wise UVs — skipped over open water,
   *  where the trestle carries bare ties + rails instead. */
  private buildBallast(): THREE.Mesh {
    const n = Math.max(60, Math.floor(this.length / 3));
    const topW = GAUGE * 0.85 + 0.5;
    const botW = GAUGE * 1.25 + 0.9;
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
    const geo = new THREE.BoxGeometry(GAUGE + 1.6, 0.18, 0.5);
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
    // Tint the steel toward the owning company's livery so you can always tell whose track
    // is whose — your rails carry your colour, a rival's carry theirs.
    const steel = new THREE.Color(0xb8bdc4);
    if (this.tint !== undefined) steel.lerp(new THREE.Color(this.tint), 0.5);
    const mat = new THREE.MeshStandardMaterial({ color: steel, metalness: 0.92, roughness: 0.32 });
    const out: THREE.Mesh[] = [];
    // A single running line — one pair of rails at ±GAUGE/2 on the centreline.
    const offsets = [-GAUGE * 0.5, GAUGE * 0.5];
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

  /** Replace this track's doubled stretches and re-render their parallel rails in place — so a
   *  line can be upgraded to double-track without rebuilding the running line (its trains keep
   *  their track reference). */
  setDoubled(spans: { u0: number; u1: number; lanes: number; side: number }[]): void {
    this.doubled = spans;
    this.buildDoubleRails();
  }

  /** Render parallel (double) rails over each doubled stretch: for `lanes` total tracks, lay
   *  `lanes-1` extra rail-pairs (ties + steel) beside the running line, offset to one side. The
   *  passing trains ride these via the matching DOUBLE_OFFSET in Train. Rebuildable: clears any
   *  previously-rendered parallel rails first. */
  private buildDoubleRails(): void {
    if (this.doubleGroup) {
      this.group.remove(this.doubleGroup);
      this.doubleGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
      });
      this.doubleGroup = null;
    }
    if (!this.doubled.length) return;
    const steel = new THREE.Color(0xb8bdc4);
    if (this.tint !== undefined) steel.lerp(new THREE.Color(this.tint), 0.5);
    const railMat = new THREE.MeshStandardMaterial({ color: steel, metalness: 0.92, roughness: 0.32 });
    const w = terrainSet('weathered_planks', 8);
    const tieMat = new THREE.MeshStandardMaterial({ map: w.map, normalMap: w.normalMap, roughness: 0.92 });
    const grp = new THREE.Group();
    const pos = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const perp = new THREE.Vector3();
    const dummy = new THREE.Object3D();
    for (const span of this.doubled) {
      const u0 = THREE.MathUtils.clamp(Math.min(span.u0, span.u1), 0, 1);
      const u1 = THREE.MathUtils.clamp(Math.max(span.u0, span.u1), 0, 1);
      if (u1 - u0 < 0.002) continue;
      const segLen = (u1 - u0) * this.length;
      const n = Math.max(8, Math.floor(segLen / 2));
      const lanes = THREE.MathUtils.clamp(Math.round(span.lanes), 2, 4);
      const sign = span.side < 0 ? -1 : 1; // which side of the running line the parallels sit on
      for (let lane = 1; lane < lanes; lane++) {
        const laneOff = lane * DOUBLE_OFFSET * sign;
        const tieCount = Math.max(3, Math.floor(segLen / TIE_SPACING));
        const ties = new THREE.InstancedMesh(new THREE.BoxGeometry(GAUGE + 1.6, 0.18, 0.5), tieMat, tieCount);
        for (let i = 0; i < tieCount; i++) {
          const u = u0 + (u1 - u0) * ((i + 0.5) / tieCount);
          this.curve.getPointAt(u, pos);
          this.curve.getTangentAt(u, tan);
          perp.crossVectors(tan, UP).normalize();
          dummy.position.set(pos.x + perp.x * laneOff, pos.y - 0.3, pos.z + perp.z * laneOff);
          dummy.rotation.set(0, Math.atan2(tan.x, tan.z), 0);
          dummy.updateMatrix();
          ties.setMatrixAt(i, dummy.matrix);
        }
        ties.instanceMatrix.needsUpdate = true;
        ties.castShadow = true;
        ties.receiveShadow = true;
        grp.add(ties);
        for (const railOff of [laneOff - GAUGE * 0.5, laneOff + GAUGE * 0.5]) {
          const line: THREE.Vector3[] = [];
          for (let i = 0; i <= n; i++) {
            const u = u0 + (u1 - u0) * (i / n);
            this.curve.getPointAt(u, pos);
            this.curve.getTangentAt(u, tan);
            perp.crossVectors(tan, UP).normalize();
            line.push(new THREE.Vector3(pos.x + perp.x * railOff, pos.y - 0.08, pos.z + perp.z * railOff));
          }
          const c = new THREE.CatmullRomCurve3(line, false, 'catmullrom', 0.5);
          const mesh = new THREE.Mesh(new THREE.TubeGeometry(c, n, RAIL_R, 8, false), railMat);
          mesh.castShadow = true;
          grp.add(mesh);
        }
      }
    }
    if (grp.children.length) {
      this.doubleGroup = grp;
      this.group.add(grp);
    }
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
      const legOff = GAUGE * 0.5 + 0.6;
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, clear, 0.5), timber);
        leg.position.set(pos.x + perp.x * legOff * s, base + clear / 2, pos.z + perp.z * legOff * s);
        leg.rotation.y = yaw;
        leg.castShadow = true;
        bents.add(leg);
      }
      // Cap under the deck + a horizontal cross-girt at mid-height on taller bents.
      const cap = new THREE.Mesh(new THREE.BoxGeometry(GAUGE + 2.0, 0.4, 0.7), timber);
      cap.position.set(pos.x, deckUnder - 0.18, pos.z);
      cap.rotation.y = yaw;
      cap.castShadow = true;
      bents.add(cap);
      if (clear > 5) {
        const girt = new THREE.Mesh(new THREE.BoxGeometry(GAUGE + 0.8, 0.3, 0.4), timber);
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
    const w = (GAUGE + 2.4) * 0.92;
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
