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
  /** Raw extraction rate (units/sec) before catchment scaling. */
  supplies: Partial<Record<CargoKind, number>>;
  /** What it pays to receive and consume. */
  demands: CargoKind[];
  /** Present on processors only. */
  recipe?: Recipe;
}

export const ARCHETYPES: Record<string, Archetype> = {
  city: {
    kind: 'City',
    houses: 22,
    supplies: { passengers: 1.6, mail: 1.1 },
    demands: ['goods', 'grain', 'cattle', 'passengers', 'mail'],
  },
  town: {
    kind: 'Town',
    houses: 11,
    supplies: { passengers: 0.9, mail: 0.6 },
    demands: ['goods', 'mail', 'passengers'],
  },
  farm: {
    kind: 'Farmstead',
    houses: 6,
    supplies: { grain: 1.4, cattle: 0.9 },
    demands: ['goods', 'mail'],
  },
  mine: {
    kind: 'Mining Camp',
    houses: 7,
    supplies: { coal: 1.7 },
    demands: ['goods', 'lumber'],
  },
  mill: {
    kind: 'Timber Mill',
    houses: 8,
    supplies: { lumber: 1.5 },
    demands: ['goods'],
  },
  factory: {
    kind: 'Factory',
    houses: 9,
    supplies: {},
    demands: ['passengers', 'mail'],
    recipe: { inputs: { coal: 1, lumber: 1 }, output: 'goods', rate: 0.55 },
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
      else if (key === 'mine') v = h > 125 || s > 0.36 ? 1 : h > 80 ? 0.4 : 0;
      else v = h > sea + 3 && s < 0.16 ? 1 : 0.5; // city / town / factory want buildable flats
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

    // A few full cities anchor the map; the rest are smaller towns and industries
    // (the catchment fodder), biased by elevation.
    let key: keyof typeof ARCHETYPES;
    if (h > 170) key = 'mine';
    else if (h > 95) key = rng() > 0.5 ? 'mill' : 'mine';
    else if (h > 45) key = rng() > 0.4 ? 'farm' : 'mill';
    else key = picks.length < 3 ? 'city' : rng() > 0.72 ? 'city' : rng() > 0.45 ? 'town' : rng() > 0.5 ? 'farm' : 'factory';
    picks.push({ x, z, key });
  }

  // Guarantee the chain can close: force in any missing link on the best-fitting site.
  for (const need of ['mine', 'mill', 'factory'] as const) {
    if (picks.some((p) => p.key === need)) continue;
    let bi = 0;
    let bs = -Infinity;
    for (let i = 0; i < picks.length; i++) {
      const s = catchment(need, field, picks[i].x, picks[i].z);
      if (s > bs) {
        bs = s;
        bi = i;
      }
    }
    picks[bi].key = need;
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
