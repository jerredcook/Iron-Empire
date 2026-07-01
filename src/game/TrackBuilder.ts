import * as THREE from 'three';
import { Network, GStation, GLine } from './Network';
import { Heightfield } from '../world/Heightfield';

const SNAP = 60; // ground-distance within which the cursor latches to a city
const END_SNAP = 30; // tighter latch onto a free end of your own track to extend it
const BRANCH_SNAP = 10; // click this close to your own track (away from stations) to branch off it
const BRANCH_CLEAR = 34; // don't branch this close to a station — start a new line from the station instead
const BRANCH_LEAD = 18; // the new branch leaves the main tangent over this run (a smooth turnout, not a T)
const CLICK_SLOP = 9; // px of pointer travel still counted as a click, not a drag
const DECK = 0.7; // preview rail deck height above the draped ground
const GAUGE = 2.6; // preview rail centre-to-centre
const TIE_W = 4.4; // preview tie length
const UP = new THREE.Vector3(0, 1, 0);

/** One point on a route under construction: a city stop, or a free terrain point. */
export interface RouteNode {
  pos: THREE.Vector3;
  station: GStation | null;
}

export interface BuildStatus {
  active: boolean;
  fromName: string | null;
  cost: number;
  affordable: boolean;
  /** True once the route has enough points to commit (the ✓ Finish button lights up). */
  canFinish: boolean;
  /** Short instruction shown in the HUD banner. */
  hint: string;
}

/**
 * Interactive track laying, SMR-style. In build mode you press on a city to start, drag to
 * the destination — a ghosted rail line (ballast-less rails + ties, draped on the terrain)
 * follows the cursor and the target town lights up the moment it's in range — and release to
 * lay the segment. Plain clicks also work (click start, click destination), and you can chain
 * extra stops/bends before pressing ✓ Finish. Right-click undoes the last point.
 */
export class TrackBuilder {
  onStatus?: (s: BuildStatus) => void;
  /** Lay a new line NOW (per-click realize) — returns the created line, or null if refused. */
  onCommit?: (nodes: RouteNode[]) => GLine | null;
  /** Extend an existing line from an end NOW — returns whether the segment was laid+charged. */
  onExtend?: (line: GLine, end: 'head' | 'tail', waypoints: THREE.Vector3[], finalStop: GStation | null) => boolean;
  /** Branch a new track off an existing line NOW — returns the created branch line, or null. */
  onBranch?: (waypoints: THREE.Vector3[], finalStop: GStation | null) => GLine | null;

  private active = false;
  private pulseT = 0;
  private placedOnDown = false;
  private nodes: RouteNode[] = [];
  private cursor = new THREE.Vector3();
  private cursorValid = false;
  private snapTarget: GStation | null = null;
  /** When the cursor is over a free end of one of your lines: connect + extend it. */
  private snapEnd: { line: GLine; end: 'head' | 'tail'; pos: THREE.Vector3; dir: THREE.Vector3 } | null = null;
  /** The line this run is growing (set at start when connecting to a tip, or after the first
   *  realized segment) — every further click extends it. */
  private extendFrom: { line: GLine; end: 'head' | 'tail' } | null = null;
  /** Set when the route starts by branching off the middle of a line: the junction point + the
   *  main line's tangent there (so the branch leaves it as a smooth turnout, not a T). */
  private branchFrom: { line: GLine; pos: THREE.Vector3; dir: THREE.Vector3 } | null = null;
  /** Every segment REALIZED (laid + charged) this run, newest last — right-click rolls one back
   *  with a full refund. A 'created' step undoes the whole new line; an 'extended' step restores
   *  the line's previous shape. */
  private runSteps: {
    kind: 'created' | 'extended';
    line: GLine;
    prevWp?: THREE.Vector3[];
    prevStops?: GStation[];
    /** The anchor's station before this segment — restored on undo. */
    prevAnchorStation: GStation | null;
    cost: number;
    bonus: number;
  }[] = [];

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private down = new THREE.Vector2();
  private ghost: THREE.Mesh;
  private snapRing: THREE.Mesh;
  private connectMarker: THREE.Mesh;
  private previewTrack: THREE.Group | null = null;
  private previewSig = '';

