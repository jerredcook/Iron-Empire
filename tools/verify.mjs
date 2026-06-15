// Headless verification suite for Iron Empire.
//
// Boots the real game in headless Chrome (software WebGL) and asserts behaviour that a
// type/build check can't: the interactive UI (consist modal, depot upgrade, build
// factory, canvas track-laying), the live render loop, and the economy over time.
// Reuses a running dev server if one is up, otherwise launches its own.
//
// Run: npm run verify

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 5175;
const BASE = `http://127.0.0.1:${PORT}`;
const VITE = `${ROOT}node_modules/vite/bin/vite.js`;
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, () => res(true));
    req.on('error', () => res(false));
    req.setTimeout(800, () => {
      req.destroy();
      res(false);
    });
  });
}

async function waitForServer(tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (await ping()) return true;
    await sleep(400);
  }
  return false;
}

function chromeDump(query) {
  return execFileSync(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--window-size=1400,900',
      '--virtual-time-budget=20000',
      '--dump-dom',
      `${BASE}/?${query}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
}

function extract(dom, id) {
  const m = dom.match(new RegExp(`<pre id="${id}"[^>]*>([^<]*)</pre>`));
  return m ? JSON.parse(m[1]) : null;
}

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

async function main() {
  if (!CHROME) {
    console.error('No Chrome/Chromium found. Looked in:\n  ' + CHROME_CANDIDATES.join('\n  '));
    process.exit(2);
  }

  let server = null;
  if (!(await ping())) {
    console.log('Starting dev server…');
    server = spawn(process.execPath, [VITE], { cwd: ROOT, stdio: 'ignore', detached: true });
    if (!(await waitForServer())) {
      console.error('Dev server did not come up on ' + BASE);
      process.exit(2);
    }
  } else {
    console.log('Reusing dev server on ' + BASE);
  }

  try {
    console.log('• Interactive UI test…');
    const ui = extract(chromeDump('autostart&uitest'), 'ie-uitest');
    check('ui: add-train consist modal commits a typed train', ui?.addTrain?.trainAdded && ui?.addTrain?.hasCoalCar, ui?.addTrain);
    check('ui: car stepper reduced the consist', ui?.addTrain?.carCount === ui?.addTrain?.expectedCars, ui?.addTrain);
    check('ui: build-line consist modal commits a line', ui?.buildLine?.lineBuilt && ui?.buildLine?.hasPassengerCar, ui?.buildLine);
    check('ui: depot upgrade button raises level', ui?.upgradeDepot?.upgraded, ui?.upgradeDepot);
    check('ui: build-factory button founds an owned industry', ui?.buildFactory?.nowHasRecipe && ui?.buildFactory?.ownedByPlayer, ui?.buildFactory);
    check('ui: canvas track-laying builds the right line', ui?.trackLay?.lineBuilt && ui?.trackLay?.connectsChosenCities, ui?.trackLay);
    check('ui: sell train removes it from the line', ui?.sellTrain?.sold, ui?.sellTrain);
    check('ui: demolish line removes it', ui?.demolishLine?.removed, ui?.demolishLine);
    check('ui: free track lays rail with no stations (no train)', ui?.freeTrack?.trackLaidWithoutStops && ui?.freeTrack?.noStops && ui?.freeTrack?.noTrain, ui?.freeTrack);
    check('ui: build station at a city adds a depot', ui?.buildStation?.nowHasDepot, ui?.buildStation);
    check(
      'ui: demolish station removes its depot, scraps dependent lines, refunds',
      ui?.demolishStation?.depotRemoved && ui?.demolishStation?.dependentLineScrapped && ui?.demolishStation?.refunded,
      ui?.demolishStation
    );
    check(
      'ui: selecting a line by its track and demolishing it removes the line',
      ui?.lineSelect?.panelShown && ui?.lineSelect?.removed,
      ui?.lineSelect
    );
    check(
      'ui: a glutted market pays steeply less than a fresh one (dynamic pricing)',
      ui?.pricing?.cheaperWhenGlutted,
      ui?.pricing
    );
    check(
      'ui: iron+steel chain world-gens a steelworks, an iron mine, and steel-hungry cities',
      ui?.steelChain?.hasSteelmill &&
        ui?.steelChain?.steelmillConsumesIron &&
        ui?.steelChain?.hasIronMine &&
        ui?.steelChain?.citiesWantSteel,
      ui?.steelChain
    );
    check(
      'ui: a running line books earnings and reports a sane profit-per-trip',
      ui?.profit?.booked && ui?.profit?.profitFinite,
      ui?.profit
    );
    check(
      'ui: forcing a breakdown stops + bills the engine; repair clears it',
      ui?.breakdown?.broke && ui?.breakdown?.repairedOk && ui?.breakdown?.reliabilityValid,
      ui?.breakdown
    );
    check(
      'ui: cargoes ride distinct car types with per-type capacity (train cap ≠ old flat model)',
      ui?.carTypes?.coalIsHopper &&
        ui?.carTypes?.passengersIsCoach &&
        ui?.carTypes?.capacityVaries &&
        ui?.carTypes?.concreteHopperCap &&
        ui?.carTypes?.beatsOldFlatModel,
      ui?.carTypes
    );
    check(
      'ui: economic events move prices (boom up, panic down) and revert after their run',
      ui?.events?.boomRaises && ui?.events?.panicLowers && ui?.events?.revertsAfterRun && ui?.events?.wiredToNetwork,
      ui?.events
    );
    check(
      'ui: station maintenance buildings — gating, charge, stock-cap+throughput, revenue, servicing, dwell, persist',
      ui?.stationBuildings?.builtAll &&
        ui?.stationBuildings?.chargedMoney &&
        ui?.stationBuildings?.dupRejected &&
        ui?.stationBuildings?.gatedNoDepot &&
        ui?.stationBuildings?.biggerStockCap &&
        ui?.stationBuildings?.revenueBonus &&
        ui?.stationBuildings?.maintainsEngine &&
        ui?.stationBuildings?.dwellHalved &&
        ui?.stationBuildings?.persisted,
      ui?.stationBuildings
    );
    check('ui: catchment assigns towns to their nearest in-range depot', ui?.catchment?.correct, ui?.catchment);
    check('ui: rail network reaches all stops on a line', ui?.network?.reachesAllStops, ui?.network);
    check(
      'ui: junction routing threads two lines via a shared depot',
      ui?.throughService?.legsAtoC === 2 && ui?.throughService?.twoDifferentLines && ui?.throughService?.built && ui?.throughService?.serviceHasTrain,
      ui?.throughService
    );
    check('ui: signalling keeps same-line trains spaced (no telescope)', ui?.signalling?.measured && ui?.signalling?.noTelescope, ui?.signalling);
    check(
      'ui: takeover transfers acquired industries to the buyer',
      ui?.takeover?.industryToPlayer && ui?.takeover?.inPlayerIndustries && ui?.takeover?.rivalEmptied,
      ui?.takeover
    );
    check(
      'ui: save/load round-trips through-services, position, cargo, ownership',
      ui?.saveLoad?.throughPreserved && ui?.saveLoad?.ownershipPreserved && ui?.saveLoad?.positionPreserved && ui?.saveLoad?.cargoPreserved,
      ui?.saveLoad
    );

    console.log('• Render-loop test…');
    const fr = extract(chromeDump('autostart&frames=240'), 'ie-frames');
    check('loop: 240 frames ran with no render errors', fr?.framesRun === 240 && fr?.renderErrors === 0, fr);
    check('loop: train moves smoothly across frames', fr?.movedOk, fr);
    check('loop: economy advances inside the loop', fr?.moneyChanged, fr);

    console.log('• Economy test…');
    const ec = extract(chromeDump('autostart&diag&simticks=12000'), 'ie-diag');
    check('economy: deliveries occur', (ec?.deliveries ?? 0) > 0, ec);
    check('economy: rival stays solvent', (ec?.rivalNetWorth ?? -1e9) > -100_000, ec);
    check('economy: player state is sane', typeof ec?.money === 'number' && !!ec?.status, ec);
    check('economy: markets actually saturate over a long run', (ec?.maxSat ?? 0) > 0, ec);

    console.log('• Speed-control test…');
    const sp = extract(chromeDump('autostart&speedtest'), 'ie-speed');
    check('speed: pause freezes the sim (no train motion, no money change)', sp?.frozeOnPause, sp);
    check('speed: 2× advances trains ~twice as far as 1×', sp?.scales, sp);

    console.log('• Soak test (~16 game-years, busy network)…');
    const sk = extract(chromeDump('autostart&soak'), 'ie-soak');
    check('soak: no NaN / runaway / out-of-bounds over ~16 game-years', sk?.clean === true && sk?.violations === 0, sk);
  } finally {
    if (server) {
      try {
        process.kill(-server.pid);
      } catch {
        /* group already gone */
      }
    }
  }

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? '  PASS' : '  FAIL'}  ${c.name}`);
    if (!c.ok) {
      failed++;
      console.log('        ' + JSON.stringify(c.detail));
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
