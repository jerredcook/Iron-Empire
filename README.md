# Iron Empire

**Sid Meier's Railroads! — but so much better.** A ground-up, high-fidelity 3D railroad
empire game for the browser: Three.js + TypeScript, built asset-first on CC0
photo-real materials (Poly Haven) so the world holds up at any zoom.

> Successor to the Iron Horizons prototype (archived at
> github.com/jerredcook/Iron-Horizons). Iron Empire starts from a much higher visual
> bar: HDRI image-based lighting, photo-textured terrain with distance-graded detail,
> dense card-foliage forests built from photoscanned twig atlases, 8x-MSAA rendering
> at native device resolution.

## Run & stop

```bash
cd ~/dev/iron-empire
bash tools/fetch-all.sh   # first time only — downloads the CC0 assets (~75MB)
npm run dev               # http://127.0.0.1:5175/
```

Stop with **Ctrl+C**. A vendored Node 20 lives in `.toolchain/`, so the npm scripts
work regardless of the system Node (only `npm install` needs
`PATH="$PWD/.toolchain/node-v20.18.0-darwin-arm64/bin:$PATH"` in front).

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `bash tools/fetch-all.sh` | (Re)download all CC0 assets |

## Where it stands

**Done — the world:**
- 4096-unit analytic landscape (single source of truth `Heightfield.height(x,z)`):
  coastal shelf, rolling lowlands, ridged mountain belt.
- Five-layer photo-PBR terrain splat (lush grass, forest floor, cliff rock, beach
  sand, snow) with slope/elevation rules, anti-tiling double-sampling, and
  distance-graded color so neither close-ups nor wide shots break down.
- HDRI sky (4k Poly Haven) driving both the visible sky and physical ambient light,
  with a matched 4096-px shadow-casting sun.
- Forests: three species of production-style card trees (conifer tiers, ellipsoid
  broadleaf canopies) using the photoscanned bark/twig/leaf textures from Poly
  Haven's tree models; instanced by biome with wind sway. Photoscanned boulders and
  shrubs scattered on scree and forest edges.
- Planar-reflection water; 8x-MSAA HalfFloat pipeline + GTAO + bloom + ACES at native
  device resolution.

**Next (gameplay, ported conceptually from the Iron Horizons research):** track
laying with grading/bridges/tunnels, stations + catchment, era locomotives, cargo
economy and supply chains, rivals + stock market, scenarios, map editor.

## Layout

```
src/
  main.ts                 boot + frame loop
  engine/ Renderer.ts CameraRig.ts Assets.ts
  world/  Heightfield.ts TerrainMesh.ts Sky.ts WaterPlane.ts Trees.ts Scatter.ts
tools/    fetch-assets.mjs fetch-all.sh    (CC0 asset pipeline)
public/assets/             (gitignored — fetched on demand)
```
