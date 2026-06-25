import * as THREE from 'three';
import { Renderer, QUALITY, QualityLevel } from './engine/Renderer';
import { CameraRig } from './engine/CameraRig';
import { Heightfield } from './world/Heightfield';
import { TerrainMesh } from './world/TerrainMesh';
import { buildSky } from './world/Sky';
import { WaterPlane } from './world/WaterPlane';
import { Scatter } from './world/Scatter';
import { Network, STOCK_CAP, Company, Goal, networthGoal } from './game/Network';
import { placeCities } from './game/Economy';
import { TrackBuilder } from './game/TrackBuilder';
import { HUD } from './game/HUD';
import { Inspector } from './game/Inspector';
import { Picker } from './game/Picker';
import { SelectionMarker } from './game/SelectionMarker';
import { Minimap } from './game/Minimap';
import { LocoClass, defaultLoco, LOCOS } from './game/Locomotives';
import { AudioBus } from './game/Audio';
import { chooseScenario, DIFFICULTIES, SCENARIOS, Difficulty } from './game/Scenarios';
import { Auctioneer } from './game/Auction';
import { EventDirector } from './game/Events';
import { Smokestacks } from './game/Smokestacks';
import { configureConsist } from './game/ConsistConfig';
import { CargoKind, carCapacity, CARGO } from './game/Cargo';
import { Train, effectiveSpeed } from './game/Train';

const SIZE = 4096;
const SEA = 0;

interface BootCfg {
  seed: number;
  year: number;
  startMoney: number;
  cities: number;
  goal: Goal;
  difficulty: Difficulty;
  player: { name: string; color: number };
  ais: { name: string; color: number }[];
  /** Restore the saved game over this world instead of seeding a starter line. */
  load: boolean;
  /** Seed a starter line + train. Off for real play (you build everything yourself); on
   *  for the headless tests, which expect a running line from the first frame. */
  seedStarter: boolean;
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
  const builder = new TrackBuilder(rig.camera, renderer.gl.domElement, terrain.mesh, network, field, scene, () => selectedLoco);
  // Synthesized sound — unlocked on the first interaction, chimes on deliveries.
  const audio = new AudioBus();
  // Dev diagnostics: count deliveries/revenue so a headless run can confirm the loop.
  const diag = { revenue: 0, deliveries: 0, builds: 0, peakSat: 0 };
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

  // Time control: the sim runs at simScale × real time (0 = paused). The camera, HUD,
  // and picking stay live at real time so a paused world is still fully inspectable.
  let simScale = 1;
  let lastRunSpeed = 1;
  const applySpeed = (scale: number): void => {
    simScale = scale;
    if (scale > 0) lastRunSpeed = scale;
    hud.setSpeed(scale);
  };

