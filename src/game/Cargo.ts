/**
 * The goods that move on the network. Every economic decision — what a city
 * supplies, what it demands, what a haul pays — is keyed on these. Colours double
 * as the livery of a loaded freight car so a moving train reads its own manifest.
 */
export type CargoKind = 'passengers' | 'mail' | 'goods' | 'grain' | 'coal' | 'lumber' | 'cattle';

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
};

export const ALL_CARGO = Object.keys(CARGO) as CargoKind[];

/**
 * What a delivery pays: the cargo's base price times the amount, scaled by how far
 * it travelled. Long hauls of fresh freight are where the money is; the factor is
 * clamped so neither a yard-shunt nor a transcontinental run breaks the economy.
 */
export function haulRevenue(kind: CargoKind, amount: number, distance: number): number {
  const distFactor = Math.min(3.0, Math.max(0.35, distance / 360));
  return Math.round(CARGO[kind].basePrice * amount * distFactor);
}
