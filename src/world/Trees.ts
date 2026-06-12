import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { modelTex, looseTex } from '../engine/Assets';

/**
 * Game-grade trees built the way production foliage is: a tapered bark-textured
 * trunk plus dozens of photo-real twig cards (Poly Haven's photoscanned twig
 * atlases with alpha cutout), merged per archetype and drawn as two InstancedMeshes
 * (trunks, cards) per species. Wind sways the cards in the vertex shader.
 */

export interface TreeArchetype {
  trunks: THREE.InstancedMesh;
  cards: THREE.InstancedMesh;
  /** Approximate radius for spacing. */
  radius: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function trunkGeometry(height: number, baseR: number, topR: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(topR, baseR, height, 9, 4);
  g.translate(0, height / 2, 0);
  // Stretch bark UVs around the trunk.
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * (height / 4));
  return g;
}

/** One foliage card: a quad whose pivot is its inner edge, drooping outward. */
function card(width: number, heightV: number, y: number, outR: number, yaw: number, pitch: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, heightV);
  g.translate(width / 2, 0, 0); // pivot at the inner edge
  g.rotateZ(pitch);
  g.rotateY(yaw);
  // Lift to its tier and push outward along its own yaw direction.
  g.translate(Math.cos(yaw) * outR, y, -Math.sin(yaw) * outR);
  return g;
}

interface ConiferSpec {
  kind: 'conifer';
  trunkH: number;
  baseR: number;
  topR: number;
  cards: { count: number; yFrom: number; yTo: number; rFrom: number; rTo: number; w: number; h: number; droop: number };
}

interface CanopySpec {
  kind: 'canopy';
  trunkH: number;
  baseR: number;
  topR: number;
  /** Canopy ellipsoid: centre height, radius (xz), vertical radius. */
  centerY: number;
  rXZ: number;
  rY: number;
  shellCards: number;
  fillCards: number;
  cardW: number;
  cardH: number;
}

type SpeciesSpec = ConiferSpec | CanopySpec;

const hash = (i: number): number => (((i * 2654435761) >>> 0) % 1000) / 1000;

function buildSpeciesGeometry(spec: SpeciesSpec): { trunk: THREE.BufferGeometry; cards: THREE.BufferGeometry } {
  const trunk = trunkGeometry(spec.trunkH, spec.baseR, spec.topR);
  const cardGeos: THREE.BufferGeometry[] = [];

  if (spec.kind === 'conifer') {
    const c = spec.cards;
    for (let i = 0; i < c.count; i++) {
      const t = i / Math.max(1, c.count - 1);
      const y = THREE.MathUtils.lerp(c.yFrom, c.yTo, t) * spec.trunkH;
      const r = THREE.MathUtils.lerp(c.rFrom, c.rTo, t);
      const yaw = i * GOLDEN;
      const jitter = 0.85 + hash(i) * 0.45;
      cardGeos.push(card(c.w * jitter, c.h * jitter, y, r, yaw, c.droop + hash(i + 77) * 0.18 - 0.09));
    }
    // Upward crown cards.
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(c.w * 0.7, c.h * 1.1);
      g.translate(0, c.h * 0.4, 0);
      g.rotateY(i * 2.1);
      g.rotateZ(0.1);
      g.translate(0, spec.trunkH * c.yTo, 0);
      cardGeos.push(g);
    }
  } else {
    // Shell: cards tangent to an ellipsoid, normals outward — reads as a full crown.
    for (let i = 0; i < spec.shellCards; i++) {
      // Fibonacci sphere point (upper-biased so the underside stays airy).
      const t = (i + 0.5) / spec.shellCards;
      const phi = Math.acos(1 - 1.7 * t); // bias: more cards on top hemisphere
      const theta = i * GOLDEN;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      const px = nx * spec.rXZ;
      const py = spec.centerY + ny * spec.rY;
      const pz = nz * spec.rXZ;

      const g = new THREE.PlaneGeometry(spec.cardW * (0.8 + hash(i) * 0.5), spec.cardH * (0.8 + hash(i + 31) * 0.5));
      // Mirror some UVs for variety.
      if (hash(i + 13) > 0.5) {
        const uv = g.attributes.uv as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) uv.setX(k, 1 - uv.getX(k));
      }
      const m = new THREE.Object3D();
      m.position.set(px, py, pz);
      m.lookAt(px + nx, py + ny, pz + nz);
      m.rotateZ(hash(i + 57) * Math.PI * 2);
      m.updateMatrix();
      g.applyMatrix4(m.matrix);
      cardGeos.push(g);
    }
    // Inner fill so gaps show leaves, not trunk.
    for (let i = 0; i < spec.fillCards; i++) {
      const g = new THREE.PlaneGeometry(spec.cardW * 1.1, spec.cardH * 1.1);
      const m = new THREE.Object3D();
      m.position.set(
        (hash(i + 3) - 0.5) * spec.rXZ * 1.1,
        spec.centerY + (hash(i + 71) - 0.4) * spec.rY * 1.1,
        (hash(i + 41) - 0.5) * spec.rXZ * 1.1
      );
      m.rotation.set(hash(i + 5) * 0.9 - 0.45, hash(i + 11) * Math.PI * 2, hash(i + 23) * 0.9 - 0.45);
      m.updateMatrix();
      g.applyMatrix4(m.matrix);
      cardGeos.push(g);
    }
  }

  return { trunk, cards: mergeGeometries(cardGeos.map((g) => (g.index ? g.toNonIndexed() : g)), false)! };
}

