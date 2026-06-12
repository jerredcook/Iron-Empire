#!/bin/bash
# Fetch every CC0 asset Iron Empire uses (Poly Haven + three.js). Idempotent.
set -e
cd "$(dirname "$0")/.."
N=.toolchain/node-v20.18.0-darwin-arm64/bin/node

$N tools/fetch-assets.mjs hdri kloofendal_48d_partly_cloudy_puresky 4k

for t in leafy_grass rock_face forest_floor coast_sand_01 snow_02 gravel_ground_01 weathered_planks; do
  $N tools/fetch-assets.mjs texture "$t" 2k Diffuse nor_gl Rough
done

for m in pine_tree_01 fir_tree_01 island_tree_02 shrub_02 boulder_01; do
  $N tools/fetch-assets.mjs model "$m" 1k
done
# The photoscan tree geometry is offline-render scale (up to 900MB) — we keep only
# their texture sets and build game-grade card trees from them.
rm -f public/assets/models/pine_tree_01/pine_tree_01.bin public/assets/models/pine_tree_01/pine_tree_01_1k.gltf
rm -f public/assets/models/fir_tree_01/fir_tree_01.bin public/assets/models/fir_tree_01/fir_tree_01_1k.gltf
rm -f public/assets/models/island_tree_02/island_tree_02.bin public/assets/models/island_tree_02/island_tree_02_1k.gltf

$N tools/fetch-assets.mjs texture pine_tree_01 1k twig_alpha
$N tools/fetch-assets.mjs texture fir_tree_01 1k twig_alpha
$N tools/fetch-assets.mjs texture island_tree_02 1k leaves_alpha

mkdir -p public/assets/textures/water
[ -f public/assets/textures/water/waternormals.jpg ] || \
  curl -fsSL -o public/assets/textures/water/waternormals.jpg \
    "https://raw.githubusercontent.com/mrdoob/three.js/r169/examples/textures/waternormals.jpg"

echo "All assets fetched."
