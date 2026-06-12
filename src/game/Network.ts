import * as THREE from 'three';
import { Heightfield } from '../world/Heightfield';
import { Track } from './Track';
import { Train } from './Train';
import { CargoKind, haulRevenue } from './Cargo';
import { Archetype, CitySite, Recipe } from './Economy';
import { buildTown, buildStation } from './Buildings';
import { LocoClass, defaultLoco } from './Locomotives';

export const STOCK_CAP = 90; // a city can only stockpile so much waiting freight
const LOAD_PER_STOP = 40; // units a train can take on in one berth
export const TRACK_COST_PER_UNIT = 95; // $ per world-unit of rail
const SECONDS_PER_YEAR = 22; // calendar pace
const DEBT_LIMIT = -120_000; // cash below this and the railroad is bankrupt
const INTEREST_RATE = 0.07; // annual interest on outstanding bonds

export type GameStatus = 'playing' | 'won' | 'lost';

export interface Goal {
  targetCash: number;
  byYear: number;
}

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
  /** One or more trains shuttling the line — add more for throughput. */
  trains: Train[];
  owner: Company;
}

export interface Delivery {
  text: string;
  amount: number;
}

/**
 * A railroad operator with its own treasury, debt, and roster of lines — the player is
 * one, each rival tycoon another. They share the world's cities (and so compete for the
 * same waiting cargo), but their books are separate.
 */
export class Company {
  money: number;
  debt = 0;
  readonly lines: GLine[] = [];
  /** AI build cadence accumulator. */
  aiTimer = 4;

  constructor(
    readonly name: string,
    readonly color: number,
    readonly isAI: boolean,
    startMoney: number
  ) {
    this.money = startMoney;
  }

  /** Cash plus fleet salvage minus debt. */
  get netWorth(): number {
    let w = this.money - this.debt;
    for (const l of this.lines) for (const t of l.trains) w += t.locoClass.cost * 0.5;
    return w;
  }

  get upkeepPerYear(): number {
    let u = 0;
    for (const l of this.lines) for (const t of l.trains) u += t.locoClass.upkeep;
    return u;
  }

  get interestPerYear(): number {
    return this.debt * INTEREST_RATE;
  }

  get creditLimit(): number {
    return Math.max(0, Math.round(this.netWorth * 1.5 + 300_000 - this.debt));
  }

  issueBond(amount: number): boolean {
    if (amount <= 0 || amount > this.creditLimit) return false;
    this.money += amount;
    this.debt += amount;
    return true;
  }

  repayDebt(amount: number): boolean {
    const pay = Math.min(amount, this.debt, this.money);
    if (pay <= 0) return false;
    this.money -= pay;
    this.debt -= pay;
    return true;
  }

  /** Has this company already joined these two cities? */
  connects(a: GStation, b: GStation): boolean {
    return this.lines.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  }
}

/**
 * The economic engine and bookkeeper. It owns the stations, the rail lines built
 * between them, and the trains running those lines; it accrues each city's production
 * into waiting stock, settles deliveries into cash, and ticks the calendar. The
 * builder UI and HUD read and drive it but hold no game state of their own.
 */
export class Network {
  readonly stations: GStation[] = [];
  /** Every line in the world, both companies'. */
  readonly lines: GLine[] = [];
  readonly player = new Company('Iron Empire', 0x8fffa8, false, 850_000);
  readonly rival = new Company('Atlas & Pacific', 0xff8a4d, true, 850_000);
  readonly companies = [this.player, this.rival];
  year = 1862;
  status: GameStatus = 'playing';
  readonly goal: Goal = { targetCash: 2_500_000, byYear: 1890 };
  private yearAccum = 0;
  /** Newest first; the HUD shows the head of this list. */
  readonly deliveries: Delivery[] = [];

  constructor(private scene: THREE.Scene, private field: Heightfield, private seed: number) {}

  // The HUD/builder talk to "the railroad" — i.e. the player company.
  get money(): number {
    return this.player.money;
  }
  get debt(): number {
    return this.player.debt;
  }
  get netWorth(): number {
    return this.player.netWorth;
  }
  get upkeepPerYear(): number {
    return this.player.upkeepPerYear;
  }
  get interestPerYear(): number {
    return this.player.interestPerYear;
  }
  get creditLimit(): number {
    return this.player.creditLimit;
  }
  issueBond(amount: number): boolean {
    return this.player.issueBond(amount);
  }
  repayDebt(amount: number): boolean {
    return this.player.repayDebt(amount);
  }

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

  /** Grading cost of a route through the given ground waypoints (track only). */
  routeCost(points: THREE.Vector3[]): number {
    let len = 0;
    for (let i = 1; i < points.length; i++) len += points[i - 1].distanceTo(points[i]);
    return Math.round(len * TRACK_COST_PER_UNIT);
  }

