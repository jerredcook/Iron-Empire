import { createNoise2D } from 'simplex-noise';

/** Small seedable PRNG so every world is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TerrainParams {
  seed: number;
  /** World units per edge. */
  size: number;
  /** Water surface height. */
  seaLevel: number;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Analytic landscape — the single source of truth for ground height. Layered like a
 * real region: a coastal shelf to the south-east, rolling lowlands through the middle,
 * and a ridged mountain belt to the north-west, with noise-warped transitions so
 * nothing reads as a gradient.
 */
export class Heightfield {
  private n1: (x: number, y: number) => number;
  private n2: (x: number, y: number) => number;
  private n3: (x: number, y: number) => number;
  private flats: { x: number; z: number; inner: number; outer: number; h: number }[] = [];

  constructor(readonly params: TerrainParams) {
    this.n1 = createNoise2D(mulberry32(params.seed));
    this.n2 = createNoise2D(mulberry32(params.seed ^ 0x9e3779b9));
    this.n3 = createNoise2D(mulberry32(params.seed ^ 0x51f3a2c4));
  }

  private fbm(nx: (x: number, y: number) => number, x: number, y: number, oct: number, lac = 2, gain = 0.5): number {
    let a = 1,
      f = 1,
      s = 0,
      norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * nx(x * f, y * f);
      norm += a;
      a *= gain;
      f *= lac;
    }
    return s / norm;
  }

  /** Flatten a circular pad (town/industry/station sites). */
  addFlat(x: number, z: number, radius: number): void {
    this.flats.push({ x, z, inner: radius * 0.75, outer: radius * 2.0, h: this.rawHeight(x, z) });
  }

  private rawHeight(x: number, z: number): number {
    const { size, seaLevel } = this.params;
    const f = 1.15 / size; // base feature frequency tied to world size

    // Domain warp for organic shapes.
    const wx = x + 260 * this.fbm(this.n2, x * f * 0.8, z * f * 0.8, 2);
    const wz = z + 260 * this.fbm(this.n2, x * f * 0.8 + 37.2, z * f * 0.8 - 11.8, 2);

    // Continental gradient: NW high ground -> SE sea, bent by low-freq noise.
    const diag = (-(wx + wz) / size) * 0.5 + 0.5; // 1 at NW corner, 0 at SE
    const bend = this.fbm(this.n1, wx * f * 0.6, wz * f * 0.6, 3) * 0.24;
    const cont = smooth(0.18, 0.95, diag + bend);

    // Rolling lowland detail everywhere.
    const rolling = this.fbm(this.n1, wx * f * 3.2, wz * f * 3.2, 5) * 26 + this.fbm(this.n3, wx * f * 9, wz * f * 9, 3) * 5;

    // Ridged mountain belt that strengthens with the continental gradient.
    const r = 1 - Math.abs(this.fbm(this.n3, wx * f * 2.0, wz * f * 2.0, 4));
    const mountains = Math.pow(r, 2.6) * 270 * smooth(0.45, 0.85, cont);

    // Continental base: real lowlands sit well above the sea so grass owns the plains
    // and sand stays a shoreline ribbon.
    const base = lerp(-55, 105, cont) + 14 * smooth(0.1, 0.35, cont);

    let h = base + rolling + mountains;

    // Soften only the immediate surf zone into a beach shelf.
    const shore = smooth(seaLevel - 7, seaLevel + 7, h);
    h = lerp(h * 0.55 + seaLevel * 0.45, h, 0.5 + 0.5 * shore);
    return h;
  }

  height(x: number, z: number): number {
    let h = this.rawHeight(x, z);
    for (const p of this.flats) {
      // Cheap bounding-box reject before the sqrt — with a dense map (many flats),
      // almost every flat is far from any given vertex, so this skips the hypot.
      if (Math.abs(x - p.x) >= p.outer || Math.abs(z - p.z) >= p.outer) continue;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d >= p.outer) continue;
      const t = 1 - smooth(p.inner, p.outer, d);
      h = lerp(h, Math.max(p.h, this.params.seaLevel + 4), t);
    }
    return h;
  }

  slope(x: number, z: number, eps = 2): number {
    const hx = this.height(x + eps, z) - this.height(x - eps, z);
    const hz = this.height(x, z + eps) - this.height(x, z - eps);
    return Math.hypot(hx, hz) / (2 * eps);
  }

  underwater(x: number, z: number): boolean {
    return this.height(x, z) < this.params.seaLevel;
  }

  get half(): number {
    return this.params.size / 2;
  }
}
