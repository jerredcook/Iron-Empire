/**
 * Station maintenance buildings — the depot-management layer. Each is a one-time purchase
 * at a player-owned depot that grants a concrete operating bonus (see Network for the
 * effects). Kept standalone so both the Network (effects) and Buildings (meshes) can name
 * the types without an import cycle.
 */
export type StationBuilding = 'roundhouse' | 'watertower' | 'warehouse' | 'postoffice' | 'hotel';

export interface StationBuildingDef {
  label: string;
  icon: string;
  cost: number;
  blurb: string;
}

export const STATION_BUILDINGS: Record<StationBuilding, StationBuildingDef> = {
  roundhouse: { label: 'Roundhouse', icon: '🛠', cost: 60_000, blurb: 'Services engines here — sheds wear, mends a breakdown' },
  watertower: { label: 'Water Tower', icon: '🗼', cost: 30_000, blurb: 'Quick top-ups — trains turn around faster' },
  warehouse: { label: 'Warehouse', icon: '🏬', cost: 55_000, blurb: 'Bigger stockpile and faster loading here' },
  postoffice: { label: 'Post Office', icon: '📮', cost: 45_000, blurb: '+30% on mail & passengers delivered here' },
  hotel: { label: 'Hotel', icon: '🏨', cost: 70_000, blurb: '+30% on passengers, and the city grows faster' },
};

/** Display order for the depot's upgrade list. */
export const STATION_BUILDING_ORDER: StationBuilding[] = ['roundhouse', 'watertower', 'warehouse', 'postoffice', 'hotel'];
