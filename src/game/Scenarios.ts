import { Network, CompanySetup, Goal, networthGoal } from './Network';
import { CARGO } from './Cargo';

/**
 * A starting situation: the world that's generated and the objective that defines victory.
 * Different scenarios set different *kinds* of objective — amass net worth, haul a cargo,
 * link cities into one network, or fulfil contracts — which is what makes them play
 * differently rather than just being the same race with a different map.
 */
export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  seed: number;
  year: number;
  startMoney: number;
  cities: number;
  goal: Goal;
}

/** How hard the contest is: capital on both sides and how driven the rivals are. */
export interface Difficulty {
  id: string;
  name: string;
  blurb: string;
  playerMult: number;
  aiMult: number;
  aiInterval: number;
  aiReserve: number;
}

export const DIFFICULTIES: Difficulty[] = [
  { id: 'apprentice', name: 'Apprentice', blurb: 'Generous capital, cautious rivals.', playerMult: 1.3, aiMult: 0.8, aiInterval: 9, aiReserve: 220_000 },
  { id: 'financier', name: 'Financier', blurb: 'An even contest.', playerMult: 1.0, aiMult: 1.0, aiInterval: 6, aiReserve: 160_000 },
  { id: 'tycoon', name: 'Tycoon', blurb: 'Lean capital, driven rivals.', playerMult: 0.8, aiMult: 1.2, aiInterval: 4.5, aiReserve: 120_000 },
  { id: 'baron', name: 'Robber Baron', blurb: 'Brutal — rivals are rich and relentless.', playerMult: 0.62, aiMult: 1.5, aiInterval: 3.2, aiReserve: 90_000 },
];

export interface GameSetup {
  scenario: Scenario;
  player: CompanySetup;
  ais: CompanySetup[];
  cities: number;
  seed: number;
  goal: Goal;
  difficulty: Difficulty;
}

export type StartChoice = { kind: 'new'; setup: GameSetup } | { kind: 'continue' };

export const SCENARIOS: Scenario[] = [
  { id: 'pioneer', name: 'Pioneer Valley', blurb: 'A temperate frontier. Grow a railroad worth a fortune.', seed: 20260611, year: 1862, startMoney: 850_000, cities: 20, goal: networthGoal(2_500_000, 1890) },
  { id: 'coal', name: 'Coal Country', blurb: 'A rugged mining belt — keep the furnaces fed with coal.', seed: 7771234, year: 1855, startMoney: 700_000, cities: 28, goal: { kind: 'cargo', cargo: 'coal', byYear: 1888, bronze: 1500, silver: 3500, gold: 6000 } },
  { id: 'ironroad', name: 'The Iron Road', blurb: 'Span the territory — knit its cities into one network.', seed: 4242777, year: 1866, startMoney: 950_000, cities: 32, goal: { kind: 'connect', byYear: 1894, bronze: 9, silver: 13, gold: 18 } },
  { id: 'contractor', name: 'The Contractor', blurb: 'Make your name fulfilling hauls the cities put out to bid.', seed: 3318890, year: 1864, startMoney: 800_000, cities: 24, goal: { kind: 'contracts', byYear: 1895, bronze: 3, silver: 6, gold: 9 } },
  { id: 'golden', name: 'Golden State', blurb: 'A booming coast. Big cities, bigger ambitions.', seed: 5550987, year: 1872, startMoney: 1_100_000, cities: 36, goal: networthGoal(4_000_000, 1898) },
  { id: 'gambit', name: "Tycoon's Gambit", blurb: 'Thin capital and hungry rivals. A fortune, fast.', seed: 9123456, year: 1860, startMoney: 500_000, cities: 14, goal: networthGoal(3_500_000, 1885) },
];

/** A short human description of an objective's tiers, e.g. "Net worth · 🥉 $2.5M  🥈 $4.0M  🥇 $6.3M".
 *  The heading names the unit (cargo / cities / contracts) so the bare tier numbers read clearly. */