  /** Full quote for a line: grading the route plus the chosen locomotive. */
  lineCost(points: THREE.Vector3[], loco: LocoClass): number {
    return this.routeCost(points) + loco.cost;
  }

  /**
   * Commit a line between two stations through the given intermediate waypoints,
   * staffed by the chosen locomotive. Deducts cost, lays the Track, and puts a train
   * on it. Returns false (building nothing) if the player can't afford it.
   */
  buildLine(a: GStation, mids: THREE.Vector3[], b: GStation, loco: LocoClass): boolean {
    return this.buildLineFor(this.player, a, mids, b, loco);
  }

  /** Commit a line owned by the given company. */
  buildLineFor(owner: Company, a: GStation, mids: THREE.Vector3[], b: GStation, loco: LocoClass): boolean {
    const waypoints = [a.pos.clone(), ...mids.map((m) => m.clone()), b.pos.clone()];
    const cost = this.lineCost(waypoints, loco);
    if (cost > owner.money) return false;
    owner.money -= cost;

    const track = new Track(this.field, waypoints);
    this.scene.add(track.group);

    const line: GLine = { a, b, track, trains: [], owner };
    this.lines.push(line);
    owner.lines.push(line);
    this.spawnTrain(line, loco);
    return true;
  }

  /** Buy and place an additional train on an existing line for more throughput. */
  addTrain(line: GLine, loco: LocoClass): boolean {
    if (loco.cost > line.owner.money) return false;
    line.owner.money -= loco.cost;
    this.spawnTrain(line, loco);
    return true;
  }

  /** Put a train on a line, staggered so multiple trains don't ride on top of one
   *  another, and wire its berth servicing to the line's owner. */
  private spawnTrain(line: GLine, loco: LocoClass): void {
    const train = new Train(line.track, this.scene, loco);
    train.offsetStart(line.trains.length * 0.28);
    this.scene.add(train.group);
    train.onArrive = (end) => this.serviceTrain(line.owner, train, end === 0 ? line.a : line.b);
    line.trains.push(train);
  }

  /** Unload anything the berth demands (paying the owner for the haul), then load. */
  private serviceTrain(owner: Company, train: Train, at: GStation): void {
    for (const [kind, lot] of [...train.cargo]) {
      if (!at.demands.has(kind)) continue;
      const dist = lot.originPos.distanceTo(at.pos);
      const rev = haulRevenue(kind, lot.amount, dist);
      owner.money += rev;
      if (!owner.isAI) this.pushDelivery(`${Math.floor(lot.amount)} ${kind} → ${at.name}`, rev);
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
    if (this.status !== 'playing') return;

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
    for (const l of this.lines) for (const t of l.trains) t.update(dt);

    // Maintenance and bond interest bleed every company's books continuously.
    for (const c of this.companies) {
      c.money -= ((c.upkeepPerYear + c.interestPerYear) / SECONDS_PER_YEAR) * dt;
      if (c.isAI) this.planAI(c, dt);
    }

    this.yearAccum += dt;
    if (this.yearAccum >= SECONDS_PER_YEAR) {
      this.yearAccum -= SECONDS_PER_YEAR;
      this.year += 1;
    }

    // Resolve the player's objective.
    if (this.player.money < DEBT_LIMIT) this.status = 'lost';
    else if (this.player.netWorth >= this.goal.targetCash) this.status = 'won';
    else if (this.year > this.goal.byYear) this.status = 'lost';
  }

  /** What a station puts on the market: raw extraction plus any processed output. */
  private offersOf(s: GStation): CargoKind[] {
    const out = Object.keys(s.supplies) as CargoKind[];
    if (s.recipe) out.push(s.recipe.output);
    return out;
  }

  /**
   * A rival's turn: every few seconds, if it has comfortable cash and room to grow,
   * connect the cheapest unbuilt city pair that would actually trade. Crude, but it
   * spreads a competing network that races the player for the same waiting cargo.
   */
  private planAI(c: Company, dt: number): void {
    c.aiTimer -= dt;
    if (c.aiTimer > 0 || c.lines.length >= 7) return;
    c.aiTimer = 6;

    const loco = defaultLoco(this.year);
    const reserve = 160_000;
    let best: { a: GStation; b: GStation; cost: number } | null = null;
    for (let i = 0; i < this.stations.length; i++) {
      for (let j = i + 1; j < this.stations.length; j++) {
        const a = this.stations[i];
        const b = this.stations[j];
        if (c.connects(a, b)) continue;
        const trades =
          this.offersOf(a).some((k) => b.demands.has(k)) || this.offersOf(b).some((k) => a.demands.has(k));
        if (!trades) continue;
        const cost = this.lineCost([a.pos, b.pos], loco);
        if (cost > c.money - reserve) continue;
        if (!best || cost < best.cost) best = { a, b, cost };
      }
    }
    if (best) this.buildLineFor(c, best.a, [], best.b, loco);
  }
}
