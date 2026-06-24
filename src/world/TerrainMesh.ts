import * as THREE from 'three';
import { Heightfield } from './Heightfield';
import { terrainSet } from '../engine/Assets';

/**
 * The ground: a high-resolution grid displaced by the Heightfield, shaded by a
 * five-layer PBR splat — lush grass, forest floor, cliff rock, beach sand, snow —
 * blended by slope and elevation with noise-jittered edges and anti-tiling
 * double-sampling so no repeats or hard bands are visible.
 */
export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  private readonly size: number;
  private readonly segments: number;

  constructor(field: Heightfield, segments = 512) {
    const { size, seaLevel } = field.params;
    this.size = size;
    this.segments = segments;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, field.height(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();

    this.mesh = new THREE.Mesh(geo, buildTerrainMaterial(size, seaLevel));
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.name = 'terrain';
  }

  /** Refresh vertex heights near a point (after grading/sculpting). */
  resample(field: Heightfield, x: number, z: number, radius: number): void {
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const r2 = radius * radius;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - x;
      const dz = pos.getZ(i) - z;
      if (dx * dx + dz * dz <= r2) pos.setY(i, field.height(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }

  /** Re-displace the ground along a freshly-graded track corridor, relighting only the touched
   *  vertices from the height gradient (cheap and local — no full normal recompute). `path` is
   *  the line's waypoint polyline; `reach` is how far the earthworks spread from it. */
  resampleCorridor(field: Heightfield, path: { x: number; z: number }[], reach: number): void {
    if (path.length < 2) return;
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const nrm = this.mesh.geometry.attributes.normal as THREE.BufferAttribute;
    const stride = this.segments + 1;
    const spacing = this.size / this.segments;
    const r2 = reach * reach;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of path) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    minX -= reach; maxX += reach; minZ -= reach; maxZ += reach;
    const touched: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      if (distToPath2(x, z, path) > r2) continue;
      pos.setY(i, field.height(x, z));
      touched.push(i);
    }
    // Relight the touched vertices and their immediate neighbours from the new heights.
    const relit = new Set<number>();
    for (const i of touched) {
      relit.add(i);
      const col = i % stride, row = (i / stride) | 0;
      if (col > 0) relit.add(i - 1);
      if (col < this.segments) relit.add(i + 1);
      if (row > 0) relit.add(i - stride);
      if (row < this.segments) relit.add(i + stride);
    }
    for (const i of relit) {
      const col = i % stride, row = (i / stride) | 0;
      const l = col > 0 ? i - 1 : i, r = col < this.segments ? i + 1 : i;
      const d = row > 0 ? i - stride : i, u = row < this.segments ? i + stride : i;
      const gx = (pos.getY(r) - pos.getY(l)) / (2 * spacing);
      const gz = (pos.getY(u) - pos.getY(d)) / (2 * spacing);
      const len = Math.hypot(gx, 1, gz) || 1;
      nrm.setXYZ(i, -gx / len, 1 / len, -gz / len);
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
  }
}

/** Squared XZ distance from a point to the nearest segment of a polyline. */
function distToPath2(px: number, pz: number, path: { x: number; z: number }[]): number {
  let min = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i].x, az = path[i].z;
    const dx = path[i + 1].x - ax, dz = path[i + 1].z - az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((px - ax) * dx + (pz - az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (ax + t * dx), ez = pz - (az + t * dz);
    const d2 = ex * ex + ez * ez;
    if (d2 < min) min = d2;
  }
  return min;
}

function buildTerrainMaterial(worldSize: number, seaLevel: number): THREE.MeshStandardMaterial {
  const aniso = 16;
  const grass = terrainSet('leafy_grass', aniso);
  const floor = terrainSet('forest_floor', aniso);
  const rock = terrainSet('rock_face', aniso);
  const sand = terrainSet('coast_sand_01', aniso);
  const snow = terrainSet('snow_02', aniso);

  const mat = new THREE.MeshStandardMaterial({
    map: grass.map,
    normalMap: grass.normalMap,
    roughnessMap: grass.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFloorD = { value: floor.map };
    shader.uniforms.uFloorN = { value: floor.normalMap };
    shader.uniforms.uRockD = { value: rock.map };
    shader.uniforms.uRockN = { value: rock.normalMap };
    shader.uniforms.uSandD = { value: sand.map };
    shader.uniforms.uSandN = { value: sand.normalMap };
    shader.uniforms.uSnowD = { value: snow.map };
    shader.uniforms.uSnowN = { value: snow.normalMap };
    shader.uniforms.uSea = { value: seaLevel };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWPos;
         varying vec3 vWNrm;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         vWNrm = normalize(mat3(modelMatrix) * objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWPos;
         varying vec3 vWNrm;
         uniform sampler2D uFloorD, uFloorN, uRockD, uRockN, uSandD, uSandN, uSnowD, uSnowN;
         uniform float uSea;

         vec2 rot2(vec2 p, float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c)*p; }

         // Anti-tiling sample: two scales/rotations blended by a slow mask.
         vec4 layerSample(sampler2D t, vec2 uv, float blendMask){
           vec4 a = texture2D(t, uv);
           vec4 b = texture2D(t, rot2(uv, 2.17) * 0.37 + vec2(0.13, 0.71));
           return mix(a, b, blendMask);
         }

         void splatWeights(in float macro, out float wG, out float wF, out float wR, out float wS, out float wW){
           float slope = clamp(1.0 - vWNrm.y, 0.0, 1.0);
           float h = vWPos.y;
           // rock on steep faces, with noisy threshold
           wR = smoothstep(0.16 + macro*0.10, 0.42 + macro*0.10, slope);
           // sand: a shoreline ribbon only (inverted ramp — GLSL smoothstep needs edge0 < edge1)
           wS = (1.0 - smoothstep(uSea + 1.0, uSea + 5.0 + macro*3.0, h)) * (1.0 - wR);
           // snow on high ground, retreating from cliffs
           wW = smoothstep(255.0 + macro*55.0, 320.0 + macro*55.0, h) * (1.0 - wR*0.85);
           // forest-floor patches across the lowland by macro noise
           wF = smoothstep(0.52, 0.74, macro) * (1.0 - wR) * (1.0 - wS) * (1.0 - wW);
           wG = max(0.0, 1.0 - wR - wS - wW - wF);
         }`
      )
      .replace(
        '#include <map_fragment>',
        `{
          vec2 uv  = vWPos.xz / 22.0;           // detail tiling
          vec2 uvR = vWPos.xz / 34.0;           // rock reads better larger
          float macro = texture2D(map, vWPos.xz / 540.0).g;
          float anti = smoothstep(0.3, 0.7, texture2D(map, vWPos.xz / 233.0).g);
          float wG,wF,wR,wS,wW; splatWeights(macro, wG, wF, wR, wS, wW);

          // Near-field: real photo detail (grass corrected toward lush green —
          // the leafy_grass photo skews straw-coloured).
          vec3 g = layerSample(map,    uv,  anti).rgb;
          g = mix(g, g * vec3(0.62, 1.05, 0.42), 0.55);
          vec3 f = layerSample(uFloorD,uv,  anti).rgb;
          vec3 r = layerSample(uRockD, uvR, anti).rgb;
          vec3 s = layerSample(uSandD, uv,  anti).rgb;
          vec3 w = layerSample(uSnowD, uv,  anti).rgb;
          vec3 nearAlb = g*wG + f*wF + r*wR + s*wS + w*wW;

          // Far-field: hand-tuned layer colours (deep mips of photos go muddy),
          // modulated by macro noise so distance still has variety.
          float mv = 0.78 + 0.44 * macro;
          vec3 gFar = vec3(0.072, 0.142, 0.030) * mv;   // lush meadow green (linear)
          vec3 fFar = vec3(0.092, 0.072, 0.038) * mv;   // leaf-litter brown
          vec3 rFar = vec3(0.155, 0.138, 0.118) * mv;   // grey-brown stone
          vec3 sFar = vec3(0.380, 0.315, 0.205) * mv;   // warm sand
          vec3 wFar = vec3(0.780, 0.815, 0.860);
          vec3 farAlb = gFar*wG + fFar*wF + rFar*wR + sFar*wS + wFar*wW;

          float dist = length(vViewPosition);
          float k = smoothstep(120.0, 750.0, dist);
          vec3 albedo = mix(nearAlb, farAlb, k);
          albedo *= 0.90 + 0.20 * texture2D(map, vWPos.xz / 1300.0).g;
          diffuseColor.rgb *= albedo;
        }`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec2 uv = vWPos.xz / 22.0;
          vec2 uvR = vWPos.xz / 34.0;
          float macro = texture2D(map, vWPos.xz / 540.0).g;
          float anti = smoothstep(0.3, 0.7, texture2D(map, vWPos.xz / 233.0).g);
          float wG,wF,wR,wS,wW; splatWeights(macro, wG, wF, wR, wS, wW);
          vec3 nG = layerSample(normalMap, uv,  anti).xyz * 2.0 - 1.0;
          vec3 nF = layerSample(uFloorN,   uv,  anti).xyz * 2.0 - 1.0;
          vec3 nR = layerSample(uRockN,    uvR, anti).xyz * 2.0 - 1.0;
          vec3 nS = layerSample(uSandN,    uv,  anti).xyz * 2.0 - 1.0;
          vec3 nW = layerSample(uSnowN,    uv,  anti).xyz * 2.0 - 1.0;
          vec3 mapN = normalize(nG*wG + nF*wF + nR*wR + nS*wS + nW*wW);
          // Fade normal detail with distance — deep-mip normals just sparkle.
          float nk = 1.0 - smoothstep(120.0, 750.0, length(vViewPosition)) * 0.9;
          mapN.xy *= 0.85 * nk;
          mapN = normalize(mapN);
          normal = normalize(getTangentFrame(-vViewPosition, normal, uv) * mapN);
        }`
      )
      // Per-layer roughness: scalar mix on top of the grass roughness map.
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
         {
           vec2 uv = vWPos.xz / 22.0;
           float macro = texture2D(map, vWPos.xz / 540.0).g;
           float wG,wF,wR,wS,wW; splatWeights(macro, wG, wF, wR, wS, wW);
           float rg = texture2D(roughnessMap, uv).g;
           roughnessFactor *= rg*wG + 0.95*wF + 0.82*wR + 0.92*wS + 0.55*wW;
         }`
      );
  };

  void worldSize;
  return mat;
}