export function describeGoal(g: Goal): string {
  const fmt = (v: number): string => (g.kind === 'networth' ? `$${(v / 1e6).toFixed(1)}M` : `${v}`);
  const head =
    g.kind === 'cargo' ? `Haul ${g.cargo && CARGO[g.cargo] ? CARGO[g.cargo].label.toLowerCase() : 'cargo'}`
    : g.kind === 'connect' ? 'Cities linked'
    : g.kind === 'contracts' ? 'Contracts filled'
    : 'Net worth';
  return `${head} · 🥉 ${fmt(g.bronze)}  🥈 ${fmt(g.silver)}  🥇 ${fmt(g.gold)} · by ${g.byYear}`;
}

const LIVERIES = [0x8fffa8, 0x6db4d6, 0xffe28a, 0xff8a4d, 0xff7766, 0xc792ea, 0x9bd07a, 0xb89a7a];
const AI_NAMES = ['Atlas & Pacific', 'Great Northern', 'Union Central'];
const AI_COLORS = [0xff8a4d, 0x6db4d6, 0xc792ea];
const SANDBOX_YEAR = 9999;
const CITY_OPTIONS = [14, 20, 28, 36];

/** Show the setup screen and resolve with the chosen setup, or 'continue' to resume. */
export function chooseScenario(): Promise<StartChoice> {
  return new Promise((resolve) => {
    const setup: GameSetup = {
      scenario: SCENARIOS[0],
      player: { name: 'Iron Empire', color: 0x8fffa8 },
      ais: [{ name: AI_NAMES[0], color: AI_COLORS[0] }],
      cities: SCENARIOS[0].cities,
      seed: SCENARIOS[0].seed,
      goal: { ...SCENARIOS[0].goal },
      difficulty: DIFFICULTIES[1],
    };
    let sandbox = false;
    let randomMap = false;

    const overlay = el('div', {
      position: 'fixed',
      inset: '0',
      zIndex: '50',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '4px',
      padding: '24px 0',
      background: 'radial-gradient(circle at 50% 18%, #1b2733, #0a0e13)',
      color: '#f4f0e6',
      font: '14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif',
      overflow: 'auto',
    });
    const title = el('div', { fontSize: '44px', fontWeight: '800', letterSpacing: '3px' });
    title.textContent = 'IRON EMPIRE';
    overlay.append(title);

    const finish = (choice: StartChoice): void => {
      overlay.remove();
      resolve(choice);
    };
    if (Network.hasSave()) {
      const cont = button('▶  Continue saved game', '#8fffa8', () => finish({ kind: 'continue' }));
      cont.style.margin = '6px 0';
      overlay.append(cont);
    }

    const grid = el('div', { display: 'grid', gridTemplateColumns: 'repeat(2, 330px)', gap: '14px', marginTop: '8px' });
    overlay.append(grid);

    // --- Scenario panel ---
    const scenarioBody = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
    const scenarioCards: { card: HTMLElement; s: Scenario }[] = [];
    for (const s of SCENARIOS) {
      const card = el('button', cardStyle());
      const tag =
        s.goal.kind === 'cargo' ? '🚚 Cargo'
        : s.goal.kind === 'connect' ? '🕸 Network'
        : s.goal.kind === 'contracts' ? '📋 Contracts'
        : '💰 Net worth';
      card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-weight:700">${s.name}</span><span style="font-size:10.5px;opacity:0.6">${tag}</span></div><div style="font-size:11.5px;opacity:0.7">${s.blurb}</div>`;
      card.onclick = () => {
        setup.scenario = s;
        if (!randomMap) setup.seed = s.seed;
        setup.cities = s.cities;
        if (!sandbox) setup.goal = { ...s.goal };
        refresh();
      };
      scenarioCards.push({ card, s });
      scenarioBody.append(card);
    }
    grid.append(panel('Scenario', scenarioBody));

    // --- Company identity panel ---
    const nameInput = textInput(setup.player.name, (v) => (setup.player.name = v || 'Iron Empire'));
    const playerSwatches = swatchRow(LIVERIES, setup.player.color, (c) => {
      setup.player.color = c;
      refresh();
    });
    const idBody = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
    idBody.append(sub('Railroad name'), nameInput, sub('Livery'), playerSwatches.row);
    grid.append(panel('Your Company', idBody));

    // --- Map panel ---
    const mapBody = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
    const citiesSeg = segmented(CITY_OPTIONS.map(String), CITY_OPTIONS.indexOf(setup.cities), (i) => (setup.cities = CITY_OPTIONS[i]));
    const seedSeg = segmented(['Scenario map', '↻ Random map'], 0, (i) => {
      randomMap = i === 1;
      setup.seed = randomMap ? Math.floor(Math.random() * 1e9) : setup.scenario.seed;
      refresh();
    });
    mapBody.append(sub('Cities'), citiesSeg, sub('Terrain'), seedSeg);
    grid.append(panel('Map', mapBody));

    // --- Victory panel ---
    const victoryBody = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
    grid.append(panel('Victory', victoryBody));

    // --- Opponents panel ---
    const oppBody = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
    grid.append(panel('Opponents', oppBody));

    // --- Difficulty panel ---
    const diffBody = el('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
    const diffSeg = segmented(DIFFICULTIES.map((d) => d.name), 1, (i) => {
      setup.difficulty = DIFFICULTIES[i];
      diffBlurb.textContent = DIFFICULTIES[i].blurb;
    });
    const diffBlurb = el('div', { fontSize: '11.5px', opacity: '0.65' });
    diffBlurb.textContent = setup.difficulty.blurb;
    diffBody.append(diffSeg, diffBlurb);
    grid.append(panel('Difficulty', diffBody));

    const startBtn = button('Start Empire  ▶', '#ffe28a', () => finish({ kind: 'new', setup }));
    startBtn.style.cssText += ';margin-top:12px;font-size:17px;padding:13px 30px';
    overlay.append(startBtn);

    // Dynamic sections that depend on current state.
    const refresh = (): void => {
      for (const { card, s } of scenarioCards) {
        const on = s === setup.scenario;
        card.style.borderColor = on ? 'rgba(143,255,168,0.7)' : 'rgba(255,255,255,0.16)';
        card.style.background = on ? 'rgba(143,255,168,0.1)' : 'rgba(255,255,255,0.05)';
      }
      playerSwatches.mark(setup.player.color);

      // Victory. The objective is set by the scenario; the player can swap it for a free
      // sandbox. (Difficulty, map and opponents are tuned separately.)
      victoryBody.innerHTML = '';
      const sandboxSeg = segmented(['Scenario goal', 'Sandbox'], sandbox ? 1 : 0, (i) => {
        sandbox = i === 1;
        if (sandbox) setup.goal = { kind: 'networth', byYear: SANDBOX_YEAR, bronze: 1e12, silver: 1e12, gold: 1e12 };
        else setup.goal = { ...setup.scenario.goal };
        refresh();
      });
      victoryBody.append(sandboxSeg);
      if (!sandbox) {
        victoryBody.append(hint(describeGoal(setup.scenario.goal)));
      } else {
        victoryBody.append(hint('Build freely — no deadline. (You can still go bankrupt.)'));
      }

      // Opponents.
      oppBody.innerHTML = '';
      const countSeg = segmented(['Solo', '2', '3', '4'], setup.ais.length, (i) => {
        while (setup.ais.length < i) {
          const k = setup.ais.length;
          setup.ais.push({ name: AI_NAMES[k % AI_NAMES.length], color: AI_COLORS[k % AI_COLORS.length] });
        }
        setup.ais.length = i;
        refresh();
      });
      oppBody.append(sub('Railroads (you + rivals)'), countSeg);
      setup.ais.forEach((ai, idx) => {
        const row = el('div', { display: 'flex', gap: '6px', alignItems: 'center' });
        const nm = textInput(ai.name, (v) => (ai.name = v || `Rival ${idx + 1}`));
        nm.style.flex = '1';
        const sw = swatchRow(LIVERIES, ai.color, (c) => {
          ai.color = c;
          refresh();
        }, true);
        row.append(nm, sw.row);
        oppBody.append(row);
      });
    };
    refresh();

    document.body.append(overlay);
  });
}

// ---- small DOM builders ----

function panel(titleText: string, body: HTMLElement): HTMLElement {
  const p = el('div', {
    padding: '12px 14px',
    background: 'rgba(18,22,28,0.6)',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.1)',
  });
  const t = el('div', { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.6px', opacity: '0.55', marginBottom: '8px' });
  t.textContent = titleText;
  p.append(t, body);
  return p;
}

function cardStyle(): Partial<CSSStyleDeclaration> {
  return {
    textAlign: 'left',
    padding: '9px 11px',
    cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.16)',
    borderRadius: '8px',
    background: 'rgba(255,255,255,0.05)',
    color: '#f4f0e6',
  };
}

function sub(text: string): HTMLElement {
  return Object.assign(el('div', { fontSize: '11px', opacity: '0.55', marginTop: '2px' }), { textContent: text });
}
function hint(text: string): HTMLElement {
  return Object.assign(el('div', { fontSize: '12px', opacity: '0.7' }), { textContent: text });
}

function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const i = document.createElement('input');
  i.value = value;
  Object.assign(i.style, {
    padding: '7px 9px',
    borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'rgba(12,16,20,0.9)',
    color: '#f4f0e6',
    fontSize: '13px',
  } as CSSStyleDeclaration);
  i.oninput = () => onChange(i.value);
  return i;
}

