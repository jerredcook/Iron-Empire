import * as THREE from 'three';
import { Heightfield } from '../world/Heightfield';
import { Track } from './Track';
import { Train } from './Train';
import { CargoKind, haulRevenue } from './Cargo';
import { Archetype, CitySite, Recipe } from './Economy';
import { buildTown, buildStation } from './Buildings';
import { LocoClass, defaultLoco, LOCOS } from './Locomotives';

export const STOCK_CAP = 90; // a city can only stockpile so much waiting freight
const LOAD_PER_STOP = 40; // units a train can take on in one berth
export const TRACK_COST_PER_UNIT = 95; // $ per world-unit of rail
const SAVE_KEY = 'ironempire.save.v1';
const SECONDS_PER_YEAR = 22; // calendar pace
const DEBT_LIMIT = -120_000; // cash below this and the railroad is bankrupt
const INTEREST_RATE = 0.07; // annual interest on outstanding bonds
const SERVE_FULL = 55; // banked service that yields full prosperity
const GROWTH_TIERS = [1.55, 2.05, 2.55]; // growth thresholds that add a house ring

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
  /** Prosperity multiplier (1..~3): rises with sustained service, scaling output. */
  growth: number;
  /** Decaying tally of demanded cargo recently received — drives growth. */
  served: number;
  /** How many outer house rings have been added (growth milestones reached). */
  tier: number;
}

export interface GLine {
  /** Ordered stations the corridor serves (≥2); a/b are its ends. */
  stops: GStation[];
  a: GStation;
  b: GStation;
  track: Track;
  /** Arc-length fraction (0..1) of each stop along the track. */
  stopFracs: number[];
  /** One or more trains shuttling the corridor — add more for throughput. */
  trains: Train[];
  owner: Company;
  /** The full ground route through every stop, kept so the line can be re-laid on load. */
  waypoints: THREE.Vector3[];
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
const SHARES_OUTSTANDING = 100_000; // per company

export class Company {
  money: number;
  debt = 0;
  readonly lines: GLine[] = [];
  readonly shares = SHARES_OUTSTANDING;
  /** Shares this company holds in others (an investable asset / path to takeover). */
  readonly holdings = new Map<Company, number>();
  /** Set when absorbed by a takeover. */
  defunct = false;
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

  /** Cash plus fleet salvage minus debt — the operating value that backs the share
   *  price (deliberately excludes the share portfolio so prices can't feed back). */
  get assetWorth(): number {
    let w = this.money - this.debt;
    for (const l of this.lines) for (const t of l.trains) w += t.locoClass.cost * 0.5;
    return w;
  }

  /** Market value of one share. */
  get sharePrice(): number {
    return Math.max(1, this.assetWorth / this.shares);
  }

  /** Value of shares held in other companies. */
  get portfolioValue(): number {
    let v = 0;
    for (const [co, qty] of this.holdings) v += qty * co.sharePrice;
    return v;
  }

