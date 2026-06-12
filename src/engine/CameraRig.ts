import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';

/** RTS camera: drag pans, right-drag orbits, wheel zooms, WASD nudges. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  private keys = new Set<string>();
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();

  constructor(dom: HTMLElement, worldSize: number) {
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 1, worldSize * 6);
    this.camera.position.set(-worldSize * 0.2, worldSize * 0.24, worldSize * 0.3);

    this.controls = new MapControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 26;
    this.controls.maxDistance = worldSize * 0.85;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(84);

    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  update(dt: number): void {
    let mx = 0,
      mz = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) mz += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) mz -= 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
    if (mx || mz) {
      this.camera.getWorldDirection(this.fwd);
      this.fwd.y = 0;
      this.fwd.normalize();
      this.right.crossVectors(this.fwd, this.camera.up).normalize();
      const speed = Math.max(120, this.camera.position.y * 1.2);
      const move = new THREE.Vector3().addScaledVector(this.fwd, mz).addScaledVector(this.right, mx).normalize().multiplyScalar(speed * dt);
      this.camera.position.add(move);
      this.controls.target.add(move);
    }
    this.controls.update();
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
