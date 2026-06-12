import * as THREE from 'three';
import { Renderer } from './engine/Renderer';
import { CameraRig } from './engine/CameraRig';
import { Heightfield } from './world/Heightfield';
import { TerrainMesh } from './world/TerrainMesh';
import { buildSky } from './world/Sky';
import { WaterPlane } from './world/WaterPlane';
import { Scatter } from './world/Scatter';

const WORLD = { seed: 20260611, size: 4096, seaLevel: 0 };

async function boot(): Promise<void> {
  const container = document.getElementById('app')!;
  const renderer = new Renderer(container);
  const scene = new THREE.Scene();
  const rig = new CameraRig(renderer.gl.domElement, WORLD.size);

  const sky = await buildSky(scene, WORLD.size);

  const field = new Heightfield(WORLD);
  const terrain = new TerrainMesh(field);
  scene.add(terrain.mesh);

  const water = new WaterPlane(WORLD.seaLevel, WORLD.size, sky.sunDirection);
  scene.add(water.water);

  const scatter = new Scatter(field, WORLD.seed);
  scene.add(scatter.group);

  renderer.attach(scene, rig.camera, WORLD.size);
  window.addEventListener('resize', () => {
    renderer.resize();
    rig.resize();
  });

  // Aim at an interesting valley between coast and mountains.
  rig.controls.target.set(-200, 30, 300);
  rig.camera.position.set(380, 420, 900);

  if (import.meta.env.DEV) {
    (window as unknown as { __ie: unknown }).__ie = { scene, rig, renderer, field, terrain, water, scatter };
  }

  const clock = new THREE.Clock();
  const loop = (): void => {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    rig.update(dt);
    water.update(dt);
    scatter.update(dt);
    renderer.render();
  };
  loop();
  document.getElementById('loading')?.classList.add('hidden');
}

void boot();
