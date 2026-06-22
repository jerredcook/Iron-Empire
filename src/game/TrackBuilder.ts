import * as THREE from 'three';
import { Network, GStation } from './Network';
import { LocoClass } from './Locomotives';

const SNAP = 60; // ground-distance within which the cursor latches to a city
const CLICK_SLOP = 9; // px of pointer travel still counted as a click, not a drag (forgiving on trackpads)

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
 * Interactive track laying. In build mode the cursor raycasts the terrain; the player
 * clicks a city to start, drops intermediate grade points across the landscape, and
 * clicks a second city to commit the line. A ghost node and live preview rail show
 * where the route goes and what it will cost; drags still pan/orbit the camera, so
 * only a click-in-place places a point.
 */
export class TrackBuilder {
  onStatus?: (s: BuildStatus) => void;
  /** Fired when a route is finished — the listener configures + commits it. The nodes
   *  are every point in order; those with a station are the line's stops. */
  onCommit?: (nodes: RouteNode[]) => void;

  private active = false;
  /** Every clicked point in order; free terrain points have station = null. */
  private nodes: RouteNode[] = [];
  private cursor = new THREE.Vector3();
  private cursorValid = false;
  private snapTarget: GStation | null = null;

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private down = new THREE.Vector2();
  private ghost: THREE.Mesh;
  private snapRing: THREE.Mesh;
  private preview: THREE.Line;
  private previewGeo = new THREE.BufferGeometry();

  constructor(
    private camera: THREE.Camera,
    private dom: HTMLElement,
    private terrain: THREE.Object3D,
    private network: Network,
    overlay: THREE.Scene,
    /** The engine to staff a finished line with — supplied live by the HUD. */
    private getLoco: () => LocoClass
  ) {
    this.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x8fffa8, transparent: true, opacity: 0.85 })
    );
    this.ghost.visible = false;
    this.ghost.renderOrder = 999;
    overlay.add(this.ghost);

    this.snapRing = new THREE.Mesh(
      new THREE.TorusGeometry(SNAP * 0.5, 1.4, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0x8fffa8, transparent: true, opacity: 0.6 })
    );
    this.snapRing.rotation.x = Math.PI / 2;
    this.snapRing.visible = false;
    overlay.add(this.snapRing);

    this.preview = new THREE.Line(
      this.previewGeo,
      new THREE.LineBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.95 })
    );
    this.preview.visible = false;
    this.preview.renderOrder = 998;
    this.preview.frustumCulled = false;
    overlay.add(this.preview);

    this.dom.addEventListener('pointerdown', this.onDown);
    this.dom.addEventListener('pointerup', this.onUp);
    this.dom.addEventListener('pointermove', this.onMove);
    window.addEventListener('keydown', this.onKey);
  }

  /** Is build mode currently engaged? (Picking should stand down while it is.) */
  isActive(): boolean {
    return this.active;
  }

  /** Enter build mode (idempotent). */
  start(): void {
    this.active = true;
    this.emit();
  }

  /** Leave build mode, discarding any half-drawn route. */
  cancel(): void {
    this.active = false;
    this.nodes = [];
    this.ghost.visible = false;
    this.snapRing.visible = false;
    this.preview.visible = false;
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

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'b' || e.key === 'B') this.toggle();
    else if (e.key === 'Escape') this.cancel();
    else if (e.key === 'Enter' && this.active) this.finish();
  };

  private onDown = (e: PointerEvent): void => {
    this.down.set(e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.active) return;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > CLICK_SLOP) return; // was a drag
    if (e.button === 2) {
      this.cancel();
      return;
    }
    if (e.button !== 0) return;
    this.raycast(e);
    if (!this.cursorValid) return;
    this.place();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.active) return;
    this.raycast(e);
    this.refreshVisuals();
  };

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
    const near = this.network.nearestStation(this.cursor, SNAP);
    // Snap to a city, but not the one we just placed.
    this.snapTarget = near && near !== this.lastStation ? near : null;
    if (this.snapTarget) this.cursor.copy(this.snapTarget.pos);
  }

  private get lastStation(): GStation | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) if (this.nodes[i].station) return this.nodes[i].station;
    return null;
  }

  private place(): void {
    // Lay track freely: each click adds a point. A click on a city makes that point a
    // stop; clicks on open ground are shaping/grade points. No need to start or end on
    // a city — you can lay rail that doesn't connect anything yet.
    this.nodes.push({ pos: this.cursor.clone(), station: this.snapTarget });
    this.refreshVisuals();
    this.emit();
  }

  /** Hand the finished route (≥2 points) to the listener to configure + commit. */
  private finish(): void {
    if (this.nodes.length < 2) return;
    this.onCommit?.(this.nodes.map((n) => ({ pos: n.pos.clone(), station: n.station })));
    this.nodes = [];
    this.refreshVisuals();
    this.emit();
  }

  /** Update ghost, snap ring, and the dashed preview rail to the current cursor. */
  private refreshVisuals(): void {
    if (!this.active) return;
    this.ghost.visible = this.cursorValid;
    if (this.cursorValid) this.ghost.position.set(this.cursor.x, this.cursor.y + 3, this.cursor.z);

    this.snapRing.visible = !!this.snapTarget;
    if (this.snapTarget) this.snapRing.position.set(this.snapTarget.pos.x, this.snapTarget.pos.y + 2, this.snapTarget.pos.z);

    const route = this.routePoints();
    if (this.nodes.length && route.length >= 2) {
      this.previewGeo.setFromPoints(route.map((p) => new THREE.Vector3(p.x, p.y + 2.5, p.z)));
      this.preview.visible = true;
      const affordable = this.network.lineCost(route, this.getLoco()) <= this.network.money;
      (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(
        this.snapTarget ? (affordable ? 0x8fffa8 : 0xff7766) : 0xffe28a
      );
    } else {
      this.preview.visible = false;
      (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(this.snapTarget ? 0x8fffa8 : 0xffffff);
    }
  }

  /** Full polyline through every placed point, then out to the cursor. */
  private routePoints(): THREE.Vector3[] {
    const pts = this.nodes.map((n) => n.pos.clone());
    if (this.cursorValid) pts.push(this.snapTarget ? this.snapTarget.pos.clone() : this.cursor.clone());
    return pts;
  }

  private emit(): void {
    const route = this.routePoints();
    const cost = this.nodes.length && route.length >= 2 ? this.network.lineCost(route, this.getLoco()) : 0;
    const stops = this.nodes.filter((n) => n.station).length;
    const canFinish = route.length >= 2; // at least two points laid (committing a real route)
    this.onStatus?.({
      active: this.active,
      fromName: this.nodes.find((n) => n.station)?.station?.name ?? null,
      cost,
      affordable: cost <= this.network.money,
      canFinish,
      hint: !this.active ? '' : this.routingHint(stops),
    });
  }

  /** The contextual instruction in the build banner. Calls out a city that still needs a
   *  Station, since a stop there earns nothing until one is built. */
  private routingHint(stops: number): string {
    if (this.snapTarget) {
      return this.snapTarget.hasStation
        ? `Click <b>${this.snapTarget.name}</b> to add it as a stop, then ✓ Finish.`
        : `Click <b>${this.snapTarget.name}</b> to route through it — ⚠ it needs a <b>Station</b> first (click the city → Build Station).`;
    }
    if (this.nodes.length === 0) return 'Click your <b>stationed</b> cities in order to lay a route. (Build a Station from a city’s panel first.)';
    return `Route: ${stops} stop${stops === 1 ? '' : 's'} — click more cities, then <b>✓ Finish</b> · <b>✕ Cancel</b> to discard.`;
  }
}
