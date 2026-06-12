import * as THREE from 'three';
import { Network } from './Network';
import { Selection } from './Inspector';

const CLICK_SLOP = 6; // px of travel still counted as a click, not a drag
const STATION_PICK = 75; // ground-distance for latching a click onto a city

/**
 * Turns a click on the world into a selection. Trains take priority (you click the
 * actual locomotive mesh); otherwise the click is projected to the ground and the
 * nearest city within reach is chosen. A click on empty land clears the selection.
 * Stands down entirely while the track builder owns the pointer.
 */
export class Picker {
  onSelect?: (sel: Selection) => void;

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private down = new THREE.Vector2();

  constructor(
    private camera: THREE.Camera,
    private dom: HTMLElement,
    private terrain: THREE.Object3D,
    private network: Network,
    private isBuilding: () => boolean
  ) {
    this.dom.addEventListener('pointerdown', (e) => this.down.set(e.clientX, e.clientY));
    this.dom.addEventListener('pointerup', this.onUp);
  }

  private onUp = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (this.isBuilding()) return;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > CLICK_SLOP) return; // a drag

    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera as THREE.PerspectiveCamera);

    // 1) A locomotive under the cursor wins.
    const trainGroups = this.network.lines.flatMap((l) => l.trains.map((t) => t.group));
    const hit = this.ray.intersectObjects(trainGroups, true)[0];
    if (hit) {
      for (const line of this.network.lines) {
        const train = line.trains.find((t) => isDescendant(hit.object, t.group));
        if (train) {
          this.onSelect?.({ kind: 'train', line, train });
          return;
        }
      }
    }

    // 2) Otherwise project to the ground and grab the nearest city.
    const ground = this.ray.intersectObject(this.terrain, true)[0];
    if (ground) {
      const st = this.network.nearestStation(ground.point, STATION_PICK);
      this.onSelect?.(st ? { kind: 'station', station: st } : null);
    }
  };
}

function isDescendant(obj: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (o === ancestor) return true;
  return false;
}