  constructor(
    private camera: THREE.Camera,
    private dom: HTMLElement,
    private terrain: THREE.Object3D,
    private network: Network,
    private field: Heightfield,
    private overlay: THREE.Scene
  ) {
    this.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(3.0, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x8fffa8, transparent: true, opacity: 0.85, depthTest: false })
    );
    this.ghost.visible = false;
    this.ghost.renderOrder = 1000;
    overlay.add(this.ghost);

    // A bright, pulsing ring that drops over a town the moment the cursor is in range to
    // make it a stop — drawn over terrain/buildings so it's unmistakable.
    this.snapRing = new THREE.Mesh(
      new THREE.TorusGeometry(SNAP * 0.5, 2.4, 10, 56),
      new THREE.MeshBasicMaterial({ color: 0x7dffb0, transparent: true, opacity: 0.85, depthTest: false })
    );
    this.snapRing.rotation.x = Math.PI / 2;
    this.snapRing.renderOrder = 1000;
    this.snapRing.visible = false;
    overlay.add(this.snapRing);

    // A cyan diamond that latches onto the free END of one of your lines — "connect here and
    // extend". Distinct from the city ring so connecting to your own track is unmistakable.
    this.connectMarker = new THREE.Mesh(
      new THREE.OctahedronGeometry(4.2),
      new THREE.MeshBasicMaterial({ color: 0x5fe0ff, transparent: true, opacity: 0.9, depthTest: false })
    );
    this.connectMarker.renderOrder = 1001;
    this.connectMarker.visible = false;
    overlay.add(this.connectMarker);

    this.dom.addEventListener('pointerdown', this.onDown);
    this.dom.addEventListener('pointerup', this.onUp);
    this.dom.addEventListener('pointermove', this.onMove);
    window.addEventListener('keydown', this.onKey);
  }

  /** Is build mode currently engaged? (Picking + camera pan stand down while it is.) */
  isActive(): boolean {
    return this.active;
  }

  /** Dev only: force the ghost preview over a fixed set of points, for headless screenshots. */
  debugShowPreview(points: THREE.Vector3[]): void {
    if (points.length < 2) return;
    this.active = true;
    this.nodes = points.slice(0, -1).map((p) => ({ pos: p.clone(), station: null }));
    this.cursor.copy(points[points.length - 1]);
    this.cursorValid = true;
    this.snapTarget = null;
    this.snapEnd = null;
    this.previewSig = '';
    this.rebuildPreviewTrack(0xcfe3ff);
  }

  start(): void {
    this.active = true;
    this.emit();
  }

  cancel(): void {
    this.active = false;
    this.nodes = [];
    this.extendFrom = null;
    this.branchFrom = null;
    this.runSteps = [];
    this.snapEnd = null;
    this.ghost.visible = false;
    this.snapRing.visible = false;
    this.connectMarker.visible = false;
    this.clearPreviewTrack();
    this.emit();
  }

  toggle(): void {
    if (this.active) this.cancel();
    else this.start();
  }

  /** Commit the current route (the HUD ✓ Finish button calls this). No-op under 2 points. */
  commit(): void {
    this.finish();
  }

  /** Per-frame pulse for the in-range snap ring. Fed real dt; a no-op when nothing snaps. */
  update(dt: number): void {
    if (!this.snapRing.visible) return;
    this.pulseT += dt;
    const beat = 0.5 + 0.5 * Math.sin(this.pulseT * 4.5);
    this.snapRing.scale.setScalar(1 + beat * 0.14);
    (this.snapRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.4 * beat;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'b' || e.key === 'B') this.toggle();
    else if (e.key === 'Escape') this.cancel();
    else if (e.key === 'Enter' && this.active) this.finish();
  };

  private onDown = (e: PointerEvent): void => {
    this.down.set(e.clientX, e.clientY);
    this.placedOnDown = false;
    if (!this.active || e.button !== 0) return;
    this.raycast(e);
    // Drop the start point immediately so a drag has something to draw from. (If the press
    // turns out to be a plain click, that's fine — the start is exactly where we want it.)
    if (this.nodes.length === 0 && this.cursorValid) {
      if (this.snapEnd) this.extendFrom = { line: this.snapEnd.line, end: this.snapEnd.end };
      this.nodes.push(this.snapNode());
      this.placedOnDown = true;
    }
    this.refreshVisuals();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.active) return;
    const wasDrag = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > CLICK_SLOP;
    if (e.button === 2) {
      // Right-click UNDOES: roll back the last laid segment (full refund); with nothing laid,
      // clear the start point; with nothing at all, leave build mode.
      if (this.runSteps.length) {
        this.undoLastSegment();
      } else if (this.nodes.length) {
        this.nodes.pop();
        this.extendFrom = null;
        this.branchFrom = null;
        this.refreshVisuals();
        this.emit();
      } else {
        this.cancel();
      }
      return;
    }
    if (e.button !== 0) return;
    this.raycast(e);
    if (this.cursorValid && !(this.placedOnDown && !wasDrag) && this.nodes.length >= 1) {
      // Per-click realize: every click (or drag-release) LAYS AND PAYS FOR the stretch from the
      // anchor to here, immediately — the track is real the moment you click.
      this.realize(this.snapNode());
    }
    this.placedOnDown = false;
    this.refreshVisuals();
    this.emit();
  };

  /** Lay + charge the segment from the current anchor to `n` right now, then move the anchor to
   *  the freshly laid end so the next click continues the same line. */
  private realize(n: RouteNode): void {
    const anchor = this.nodes[this.nodes.length - 1];
    if (!anchor || anchor.pos.distanceTo(n.pos) < 10) return; // a click on the anchor isn't a segment
    const prevAnchorStation = anchor.station;
    if (this.extendFrom) {
      // Continue the line this run is growing (or the tip we connected to).
      const { line, end } = this.extendFrom;
      const prevWp = line.waypoints.map((p) => p.clone());
      const prevStops = line.stops.slice();
      if (!this.onExtend?.(line, end, [n.pos.clone()], n.station)) return;
      this.runSteps.push({ kind: 'extended', line, prevWp, prevStops, prevAnchorStation, cost: this.network.lastBuildCost, bonus: 0 });
    } else if (this.branchFrom) {
      // First segment of a branch: leave the junction along the main's tangent (smooth turnout).
      const bp = this.branchFrom.pos;
      const sign = n.pos.clone().sub(bp).setY(0).dot(this.branchFrom.dir) >= 0 ? 1 : -1;
      const lead = bp.clone().addScaledVector(this.branchFrom.dir, sign * BRANCH_LEAD);
      const line = this.onBranch?.([bp.clone(), lead, n.pos.clone()], n.station) ?? null;
      if (!line) return;
      this.runSteps.push({ kind: 'created', line, prevAnchorStation, cost: this.network.lastBuildCost, bonus: this.network.lastBuildBonus });
      this.extendFrom = { line, end: 'tail' };
      this.branchFrom = null;
    } else {
      // First segment of a brand-new line (started at a city or open ground).
      const line = this.onCommit?.([{ pos: anchor.pos.clone(), station: anchor.station }, { pos: n.pos.clone(), station: n.station }]) ?? null;
      if (!line) return;
      this.runSteps.push({ kind: 'created', line, prevAnchorStation, cost: this.network.lastBuildCost, bonus: this.network.lastBuildBonus });
      this.extendFrom = { line, end: 'tail' };
    }
    this.reanchor(n.station);
  }

  /** Put the anchor on the REAL end of the line being grown (the committed geometry may berth or
   *  curve, so the true rail end is what the next segment must continue from). */
  private reanchor(station: GStation | null): void {
    const ef = this.extendFrom;
    if (!ef) { this.nodes = []; return; }
    const w = ef.line.waypoints;
    const pos = (ef.end === 'tail' ? w[w.length - 1] : w[0]).clone();
    this.nodes = [{ pos, station }];
  }

  /** Roll back the newest laid segment: restore the line's previous shape (or delete a line this
   *  run created) and refund exactly what it cost. */
  private undoLastSegment(): void {
    const step = this.runSteps.pop();
    if (!step) return;
    if (step.kind === 'extended') {
      this.network.rollbackExtend(step.line, step.prevWp!, step.prevStops!, step.cost);
      this.extendFrom = this.extendFrom ?? { line: step.line, end: 'tail' };
      this.reanchor(step.prevAnchorStation);
    } else {
      this.network.undoCreatedLine(step.line, step.cost, step.bonus);
      // Back to picking a start point — the run's line no longer exists.
      this.extendFrom = null;
      this.branchFrom = null;
      this.nodes = [];
    }
    this.refreshVisuals();
    this.emit();
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.active) return;
    this.raycast(e);
    this.refreshVisuals();
  };

  private snapNode(): RouteNode {
    if (this.snapEnd) return { pos: this.snapEnd.pos.clone(), station: null };
    return { pos: this.snapTarget ? this.snapTarget.pos.clone() : this.cursor.clone(), station: this.snapTarget };
  }

  /** Project the pointer onto the terrain and resolve any city snap. */
  private raycast(e: PointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera as THREE.PerspectiveCamera);
    const hit = this.ray.intersectObject(this.terrain, true)[0];
    this.cursorValid = !!hit;
    if (!hit) {
      this.snapTarget = null;
      return;
    }
    this.cursor.copy(hit.point);
    // Starting a run: latch onto a FREE END of your own track (the stub's tip) so the new track
    // continues out of it — connect-and-extend, never a T off the station.
    this.snapEnd = this.nodes.length === 0 ? this.nearestLineEnd(this.cursor, END_SNAP) : null;
    if (this.snapEnd) {
      this.snapTarget = null;
      this.branchFrom = null;
      this.cursor.copy(this.snapEnd.pos);
      return;
    }
    // Starting a run by clicking ON your own track (out in the open, not at a station): BRANCH off
    // it here. The junction point + the main line's tangent are recorded so the new track leaves as
    // a smooth turnout. (Near a station you start a new line from the station instead.)
    if (this.nodes.length === 0) {
      const on = this.network.nearestOnLine(this.network.player, this.cursor, BRANCH_SNAP);
      if (on && !this.network.nearestCity(on.pos, BRANCH_CLEAR)) {
        const dir = new THREE.Vector3();
        on.line.track.curve.getTangentAt(THREE.MathUtils.clamp(on.u, 0, 1), dir);
        dir.y = 0;
        if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
        dir.normalize();
        this.branchFrom = { line: on.line, pos: on.pos.clone(), dir };
        this.snapTarget = null;
        this.cursor.copy(on.pos);
        return;
      }
      this.branchFrom = null;
    }
    // Snap to ANY city in range, depot or not — you connect the track first, then build the
    // depot. (Using only stationed cities meant a bare destination never latched, so the line
    // didn't actually reach it.)
    const near = this.network.nearestCity(this.cursor, SNAP);
    this.snapTarget = near && near !== this.lastStation ? near : null;
    if (this.snapTarget) this.cursor.copy(this.snapTarget.pos);
  }

  /** The free line-end of yours nearest the cursor, within `maxDist` — or null. An end that sits
   *  at one of its line's STATION stops is a platform, not a free tip: we skip it so pressing a
   *  station starts a NEW line there (a new platform, up to 4 per station) instead of extending the
   *  line that already berths there. Only genuine open-country tips (e.g. the starter stub) extend. */
  private nearestLineEnd(p: THREE.Vector3, maxDist: number): typeof this.snapEnd {
    let best: typeof this.snapEnd = null;
    let bd = maxDist;
    for (const e of this.network.extendableEnds(this.network.player)) {
      const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  private get lastStation(): GStation | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) if (this.nodes[i].station) return this.nodes[i].station;
    return null;
  }

  /** End the laying run. Everything clicked is already real and paid for (per-click realize), so
   *  ✓ Done just clears the run state, ready to start the next run. */
  private finish(): void {
    this.nodes = [];
    this.extendFrom = null;
    this.branchFrom = null;
    this.runSteps = [];
    this.refreshVisuals();
    this.emit();
  }

  private refreshVisuals(): void {
    if (!this.active) return;
    this.ghost.visible = this.cursorValid;
    if (this.cursorValid) this.ghost.position.set(this.cursor.x, this.cursor.y + 3, this.cursor.z);

    // Cyan = connecting to your own track (a free end to extend, or a mid-track branch point);
    // green = a city with a depot; amber = a city still needing one.
    const tint = this.snapEnd || this.branchFrom ? 0x5fe0ff : this.snapTarget ? (this.snapTarget.hasStation ? 0x7dffb0 : 0xffcf73) : 0xcfe3ff;
    this.snapRing.visible = !!this.snapTarget;
    if (this.snapTarget) {
      this.snapRing.position.set(this.snapTarget.pos.x, this.snapTarget.pos.y + 2, this.snapTarget.pos.z);
      (this.snapRing.material as THREE.MeshBasicMaterial).color.setHex(tint);
    }
    // Cyan diamond on the point you'd connect to: a line end (extend) or a mid-track junction (branch).
    const connectAt = this.snapEnd?.pos ?? this.branchFrom?.pos ?? null;
    this.connectMarker.visible = !!connectAt;
    if (connectAt) this.connectMarker.position.set(connectAt.x, connectAt.y + 5, connectAt.z);

    this.rebuildPreviewTrack(tint);
    (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(this.snapTarget ? tint : 0xffffff);
  }

  /** Rebuild the ghost rail line when the route's shape (or snap state) changes enough. */
  private rebuildPreviewTrack(tint: number): void {
    let route = this.routePoints();
    if (route.length < 2) {
      this.clearPreviewTrack();
      return;
    }
    // Preview the EXACT committed route — including the platform berth where a new line meets a
    // station you already serve — so the ghost is what you get, not a straight line that then
    // jumps aside on commit. (Extending or branching off existing track doesn't berth.)
    if (!this.extendFrom && !this.branchFrom) {
      const stops = this.nodes.filter((n) => n.station).map((n) => n.station!);
      if (this.snapTarget && this.snapTarget !== stops[stops.length - 1]) stops.push(this.snapTarget);
      if (stops.length) route = this.network.plannedRoute(this.network.player, stops, route);
      if (route.length < 2) { this.clearPreviewTrack(); return; }
    }
    const tail = route[route.length - 1];
    const snap = this.snapTarget ? (this.snapTarget.hasStation ? 'd' : 'b') : 'n';
    const sig = `${this.nodes.length}|${Math.round(tail.x / 3)}|${Math.round(tail.z / 3)}|${snap}`;
    if (sig === this.previewSig && this.previewTrack) return;
    this.previewSig = sig;
    this.clearPreviewTrack();
    this.previewTrack = buildGhostTrack(route, tint, this.field);
    this.overlay.add(this.previewTrack);
  }

  private clearPreviewTrack(): void {
    if (!this.previewTrack) return;
    this.overlay.remove(this.previewTrack);
    this.previewTrack.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    });
    this.previewTrack = null;
    this.previewSig = '';
  }

  /** Polyline through every placed point, then out to the cursor. When extending a line, a
   *  lead-in point along the line's existing direction makes the preview curve out of the old
   *  end exactly as the committed track will. */
  private routePoints(): THREE.Vector3[] {
    const pts = this.nodes.map((n) => n.pos.clone());
    if (this.cursorValid) pts.push(this.snapTarget ? this.snapTarget.pos.clone() : this.cursor.clone());
    if (this.extendFrom && pts.length >= 1) {
      const e = this.network.lineEnds(this.network.player).find((x) => x.line === this.extendFrom!.line && x.end === this.extendFrom!.end);
      if (e) pts.unshift(e.pos.clone().addScaledVector(e.dir, -24)); // a step back INTO the old track
    } else if (this.branchFrom && pts.length >= 2) {
      // Leave the junction along the main line's tangent (toward the drag) for a run, so the branch
      // peels off as a smooth turnout instead of kinking off at an angle.
      const bp = this.branchFrom.pos;
      const sign = pts[pts.length - 1].clone().sub(bp).setY(0).dot(this.branchFrom.dir) >= 0 ? 1 : -1;
      pts.splice(1, 0, bp.clone().addScaledVector(this.branchFrom.dir, sign * BRANCH_LEAD));
    }
    return pts;
  }

  private emit(): void {
    // The quote is for the NEXT stretch only (anchor → cursor) — each click pays as it lays,
    // so there's no accumulated bill to show. Track cost only; trains are bought separately.
    // Quoted off the straight anchor→cursor run, exactly how the charge is computed.
    const a = this.nodes[this.nodes.length - 1];
    const cost = a && this.cursorValid ? this.network.routeCost([a.pos, this.snapTarget ? this.snapTarget.pos : this.cursor]) : 0;
    this.onStatus?.({
      active: this.active,
      fromName: this.nodes.find((n) => n.station)?.station?.name ?? null,
      cost,
      affordable: cost <= this.network.money,
      canFinish: this.runSteps.length > 0,
      hint: !this.active ? '' : this.routingHint(),
    });
  }

  private routingHint(): string {
    if (this.branchFrom && !this.nodes.length) return '🔗 <b>Branch off your track here</b> — press, then every click lays (and pays for) real track from this junction.';
    if (this.snapEnd) return '🔗 <b>Connected to your line</b> — every click now lays (and pays for) the next stretch of track.';
    if (this.snapTarget && this.nodes.length === 0) {
      return this.snapTarget.hasStation
        ? `Start a <b>new line</b> from <b>${this.snapTarget.name}</b> — every click lays real track. It gets its own platform (up to <b>4 lines</b> per station).`
        : `<b>${this.snapTarget.name}</b> needs a <b>Station</b> first (click the city → Build Station).`;
    }
    if (this.nodes.length) {
      const to = this.snapTarget ? ` — release on <b>${this.snapTarget.name}</b> to connect it` : '';
      const done = this.runSteps.length ? ' · <b>✓ Done</b> ends the run' : '';
      return `Click to <b>lay track</b> to the cursor (built and paid right there)${to} · right-click <b>undoes + refunds</b>${done}.`;
    }
    return 'Press a <b>station</b> to start a new line, a <b>cyan tip</b> to extend, or <b>click on your track</b> to branch — track lays and is paid for click by click.';
  }
}

