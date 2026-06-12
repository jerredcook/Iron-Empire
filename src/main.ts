import * as THREE from 'three';
import { Renderer } from './engine/Renderer';
import { CameraRig } from './engine/CameraRig';
import { Heightfield } from './world/Heightfield';
import { TerrainMesh } from './world/TerrainMesh';
import { buildSky } from './world/Sky';
import { WaterPlane } from './world/WaterPlane';
import { Scatter } from './world/Scatter';
import { Track } from './game/Track';
import { Train } from './game/Train';
import { buildTown, buildStation } from './game/Buildings';

const WORLD = { seed: 20260611, size: 4096, seaLevel: 0 };

async function boot(): Promise<void> {
  const container = document.getElementById('app')!;
  const renderer = new Renderer(container);
  const scene = new THREE.Scene();
  const rig = new CameraRig(renderer.gl.domElement, WORLD.size);

  const sky = await buildSky(scene, WORLD.size);

  const field = new Heightfield(WORLD);
  // Town sites — flatten pads before the terrain mesh samples heights.
  const townSites = [
    new THREE.Vector3(940, 0, 940),
    new THREE.Vector3(-690, 0, -300),
  ];
  for (const t of townSites) field.addFlat(t.x, t.z, 60);
  const terrain = new TerrainMesh(field);
  scene.add(terrain.mesh);

  const water = new WaterPlane(WORLD.seaLevel, WORLD.size, sky.sunDirection);
  scene.add(water.water);

  const scatter = new Scatter(field, WORLD.seed);
  scene.add(scatter.group);

  // Demo line: a scenic run along the coast and up the valley, crossing the bay inlet.
  const track = new Track(field, [
    new THREE.Vector3(930, 0, 925),
    new THREE.Vector3(620, 0, 520),
    new THREE.Vector3(420, 0, 420),
    new THREE.Vector3(80, 0, 250),
    new THREE.Vector3(-320, 0, 60),
    new THREE.Vector3(-660, 0, -285),
  ]);
  scene.add(track.group);
  const train = new Train(track, scene);
  scene.add(train.group);

  // Towns at the line's ends, stations beside the track.
  for (const [i, site] of townSites.entries()) {
    const town = buildTown(WORLD.seed + i * 97, 14);
    town.position.set(site.x, field.height(site.x, site.z), site.z);
    scene.add(town);

    // Walk inward from the line's end to the first stretch of solid ground.
    let u = i === 0 ? 0.005 : 0.995;
    const step = (i === 0 ? 1 : -1) * 0.005;
    for (let k = 0; k < 40; k++) {
      const q = track.curve.getPointAt(u);
      const sx = q.x - track.curve.getTangentAt(u).z * 4.4;
      const sz = q.z + track.curve.getTangentAt(u).x * 4.4;
      if (field.height(sx, sz) > WORLD.seaLevel + 1.2) break;
      u += step;
    }
    const p = track.curve.getPointAt(u);
    const tan = track.curve.getTangentAt(u);
    const station = buildStation();
    station.position.set(p.x - tan.z * 4.4, field.height(p.x - tan.z * 4.4, p.z + tan.x * 4.4), p.z + tan.x * 4.4);
    station.rotation.y = Math.atan2(tan.x, tan.z);
    scene.add(station);
  }

  renderer.attach(scene, rig.camera, WORLD.size);
  window.addEventListener('resize', () => {
    renderer.resize();
    rig.resize();
  });

  // Aim at an interesting valley between coast and mountains.
  rig.controls.target.set(-200, 30, 300);
  rig.camera.position.set(380, 420, 900);

  if (import.meta.env.DEV) {
    (window as unknown as { __ie: unknown }).__ie = { scene, rig, renderer, field, terrain, water, scatter, track, train };
  }

  const clock = new THREE.Clock();
  const loop = (): void => {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    rig.update(dt);
    water.update(dt);
    scatter.update(dt);
    train.update(dt);
    renderer.render();
  };
  loop();
  document.getElementById('loading')?.classList.add('hidden');
}

void boot();
