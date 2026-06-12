import * as THREE from 'three';
import { Track } from './Track';
import { buildLocomotive, LocomotiveRig } from './Locomotive';

const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * A locomotive running a Track: position/orientation sampled from the curve, driving
 * wheels and rods rotating in sync with ground speed, and a chimney smoke plume that
 * thickens with effort. Reverses at the line's ends (demo behaviour).
 */
export class Train {
  readonly group = new THREE.Group();
  private loco: LocomotiveRig;
  private smoke: Smoke;
  private dist = 0;
  private dir = 1;
  private wheelAngle = 0;
  private speed = 16;

  private _pos = new THREE.Vector3();
  private _tan = new THREE.Vector3();
  private _quat = new THREE.Quaternion();
  private _head = new THREE.Vector3();
  private _tip = new THREE.Vector3();

  constructor(private track: Track, scene: THREE.Scene) {
    this.loco = buildLocomotive();
    this.group.add(this.loco.group);
    this.smoke = new Smoke(220);
    scene.add(this.smoke.points);
    this.dist = track.length * 0.3;
  }

  update(dt: number): void {
    this.dist += this.dir * this.speed * dt;
    if (this.dist > this.track.length - 8) {
      this.dist = this.track.length - 8;
      this.dir = -1;
    } else if (this.dist < 8) {
      this.dist = 8;
      this.dir = 1;
    }
    const u = this.dist / this.track.length;
    this.track.curve.getPointAt(u, this._pos);
    this.track.curve.getTangentAt(u, this._tan);
    this._head.copy(this._tan).multiplyScalar(this.dir);
    this._quat.setFromUnitVectors(FORWARD, this._head);
    this.loco.group.position.copy(this._pos);
    this.loco.group.position.y -= 0.78; // wheel contact on the railhead
    this.loco.group.quaternion.copy(this._quat);

    this.wheelAngle += (this.dir * this.speed * dt) / this.loco.driverRadius;
    this.loco.setWheelAngle(this.wheelAngle);

    this.loco.group.updateMatrixWorld();
    this.loco.chimneyTip(this._tip);
    this.smoke.update(dt, this._tip, Math.abs(this.speed));
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
    this.accum += dt * Math.min(1.6, 0.4 + effort / 14);
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
