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
import { Train } from './game/Train';

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
  let followTrain: Train | null = null;
  const clearSelection = (): void => {
    inspector.select(null);
    minimap.setSelection(null);
  };
  const inspector = new Inspector(
    network,
    clearSelection,
    (line) => {
      if (!line.owner.isAI) configureConsist(network, line.stops, selectedLoco, (cars) => network.addTrain(line, selectedLoco, cars));
    },
    (st) => network.buildIndustry(st),
    (st) => network.upgradeStation(st),
    (train) => {
      followTrain = train;
    },
    (line, train) => {
      network.sellTrain(line, train);
      if (followTrain === train) followTrain = null;
      clearSelection();
    },
    (line) => {
      if (line.trains.includes(followTrain as Train)) followTrain = null;
      network.demolishLine(line);
      clearSelection();
    }
  );
  const auctioneer = new Auctioneer(network);
  const picker = new Picker(rig.camera, renderer.gl.domElement, terrain.mesh, network, () => builder.isActive());
  picker.onSelect = (sel) => {
    followTrain = null; // selecting anything new stops following
    inspector.select(sel);
    minimap.setSelection(sel);
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') followTrain = null;
  });
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
    runUiTest(network, builder, inspector, rig.camera, renderer.gl.domElement, selectedLoco);
  }

  // One frame of the whole game — used by the live loop and the headless frame test.
  const step = (dt: number): void => {
    rig.update(dt);
    // Follow camera: shift the whole rig so the followed train stays centred while
    // the player can still orbit/zoom around it. Drops follow if the train is gone.
    if (followTrain) {
      const onRails = network.lines.some((l) => l.trains.includes(followTrain as Train));
      if (!onRails) followTrain = null;
      else {
        const p = followTrain.headPosition;
        const dx = p.x - rig.controls.target.x;
        const dy = p.y - rig.controls.target.y;
        const dz = p.z - rig.controls.target.z;
        rig.controls.target.set(p.x, p.y, p.z);
        rig.camera.position.set(rig.camera.position.x + dx, rig.camera.position.y + dy, rig.camera.position.z + dz);
      }
    }
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

  // Headless render-loop test: run the real per-frame step N times (rendering and all)
  // and assert it never throws and a train physically moves across the frames.
  const frames = Number(new URLSearchParams(location.search).get('frames') ?? 0);
  if (frames > 0) {
    step(1 / 30); // one step so the train is placed on the rail before we sample it
    const train = network.lines[0]?.trains[0];
    const start = train ? train.headPosition.clone() : new THREE.Vector3();
    const moneyStart = network.money;
    let ran = 0;
    let renderErrors = 0;
    let lastError = '';
    let maxStep = 0; // largest single-frame movement — a moving train, not a teleport
    for (let i = 0; i < frames; i++) {
      const prev = train ? train.headPosition.clone() : new THREE.Vector3();
      try {
        step(1 / 30);
        ran++;
      } catch (e) {
        renderErrors++;
        lastError = String(e);
      }
      if (train) maxStep = Math.max(maxStep, train.headPosition.distanceTo(prev));
    }
    const moved = train ? train.headPosition.distanceTo(start) : 0;
    const el = document.createElement('pre');
    el.id = 'ie-frames';
    el.style.cssText = 'position:fixed;top:40px;left:0;z-index:99;font-size:10px;color:#ff0;background:#000;margin:0;padding:2px';
    el.textContent = JSON.stringify({
      framesRun: ran,
      renderErrors,
      lastError,
      trainMoved: +moved.toFixed(1),
      maxFrameStep: +maxStep.toFixed(2),
      movedOk: moved > 5 && maxStep < 20, // it travelled, and smoothly (no teleport)
      moneyChanged: network.money !== moneyStart,
    });
    document.body.append(el);
  }

  const clock = new THREE.Clock();
  const loop = (): void => {
    requestAnimationFrame(loop);
    step(Math.min(clock.getDelta(), 0.05));
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

/** Dispatch a real click (pointerdown+up at one spot) on the canvas at pixel x,y. */
function clickCanvas(canvas: HTMLElement, x: number, y: number): void {
  for (const type of ['pointerdown', 'pointerup'] as const) {
    canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  }
}

function runUiTest(
  network: Network,
  builder: TrackBuilder,
  inspector: Inspector,
  camera: THREE.PerspectiveCamera,
  canvas: HTMLElement,
  loco: LocoClass
): void {
  const result: Record<string, unknown> = {};
  network.player.money = 5_000_000; // fund the test so nothing fails on affordability
  const maxCars = network.maxCars(loco);

  // A) Add a configured train to the existing starter line (drives the consist modal).
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

  // C) Depot upgrade via the inspector station panel button.
  const upStation = network.stations[0];
  const lvlBefore = upStation.level;
  inspector.select({ kind: 'station', station: upStation });
  inspector.update(1); // force a render so the panel + handlers exist
  (document.querySelector('[data-upgrade]') as HTMLElement | null)?.click();
  result.upgradeDepot = { levelBefore: lvlBefore, levelAfter: upStation.level, upgraded: upStation.level === lvlBefore + 1 };

  // D) Build factory via the inspector station panel button (a city without industry).
  const facStation = network.stations.find((s) => !s.recipe);
  if (facStation) {
    inspector.select({ kind: 'station', station: facStation });
    inspector.update(1);
    (document.querySelector('[data-industry]') as HTMLElement | null)?.click();
    result.buildFactory = { hadRecipe: false, nowHasRecipe: !!facStation.recipe, ownedByPlayer: facStation.owner === network.player };
  }

  // E) Lay track by clicking the canvas: frame two unconnected cities, click each, Enter.
  result.trackLay = layTrackTest(network, builder, camera, canvas);

  // F) Sell a train via the inspector button.
  const sellLine = network.lines.find((l) => !l.owner.isAI && l.trains.length > 1);
  if (sellLine) {
    const beforeT = sellLine.trains.length;
    inspector.select({ kind: 'train', line: sellLine, train: sellLine.trains[0] });
    inspector.update(1);
    (document.querySelector('[data-sell]') as HTMLElement | null)?.click();
    result.sellTrain = { before: beforeT, after: sellLine.trains.length, sold: sellLine.trains.length === beforeT - 1 };
  }

  // G) Demolish a line via the inspector button.
  const demoLine = network.lines.find((l) => !l.owner.isAI && l.trains.length > 0);
  if (demoLine) {
    const beforeL = network.lines.length;
    inspector.select({ kind: 'train', line: demoLine, train: demoLine.trains[0] });
    inspector.update(1);
    (document.querySelector('[data-demolish]') as HTMLElement | null)?.click();
    result.demolishLine = { before: beforeL, after: network.lines.length, removed: !network.lines.includes(demoLine) };
  }

  const el = document.createElement('pre');
  el.id = 'ie-uitest';
  el.style.cssText = 'position:fixed;top:0;left:0;z-index:99;font-size:10px;color:#0ff;background:#000;margin:0;padding:2px;max-width:100vw;white-space:pre-wrap';
  el.textContent = JSON.stringify(result);
  document.body.append(el);
}

/** Drive the whole interactive track-laying pipeline with real canvas pointer events. */
function layTrackTest(
  network: Network,
  builder: TrackBuilder,
  camera: THREE.PerspectiveCamera,
  canvas: HTMLElement
): Record<string, unknown> {
  // Closest pair of cities not yet connected.
  const s = network.stations;
  let a = s[0];
  let b = s[1];
  let bd = Infinity;
  for (let i = 0; i < s.length; i++)
    for (let j = i + 1; j < s.length; j++) {
      if (network.isConnected(s[i], s[j])) continue;
      const d = s[i].pos.distanceToSquared(s[j].pos);
      if (d < bd) {
        bd = d;
        a = s[i];
        b = s[j];
      }
    }

  // Frame the camera nearly top-down over the pair so both project on-screen.
  const mid = a.pos.clone().add(b.pos).multiplyScalar(0.5);
  const dist = a.pos.distanceTo(b.pos);
  camera.position.set(mid.x + 1, mid.y + Math.max(dist * 1.3, 500), mid.z + 1);
  camera.lookAt(mid);
  camera.updateMatrixWorld(true);

  const rect = canvas.getBoundingClientRect();
  const screen = (p: THREE.Vector3): { x: number; y: number; on: boolean } => {
    const v = p.clone().project(camera);
    return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top, on: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
  };
  const sa = screen(a.pos);
  const sb = screen(b.pos);

  const linesBefore = network.lines.length;
  builder.start();
  clickCanvas(canvas, sa.x, sa.y); // first stop
  clickCanvas(canvas, sb.x, sb.y); // second stop (snaps to the city)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); // finish → consist modal
  const consistClosed = driveConsistModal('goods');
  const built = network.lines.length === linesBefore + 1;
  const nl = network.lines[network.lines.length - 1];
  return {
    aOnScreen: sa.on,
    bOnScreen: sb.on,
    lineBuilt: built,
    connectsChosenCities: built ? nl.stops.includes(a) && nl.stops.includes(b) : false,
    consistCommitted: consistClosed,
  };
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
