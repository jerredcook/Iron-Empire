import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { Heightfield, mulberry32 } from './Heightfield';
import { buildTreeArchetypes, TreesResult } from './Trees';
import { loadGltf } from '../engine/Assets';

/**
 * Populates the land: conifer belts on the high ground, broadleaf woods in the
 * lowlands, shrubs at forest edges, photoscanned boulders on scree. Placement is
 * biome-noise driven and deterministic per seed.
 */
export class Scatter {
  readonly group = new THREE.Group();
  private trees: TreesResult;

  constructor(field: Heightfield, seed: number) {
    const { seaLevel, size } = field.params;
    const rng = mulberry32(seed ^ 0x7e11);
    const forestNoise = createNoise2D(mulberry32(seed ^ 0x3344));
    const speciesNoise = createNoise2D(mulberry32(seed ^ 0x8b13));

    const budget = Math.round(26000 * (size / 4096) ** 2);
    this.trees = buildTreeArchetypes({ pine: budget, fir: budget, broadleaf: budget });
    const { pine, fir, broadleaf } = this.trees.archetypes;
    this.group.add(pine.trunks, pine.cards, fir.trunks, fir.cards, broadleaf.trunks, broadleaf.cards);

    const dummy = new THREE.Object3D();
    const half = field.half - 24;
    const counts = { pine: 0, fir: 0, broadleaf: 0 };

    for (let i = 0; i < budget * 3; i++) {
      const x = (rng() * 2 - 1) * half;
      const z = (rng() * 2 - 1) * half;
      const h = field.height(x, z);
      if (h < seaLevel + 2.5) continue;
      if (h > 235) continue; // above the treeline
      if (field.slope(x, z) > 0.55) continue;

      // Forests clump: keep where the density field is high.
      const density = forestNoise(x / 620, z / 620) * 0.5 + 0.5;
      if (rng() > density * 0.92) continue;

      // Species: conifers on high/cold ground, broadleaf low; mix at the seam.
      const coldness = h / 200 + (speciesNoise(x / 900, z / 900) * 0.5 + 0.5) * 0.55;
      const arch = coldness > 0.78 ? fir : coldness > 0.52 ? pine : broadleaf;
      const key = arch === fir ? 'fir' : arch === pine ? 'pine' : 'broadleaf';
      if (counts[key] >= budget) continue;

      const s = 0.75 + rng() * 0.65;
      dummy.position.set(x, h - 0.3, z);
      dummy.scale.setScalar(s);
      dummy.rotation.y = rng() * Math.PI * 2;
      dummy.updateMatrix();
      const idx = counts[key]++;
      arch.trunks.setMatrixAt(idx, dummy.matrix);
      arch.cards.setMatrixAt(idx, dummy.matrix);
    }

    for (const a of [pine, fir, broadleaf]) {
      const key = a === fir ? 'fir' : a === pine ? 'pine' : 'broadleaf';
      a.trunks.count = counts[key];
      a.cards.count = counts[key];
      a.trunks.instanceMatrix.needsUpdate = true;
      a.cards.instanceMatrix.needsUpdate = true;
    }

    // Photoscanned boulders + shrubs (loaded async; placed deterministically).
    void this.placeModels(field, seed);
  }

  private async placeModels(field: Heightfield, seed: number): Promise<void> {
    const { seaLevel, size } = field.params;
    const place = (
      src: THREE.Group,
      count: number,
      rngSeed: number,
      filter: (x: number, z: number, h: number) => boolean,
      scale: [number, number],
      sink = 0.4
    ): void => {
      let geo: THREE.BufferGeometry | null = null;
      let mat: THREE.Material | null = null;
      src.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !geo) {
          geo = m.geometry as THREE.BufferGeometry;
          mat = m.material as THREE.Material;
        }
      });
      if (!geo || !mat) return;
      const inst = new THREE.InstancedMesh(geo, mat, count);
      inst.castShadow = true;
      inst.receiveShadow = true;
      const rng = mulberry32(rngSeed);
      const dummy = new THREE.Object3D();
      const half = field.half - 24;
      let placed = 0;
      for (let i = 0; i < count * 40 && placed < count; i++) {
        const x = (rng() * 2 - 1) * half;
        const z = (rng() * 2 - 1) * half;
        const h = field.height(x, z);
        if (!filter(x, z, h)) continue;
        dummy.position.set(x, h - sink, z);
        dummy.scale.setScalar(scale[0] + rng() * (scale[1] - scale[0]));
        dummy.rotation.y = rng() * Math.PI * 2;
        dummy.updateMatrix();
        inst.setMatrixAt(placed++, dummy.matrix);
      }
      inst.count = placed;
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
    };

    const area = (size / 4096) ** 2;
    const [boulder, shrub] = await Promise.all([
      loadGltf('/assets/models/boulder_01/boulder_01_1k.gltf'),
      loadGltf('/assets/models/shrub_02/shrub_02_1k.gltf'),
    ]);
    place(
      boulder,
      Math.round(420 * area),
      seed ^ 0xb01d,
      (x, z, h) => h > seaLevel + 1 && (field.slope(x, z) > 0.34 || h > 170),
      [1.6, 6],
      0.7
    );
    place(
      shrub,
      Math.round(2600 * area),
      seed ^ 0x5a7b,
      (x, z, h) => h > seaLevel + 2 && h < 190 && field.slope(x, z) < 0.5,
      [1.2, 3.2],
      0.15
    );
  }

  update(dt: number): void {
    this.trees.update(dt);
  }
}
