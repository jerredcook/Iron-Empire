import * as THREE from 'three';
import { Track } from './Track';
import { buildLocomotive, LocomotiveRig } from './Locomotive';
import { buildBoxcar, FreightCar } from './Cars';
import { CargoKind, CARGO } from './Cargo';

const FORWARD = new THREE.Vector3(0, 0, 1);
const STOP_MARGIN = 9; // how close to the line's end the train berths

/** A single cargo lot riding the train, tagged with where it was picked up so the
 *  delivering station can be paid for the distance it travelled. */
export interface CargoLot {
  amount: number;
  originPos: THREE.Vector3;
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
  readonly cargo = new Map<CargoKind, CargoLot>();
  readonly capacity: number;
  /** Fired when the train berths at an end: 0 = line start, 1 = line end. */
  onArrive?: (end: 0 | 1) => void;

  private loco: LocomotiveRig;
  private cars: FreightCar[] = [];
  private smoke: Smoke;
  private dist: number;
  private dir: 1 | -1 = 1;
  private speed = 0;
  private maxSpeed = 22;
  private wheelAngle = 0;
  private dwell = 0;

  private _pos = new THREE.Vector3();
  private _tan = new THREE.Vector3();
  private _quat = new THREE.Quaternion();
  private _head = new THREE.Vector3();
  private _tip = new THREE.Vector3();

  constructor(private track: Track, scene: THREE.Scene, carCount = 3, capacity = 60) {
    this.capacity = capacity;
    this.loco = buildLocomotive();
    this.group.add(this.loco.group);
    for (let i = 0; i < carCount; i++) {
      const car = buildBoxcar();
      this.cars.push(car);
      this.group.add(car.group);
    }
    this.smoke = new Smoke(220);
    scene.add(this.smoke.points);
    this.dist = STOP_MARGIN;
    this.dir = 1;
  }

  /** Total units currently aboard. */
  cargoTotal(): number {
    let t = 0;
    for (const lot of this.cargo.values()) t += lot.amount;
    return t;
  }

  cargoFree(): number {
    return this.capacity - this.cargoTotal();
  }

  /** Re-livery cars to the dominant cargo aboard (called by the network after a load). */
  refreshLivery(): void {
    const kinds: CargoKind[] = [];
    for (const [k, lot] of this.cargo) {
      const cars = Math.max(1, Math.round((lot.amount / this.capacity) * this.cars.length));
      for (let i = 0; i < cars; i++) kinds.push(k);
    }
    for (let i = 0; i < this.cars.length; i++) {
      this.cars[i].setLivery(i < kinds.length ? CARGO[kinds[i]].color : null);
    }
  }

  update(dt: number): void {
    const len = this.track.length;
    const farEnd = len - STOP_MARGIN;

    if (this.dwell > 0) {
      this.dwell -= dt;
      this.speed = 0;
    } else {
      // Trapezoidal speed: ease toward a target that collapses near the berth so the
      // train glides in rather than slamming to a halt.
      const remaining = this.dir > 0 ? farEnd - this.dist : this.dist - STOP_MARGIN;
      const target = Math.min(this.maxSpeed, Math.max(3, remaining * 0.9));
      this.speed += THREE.MathUtils.clamp(target - this.speed, -28 * dt, 12 * dt);
      this.dist += this.dir * this.speed * dt;

      if (this.dir > 0 && this.dist >= farEnd) {
        this.dist = farEnd;
        this.dir = -1;
        this.dwell = 2.2;
        this.onArrive?.(1);
      } else if (this.dir < 0 && this.dist <= STOP_MARGIN) {
        this.dist = STOP_MARGIN;
        this.dir = 1;
        this.dwell = 2.2;
        this.onArrive?.(0);
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
