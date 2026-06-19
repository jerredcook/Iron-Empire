import * as THREE from 'three';
import { Network } from './Network';
import { Smoke } from './Train';

/**
 * Chimney smoke for every processing industry (factories, steelworks) — they sit there
 * belching steadily, harder when they have raw material to work, so a glance across the
 * map shows the country actually at work. Reuses the locomotive's particle smoke. A stack
 * is created lazily the first time an industry appears (including ones the player founds
 * mid-game) and lives for the session — industries don't move or vanish.
 */
export class Smokestacks {
  private stacks = new Map<number, { smoke: Smoke; tip: THREE.Vector3 }>();

  constructor(private scene: THREE.Scene, private network: Network) {}

  /** Number of active chimneys — read by the headless render test. */
  count(): number {
    return this.stacks.size;
  }

  update(dt: number): void {
    for (const s of this.network.stations) {
      if (!s.recipe) continue;
      let stack = this.stacks.get(s.id);
      if (!stack) {
        const smoke = new Smoke(80);
        this.scene.add(smoke.points);
        // Above the industrial quarter (where buildFactory drops the hall).
        const tip = new THREE.Vector3(s.pos.x - 28, s.pos.y + 15, s.pos.z + 22);
        stack = { smoke, tip };
        this.stacks.set(s.id, stack);
      }
      // Busier (more emission) when it actually has inputs queued to process.
      let busy = false;
      for (const v of s.input.values()) if (v > 0.5) busy = true;
      stack.smoke.update(dt, stack.tip, busy ? 9 : 3);
    }
  }
}
