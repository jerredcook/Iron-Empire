/**
 * The goods that move on the network. Every economic decision — what a city
 * supplies, what it demands, what a haul pays — is keyed on these. Colours double
 * as the livery of a loaded freight car so a moving train reads its own manifest.
 */
export type CargoKind =
  | 'passengers'
  | 'mail'
  | 'goods'
  | 'grain'
  | 'coal'
  | 'lumber'
  | 'cattle'
  | 'iron'
  | 'steel';

export interface CargoDef {
  kind: CargoKind;
  label: string;
  /** Freight-car livery / HUD swatch. */
  color: number;
  /** Revenue per unit before the distance multiplier. */
  basePrice: number;
}

export const CARGO: Record<CargoKind, CargoDef> = {
  passengers: { kind: 'passengers', label: 'Passengers', color: 0x6db4d6, basePrice: 46 },
  mail: { kind: 'mail', label: 'Mail', color: 0xe8d27a, basePrice: 58 },
  goods: { kind: 'goods', label: 'Goods', color: 0xc06a3a, basePrice: 64 },
  grain: { kind: 'grain', label: 'Grain', color: 0xd9b24a, basePrice: 30 },
  coal: { kind: 'coal', label: 'Coal', color: 0x303034, basePrice: 28 },
  lumber: { kind: 'lumber', label: 'Lumber', color: 0x8a5a32, basePrice: 34 },
  cattle: { kind: 'cattle', label: 'Cattle', color: 0xb89a7a, basePrice: 40 },
  iron: { kind: 'iron', label: 'Iron Ore', color: 0x9a6b4f, basePrice: 32 },
  steel: { kind: 'steel', label: 'Steel', color: 0x7f8a99, basePrice: 78 },
};

export const ALL_CARGO = Object.keys(CARGO) as CargoKind[];

/**
 * What a delivery pays: the cargo's base price times the amount, scaled by how far
 * it travelled. Long hauls of fresh freight are where the money is; the factor is
 * clamped so neither a yard-shunt nor a transcontinental run breaks the economy.
 */
export function haulRevenue(kind: CargoKind, amount: number, distance: number): number {
  const distFactor = Math.min(4.0, Math.max(0.6, distance / 260));
  return Math.round(CARGO[kind].basePrice * amount * distFactor * 2.0);
}

/** How far a glutted market depresses its price — a fully saturated market pays this
 *  fraction less. Dumping the same cargo into one town again and again earns steadily
 *  less; spreading deliveries across markets (or diversifying the manifest) beats it. */
export const SATURATION_DEPTH = 0.62;

/**
 * The price multiplier a market currently pays for a cargo given how saturated it is
 * (0 = fresh, full price; 1 = glutted). Each delivery nudges saturation up; it recovers
 * toward fresh while the market goes hungry — the demand half of the economy that makes
 * *where* you sell matter as much as *what* you haul.
 */
export function marketMult(saturation: number): number {
  const s = Math.min(1, Math.max(0, saturation));
  return 1 - SATURATION_DEPTH * s;
}
