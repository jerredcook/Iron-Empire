import * as THREE from 'three';
import { CargoKind } from './Cargo';
import { Heightfield, mulberry32 } from '../world/Heightfield';

const TAU = Math.PI * 2;

/** A processor's conversion: it consumes `inputs` (units per unit of output) and
 *  emits `output` at up to `rate` units/sec, throttled by its input inventory. */
export interface Recipe {
  inputs: Partial<Record<CargoKind, number>>;
  output: CargoKind;
  rate: number;
}

/**
 * The economic character of a place. Raw sites *extract* cargo (`supplies`), cities
 * *consume* it (`demands`), and processors *convert* a delivered raw input into a
 * finished good (`recipe`) that's then hauled onward — the supply chain the whole game
 * turns on: Mine→coal and Mill→lumber feed a Factory that makes goods for the Cities,
 * while Farms feed the cities directly. Archetypes are chosen by terrain.
 */
export interface Archetype {
  kind: string;
  /** Houses rendered in the town cluster. */
  houses: number;
  /** Starting settlement size (0 hamlet … 2 city) — the floor of its growth stage. */
  size: number;
  /** Raw extraction rate (units/sec) before catchment scaling. */
  supplies: Partial<Record<CargoKind, number>>;
  /** What it pays to receive and consume. */
  demands: CargoKind[];
  /** Present on processors only. */
  recipe?: Recipe;
}

/** A settlement's growth stages — its size plus how well it's been served lifts it up
 *  the ladder, and each rung brings new appetites (see STAGE_DEMANDS). */
export const STAGES = ['Hamlet', 'Town', 'City', 'Metropolis'];

/** Extra consumer cargo a place picks up on reaching each stage — a growing populace
 *  wants manufactured goods, then food, then the steel to build itself bigger. */
export const STAGE_DEMANDS: CargoKind[][] = [
  [], // Hamlet — its base demands only
  ['goods'], // Town
  ['furniture', 'cars'], // City — a developed populace wants manufactured goods
  ['paper', 'weapons'], // Metropolis — newsprint and an arsenal
];

export const ARCHETYPES: Record<string, Archetype> = {
  // ── Settlements (consumers) ────────────────────────────────────────────────
  city: {
    kind: 'City',
    houses: 22,
    size: 2,
    supplies: { passengers: 1.6, mail: 1.1 },
    demands: ['food', 'goods', 'furniture', 'cars', 'steel', 'grain', 'cattle', 'fish', 'oil', 'passengers', 'mail'],
  },
  town: {
    kind: 'Town',
    houses: 11,
    size: 1,
    supplies: { passengers: 0.9, mail: 0.6 },
    demands: ['food', 'goods', 'mail', 'passengers'],
  },
  // ── Raw resource sites (pure producers) ────────────────────────────────────
  farm: {
    kind: 'Farmstead',
    houses: 6,
    size: 0,
    supplies: { grain: 1.4, cattle: 0.9 },
    demands: ['goods', 'mail'],
  },
  fishery: {
    kind: 'Fishery',
    houses: 6,
    size: 0,
    supplies: { fish: 1.4 },
    demands: ['goods', 'mail'],
  },
  mine: {
    kind: 'Mining Camp',
    houses: 7,
    size: 0,
    supplies: { coal: 1.7 },
    demands: ['goods', 'lumber'],
  },
  ironmine: {
    kind: 'Iron Mine',
    houses: 7,
    size: 0,
    supplies: { iron: 1.5 },
    demands: ['goods', 'lumber'],
  },
  oilwell: {
    kind: 'Oil Field',
    houses: 6,
    size: 0,
    supplies: { oil: 1.5 },
    demands: ['goods', 'lumber'],
  },
  mill: {
    kind: 'Timber Mill',
    houses: 8,
    size: 0,
    supplies: { lumber: 1.5 },
    demands: ['goods'],
  },
  // ── Processing plants (convert a raw input into a finished good) ────────────
  factory: {
    kind: 'Factory',
    houses: 9,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { coal: 1, lumber: 1 }, output: 'goods', rate: 0.55 },
  },
  steelmill: {
    kind: 'Steelworks',
    houses: 10,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { coal: 1, iron: 1 }, output: 'steel', rate: 0.5 },
  },
  foodplant: {
    kind: 'Grain Mill',
    houses: 8,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { grain: 1 }, output: 'food', rate: 0.6 },
  },
  packinghouse: {
    kind: 'Packing House',
    houses: 8,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { cattle: 1 }, output: 'food', rate: 0.55 },
  },
  cannery: {
    kind: 'Cannery',
    houses: 7,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { fish: 1 }, output: 'food', rate: 0.55 },
  },
  furnitureworks: {
    kind: 'Furniture Works',
    houses: 9,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { lumber: 1 }, output: 'furniture', rate: 0.5 },
  },
  papermill: {
    kind: 'Paper Mill',
    houses: 9,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { lumber: 1 }, output: 'paper', rate: 0.55 },
  },
  refinery: {
    kind: 'Refinery',
    houses: 9,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { oil: 1 }, output: 'goods', rate: 0.55 },
  },
  autoplant: {
    kind: 'Auto Plant',
    houses: 11,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { steel: 1 }, output: 'cars', rate: 0.42 },
  },
  armsfactory: {
    kind: 'Arsenal',
    houses: 10,
    size: 0,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { steel: 1 }, output: 'weapons', rate: 0.4 },
  },
};