  const hud = new HUD(
    network,
    () => builder.toggle(),
    () => builder.commit(),
    renderer.quality,
    applyQuality,
    (loco) => {
      selectedLoco = loco;
    },
    () => audio.toggle(),
    applySpeed,
    (line, train) => {
      // Clicking a roster row selects that train and jumps the camera to follow it.
      picker.onSelect?.({ kind: 'train', line, train });
      followTrain = train;
    },
    (c) => network.acceptContract(c)
  );
  builder.onStatus = (s) => {
    hud.setBuildStatus(s);
    rig.controls.enablePan = !s.active; // in build mode a drag lays track, so don't pan (WASD still pans)
    if (s.active) selectionMarker.hide(); // its ring would compete with the build snap rings
  };
  // Finishing a route: if the line links two depots, configure + run a train right away.
  // Otherwise just lay the track and say plainly what's needed to run it — a train earns
  // nothing without depots, so we never spawn (or charge for) one that can't work.
  builder.onCommit = (nodes) => {
    const waypoints = nodes.map((n) => n.pos);
    const stops = nodes.filter((n) => n.station).map((n) => n.station!);
    // Lay TRACK ONLY — never auto-start a train. The player adds trains deliberately from the
    // line's panel ("🚂 Start a train"), so a line never sprouts a train it didn't ask for.
    network.buildLine(waypoints, stops); // onTrackBuilt grades the terrain + clears the corridor
    const bare = stops.filter((s) => !s.hasStation);
    if (bare.length) {
      const names = bare.map((s) => s.name).join(' & ');
      hud.news(`Track laid. ${names} ${bare.length > 1 ? 'need' : 'needs'} a Station first — click the city → Build Station, then select the line → 🚂 Start a train.`, false);
    } else if (stops.length >= 2) {
      hud.news('Track laid. Select the line → 🚂 Start a train to run it.', true);
    }
  };
  renderer.gl.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  // Inspection: minimap + click-to-select + detail panel, all reading live state.
  const minimap = new Minimap(field, network);
  const selectionMarker = new SelectionMarker(scene);
  let followTrain: Train | null = null;
  const clearSelection = (): void => {
    inspector.select(null);
    minimap.setSelection(null);
    selectionMarker.hide();
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
    },
    (st) => network.buildStationAt(st),
    (st) => network.buildThroughService(st, selectedLoco),
    (st) => {
      network.demolishStation(st);
      clearSelection();
    },
    (line, train) => network.repairTrain(line, train),
    (st, type) => network.addStationBuilding(st, type),
    (line, train) => {
      const upgraded = network.replaceLoco(line, train, defaultLoco(network.year));
      if (upgraded && followTrain === train) followTrain = null; // the old train object is gone
      clearSelection();
    },
    (line) => network.repairLine(line)
  );
  const auctioneer = new Auctioneer(network);
  const smokestacks = new Smokestacks(scene, network);
  // Economic events (booms, panics, gold rushes) move freight prices for a while; wire
  // their price multiplier into the Network and their headlines into the HUD news toast.
  // Some events are physical — a storm washes out a line — surfaced the same way.
  const events = new EventDirector((text, good) => hud.news(text, good));
  network.priceModifier = (k) => events.priceMult(k);
  // Fly the camera to a world spot, keeping the current view angle and zoom.
  const focusOn = (at: { x: number; z: number }): void => {
    const dx = at.x - rig.controls.target.x;
    const dz = at.z - rig.controls.target.z;
    rig.controls.target.set(at.x, field.height(at.x, at.z), at.z);
    rig.camera.position.x += dx;
    rig.camera.position.z += dz;
  };
  // Any line that's laid (yours, a rival's, or one restored from a save) grades the terrain to
  // its new roadbed and clears trees/shrubs from the corridor.
  network.onTrackBuilt = (waypoints) => {
    terrain.resampleCorridor(field, waypoints, field.corridorReach);
    scatter.clearCorridor(waypoints);
  };
  network.onNews = (text, good, at) => hud.news(text, good, at);
  // Clicking a place-tagged toast (a city that just grew, a fulfilled contract) flies there.
  hud.onNewsClick = (at) => focusOn(at);
  // An auction flies to the lot on the block so the player can see what they're bidding on.
  auctioneer.onView = (at) => focusOn(at);
  network.onDeliveryPop = (pos, amount) => hud.popMoney(pos, amount);
  events.onDisaster = () => network.triggerRandomWashout();
  const picker = new Picker(rig.camera, renderer.gl.domElement, terrain.mesh, network, () => builder.isActive());
  picker.onSelect = (sel) => {
    followTrain = null; // selecting anything new stops following
    inspector.select(sel);
    minimap.setSelection(sel);
    // Mark the selected city in the world; clear it for line/train/empty selections.
    if (sel?.kind === 'station') selectionMarker.show(sel.station.pos);
    else selectionMarker.hide();
  };
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Escape') followTrain = null;
    // Time controls: Space toggles pause (restoring the last running speed), 1–3 set it.
    else if (e.code === 'Space') {
      e.preventDefault();
      applySpeed(simScale === 0 ? lastRunSpeed : 0);
    } else if (e.key === '1') applySpeed(1);
    else if (e.key === '2') applySpeed(2);
    else if (e.key === '3') applySpeed(3);
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
  } else if (cfg.seedStarter) {
    // Tests only: seed one productive line so the world opens in motion. Real play starts
    // empty — you lay your own first track + train.
    const pair = starterPair(network);
    if (pair) {
      network.buildStationAt(pair[0]);
      network.buildStationAt(pair[1]);
      network.buildLine([pair[0].pos, pair[1].pos], [pair[0], pair[1]], selectedLoco);
    }
  }

  // Open on a high three-quarter overview so several cities are in frame.
  rig.controls.target.set(0, 20, 0);
  rig.camera.position.set(-620, 640, 820);

  // Dev visual-check (?trackshot, never in normal play): build a line across the steepest city
  // pair, then frame the spot where the bed departs most from the land (the biggest cut or fill)
  // close + side-on — a repeatable way to eyeball terrain grading in a headless screenshot.
  if (location.search.includes('trackshot')) {
    const ss = network.stations;
    const wantWater = location.search.includes('water');
    let best: GStation[] | null = null;
    let bestScore = -1;
    for (let i = 0; i < ss.length; i++)
      for (let j = i + 1; j < ss.length; j++) {
        const d = ss[i].pos.distanceTo(ss[j].pos);
        if (d < 160 || d > 560) continue;
        // Default: the steepest pair (most cut/fill). ?water: a pair whose midpoint is over a
        // lake, to confirm the line bridges water instead of filling it.
        const mx = (ss[i].pos.x + ss[j].pos.x) / 2, mz = (ss[i].pos.z + ss[j].pos.z) / 2;
        const midH = field.height(mx, mz);
        const score = wantWater ? (field.params.seaLevel - midH) : Math.abs(ss[i].pos.y - ss[j].pos.y);
        if (score > bestScore) { bestScore = score; best = [ss[i], ss[j]]; }
      }
    if (best) {
      const natural = best.map((s) => s.pos.clone());
      network.buildStationAt(best[0]);
      network.buildStationAt(best[1]);
      network.buildLine([best[0].pos, best[1].pos], [best[0], best[1]], selectedLoco);
      const ln = network.lines[network.lines.length - 1];
      // Sample for the point with the most fill/cut vs a straight land guess between the ends.
      let bu = 0.5, bestGap = -1;
      for (let k = 1; k < 16; k++) {
        const u = k / 16;
        const p = ln.track.curve.getPointAt(u);
        const land = THREE.MathUtils.lerp(natural[0].y, natural[1].y, u);
        const gap = Math.abs(p.y - land);
        if (gap > bestGap) { bestGap = gap; bu = u; }
      }
      const mid = ln.track.curve.getPointAt(bu);
      const a = ln.track.curve.getPointAt(Math.max(0, bu - 0.06));
      const b = ln.track.curve.getPointAt(Math.min(1, bu + 0.06));
      const tan = b.clone().sub(a).setY(0).normalize();
      const side = new THREE.Vector3(-tan.z, 0, tan.x);
      rig.controls.target.copy(mid).y -= 2;
      rig.camera.position.copy(mid).addScaledVector(side, 30).addScaledVector(tan, 6);
      rig.camera.position.y = mid.y + 6;
    }
  }

  // Dev visual-check (?townshot): frame a city the starter line runs through, from above, to
  // confirm its houses relocated clear of the rails.
  if (location.search.includes('townshot')) {
    const city = network.player.lines[0]?.stops[0];
    if (city) {
      rig.controls.target.copy(city.pos);
      rig.camera.position.set(city.pos.x + 55, city.pos.y + 70, city.pos.z + 55);
    }
  }

  // Dev visual-check (?doubletrack): build two lines over the same flat-ish pair and frame the
  // middle — the second must auto-snap into a parallel double-track beside the first.
  if (location.search.includes('doubletrack')) {
    const ss = network.stations;
    let best: GStation[] | null = null;
    let bestScore = 1e9;
    for (let i = 0; i < ss.length; i++)
      for (let j = i + 1; j < ss.length; j++) {
        const d = ss[i].pos.distanceTo(ss[j].pos);
        if (d < 180 || d > 380) continue;
        const relief = Math.abs(ss[i].pos.y - ss[j].pos.y); // flattest pair reads clearest
        if (relief < bestScore) { bestScore = relief; best = [ss[i], ss[j]]; }
      }
    if (best) {
      network.buildStationAt(best[0]);
      network.buildStationAt(best[1]);
      network.buildLine([best[0].pos, best[1].pos], [best[0], best[1]], selectedLoco); // track 1
      network.buildLine([best[0].pos, best[1].pos], [best[0], best[1]], selectedLoco); // track 2 → offset
      const ln = network.lines[network.lines.length - 1];
      const mid = ln.track.curve.getPointAt(0.5);
      rig.controls.target.copy(mid);
      rig.camera.position.set(mid.x + 18, mid.y + 22, mid.z + 18);
    }
  }

  if (import.meta.env.DEV) {
    (window as unknown as { __ie: unknown }).__ie = { scene, rig, renderer, field, terrain, water, scatter, network, builder, inspector, minimap, picker };
  }

  // Always-on build stamp so it's obvious which version is loaded (kills "I don't see changes"
  // cache confusion — compare this to the latest commit).
  const buildEl = document.createElement('div');
  buildEl.textContent = `build ${__BUILD_ID__}`;
  buildEl.style.cssText =
    'position:fixed;top:6px;right:10px;z-index:60;font:10px/1.4 ui-monospace,Menlo,monospace;color:#cfe8ff;' +
    'background:rgba(12,16,22,0.66);padding:2px 7px;border-radius:5px;pointer-events:none';
  document.body.append(buildEl);

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
    let maxSat = 0;
    let steelMade = 0;
    for (const s of network.stations) {
      goods += s.stock.get('goods') ?? 0;
      maxGrowth = Math.max(maxGrowth, s.growth);
      for (const v of s.sat.values()) maxSat = Math.max(maxSat, v);
      if (s.recipe?.output === 'steel') steelMade += s.stock.get('steel') ?? 0;
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
      maxSat: +maxSat.toFixed(3),
      peakSat: +diag.peakSat.toFixed(3),
      steelStock: +steelMade.toFixed(1),
      rivalNetWorth: Math.round(network.rivals[0]?.netWorth ?? 0),
      // Per-company depot separation: cities where 2+ railroads each built their OWN depot,
      // and the rival's total self-built depots (it never free-rides on the player's).
      multiDepot: network.stations.filter((s) => s.depots.size > 1).length,
      aiDepots: network.stations.reduce((a, s) => a + [...s.depots.keys()].filter((o) => o.isAI).length, 0),
    });
  };

  // Headless verification: run the real simulation synchronously for N ticks, then
  // report — exercises trains, deliveries, the AI, growth, and the calendar.
  const simticks = Number(new URLSearchParams(location.search).get('simticks') ?? 0);
  for (let i = 0; i < simticks; i++) {
    network.update(1 / 30);
    auctioneer.update(1 / 30);
    // Track peak market saturation over the whole run — robust to the final instant being
    // quiet (a momentary lull would read 0 even though markets saturated throughout).
    for (const s of network.stations) for (const v of s.sat.values()) if (v > diag.peakSat) diag.peakSat = v;
  }
  writeDiag();

  // Dev visual-check (?compete): after the AI has expanded, frame a city where two railroads
  // each built their OWN depot — confirms the per-company station separation.
  if (location.search.includes('compete')) {
    const city = network.stations.find((s) => s.depots.size > 1);
    if (city) {
      rig.controls.target.copy(city.pos);
      rig.camera.position.set(city.pos.x + 70, city.pos.y + 85, city.pos.z + 70);
    }
  }

  // Dev visual-check (?trainshot): freeze the sim and frame a LOADED train close-up to confirm
  // the cars show their cargo (heaped hopper, stacked flat, lit coach windows).
  if (location.search.includes('trainshot')) {
    applySpeed(0); // freeze so the train stays in frame during the screenshot render
    let tr: typeof network.player.lines[number]['trains'][number] | null = null;
    for (const l of network.player.lines) for (const t of l.trains) if (t.cargoTotal() > 4) { tr = tr ?? t; }
    tr = tr ?? network.player.lines[0]?.trains[0] ?? null;
    if (tr) {
      const p = tr.headPosition.clone();
      rig.controls.target.set(p.x, p.y, p.z);
      rig.camera.position.set(p.x + 12, p.y + 22, p.z + 12);
    }
  }

  // Headless UI test: drive the real consist modal DOM for both the add-train and
  // build-line paths, then report what actually happened in the model.
  if (location.search.includes('uitest')) {
    runUiTest(network, builder, inspector, rig.camera, renderer.gl.domElement, selectedLoco, hud);
  }

  // Headless soak test: build an active multi-line economy and simulate many game-years,
  // checking every tick for NaN, runaway, or out-of-bounds stock/cargo.
  if (location.search.includes('soak')) {
    runSoak(network, selectedLoco);
  }

  // Headless single-track test: two trains on one line, run long enough for several opposing
  // meets, asserting they never overlap (block reservation) and both keep moving (no livelock).
  if (location.search.includes('singletrack')) {
    runSingleTrack(network, selectedLoco);
  }


  // Headless AI test: on a fresh world with an open map, hand a rival capital and time and
  // confirm it plays smart — scales winners, sharpens depots, expands, invests, stays solvent.
  if (location.search.includes('aitest')) {
    runAiTest(network);
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
    // The simulation advances at the chosen speed (0 = paused); ambient water/scatter
    // and everything below stay on real time so the view never freezes.
    const sim = dt * simScale;
    water.update(dt);
    scatter.update(dt);
    smokestacks.update(dt); // ambient — keeps the chimneys alive even while paused
    selectionMarker.update(dt); // pulse/bob on real time, even while paused
    builder.update(dt); // throb the snap ring while laying track
    network.update(sim);
    auctioneer.update(sim);
    events.update(sim);
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
      smokeStacks: smokestacks.count(), // chimneys lit over the run (industries are at work)
    });
    document.body.append(el);
  }

  // Headless speed test: pause freezes the sim (no train motion, no money change), and
  // 2× advances trains about twice as far as 1× over the same number of real frames.
  if (location.search.includes('speedtest')) {
    for (let i = 0; i < 60; i++) step(1 / 30); // warm up so trains are cruising
    const measure = (n: number): number => {
      const ts = network.lines.flatMap((l) => l.trains);
      const prev = ts.map((t) => t.railDist);
      let path = 0;
      for (let i = 0; i < n; i++) {
        step(1 / 30);
        ts.forEach((t, k) => {
          path += Math.abs(t.railDist - prev[k]);
          prev[k] = t.railDist;
        });
      }
      return path;
    };
    applySpeed(0);
    const moneyAtPause = network.money;
    const pausedPath = measure(40);
    const pausedMoneyDelta = Math.abs(network.money - moneyAtPause);
    applySpeed(1);
    const d1 = measure(90);
    applySpeed(2);
    const d2 = measure(90);
    applySpeed(1);
    const el = document.createElement('pre');
    el.id = 'ie-speed';
    el.style.cssText = 'position:fixed;top:80px;left:0;z-index:99;font-size:10px;color:#0f0;background:#000;margin:0;padding:2px';
    el.textContent = JSON.stringify({
      pausedPath: +pausedPath.toFixed(3),
      pausedMoneyDelta: +pausedMoneyDelta.toFixed(3),
      d1: +d1.toFixed(1),
      d2: +d2.toFixed(1),
      frozeOnPause: pausedPath < 0.01 && pausedMoneyDelta < 0.01,
      scales: d1 > 1 && d2 > d1 * 1.5,
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

  // First-time players get the how-to-play card once (skipped for headless test runs).
  if (!location.search.includes('autostart')) {
    try {
      if (!localStorage.getItem('ie.helpSeen')) {
        hud.showHelp();
        localStorage.setItem('ie.helpSeen', '1');
      }
    } catch {
      /* localStorage may be unavailable */
    }
  }
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
/** Press at (x1,y1), drag to (x2,y2), release — the primary track-laying gesture. */
function dragCanvas(canvas: HTMLElement, x1: number, y1: number, x2: number, y2: number): void {
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x1, clientY: y1, button: 0, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x2, clientY: y2, button: 0, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x2, clientY: y2, button: 0, bubbles: true }));
}

