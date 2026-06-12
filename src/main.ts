import * as THREE from 'three';
import { Renderer, QUALITY, QualityLevel } from './engine/Renderer';
import { CameraRig } from './engine/CameraRig';
import { Heightfield } from './world/Heightfield';
import { TerrainMesh } from './world/TerrainMesh';
import { buildSky } from './world/Sky';
import { WaterPlane } from './world/WaterPlane';
import { Scatter } from './world/Scatter';
import { Network } from './game/Network';
import { placeCities } from './game/Economy';
import { TrackBuilder } from './game/TrackBuilder';
import { HUD } from './game/HUD';
import { Inspector } from './game/Inspector';
import { Picker } from './game/Picker';
import { Minimap } from './game/Minimap';
import { LocoClass, defaultLoco } from './game/Locomotives';
import { AudioBus } from './game/Audio';
import { chooseScenario, DIFFICULTIES, Difficulty } from './game/Scenarios';
import { Auctioneer } from './game/Auction';

const SIZE = 4096;
const SEA = 0;

interface BootCfg {
  seed: number;
  year: number;
  startMoney: number;
  cities: number;
  goal: { targetCash: number; byYear: number };
  difficulty: Difficulty;
  player: { name: string; color: number };
  ais: { name: string; color: number }[];
  /** Restore the saved game over this world instead of seeding a starter line. */
  load: boolean;
}

async function boot(cfg: BootCfg): Promise<void> {
  const container = document.getElementById('app')!;
  const renderer = new Renderer(container);
  const scene = new THREE.Scene();
  const rig = new CameraRig(renderer.gl.domElement, SIZE);

  const sky = await buildSky(scene, SIZE);

  const field = new Heightfield({ seed: cfg.seed, size: SIZE, seaLevel: SEA });
  // Cities pick buildable ground and flatten their pads — must happen before the
  // terrain mesh samples heights.
  const sites = placeCities(field, cfg.seed, cfg.cities);
  const terrain = new TerrainMesh(field);
  scene.add(terrain.mesh);

  const water = new WaterPlane(SEA, SIZE, sky.sunDirection);
  scene.add(water.water);

  const scatter = new Scatter(field, cfg.seed);
  scene.add(scatter.group);

  // The economy: drop a town + depot at every site.
  const network = new Network(scene, field, cfg.seed, {
    startMoney: cfg.startMoney,
    year: cfg.year,
    cities: cfg.cities,
    goal: cfg.goal,
    difficulty: cfg.difficulty,
    player: cfg.player,
    ais: cfg.ais,
  });
  for (const site of sites) network.addStation(site);

  // The engine a finished line is staffed with — the HUD's picker drives this.
  let selectedLoco: LocoClass = defaultLoco(network.year);

  // Quality tier: rebuild the post pipeline and resize the sun's shadow map together.
  const applyQuality = (q: QualityLevel): void => {
    renderer.setQuality(q);
    const n = QUALITY[q].shadowMap;
    sky.sun.shadow.mapSize.set(n, n);
    sky.sun.shadow.map?.dispose();
    sky.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget; // force three.js to rebuild it
  };

  // Interactive track laying + HUD.
  const builder = new TrackBuilder(rig.camera, renderer.gl.domElement, terrain.mesh, network, scene, () => selectedLoco);
  // Synthesized sound — unlocked on the first interaction, chimes on deliveries.
  const audio = new AudioBus();
  network.onRevenue = () => audio.chime();
  network.onBuilt = () => audio.build();
  window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

  const hud = new HUD(
    network,
    () => builder.toggle(),
    renderer.quality,
    applyQuality,
    (loco) => {
      selectedLoco = loco;
    },
    () => audio.toggle()
  );
  builder.onStatus = (s) => hud.setBuildStatus(s);
  renderer.gl.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  // Inspection: minimap + click-to-select + detail panel, all reading live state.
  const minimap = new Minimap(field, network);
  const inspector = new Inspector(
    network,
    () => {
      inspector.select(null);
      minimap.setSelection(null);
    },
    (line) => {
      if (!line.owner.isAI) network.addTrain(line, selectedLoco);
    },
    (st) => network.buildIndustry(st)
  );
  const auctioneer = new Auctioneer(network);
  const picker = new Picker(rig.camera, renderer.gl.domElement, terrain.mesh, network, () => builder.isActive());
  picker.onSelect = (sel) => {
    inspector.select(sel);
    minimap.setSelection(sel);
  };
  minimap.onPan = (x, z) => {
    const dx = x - rig.controls.target.x;
    const dz = z - rig.controls.target.z;
    rig.controls.target.set(x, field.height(x, z), z);
    rig.camera.position.x += dx;
    rig.camera.position.z += dz;
  };

  renderer.attach(scene, rig.camera, SIZE);
  window.addEventListener('resize', () => {
    renderer.resize();
    rig.resize();
  });

  if (cfg.load) {
    // Restore the saved game over this freshly generated (same-seed) world.
    network.loadFromStorage();
  } else {
    // Seed one productive line so the world opens in motion and the cargo loop is
    // legible from the first frame — the closest pair that actually trades.
    const pair = starterPair(network);
    if (pair) network.buildLine([pair[0], pair[1]], [[]], selectedLoco);
  }

  // Open on a high three-quarter overview so several cities are in frame.
  rig.controls.target.set(0, 20, 0);
  rig.camera.position.set(-620, 640, 820);

  if (import.meta.env.DEV) {
    (window as unknown as { __ie: unknown }).__ie = { scene, rig, renderer, field, terrain, water, scatter, network, builder, inspector, minimap, picker };
  }

  const clock = new THREE.Clock();
  const loop = (): void => {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    rig.update(dt);
    water.update(dt);
    scatter.update(dt);
    network.update(dt);
    auctioneer.update(dt);
    renderer.render();
    hud.update(rig.camera, window.innerWidth, window.innerHeight);
    inspector.update(dt);
    minimap.update(rig.camera, rig.controls.target);
  };
  loop();
  document.getElementById('loading')?.classList.add('hidden');
}

