/**
 * The roster of buyable steam power. Classes are the historical American wheel
 * arrangements, gated by their introduction year so the era you're playing limits the
 * power you can field. Stats drive the actual simulation: cruise speed, freight
 * capacity, purchase price, and annual maintenance (the money sink that makes a fleet
 * a liability as well as an asset). Diesel/electric era classes wait on new models.
 */
export interface LocoClass {
  id: string;
  name: string;
  wheel: string;
  /** Year the class becomes available to buy. */
  year: number;
  /** Cruise speed, world units/sec. */
  speed: number;
  /** Cargo capacity, units. */
  capacity: number;
  /** Purchase price. */
  cost: number;
  /** Maintenance, $/year. */
  upkeep: number;
}

export const LOCOS: LocoClass[] = [
  { id: 'grasshopper', name: 'Grasshopper', wheel: '0-4-0', year: 1830, speed: 15, capacity: 40, cost: 26000, upkeep: 5000 },
  { id: 'american', name: 'American', wheel: '4-4-0', year: 1850, speed: 23, capacity: 60, cost: 42000, upkeep: 8000 },
  { id: 'mogul', name: 'Mogul', wheel: '2-6-0', year: 1866, speed: 22, capacity: 90, cost: 64000, upkeep: 11000 },
  { id: 'tenwheeler', name: 'Ten-Wheeler', wheel: '4-6-0', year: 1880, speed: 29, capacity: 95, cost: 96000, upkeep: 14000 },
  { id: 'consolidation', name: 'Consolidation', wheel: '2-8-0', year: 1875, speed: 19, capacity: 150, cost: 88000, upkeep: 15000 },
  { id: 'pacific', name: 'Pacific', wheel: '4-6-2', year: 1902, speed: 37, capacity: 110, cost: 148000, upkeep: 20000 },
  { id: 'mountain', name: 'Mountain', wheel: '4-8-2', year: 1923, speed: 33, capacity: 175, cost: 196000, upkeep: 24000 },
];

/** Classes introduced on or before the given year, cheapest first. */
export function availableLocos(year: number): LocoClass[] {
  return LOCOS.filter((l) => l.year <= year).sort((a, b) => a.cost - b.cost);
}

/** The default selection: the best engine available in the given year. */
export function defaultLoco(year: number): LocoClass {
  const avail = availableLocos(year);
  return avail[avail.length - 1] ?? LOCOS[1];
}