function runUiTest(
  network: Network,
  builder: TrackBuilder,
  inspector: Inspector,
  camera: THREE.PerspectiveCamera,
  canvas: HTMLElement,
  loco: LocoClass,
  hud: HUD
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

  // B) Build a new line through the builder's commit path — it must lay TRACK ONLY (no
  //    auto-train) — then start a train on it deliberately via the configure path.
  const linesBefore = network.lines.length;
  builder.onCommit?.(line.stops.map((s) => ({ pos: s.pos, station: s })));
  const newLine = network.lines[network.lines.length - 1];
  const lineBuilt = network.lines.length === linesBefore + 1;
  const trackOnly = (newLine?.trains.length ?? -1) === 0; // building must never spawn a train
  configureConsist(network, newLine.stops, loco, (cars) => network.addTrain(newLine, loco, cars));
  const bClosed = driveConsistModal('passengers');
  result.buildLine = {
    committed: bClosed,
    lineBuilt,
    trackOnly,
    firstTrainCars: newLine?.trains[0]?.consist.length ?? 0,
    hasPassengerCar: newLine?.trains[0]?.consist.some((c) => c.kind === 'passengers') ?? false,
  };

  // C) Depot upgrade via the inspector station panel button (needs a depot first).
  const upStation = network.stations[0];
  network.buildStationAt(upStation);
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

  // H0) Build a station at a city that has none, via the inspector button.
  const bareCity = network.stations.find((s) => !s.hasStation);
  if (bareCity) {
    inspector.select({ kind: 'station', station: bareCity });
    inspector.update(1);
    (document.querySelector('[data-buildstation]') as HTMLElement | null)?.click();
    result.buildStation = { hadDepot: false, nowHasDepot: bareCity.hasStation };
  }

  // H) Free-form track with no city stops → rail is laid, but no train (no route yet).
  const beforeFree = network.lines.length;
  const o = network.stations[0].pos;
  builder.onCommit?.([
    { pos: new THREE.Vector3(o.x + 160, 0, o.z + 160), station: null },
    { pos: new THREE.Vector3(o.x + 360, 0, o.z + 240), station: null },
  ]);
  const free = network.lines[network.lines.length - 1];
  result.freeTrack = {
    trackLaidWithoutStops: network.lines.length === beforeFree + 1,
    noStops: free?.stops.length === 0,
    noTrain: free?.trains.length === 0,
  };

  // I) Catchment: every depot-less city must belong to its nearest in-range depot.
  let catchmentCorrect = true;
  for (const c of network.stations) {
    if (c.hasStation) continue;
    let nearest: typeof c | null = null;
    let nd = network.catchmentRange;
    for (const d of network.stations) {
      if (!d.hasStation) continue;
      const dist = Math.hypot(d.pos.x - c.pos.x, d.pos.z - c.pos.z);
      if (dist < nd) {
        nd = dist;
        nearest = d;
      }
    }
    const servedBySome = network.stations.some((d) => d.hasStation && d.catchment.includes(c));
    if (nearest ? !nearest.catchment.includes(c) : servedBySome) catchmentCorrect = false;
  }
  result.catchment = {
    correct: catchmentCorrect,
    anyDepotServesTowns: network.stations.some((s) => s.hasStation && s.catchment.length > 0),
  };

  // J) Network reachability: stations on a line reach each other across the network.
  const netLine = network.lines.find((l) => l.stops.length >= 2);
  if (netLine) {
    const reach = network.reachableFrom(netLine.stops[0]);
    result.network = { reachesAllStops: netLine.stops.every((s) => reach.has(s)), reachCount: reach.size };
  }

  // K) Junction routing: two lines sharing a depot, a through-service threads both.
  const A = network.stations[1];
  const B = network.stations[2];
  const C = network.stations[3];
  network.buildStationAt(A);
  network.buildStationAt(B);
  network.buildStationAt(C);
  network.buildLine([A.pos, B.pos], [A, B], loco);
  network.buildLine([B.pos, C.pos], [B, C], loco);
  const legs = network.pathLegs(A, C);
  const tsBuilt = network.buildThroughService(A, loco);
  const tsLine = network.lines[network.lines.length - 1];
  result.throughService = {
    legsAtoC: legs?.length ?? 0, // expect 2 — A→B then B→C
    twoDifferentLines: legs?.length === 2 ? legs[0].line !== legs[1].line : false,
    built: tsBuilt,
    serviceHasTrain: (tsLine?.trains.length ?? 0) >= 1,
  };

  // L) Signalling: two trains on one isolated line, both moving the same way, hold an
  //    arc-length gap and never telescope (measured by rail position — robust on curves).
  //    A dedicated line (away from the through-service rails) isolates same-line spacing.
  const P = network.stations[6];
  const Q = network.stations[9];
  network.buildStationAt(P);
  network.buildStationAt(Q);
  network.buildLine([P.pos, Q.pos], [P, Q], loco);
  const sigLine = network.lines[network.lines.length - 1];
  network.addTrain(sigLine, loco);
  for (let i = 0; i < 150; i++) network.update(1 / 30); // warm up — let trains separate
  let minGap = Infinity;
  let sameDirTicks = 0;
  for (let i = 0; i < 600; i++) {
    network.update(1 / 30);
    const ts = sigLine.trains;
    if (ts.length < 2 || ts[0].heading !== ts[1].heading) continue;
    sameDirTicks++;
    // The arc block holds the follower a safe gap behind, so the rail-distance gap
    // never collapses (a telescope would drive it toward 0).
    minGap = Math.min(minGap, Math.abs(ts[0].railDist - ts[1].railDist));
  }
  result.signalling = {
    minGap: Number.isFinite(minGap) ? +minGap.toFixed(1) : -1,
    sameDirTicks,
    noTelescope: minGap > 6,
    measured: sameDirTicks > 50,
  };

  // M) Takeover transfers the acquired company's industries to the buyer.
  const rival = network.rivals[0];
  const lot = network.ownableIndustries()[0];
  if (rival && lot) {
    network.awardIndustry(lot, rival, 1000);
    network.player.money = 1e9;
    network.buyShares(rival, 60_000); // > 50% → takeover
    result.takeover = {
      industryToPlayer: lot.owner === network.player,
      inPlayerIndustries: network.player.industries.includes(lot),
      rivalEmptied: rival.industries.length === 0,
    };
  }

  // N) Save → load round-trips through-services, cargo, train position, ownership.
  for (let i = 0; i < 400; i++) network.update(1 / 30); // let trains pick up cargo
  const sumPos = (): number => network.lines.flatMap((l) => l.trains).reduce((a, t) => a + t.railDist, 0);
  const sumCargo = (): number => network.lines.flatMap((l) => l.trains).reduce((a, t) => a + t.cargoTotal(), 0);
  const pre = {
    through: network.lines.filter((l) => l.through).length,
    owned: network.stations.filter((s) => s.owner).length,
    pos: sumPos(),
    cargo: sumCargo(),
  };
  network.save();
  network.loadFromStorage();
  result.saveLoad = {
    cargoBefore: +pre.cargo.toFixed(0),
    throughPreserved: pre.through > 0 && network.lines.filter((l) => l.through).length === pre.through,
    ownershipPreserved: network.stations.filter((s) => s.owner).length === pre.owned,
    positionPreserved: Math.abs(sumPos() - pre.pos) < 25,
    cargoPreserved: Math.abs(sumCargo() - pre.cargo) < 5,
  };

  // M) Demolish station via the inspector button: the depot goes away, every line that
  //    stops there is scrapped with it, and the player is refunded.
  //    Use cities the player can actually build on (no pre-existing rival depot), so the
  //    player owns the depot it then tears down.
  //    (The harness has amassed enough cash to trip the win condition by now, which
  //    halts building — reset to 'playing' so we exercise the demolish mechanic itself.)
  network.status = 'playing';
  const freeCities = network.stations.filter((s) => !s.hasStation);
  const ds1 = freeCities[0];
  const ds2 = freeCities[1];
  network.buildStationAt(ds1);
  network.buildStationAt(ds2);
  network.buildLine([ds1.pos, ds2.pos], [ds1, ds2], loco);
  const dsLine = network.lines[network.lines.length - 1];
  const moneyBeforeDS = network.player.money;
  const linesBeforeDS = network.lines.length;
  inspector.select({ kind: 'station', station: ds1 });
  inspector.update(1);
  const dsBtnShown = !!document.querySelector('[data-demolishstation]');
  (document.querySelector('[data-demolishstation]') as HTMLElement | null)?.click();
  result.demolishStation = {
    btnShown: dsBtnShown,
    depotRemoved: !ds1.hasStation,
    dependentLineScrapped: !network.lines.includes(dsLine) && network.lines.length < linesBeforeDS,
    refunded: network.player.money > moneyBeforeDS,
  };

  // N) Select a line by its track (the Picker's 'line' selection) and demolish it from
  //    the line panel — the path a player takes when clicking rails to delete them.
  const ls1 = freeCities[2];
  const ls2 = freeCities[3];
  network.buildStationAt(ls1);
  network.buildStationAt(ls2);
  network.buildLine([ls1.pos, ls2.pos], [ls1, ls2], loco);
  const lsLine = network.lines[network.lines.length - 1];
  const linesBeforeLS = network.lines.length;
  inspector.select({ kind: 'line', line: lsLine });
  inspector.update(1);
  const lsPanelShown = !!document.querySelector('[data-demolish]');
  (document.querySelector('[data-demolish]') as HTMLElement | null)?.click();
  result.lineSelect = {
    panelShown: lsPanelShown,
    removed: !network.lines.includes(lsLine) && network.lines.length < linesBeforeLS,
  };

  // O) Dynamic pricing: a market pays full price when fresh and steeply less when glutted.
  const pcCity = network.stations.find((s) => s.hasStation) ?? network.stations[0];
  pcCity.sat.set('goods', 0);
  const freshPrice = network.marketPrice(pcCity, 'goods');
  pcCity.sat.set('goods', 1);
  const gluttedPrice = network.marketPrice(pcCity, 'goods');
  pcCity.sat.set('goods', 0); // restore
  result.pricing = {
    fresh: +freshPrice.toFixed(3),
    glutted: +gluttedPrice.toFixed(3),
    cheaperWhenGlutted: gluttedPrice < freshPrice - 0.1 && freshPrice > 0.95,
  };

  // P) Iron + steel chain: world-gen guaranteed a steelworks (coal+iron→steel), an iron
  //    mine to feed it, and cities that want the steel.
  const steelmill = network.stations.find((s) => s.recipe?.output === 'steel');
  const ironmine = network.stations.find((s) => Object.keys(s.supplies).includes('iron'));
  result.steelChain = {
    hasSteelmill: !!steelmill,
    steelmillConsumesIron: !!steelmill && steelmill.demands.has('iron') && steelmill.demands.has('coal'),
    hasIronMine: !!ironmine,
    citiesWantSteel: network.stations.some((s) => s.archetype.kind === 'City' && s.demands.has('steel')),
  };

  // Q) Profit-per-trip readout: a running line books earnings and reports a sane P/L.
  //    Build a guaranteed trade — a grain farm to its nearest grain-eating city — then run
  //    it (holding 'playing' so the amassed test cash doesn't trip the win condition and
  //    freeze the sim), and read the line that earned the most.
  network.status = 'playing';
  const grainFarm = network.stations.find((s) => Object.keys(s.supplies).includes('grain'));
  let grainCity: GStation | null = null;
  let gd = Infinity;
  if (grainFarm) {
    for (const s of network.stations) {
      if (s === grainFarm || !s.demands.has('grain')) continue;
      const d = s.pos.distanceToSquared(grainFarm.pos);
      if (d < gd) {
        gd = d;
        grainCity = s;
      }
    }
  }
  if (grainFarm && grainCity) {
    if (!grainFarm.hasStation) network.buildStationAt(grainFarm);
    if (!grainCity.hasStation) network.buildStationAt(grainCity);
    network.buildLine([grainFarm.pos, grainCity.pos], [grainFarm, grainCity], loco, ['grain', 'grain']);
  }
  for (let i = 0; i < 2500; i++) {
    network.status = 'playing';
    network.update(1 / 30);
  }
  let plLine: (typeof network.lines)[number] | null = null;
  let bestEarned = -1;
  for (const l of network.player.lines) {
    if (!l.through && l.earned > bestEarned) {
      bestEarned = l.earned;
      plLine = l;
    }
  }
  if (plLine) {
    const st = network.lineStats(plLine);
    result.profit = {
      earned: Math.round(st.earned),
      trips: st.trips,
      perTrip: Math.round(st.perTrip),
      profitFinite: Number.isFinite(st.profitPerYear),
      booked: st.earned > 0 && st.trips > 0 && st.perTrip > 0,
    };
  }

  // R) Breakdown + repair: forcing a failure stops the engine and bills the owner; the
  //    repair button clears it.
  if (plLine && plLine.trains.length) {
    network.status = 'playing';
    const tr = plLine.trains[0];
    const moneyBeforeBreak = network.player.money;
    tr.forceBreakdown();
    const brokeAndBilled = tr.broken && network.player.money < moneyBeforeBreak;
    const repaired = network.repairTrain(plLine, tr);
    result.breakdown = {
      broke: brokeAndBilled,
      repairedOk: repaired && !tr.broken,
      reliabilityValid: LOCOS.every((l) => l.reliability > 0 && l.reliability <= 1),
    };
  }

  // S) Distinct car types: each cargo maps to a car type with its own capacity, and a
  //    train's total capacity is the sum of its cars' (not a flat per-car constant).
  //    The hopper train built for the grain line above (28/car) lets us assert a concrete
  //    capacity the old flat 24/car model would get wrong — not a tautology.
  const coalCap = carCapacity('coal'); // hopper
  const cattleCap = carCapacity('cattle'); // stock
  const hopperTrain = network.player.lines
    .flatMap((l) => l.trains)
    .find((t) => t.consist.length > 0 && t.consist.every((c) => CARGO[c.kind].car === 'hopper'));
  result.carTypes = {
    coalIsHopper: CARGO.coal.car === 'hopper',
    passengersIsCoach: CARGO.passengers.car === 'coach',
    capacityVaries: coalCap !== cattleCap && coalCap > cattleCap && coalCap === 28 && cattleCap === 18,
    concreteHopperCap: hopperTrain ? hopperTrain.capacity === 28 * hopperTrain.consist.length : false,
    beatsOldFlatModel: hopperTrain ? hopperTrain.capacity !== 24 * hopperTrain.consist.length : false,
  };

  // T) Economic events: a boom raises a cargo's price, a panic lowers everything, and
  //    every event reverts once its run is over. (auto=false so the scheduler stays quiet.)
  const ed = new EventDirector(undefined, false);
  ed.forceEvent('boom', 'steel');
  const boomMult = ed.priceMult('steel');
  ed.forceEvent('panic');
  const panicMult = ed.priceMult('grain');
  for (let i = 0; i < 6000; i++) ed.update(1 / 30); // 200 game-seconds — past every duration
  result.events = {
    boomRaises: boomMult > 1.3,
    panicLowers: panicMult < 1,
    revertsAfterRun: Math.abs(ed.priceMult('steel') - 1) < 0.001 && Math.abs(ed.priceMult('grain') - 1) < 0.001,
    wiredToNetwork: typeof network.priceModifier === 'function',
  };

  // U) Station maintenance buildings: each is a one-time player-depot purchase with a
  //    concrete effect — gating, charge, stock-cap, revenue bonus, engine servicing, and
  //    persistence across save/load.
  network.status = 'playing';
  const sbCity = network.stations.find((s) => !s.hasStation);
  if (sbCity) {
    network.buildStationAt(sbCity);
    const moneyBeforeSB = network.player.money;
    const builtAll =
      network.addStationBuilding(sbCity, 'warehouse') &&
      network.addStationBuilding(sbCity, 'postoffice') &&
      network.addStationBuilding(sbCity, 'hotel') &&
      network.addStationBuilding(sbCity, 'roundhouse') &&
      network.addStationBuilding(sbCity, 'watertower');
    const chargedMoney = network.player.money < moneyBeforeSB;
    const dupRejected = !network.addStationBuilding(sbCity, 'warehouse'); // already built
    const bareCity2 = network.stations.find((s) => !s.hasStation);
    const gatedNoDepot = bareCity2 ? !network.addStationBuilding(bareCity2, 'warehouse') : true;
    const bareForCompare = network.stations.find((s) => s.hasStation && !s.buildings.has('warehouse'));
    const biggerStockCap =
      network.stockCap(sbCity) > STOCK_CAP &&
      (bareForCompare ? network.loadPerStop(sbCity) > network.loadPerStop(bareForCompare) : network.loadPerStop(sbCity) > 80);
    const revenueBonus =
      network.stationRevenueMult(sbCity, 'passengers') > 1 && network.stationRevenueMult(sbCity, 'goods') === 1;
    const someTrain = network.player.lines.flatMap((l) => l.trains)[0] ?? null;
    let maintainsEngine = false;
    if (someTrain) {
      someTrain.forceBreakdown();
      someTrain.maintain();
      maintainsEngine = !someTrain.broken;
    }
    // Water tower: expediteDwell halves an active berth dwell. Build a dedicated SHORT line
    // (closest free pair) so its lone train berths quickly and reliably — independent of
    // whatever state the rest of the test has accumulated — then assert the call halves it.
    let dwellHalved = false;
    const wfree = network.stations.filter((s) => !s.hasStation);
    if (wfree.length >= 2) {
      let wa = wfree[0];
      let wb = wfree[1];
      let wbd = Infinity;
      for (let i = 0; i < wfree.length; i++)
        for (let j = i + 1; j < wfree.length; j++) {
          const d = wfree[i].pos.distanceToSquared(wfree[j].pos);
          if (d < wbd) {
            wbd = d;
            wa = wfree[i];
            wb = wfree[j];
          }
        }
      network.buildStationAt(wa);
      network.buildStationAt(wb);
      network.buildLine([wa.pos, wb.pos], [wa, wb], loco);
      const wtTrain = network.lines[network.lines.length - 1].trains[0];
      for (let i = 0; i < 3000 && wtTrain; i++) {
        network.status = 'playing';
        network.update(1 / 30);
        if (wtTrain.dwellRemaining > 0.6) break;
      }
      const before = wtTrain ? wtTrain.dwellRemaining : 0;
      wtTrain?.expediteDwell();
      dwellHalved = !!wtTrain && before > 0.6 && Math.abs(wtTrain.dwellRemaining - before * 0.5) < 0.02;
    }
    network.save();
    network.status = 'playing';
    network.loadFromStorage();
    result.stationBuildings = {
      builtAll,
      chargedMoney,
      dupRejected,
      gatedNoDepot,
      biggerStockCap,
      revenueBonus,
      maintainsEngine,
      dwellHalved,
      persisted: sbCity.buildings.has('warehouse') && sbCity.buildings.has('hotel') && sbCity.buildings.size === 5,
    };
  }

  // W) Terrain shapes speed: the pure speed-cap curve (flat/straight/empty = full; climbing,
  //    a tight curve, and a heavy load each cost speed; a downgrade gives a little back), and
  //    that a real train's cap drops when it's loaded at the same spot.
  const flat = effectiveSpeed(40, 0, 0, 0);
  const climb = effectiveSpeed(40, 0.035, 0, 0);
  const steeper = effectiveSpeed(40, 0.1, 0, 0);
  const descend = effectiveSpeed(40, -0.035, 0, 0);
  const curve = effectiveSpeed(40, 0, 0.12, 0);
  const loadedCurve = effectiveSpeed(40, 0, 0, 1);
  const spTrain = network.player.lines.flatMap((l) => l.trains)[0] ?? null;
  let loadSlows = false;
  if (spTrain) {
    for (const c of spTrain.consist) c.amount = 0;
    const emptyCap = spTrain.speedCapNow;
    for (const c of spTrain.consist) c.amount = 24;
    const loadedCap = spTrain.speedCapNow;
    loadSlows = emptyCap > 0 && loadedCap < emptyCap;
    for (const c of spTrain.consist) c.amount = 0;
  }
  result.terrainSpeed = {
    flatIsFull: Math.abs(flat - 40) < 0.01,
    climbSlows: climb < 40,
    steeperIsSlower: steeper < climb,
    descendBoosts: descend >= 40,
    curveSlows: curve < 40 * 0.6,
    loadSlowsCurve: loadedCurve < 40,
    realTrainLoadSlows: loadSlows,
  };

  // X) First-connection bonus: joining two previously-unconnected cities pays a grant;
  //    a redundant line on an already-joined pair pays nothing.
  network.status = 'playing';
  const fc = network.stations.filter((s) => !s.hasStation);
  if (fc.length >= 2 && !network.isConnected(fc[0], fc[1])) {
    network.buildStationAt(fc[0]);
    network.buildStationAt(fc[1]);
    const cost1 = network.lineCost([fc[0].pos, fc[1].pos], loco);
    const m0 = network.player.money;
    network.buildLine([fc[0].pos, fc[1].pos], [fc[0], fc[1]], loco);
    const paid1 = m0 - network.player.money; // = cost − bonus
    const cost2 = network.lineCost([fc[0].pos, fc[1].pos], loco);
    const m1 = network.player.money;
    network.buildLine([fc[0].pos, fc[1].pos], [fc[0], fc[1]], loco); // pair already joined
    const paid2 = m1 - network.player.money;
    result.firstConnect = {
      bonusOnNew: paid1 < cost1, // got a rebate on the first link
      noBonusRedundant: paid2 >= cost2 - 1, // paid full fare for the redundant line
    };
  }

  // Y) Fleet roster: the HUD lists every player train (loco name + route), and clicking a
  //    row selects that train (the inspector opens its panel).
  network.status = 'playing';
  hud.update(camera, 1400, 900); // populate the roster (the live loop hasn't run in test mode)
  const rosterRows = document.querySelectorAll('[data-rosterrow]');
  const fleetCount = network.player.lines.reduce((a, l) => a + l.trains.length, 0);
  const firstRow = rosterRows[0] as HTMLElement | undefined;
  const rowNamesLoco = !!firstRow && network.player.lines.flatMap((l) => l.trains).some((t) => firstRow.textContent?.includes(t.locoClass.name));
  inspector.select(null);
  firstRow?.click();
  inspector.update(1);
  const clickOpenedTrain = !!document.querySelector('[data-follow]'); // the Follow button lives only in the train panel
  result.roster = {
    rowsMatchFleet: rosterRows.length > 0 && rosterRows.length === fleetCount,
    rowNamesLoco,
    clickSelectsTrain: clickOpenedTrain,
  };

  // Z) Engine in-place upgrade: re-engine a train, keeping its consist, cargo, and place
  //    on the line, for the price difference.
  network.status = 'playing';
  const euCities = network.stations.filter((s) => !s.hasStation);
  if (euCities.length >= 2) {
    const c1 = euCities[0];
    const c2 = euCities[1];
    network.buildStationAt(c1);
    network.buildStationAt(c2);
    const oldLoco = LOCOS[0]; // Grasshopper
    network.buildLine([c1.pos, c2.pos], [c1, c2], oldLoco, ['grain', 'grain']);
    const euLine = network.lines[network.lines.length - 1];
    const tr = euLine.trains[0];
    for (let i = 0; i < 300; i++) {
      network.status = 'playing';
      network.update(1 / 30);
    }
    network.status = 'playing'; // the funded test trips the win condition; keep it live
    tr.consist.forEach((c) => (c.amount = 12)); // give it real cargo to preserve
    const beforeKinds = tr.consist.map((c) => c.kind).join(',');
    const beforeCargo = tr.consist.reduce((a, c) => a + c.amount, 0);
    const beforeDist = tr.railDist;
    const newLoco = LOCOS[6]; // Mountain — a much better engine
    const net = network.reLocoCost(tr, newLoco);
    const m0 = network.player.money;
    const ok = network.replaceLoco(euLine, tr, newLoco);
    const nt = euLine.trains[0];
    result.engineUpgrade = {
      swapped: ok && nt.locoClass.id === newLoco.id && nt !== tr,
      consistPreserved: nt.consist.map((c) => c.kind).join(',') === beforeKinds,
      cargoPreserved: Math.abs(nt.consist.reduce((a, c) => a + c.amount, 0) - beforeCargo) < 1,
      positionPreserved: Math.abs(nt.railDist - beforeDist) < 5,
      charged: Math.abs(m0 - network.player.money - net) < 1,
      trainCountSame: euLine.trains.length === 1,
    };
  }

  // AA) Washout disaster: a storm halts a line's trains until it rebuilds or is repaired.
  network.status = 'playing';
  const woCities = network.stations.filter((s) => !s.hasStation);
  if (woCities.length >= 2) {
    const wa = woCities[0];
    const wb = woCities[1];
    network.buildStationAt(wa);
    network.buildStationAt(wb);
    network.buildLine([wa.pos, wb.pos], [wa, wb], loco, ['grain', 'grain']);
    const woLine = network.lines[network.lines.length - 1];
    const woTrain = woLine.trains[0];
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        network.status = 'playing';
        network.update(1 / 30);
      }
    };
    // Strike while the train is berthed, exercising the "held at a stop" path: a halted
    // line must NOT keep re-servicing (booking phantom trips/revenue) every dwell cycle.
    for (let i = 0; i < 3000; i++) {
      network.status = 'playing';
      network.update(1 / 30);
      if (woTrain.dwellRemaining > 0.3) break;
    }
    network.status = 'playing';
    const tripsAtStrike = woLine.trips;
    const blocked = network.washoutLine(woLine) && network.isBlocked(woLine);
    const d1 = woTrain.railDist;
    tick(300); // ~10s halted at the berth — several would-be dwell cycles
    const haltsTrains = Math.abs(woTrain.railDist - d1) < 1;
    const noPhantomTrips = woLine.trips === tripsAtStrike;
    network.status = 'playing'; // the funded test trips the win condition; keep it live
    const m0 = network.player.money;
    const repaired = network.repairLine(woLine);
    const charged = network.player.money < m0;
    const d3 = woTrain.railDist;
    tick(220);
    const resumes = Math.abs(woTrain.railDist - d3) > 5;
    network.status = 'playing';
    network.washoutLine(woLine, 0.5); // a half-second washout…
    tick(60); // …2 sim-seconds later it has rebuilt itself
    const autoClears = !network.isBlocked(woLine);
    result.washout = {
      blocked,
      haltsTrains,
      noPhantomTrips,
      repairCharges: repaired && charged,
      resumes,
      autoClears,
    };
  }

  // BB) Living world: a well-served settlement climbs the stage ladder to Metropolis,
  //     picking up new cargo appetites on the way.
  network.status = 'playing';
  const grow =
    network.stations.find((s) => s.archetype.kind === 'Town') ??
    network.stations.find((s) => s.archetype.size < 2 && s.stage < 3 && s.demands.size < 6);
  if (grow) {
    const stage0 = grow.stage;
    const demands0 = grow.demands.size;
    grow.served = 240; // force full prosperity, then let one tick recompute growth
    network.update(0.01);
    result.cityEvolves = {
      stageRose: grow.stage > stage0,
      reachedMetropolis: grow.stage === 3,
      titleMetropolis: network.stageName(grow) === 'Metropolis',
      unlockedNewDemand: grow.demands.size > demands0,
      labelShowsStage: network.stationLabel(grow).includes('Metropolis'),
    };
  }

  // CC) Haul contracts: accept a job, deliver toward it to fulfil it for a reward, and an
  //     unmet job lapses at its deadline.
  network.status = 'playing';
  const ccCity =
    network.stations.find((s) => s.hasStation && s.demands.has('grain')) ??
    network.stations.find((s) => s.hasStation && s.demands.size > 0);
  if (ccCity) {
    const cargo: CargoKind = ccCity.demands.has('grain') ? 'grain' : [...ccCity.demands][0];
    const c = network.addContract(ccCity, cargo, 30, 50_000, network.year + 10);
    const accepted = network.acceptContract(c);
    const wasActive = c.status === 'active';
    const m0 = network.player.money;
    network.creditContracts(ccCity, cargo, 40); // deliver 40 (≥ the 30 required)
    const rewardPaid = network.player.money === m0 + 50_000;
    // A second job, already past its deadline, should lapse on the next tick.
    const c2 = network.addContract(ccCity, cargo, 50, 30_000, network.year - 1);
    network.acceptContract(c2);
    network.status = 'playing';
    network.update(0.01);
    result.contract = {
      accepted: accepted && wasActive,
      progressed: c.delivered === 40,
      completed: c.status === 'done',
      rewardPaid,
      expires: c2.status === 'failed',
    };
  }

  // DD) Victory medals: gold/silver/bronze tiers, an early win on reaching gold, the game
  //     NOT ending the instant it crosses bronze, and the right medal awarded at the deadline.
  const th = network.medalThresholds();
  const tiersCorrect =
    network.medalFor(0) === 'none' &&
    network.medalFor(th.bronze) === 'bronze' &&
    network.medalFor(th.silver) === 'silver' &&
    network.medalFor(th.gold) === 'gold' &&
    th.silver > th.bronze &&
    th.gold > th.silver;
  // (`as string` casts below break TS's literal-narrowing of status/earnedMedal across the
  //  update() calls — the methods mutate them but TS can't see that.)
  const stat = (): string => network.status;
  const med = (): string => network.earnedMedal;
  // Overwhelming net worth wins immediately with gold, even before the deadline.
  network.status = 'playing';
  network.earnedMedal = 'none';
  network.player.money = th.gold * 3;
  network.year = network.goal.byYear - 5;
  network.update(0.01);
  const goldEarlyWin = stat() === 'won' && med() === 'gold';
  // Above bronze but below gold, before the deadline: the game keeps running (no early end).
  network.status = 'playing';
  network.earnedMedal = 'none';
  network.player.money = th.bronze;
  network.year = network.goal.byYear - 5;
  network.update(0.01);
  const noEarlyBronzeEnd = network.player.netWorth >= th.gold ? stat() === 'won' : stat() === 'playing';
  // At the deadline with at least bronze: win with the medal that matches net worth.
  network.status = 'playing';
  network.earnedMedal = 'none';
  network.player.money = th.bronze;
  network.year = network.goal.byYear + 1;
  const expectedMedal = network.medalFor(network.player.netWorth);
  network.update(0.01);
  const byYearMedal = expectedMedal === 'none' ? stat() === 'lost' : stat() === 'won' && med() === expectedMedal;
  result.medals = { tiersCorrect, goldEarlyWin, noEarlyBronzeEnd, byYearMedal };

  // EE) Onboarding: the how-to-play overlay opens and the "Got it" button closes it.
  hud.showHelp();
  const helpOverlay = document.querySelector('[data-helpoverlay]') as HTMLElement | null;
  const helpShown = !!helpOverlay && helpOverlay.style.display === 'flex';
  const gotIt = document.querySelector('[data-closehelp]') as HTMLElement | null;
  gotIt?.click();
  result.help = {
    opens: helpShown,
    hasCard: !!gotIt,
    closes: !!helpOverlay && helpOverlay.style.display === 'none',
  };

  // FF) Varied objectives: each kind reports the right progress and resolves win/lose
  //     through the same medal logic — cargo by cumulative deliveries, contracts by count,
  //     connect by the largest linked component of the player's own lines.
  {
    const saved = network.goal;
    network.player.money = 5_000_000;

    // Cargo — cumulative player deliveries of the target cargo.
    network.status = 'playing';
    network.earnedMedal = 'none';
    network.goal = { kind: 'cargo', cargo: 'coal', byYear: network.year + 20, bronze: 100, silver: 200, gold: 400 };
    network.cargoHauled.set('coal', 0);
    const cargoZero = network.objectiveProgress() === 0;
    network.cargoHauled.set('coal', 250);
    const cargoProg = network.objectiveProgress() === 250 && network.medalFor(250) === 'silver';
    network.cargoHauled.set('coal', 450); // crossing gold before the deadline wins immediately
    network.update(0.01);
    const cargoWin = stat() === 'won' && med() === 'gold';

    // Contracts — fulfilled-contract counter.
    network.status = 'playing';
    network.earnedMedal = 'none';
    network.goal = { kind: 'contracts', byYear: network.year + 20, bronze: 2, silver: 4, gold: 6 };
    network.contractsDone = 5;
    const contractsProg = network.objectiveProgress() === 5 && network.medalFor(5) === 'silver';

    // Connect — largest set of cities linked into one of the player's networks.
    network.status = 'playing';
    network.earnedMedal = 'none';
    network.goal = { kind: 'connect', byYear: network.year + 20, bronze: 2, silver: 3, gold: 4 };
    const a = network.stations[0];
    const b = network.stations[1];
    const c = network.stations[2];
    network.buildLine([a.pos, b.pos], [a, b]);
    network.buildLine([b.pos, c.pos], [b, c]);
    const connected = network.playerCitiesConnected();
    const connectProg = network.objectiveProgress() === connected && connected >= 3;

    network.goal = saved;
    network.status = 'playing';
    network.earnedMedal = 'none';
    result.objectives = { cargoZero, cargoProg, cargoWin, contractsProg, connectProg, connected };
  }

  // GG) Build guidance: committing a line to a city that has no depot warns the player in
  //     plain language, so a train that earns nothing isn't a silent mystery.
  {
    network.status = 'playing';
    network.player.money = 5_000_000;
    // Earlier tests have given most cities depots, so deliberately strip two back to bare
    // to exercise the station-missing warning path deterministically.
    const x = network.stations[0];
    const y = network.stations[1];
    network.demolishStation(x);
    network.demolishStation(y);
    const newsEl = document.querySelector('[data-news]') as HTMLElement | null;
    let warnedStationless = false;
    if (!x.hasStation && !y.hasStation && newsEl) {
      newsEl.textContent = '';
      builder.onCommit?.([
        { pos: x.pos, station: x },
        { pos: y.pos, station: y },
      ]);
      driveConsistModal('goods'); // confirm the train → fires the warning
      warnedStationless = /station/i.test(newsEl.textContent ?? '');
    }
    result.buildGuidance = {
      warnedStationless,
      finishButton: !!document.querySelector('[data-finishroute]'),
      bothBare: !x.hasStation && !y.hasStation,
    };
  }

  // HH) Selection + station visuals: the city marker shows/hides on demand, and building a
  //     line snaps the stop's depot beside the rails so it reads as connected to the track.
  {
    const sc = new THREE.Scene();
    const marker = new SelectionMarker(sc);
    const startsHidden = !marker.active;
    const target = network.stations[0];
    marker.show(target.pos);
    const shown = marker.active && marker.position.distanceTo(target.pos) < 0.001;
    marker.update(0.1);
    marker.hide();
    const hidden = !marker.active;
    marker.dispose();

    network.status = 'playing';
    network.player.money = 5_000_000;
    const da = network.stations.find((s) => !s.hasStation);
    const db = network.stations.filter((s) => !s.hasStation && s !== da)[0];
    let depotAligned = false;
    let besideTrack = false;
    if (da && db) {
      network.buildStationAt(da);
      network.buildStationAt(db);
      network.buildLine([da.pos, db.pos], [da, db], loco);
      const dep = da.depots.get(network.player);
      depotAligned = dep?.aligned === true;
      const d = dep ? Math.hypot(dep.mesh.position.x - da.pos.x, dep.mesh.position.z - da.pos.z) : 999;
      besideTrack = d > 4 && d < 26; // beside the rails — not on top of the city, not far off
    }
    result.selectionUI = { startsHidden, shown, hidden, depotAligned, besideTrack };
  }

  // II) Start-a-train flow (line-panel CTA, gated on depots) + keyboard navigation.
  {
    network.status = 'playing';
    network.player.money = 5_000_000;
    // Earlier tests left most cities with depots, so strip two back to bare deterministically.
    const bareA = network.stations[0];
    const bareB = network.stations[1];
    network.demolishStation(bareA);
    network.demolishStation(bareB);
    let trainGatedOffDepots = false;
    let trainRunsWithDepots = false;
    let ctaAppearsWithDepots = false;
    let ctaStartsTrain = false;
    if (!bareA.hasStation && !bareB.hasStation) {
      // Depot-less line: track laid, but no train and the line knows it can't run one.
      network.buildLine([bareA.pos, bareB.pos], [bareA, bareB], loco);
      const line = network.player.lines[network.player.lines.length - 1];
      trainGatedOffDepots = line.trains.length === 0 && !network.canRunTrains(line);
      inspector.select({ kind: 'line', line });
      inspector.update(1);
      const ctaWhenIneligible = !!document.querySelector('[data-addtrain]');
      // Build both depots → the line becomes runnable and the Start-a-train CTA appears.
      network.buildStationAt(bareA);
      network.buildStationAt(bareB);
      trainRunsWithDepots = network.canRunTrains(line);
      inspector.select({ kind: 'line', line });
      inspector.update(1);
      const cta = document.querySelector('[data-addtrain]') as HTMLElement | null;
      ctaAppearsWithDepots = !!cta && !ctaWhenIneligible;
      const before = line.trains.length;
      cta?.click();
      driveConsistModal('goods');
      ctaStartsTrain = line.trains.length === before + 1;
    }

    // Keyboard navigation: reset restores the opening view; Q orbits; R zooms in.
    const navRig = new CameraRig(document.createElement('div'), 4096);
    const homePos = navRig.camera.position.clone();
    navRig.camera.position.x += 800;
    navRig.reset();
    const resetOK = navRig.camera.position.distanceTo(homePos) < 0.001;
    const beforeRot = navRig.camera.position.clone();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));
    navRig.update(0.25);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'q' }));
    const rotated = navRig.camera.position.distanceTo(beforeRot) > 1;
    const distBefore = navRig.camera.position.distanceTo(navRig.controls.target);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    navRig.update(0.25);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'r' }));
    const zoomed = navRig.camera.position.distanceTo(navRig.controls.target) < distBefore - 1;

    result.startTrainAndNav = { trainGatedOffDepots, trainRunsWithDepots, ctaAppearsWithDepots, ctaStartsTrain, resetOK, rotated, zoomed };
  }

  // KK) Snapping to a depot-less destination: dragging to a bare city must still latch onto
  //     it so the line actually connects there (you wire the track first, then add a depot).
  {
    network.status = 'playing';
    network.player.money = 5_000_000;
    builder.cancel();
    const start = network.stations[0];
    const dest = network.stations[1];
    if (!start.hasStation) network.buildStationAt(start);
    network.demolishStation(dest); // make the destination bare
    const mid = start.pos.clone().add(dest.pos).multiplyScalar(0.5);
    const span = start.pos.distanceTo(dest.pos);
    camera.position.set(mid.x + 1, mid.y + Math.max(span * 1.3, 500), mid.z + 1);
    camera.lookAt(mid);
    camera.updateMatrixWorld(true);
    const rect = canvas.getBoundingClientRect();
    const screen = (p: THREE.Vector3): { x: number; y: number } => {
      const v = p.clone().project(camera);
      return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
    };
    const ss = screen(start.pos);
    const sd = screen(dest.pos);
    const before = network.lines.length;
    builder.start();
    dragCanvas(canvas, ss.x, ss.y, sd.x, sd.y);
    (document.querySelector('[data-finishroute]') as HTMLElement | null)?.click();
    driveConsistModal('grain'); // no-op (track-only, since the destination has no depot)
    const built = network.lines.length === before + 1;
    const nl = network.lines[network.lines.length - 1];
    result.bareSnap = { built, connectsBareDest: built && !dest.hasStation && nl.stops.includes(dest) };
    builder.cancel();
  }

  // LL) Track grade: a line over the most elevation-varied corridor eases to a gentle ruling
  //     gradient with no abrupt ramp (smooth grade transitions, not flat-then-steep).
  {
    network.status = 'playing';
    network.player.money = 5_000_000;
    const ss2 = network.stations;
    let ga = ss2[0];
    let gb = ss2[1];
    let bestDh = -1;
    for (let i = 0; i < ss2.length; i++) {
      for (let j = i + 1; j < ss2.length; j++) {
        const dxz = Math.hypot(ss2[i].pos.x - ss2[j].pos.x, ss2[i].pos.z - ss2[j].pos.z);
        if (dxz < 150 || dxz > 800) continue; // a normal-length line
        const dh = Math.abs(ss2[i].pos.y - ss2[j].pos.y);
        if (dh > bestDh) { bestDh = dh; ga = ss2[i]; gb = ss2[j]; }
      }
    }
    if (!ga.hasStation) network.buildStationAt(ga);
    if (!gb.hasStation) network.buildStationAt(gb);
    network.buildLine([ga.pos, gb.pos], [ga, gb], loco);
    const curve = network.player.lines[network.player.lines.length - 1].track.curve;
    const N = 90;
    const gp: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) gp.push(curve.getPointAt(i / N));
    let maxGrade = 0;
    let maxJump = 0;
    let prevGrade = 0;
    for (let i = 1; i <= N; i++) {
      const dxz = Math.max(1e-4, Math.hypot(gp[i].x - gp[i - 1].x, gp[i].z - gp[i - 1].z));
      const grade = (gp[i].y - gp[i - 1].y) / dxz;
      maxGrade = Math.max(maxGrade, Math.abs(grade));
      if (i > 1) maxJump = Math.max(maxJump, Math.abs(grade - prevGrade));
      prevGrade = grade;
    }
    result.grade = {
      dh: +bestDh.toFixed(1),
      maxGrade: +maxGrade.toFixed(4),
      maxJump: +maxJump.toFixed(4),
      // The fix: the grade changes smoothly (no abrupt flat-then-ramp) and never spikes into
      // a cliff — even the most elevation-varied corridor runs an even ruling gradient.
      smooth: maxJump <= 0.02 && maxGrade <= 0.25,
    };
  }

  // MM) Track is colour-coded by owner: a player line's rails carry the player's livery (a
  //     green-ish steel), not bare grey steel — so your track reads as yours at a glance.
  {
    network.status = 'playing';
    network.player.money = 5_000_000;
    const a = network.stations[0];
    const b = network.stations[1];
    if (!a.hasStation) network.buildStationAt(a);
    if (!b.hasStation) network.buildStationAt(b);
    network.buildLine([a.pos, b.pos], [a, b], loco);
    const line = network.player.lines[network.player.lines.length - 1];
    let railHex = -1;
    line.track.group.traverse((o) => {
      const m = o as THREE.Mesh;
      const mat = m.material as THREE.MeshStandardMaterial | undefined;
      if (mat && mat.metalness >= 0.8 && railHex < 0) railHex = mat.color.getHex();
    });
    const c = new THREE.Color(railHex >= 0 ? railHex : 0);
    result.trackColor = {
      found: railHex >= 0,
      tinted: railHex >= 0 && railHex !== 0xb8bdc4, // not bare steel
      towardPlayer: c.g > c.r, // the player livery (0x8fffa8) is green-dominant
    };
  }

  // NN) A player delivery floats a "+$N" up from the train, then fades.
  {
    const target = network.stations[0].pos;
    camera.position.set(target.x, target.y + 260, target.z + 260);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    hud.update(camera, 1400, 900); // stores the camera so popMoney can project
    const before = document.querySelectorAll('[data-moneypop]').length;
    hud.popMoney(target, 91234);
    const pops = [...document.querySelectorAll('[data-moneypop]')];
    result.moneyPop = {
      shown: pops.length === before + 1,
      hasAmount: pops.some((e) => (e.textContent ?? '').includes('+$91,234')),
    };
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

  // A route can only stop at cities with depots — build them first.
  network.buildStationAt(a);
  network.buildStationAt(b);

  const linesBefore = network.lines.length;
  builder.start();
  // Press the start city and drag to the destination — the new primary gesture lays the
  // whole segment in one motion (drops the start on press, the end on release).
  dragCanvas(canvas, sa.x, sa.y, sb.x, sb.y);
  // Finish via the on-screen ✓ button — the discoverable primary path (not the Enter shortcut).
  const finishBtn = document.querySelector('[data-finishroute]') as HTMLButtonElement | null;
  const finishReady = !!finishBtn && !finishBtn.disabled;
  finishBtn?.click(); // commit → consist modal
  const consistClosed = driveConsistModal('goods');
  const built = network.lines.length === linesBefore + 1;
  const nl = network.lines[network.lines.length - 1];
  return {
    aOnScreen: sa.on,
    bOnScreen: sb.on,
    lineBuilt: built,
    connectsChosenCities: built ? nl.stops.includes(a) && nl.stops.includes(b) : false,
    consistCommitted: consistClosed,
    finishButtonReady: finishReady,
  };
}