/** A translucent, terrain-draped preview of the rail line: two tinted rails over a row of
 *  ties, draped on the ground. The caller picks the rail tint (green = snapping to a depot,
 *  amber = a city needing one, blue = free track). Light enough to rebuild while dragging. */
function buildGhostTrack(points: THREE.Vector3[], tint: number, field: Heightfield): THREE.Group {
  const g = new THREE.Group();
  g.renderOrder = 998;

  // Densify + drape each segment on the terrain so the preview hugs the ground.
  const draped: THREE.Vector3[] = [];
  const floor = field.params.seaLevel + 0.6;
  for (let w = 0; w < points.length - 1; w++) {
    const a = points[w];
    const b = points[w + 1];
    const steps = Math.max(2, Math.floor(a.distanceTo(b) / 14));
    const last = w === points.length - 2;
    for (let i = 0; i < steps + (last ? 1 : 0); i++) {
      const s = i / steps;
      const x = THREE.MathUtils.lerp(a.x, b.x, s);
      const z = THREE.MathUtils.lerp(a.z, b.z, s);
      const y = Math.max(field.height(x, z), floor) + DECK;
      draped.push(new THREE.Vector3(x, y, z));
    }
  }
  if (draped.length < 2) return g;

  const curve = new THREE.CatmullRomCurve3(draped, false, 'catmullrom', 0.5);
  const length = Math.max(1, curve.getLength());

  // Gravel ballast bed — a continuous ribbon so the preview reads as REAL track being laid,
  // not two thin lines.
  const ballN = Math.min(160, Math.max(6, Math.floor(length / 4)));
  const bedW = TIE_W * 0.6;
  const bverts: number[] = [];
  const bp = new THREE.Vector3();
  const bt = new THREE.Vector3();
  const bperp = new THREE.Vector3();
  for (let i = 0; i <= ballN; i++) {
    curve.getPointAt(i / ballN, bp);
    curve.getTangentAt(i / ballN, bt);
    bperp.crossVectors(bt, UP).normalize();
    const y = bp.y - 0.24;
    bverts.push(bp.x - bperp.x * bedW, y, bp.z - bperp.z * bedW);
    bverts.push(bp.x + bperp.x * bedW, y, bp.z + bperp.z * bedW);
  }
  const bidx: number[] = [];
  for (let i = 0; i < ballN; i++) { const a = i * 2; bidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const bgeo = new THREE.BufferGeometry();
  bgeo.setAttribute('position', new THREE.Float32BufferAttribute(bverts, 3));
  bgeo.setIndex(bidx);
  g.add(new THREE.Mesh(bgeo, new THREE.MeshBasicMaterial({ color: 0x837a6d, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide })));

  // Ties.
  const tieCount = Math.min(240, Math.max(4, Math.floor(length / 2.4)));
  const tieMat = new THREE.MeshBasicMaterial({ color: 0x5c4630, transparent: true, opacity: 0.78, depthWrite: false });
  const ties = new THREE.InstancedMesh(new THREE.BoxGeometry(TIE_W, 0.22, 0.55), tieMat, tieCount);
  const dummy = new THREE.Object3D();
  const pos = new THREE.Vector3();
  const tan = new THREE.Vector3();
  for (let i = 0; i < tieCount; i++) {
    const u = (i + 0.5) / tieCount;
    curve.getPointAt(u, pos);
    curve.getTangentAt(u, tan);
    dummy.position.set(pos.x, pos.y - 0.16, pos.z);
    dummy.rotation.set(0, Math.atan2(tan.x, tan.z), 0);
    dummy.updateMatrix();
    ties.setMatrixAt(i, dummy.matrix);
  }
  ties.instanceMatrix.needsUpdate = true;
  g.add(ties);

  // Two rails as tinted tubes (a touch thicker + nearly solid so they read as steel).
  const railMat = new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.98, depthWrite: false });
  const railN = Math.min(180, Math.max(8, Math.floor(length / 3)));
  for (const off of [-GAUGE / 2, GAUGE / 2]) {
    const line: THREE.Vector3[] = [];
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const perp = new THREE.Vector3();
    for (let i = 0; i <= railN; i++) {
      curve.getPointAt(i / railN, p);
      curve.getTangentAt(i / railN, t);
      perp.crossVectors(t, UP).normalize();
      line.push(new THREE.Vector3(p.x + perp.x * off, p.y, p.z + perp.z * off));
    }
    const rc = new THREE.CatmullRomCurve3(line, false, 'catmullrom', 0.5);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(rc, railN, 0.32, 6, false), railMat));
  }
  return g;
}
