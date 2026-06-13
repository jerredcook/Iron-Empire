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
