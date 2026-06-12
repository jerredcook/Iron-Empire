import * as THREE from 'three';
import { Track, TRACK_SIDE } from './Track';
import { buildLocomotive, LocomotiveRig } from './Locomotive';
import { buildBoxcar, FreightCar } from './Cars';
import { CargoKind, CARGO } from './Cargo';
import { LocoClass } from './Locomotives';

const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const STOP_MARGIN = 9; // how close to the line's end the train berths
const BLOCK_GAP = 16; // safe separation a following train keeps behind its leader
export const CAR_CAP = 24; // units one freight car holds

/** One car in a consist: a fixed cargo type and what it's currently carrying. */
export interface Car {
  kind: CargoKind;
  amount: number;
  /** Where the current load was picked up (for the distance-based haul payment). */
  origin: THREE.Vector3;
}

/**
 * A locomotive + freight consist running a Track. It accelerates away from each
 * berth, cruises, and decelerates into the far end where it dwells briefly while the
 * network loads/unloads it (via the onArrive hook), then reverses. Wheels and rods
 * stay synced to ground speed, smoke thickens with effort, and the trailing boxcars
 * articulate along the curve wearing the livery of whatever they carry.
 */
export class Train {
  readonly group = new THREE.Group();
  /** The ordered consist: one entry per car, each a fixed cargo type. */
  readonly consist: Car[] = [];
  readonly capacity: number;
  /** Fired when the train berths at a stop, with that stop's index along the line. */
  onStop?: (stopIndex: number) => void;

  /** The class this train is hauling with — its stats drive speed/capacity/upkeep. */
  readonly locoClass: LocoClass;

  private loco: LocomotiveRig;
  private cars: FreightCar[] = [];
  private smoke: Smoke;
  /** Arc-length position of each stop along the track, ascending (ends inset by the berth margin). */
  private stopDist: number[];
  private dist: number;
  private dir: 1 | -1 = 1;
  private target = 1; // index in stopDist we're heading toward
  private speed = 0;
  private maxSpeed: number;
  private wheelAngle = 0;
  private dwell = 0;

  private _pos = new THREE.Vector3();
  private _tan = new THREE.Vector3();
  private _perp = new THREE.Vector3();
  private _quat = new THREE.Quaternion();
  private _head = new THREE.Vector3();
  private _tip = new THREE.Vector3();
  /** Arc-length the train ahead on this rail occupies — it may not advance past it. */
  private block: number | null = null;

  constructor(private track: Track, scene: THREE.Scene, locoClass: LocoClass, stopFracs: number[], carKinds: CargoKind[]) {
    this.locoClass = locoClass;
    this.capacity = carKinds.length * CAR_CAP;
    this.maxSpeed = locoClass.speed;
    const len = track.length;
    // Stops at their arc positions, ends pulled in to the berth margin, ascending.
    this.stopDist = stopFracs
      .map((f) => THREE.MathUtils.clamp(f * len, STOP_MARGIN, len - STOP_MARGIN))
      .sort((a, b) => a - b);
    this.loco = buildLocomotive();
    this.group.add(this.loco.group);
    // One car per configured slot, permanently liveried to its cargo type.
    for (const kind of carKinds) {
      const car = buildBoxcar();
      car.setLivery(CARGO[kind].color);
      this.cars.push(car);
      this.group.add(car.group);
      this.consist.push({ kind, amount: 0, origin: new THREE.Vector3() });
    }
    this.smoke = new Smoke(220);
    scene.add(this.smoke.points);
    this.dist = this.stopDist[0];
    this.dir = 1;
    this.target = 1;
  }

  /** World position of the locomotive (for minimap dots / camera framing). */
  get headPosition(): THREE.Vector3 {
    return this.loco.group.position;
  }

  /** Current arc-length position and heading — read by the block-signal pass. */
  get railDist(): number {
    return this.dist;
  }
  get heading(): 1 | -1 {
    return this.dir;
  }

  /** The arc-length a leader occupies ahead on this rail (same direction), or null
   *  if the line is clear. The train holds short of it. */
  setBlock(d: number | null): void {
    this.block = d;
  }

  /** Shift this train's start along the line (0..1) so several trains on one corridor
   *  stay spaced out, re-aiming it at the next stop ahead. */
  offsetStart(frac: number): void {
    const len = this.track.length;
    this.dist = THREE.MathUtils.clamp(frac * len, STOP_MARGIN, len - STOP_MARGIN);
    const ahead = this.stopDist.findIndex((d) => d > this.dist + 1);
    if (ahead === -1) {
      this.dir = -1;
      this.target = this.stopDist.length - 2;
    } else {
      this.dir = 1;
      this.target = ahead;
    }
  }

  /** Total units currently aboard. */
  cargoTotal(): number {
    let t = 0;
    for (const car of this.consist) t += car.amount;
    return t;
  }

