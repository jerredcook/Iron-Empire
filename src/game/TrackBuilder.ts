import * as THREE from 'three';
import { Network, GStation } from './Network';

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

  private active = false;
  private from: GStation | null = null;
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
    overlay: THREE.Scene
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

  /** Enter build mode (idempotent). */
  start(): void {
    this.active = true;
    this.emit();
  }

  /** Leave build mode, discarding any half-drawn route. */
  cancel(): void {
    this.active = false;
    this.from = null;
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
    // Don't snap back onto the city we started from.
    this.snapTarget = near && near !== this.from ? near : null;
    if (this.snapTarget) this.cursor.copy(this.snapTarget.pos);
  }

  private place(): void {
    if (!this.from) {
      // Must begin on a city.
      const start = this.snapTarget ?? this.network.nearestStation(this.cursor, SNAP);
      if (!start) return;
      this.from = start;
      this.emit();
      return;
    }
    if (this.snapTarget) {
      // Closing on a second city commits the line.
      if (!this.network.isConnected(this.from, this.snapTarget)) {
        const ok = this.network.buildLine(this.from, this.mids, this.snapTarget);
        if (!ok) return; // unaffordable — keep the route up so the player can see it
      }
      this.from = null;
      this.mids = [];
      this.refreshVisuals();
      this.emit();
      return;
    }
    this.mids.push(this.cursor.clone());
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
    if (this.from && route.length >= 2) {
      this.previewGeo.setFromPoints(route.map((p) => new THREE.Vector3(p.x, p.y + 2.5, p.z)));
      this.preview.visible = true;
      const affordable = this.network.routeCost(route) <= this.network.money;
      (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(
        this.snapTarget ? (affordable ? 0x8fffa8 : 0xff7766) : 0xffe28a
      );
    } else {
      this.preview.visible = false;
      (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(this.snapTarget ? 0x8fffa8 : 0xffffff);
    }
  }

  /** Full polyline from the start city through the dropped points to the cursor. */
  private routePoints(): THREE.Vector3[] {
    if (!this.from) return [];
    const pts = [this.from.pos.clone(), ...this.mids.map((m) => m.clone())];
    if (this.cursorValid) pts.push(this.cursor.clone());
    return pts;
  }

  private emit(): void {
    const route = this.routePoints();
    const cost = this.from && route.length >= 2 ? this.network.routeCost(route) : 0;
    this.onStatus?.({
      active: this.active,
      fromName: this.from?.name ?? null,
      cost,
      affordable: cost <= this.network.money,
      hint: !this.active
        ? ''
        : !this.from
          ? 'Click a city to start the line'
          : this.snapTarget
            ? `Click ${this.snapTarget.name} to finish`
            : 'Click to drop a grade point · click a city to finish · Esc cancels',
    });
  }
}