  /** Total worth the objective is judged on: operating value plus investments. */
  get netWorth(): number {
    return this.assetWorth + this.portfolioValue;
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

  /** Has this company already joined these two cities on one corridor? */
  connects(a: GStation, b: GStation): boolean {
    return this.lines.some((l) => l.stops.includes(a) && l.stops.includes(b));
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
  /** Fired when the player earns a delivery / completes a build (for audio). */
  onRevenue?: (amount: number) => void;
  onBuilt?: () => void;

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

  // ---- Persistence -------------------------------------------------------

  static hasSave(): boolean {
    try {
      return !!localStorage.getItem(SAVE_KEY);
    } catch {
      return false;
    }
  }

  /** Snapshot the dynamic game state. Cities are deterministic from the seed, so only
   *  their changing stock/prosperity is stored; lines store their route + roster. */
  save(): void {
    const ci = (c: Company): number => this.companies.indexOf(c);
    const data = {
      year: this.year,
      status: this.status,
      companies: this.companies.map((c) => ({
        money: c.money,
        debt: c.debt,
        defunct: c.defunct,
        holdings: [...c.holdings].map(([co, q]) => [ci(co), q]),
      })),
      stations: this.stations.map((s) => ({
        stock: [...s.stock],
        input: [...s.input],
        served: s.served,
        tier: s.tier,
      })),
      lines: this.lines.map((l) => ({
        owner: ci(l.owner),
        stops: l.stops.map((s) => s.id),
        wp: l.waypoints.map((p) => [Math.round(p.x), Math.round(p.z)]),
        locos: l.trains.map((t) => t.locoClass.id),
      })),
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable — ignore */
    }
  }

  /** Restore a saved game over a freshly generated world (same seed). */
  loadFromStorage(): boolean {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch {
      return false;
    }
    if (!raw) return false;
    const data = JSON.parse(raw);

    this.year = data.year;
    this.status = data.status ?? 'playing';
    this.clearLines();

    this.companies.forEach((c, i) => {
      const cd = data.companies[i];
      if (!cd) return;
      c.money = cd.money;
      c.debt = cd.debt;
      c.defunct = cd.defunct;
      c.holdings.clear();
    });
    // Holdings reference other companies, so wire them after all exist.
    this.companies.forEach((c, i) => {
      for (const [idx, q] of data.companies[i]?.holdings ?? []) c.holdings.set(this.companies[idx], q);
    });

    this.stations.forEach((s, i) => {
      const sd = data.stations[i];
      if (!sd) return;
      s.stock = new Map(sd.stock);
      s.input = new Map(sd.input);
      s.served = sd.served ?? 0;
      s.tier = 0; // re-grown below so the house rings reappear
      s.growth = 1 + Math.min(2, s.served / SERVE_FULL);
      this.maybeGrowCity(s);
    });

    for (const ld of data.lines) {
      const stops = (ld.stops as number[]).map((id) => this.stations[id]);
      const owner = this.companies[ld.owner];
      if (stops.some((s) => !s) || !owner) continue;
      const wp: THREE.Vector3[] = ld.wp.map((p: [number, number]) => new THREE.Vector3(p[0], this.field.height(p[0], p[1]), p[1]));
      const locos = (ld.locos as string[]).map((id) => LOCOS.find((l) => l.id === id) ?? defaultLoco(this.year));
      this.layLine(owner, stops, wp, locos);
    }
    return true;
  }

  /** Tear down every line (meshes + trains) — used before restoring a save. */
  private clearLines(): void {
    for (const l of this.lines) {
      this.scene.remove(l.track.group);
      for (const t of l.trains) this.scene.remove(t.group);
    }
    this.lines.length = 0;
    for (const c of this.companies) c.lines.length = 0;
  }

  /** Player's stake in a company, 0..1. */
  stake(target: Company): number {
    return (this.player.holdings.get(target) ?? 0) / target.shares;
  }

  /** Player buys shares of a company; crossing 50% triggers a takeover. */
  buyShares(target: Company, qty: number): boolean {
    if (target.defunct || qty <= 0) return false;
    const cost = qty * target.sharePrice;
    if (cost > this.player.money) return false;
    this.player.money -= cost;
    this.player.holdings.set(target, (this.player.holdings.get(target) ?? 0) + qty);
    if (target !== this.player && this.stake(target) > 0.5) this.takeover(this.player, target);
    return true;
  }

  /** Player sells shares back to the market at the current price. */
  sellShares(target: Company, qty: number): boolean {
    const held = this.player.holdings.get(target) ?? 0;
    const q = Math.min(qty, held);
    if (q <= 0) return false;
    this.player.money += q * target.sharePrice;
    this.player.holdings.set(target, held - q);
    return true;
  }

  /** Absorb a company: its lines and cash transfer to the acquirer; it goes defunct. */
  private takeover(buyer: Company, target: Company): void {
    for (const l of target.lines) {
      l.owner = buyer;
      buyer.lines.push(l);
    }
    target.lines.length = 0;
    buyer.money += target.money;
    target.money = 0;
    target.defunct = true;
    buyer.holdings.delete(target);
    this.pushDelivery(`Acquired ${target.name}`, 0);
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
      growth: 1,
      served: 0,
      tier: 0,
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

  /** Are two stations already joined on some corridor? */
  isConnected(a: GStation, b: GStation): boolean {
    return this.lines.some((l) => l.stops.includes(a) && l.stops.includes(b));
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
  buildLine(stops: GStation[], segMids: THREE.Vector3[][], loco: LocoClass): boolean {
    return this.buildLineFor(this.player, stops, segMids, loco);
  }

  /** Assemble the full ground route from an ordered stop list and the grade points
   *  dropped between each consecutive pair. */
  private routeWaypoints(stops: GStation[], segMids: THREE.Vector3[][]): THREE.Vector3[] {
    const wp: THREE.Vector3[] = [];
    for (let i = 0; i < stops.length; i++) {
      wp.push(stops[i].pos.clone());
      if (i < stops.length - 1) for (const m of segMids[i] ?? []) wp.push(m.clone());
    }
    return wp;
  }

  /** Commit a corridor owned by the given company (charges its treasury). */
  buildLineFor(owner: Company, stops: GStation[], segMids: THREE.Vector3[][], loco: LocoClass): boolean {
    if (stops.length < 2) return false;
    const waypoints = this.routeWaypoints(stops, segMids);
    const cost = this.lineCost(waypoints, loco);
    if (cost > owner.money) return false;
    owner.money -= cost;
    this.layLine(owner, stops, waypoints, [loco]);
    if (owner === this.player) this.onBuilt?.();
    return true;
  }

  /** Lay the rails + trains for a corridor without charging — shared by build and load. */
  private layLine(owner: Company, stops: GStation[], waypoints: THREE.Vector3[], locos: LocoClass[]): GLine {
    const track = new Track(this.field, waypoints);
    this.scene.add(track.group);
    const stopFracs = stops.map((s) => track.nearestU(s.pos));
    const line: GLine = { stops, a: stops[0], b: stops[stops.length - 1], track, stopFracs, trains: [], owner, waypoints };
    this.lines.push(line);
    owner.lines.push(line);
    for (const loco of locos) this.spawnTrain(line, loco);
    return line;
  }

  /** Buy and place an additional train on an existing line for more throughput. */
  addTrain(line: GLine, loco: LocoClass): boolean {
    if (loco.cost > line.owner.money) return false;
    line.owner.money -= loco.cost;
    this.spawnTrain(line, loco);
    return true;
  }

  /** Put a train on a line, staggered so multiple trains don't ride on top of one
   *  another, and wire its stop servicing to the line's owner. */
  private spawnTrain(line: GLine, loco: LocoClass): void {
    const train = new Train(line.track, this.scene, loco, line.stopFracs);
    train.offsetStart(line.trains.length * 0.28);
    this.scene.add(train.group);
    train.onStop = (i) => this.serviceTrain(line.owner, train, line.stops[i]);
    line.trains.push(train);
  }

  /** Unload anything the berth demands (paying the owner for the haul), then load. */
  private serviceTrain(owner: Company, train: Train, at: GStation): void {
    for (const [kind, lot] of [...train.cargo]) {
      if (!at.demands.has(kind)) continue;
      const dist = lot.originPos.distanceTo(at.pos);
      const rev = haulRevenue(kind, lot.amount, dist);
      owner.money += rev;
      if (!owner.isAI) {
        this.pushDelivery(`${Math.floor(lot.amount)} ${kind} → ${at.name}`, rev);
        this.onRevenue?.(rev);
      }
      // Raw delivered to a processor feeds its input inventory; anything else is
      // consumed on arrival (and feeds the city's prosperity). Either way it's paid.
      if (at.recipe && kind in at.recipe.inputs) {
        at.input.set(kind, Math.min(STOCK_CAP, (at.input.get(kind) ?? 0) + lot.amount));
      } else {
        at.served += lot.amount;
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

  /** Add an outer ring of houses each time a city crosses a growth milestone. */
  private maybeGrowCity(s: GStation): void {
    while (s.tier < GROWTH_TIERS.length && s.growth >= GROWTH_TIERS[s.tier]) {
      const t = s.tier;
      const ring = buildTown(this.seed + s.id * 131 + (t + 1) * 7919, 5 + t, 50 + t * 16, 64 + t * 16);
      ring.position.copy(s.pos);
      this.scene.add(ring);
      s.tier++;
    }
  }

  private pushDelivery(text: string, amount: number): void {
    this.deliveries.unshift({ text, amount });
    if (this.deliveries.length > 6) this.deliveries.pop();
  }

  update(dt: number): void {
    if (this.status !== 'playing') return;

    for (const s of this.stations) {
      // Prosperity decays without service and is recomputed into a 1..3 multiplier.
      s.served = Math.max(0, s.served - s.served * 0.05 * dt);
      s.growth = 1 + Math.min(2, s.served / SERVE_FULL);
      this.maybeGrowCity(s);

      // Extraction (scaled by prosperity) accrues as outbound stock, capped.
      for (const kind of Object.keys(s.supplies) as CargoKind[]) {
        const cur = s.stock.get(kind) ?? 0;
        if (cur < STOCK_CAP) s.stock.set(kind, Math.min(STOCK_CAP, cur + s.supplies[kind]! * s.growth * dt));
      }
      // Processors convert input inventory into finished goods, throttled by whichever
      // input is scarcest and by room left in the output stockpile.
      if (s.recipe) this.process(s, dt);
    }
    for (const l of this.lines) for (const t of l.trains) t.update(dt);

    // Maintenance and bond interest bleed every company's books continuously.
    for (const c of this.companies) {
      c.money -= ((c.upkeepPerYear + c.interestPerYear) / SECONDS_PER_YEAR) * dt;
      if (c.isAI && !c.defunct) this.planAI(c, dt);
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
    if (best) this.buildLineFor(c, [best.a, best.b], [[]], loco);
  }
}
