import * as THREE from 'three';
import { Heightfield } from '../world/Heightfield';
import { Track, TRACK_SIDE } from './Track';
import { Train, CAR_CAP } from './Train';
import { CargoKind, CARGO, ALL_CARGO, haulRevenue, marketMult, carCapacity } from './Cargo';
import { Archetype, CitySite, Recipe, ARCHETYPES, STAGES, STAGE_DEMANDS } from './Economy';
import { buildTown, buildStation, buildFactory, buildStationStructure } from './Buildings';
import { LocoClass, defaultLoco, LOCOS } from './Locomotives';
import { StationBuilding, STATION_BUILDINGS, STATION_BUILDING_ORDER } from './Depot';

export const STOCK_CAP = 120; // a city can only stockpile so much waiting freight
const LOAD_PER_STOP = 80; // units a train can take on in one berth
export const TRACK_COST_PER_UNIT = 95; // $ per world-unit of rail
const SAVE_KEY = 'ironempire.save.v1';
const SECONDS_PER_YEAR = 40; // calendar pace — slow enough that a route runs many trips/year
const DEBT_LIMIT = -120_000; // cash below this and the railroad is bankrupt
const INTEREST_RATE = 0.07; // annual interest on outstanding bonds
const DIVIDEND_RATE = 0.05; // share of operating value paid out to holders each year
const INDUSTRY_ROYALTY = 9; // $/unit the industry's owner earns on shipped output
const STATION_BONUS = 0.18; // extra haul revenue per depot upgrade level
const STATION_COST = 70_000; // price to build a depot at a city
const DOUBLE_TRACK_GAP = 9; // lateral spacing when a line is laid alongside one it duplicates
const PLATFORM_GAP = 7.5; // spacing between a station's parallel platform tracks
const PLATFORM_LEN = 24; // how long the parallel platform run is before the berth
const TOWN_CLEAR = 15; // keep town houses this far off the rails (they relocate clear)
const DEPOT_CLEAR = 19; // and this far from a depot building, so the station isn't crowded

/** Distance from point p to segment a→b in the XZ plane. */
function pointSegDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  let s = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  return Math.hypot(p.x - (a.x + s * dx), p.z - (a.z + s * dz));
}
const CATCHMENT_RADIUS = 380; // a depot gathers cargo from towns within this range
const MAX_STATION_LEVEL = 3;
const SERVE_FULL = 55; // banked service that yields full prosperity
const GROWTH_TIERS = [1.55, 2.05, 2.55]; // growth thresholds that add a house ring
const SAT_PER_UNIT = 0.0055; // market saturation added per delivered unit (a ~80-unit drop ≈ +0.44)
const SAT_RECOVERY = 0.02; // saturation shed per second while a market goes unfed (~full in 30s)
// Station maintenance-building effects.
const POSTOFFICE_MULT = 1.3; // mail & passenger revenue bonus at a post office
const HOTEL_MULT = 1.3; // passenger revenue bonus at a hotel
const WAREHOUSE_STOCK = 1.6; // stockpile-cap multiplier at a warehouse
const WAREHOUSE_LOAD = 1.5; // loading-throughput multiplier at a warehouse
const HOTEL_GROWTH = 1.5; // prosperity accrual multiplier on passenger deliveries at a hotel
const FIRST_CONNECT_BASE = 15_000; // flat grant for joining two cities for the first time
const FIRST_CONNECT_PER_UNIT = 40; // plus this much per world-unit of distance between them
const CONTRACT_FIRST_DELAY = 1.5 * SECONDS_PER_YEAR; // before the first job is posted
const CONTRACT_INTERVAL = 2.5 * SECONDS_PER_YEAR; // cadence of new postings (up to the cap)
const CONTRACT_MAX_OFFERED = 3; // jobs sitting on the board at once
const CONTRACT_MAX_ACTIVE = 3; // jobs the player can have under way at once
const CONTRACT_REWARD_FACTOR = 3.2; // premium over an ordinary haul of the same cargo
const WASHOUT_DURATION = 3 * SECONDS_PER_YEAR; // sim-seconds a washout takes to rebuild itself
const WASHOUT_REPAIR_MIN = 25_000; // cheapest emergency repair to reopen a line at once
const WASHOUT_REPAIR_FRAC = 0.12; // …or this share of the line's grading value, whichever is more

export type GameStatus = 'playing' | 'won' | 'lost';
export type Medal = 'gold' | 'silver' | 'bronze' | 'none';
const SILVER_MULT = 1.6; // silver net-worth threshold = target × this
const GOLD_MULT = 2.5; // gold net-worth threshold = target × this

/** What the player is playing toward. The same gold/silver/bronze tiering applies to
 *  every kind — only the measured quantity differs. */
export type ObjectiveKind = 'networth' | 'cargo' | 'connect' | 'contracts';
export interface Goal {
  kind: ObjectiveKind;
  byYear: number;
  /** Tier thresholds in the objective's own units ($, cargo units, cities, jobs). */
  bronze: number;
  silver: number;
  gold: number;
  /** The cargo to haul, for kind === 'cargo'. */
  cargo?: CargoKind;
}

/** Build a classic net-worth objective (bronze = target, silver/gold scaled above it). */
export function networthGoal(targetCash: number, byYear: number): Goal {
  return { kind: 'networth', byYear, bronze: targetCash, silver: targetCash * SILVER_MULT, gold: targetCash * GOLD_MULT };
}

/** Difficulty knobs the Network actually consumes (structurally a Scenarios.Difficulty). */
export interface DifficultyParams {
  id: string;
  playerMult: number;
  aiMult: number;
  aiInterval: number;
  aiReserve: number;
}

export interface CompanySetup {
  name: string;
  color: number;
}

export interface NetworkConfig {
  startMoney: number;
  year: number;
  cities: number;
  goal: Goal;
  difficulty: DifficultyParams;
  /** The player's railroad identity. */
  player: CompanySetup;
  /** The AI railroads (0–3), in order. */
  ais: CompanySetup[];
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
  /** Per-cargo market saturation (0 fresh … 1 glutted): rises as a cargo is delivered
   *  here, recovers while the market goes unfed, and depresses the price paid. */
  sat: Map<CargoKind, number>;
  /** Inbound: delivered raw materials waiting to be processed (processors only). */
  input: Map<CargoKind, number>;
  recipe?: Recipe;
  /** Prosperity multiplier (1..~3): rises with sustained service, scaling output. */
  growth: number;
  /** Decaying tally of demanded cargo recently received — drives growth. */
  served: number;
  /** How many outer house rings have been added (growth milestones reached). */
  tier: number;
  /** The company that owns this city's industry (earns a royalty on its output), or null. */
  owner: Company | null;
  /** Appraised value of the owned industry — counts toward the owner's net worth. */
  bookValue: number;
  /** Depot upgrade level (0–3): each level adds a haul-revenue bonus here. */
  level: number;
  /** Cumulative revenue earned from deliveries to this station. */
  revenue: number;
  /** Whether the PLAYER has built a depot here (convenience mirror of depots.has(player)). */
  hasStation: boolean;
  /** Every company's own depot at this city — each railroad builds and uses its own; a line
   *  can only stop here if its owner has one. Industries, catchment + stock are city-shared. */
  depots: Map<Company, GDepot>;
  /** Holds the town's house-ring meshes; rebuilt to keep houses off freshly-laid track. */
  townGroup: THREE.Group;
  /** Nearby depot-less cities this station gathers cargo from (its catchment). */
  catchment: GStation[];
  /** Maintenance buildings bought at this depot (roundhouse, warehouse, …). */
  buildings: Set<StationBuilding>;
  /** Settlement growth stage (0 Hamlet … 3 Metropolis) — rises with sustained service
   *  and unlocks new cargo demands. Starts at the archetype's base size. */
  stage: number;
}

/** One company's depot building at a city. */
export interface GDepot {
  owner: Company;
  mesh: THREE.Object3D;
  /** True once it's been sat beside its owner's serving line's rails. */
  aligned: boolean;
}

export interface GLine {
  /** Ordered city stops the line serves (0+). Track can exist with fewer than 2. */
  stops: GStation[];
  track: Track;
  /** Arc-length fraction (0..1) of each stop along the track. */
  stopFracs: number[];
  /** One or more trains shuttling the corridor — add more for throughput. */
  trains: Train[];
  owner: Company;
  /** Grading cost of the route — its value as infrastructure. */
  value: number;
  /** Cumulative haul revenue booked by this line's trains — the income half of its P/L. */
  earned: number;
  /** Completed service stops (legs) — earned ÷ trips gives revenue per trip. */
  trips: number;
  /** Sim-clock reading when the line was laid — used to annualize earnings. */
  bornClock: number;
  /** The full ground route through every stop, kept so the line can be re-laid on load. */
  waypoints: THREE.Vector3[];
  /** A through-service rides existing rails (movement-only track) — no new visuals. */
  through: boolean;
  /** Sim-clock time a washout clears (0 = open). While clock < this, trains are halted. */
  blockedUntil: number;
}

/** A time-limited haul contract: deliver `quantity` of `cargo` to `station` by
 *  `deadlineYear` for a `reward`. Offered on the board, then accepted and worked. */
export interface Contract {
  id: number;
  station: GStation;
  cargo: CargoKind;
  quantity: number;
  delivered: number;
  reward: number;
  deadlineYear: number;
  status: 'offered' | 'active' | 'done' | 'failed';
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
  /** Industries (city factories/resources) this company owns. */
  readonly industries: GStation[] = [];
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
    // Rail infrastructure and rolling stock are assets — building shouldn't sink worth.
    for (const l of this.lines) {
      w += l.value * 0.8;
      for (const t of l.trains) w += t.locoClass.cost * 0.5;
    }
    for (const ind of this.industries) w += ind.bookValue;
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
  readonly player: Company;
  /** Player first, then 0–3 AI companies. */
  readonly companies: Company[];
  year = 1862;
  status: GameStatus = 'playing';
  /** The victory medal earned when the game is won (else 'none'). */
  earnedMedal: Medal = 'none';
  goal: Goal = networthGoal(2_500_000, 1890);
  /** Cumulative units of each cargo the player has delivered (for cargo objectives). */
  readonly cargoHauled = new Map<CargoKind, number>();
  /** How many contracts the player has fulfilled (for contract objectives). */
  contractsDone = 0;
  /** Generation parameters, stored so a save reloads an identical world. */
  cities = 0;
  aiCount = 1;
  difficultyId = 'financier';
  private aiInterval = 6;
  private aiReserve = 160_000;
  private yearAccum = 0;
  /** Total elapsed sim-seconds — used to annualize a line's earnings into a rate. */
  private clock = 0;
  /** City-pair keys the player has already been paid a first-connection bonus for. */
  private firstConnected = new Set<string>();
  /** Haul contracts — offered on the board, then accepted and worked by the player. */
  readonly contracts: Contract[] = [];
  private contractTimer = CONTRACT_FIRST_DELAY;
  private nextContractId = 1;
  /** Newest first; the HUD shows the head of this list. */
  readonly deliveries: Delivery[] = [];
  /** A times-of-the-era price multiplier per cargo (booms, panics…), set by the
   *  EventDirector. Neutral by default so the economy runs fine without one. */
  priceModifier: (kind: CargoKind) => number = () => 1;
  /** Fired when the player earns a delivery / completes a build (for audio). */
  onRevenue?: (amount: number) => void;
  /** A player delivery just paid out — float the $ earned up from the train at this spot. */
  onDeliveryPop?: (pos: THREE.Vector3, amount: number) => void;
  onBuilt?: () => void;
  /** Headline feed for world events (washouts and their repair) — wired to the HUD toast. */
  onNews?: (text: string, good: boolean, at?: THREE.Vector3) => void;
  /** Fired when a real (non through-service) line's track is laid — lets the view grade the
   *  terrain to the new roadbed and clear scatter from the corridor. */
  onTrackBuilt?: (waypoints: THREE.Vector3[]) => void;