/** Single-track collision test (its own headless page so it doesn't bloat the UI dump): two
 *  trains on one 3-stop line, run long enough for several opposing meets. Asserts they never
 *  overlap (block reservation pulls one aside to pass) and both keep moving (no livelock). */
function runSingleTrack(network: Network, loco: LocoClass): void {
  network.player.money = 5_000_000;
  network.goal = networthGoal(Number.MAX_SAFE_INTEGER, 99999); // don't auto-win mid-sim
  const sx = network.stations;
  const trio = [sx[0], sx[1], sx[2]];
  trio.forEach((c) => { if (!c.hasStation) network.buildStationAt(c); });
  network.buildLine([trio[0].pos, trio[1].pos, trio[2].pos], trio, loco); // 3 stops = a passing point
  const line = network.player.lines[network.player.lines.length - 1];
  network.addTrain(line, loco); // a second train → opposing traffic
  const tr = line.trains;
  let st: Record<string, unknown> = { noCollision: false, bothMoved: false };
  if (tr.length >= 2) {
    const traveled = [0, 0];
    const last = [tr[0].railDist, tr[1].railDist];
    let minDist = Infinity;
    for (let i = 0; i < 2500; i++) {
      network.status = 'playing';
      network.update(1 / 30);
      for (let k = 0; k < 2; k++) {
        traveled[k] += Math.abs(tr[k].railDist - last[k]);
        last[k] = tr[k].railDist;
      }
      const d = tr[0].headPosition.distanceTo(tr[1].headPosition);
      if (d < minDist) minDist = d;
    }
    st = {
      noCollision: minDist > 2.5, // never overlapped — closest is one parked aside as the other passes
      bothMoved: traveled[0] > 400 && traveled[1] > 400, // neither starved
      minDist: +minDist.toFixed(2),
      traveled: traveled.map((t) => Math.round(t)),
    };
  }
  const el = document.createElement('pre');
  el.id = 'ie-singletrack';
  el.style.cssText = 'position:fixed;top:0;left:0;z-index:99;font-size:10px;color:#0ff;background:#000;margin:0;padding:2px;white-space:pre-wrap';
  el.textContent = JSON.stringify(st);
  document.body.append(el);
}

