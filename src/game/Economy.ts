import * as THREE from 'three';
import { CargoKind } from './Cargo';
import { Heightfield, mulberry32 } from '../world/Heightfield';

/**
 * The economic character of a place. Supplies accrue as waiting stock (units/sec);
 * demands are what a city will pay to receive. Archetypes are chosen by terrain —
 * ports and county seats in the lowlands, mines in the high country, mills at the
 * forest edge — so the map's geography drives the supply chains the player connects.
 */
export interface Archetype {
  kind: string;
  /** Houses rendered in the town cluster. */
  houses: number;
  supplies: Partial<Record<CargoKind, number>>;
  demands: CargoKind[];
}

export const ARCHETYPES: Record<string, Archetype> = {
  city: {
    kind: 'City',
    houses: 22,
    supplies: { passengers: 1.6, mail: 1.1, goods: 0.7 },
    demands: ['passengers', 'mail', 'goods', 'cattle', 'grain', 'coal'],
  },
  town: {
    kind: 'Town',
    houses: 11,
    supplies: { passengers: 0.9, mail: 0.6 },
    demands: ['passengers', 'mail', 'goods', 'lumber'],
  },
  farm: {
    kind: 'Farmstead',
    houses: 6,
    supplies: { grain: 1.4, cattle: 0.9 },
    demands: ['passengers', 'mail', 'goods'],
  },
  mine: {
    kind: 'Mining Camp',
    houses: 7,
    supplies: { coal: 1.7 },
    demands: ['passengers', 'goods', 'lumber'],
  },
  mill: {
    kind: 'Timber Mill',
    houses: 8,
    supplies: { lumber: 1.5 },
    demands: ['passengers', 'goods', 'mail'],
  },
};

const CITY_NAMES = [
  'Ashford', 'Brookline', 'Carrolton', 'Dunmore', 'Eastgate', 'Fairhaven', 'Granger',
  'Holloway', 'Ironton', 'Jericho', 'Kingsbury', 'Lakemont', 'Millbrook', 'Norwood',
  'Oakdale', 'Pinecrest', 'Quarry Bend', 'Redfield', 'Stillwater', 'Thornton',
];

export interface CitySite {
  name: string;
  pos: THREE.Vector3;
  archetype: Archetype;
}

/**
 * Scatter cities across buildable ground. Candidates are rejected underwater, on
 * steep slopes, or too close to an existing city; the survivor's archetype is biased
 * by elevation. Each site's pad is flattened into the heightfield (call before the
 * terrain mesh is built) so depots sit on level ground.
 */
export function placeCities(field: Heightfield, seed: number, count: number): CitySite[] {
  const rng = mulberry32(seed ^ 0x1234abcd);
  const sites: CitySite[] = [];
  const half = field.half;
  const sea = field.params.seaLevel;
  let nameI = 0;

  for (let attempt = 0; attempt < count * 80 && sites.length < count; attempt++) {
    const x = (rng() * 2 - 1) * half * 0.86;
    const z = (rng() * 2 - 1) * half * 0.86;
    const h = field.height(x, z);
    if (h < sea + 3) continue; // no founding cities in the surf
    if (field.slope(x, z, 6) > 0.32) continue; // too steep to grade a town
    if (sites.some((s) => Math.hypot(s.pos.x - x, s.pos.z - z) < 480)) continue;

    // Elevation picks the trade: high ground mines, mid-slopes mill timber, the
    // fertile lowlands farm, and the rest are towns with the odd full city.
    let key: keyof typeof ARCHETYPES;
    if (h > 170) key = 'mine';
    else if (h > 95) key = rng() > 0.5 ? 'mill' : 'mine';
    else if (h > 45) key = rng() > 0.45 ? 'farm' : 'mill';
    else key = sites.length < 2 || rng() > 0.6 ? 'city' : rng() > 0.4 ? 'town' : 'farm';

    field.addFlat(x, z, 70);
    sites.push({
      name: CITY_NAMES[nameI++ % CITY_NAMES.length],
      pos: new THREE.Vector3(x, 0, z), // y filled after terrain heights settle
      archetype: ARCHETYPES[key],
    });
  }
  return sites;
}
