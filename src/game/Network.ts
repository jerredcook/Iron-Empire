import * as THREE from 'three';
import { Heightfield } from '../world/Heightfield';
import { Track } from './Track';
import { Train } from './Train';
import { CargoKind, haulRevenue } from './Cargo';
import { Archetype, CitySite, Recipe } from './Economy';
import { buildTown, buildStation } from './Buildings';

export const STOCK_CAP = 90; // a city can only stockpile so much waiting freight
const LOAD_PER_STOP = 40; // units a train can take on in one berth
export const TRACK_COST_PER_UNIT = 95; // $ per world-unit of rail
const TRAIN_COST = 42000;

export interface GStation {
  id: number;
  name: string;
  archetype: Archetype;
  pos: THREE.Vector3;
  /** Raw extraction rates (units/sec), catchment-scaled. */
  supplies: Partial<Record<CargoKind, number>>;
  /** Everything it pays to receive — final consumption plus any recipe inputs. */
  demands: Set<CargoKind>;
  /** Outbound: produced/extracted cargo waiting to be hauled away. */
  stock: Map<CargoKind, number>;
  /** Inbound: delivered raw materials waiting to be processed (processors only). */
  input: Map<CargoKind, number>;
  recipe?: Recipe;
}

export interface GLine {
  a: GStation;
  b: GStation;
  track: Track;
  train: Train;
}

export interface Delivery {
  text: string;
  amount: number;
}

/**
 * The economic engine and bookkeeper. It owns the stations, the rail lines built
 * between them, and the trains running those lines; it accrues each city's production
 * into waiting stock, settles deliveries into cash, and ticks the calendar. The
 * builder UI and HUD read and drive it but hold no game state of their own.
 */
export class Network {
  readonly stations: GStation[] = [];
  readonly lines: GLine[] = [];
  money = 850_000;
  year = 1862;
  private yearAccum = 0;
  /** Newest first; the HUD shows the head of this list. */
  readonly deliveries: Delivery[] = [];

  constructor(private scene: THREE.Scene, private field: Heightfield, private seed: number) {}

  /** Build the economic node + its town/depot visuals from a generated site. */
  addStation(site: CitySite): GStation {
    const pos = site.pos.clone();
    pos.y = this.field.height(pos.x, pos.z);

    const recipe = site.archetype.recipe;
    const demands = new Set<CargoKind>(site.archetype.demands);
    if (recipe) for (const k of Object.keys(recipe.inputs) as CargoKind[]) demands.add(k);

    const st: GStation = {
      id: this.stations.length,
      name: site.name,
      archetype: site.archetype,
      pos,
      supplies: site.supplies,
      demands,
      stock: new Map(),
      input: new Map(),
      recipe,
    };
    this.stations.push(st);

    const town = buildTown(this.seed + st.id * 131, site.archetype.houses);
    town.position.copy(pos);
    this.scene.add(town);

    const depot = buildStation();
    depot.position.set(pos.x + 16, this.field.height(pos.x + 16, pos.z), pos.z);
    depot.rotation.y = Math.atan2(pos.x - depot.position.x, pos.z - depot.position.z);
    this.scene.add(depot);

    return st;
  }