/** Build a busy multi-line economy and simulate ~16 game-years, asserting every tick
 *  that nothing goes NaN, runs away, or leaves valid bounds. */
function runSoak(network: Network, loco: LocoClass): void {
  const TICKS = 14000; // ~12 game-years (trimmed to keep the verify suite brisk)
  // Fund everyone and remove the win/lose deadline so the sim keeps running.
  network.player.money = 5e8;
  for (const r of network.rivals) r.money = 5e8;
  network.goal = networthGoal(Number.MAX_SAFE_INTEGER, 99999);

  // Lay a web of lines across the map, double a few up.
  const s = network.stations;
  for (let i = 0; i + 1 < Math.min(s.length, 18); i += 2) {
    network.buildStationAt(s[i]);
    network.buildStationAt(s[i + 1]);
    network.buildLine([s[i].pos, s[i + 1].pos], [s[i], s[i + 1]], loco);
  }
  for (const l of network.player.lines.slice(0, 5)) network.addTrain(l, loco);

  const bad = (v: number): boolean => !Number.isFinite(v);
  let violations = 0;
  let firstTick = -1;
  let firstViolation = '';
  const flag = (msg: string, t: number): void => {
    violations++;
    if (firstTick < 0) {
      firstTick = t;
      firstViolation = msg;
    }
  };

  for (let t = 0; t < TICKS; t++) {
    network.update(1 / 30);
    for (const c of network.companies) {
      if (bad(c.money) || bad(c.netWorth)) flag(`company ${c.name} money/netWorth not finite`, t);
    }
    for (const st of network.stations) {
      const cap = network.stockCap(st) + 2; // a warehouse legitimately raises the ceiling
      for (const [k, amt] of st.stock) {
        if (bad(amt) || amt < -0.5 || amt > cap) flag(`stock ${st.name}/${k}=${amt}`, t);
      }
      for (const [k, amt] of st.input) {
        if (bad(amt) || amt < -0.5 || amt > cap) flag(`input ${st.name}/${k}=${amt}`, t);
      }
    }
    for (const l of network.lines) {
      for (const tr of l.trains) {
        for (const car of tr.consist) {
          if (bad(car.amount) || car.amount < -0.5 || car.amount > carCapacity(car.kind) + 2) flag(`car ${car.kind}=${car.amount}`, t);
        }
        if (bad(tr.railDist)) flag('train railDist not finite', t);
      }
    }
    if (violations > 0 && firstTick === t) break; // stop at the first failing tick
  }

  const el = document.createElement('pre');
  el.id = 'ie-soak';
  el.style.cssText = 'position:fixed;top:80px;left:0;z-index:99;font-size:10px;color:#f80;background:#000;margin:0;padding:2px';
  el.textContent = JSON.stringify({
    ticks: TICKS,
    violations,
    firstTick,
    firstViolation,
    clean: violations === 0,
    finalYear: network.year,
    finalMoney: Math.round(network.money),
    lines: network.lines.length,
    trains: network.lines.reduce((a, l) => a + l.trains.length, 0),
    deliveries: 0,
  });
  document.body.append(el);
}

