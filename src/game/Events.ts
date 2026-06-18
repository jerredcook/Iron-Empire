import { CargoKind, CARGO, ALL_CARGO } from './Cargo';

/**
 * The robber-baron era's churn: booms, gluts, panics, and gold rushes that periodically
 * sweep the markets and move freight prices for a while before fading. Each event applies
 * a price multiplier — to one cargo or to all of them — that the Network reads when it
 * pays out a delivery, so the same haul can be worth more or less depending on the times.
 * Self-contained (no world state): the main loop wires its `priceMult` into the Network
 * and its news into the HUD.
 */
export type EventKind = 'boom' | 'glut' | 'panic' | 'goldrush';

interface ActiveEvent {
  title: string;
  good: boolean;
  scope: 'all' | CargoKind;
  mult: number;
  remaining: number; // sim-seconds left
}

const YEAR = 40; // sim-seconds per game-year (matches Network.SECONDS_PER_YEAR)
const FIRST_DELAY = 4 * YEAR; // settle in before the first shock
const INTERVAL_MIN = 6 * YEAR;
const INTERVAL_SPAN = 5 * YEAR;

export class EventDirector {
  private active: ActiveEvent[] = [];
  private timer = FIRST_DELAY;

  /** Optional: trigger a physical disaster (a line washout) instead of a market swing.
   *  Wired by the main loop to the Network; left unset in headless tests. */
  onDisaster?: () => void;

  constructor(
    private onNews?: (text: string, good: boolean) => void,
    private auto = true
  ) {}

  /** Net price multiplier currently applied to a cargo by all active events. */
  priceMult(kind: CargoKind): number {
    let m = 1;
    for (const e of this.active) if (e.scope === 'all' || e.scope === kind) m *= e.mult;
    return m;
  }

  /** Whatever the player most needs to know — the headline of the strongest active event. */
  get headline(): string | null {
    return this.active.length ? this.active[this.active.length - 1].title : null;
  }

  update(dt: number): void {
    for (const e of this.active) e.remaining -= dt;
    this.active = this.active.filter((e) => e.remaining > 0);

    if (!this.auto) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = INTERVAL_MIN + Math.random() * INTERVAL_SPAN;
      // Some of the era's churn is physical, not financial — a storm takes out a line.
      if (this.onDisaster && Math.random() < 0.4) {
        this.onDisaster();
      } else {
        const kinds: EventKind[] = ['boom', 'glut', 'panic', 'goldrush'];
        this.forceEvent(kinds[Math.floor(Math.random() * kinds.length)]);
      }
    }
  }

  /** Trigger a specific event now — used by the random scheduler and the test harness.
   *  For per-cargo events, a cargo may be supplied (otherwise one is chosen at random). */
  forceEvent(kind: EventKind, cargo?: CargoKind): void {
    const pick = (): CargoKind => cargo ?? ALL_CARGO[Math.floor(Math.random() * ALL_CARGO.length)];
    let e: ActiveEvent;
    switch (kind) {
      case 'boom': {
        const c = pick();
        e = { title: `${CARGO[c].label} boom — prices surge`, good: true, scope: c, mult: 1.9, remaining: 3 * YEAR };
        break;
      }
      case 'glut': {
        const c = pick();
        e = { title: `${CARGO[c].label} glut — prices collapse`, good: false, scope: c, mult: 0.5, remaining: 2.5 * YEAR };
        break;
      }
      case 'goldrush':
        e = { title: 'Gold rush — passenger traffic soars', good: true, scope: 'passengers', mult: 2.2, remaining: 2.5 * YEAR };
        break;
      case 'panic':
      default:
        e = { title: 'Financial panic — freight rates slump', good: false, scope: 'all', mult: 0.6, remaining: 2.5 * YEAR };
        break;
    }
    this.active.push(e);
    this.onNews?.(e.title, e.good);
  }
}