  nearestStation(point: THREE.Vector3, maxDist: number): GStation | null {
    let best: GStation | null = null;
    let bd = maxDist;
    for (const s of this.stations) {
      const d = Math.hypot(s.pos.x - point.x, s.pos.z - point.z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  /** Are two stations already joined by a line (either direction)? */
  isConnected(a: GStation, b: GStation): boolean {
    return this.lines.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  }

  /** Quoted cost of a route through the given ground waypoints. */
  routeCost(points: THREE.Vector3[]): number {
    let len = 0;
    for (let i = 1; i < points.length; i++) len += points[i - 1].distanceTo(points[i]);
    return Math.round(len * TRACK_COST_PER_UNIT + TRAIN_COST);
  }

  /**
   * Commit a line between two stations through the given intermediate waypoints.
   * Deducts cost, lays the Track, and puts a train on it. Returns false (building
   * nothing) if the player can't afford it.
   */
  buildLine(a: GStation, mids: THREE.Vector3[], b: GStation): boolean {
    const waypoints = [a.pos.clone(), ...mids.map((m) => m.clone()), b.pos.clone()];
    const cost = this.routeCost(waypoints);
    if (cost > this.money) return false;
    this.money -= cost;

    const track = new Track(this.field, waypoints);
    this.scene.add(track.group);
    const train = new Train(track, this.scene);
    this.scene.add(train.group);

    const line: GLine = { a, b, track, train };
    train.onArrive = (end) => this.serviceTrain(line, end === 0 ? a : b);
    this.lines.push(line);
    return true;
  }

  /** Unload anything the berth demands (paying for the haul), then load what it offers. */
  private serviceTrain(line: GLine, at: GStation): void {
    const train = line.train;

    for (const [kind, lot] of [...train.cargo]) {
      if (!at.demands.has(kind)) continue;
      const dist = lot.originPos.distanceTo(at.pos);
      const rev = haulRevenue(kind, lot.amount, dist);
      this.money += rev;
      this.pushDelivery(`${Math.floor(lot.amount)} ${kind} → ${at.name}`, rev);
      // Raw delivered to a processor feeds its input inventory; anything else is
      // consumed on arrival. Either way the haul is paid.
      if (at.recipe && kind in at.recipe.inputs) {
        at.input.set(kind, Math.min(STOCK_CAP, (at.input.get(kind) ?? 0) + lot.amount));
      }
      train.cargo.delete(kind);
    }

    for (const kind of Object.keys(at.supplies) as CargoKind[]) {
      const free = train.cargoFree();
      if (free <= 0) break;
      const have = at.stock.get(kind) ?? 0;
      const take = Math.min(have, free, LOAD_PER_STOP);
      if (take < 1) continue;
      at.stock.set(kind, have - take);
      const lot = train.cargo.get(kind);
      if (lot) lot.amount += take;
      else train.cargo.set(kind, { amount: take, originPos: at.pos.clone() });
    }

    train.refreshLivery();
  }

  /** Run a processor's recipe for one tick: make as many output units as inputs and
   *  stockpile room allow, consuming the inputs proportionally. */
  private process(s: GStation, dt: number): void {
    const rc = s.recipe!;
    let batch = rc.rate * dt;
    for (const k of Object.keys(rc.inputs) as CargoKind[]) {
      batch = Math.min(batch, (s.input.get(k) ?? 0) / rc.inputs[k]!);
    }
    batch = Math.min(batch, STOCK_CAP - (s.stock.get(rc.output) ?? 0));
    if (batch <= 0) return;
    for (const k of Object.keys(rc.inputs) as CargoKind[]) {
      s.input.set(k, (s.input.get(k) ?? 0) - rc.inputs[k]! * batch);
    }
    s.stock.set(rc.output, (s.stock.get(rc.output) ?? 0) + batch);
  }

  private pushDelivery(text: string, amount: number): void {
    this.deliveries.unshift({ text, amount });
    if (this.deliveries.length > 6) this.deliveries.pop();
  }

  update(dt: number): void {
    for (const s of this.stations) {
      // Raw extraction accrues as outbound stock, capped so it can't pile up forever.
      for (const kind of Object.keys(s.supplies) as CargoKind[]) {
        const cur = s.stock.get(kind) ?? 0;
        if (cur < STOCK_CAP) s.stock.set(kind, Math.min(STOCK_CAP, cur + s.supplies[kind]! * dt));
      }
      // Processors convert input inventory into finished goods, throttled by whichever
      // input is scarcest and by room left in the output stockpile.
      if (s.recipe) this.process(s, dt);
    }
    for (const l of this.lines) l.train.update(dt);

    this.yearAccum += dt;
    if (this.yearAccum >= 22) {
      this.yearAccum -= 22;
      this.year += 1;
    }
  }
}