function swatchRow(
  colors: number[],
  initial: number,
  onPick: (c: number) => void,
  compact = false
): { row: HTMLElement; mark: (c: number) => void } {
  const row = el('div', { display: 'flex', gap: '4px', flexWrap: 'wrap' });
  const sz = compact ? '16px' : '22px';
  const cells: { el: HTMLElement; c: number }[] = [];
  const mark = (sel: number): void => {
    for (const cell of cells) cell.el.style.outline = cell.c === sel ? '2px solid #fff' : '2px solid transparent';
  };
  for (const c of colors) {
    const cell = el('div', {
      width: sz,
      height: sz,
      borderRadius: '5px',
      cursor: 'pointer',
      background: '#' + c.toString(16).padStart(6, '0'),
      outlineOffset: '1px',
    });
    cell.onclick = () => {
      onPick(c);
      mark(c);
    };
    cells.push({ el: cell, c });
    row.append(cell);
  }
  mark(initial);
  return { row, mark };
}

function segmented(labels: string[], initial: number, onPick: (i: number) => void): HTMLElement {
  const row = el('div', { display: 'flex', gap: '5px' });
  const btns: HTMLElement[] = [];
  const mark = (sel: number): void => {
    btns.forEach((b, i) => {
      const on = i === sel;
      b.style.background = on ? 'rgba(143,255,168,0.18)' : 'rgba(255,255,255,0.05)';
      b.style.borderColor = on ? 'rgba(143,255,168,0.6)' : 'rgba(255,255,255,0.18)';
      b.style.color = on ? '#8fffa8' : '#f4f0e6';
    });
  };
  labels.forEach((label, i) => {
    const b = el('button', {
      flex: '1',
      padding: '7px 4px',
      cursor: 'pointer',
      borderRadius: '6px',
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'rgba(255,255,255,0.05)',
      color: '#f4f0e6',
      fontSize: '12.5px',
      fontWeight: '600',
      whiteSpace: 'nowrap',
    });
    b.textContent = label;
    b.onclick = () => {
      mark(i);
      onPick(i);
    };
    btns.push(b);
    row.append(b);
  });
  mark(initial);
  return row;
}

function button(label: string, color: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', {
    padding: '11px 22px',
    cursor: 'pointer',
    border: `1px solid ${color}99`,
    borderRadius: '8px',
    background: `${color}22`,
    color,
    fontSize: '15px',
    fontWeight: '700',
  }) as HTMLButtonElement;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function el(tag: string, style: Partial<CSSStyleDeclaration>): HTMLElement {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  return e;
}
