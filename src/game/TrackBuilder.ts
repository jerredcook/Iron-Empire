import * as THREE from 'three';
import { Network, GStation } from './Network';
import { LocoClass } from './Locomotives';

const SNAP = 60; // ground-distance within which the cursor latches to a city
const CLICK_SLOP = 6; // px of pointer travel still counted as a click, not a drag

export interface BuildStatus {
  active: boolean;
  fromName: string | null;
  cost: number;
  affordable: boolean;
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
  /** Fired when a corridor is finished — the listener configures + commits it. */
  onCommit?: (stops: GStation[], segMids: THREE.Vector3[][]) => void;

  private active = false;
  /** Ordered stations clicked so far (the corridor's stops). */
  private stops: GStation[] = [];
  /** Grade points for each completed segment (between consecutive stops). */
  private segMids: THREE.Vector3[][] = [];
  /** Grade points dropped since the last stop (the segment in progress). */
  private mids: THREE.Vector3[] = [];
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
    this.stops = [];
    this.segMids = [];
    this.mids = [];
    this.ghost.visible = false;
    this.snapRing.visible = false;
    this.preview.visible = false;
    this.emit();
  }

  toggle(): void {
    if (this.active) this.cancel();
    else this.start();
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
    // Don't snap back onto the stop we're currently leaving.
    this.snapTarget = near && near !== this.lastStop ? near : null;
    if (this.snapTarget) this.cursor.copy(this.snapTarget.pos);
  }

  private get lastStop(): GStation | null {
    return this.stops.length ? this.stops[this.stops.length - 1] : null;
  }

  private place(): void {
    if (this.stops.length === 0) {
      // Must begin on a city.
      const start = this.snapTarget ?? this.network.nearestStation(this.cursor, SNAP);
      if (!start) return;
      this.stops.push(start);
      this.emit();
      return;
    }
    if (this.snapTarget) {
      // Reaching another city closes the current segment and adds it as a stop;
      // the corridor keeps going until the player presses Enter.
      this.segMids.push(this.mids);
      this.stops.push(this.snapTarget);
      this.mids = [];
      this.refreshVisuals();
      this.emit();
      return;
    }
    this.mids.push(this.cursor.clone());
    this.emit();
  }

  /** Hand the finished corridor (≥2 stops) to the listener to configure + commit. */
  private finish(): void {
    if (this.stops.length < 2) return;
    this.onCommit?.(this.stops.slice(), this.segMids.map((a) => a.slice()));
    this.stops = [];
    this.segMids = [];
    this.mids = [];
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
    if (this.stops.length && route.length >= 2) {
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

  /** Full polyline through every committed stop, then the in-progress segment out to
   *  the cursor. */
  private routePoints(): THREE.Vector3[] {
    if (!this.stops.length) return [];
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < this.stops.length; i++) {
      pts.push(this.stops[i].pos.clone());
      if (i < this.stops.length - 1) for (const m of this.segMids[i]) pts.push(m.clone());
    }
    for (const m of this.mids) pts.push(m.clone());
    if (this.cursorValid && !this.snapTarget) pts.push(this.cursor.clone());
    else if (this.snapTarget) pts.push(this.snapTarget.pos.clone());
    return pts;
  }

  private emit(): void {
    const route = this.routePoints();
    const cost = this.stops.length && route.length >= 2 ? this.network.lineCost(route, this.getLoco()) : 0;
    this.onStatus?.({
      active: this.active,
      fromName: this.stops[0]?.name ?? null,
      cost,
      affordable: cost <= this.network.money,
      hint: !this.active
        ? ''
        : this.stops.length === 0
          ? 'Click a city to start the line'
          : this.snapTarget
            ? `Click ${this.snapTarget.name} to add it as a stop · Enter to finish`
            : this.stops.length >= 2
              ? 'Drop a grade point · click a city for another stop · Enter to finish · Esc cancels'
              : 'Click to drop a grade point · click a city to add a stop · Esc cancels',
    });
  }
}