  update(dt: number): void {
    const len = this.track.length;

    if (this.dwell > 0) {
      this.dwell -= dt;
      this.speed = 0;
    } else {
      // Aim for the next scheduled stop, but never past the block a leader holds ahead
      // on this rail — so a following train eases to a stand behind it instead of
      // telescoping into it.
      const stop = this.stopDist[this.target];
      let limit = stop;
      if (this.block !== null) {
        const hold = this.block - BLOCK_GAP;
        limit = this.dir > 0 ? Math.min(stop, hold) : Math.max(stop, this.block + BLOCK_GAP);
      }
      const remaining = Math.max(0, (limit - this.dist) * this.dir);
      const target = Math.min(this.maxSpeed, Math.max(0, remaining * 0.9));
      this.speed += THREE.MathUtils.clamp(target - this.speed, -28 * dt, 12 * dt);
      this.speed = Math.max(0, this.speed);
      this.dist += this.dir * this.speed * dt;
      // Don't overshoot the limit (the held block or the stop).
      if (this.dir > 0) this.dist = Math.min(this.dist, limit);
      else this.dist = Math.max(this.dist, limit);

      const reached = this.dir > 0 ? this.dist >= stop - 0.01 : this.dist <= stop + 0.01;
      if (reached) {
        this.dist = stop;
        this.dwell = 2.2;
        const stopped = this.target;
        // Advance to the next stop, reversing at either end of the corridor.
        if (this.target >= this.stopDist.length - 1) {
          this.dir = -1;
          this.target = this.stopDist.length - 2;
        } else if (this.target <= 0) {
          this.dir = 1;
          this.target = 1;
        } else {
          this.target += this.dir;
        }
        this.onStop?.(stopped);
      }
    }

    this.placeBody(this.dist, this.dir, this.loco.group, -0.78);
    this.wheelAngle += (this.dir * this.speed * dt) / this.loco.driverRadius;
    this.loco.setWheelAngle(this.wheelAngle);

    // Boxcars trail the tender, each sampled at its own arc-length so they swing
    // through curves independently.
    for (let i = 0; i < this.cars.length; i++) {
      const back = this.dist - this.dir * (10.5 + i * 6.2);
      this.placeBody(THREE.MathUtils.clamp(back, 0, len), this.dir, this.cars[i].group, -0.78);
    }

    this.loco.group.updateMatrixWorld();
    this.loco.chimneyTip(this._tip);
    this.smoke.update(dt, this._tip, this.speed);
  }

  private placeBody(dist: number, dir: 1 | -1, obj: THREE.Object3D, yOff: number): void {
    const u = THREE.MathUtils.clamp(dist / this.track.length, 0, 1);
    this.track.curve.getPointAt(u, this._pos);
    this.track.curve.getTangentAt(u, this._tan);
    this._head.copy(this._tan).multiplyScalar(dir);
    this._quat.setFromUnitVectors(FORWARD, this._head);
    obj.position.copy(this._pos);
    // Keep to one running line per direction (double track), so opposing trains pass
    // on separate rails rather than through each other.
    this._perp.crossVectors(this._tan, UP).normalize();
    const side = dir > 0 ? -TRACK_SIDE : TRACK_SIDE;
    obj.position.addScaledVector(this._perp, side);
    obj.position.y += yOff;
    obj.quaternion.copy(this._quat);
  }
}

/** Soft sprite smoke: puffs rise, drift, grow and fade. */
class Smoke {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private cursor = 0;
  private accum = 0;

  constructor(private count: number) {
    this.pos = new Float32Array(count * 3).fill(-9999);
    this.vel = new Float32Array(count * 3);
    this.age = new Float32Array(count).fill(1e9);
    this.life = new Float32Array(count).fill(1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(count), 1));
    const mat = new THREE.PointsMaterial({
      size: 4.5,
      map: smokeSprite(),
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
      color: 0xd8dade,
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vA;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvA = aAlpha;')
        .replace('gl_PointSize = size;', 'gl_PointSize = size * (2.0 - vA * 1.4);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vA;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vA;');
    };
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  update(dt: number, at: THREE.Vector3, effort: number): void {
    this.accum += dt * Math.min(1.6, 0.25 + effort / 14);
    while (this.accum >= 0.06) {
      this.accum -= 0.06;
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;
      this.pos[i * 3] = at.x + (Math.random() - 0.5) * 0.2;
      this.pos[i * 3 + 1] = at.y;
      this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.2;
      this.vel[i * 3] = (Math.random() - 0.5) * 0.7;
      this.vel[i * 3 + 1] = 2.6 + Math.random() * 1.2;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.7;
      this.age[i] = 0;
      this.life[i] = 2.4 + Math.random() * 1.4;
    }
    const alpha = this.points.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        alpha.setX(i, 0);
        continue;
      }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] *= 0.995;
      alpha.setX(i, (1 - t) * Math.min(1, t * 6));
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    alpha.needsUpdate = true;
  }
}

function smokeSprite(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.55, 'rgba(235,235,238,0.45)');
  grad.addColorStop(1, 'rgba(230,230,233,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