const CITY_NAMES = [
  'Ashford', 'Brookline', 'Carrolton', 'Dunmore', 'Eastgate', 'Fairhaven', 'Granger',
  'Holloway', 'Ironton', 'Jericho', 'Kingsbury', 'Lakemont', 'Millbrook', 'Norwood',
  'Oakdale', 'Pinecrest', 'Quarry Bend', 'Redfield', 'Stillwater', 'Thornton',
  'Underwood', 'Vinemont', 'Westcliff', 'Yardley', 'Aldergrove', 'Belcourt', 'Cedarvale',
  'Drayton', 'Elmwood', 'Foxglen', 'Greenport', 'Hartwell', 'Inglewood', 'Juniper Flats',
  'Kestrel', 'Linden', 'Marlow', 'Northbrook', 'Orchard Hill', 'Pemberton',
];

export interface CitySite {
  name: string;
  pos: THREE.Vector3;
  archetype: Archetype;
  /** Catchment-scaled extraction rates (a copy — never mutate the archetype). */
  supplies: Partial<Record<CargoKind, number>>;
}

/**
 * How well the land around a site suits its trade — a catchment multiplier in roughly
 * [0.7, 1.4]. A farm ringed by flat lowland out-produces one wedged in the hills; a
 * mine pays off in steep high country; a mill wants forested mid-slopes. Sampled on
 * two rings around the site.
 */
function catchment(key: string, field: Heightfield, x: number, z: number): number {
  const sea = field.params.seaLevel;
  let score = 0;
  let n = 0;
  for (const r of [55, 110]) {
    for (let a = 0; a < 8; a++) {
      const px = x + Math.cos((a / 8) * TAU) * r;
      const pz = z + Math.sin((a / 8) * TAU) * r;
      const h = field.height(px, pz);
      const s = field.slope(px, pz, 8);
      let v: number;
      if (key === 'farm') v = h > sea + 4 && h < 60 && s < 0.12 ? 1 : s < 0.2 ? 0.4 : 0;
      else if (key === 'mill') v = h > 40 && h < 165 && s > 0.04 && s < 0.42 ? 1 : 0.3;
      else if (key === 'mine' || key === 'ironmine') v = h > 125 || s > 0.36 ? 1 : h > 80 ? 0.4 : 0;
      else if (key === 'fishery') v = h < sea ? 1 : h < sea + 16 ? 0.5 : 0.1; // wants the waterline
      else v = h > sea + 3 && s < 0.16 ? 1 : 0.5; // settlements, plants + oil fields want buildable flats
      score += v;
      n++;
    }
  }
  return 0.7 + (score / n) * 0.7;
}