function barkMaterial(slug: string, barkName: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: modelTex(slug, `${barkName}_diff`, true),
    normalMap: modelTex(slug, `${barkName}_nor_gl`),
    roughness: 0.95,
  });
}

function cardMaterial(diff: THREE.Texture, alpha: THREE.Texture, nor: THREE.Texture, time: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: diff,
    alphaMap: alpha,
    normalMap: nor,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float ph = iPos.x * 0.05 + iPos.z * 0.07;
          float wgt = clamp(transformed.y / 14.0, 0.0, 1.0);
          transformed.x += sin(uTime * 1.1 + ph) * 0.35 * wgt;
          transformed.z += cos(uTime * 0.9 + ph * 1.3) * 0.35 * wgt;
        }`
      );
  };
  return m;
}

export interface TreesResult {
  archetypes: Record<'pine' | 'fir' | 'broadleaf', TreeArchetype>;
  update(dt: number): void;
}

export function buildTreeArchetypes(maxPerSpecies: { pine: number; fir: number; broadleaf: number }): TreesResult {
  const time = { value: 0 };

  const make = (
    spec: SpeciesSpec,
    bark: THREE.MeshStandardMaterial,
    cardMat: THREE.MeshStandardMaterial,
    max: number,
    radius: number
  ): TreeArchetype => {
    const { trunk, cards } = buildSpeciesGeometry(spec);
    const trunks = new THREE.InstancedMesh(trunk, bark, max);
    const cardMesh = new THREE.InstancedMesh(cards, cardMat, max);
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    cardMesh.castShadow = true;
    cardMesh.receiveShadow = true;
    trunks.count = 0;
    cardMesh.count = 0;
    return { trunks, cards: cardMesh, radius };
  };

  const pineCardMat = cardMaterial(
    modelTex('pine_tree_01', 'twig_diff', true),
    looseTex('pine_tree_01', 'twig_alpha'),
    modelTex('pine_tree_01', 'twig_nor_gl'),
    time
  );
  pineCardMat.color.set(0.82, 0.96, 0.72); // lift the grey twigs toward living green
  const pine = make(
    {
      kind: 'conifer',
      trunkH: 16,
      baseR: 0.55,
      topR: 0.12,
      cards: { count: 52, yFrom: 0.24, yTo: 0.98, rFrom: 3.8, rTo: 0.45, w: 6.4, h: 4.2, droop: -0.4 },
    },
    barkMaterial('pine_tree_01', 'bark'),
    pineCardMat,
    maxPerSpecies.pine,
    4.2
  );

  const firCardMat = cardMaterial(
    modelTex('fir_tree_01', 'twig_diff', true),
    looseTex('fir_tree_01', 'twig_alpha'),
    modelTex('fir_tree_01', 'twig_nor_gl'),
    time
  );
  firCardMat.color.set(0.85, 1.0, 0.8);
  const fir = make(
    {
      kind: 'conifer',
      trunkH: 12.5,
      baseR: 0.42,
      topR: 0.1,
      cards: { count: 46, yFrom: 0.16, yTo: 0.99, rFrom: 3.0, rTo: 0.3, w: 5.0, h: 3.4, droop: -0.3 },
    },
    barkMaterial('fir_tree_01', 'bark'),
    firCardMat,
    maxPerSpecies.fir,
    3.6
  );

  const broadleaf = make(
    {
      kind: 'canopy',
      trunkH: 6.5,
      baseR: 0.62,
      topR: 0.3,
      centerY: 8.2,
      rXZ: 4.6,
      rY: 3.4,
      shellCards: 56,
      fillCards: 16,
      cardW: 5.4,
      cardH: 4.2,
    },
    barkMaterial('island_tree_02', 'branches'),
    cardMaterial(
      modelTex('island_tree_02', 'leaves_diff', true),
      looseTex('island_tree_02', 'leaves_alpha'),
      modelTex('island_tree_02', 'leaves_nor_gl'),
      time
    ),
    maxPerSpecies.broadleaf,
    5
  );

  return {
    archetypes: { pine, fir, broadleaf },
    update(dt: number) {
      time.value += dt;
    },
  };
}
