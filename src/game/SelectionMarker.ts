import * as THREE from 'three';

/**
 * A world-space highlight for the currently selected city: a pulsing ring on the ground
 * with a bobbing pin floating above it. Drawn over everything (depthTest off, high render
 * order) so it's never hidden behind terrain or buildings. Purely cosmetic.
 */
export class SelectionMarker {
  private group = new THREE.Group();
  private ring: THREE.Mesh;
  private pin: THREE.Mesh;
  private t = 0;

  constructor(private scene: THREE.Scene, color = 0x9af7b0) {
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(24, 1.3, 10, 56), ringMat);
    this.ring.rotation.x = Math.PI / 2; // lie flat on the ground
    this.ring.renderOrder = 1000;

    const pinMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
    this.pin = new THREE.Mesh(new THREE.ConeGeometry(3.6, 9, 4), pinMat);
    this.pin.rotation.x = Math.PI; // point the tip down at the city
    this.pin.renderOrder = 1000;

    this.group.add(this.ring, this.pin);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Whether a city is currently highlighted. */
  get active(): boolean {
    return this.group.visible;
  }

  /** The highlight's world position. */
  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Highlight the city at the given world position. */
  show(pos: THREE.Vector3): void {
    this.group.position.copy(pos);
    this.group.visible = true;
    this.t = 0;
  }

  hide(): void {
    this.group.visible = false;
  }

  /** Per-frame pulse + bob. Fed real dt, so it keeps animating even while paused. */
  update(dt: number): void {
    if (!this.group.visible) return;
    this.t += dt;
    const beat = 0.5 + 0.5 * Math.sin(this.t * 3);
    this.ring.scale.setScalar(1 + beat * 0.12);
    this.ring.position.y = 2;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.4 * beat;
    this.pin.position.y = 30 + Math.sin(this.t * 2.4) * 2.6;
    this.pin.rotation.y = this.t * 1.1; // slow spin
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.ring.geometry.dispose();
    this.pin.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    (this.pin.material as THREE.Material).dispose();
  }
}