function scaled(supplies: Partial<Record<CargoKind, number>>, mult: number): Partial<Record<CargoKind, number>> {
  const out: Partial<Record<CargoKind, number>> = {};
  for (const k of Object.keys(supplies) as CargoKind[]) out[k] = +(supplies[k]! * mult).toFixed(3);
  return out;
}

/**
 * Scatter cities across buildable ground. Candidates are rejected underwater, on steep
 * slopes, or too close to a neighbour; the survivor's archetype is biased by elevation,
 * then nudged to guarantee a working supply chain (at least one mine, mill, and
 * factory). Each site's pad is flattened into the heightfield — call before the terrain
 * mesh is built.
 */
export function placeCities(field: Heightfield, seed: number, count: number): CitySite[] {
  const rng = mulberry32(seed ^ 0x1234abcd);
  const half = field.half;
  const sea = field.params.seaLevel;
  let nameI = 0;

  const picks: { x: number; z: number; key: keyof typeof ARCHETYPES }[] = [];
  for (let attempt = 0; attempt < count * 120 && picks.length < count; attempt++) {
    const x = (rng() * 2 - 1) * half * 0.9;
    const z = (rng() * 2 - 1) * half * 0.9;
    const h = field.height(x, z);
    if (h < sea + 3) continue; // no founding towns in the surf
    if (field.slope(x, z, 6) > 0.34) continue; // too steep to grade a town
    // Pack the map densely so a depot's catchment can gather a regional cluster.
    if (picks.some((p) => Math.hypot(p.x - x, p.z - z) < 260)) continue;

    // A few full cities anchor the map; the rest are smaller towns, raw sites, and processing
    // plants (the catchment fodder + supply web), biased by elevation.
    const PLANTS: (keyof typeof ARCHETYPES)[] = [
      'factory', 'steelmill', 'foodplant', 'packinghouse', 'furnitureworks', 'papermill', 'refinery', 'autoplant', 'armsfactory', 'cannery',
    ];
    const plant = (): keyof typeof ARCHETYPES => PLANTS[Math.floor(rng() * PLANTS.length)];
    let key: keyof typeof ARCHETYPES;
    if (h > 170) key = rng() > 0.5 ? 'mine' : 'ironmine';
    else if (h > 95) {
      const r = rng();
      key = r > 0.72 ? 'mill' : r > 0.5 ? 'mine' : r > 0.28 ? 'ironmine' : 'oilwell';
    } else if (h > 45) {
      const r = rng();
      key = r > 0.62 ? 'farm' : r > 0.42 ? 'mill' : r > 0.28 ? 'oilwell' : plant();
    } else if (picks.length < 3) {
      key = 'city';
    } else {
      const r = rng();
      key = r > 0.8 ? 'city' : r > 0.62 ? 'town' : r > 0.48 ? 'farm' : r > 0.36 ? 'fishery' : plant();
    }
    picks.push({ x, z, key });
  }

  // Guarantee every chain can close — raws have a producer, each finished good a plant — by
  // forcing any missing link onto the best-fitting site not already claimed this pass.
  const forced = new Set<number>();
  for (const need of [
    'mine', 'mill', 'factory', 'ironmine', 'steelmill',
    'farm', 'oilwell', 'fishery', 'foodplant', 'furnitureworks', 'papermill', 'autoplant',
  ] as const) {
    if (picks.some((p) => p.key === need)) continue;
    let bi = -1;
    let bs = -Infinity;
    for (let i = 0; i < picks.length; i++) {
      if (forced.has(i)) continue;
      const s = catchment(need, field, picks[i].x, picks[i].z);
      if (s > bs) {
        bs = s;
        bi = i;
      }
    }
    if (bi >= 0) {
      picks[bi].key = need;
      forced.add(bi);
    }
  }

  const sites: CitySite[] = [];
  for (const p of picks) {
    field.addFlat(p.x, p.z, 48);
    const arch = ARCHETYPES[p.key];
    sites.push({
      name: CITY_NAMES[nameI++ % CITY_NAMES.length],
      pos: new THREE.Vector3(p.x, 0, p.z), // y filled after terrain heights settle
      archetype: arch,
      supplies: scaled(arch.supplies, catchment(p.key, field, p.x, p.z)),
    });
  }
  return sites;
}
