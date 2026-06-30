import * as THREE from 'three';
import { Network, GStation, GLine } from './Network';
import { LocoClass } from './Locomotives';
import { DOUBLE_OFFSET } from './Track';
import { Heightfield } from '../world/Heightfield';

const SNAP = 60; // ground-distance within which the cursor latches to a city
const END_SNAP = 30; // tighter latch onto a free end of your own track to extend it
const DOUBLE_SNAP = 26; // ground-distance within which a press latches onto your own track to double it
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
  /** Which laying mode is engaged — single (new track) or double (parallel rail). */
  mode: 'single' | 'double';
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
  /** Fired when a brand-new route is finished — the listener configures + commits it. */
  onCommit?: (nodes: RouteNode[]) => void;
  /** Fired when the route EXTENDS one of the player's existing lines from a free end. */
  onExtend?: (line: GLine, end: 'head' | 'tail', waypoints: THREE.Vector3[], finalStop: GStation | null) => void;
  /** Fired when a stretch of one of the player's lines is traced to lay a parallel (double) rail.
   *  `side` (+1/-1) is which side of the line the new rail goes — the side you dragged on. */
  onDouble?: (line: GLine, u0: number, u1: number, side: number) => void;

  /** 'single' lays new track; 'double' traces along your own track to lay a parallel rail beside it. */
  private mode: 'single' | 'double' = 'single';
  /** The stretch of your track being traced for a double rail (arc-fractions along that line). `side`
   *  is the side you're dragging on; `maxOff` tracks the most decisive lateral offset so a wobble
   *  across the rail doesn't flip the side. */
  private doubleTrace: { line: GLine; u0: number; u1: number; side: number; maxOff: number } | null = null;
  private dragging = false;
  private active = false;
  private pulseT = 0;
  private placedOnDown = false;
  private nodes: RouteNode[] = [];
  private cursor = new THREE.Vector3();
  private cursorValid = false;
  private snapTarget: GStation | null = null;
  /** When the cursor is over a free end of one of your lines: connect + extend it. */
  private snapEnd: { line: GLine; end: 'head' | 'tail'; pos: THREE.Vector3; dir: THREE.Vector3 } | null = null;
  /** Locked once the route starts from a line end — this run extends that line. */
  private extendFrom: { line: GLine; end: 'head' | 'tail' } | null = null;

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
    private overlay: THREE.Scene,
    /** The engine to staff a finished line with — supplied live by the HUD. */
    private getLoco: () => LocoClass
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
    this.snapEnd = null;
    this.doubleTrace = null;
    this.dragging = false;
    this.ghost.visible = false;
    this.snapRing.visible = false;
    this.connectMarker.visible = false;
    this.clearPreviewTrack();
    this.emit();
  }

  /** Single = lay new track; double = trace your own track to lay a parallel rail. Switching
   *  clears any half-built route/trace. */
  setMode(m: 'single' | 'double'): void {
    if (this.mode === m) return;
    this.mode = m;
    this.nodes = [];
    this.extendFrom = null;
    this.snapEnd = null;
    this.doubleTrace = null;
    this.dragging = false;
    this.ghost.visible = false;
    this.snapRing.visible = false;
    this.connectMarker.visible = false;
    this.clearPreviewTrack();
    this.emit();
  }

  getMode(): 'single' | 'double' {
    return this.mode;
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
    if (!this.active) return;
    if (this.mode === 'double') { this.onDoubleDown(e); return; }
    if (e.button !== 0) return;
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
    if (this.mode === 'double') { this.onDoubleUp(e); return; }
    const wasDrag = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > CLICK_SLOP;
    if (e.button === 2) {
      // Right-click undoes the last point, or leaves build mode if the route is empty.
      if (this.nodes.length) {
        this.nodes.pop();
        this.refreshVisuals();
        this.emit();
      } else {
        this.cancel();
      }
      return;
    }
    if (e.button !== 0) return;
    this.raycast(e);
    if (this.cursorValid && !(this.placedOnDown && !wasDrag)) {
      // Anything but a plain click that only dropped the start adds a point at the release.
      this.pushIfFar(this.snapNode());
    }
    this.placedOnDown = false;
    this.refreshVisuals();
    this.emit();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.active) return;
    if (this.mode === 'double') { this.onDoubleMove(e); return; }
    this.raycast(e);
    this.refreshVisuals();
  };

  // ---- Double-track mode: press on your own track, drag along it, release to lay a parallel rail.

  private onDoubleDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.dragging = true;
    this.raycastGround(e);
    const near = this.cursorValid ? this.network.nearestOnLine(this.network.player, this.cursor, DOUBLE_SNAP) : null;
    this.doubleTrace = near ? { line: near.line, u0: near.u, u1: near.u, side: 1, maxOff: 0 } : null;
    if (this.doubleTrace) this.updateTraceSide(near!.u);
    this.refreshDoubleVisuals();
  }

  private onDoubleMove(e: PointerEvent): void {
    this.raycastGround(e);
    if (this.dragging && this.doubleTrace && this.cursorValid) {
      this.doubleTrace.u1 = THREE.MathUtils.clamp(this.doubleTrace.line.track.nearestU(this.cursor), 0, 1);
      this.updateTraceSide(this.doubleTrace.u1);
    }
    this.refreshDoubleVisuals();
  }

  private onDoubleUp(e: PointerEvent): void {
    if (e.button === 2) { this.cancel(); return; } // right-click leaves build mode
    if (e.button !== 0) return;
    this.dragging = false;
    const tr = this.doubleTrace;
    const committed = !!tr && Math.abs(tr.u1 - tr.u0) * tr.line.track.length >= 24;
    if (committed && tr) this.onDouble?.(tr.line, Math.min(tr.u0, tr.u1), Math.max(tr.u0, tr.u1), tr.side);
    this.doubleTrace = null;
    this.clearPreviewTrack();
    // After laying a rail, drop back to Single so you can immediately keep building/extending track
    // (re-select Double for a 3rd/4th rail on the same stretch). Avoids getting stuck in Double mode.
    if (committed) this.setMode('single');
    else this.emit();
  }

  /** Lock the trace's side to whichever side of the track the cursor is most decisively on, so a
   *  wobble back over the rail mid-drag doesn't flip it. */
  private updateTraceSide(u: number): void {
    const tr = this.doubleTrace;
    if (!tr) return;
    const tp = new THREE.Vector3();
    const tan = new THREE.Vector3();
    tr.line.track.curve.getPointAt(THREE.MathUtils.clamp(u, 0, 1), tp);
    tr.line.track.curve.getTangentAt(THREE.MathUtils.clamp(u, 0, 1), tan);
    const perpx = -tan.z;
    const perpz = tan.x;
    const len = Math.hypot(perpx, perpz) || 1;
    const off = ((this.cursor.x - tp.x) * perpx + (this.cursor.z - tp.z) * perpz) / len;
    if (Math.abs(off) > Math.abs(tr.maxOff)) {
      tr.maxOff = off;
      tr.side = off >= 0 ? 1 : -1;
    }
  }

  /** Project the pointer onto the terrain only (no city/line snap) — for double-mode tracing. */
  private raycastGround(e: PointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera as THREE.PerspectiveCamera);
    const hit = this.ray.intersectObject(this.terrain, true)[0];
    this.cursorValid = !!hit;
    if (hit) this.cursor.copy(hit.point);
  }

  private refreshDoubleVisuals(): void {
    if (!this.active) return;
    this.ghost.visible = false;
    this.snapRing.visible = false;
    this.connectMarker.visible = false;
    const pts = this.doubleTrace ? this.doubleGhostPoints(this.doubleTrace) : [];
    if (pts.length >= 2) {
      const sig = `d|${Math.round(this.doubleTrace!.u0 * 200)}|${Math.round(this.doubleTrace!.u1 * 200)}|${this.doubleTrace!.side}`;
      if (sig !== this.previewSig || !this.previewTrack) {
        this.previewSig = sig;
        this.clearPreviewTrack();
        this.previewTrack = buildGhostTrack(pts, 0x9fd0ff, this.field);
        this.previewSig = sig;
        this.overlay.add(this.previewTrack);
      }
    } else {
      this.clearPreviewTrack();
    }
    this.emit();
  }

  /** Sample the traced stretch of the line's curve, offset to the parallel-rail side, draped on
   *  the ground — the ghost of the second rail about to be laid. */
  private doubleGhostPoints(trace: { line: GLine; u0: number; u1: number; side: number }): THREE.Vector3[] {
    const { line } = trace;
    const u0 = Math.min(trace.u0, trace.u1);
    const u1 = Math.max(trace.u0, trace.u1);
    const segLen = (u1 - u0) * line.track.length;
    if (segLen < 8) return [];
    const off = DOUBLE_OFFSET * (trace.side < 0 ? -1 : 1); // the side you're dragging on
    const n = Math.max(2, Math.floor(segLen / 14));
    const pts: THREE.Vector3[] = [];
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const perp = new THREE.Vector3();
    const floor = this.field.params.seaLevel + 0.6;
    for (let i = 0; i <= n; i++) {
      const u = u0 + (u1 - u0) * (i / n);
      line.track.curve.getPointAt(u, p);
      line.track.curve.getTangentAt(u, t);
      perp.crossVectors(t, UP).normalize();
      const x = p.x + perp.x * off;
      const z = p.z + perp.z * off;
      const y = Math.max(this.field.height(x, z), floor) + 0.7;
      pts.push(new THREE.Vector3(x, y, z));
    }
    return pts;
  }

  private snapNode(): RouteNode {
    if (this.snapEnd) return { pos: this.snapEnd.pos.clone(), station: null };
    return { pos: this.snapTarget ? this.snapTarget.pos.clone() : this.cursor.clone(), station: this.snapTarget };
  }

  private pushIfFar(n: RouteNode): void {
    const last = this.nodes[this.nodes.length - 1];
    if (last && last.pos.distanceTo(n.pos) < 10) return; // ignore a release right on the last point
    this.nodes.push(n);
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
      this.cursor.copy(this.snapEnd.pos);
      return;
    }
    // Snap to ANY city in range, depot or not — you connect the track first, then build the
    // depot. (Using only stationed cities meant a bare destination never latched, so the line
    // didn't actually reach it.)
    const near = this.network.nearestCity(this.cursor, SNAP);
    this.snapTarget = near && near !== this.lastStation ? near : null;
    if (this.snapTarget) this.cursor.copy(this.snapTarget.pos);
  }

  /** The free line-end of yours nearest the cursor, within `maxDist` — or null. */
  private nearestLineEnd(p: THREE.Vector3, maxDist: number): typeof this.snapEnd {
    let best: typeof this.snapEnd = null;
    let bd = maxDist;
    for (const e of this.network.lineEnds(this.network.player)) {
      const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  private get lastStation(): GStation | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) if (this.nodes[i].station) return this.nodes[i].station;
    return null;
  }

  /** Hand the finished route (≥2 points) to the listener. Extending an existing line takes the
   *  extend path; a fresh route takes the commit path. */
  private finish(): void {
    if (this.nodes.length < 2) return;
    if (this.extendFrom) {
      // nodes[0] is the line end (the anchor, already on the line); the rest are new ground.
      const wp = this.nodes.slice(1).map((n) => n.pos.clone());
      const finalStop = [...this.nodes].reverse().find((n) => n.station)?.station ?? null;
      this.onExtend?.(this.extendFrom.line, this.extendFrom.end, wp, finalStop);
    } else {
      this.onCommit?.(this.nodes.map((n) => ({ pos: n.pos.clone(), station: n.station })));
    }
    this.nodes = [];
    this.extendFrom = null;
    this.refreshVisuals();
    this.emit();
  }

  private refreshVisuals(): void {
    if (!this.active) return;
    this.ghost.visible = this.cursorValid;
    if (this.cursorValid) this.ghost.position.set(this.cursor.x, this.cursor.y + 3, this.cursor.z);

    // Green = snapping to a city that already has a depot (ready to run); amber = snapping to
    // a city that still needs one (the track will connect, but build a Station to run trains).
    const tint = this.snapEnd ? 0x5fe0ff : this.snapTarget ? (this.snapTarget.hasStation ? 0x7dffb0 : 0xffcf73) : 0xcfe3ff;
    this.snapRing.visible = !!this.snapTarget;
    if (this.snapTarget) {
      this.snapRing.position.set(this.snapTarget.pos.x, this.snapTarget.pos.y + 2, this.snapTarget.pos.z);
      (this.snapRing.material as THREE.MeshBasicMaterial).color.setHex(tint);
    }
    // Cyan diamond on the line end you'd connect to + extend.
    this.connectMarker.visible = !!this.snapEnd;
    if (this.snapEnd) this.connectMarker.position.set(this.snapEnd.pos.x, this.snapEnd.pos.y + 5, this.snapEnd.pos.z);

    this.rebuildPreviewTrack(tint);
    (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(this.snapTarget ? tint : 0xffffff);
  }

  /** Rebuild the ghost rail line when the route's shape (or snap state) changes enough. */
  private rebuildPreviewTrack(tint: number): void {
    const route = this.routePoints();
    if (route.length < 2) {
      this.clearPreviewTrack();
      return;
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
    }
    return pts;
  }

  private emit(): void {
    if (this.mode === 'double') {
      const tr = this.doubleTrace;
      const cost = tr ? this.network.doubleCost(tr.line, tr.u0, tr.u1) : 0;
      this.onStatus?.({
        active: this.active,
        fromName: null,
        cost,
        affordable: cost <= this.network.money,
        canFinish: false,
        hint: !this.active ? '' : this.doubleHint(),
        mode: 'double',
      });
      return;
    }
    const route = this.routePoints();
    const cost = this.nodes.length && route.length >= 2 ? this.network.lineCost(route, this.getLoco()) : 0;
    const stops = this.nodes.filter((n) => n.station).length;
    this.onStatus?.({
      active: this.active,
      fromName: this.nodes.find((n) => n.station)?.station?.name ?? null,
      cost,
      affordable: cost <= this.network.money,
      canFinish: this.nodes.length >= 2,
      hint: !this.active ? '' : this.routingHint(stops),
      mode: 'single',
    });
  }

  private doubleHint(): string {
    if (!this.doubleTrace) {
      return '<b>Double-track</b> — press on <b>your own track</b> and drag along it; a second rail lays beside the stretch you trace. (Trace an already-double stretch again for a 3rd/4th rail.)';
    }
    return 'Release to lay the second rail along this stretch — <b>right-click</b> cancels.';
  }

  private routingHint(stops: number): string {
    if (this.snapEnd) return '🔗 <b>Connected to your line</b> — drag out to a city and the track curves from here.';
    if (this.snapTarget) {
      return this.snapTarget.hasStation
        ? `Release on <b>${this.snapTarget.name}</b> to connect it — then <b>✓ Finish</b>.`
        : `<b>${this.snapTarget.name}</b> needs a <b>Station</b> first (click the city → Build Station).`;
    }
    if (this.extendFrom) return `Extending your line — drag to a city, then <b>✓ Finish</b> · right-click undoes.`;
    if (this.nodes.length === 0) return 'Start from a <b>city</b> or the <b>end of your track</b> (cyan), and drag out. (Build Stations to run trains.)';
    return `Route: ${stops} stop${stops === 1 ? '' : 's'} — drag on to the next city, or <b>✓ Finish</b> · right-click undoes · <b>✕ Cancel</b> discards.`;
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
