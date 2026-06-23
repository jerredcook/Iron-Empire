import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * RTS camera tuned for a trackpad (no mouse/trackball assumed). Click-drag pans, two-finger
 * scroll zooms (to the cursor), and the keyboard does the rest so nothing needs a right
 * button: WASD/arrows pan, Q/E orbit, R/F zoom, Home (or 0) resets to the opening view.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  private keys = new Set<string>();
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private home: { pos: THREE.Vector3; target: THREE.Vector3 };

  constructor(dom: HTMLElement, worldSize: number) {
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 1, worldSize * 6);
    this.camera.position.set(-worldSize * 0.2, worldSize * 0.24, worldSize * 0.3);

    this.controls = new MapControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.screenSpacePanning = false; // pan across the ground plane (right for a map view)
    this.controls.zoomToCursor = true; // two-finger scroll zooms toward the pointer
    this.controls.minDistance = 26;
    this.controls.maxDistance = worldSize * 0.85;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(84);

    this.home = { pos: this.camera.position.clone(), target: this.controls.target.clone() };

    // Ignore keys typed into form fields (e.g. the menu's name box) so they don't drive the camera.
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  update(dt: number): void {
    // Pan (WASD / arrows): slide camera + target across the ground plane.
    let mx = 0;
    let mz = 0;
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

    // Orbit (Q/E): yaw around the look-at target — the trackpad stand-in for right-drag.
    let yaw = 0;
    if (this.keys.has('q')) yaw += 1;
    if (this.keys.has('e')) yaw -= 1;
    if (yaw) {
      const off = this.camera.position.clone().sub(this.controls.target);
      off.applyAxisAngle(UP, yaw * 1.1 * dt);
      this.camera.position.copy(this.controls.target).add(off);
    }

    // Zoom (R/F): dolly toward / away from the target, within the controls' distance limits.
    let dz = 0;
    if (this.keys.has('r')) dz -= 1; // in
    if (this.keys.has('f')) dz += 1; // out
    if (dz) {
      const off = this.camera.position.clone().sub(this.controls.target);
      const len = THREE.MathUtils.clamp(off.length() * (1 + dz * 1.6 * dt), this.controls.minDistance, this.controls.maxDistance);
      this.camera.position.copy(this.controls.target).add(off.setLength(len));
    }

    // Reset to the opening overview.
    if (this.keys.has('home') || this.keys.has('0')) this.reset();

    this.controls.update();
  }

  /** Restore the opening 3/4 overview. */
  reset(): void {
    this.camera.position.copy(this.home.pos);
    this.controls.target.copy(this.home.target);
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