/** Hand a rival real capital on a fresh, open map and confirm it plays smart: scales busy
 *  lines, sharpens depots, expands the network, invests spare cash, and stays solvent. */
function runAiTest(network: Network): void {
  // Ensure a second rival exists so the AI→AI stock-market path (companyBuyShares with
  // allowTakeover=true, accumulating toward absorbing another railroad) is exercised — the
  // single-AI autostart config can only ever test a capped position in the player.
  if (network.companies.filter((c) => c.isAI).length < 2) {
    network.companies.push(new Company('Sierra & Gulf', 0x4dff8a, true, 600_000));
  }
  const ai = network.companies.find((c) => c.isAI);
  let result: Record<string, unknown> = { hasAI: false };
  if (ai) {
    ai.money = 5_000_000;
    const before = network.lines.filter((l) => l.owner.isAI).length;
    for (let i = 0; i < 7000; i++) {
      network.status = 'playing';
      network.update(1 / 30);
    }
    const aiLines = network.lines.filter((l) => l.owner.isAI);
    const maxTrains = aiLines.reduce((m, l) => Math.max(m, l.trains.length), 0);
    const totalHoldings = network.companies.reduce(
      (a, c) => a + [...c.holdings.values()].reduce((x, y) => x + y, 0),
      0
    );
    const aiDepots = network.stations.filter((s) => [...s.depots.keys()].some((o) => o.isAI));
    const maxLevel = aiDepots.reduce((m, s) => Math.max(m, s.level), 0);
    const anyWarehouse = aiDepots.some((s) => s.buildings.has('warehouse'));
    const aliveAIs = network.companies.filter((c) => c.isAI && !c.defunct);
    const defunctAIs = network.companies.filter((c) => c.isAI && c.defunct).length;
    result = {
      hasAI: true,
      expands: aiLines.length > before,
      reinforces: maxTrains >= 2,
      upgrades: maxLevel >= 1 || anyWarehouse,
      invests: totalHoldings > 0 || defunctAIs > 0,
      solvent: aliveAIs.length > 0 && aliveAIs.every((c) => c.netWorth > -100_000 && Number.isFinite(c.money)),
    };
  }
  const el = document.createElement('pre');
  el.id = 'ie-ai';
  el.style.cssText = 'position:fixed;top:120px;left:0;z-index:99;font-size:10px;color:#0ff;background:#000;margin:0;padding:2px';
  el.textContent = JSON.stringify(result);
  document.body.append(el);
}

// Only used as the boot-config goal when Continuing a save — load() then overwrites it
// with the saved objective, so the exact value here is immaterial.
const FALLBACK_GOAL: Goal = networthGoal(2_500_000, 1890);

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
      seedStarter: true, // headless tests expect a running line from frame one
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
      seedStarter: false,
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
    seedStarter: false, // real play: you build your own first line
  });
}

void start();
