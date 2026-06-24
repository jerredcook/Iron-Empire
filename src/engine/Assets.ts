import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Central asset loading. Everything under /assets is CC0 (Poly Haven, three.js),
 * fetched by tools/fetch-assets.mjs. Loaders cache by URL.
 */

const texLoader = new THREE.TextureLoader();
const rgbeLoader = new RGBELoader();
const gltfLoader = new GLTFLoader();
const cache = new Map<string, THREE.Texture>();

// Vite's base URL: '/' in dev, '/Iron-Empire/' on a GitHub project Page. Runtime asset URLs
// are absolute ('/assets/...'), so prefix them with the base so they resolve under the deploy.
const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const asset = (url: string): string => BASE + url.replace(/^\//, '');

export interface PbrMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap?: THREE.Texture;
  alphaMap?: THREE.Texture;
}

function load(url: string, opts: { srgb?: boolean; repeat?: boolean; aniso?: number } = {}): THREE.Texture {
  const key = url + JSON.stringify(opts);
  const hit = cache.get(key);
  if (hit) return hit;
  const t = texLoader.load(asset(url));
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = opts.aniso ?? 8;
  cache.set(key, t);
  return t;
}

/** A Poly Haven terrain texture set: diff + nor_gl + rough at 2k. */
export function terrainSet(slug: string, aniso: number): PbrMaps {
  const base = `/assets/textures/${slug}`;
  return {
    map: load(`${base}/diff_2k.jpg`, { srgb: true, aniso }),
    normalMap: load(`${base}/nor_gl_2k.jpg`, { aniso }),
    roughnessMap: load(`${base}/rough_2k.jpg`, { aniso }),
  };
}

/** A texture from a downloaded model's bundle (bark, twig cards, …). */
export function modelTex(slug: string, name: string, srgb = false): THREE.Texture {
  return load(`/assets/models/${slug}/textures/${slug}_${name}_1k.jpg`, { srgb, aniso: 8 });
}

/** Stand-alone map fetched into textures/<slug>/ (e.g. twig alpha masks). */
export function looseTex(slug: string, name: string): THREE.Texture {
  return load(`/assets/textures/${slug}/${name}_1k.jpg`, { repeat: false });
}

export function waterNormals(): THREE.Texture {
  return load('/assets/textures/water/waternormals.jpg', {});
}

export function loadHdri(url: string): Promise<THREE.DataTexture> {
  return new Promise((resolve, reject) => {
    rgbeLoader.load(
      asset(url),
      (t) => {
        t.mapping = THREE.EquirectangularReflectionMapping;
        resolve(t);
      },
      undefined,
      reject
    );
  });
}

export function loadGltf(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    gltfLoader.load(asset(url), (g) => resolve(g.scene), undefined, reject);
  });
}
