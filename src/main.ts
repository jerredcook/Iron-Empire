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
import { chooseScenario, DIFFICULTIES, SCENARIOS, Difficulty } from './game/Scenarios';
import { Auctioneer } from './game/Auction';
import { configureConsist } from './game/ConsistConfig';
import { CargoKind } from './game/Cargo';

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
  // Dev diagnostics: count deliveries/revenue so a headless run can confirm the loop.
  const diag = { revenue: 0, deliveries: 0, builds: 0 };
  network.onRevenue = (amt) => {
    audio.chime();
    diag.revenue += amt;
    diag.deliveries += 1;
  };
  network.onBuilt = () => {
    audio.build();
    diag.builds += 1;
  };
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
  // Finishing a corridor opens the consist dialog, then builds it with the chosen cars.
  builder.onCommit = (stops, segMids) =>
    configureConsist(network, stops, selectedLoco, (cars) => network.buildLine(stops, segMids, selectedLoco, cars));
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
      if (!line.owner.isAI) configureConsist(network, line.stops, selectedLoco, (cars) => network.addTrain(line, selectedLoco, cars));
    },
    (st) => network.buildIndustry(st),
    (st) => network.upgradeStation(st)
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

  // Dev diagnostics element (read by a headless verification run via ?diag).
  const diagEl = location.search.includes('diag') ? document.createElement('pre') : null;
  if (diagEl) {
    diagEl.id = 'ie-diag';
    diagEl.style.cssText = 'position:fixed;bottom:0;left:0;z-index:99;font-size:10px;color:#0f0;background:#000;margin:0;padding:2px';
    document.body.append(diagEl);
  }
  const writeDiag = (): void => {
    if (!diagEl) return;
    let goods = 0;
    let maxGrowth = 1;
    for (const s of network.stations) {
      goods += s.stock.get('goods') ?? 0;
      maxGrowth = Math.max(maxGrowth, s.growth);
    }
    diagEl.textContent = JSON.stringify({
      year: network.year,
      money: Math.round(network.money),
      netWorth: Math.round(network.netWorth),
      status: network.status,
      playerLines: network.player.lines.length,
      aiLines: network.lines.filter((l) => l.owner.isAI).length,
      trains: network.lines.reduce((a, l) => a + l.trains.length, 0),
      deliveries: diag.deliveries,
      revenue: Math.round(diag.revenue),
      goodsWaiting: Math.round(goods),
      maxGrowth: +maxGrowth.toFixed(2),
      rivalNetWorth: Math.round(network.rivals[0]?.netWorth ?? 0),
    });
  };

  // Headless verification: run the real simulation synchronously for N ticks, then
  // report — exercises trains, deliveries, the AI, growth, and the calendar.
  const simticks = Number(new URLSearchParams(location.search).get('simticks') ?? 0);
  for (let i = 0; i < simticks; i++) {
    network.update(1 / 30);
    auctioneer.update(1 / 30);
  }
  writeDiag();

  // Headless UI test: drive the real consist modal DOM for both the add-train and
  // build-line paths, then report what actually happened in the model.
  if (location.search.includes('uitest')) {
    runUiTest(network, builder, selectedLoco);
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
    writeDiag();
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

/** Drive the open consist modal: trim a car, set the first car's cargo, hit Buy.
 *  Returns true if the modal committed and closed. Re-queries after each step because
 *  the modal re-renders its own DOM. */
function driveConsistModal(cargo: CargoKind): boolean {
  const panel = (): HTMLElement | null => document.querySelector('[data-consist]');
  if (!panel()) return false;
  (panel()!.querySelector('[data-dec]') as HTMLElement | null)?.click();
  const sel = panel()!.querySelector('select') as HTMLSelectElement | null;
  if (sel) {
    sel.value = cargo;
    sel.dispatchEvent(new Event('change'));
  }
  const buy = [...panel()!.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith('Buy')) as
    | HTMLButtonElement
    | undefined;
  buy?.click();
  return !panel();
}

function runUiTest(network: Network, builder: TrackBuilder, loco: LocoClass): void {
  const result: Record<string, unknown> = {};
  const maxCars = network.maxCars(loco);

  // A) Add a configured train to the existing starter line.
  const line = network.lines[0];
  const before = line.trains.length;
  configureConsist(network, line.stops, loco, (cars) => network.addTrain(line, loco, cars));
  const aClosed = driveConsistModal('coal');
  const added = line.trains[line.trains.length - 1];
  result.addTrain = {
    committed: aClosed,
    trainAdded: line.trains.length === before + 1,
    carCount: added?.consist.length ?? 0,
    expectedCars: maxCars - 1,
    hasCoalCar: added?.consist.some((c) => c.kind === 'coal') ?? false,
  };

  // B) Build a new line through the builder's commit path (same stops as the starter).
  const linesBefore = network.lines.length;
  builder.onCommit?.(line.stops.slice(), [[]]);
  const bClosed = driveConsistModal('passengers');
  const newLine = network.lines[network.lines.length - 1];
  result.buildLine = {
    committed: bClosed,
    lineBuilt: network.lines.length === linesBefore + 1,
    firstTrainCars: newLine?.trains[0]?.consist.length ?? 0,
    hasPassengerCar: newLine?.trains[0]?.consist.some((c) => c.kind === 'passengers') ?? false,
  };

  const el = document.createElement('pre');
  el.id = 'ie-uitest';
  el.style.cssText = 'position:fixed;top:0;left:0;z-index:99;font-size:10px;color:#0ff;background:#000;margin:0;padding:2px';
  el.textContent = JSON.stringify(result);
  document.body.append(el);
}

const FALLBACK_GOAL = { targetCash: 2_500_000, byYear: 1890 };

/** Show the start menu, then boot the chosen setup — or regenerate the saved world and
 *  restore it when the player chooses Continue. */
async function start(): Promise<void> {
  // Headless verification: ?autostart skips the menu and boots a default game.
  if (location.search.includes('autostart')) {
    const s = SCENARIOS[0];
    await boot({
      seed: s.seed,
      year: s.year,
      startMoney: s.startMoney,
      cities: s.cities,
      goal: s.goal,
      difficulty: DIFFICULTIES[1],
      player: { name: 'Iron Empire', color: 0x8fffa8 },
      ais: [{ name: 'Atlas & Pacific', color: 0xff8a4d }],
      load: false,
    });
    return;
  }
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