type GStation = (typeof Network.prototype.stations)[number];

/** The closest pair of cities that trade (one supplies what the other wants); falls
 *  back to the closest pair overall. The natural first line for the starter network. */
function starterPair(network: Network): [GStation, GStation] | null {
  const s = network.stations;
  if (s.length < 2) return null;
  const trades = (a: GStation, b: GStation): boolean =>
    Object.keys(a.supplies).some((k) => b.demands.has(k as never)) ||
    Object.keys(b.supplies).some((k) => a.demands.has(k as never));

  let best: [GStation, GStation] | null = null;
  let bd = Infinity;
  let bestAny: [GStation, GStation] = [s[0], s[1]];
  let bdAny = Infinity;
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      const d = s[i].pos.distanceToSquared(s[j].pos);
      if (d < bdAny) {
        bdAny = d;
        bestAny = [s[i], s[j]];
      }
      if (trades(s[i], s[j]) && d < bd) {
        bd = d;
        best = [s[i], s[j]];
      }
    }
  }
  return best ?? bestAny;
}

const FALLBACK_GOAL = { targetCash: 2_500_000, byYear: 1890 };

/** Show the start menu, then boot the chosen setup — or regenerate the saved world and
 *  restore it when the player chooses Continue. */
async function start(): Promise<void> {
  const choice = await chooseScenario();
  if (choice.kind === 'continue') {
    const w = Network.savedWorld();
    if (!w) return; // no save after all — shouldn't happen
    const difficulty = DIFFICULTIES.find((d) => d.id === w.difficulty) ?? DIFFICULTIES[1];
    await boot({
      seed: w.seed,
      cities: w.cities,
      difficulty,
      player: w.player,
      ais: w.ais,
      year: 1862,
      startMoney: 0,
      goal: FALLBACK_GOAL,
      load: true,
    });
    return;
  }
  const s = choice.setup;
  await boot({
    seed: s.seed,
    year: s.scenario.year,
    startMoney: s.scenario.startMoney,
    cities: s.cities,
    goal: s.goal,
    difficulty: s.difficulty,
    player: s.player,
    ais: s.ais,
    load: false,
  });
}

void start();