  constructor(
    private scene: THREE.Scene,
    private field: Heightfield,
    private seed: number,
    cfg: NetworkConfig
  ) {
    const diff = cfg.difficulty;
    this.player = new Company(cfg.player.name, cfg.player.color, false, Math.round(cfg.startMoney * diff.playerMult));
    this.companies = [this.player];
    for (const a of cfg.ais) {
      this.companies.push(new Company(a.name, a.color, true, Math.round(cfg.startMoney * diff.aiMult)));
    }
    this.year = cfg.year;
    this.cities = cfg.cities;
    this.aiCount = cfg.ais.length;
    this.difficultyId = diff.id;
    this.aiInterval = diff.aiInterval;
    this.aiReserve = diff.aiReserve;
    this.goal = { ...cfg.goal };
  }

  /** The AI companies still in play. */
  get rivals(): Company[] {
    return this.companies.filter((c) => c.isAI && !c.defunct);
  }

  get worldSeed(): number {
    return this.seed;
  }

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

  /** The world parameters (seed + city count) a save was made in, so it can be
   *  regenerated identically before the dynamic state is restored. */
  static savedWorld(): {
    seed: number;
    cities: number;
    difficulty: string;
    player: CompanySetup;
    ais: CompanySetup[];
  } | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return {
        seed: d.seed,
        cities: d.cities,
        difficulty: d.difficulty ?? 'financier',
        player: d.player ?? { name: 'Iron Empire', color: 0x8fffa8 },
        ais: d.ais ?? [{ name: 'Atlas & Pacific', color: 0xff8a4d }],
      };
    } catch {
      return null;
    }
  }

  /** Snapshot the dynamic game state. Cities are deterministic from the seed, so only
   *  their changing stock/prosperity is stored; lines store their route + roster. */
  save(): void {
    const ci = (c: Company): number => this.companies.indexOf(c);
    const data = {
      seed: this.seed,
      cities: this.cities,
      difficulty: this.difficultyId,
      player: { name: this.player.name, color: this.player.color },
      ais: this.companies.filter((c) => c.isAI).map((c) => ({ name: c.name, color: c.color })),
      year: this.year,
      goal: { ...this.goal },
      cargoHauled: [...this.cargoHauled],
      contractsDone: this.contractsDone,
      status: this.status,
      earnedMedal: this.earnedMedal,
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
        owner: s.owner ? ci(s.owner) : -1,
        bookValue: s.bookValue,
        hasRecipe: !!s.recipe,
        level: s.level,
        revenue: Math.round(s.revenue),
        hasStation: s.hasStation,
        depotOwners: [...s.depots.keys()].map((co) => ci(co)),
        buildings: [...s.buildings],
      })),
      lines: this.lines.map((l) => ({
        owner: ci(l.owner),
        stops: l.stops.map((s) => s.id),
        through: l.through,
        // [x, y, z] — y is only needed for through-services (raw tracks); regular
        // lines recompute it from the terrain on load.
        wp: l.waypoints.map((p) => [Math.round(p.x), +p.y.toFixed(1), Math.round(p.z)]),
        trains: l.trains.map((t) => ({
          loco: t.locoClass.id,
          dist: +t.railDist.toFixed(1),
          dir: t.heading,
          cars: t.consist.map((c) => ({ kind: c.kind, amount: +c.amount.toFixed(1), origin: [+c.origin.x.toFixed(1), +c.origin.y.toFixed(1), +c.origin.z.toFixed(1)] })),
        })),
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
    this.earnedMedal = data.earnedMedal ?? 'none';
    if (data.goal) {
      // Back-compat: pre-objective saves stored only { targetCash, byYear }. Default any
      // missing field so a truncated save can't produce NaN tier thresholds.
      this.goal = data.goal.kind ? { ...data.goal } : networthGoal(data.goal.targetCash ?? 2_500_000, data.goal.byYear ?? 1890);
    }
    this.cargoHauled.clear();
    for (const [k, v] of (data.cargoHauled ?? [])) this.cargoHauled.set(k, v);
    this.contractsDone = data.contractsDone ?? 0;
    this.clearLines();

    this.companies.forEach((c, i) => {
      const cd = data.companies[i];
      if (!cd) return;
      c.money = cd.money;
      c.debt = cd.debt;
      c.defunct = cd.defunct;
      c.holdings.clear();
      c.industries.length = 0;
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
      s.stage = s.archetype.size; // …and the stage re-derived from the restored prosperity
      s.growth = 1 + Math.min(2, s.served / SERVE_FULL);
      this.maybeGrowCity(s); // announce=false: no headlines while restoring a save

      // A factory founded by the player at runtime isn't in the seed — re-add it.
      if (sd.hasRecipe && !s.recipe) {
        s.recipe = ARCHETYPES.factory.recipe;
        for (const k of Object.keys(s.recipe!.inputs) as CargoKind[]) s.demands.add(k);
        const f = buildFactory();
        const fx = s.pos.x - 28;
        const fz = s.pos.z + 22;
        f.position.set(fx, this.field.height(fx, fz), fz);
        f.rotation.y = s.id * 0.7;
        this.scene.add(f);
      }
      // Restore industry ownership + depot level/earnings.
      s.bookValue = sd.bookValue ?? 0;
      s.owner = sd.owner >= 0 ? this.companies[sd.owner] : null;
      if (s.owner) s.owner.industries.push(s);
      s.level = sd.level ?? 0;
      s.revenue = sd.revenue ?? 0;
      // Restore every company's depot here. (Old saves: a single depotOwner + hasStation.)
      const owners: number[] = sd.depotOwners ?? (sd.hasStation ? [sd.depotOwner >= 0 ? sd.depotOwner : 0] : []);
      for (const oi of owners) this.placeDepot(s, this.companies[oi] ?? this.player);
      s.buildings.clear(); // restore strictly from the save, not stale in-memory state
      if (s.depots.has(this.player)) {
        for (const b of (sd.buildings ?? []) as StationBuilding[]) {
          s.buildings.add(b);
          this.placeStationStructure(s, b);
        }
      }
    });

    for (const ld of data.lines) {
      const stops = (ld.stops as number[]).map((id) => this.stations[id]);
      const owner = this.companies[ld.owner];
      if (stops.some((s) => !s) || !owner) continue;
      const through = !!ld.through;
      // Waypoints saved as [x,y,z]; a through-service keeps its exact y (it rides the
      // rails), a regular line recomputes y from the terrain. (Old saves stored [x,z].)
      const wp: THREE.Vector3[] = ld.wp.map((p: number[]) =>
        new THREE.Vector3(p[0], through && p.length >= 3 ? p[1] : this.field.height(p[0], p[p.length - 1]), p[p.length - 1])
      );
      const tds = ld.trains as { loco: string; dist?: number; dir?: 1 | -1; cars: unknown[] }[];
      const trains = tds.map((t) => ({
        loco: LOCOS.find((l) => l.id === t.loco) ?? defaultLoco(this.year),
        cars: t.cars.map((c) => (typeof c === 'string' ? c : (c as { kind: CargoKind }).kind)) as CargoKind[],
      }));
      const line = this.layLine(owner, stops, wp, trains, through);
      // Restore each train's position + cargo (cars saved as objects in current format).
      line.trains.forEach((tr, i) => {
        const td = tds[i];
        if (!td || td.dist === undefined || td.dir === undefined) return;
        const cargo = td.cars.map((c) =>
          typeof c === 'string'
            ? { amount: 0, origin: [0, 0, 0] as [number, number, number] }
            : { amount: (c as { amount: number }).amount, origin: (c as { origin: [number, number, number] }).origin }
        );
        tr.restore(td.dist, td.dir, cargo);
      });
    }
    // Depots were placed before the lines existed; now snap each onto its owner's rails.
    for (const s of this.stations) for (const [owner, d] of s.depots) { d.aligned = false; this.alignDepot(s, owner); }
    return true;
  }

  /** Tear down every line (meshes + trains) — used before restoring a save. */
  private clearLines(): void {
    for (const l of this.lines) {
      for (const t of l.trains) t.dispose(this.scene);
      this.scene.remove(l.track.group);
      l.track.dispose();
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
    return this.companyBuyShares(this.player, target, qty);
  }

  /** Any company buys shares of another. Crossing 50% triggers a takeover (unless the
   *  buyer is forbidden it — an AI can take a position in the player but never absorb it). */
  private companyBuyShares(buyer: Company, target: Company, qty: number, allowTakeover = true): boolean {
    if (target.defunct || buyer === target || qty <= 0) return false;
    const cost = qty * target.sharePrice;
    if (cost > buyer.money) return false;
    buyer.money -= cost;
    buyer.holdings.set(target, (buyer.holdings.get(target) ?? 0) + qty);
    if (allowTakeover && (buyer.holdings.get(target) ?? 0) / target.shares > 0.5) this.takeover(buyer, target);
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
    // The acquired company's industries (and their royalties + book value) transfer too.
    for (const st of this.stations) {
      if (st.owner === target) {
        st.owner = buyer;
        buyer.industries.push(st);
      }
    }
    target.industries.length = 0;
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
      sat: new Map(),
      input: new Map(),
      recipe,
      growth: 1,
      served: 0,
      tier: 0,
      owner: null,
      bookValue: 0,
      level: 0,
      revenue: 0,
      hasStation: false,
      depots: new Map(),
      townGroup: new THREE.Group(),
      catchment: [],
      buildings: new Set(),
      stage: site.archetype.size,
    };
    this.stations.push(st);

    // The town exists from the start; the depot is built (and paid for) by a railroad. The
    // house rings live in townGroup so they can be rebuilt clear of track laid later.
    st.townGroup.position.copy(pos);
    this.scene.add(st.townGroup);
    this.rebuildTown(st);

    return st;
  }

  /** (Re)build a town's house rings, relocating any house off freshly-laid track. Deterministic
   *  per seed+id+tier, so it reproduces the same town minus what the rails now occupy. */
  private rebuildTown(st: GStation): void {
    for (const child of [...st.townGroup.children]) {
      st.townGroup.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    const base = this.seed + st.id * 131;
    const avoid = (lx: number, lz: number): boolean => {
      const wx = st.pos.x + lx, wz = st.pos.z + lz;
      if (this.field.nearCorridor(wx, wz, TOWN_CLEAR)) return true;
      // Give each depot building elbow room — houses make way for the station, not the reverse.
      for (const d of st.depots.values()) {
        if (Math.hypot(d.mesh.position.x - wx, d.mesh.position.z - wz) < DEPOT_CLEAR) return true;
      }
      return false;
    };
    st.townGroup.add(buildTown(base, st.archetype.houses, 13, 47, avoid));
    for (let t = 0; t < st.tier; t++) {
      st.townGroup.add(buildTown(base + (t + 1) * 7919, 5 + t, 50 + t * 16, 64 + t * 16, avoid));
    }
  }

  /** Outer reach of a town's houses (for deciding which towns a new line disturbs). */
  private townRadius(st: GStation): number {
    return st.tier > 0 ? 64 + (st.tier - 1) * 16 : 47;
  }

  /** A line was laid — shoulder the houses of every town it passes off the new rails. */
  private clearTownsForCorridor(waypoints: THREE.Vector3[]): void {
    for (const st of this.stations) {
      let near = false;
      const reach = this.townRadius(st) + TOWN_CLEAR;
      for (let i = 0; i < waypoints.length - 1 && !near; i++) {
        near = pointSegDist(st.pos, waypoints[i], waypoints[i + 1]) < reach;
      }
      if (near) this.rebuildTown(st);
    }
  }

  /** What it costs to put a depot at a city — required before a route can stop there. */
  stationCost(): number {
    return STATION_COST;
  }

  /** The price multiplier (0..1) this market currently pays for a cargo — 1 when fresh,
   *  falling as it saturates. Read by the inspector to show why a glutted town pays less. */
  marketPrice(st: GStation, kind: CargoKind): number {
    return marketMult(st.sat.get(kind) ?? 0);
  }

  get catchmentRange(): number {
    return CATCHMENT_RADIUS;
  }

  /** Does this company have its own depot at this city? */
  hasDepot(st: GStation, company: Company): boolean {
    return st.depots.has(company);
  }

  /** Build a depot at a city so the player's trains can serve it. Charged to the player. Each
   *  railroad builds its OWN depot — the player can build here even if a rival already has one. */
  buildStationAt(st: GStation): boolean {
    if (st.depots.has(this.player) || this.status !== 'playing') return false;
    if (STATION_COST > this.player.money) return false;
    this.player.money -= STATION_COST;
    this.placeDepot(st, this.player);
    this.onBuilt?.();
    return true;
  }

  /** Demolish a player-built depot: scrap any lines that stop here (they can't run
   *  without it), remove the depot, refund part of its cost, and re-figure catchment. */
  demolishStation(st: GStation): boolean {
    const depot = st.depots.get(this.player);
    if (!depot || this.status !== 'playing') return false;
    // Only the player's own lines through here die — a rival keeps its separate depot + lines.
    for (const l of [...this.lines]) {
      if (l.owner === this.player && l.stops.includes(st)) this.demolishLine(l);
    }
    this.scene.remove(depot.mesh);
    depot.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose(); // depot materials are shared (mats() singleton)
    });
    st.depots.delete(this.player);
    st.hasStation = false;
    st.level = 0;
    st.revenue = 0;
    st.buildings.clear(); // their meshes were children of the depot, freed above
    this.player.money += Math.round(STATION_COST * 0.4);
    this.assignCatchment();
    this.onBuilt?.();
    return true;
  }

  /** Build one company's depot building at a city (also used on load). */
  private placeDepot(st: GStation, owner: Company): void {
    // Re-placing this owner's depot (loading into an active game) — free the old mesh first.
    const existing = st.depots.get(owner);
    if (existing) {
      this.scene.remove(existing.mesh);
      existing.mesh.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    const mesh = buildStation();
    this.scene.add(mesh);
    const depot: GDepot = { owner, mesh, aligned: false };
    st.depots.set(owner, depot);
    if (owner === this.player) st.hasStation = true;
    this.alignDepot(st, owner); // sit it beside its line's rails, or face the nearest city
    this.rebuildTown(st); // relocate houses that now crowd the depot
    this.assignCatchment();
  }

  /** The player's depot mesh at a city (for building add-ons), or null. */
  private playerDepotMesh(st: GStation): THREE.Object3D | null {
    return st.depots.get(this.player)?.mesh ?? null;
  }

  /** Place the depot beside the rails of a line that stops here, with its platform running
   *  along the track so the station reads as part of the line. With no line yet, it faces
   *  the nearest neighbouring city as a sensible default until one arrives. Purely visual —
   *  catchment and the economy key off st.pos, never the depot mesh. */
  private alignDepot(st: GStation, owner: Company): void {
    const depot = st.depots.get(owner);
    if (!depot) return;
    const at = new THREE.Vector3();
    const dir = new THREE.Vector3();
    // Align beside a line OWNED BY this company that stops here, so each railroad's depot sits on
    // its own rails — never a rival's.
    const line = this.lines.find(
      (l) => l.owner === owner && !l.through && l.stops.includes(st) && l.track.group.children.length > 0
    );
    // Stagger each railroad's depot further off the rails so two owners at one city never stack.
    const slot = Math.max(0, [...st.depots.keys()].indexOf(owner));
    if (line) {
      const u = Math.max(0, Math.min(1, line.stopFracs[line.stops.indexOf(st)]));
      line.track.curve.getPointAt(u, at);
      line.track.curve.getTangentAt(u, dir);
      dir.y = 0;
      depot.aligned = true;
    } else {
      at.copy(st.pos);
      let near: GStation | null = null;
      let best = Infinity;
      for (const o of this.stations) {
        if (o === st) continue;
        const d = o.pos.distanceToSquared(st.pos);
        if (d < best) { best = d; near = o; }
      }
      if (near) dir.set(near.pos.x - st.pos.x, 0, near.pos.z - st.pos.z);
    }
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    // Sit the depot just off one side of the track so its platform's track edge (+X local)
    // runs right alongside the rails (its long axis +Z parallel to them) — a station ON the
    // line, not a building nearby.
    const SIDE = 6.5 + slot * 9;
    const px = at.x - dir.z * SIDE;
    const pz = at.z + dir.x * SIDE;
    depot.mesh.position.set(px, this.field.height(px, pz), pz);
    depot.mesh.rotation.y = Math.atan2(dir.x, dir.z);
  }

  /** Buy a maintenance building at a player-owned depot (one of each). */
  addStationBuilding(st: GStation, type: StationBuilding): boolean {
    if (!st.depots.has(this.player) || this.status !== 'playing') return false;
    if (st.buildings.has(type)) return false;
    const cost = STATION_BUILDINGS[type].cost;
    if (cost > this.player.money) return false;
    this.player.money -= cost;
    st.buildings.add(type);
    this.placeStationStructure(st, type);
    this.onBuilt?.();
    return true;
  }

  /** Set a maintenance structure beside the depot (laid out in a row in depot-local
   *  space, so demolishing the depot frees it along with the depot's own geometry). */
  private placeStationStructure(st: GStation, type: StationBuilding): void {
    const mesh = this.playerDepotMesh(st);
    if (!mesh) return;
    const s = buildStationStructure(type);
    const idx = STATION_BUILDING_ORDER.indexOf(type);
    s.position.set(-18 + idx * 9, 0, -13);
    mesh.add(s);
  }

  /** Most this station can stockpile of any one cargo — a warehouse raises it. */
  stockCap(st: GStation): number {
    return STOCK_CAP * (st.buildings.has('warehouse') ? WAREHOUSE_STOCK : 1);
  }

  /** Units a train can take on in one berth here — a warehouse raises it. */
  loadPerStop(st: GStation): number {
    return LOAD_PER_STOP * (st.buildings.has('warehouse') ? WAREHOUSE_LOAD : 1);
  }

  /** Extra revenue multiplier from this station's buildings for a given cargo (post
   *  office boosts mail & passengers, hotel boosts passengers). */
  stationRevenueMult(st: GStation, kind: CargoKind): number {
    let m = 1;
    if (st.buildings.has('postoffice') && (kind === 'mail' || kind === 'passengers')) m *= POSTOFFICE_MULT;
    if (st.buildings.has('hotel') && kind === 'passengers') m *= HOTEL_MULT;
    return m;
  }

  /** Assign each depot-less city to its nearest depot within range — that depot then
   *  gathers (and sells to) its cargo. A city with its own depot is its own node. */
  assignCatchment(): void {
    for (const s of this.stations) s.catchment = [];
    for (const city of this.stations) {
      if (city.depots.size > 0) continue; // any railroad's depot makes it its own node
      let best: GStation | null = null;
      let bd = CATCHMENT_RADIUS;
      for (const dep of this.stations) {
        if (dep.depots.size === 0) continue;
        const d = Math.hypot(dep.pos.x - city.pos.x, dep.pos.z - city.pos.z);
        if (d < bd) {
          bd = d;
          best = dep;
        }
      }
      if (best) best.catchment.push(city);
    }
  }

  /** Cargo a station can ship: its own extraction plus every catchment city's, each
   *  scaled by that city's prosperity. */
  private effectiveSupplies(st: GStation): Map<CargoKind, number> {
    const m = new Map<CargoKind, number>();
    const add = (c: GStation): void => {
      for (const k of Object.keys(c.supplies) as CargoKind[]) m.set(k, (m.get(k) ?? 0) + c.supplies[k]! * c.growth);
    };
    add(st);
    for (const c of st.catchment) add(c);
    return m;
  }

  /** Cargo a station pays to receive: its own demands plus every catchment city's. */
  private effectiveDemands(st: GStation): Set<CargoKind> {
    const s = new Set<CargoKind>(st.demands);
    for (const c of st.catchment) for (const k of c.demands) s.add(k);
    return s;
  }

  /** Nearest city to a point (built or not) — for selection/inspection. */
  nearestCity(point: THREE.Vector3, maxDist: number): GStation | null {
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

  /** Every station reachable from `st` over the connected rail network — lines that
   *  share a stop chain into one network, so cargo and trains move across the whole
   *  component, not just a single line. */
  reachableFrom(st: GStation): Set<GStation> {
    const seen = new Set<GStation>([st]);
    const queue: GStation[] = [st];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const l of this.lines) {
        if (!l.stops.includes(cur)) continue;
        for (const s of l.stops) if (!seen.has(s)) {
          seen.add(s);
          queue.push(s);
        }
      }
    }
    return seen;
  }

  /** Adjacent depots one segment away from `s`, with the line and segment length. */
  private neighbors(s: GStation): { to: GStation; line: GLine; w: number }[] {
    const out: { to: GStation; line: GLine; w: number }[] = [];
    for (const l of this.lines) {
      const idx = l.stops.indexOf(s);
      if (idx < 0) continue;
      for (const j of [idx - 1, idx + 1]) {
        if (j < 0 || j >= l.stops.length) continue;
        const w = Math.abs(l.stopFracs[j] - l.stopFracs[idx]) * l.track.length;
        out.push({ to: l.stops[j], line: l, w });
      }
    }
    return out;
  }

  /** Shortest path across the rail network from one depot to another, as the legs (each
   *  a line + the two stations it runs between). Dijkstra over the segment graph. */
  pathLegs(from: GStation, to: GStation): { line: GLine; from: GStation; to: GStation }[] | null {
    const dist = new Map<GStation, number>([[from, 0]]);
    const prev = new Map<GStation, { via: GStation; line: GLine }>();
    const open: GStation[] = [from];
    const done = new Set<GStation>();
    while (open.length) {
      open.sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity));
      const u = open.shift()!;
      if (done.has(u)) continue;
      done.add(u);
      if (u === to) break;
      for (const n of this.neighbors(u)) {
        const nd = (dist.get(u) ?? Infinity) + n.w;
        if (nd < (dist.get(n.to) ?? Infinity)) {
          dist.set(n.to, nd);
          prev.set(n.to, { via: u, line: n.line });
          open.push(n.to);
        }
      }
    }
    if (from === to || !prev.has(to)) return from === to ? [] : null;
    const legs: { line: GLine; from: GStation; to: GStation }[] = [];
    let cur = to;
    while (cur !== from) {
      const p = prev.get(cur)!;
      legs.unshift({ line: p.line, from: p.via, to: cur });
      cur = p.via;
    }
    return legs;
  }

  /**
   * Run a through-service from a depot to the farthest depot reachable across the
   * network, path-finding over the existing lines. The train rides a movement-only
   * track that traces the rails it crosses, so a single train threads several lines
   * through their junctions. Charged the cost of the locomotive.
   */
  buildThroughService(from: GStation, loco: LocoClass, cars?: CargoKind[]): boolean {
    if (loco.cost > this.player.money) return false;
    const reach = [...this.reachableFrom(from)].filter((s) => s !== from && s.hasStation);
    if (!reach.length) return false;
    let to = reach[0];
    let far = -1;
    for (const s of reach) {
      const d = from.pos.distanceToSquared(s.pos);
      if (d > far) {
        far = d;
        to = s;
      }
    }
    const legs = this.pathLegs(from, to);
    if (!legs || legs.length === 0) return false;

    // Sample each leg's curve to trace a continuous route across the junctions.
    const pts: THREE.Vector3[] = [];
    const stops: GStation[] = [from];
    const tmp = new THREE.Vector3();
    for (const leg of legs) {
      const uA = leg.line.track.nearestU(leg.from.pos);
      const uB = leg.line.track.nearestU(leg.to.pos);
      const n = Math.max(4, Math.floor((Math.abs(uB - uA) * leg.line.track.length) / 18));
      for (let i = pts.length ? 1 : 0; i <= n; i++) {
        leg.line.track.curve.getPointAt(THREE.MathUtils.clamp(THREE.MathUtils.lerp(uA, uB, i / n), 0, 1), tmp);
        pts.push(tmp.clone());
      }
      stops.push(leg.to);
    }

    this.player.money -= loco.cost;
    // Movement-only track tracing existing rails — built via layLine(through) so it
    // round-trips correctly through save/load.
    this.layLine(this.player, stops, pts, [{ loco, cars: cars ?? this.defaultConsist(stops, loco) }], true);
    this.onBuilt?.();
    return true;
  }

  /** Nearest city that has a depot — for track-laying stop snapping. */
  nearestStation(point: THREE.Vector3, maxDist: number): GStation | null {
    let best: GStation | null = null;
    let bd = maxDist;
    for (const s of this.stations) {
      if (!s.hasStation) continue;
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

  /** Is this city part of the company's connected network (a depot here, or a stop it serves)? */
  inNetwork(company: Company, city: GStation): boolean {
    return city.depots.has(company) || company.lines.some((l) => l.stops.includes(city));
  }

  /** How many of the company's real routes (2+ stops) already stop at this city. */
  lineCountAt(company: Company, city: GStation): number {
    return company.lines.filter((l) => l.stops.length >= 2 && l.stops.includes(city)).length;
  }

  /** Most lines one station may host. */
  readonly maxLinesPerStation = 4;

  /** Why this company can't lay a line over these stops, or null if it's allowed. Enforces the
   *  two network rules: build OUT from your own network (no floating track), ≤4 lines a station. */
  lineBuildIssue(company: Company, stops: GStation[]): string | null {
    const unique = stops.filter((s, i) => stops.indexOf(s) === i);
    // Connected: once you have any track or station, a new line must touch a city you serve.
    const hasNetwork = company.lines.length > 0 || this.stations.some((s) => s.depots.has(company));
    if (hasNetwork && stops.length >= 1 && !stops.some((s) => this.inNetwork(company, s))) {
      return 'New track must connect to your network — start it from a city you already serve.';
    }
    for (const s of unique) {
      if (this.lineCountAt(company, s) >= this.maxLinesPerStation) {
        return `${s.name} already has ${this.maxLinesPerStation} lines — the most a station can take.`;
      }
    }
    return null;
  }

  /** The free ends of a company's real lines — where track can be extended from. Each carries
   *  the outward direction so a new run curves smoothly out of it instead of kinking. */
  lineEnds(company: Company): { line: GLine; end: 'head' | 'tail'; pos: THREE.Vector3; dir: THREE.Vector3 }[] {
    const out: { line: GLine; end: 'head' | 'tail'; pos: THREE.Vector3; dir: THREE.Vector3 }[] = [];
    for (const l of company.lines) {
      if (l.through || l.waypoints.length < 2) continue;
      const w = l.waypoints;
      out.push({ line: l, end: 'head', pos: w[0].clone(), dir: w[0].clone().sub(w[1]).setY(0).normalize() });
      out.push({ line: l, end: 'tail', pos: w[w.length - 1].clone(), dir: w[w.length - 1].clone().sub(w[w.length - 2]).setY(0).normalize() });
    }
    return out;
  }

  /** Where a NEW line should berth at `city`, approaching from `fromPos`: the first line gets the
   *  centre track; each extra line of the same owner gets a PARALLEL PLATFORM alongside — offset
   *  to the SIDE the line approaches from, with a brief parallel run in, so it never has to cross
   *  the existing track to reach its berth. Returns the final waypoint(s), ordered toward berth. */
  private platformBerth(owner: Company, city: GStation, fromPos: THREE.Vector3): THREE.Vector3[] {
    const here = owner.lines.filter((l) => !l.through && l.stops.length >= 1 && l.stops.includes(city));
    const slot = Math.min(here.length, 3); // 0 = centre track; 1..3 = platforms beside it
    if (slot === 0) return [city.pos.clone()];
    const first = here[0];
    const u = Math.max(0, Math.min(1, first.stopFracs[first.stops.indexOf(city)]));
    const tan = new THREE.Vector3();
    first.track.curve.getTangentAt(u, tan);
    tan.y = 0;
    if (tan.lengthSq() < 1e-4) tan.set(1, 0, 0);
    tan.normalize();
    const perp = new THREE.Vector3(-tan.z, 0, tan.x);
    // Offset toward the approach side so the new track stays clear of the existing one.
    const toFrom = fromPos.clone().sub(city.pos);
    toFrom.y = 0;
    const side = toFrom.dot(perp) >= 0 ? 1 : -1;
    const berth = city.pos.clone().addScaledVector(perp, side * slot * PLATFORM_GAP);
    // Brief parallel run into the berth, laid on the approach side (toward fromPos).
    const leadSign = fromPos.clone().sub(berth).dot(tan) >= 0 ? 1 : -1;
    const lead = berth.clone().addScaledVector(tan, leadSign * PLATFORM_LEN);
    return [lead, berth];
  }

  /** Replace the route's endpoints with platform berths where the owner already serves that
   *  city, so a hub station fans into parallel platform tracks (each on its own approach side). */
  private withPlatformBerths(owner: Company, stops: GStation[], route: THREE.Vector3[]): THREE.Vector3[] {
    let r = route.map((p) => p.clone());
    const a = stops[0];
    const b = stops[stops.length - 1];
    if (a && r.length >= 2 && owner.lines.some((l) => !l.through && l.stops.includes(a))) {
      const berth = this.platformBerth(owner, a, r[1]); // approaches from the next point
      r = [...berth.slice().reverse(), ...r.slice(1)]; // berth, lead, …
    }
    if (b && b !== a && r.length >= 2 && owner.lines.some((l) => !l.through && l.stops.includes(b))) {
      r = [...r.slice(0, -1), ...this.platformBerth(owner, b, r[r.length - 2])]; // …, lead, berth
    }
    return r;
  }

  /** Extend an existing line from one of its ends: append the new ground waypoints (and an
   *  optional new city stop), charge the added track, and re-lay the rails — the smoothed curve
   *  flows naturally out of the old end. Returns false if unaffordable. */
  extendLine(line: GLine, end: 'head' | 'tail', addWaypoints: THREE.Vector3[], newStop: GStation | null): boolean {
    if (line.through || addWaypoints.length < 1) return false;
    const owner = line.owner;
    const anchor = end === 'tail' ? line.waypoints[line.waypoints.length - 1] : line.waypoints[0];
    let added = addWaypoints.map((p) => p.clone());
    // If we're reaching a city this railroad already serves, berth on a parallel platform track,
    // offset toward the side we're approaching from (so it doesn't cross the existing track).
    if (newStop && added.length && owner.lines.some((l) => !l.through && l.stops.includes(newStop))) {
      const fromPos = added.length >= 2 ? added[added.length - 2] : anchor;
      added = [...added.slice(0, -1), ...this.platformBerth(owner, newStop, fromPos)];
    }
    const segCost = this.routeCost([anchor.clone(), ...added]);
    if (segCost > owner.money) return false;
    owner.money -= segCost;
    const wp = end === 'tail' ? [...line.waypoints, ...added] : [...added.reverse(), ...line.waypoints];
    this.scene.remove(line.track.group);
    line.track.dispose();
    line.track = new Track(this.field, wp, true, false, owner.color);
    this.scene.add(line.track.group);
    line.waypoints = wp;
    if (newStop && !line.stops.includes(newStop)) {
      if (end === 'tail') line.stops.push(newStop);
      else line.stops.unshift(newStop);
    }
    line.stopFracs = line.stops.map((s) => line.track.nearestU(s.pos));
    line.value = this.routeCost(wp);
    this.clearTownsForCorridor(wp);
    this.onTrackBuilt?.(wp);
    for (const st of line.stops) {
      const d = st.depots.get(owner);
      if (d) { d.aligned = false; this.alignDepot(st, owner); }
    }
    // The rails moved under any running train — set each back at the start of the rebuilt line.
    for (const t of line.trains) {
      t.restore(0, 1, t.consist.map((c) => ({ amount: c.amount, origin: [c.origin.x, c.origin.y, c.origin.z] as [number, number, number] })));
    }
    if (owner === this.player) this.onBuilt?.();
    return true;
  }

  /** Spawn a company's home: a maxed-out station at a city plus a short stub of track to grow
   *  out from — free (the starting setup). No train yet; the network is built from here. */
  seedStarter(company: Company, city: GStation): void {
    const money = company.money;
    this.placeDepot(city, company);
    city.level = 3; // fully upgraded (depot level is city-shared)
    // A home city has industry: a works that turns hauled-in raw materials into goods to ship —
    // so from frame one there's a supply chain to build (raw → here → goods → elsewhere).
    if (!city.recipe) {
      city.recipe = ARCHETYPES.factory.recipe;
      for (const k of Object.keys(city.recipe!.inputs) as CargoKind[]) city.demands.add(k);
      city.owner = company;
      city.bookValue = 160_000;
      company.industries.push(city);
      const f = buildFactory();
      const fx = city.pos.x - 28;
      const fz = city.pos.z + 22;
      f.position.set(fx, this.field.height(fx, fz), fz);
      f.rotation.y = city.id * 0.7;
      this.scene.add(f);
    }
    // A short stub of rail off the station, aimed at the nearest neighbour but stopping short.
    let near: GStation | null = null;
    let best = Infinity;
    for (const o of this.stations) {
      if (o === city) continue;
      const d = o.pos.distanceToSquared(city.pos);
      if (d < best) { best = d; near = o; }
    }
    const dir = near ? near.pos.clone().sub(city.pos).setY(0).normalize() : new THREE.Vector3(1, 0, 0);
    const end = city.pos.clone().addScaledVector(dir, 40);
    end.y = this.field.height(end.x, end.z);
    this.buildLineFor(company, [city.pos.clone(), end], [city]); // 1-stop stub: track only
    company.money = money; // the home setup is on the house
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
   * A line's running profit-and-loss — the core "is this route paying?" readout. Income
   * is the haul revenue its trains have booked, annualized over how long the line has
   * run; cost is the yearly upkeep of its locomotives. `perTrip` is the average revenue
   * each service stop brings in.
   */
  lineStats(line: GLine): {
    earned: number;
    trips: number;
    perTrip: number;
    upkeepPerYear: number;
    profitPerYear: number;
  } {
    const ageYears = Math.max(0.05, (this.clock - line.bornClock) / SECONDS_PER_YEAR);
    const upkeepPerYear = line.trains.reduce((a, t) => a + t.locoClass.upkeep, 0);
    const perTrip = line.trips > 0 ? line.earned / line.trips : 0;
    const profitPerYear = line.earned / ageYears - upkeepPerYear;
    return { earned: line.earned, trips: line.trips, perTrip, upkeepPerYear, profitPerYear };
  }

  /**
   * Commit a line between two stations through the given intermediate waypoints,
   * staffed by the chosen locomotive. Deducts cost, lays the Track, and puts a train
   * on it. Returns false (building nothing) if the player can't afford it.
   */
  buildLine(waypoints: THREE.Vector3[], stops: GStation[], loco?: LocoClass, cars?: CargoKind[]): boolean {
    return this.buildLineFor(this.player, waypoints, stops, loco, cars);
  }

  /** If this owner already runs a line over the same set of cities, shift the new route sideways
   *  by one (or more) track-widths so it lays as a clean parallel double-track rather than
   *  overlapping the first — two independent tracks that never block each other. */
  private parallelOffset(owner: Company, stops: GStation[], waypoints: THREE.Vector3[]): THREE.Vector3[] {
    if (stops.length < 2 || waypoints.length < 2) return waypoints;
    const key = stops.map((s) => s.id).sort((a, b) => a - b).join(',');
    const dup = owner.lines.filter(
      (l) => !l.through && l.stops.length >= 2 && l.stops.map((s) => s.id).sort((a, b) => a - b).join(',') === key
    ).length;
    if (dup === 0) return waypoints;
    const dist = dup * DOUBLE_TRACK_GAP;
    return waypoints.map((p, i) => {
      const a = waypoints[Math.max(0, i - 1)];
      const b = waypoints[Math.min(waypoints.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      // Left-hand perpendicular — the same side the depot platform sits, so it lands between rails.
      return new THREE.Vector3(p.x - (dz / len) * dist, p.y, p.z + (dx / len) * dist);
    });
  }

  /**
   * Commit a length of track along the given ground waypoints, stopping at the listed
   * cities. Track can be laid freely — with fewer than 2 stops it's just rail (no
   * train). With 2+ stops and a locomotive, a train is put on it. Returns false (and
   * builds nothing) if unaffordable.
   */
  buildLineFor(owner: Company, waypoints: THREE.Vector3[], stops: GStation[], loco?: LocoClass, cars?: CargoKind[]): boolean {
    if (waypoints.length < 2) return false;
    // Lay a line that duplicates a corridor this railroad already runs ALONGSIDE the first as a
    // clean parallel double-track, instead of overlapping (and blocking) it.
    // A duplicate corridor is silently shouldered aside so two lines never overlap-and-jam — but
    // it's not advertised: the point of a new line is to reach a NEW place, not parallel an old one.
    // Endpoints at a city this owner already serves berth on a parallel platform track.
    const route = this.withPlatformBerths(owner, stops, this.parallelOffset(owner, stops, waypoints));
    // A train only runs (and is only paid for) when this owner has its OWN depot at 2+ stops.
    const runnable = stops.length >= 2 && !!loco && stops.filter((s) => s.depots.has(owner)).length >= 2;
    const cost = this.routeCost(route) + (runnable ? loco!.cost : 0);
    if (cost > owner.money) return false;
    owner.money -= cost;
    // First-connection bonus (player only): a one-time grant for each pair of cities this
    // line joins for the first time ever — the genre's reward for opening a new corridor.
    // Tracked permanently (not just by current connectivity) so it can't be farmed by
    // demolishing and rebuilding the same link.
    let bonus = 0;
    if (owner === this.player) {
      for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        if (a.id === b.id) continue; // a stop repeated on one line isn't a new connection
        const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        if (!this.firstConnected.has(key) && !this.isConnected(a, b)) {
          this.firstConnected.add(key);
          bonus += FIRST_CONNECT_BASE + Math.round(a.pos.distanceTo(b.pos) * FIRST_CONNECT_PER_UNIT);
        }
      }
    }
    const trains = runnable ? [{ loco: loco!, cars: cars ?? this.defaultConsist(stops, loco!) }] : [];
    this.layLine(owner, stops, route, trains);
    // Snap this owner's depots onto this line's rails the first time it serves them.
    for (const st of stops) {
      const d = st.depots.get(owner);
      if (d && !d.aligned) this.alignDepot(st, owner);
    }
    if (bonus > 0) {
      owner.money += bonus;
      this.pushDelivery(`First link: ${stops[0].name} ↔ ${stops[stops.length - 1].name}`, bonus);
    }
    if (owner === this.player) this.onBuilt?.();
    return true;
  }

  /** Lay the rails + trains for a line without charging — shared by build and load. A
   *  through-service rides existing rails on a movement-only (raw) track and adds no
   *  infrastructure value. */
  private layLine(
    owner: Company,
    stops: GStation[],
    waypoints: THREE.Vector3[],
    trains: { loco: LocoClass; cars: CargoKind[] }[],
    through = false
  ): GLine {
    const track = new Track(this.field, waypoints, !through, through, owner.color);
    this.scene.add(track.group);
    const stopFracs = stops.map((s) => track.nearestU(s.pos));
    const value = through ? 0 : this.routeCost(waypoints);
    const line: GLine = { stops, track, stopFracs, trains: [], owner, value, waypoints, through, earned: 0, trips: 0, bornClock: this.clock, blockedUntil: 0 };
    this.lines.push(line);
    owner.lines.push(line);
    if (!through) {
      this.clearTownsForCorridor(waypoints); // shoulder town houses off the new rails
      this.onTrackBuilt?.(waypoints); // grade terrain + clear scatter to the new bed
    }
    for (const t of trains) this.spawnTrain(line, t.loco, t.cars);
    return line;
  }

  /** Most cars a locomotive can pull. */
  maxCars(loco: LocoClass): number {
    return Math.max(1, Math.min(8, Math.round(loco.capacity / CAR_CAP)));
  }

  /** A sensible default consist: fill the cars with cargo this route actually trades. */
  defaultConsist(stops: GStation[], loco: LocoClass): CargoKind[] {
    const traded = ALL_CARGO.filter(
      (k) => stops.some((s) => this.offersOf(s).includes(k)) && stops.some((s) => s.demands.has(k))
    );
    const pool = traded.length ? traded : (['goods'] as CargoKind[]);
    const n = this.maxCars(loco);
    return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
  }

  /** Found a factory at a city that has no industry yet: it gains the goods recipe
   *  (consuming coal + lumber), starts demanding those inputs, and a hall appears. */
  buildIndustry(st: GStation): boolean {
    if (st.recipe || this.status !== 'playing') return false;
    const cost = 160_000;
    if (cost > this.player.money) return false;
    this.player.money -= cost;

    st.recipe = ARCHETYPES.factory.recipe;
    for (const k of Object.keys(st.recipe!.inputs) as CargoKind[]) st.demands.add(k);
    // You own what you build.
    st.owner = this.player;
    st.bookValue = cost;
    this.player.industries.push(st);

    const f = buildFactory();
    const fx = st.pos.x - 28;
    const fz = st.pos.z + 22;
    f.position.set(fx, this.field.height(fx, fz), fz);
    f.rotation.y = st.id * 0.7;
    this.scene.add(f);
    this.onBuilt?.();
    return true;
  }

  /** Producing cities whose industry isn't owned yet — the pool auctions draw from. */
  ownableIndustries(): GStation[] {
    return this.stations.filter((s) => !s.owner && this.offersOf(s).length > 0);
  }

  /** Appraised value of a city's industry, from its output potential and prosperity. */
  appraiseIndustry(st: GStation): number {
    let rate = 0;
    for (const k of Object.keys(st.supplies) as CargoKind[]) rate += st.supplies[k]!;
    if (st.recipe) rate += st.recipe.rate * 1.5;
    return Math.round((70_000 + rate * st.growth * 130_000) / 1000) * 1000;
  }

  /** Transfer an industry to a company at the agreed price. */
  awardIndustry(st: GStation, co: Company, price: number): void {
    if (st.owner) return;
    co.money -= price;
    st.owner = co;
    st.bookValue = this.appraiseIndustry(st);
    co.industries.push(st);
  }

  /** Buy and place an additional train (with the given consist) on an existing line. */
  addTrain(line: GLine, loco: LocoClass, cars?: CargoKind[]): boolean {
    if (!this.canRunTrains(line)) return false; // needs two depots to be worth running
    if (loco.cost > line.owner.money) return false;
    line.owner.money -= loco.cost;
    this.spawnTrain(line, loco, cars ?? this.defaultConsist(line.stops, loco));
    return true;
  }

  /** A line can run trains once at least two of its stops have a depot to load/unload at. */
  canRunTrains(line: GLine): boolean {
    return !line.through && line.stops.filter((s) => s.hasStation).length >= 2;
  }

  /** Sell a train off a line: remove it and refund half the locomotive's value. */
  sellTrain(line: GLine, train: Train): boolean {
    const i = line.trains.indexOf(train);
    if (i < 0) return false;
    line.trains.splice(i, 1);
    train.dispose(this.scene);
    line.owner.money += Math.round(train.locoClass.cost * 0.5);
    return true;
  }

  /** What it costs to re-engine a train with a given class — the new loco less a
   *  trade-in on the old one. */
  reLocoCost(train: Train, newLoco: LocoClass): number {
    return newLoco.cost - Math.round(train.locoClass.cost * 0.5);
  }

  /** Swap a train's locomotive for a different class in place — keeping its consist,
   *  cargo, and position on the line — for the price difference (less a trade-in on the
   *  old engine). The train's slot in the line is preserved. */
  replaceLoco(line: GLine, train: Train, newLoco: LocoClass): boolean {
    if (line.owner !== this.player || this.status !== 'playing') return false;
    if (newLoco.id === train.locoClass.id) return false;
    const idx = line.trains.indexOf(train);
    if (idx < 0) return false;
    const net = this.reLocoCost(train, newLoco);
    if (net > line.owner.money) return false;
    // Capture the old engine's consist, cargo, and exact position.
    const carKinds = train.consist.map((c) => c.kind);
    const cargo = train.consist.map((c) => ({
      amount: c.amount,
      origin: [c.origin.x, c.origin.y, c.origin.z] as [number, number, number],
    }));
    const dist = train.railDist;
    const dir = train.heading;
    line.owner.money -= net;
    // Retire the old engine and roll the new one out into the same slot.
    train.dispose(this.scene);
    line.trains.splice(idx, 1);
    this.spawnTrain(line, newLoco, carKinds);
    const nt = line.trains.pop()!; // spawnTrain appended it
    line.trains.splice(idx, 0, nt);
    nt.restore(dist, dir, cargo);
    this.onBuilt?.();
    return true;
  }

  // ── Washouts: storms periodically knock out a line until it's rebuilt or repaired ──

  /** A short, readable name for a line (its end cities) — used in headlines. */
  private lineName(line: GLine): string {
    return line.stops.length ? `${line.stops[0].name}↔${line.stops[line.stops.length - 1].name}` : 'a line';
  }

  /** Is this line currently washed out (trains halted)? */
  isBlocked(line: GLine): boolean {
    return line.blockedUntil > this.clock;
  }

  /** What an emergency repair to reopen a washed-out line costs. */
  washoutRepairCost(line: GLine): number {
    return Math.max(WASHOUT_REPAIR_MIN, Math.round(line.value * WASHOUT_REPAIR_FRAC));
  }

  /** Knock out a line: halt its trains until it rebuilds (or is repaired). */
  washoutLine(line: GLine, duration = WASHOUT_DURATION): boolean {
    if (line.through || this.isBlocked(line) || this.lines.indexOf(line) < 0) return false;
    line.blockedUntil = this.clock + duration;
    this.onNews?.(`⛈ Storm washes out the ${this.lineName(line)} line — service halted`, false);
    this.onBuilt?.();
    return true;
  }

  /** A storm strikes a random running line — the disaster the EventDirector occasionally
   *  triggers in the live game. Picks a real, trafficked, not-already-stricken line. */
  triggerRandomWashout(): boolean {
    const candidates = this.lines.filter((l) => !l.through && l.trains.length > 0 && !this.isBlocked(l));
    if (!candidates.length) return false;
    return this.washoutLine(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  /** Pay to reopen a washed-out line at once (the owner's call). */
  repairLine(line: GLine): boolean {
    if (!this.isBlocked(line) || line.owner !== this.player || this.status !== 'playing') return false;
    const cost = this.washoutRepairCost(line);
    if (cost > line.owner.money) return false;
    line.owner.money -= cost;
    line.blockedUntil = 0;
    this.onNews?.(`The ${this.lineName(line)} line is repaired and running again`, true);
    this.onBuilt?.();
    return true;
  }

  // ── Haul contracts: time-limited delivery jobs for a premium reward ──

  /** Post a contract on the board (used by the periodic generator and the test harness). */
  addContract(station: GStation, cargo: CargoKind, quantity: number, reward: number, deadlineYear: number): Contract {
    const c: Contract = {
      id: this.nextContractId++,
      station,
      cargo,
      quantity,
      delivered: 0,
      reward,
      deadlineYear,
      status: 'offered',
    };
    this.contracts.push(c);
    return c;
  }

  /** How many contracts the player has under way right now. */
  activeContracts(): number {
    return this.contracts.filter((c) => c.status === 'active').length;
  }

  /** Take on an offered contract (limited slots). */
  acceptContract(c: Contract): boolean {
    if (c.status !== 'offered' || this.status !== 'playing') return false;
    if (this.activeContracts() >= CONTRACT_MAX_ACTIVE) return false;
    c.status = 'active';
    this.onBuilt?.();
    return true;
  }

  /** Count a player delivery toward any matching active contract; fulfilment pays out. */
  creditContracts(station: GStation, cargo: CargoKind, amount: number): void {
    for (const c of this.contracts) {
      if (c.status !== 'active' || c.station !== station || c.cargo !== cargo) continue;
      c.delivered += amount;
      if (c.delivered >= c.quantity) {
        c.status = 'done';
        this.contractsDone += 1; // counts toward a contracts objective
        this.player.money += c.reward;
        this.pushDelivery(`Contract: ${c.quantity} ${cargo} → ${station.name}`, c.reward);
        this.onNews?.(`Contract fulfilled — ${c.quantity} ${cargo} to ${station.name}, +$${c.reward.toLocaleString()}`, true, station.pos);
        this.onBuilt?.();
      }
    }
  }

  /** Post new jobs up to the board cap, and resolve those whose deadline has passed. Only
   *  meaningful in the live game — the player has to be there to accept and work them. */
  private tickContracts(dt: number): void {
    for (const c of this.contracts) {
      if ((c.status === 'active' || c.status === 'offered') && this.year > c.deadlineYear) {
        if (c.status === 'active') this.onNews?.(`Contract lapsed — ${c.cargo} to ${c.station.name}`, false);
        c.status = 'failed';
      }
    }
    // Keep the resolved tail from growing forever (board stays small).
    while (this.contracts.length > 12 && (this.contracts[0].status === 'done' || this.contracts[0].status === 'failed')) {
      this.contracts.shift();
    }
    this.contractTimer -= dt;
    if (this.contractTimer > 0) return;
    this.contractTimer = CONTRACT_INTERVAL;
    if (this.contracts.filter((c) => c.status === 'offered').length >= CONTRACT_MAX_OFFERED) return;
    // A depot city that wants something a railroad could bring it.
    const cities = this.stations.filter((s) => s.hasStation && s.demands.size > 0);
    if (!cities.length) return;
    const city = cities[Math.floor(Math.random() * cities.length)];
    const wants = [...city.demands];
    const cargo = wants[Math.floor(Math.random() * wants.length)];
    const quantity = 60 + Math.floor(Math.random() * 8) * 20; // 60…200, rounded
    const reward = Math.round(quantity * CARGO[cargo].basePrice * CONTRACT_REWARD_FACTOR);
    const deadlineYear = this.year + 5 + Math.floor(Math.random() * 6);
    this.addContract(city, cargo, quantity, reward, deadlineYear);
  }

  /** Demolish a whole line: scrap its trains and rails, refund part of the grading. */
  demolishLine(line: GLine): boolean {
    if (this.status !== 'playing') return false; // no teardown once the game is decided (matches the other mutators)
    for (const t of [...line.trains]) t.dispose(this.scene);
    line.trains.length = 0;
    this.scene.remove(line.track.group);
    line.track.dispose();
    line.owner.money += Math.round(line.value * 0.4);
    const gi = this.lines.indexOf(line);
    if (gi >= 0) this.lines.splice(gi, 1);
    const oi = line.owner.lines.indexOf(line);
    if (oi >= 0) line.owner.lines.splice(oi, 1);
    return true;
  }

  /** Upgrade a city's depot (higher levels add a haul-revenue bonus there). */
  upgradeStation(st: GStation): boolean {
    if (st.level >= MAX_STATION_LEVEL || this.status !== 'playing') return false;
    const cost = this.stationUpgradeCost(st);
    if (cost > this.player.money) return false;
    this.player.money -= cost;
    st.level += 1;
    this.onBuilt?.();
    return true;
  }

  stationUpgradeCost(st: GStation): number {
    return 90_000 * (st.level + 1);
  }

  /** Put a train on a line, staggered so multiple trains don't ride on top of one
   *  another, and wire its stop servicing to the line's owner. */
  private spawnTrain(line: GLine, loco: LocoClass, cars: CargoKind[]): void {
    const train = new Train(line.track, this.scene, loco, line.stopFracs, cars);
    train.offsetStart(line.trains.length * 0.28);
    this.scene.add(train.group);
    train.onStop = (i) => this.serviceTrain(line, train, line.stops[i]);
    train.onBreakdown = () => {
      const fee = Math.round(loco.cost * 0.04);
      line.owner.money -= fee;
      if (line.owner === this.player) {
        this.pushDelivery(`${loco.name} broke down — repairs`, -fee);
        this.onBuilt?.();
      }
    };
    line.trains.push(train);
  }

  /** Get a broken engine out of the shop immediately (the breakdown bill was already
   *  charged when it failed). Only the line's owner can order the repair. */
  repairTrain(line: GLine, train: Train): boolean {
    if (!train.broken || line.owner !== this.player || this.status !== 'playing') return false;
    train.repair();
    this.onBuilt?.();
    return true;
  }

  /** Service each car at a berth: a car whose cargo the city demands unloads (paying
   *  the owner, scaled by the station's upgrade level), then every car tops up with its
   *  own assigned cargo from the city's stock. Typed cars only carry their own kind. */
  private serviceTrain(line: GLine, train: Train, at: GStation): void {
    const owner = line.owner;
    line.trips += 1; // arriving at a berth completes a leg
    // Maintenance buildings: a roundhouse services the engine, a water tower speeds the
    // turnaround. Both act on the train the moment it berths here.
    if (at.buildings.has('roundhouse')) train.maintain();
    if (at.buildings.has('watertower')) train.expediteDwell();
    const bonus = 1 + at.level * STATION_BONUS;
    const inputCap = this.stockCap(at);
    const loadCap = this.loadPerStop(at);
    const wants = this.effectiveDemands(at); // own demands + the whole catchment's
    let playerRev = 0; // summed across the consist, floated up as one figure
    for (const car of train.consist) {
      // Unload. The price paid falls as this market saturates on the cargo, then the
      // delivery saturates it a little more (it recovers between trains, in update()).
      if (car.amount > 0 && wants.has(car.kind)) {
        const dist = car.origin.distanceTo(at.pos);
        const mult = marketMult(at.sat.get(car.kind) ?? 0);
        const rev = Math.round(
          haulRevenue(car.kind, car.amount, dist) * bonus * mult * this.priceModifier(car.kind) * this.stationRevenueMult(at, car.kind)
        );
        at.sat.set(car.kind, Math.min(1, (at.sat.get(car.kind) ?? 0) + car.amount * SAT_PER_UNIT));
        owner.money += rev;
        at.revenue += rev; // per-stop earnings tally
        line.earned += rev; // the line's own income, for its profit/trip readout
        if (!owner.isAI) {
          this.pushDelivery(`${Math.floor(car.amount)} ${car.kind} → ${at.name}`, rev);
          this.onRevenue?.(rev);
          this.creditContracts(at, car.kind, car.amount); // a delivery may fulfil a contract
          this.cargoHauled.set(car.kind, (this.cargoHauled.get(car.kind) ?? 0) + car.amount); // toward a cargo objective
          playerRev += rev;
        }
        if (at.recipe && car.kind in at.recipe.inputs) {
          at.input.set(car.kind, Math.min(inputCap, (at.input.get(car.kind) ?? 0) + car.amount));
        } else {
          // A hotel turns served passengers into faster prosperity growth.
          const grow = at.buildings.has('hotel') && car.kind === 'passengers' ? HOTEL_GROWTH : 1;
          at.served += car.amount * grow;
        }
        car.amount = 0;
      }
      // Load this car's assigned cargo from the city's stock (up to its car's capacity).
      const room = carCapacity(car.kind) - car.amount;
      if (room > 0) {
        const have = at.stock.get(car.kind) ?? 0;
        const take = Math.min(room, have, loadCap);
        if (take >= 1) {
          at.stock.set(car.kind, have - take);
          if (car.amount === 0) car.origin.copy(at.pos);
          car.amount += take;
          if (at.owner) at.owner.money += take * INDUSTRY_ROYALTY;
        }
      }
    }
    if (playerRev > 0) this.onDeliveryPop?.(train.headPosition.clone(), playerRev);
  }

  /** Run a processor's recipe for one tick: make as many output units as inputs and
   *  stockpile room allow, consuming the inputs proportionally. */
  private process(s: GStation, dt: number): void {
    const rc = s.recipe!;
    let batch = rc.rate * dt;
    for (const k of Object.keys(rc.inputs) as CargoKind[]) {
      batch = Math.min(batch, (s.input.get(k) ?? 0) / rc.inputs[k]!);
    }
    batch = Math.min(batch, this.stockCap(s) - (s.stock.get(rc.output) ?? 0));
    if (batch <= 0) return;
    for (const k of Object.keys(rc.inputs) as CargoKind[]) {
      s.input.set(k, (s.input.get(k) ?? 0) - rc.inputs[k]! * batch);
    }
    s.stock.set(rc.output, (s.stock.get(rc.output) ?? 0) + batch);
  }

  /** Add an outer ring of houses each time a city crosses a growth milestone, and lift it
   *  up the settlement ladder — each new stage brings new appetites. `announce` posts a
   *  headline for the notable milestones (suppressed when re-growing a loaded save). */
  private maybeGrowCity(s: GStation, announce = false): void {
    let grew = false;
    while (s.tier < GROWTH_TIERS.length && s.growth >= GROWTH_TIERS[s.tier]) {
      s.tier++;
      grew = true;
    }
    if (grew) this.rebuildTown(s); // re-lay all rings (the new outer one included), off the rails
    const target = Math.min(STAGES.length - 1, s.archetype.size + s.tier);
    while (s.stage < target) {
      s.stage += 1;
      for (const k of STAGE_DEMANDS[s.stage]) s.demands.add(k); // new cargo it now buys
      if (announce && s.stage >= 2) this.onNews?.(`${s.name} has grown into a ${STAGES[s.stage]} — click to view`, true, s.pos);
    }
  }

  /** A settlement's stage title (Hamlet … Metropolis). */
  stageName(s: GStation): string {
    return STAGES[Math.min(STAGES.length - 1, Math.max(0, s.stage))];
  }

  /** Display label combining a station's growth stage and its type, deduped so a plain
   *  "City · City" reads simply as "City". */
  stationLabel(s: GStation): string {
    const stage = this.stageName(s);
    return stage === s.archetype.kind ? stage : `${stage} · ${s.archetype.kind}`;
  }

  private pushDelivery(text: string, amount: number): void {
    this.deliveries.unshift({ text, amount });
    if (this.deliveries.length > 6) this.deliveries.pop();
  }

  update(dt: number): void {
    if (this.status !== 'playing') return;
    this.clock += dt;

    for (const s of this.stations) {
      // Prosperity decays without service and is recomputed into a 1..3 multiplier.
      s.served = Math.max(0, s.served - s.served * 0.05 * dt);
      s.growth = 1 + Math.min(2, s.served / SERVE_FULL);
      this.maybeGrowCity(s, true);

      // Markets recover toward fresh while they go unfed — the price they pay creeps
      // back up, so a corridor abandoned for a while is lucrative to return to.
      if (s.sat.size) for (const [k, v] of s.sat) if (v > 0) s.sat.set(k, Math.max(0, v - SAT_RECOVERY * dt));

      // Only depots accrue stock — gathering their whole catchment (already
      // prosperity-scaled). A city with no depot in range has no outlet for its cargo.
      if (s.hasStation) {
        const cap = this.stockCap(s);
        for (const [kind, rate] of this.effectiveSupplies(s)) {
          const cur = s.stock.get(kind) ?? 0;
          if (cur < cap) s.stock.set(kind, Math.min(cap, cur + rate * dt));
        }
        // A factory ships finished goods only through its own depot.
        if (s.recipe) this.process(s, dt);
      }
    }
    // Single track: opposing trains can't share a segment, so dispatch decides who waits.
    this.dispatch();
    // Same-line spacing: a train holds short of the nearest same-direction leader on its own
    // line (precise arc-length — robust on curves). A train pulled aside at a stop is off the
    // running line, so it neither blocks a follower nor is one.
    for (const l of this.lines) {
      const ts = l.trains;
      for (const t of ts) {
        let leader: number | null = null;
        let bestGap = Infinity;
        for (const o of ts) {
          if (o === t || o.heading !== t.heading || o.isParked) continue;
          const gap = (o.railDist - t.railDist) * t.heading;
          if (gap > 0 && gap < bestGap) {
            bestGap = gap;
            leader = o.railDist;
          }
        }
        t.setBlock(leader);
      }
    }
    // Cross-line junctions: a train also holds if a train on ANOTHER line is close
    // ahead on the same physical rail (world space), so services that share rails at
    // junctions don't telescope.
    this.signal();
    for (const l of this.lines) {
      // A washed-out line halts its trains where they stand until it rebuilds (clock
      // passes blockedUntil) or the owner pays for an emergency repair.
      if (l.blockedUntil > 0) {
        if (this.clock >= l.blockedUntil) {
          l.blockedUntil = 0;
          this.onNews?.(`The ${this.lineName(l)} line has rebuilt and reopened`, true);
        } else {
          for (const t of l.trains) t.worldHold = true;
        }
      }
      for (const t of l.trains) t.update(dt);
    }

    // Maintenance and bond interest bleed every company's books continuously.
    for (const c of this.companies) {
      c.money -= ((c.upkeepPerYear + c.interestPerYear) / SECONDS_PER_YEAR) * dt;
      if (c.isAI && !c.defunct) this.planAI(c, dt);
    }

    this.yearAccum += dt;
    if (this.yearAccum >= SECONDS_PER_YEAR) {
      this.yearAccum -= SECONDS_PER_YEAR;
      this.year += 1;
      this.payDividends();
    }
    this.tickContracts(dt);

    // Resolve the player's objective. The game runs toward the top medal (or the deadline)
    // rather than ending the instant it crosses the bronze line, so the medal earned reflects
    // how well the railroad actually did. Bankruptcy is a loss regardless of objective kind.
    const { bronze, gold } = this.medalThresholds();
    const progress = this.objectiveProgress();
    if (this.player.money < DEBT_LIMIT) {
      this.status = 'lost';
    } else if (progress >= gold) {
      this.status = 'won';
      this.earnedMedal = 'gold';
    } else if (this.year > this.goal.byYear) {
      if (progress >= bronze) {
        this.status = 'won';
        this.earnedMedal = this.medalFor(progress);
      } else {
        this.status = 'lost';
      }
    }
  }

  /** Current value of the active objective, in its own units (dollars / cargo / cities / jobs). */
  objectiveProgress(): number {
    switch (this.goal.kind) {
      case 'cargo':
        return this.goal.cargo ? this.cargoHauled.get(this.goal.cargo) ?? 0 : 0;
      case 'connect':
        return this.playerCitiesConnected();
      case 'contracts':
        return this.contractsDone;
      default:
        return this.player.netWorth;
    }
  }

  /** The largest set of cities the player has linked into one continuous network. */
  playerCitiesConnected(): number {
    const lines = this.player.lines.filter((l) => !l.through && l.stops.length >= 2);
    if (!lines.length) return 0;
    const adj = new Map<GStation, Set<GStation>>();
    const link = (a: GStation, b: GStation) => {
      let set = adj.get(a);
      if (!set) adj.set(a, (set = new Set()));
      set.add(b);
    };
    for (const l of lines) {
      for (let i = 0; i < l.stops.length; i++) {
        for (let j = i + 1; j < l.stops.length; j++) {
          link(l.stops[i], l.stops[j]);
          link(l.stops[j], l.stops[i]);
        }
      }
    }
    const seen = new Set<GStation>();
    let best = 0;
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      let n = 0;
      const queue = [start];
      seen.add(start);
      while (queue.length) {
        const s = queue.pop()!;
        n++;
        for (const nb of adj.get(s) ?? []) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
      }
      best = Math.max(best, n);
    }
    return best;
  }

  /** The tier bars for each victory medal, in the objective's own units. */
  medalThresholds(): { bronze: number; silver: number; gold: number } {
    return { bronze: this.goal.bronze, silver: this.goal.silver, gold: this.goal.gold };
  }

  /** The medal a given objective value would earn (none below the bronze tier). */
  medalFor(progress: number): Medal {
    const { bronze, silver, gold } = this.medalThresholds();
    if (progress >= gold) return 'gold';
    if (progress >= silver) return 'silver';
    if (progress >= bronze) return 'bronze';
    return 'none';
  }

  /** One-line description of what the player is playing toward. */
  objectiveLabel(): string {
    const o = this.goal;
    switch (o.kind) {
      case 'cargo':
        return `Haul ${o.cargo && CARGO[o.cargo] ? CARGO[o.cargo].label.toLowerCase() : 'cargo'} by ${o.byYear}`;
      case 'connect':
        return `Link cities into one network by ${o.byYear}`;
      case 'contracts':
        return `Fulfil haul contracts by ${o.byYear}`;
      default:
        return `Build net worth by ${o.byYear}`;
    }
  }

  /** Format a value in the active objective's units (e.g. "$2.5M", "400 coal", "8 cities"). */
  formatObjective(value: number): string {
    const o = this.goal;
    switch (o.kind) {
      case 'cargo':
        // Cargo labels are mass/collective nouns ("coal", "steel", "passengers"), so they
        // take no plural 's' — "600 coal" is correct, "600 coals" would not be.
        return `${Math.floor(value)} ${o.cargo && CARGO[o.cargo] ? CARGO[o.cargo].label.toLowerCase() : ''}`.trim();
      case 'connect':
        return `${Math.floor(value)} ${Math.floor(value) === 1 ? 'city' : 'cities'}`;
      case 'contracts':
        return `${Math.floor(value)} ${Math.floor(value) === 1 ? 'contract' : 'contracts'}`;
      default:
        return `$${(value / 1e6).toFixed(value >= 1e6 ? 1 : 2)}M`;
    }
  }

  /** Single-track block reservation. With one running line, two trains heading toward each
   *  other can't share a segment, so a berthed train won't depart into the stretch ahead while
   *  an opposing train holds it — it waits at the stop (pulled aside so the other runs through).
   *  When two berthed trains contest the same stretch from opposite ends, the one that's waited
   *  longer goes first (so neither starves). Two trains on a bare line thus take turns — the cost
   *  of over-running it; an intermediate stop gives them a place to pass without one waiting long. */
  private dispatch(): void {
    for (const l of this.lines) {
      const ts = l.trains;
      if (ts.length < 2) continue;
      // 1) Decide which berthed trains must hold before leaving their stop, so opposing trains
      //    never share a stretch OR converge on the same stop — they wait at a station instead.
      const held: boolean[] = new Array(ts.length).fill(false);
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        const seg = t.nextSegment();
        if (!seg) continue; // out on the line (committed) or nowhere to go
        const dest = t.targetArc(); // the stop t is about to head for
        for (let j = 0; j < ts.length && !held[i]; j++) {
          if (j === i) continue;
          const o = ts[j];
          // (a) an opposing train is already out on this stretch — can't enter behind it.
          if (o.heading !== seg.dir && o.insideSegment(seg.lo, seg.hi)) {
            held[i] = true;
            break;
          }
          // (b) an opposing train berthed at the far end wants the same stretch — contest;
          //     the longer-waiting train wins (tiebreak: lower index), the other holds.
          const os = o.nextSegment();
          if (os && os.lo === seg.lo && os.hi === seg.hi && os.dir !== seg.dir) {
            if (o.waitedFor > t.waitedFor || (o.waitedFor === t.waitedFor && j < i)) held[i] = true;
          }
          // (c) destination-stop reservation: another train is bound for the same stop from the
          //     FAR side. A moving one has right of way (it can't stop on a dime); a berthed one
          //     is a contest. Either way t waits at its stop rather than both meeting in motion.
          else if (o.targetArc() === dest && (o.railDist - dest) * seg.dir > -3) {
            if (o.isMoving() || o.waitedFor > t.waitedFor || (o.waitedFor === t.waitedFor && j < i)) held[i] = true;
          }
        }
      }
      for (let i = 0; i < ts.length; i++) ts[i].setHoldAtStop(held[i]);
      // 2) Pull a train aside only while it's STOPPED at a station sharing it with another (a
      //    siding) — a moving train always stays on the centreline (never runs off at an angle).
      for (let i = 0; i < ts.length; i++) {
        const si = ts[i].atStopIndex();
        if (si < 0) { ts[i].setParked(false); continue; } // moving — on the rail
        let aside = held[i];
        for (let j = 0; j < i && !aside; j++) if (ts[j].atStopIndex() === si) aside = true;
        ts[i].setParked(aside);
      }
    }
  }

  /** Cross-line collision signalling in world space: a train holds when another train is close
   *  ahead of it on the same physical rail, so services that share rails at junctions don't
   *  telescope. A train pulled aside at a stop is off the running line and ignored. */
  private signal(): void {
    const SAME_RAIL = TRACK_SIDE * 1.5; // lateral tolerance: within one rail
    const AHEAD_GAP = 16; // hold this far behind the train in front
    const entries: { t: Train; line: GLine }[] = [];
    for (const l of this.lines) for (const t of l.trains) entries.push({ t, line: l });
    for (const e of entries) e.t.worldHold = false;
    for (const e of entries) {
      if (e.t.isParked) continue;
      const p = e.t.headPosition;
      const f = e.t.worldForward;
      if (f.lengthSq() < 0.1) continue;
      for (const o of entries) {
        if (o.line === e.line || o.t.isParked) continue; // same-line spacing is the arc block's job
        // Only a same-direction leader can be telescoped into. Two trains meeting head-on at a
        // junction are on separate, diverging single tracks — they pass, they don't deadlock.
        const of = o.t.worldForward;
        if (of.x * f.x + of.z * f.z < -0.3) continue;
        const dx = o.t.headPosition.x - p.x;
        const dz = o.t.headPosition.z - p.z;
        const ahead = dx * f.x + dz * f.z; // distance ahead along the heading
        if (ahead <= 0 || ahead > AHEAD_GAP) continue;
        const lateral = Math.abs(dx * -f.z + dz * f.x); // perpendicular distance
        if (lateral > SAME_RAIL) continue;
        e.t.worldHold = true;
        break;
      }
    }
  }

  /** Annual dividend: each solvent company pays a slice of its operating value to its
   *  shareholders, drawn from its own cash — so holding a rival's stock is an income
   *  stream (and a drain on them), not just a bet on the price. */
  private payDividends(): void {
    for (const c of this.companies) {
      if (c.defunct) continue;
      const pool = Math.max(0, c.assetWorth) * DIVIDEND_RATE;
      if (pool < 1) continue;
      for (const holder of this.companies) {
        const held = holder.holdings.get(c) ?? 0;
        if (held <= 0) continue;
        const cut = pool * (held / c.shares);
        c.money -= cut;
        holder.money += cut;
        if (holder === this.player) this.pushDelivery(`${c.name} dividend`, Math.round(cut));
      }
    }
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
    if (c.aiTimer > 0) return;
    c.aiTimer = this.aiInterval;
    if (c.defunct) return;

    // One measured move per turn, in priority order: keep the books healthy, scale the
    // winners, sharpen the network, then expand it, and finally park spare cash in stock.
    if (c.debt > 0 && c.money > this.aiReserve * 4) {
      c.repayDebt(Math.min(c.debt, c.money - this.aiReserve * 3));
      return;
    }
    if (this.aiReinforce(c)) return;
    if (this.aiUpgrade(c)) return;
    if (this.aiExpand(c)) return;
    this.aiInvest(c);
  }

  /** Put another train on a busy line of the AI's — one whose stops have a real backlog of
   *  waiting cargo and that isn't already at its train cap. */
  private aiReinforce(c: Company): boolean {
    const loco = defaultLoco(this.year);
    if (loco.cost > c.money - this.aiReserve) return false;
    let best: GLine | null = null;
    let bestWaiting = 90; // need a genuine backlog before adding capacity
    for (const l of c.lines) {
      if (l.through || l.stops.length < 2) continue;
      let waiting = 0;
      for (const s of l.stops) for (const v of s.stock.values()) waiting += v;
      // Capacity scales with the backlog, not the route length: a line drowning in waiting
      // cargo earns another train even if it's short (a cheap line can still be a busy one).
      const cap = Math.min(3, 1 + Math.floor(waiting / 140));
      if (l.trains.length >= cap) continue;
      if (waiting > bestWaiting) {
        bestWaiting = waiting;
        best = l;
      }
    }
    return best ? this.addTrain(best, loco) : false;
  }

  /** Improve the AI's best-earning depot: raise its level, else add a warehouse. */
  private aiUpgrade(c: Company): boolean {
    let dep: GStation | null = null;
    let bestRev = -1;
    for (const s of this.stations) {
      if (s.depots.has(c) && s.revenue > bestRev) {
        bestRev = s.revenue;
        dep = s;
      }
    }
    if (!dep) return false;
    if (dep.level < MAX_STATION_LEVEL) {
      const cost = this.stationUpgradeCost(dep);
      if (cost <= c.money - this.aiReserve) {
        c.money -= cost;
        dep.level += 1;
        return true;
      }
    }
    if (!dep.buildings.has('warehouse')) {
      const cost = STATION_BUILDINGS.warehouse.cost;
      if (cost <= c.money - this.aiReserve) {
        c.money -= cost;
        dep.buildings.add('warehouse');
        this.placeStationStructure(dep, 'warehouse');
        return true;
      }
    }
    return false;
  }

  /** Build the cheapest unbuilt trading corridor, scaling the network cap with net worth
   *  and floating a bond to cover a shortfall when the company is creditworthy. */
  private aiExpand(c: Company): boolean {
    // Cap the network by CITIES SERVED, not line count — extending grows the trunk without
    // adding lines, so a line cap would let it expand forever and never invest its profits.
    const cap = Math.min(13, 4 + Math.floor(Math.max(0, c.netWorth) / 1_200_000));
    const served = c.lines.reduce((a, l) => a + (l.through ? 0 : l.stops.length), 0);
    if (served >= cap) return false;
    const loco = defaultLoco(this.year);
    // Build OUT from its own network, just like the player — once it has any track, a new line
    // must touch a city it already serves (its first line bootstraps the network from anywhere).
    const rooted = c.lines.length > 0;
    let best: { a: GStation; b: GStation; cost: number } | null = null;
    for (let i = 0; i < this.stations.length; i++) {
      for (let j = i + 1; j < this.stations.length; j++) {
        const a = this.stations[i];
        const b = this.stations[j];
        if (c.connects(a, b)) continue;
        if (!this.offersOf(a).some((k) => b.demands.has(k)) && !this.offersOf(b).some((k) => a.demands.has(k))) continue;
        // Once it has track, only EXTEND from a free END of a line — never branch a new line off
        // a city it passes through (that's the right-angle T). Its network grows as a curving trunk.
        if (rooted && !this.aiEndAt(c, a) && !this.aiEndAt(c, b)) continue;
        if (this.lineCountAt(c, a) >= this.maxLinesPerStation || this.lineCountAt(c, b) >= this.maxLinesPerStation) continue;
        // It must build its OWN depot at any endpoint it doesn't already serve — a rival's
        // depot is no use to it.
        const depots = (a.depots.has(c) ? 0 : STATION_COST) + (b.depots.has(c) ? 0 : STATION_COST);
        const cost = this.lineCost([a.pos, b.pos], loco) + depots;
        if (!best || cost < best.cost) best = { a, b, cost };
      }
    }
    if (!best) return false;
    // Fund a shortfall with a bond, but only a creditworthy, proportionate one.
    const shortfall = best.cost - (c.money - this.aiReserve);
    if (shortfall > 0 && shortfall <= c.creditLimit && best.cost < Math.max(0, c.netWorth) * 0.5) {
      c.issueBond(Math.ceil(shortfall));
    }
    if (best.cost > c.money - this.aiReserve) return false;
    for (const st of [best.a, best.b]) {
      if (!st.depots.has(c)) {
        c.money -= STATION_COST;
        this.placeDepot(st, c);
      }
    }
    // Prefer EXTENDING a line that already ends at one of these cities — continuous track that
    // curves out of the old end — over a fresh line that would T at the shared city. Its existing
    // train just shuttles the longer route.
    const endA = this.aiEndAt(c, best.a);
    const endB = this.aiEndAt(c, best.b);
    if (endA) return this.extendLine(endA.line, endA.end, [best.b.pos], best.b);
    if (endB) return this.extendLine(endB.line, endB.end, [best.a.pos], best.a);
    return this.buildLineFor(c, [best.a.pos, best.b.pos], [best.a, best.b], loco);
  }

  /** A line of this company that terminates AT this city (so it can be extended onward), or null. */
  private aiEndAt(c: Company, city: GStation): { line: GLine; end: 'head' | 'tail' } | null {
    for (const l of c.lines) {
      if (l.through || l.stops.length < 1) continue;
      if (l.stops[l.stops.length - 1] === city) return { line: l, end: 'tail' };
      if (l.stops[0] === city) return { line: l, end: 'head' };
    }
    return null;
  }

  /** Park spare cash in the cheapest rival's stock — accumulating toward a takeover of
   *  another railroad, or a (capped) income position in the player. */
  private aiInvest(c: Company): boolean {
    const spare = c.money - this.aiReserve * 2.5;
    if (spare < 60_000) return false;
    let target: Company | null = null;
    let cheapest = Infinity;
    for (const o of this.companies) {
      if (o === c || o.defunct || !o.isAI) continue;
      if (o.sharePrice < cheapest) {
        cheapest = o.sharePrice;
        target = o;
      }
    }
    const allowTakeover = !!target; // an AI rival can be absorbed; the player cannot
    if (!target && !this.player.defunct) target = this.player;
    if (!target) return false;
    let qty = Math.min(Math.floor((spare * 0.5) / target.sharePrice), Math.floor(target.shares * 0.08));
    if (!allowTakeover) {
      // Cap a stake in the player to a quarter — a position, not a coup.
      const room = Math.floor(target.shares * 0.25) - (c.holdings.get(target) ?? 0);
      qty = Math.min(qty, Math.max(0, room));
    }
    if (qty < 100) return false;
    return this.companyBuyShares(c, target, qty, allowTakeover);
  }
}
