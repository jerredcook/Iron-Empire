import { Network } from './Network';

/**
 * A starting situation: which world is generated and the terms of victory. The start
 * menu offers a handful; each varies the seed (so the terrain and city layout differ),
 * the era you begin in (which gates the locomotives available), your opening capital,
 * the number of cities, and the net-worth target and deadline.
 */
export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  seed: number;
  year: number;
  startMoney: number;
  cities: number;
  goal: { targetCash: number; byYear: number };
}

/** How hard the contest is: capital on both sides and how driven the rivals are. */
export interface Difficulty {
  id: string;
  name: string;
  blurb: string;
  /** Multiplier on the scenario's starting capital for the player / for each AI. */
  playerMult: number;
  aiMult: number;
  /** Seconds between an AI's expansion attempts, and the cash reserve it keeps. */
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
  /** Number of AI companies (0–3), so 1–4 railroads in total. */
  aiCount: number;
  difficulty: Difficulty;
}

export type StartChoice = { kind: 'new'; setup: GameSetup } | { kind: 'continue' };

export const SCENARIOS: Scenario[] = [
  {
    id: 'pioneer',
    name: 'Pioneer Valley',
    blurb: 'A temperate frontier of farms and forests. A gentle place to learn the trade.',
    seed: 20260611,
    year: 1862,
    startMoney: 850_000,
    cities: 9,
    goal: { targetCash: 2_500_000, byYear: 1890 },
  },
  {
    id: 'coal',
    name: 'Coal Country',
    blurb: 'A rugged mining belt. Feed the factories and beat the deadline on lean capital.',
    seed: 7771234,
    year: 1855,
    startMoney: 700_000,
    cities: 10,
    goal: { targetCash: 3_000_000, byYear: 1888 },
  },
  {
    id: 'golden',
    name: 'Golden State',
    blurb: 'A booming coast in the steam age. Big cities, bigger ambitions.',
    seed: 5550987,
    year: 1872,
    startMoney: 1_100_000,
    cities: 11,
    goal: { targetCash: 4_000_000, byYear: 1898 },
  },
  {
    id: 'gambit',
    name: "Tycoon's Gambit",
    blurb: 'Thin capital and hungry rivals. Outbuild them — or buy them out.',
    seed: 9123456,
    year: 1860,
    startMoney: 500_000,
    cities: 8,
    goal: { targetCash: 3_500_000, byYear: 1885 },
  },
];

/** Show the start menu (scenario + opponents + difficulty) and resolve with the chosen
 *  setup, or 'continue' to resume the saved game. */
export function chooseScenario(): Promise<StartChoice> {
  return new Promise((resolve) => {
    let scenario: Scenario = SCENARIOS[0];
    let aiCount = 1;
    let difficulty: Difficulty = DIFFICULTIES[1];

    const overlay = el('div', {
      position: 'fixed',
      inset: '0',
      zIndex: '50',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      background: 'radial-gradient(circle at 50% 25%, #1b2733, #0a0e13)',
      color: '#f4f0e6',
      font: '15px/1.5 -apple-system, Segoe UI, Roboto, sans-serif',
      overflow: 'auto',
    });

    const title = el('div', { fontSize: '48px', fontWeight: '800', letterSpacing: '3px' });
    title.textContent = 'IRON EMPIRE';
    const sub = el('div', { opacity: '0.7', marginBottom: '14px' });
    sub.textContent = 'Set up your venture';
    overlay.append(title, sub);

    const finish = (choice: StartChoice): void => {
      overlay.remove();
      resolve(choice);
    };

    if (Network.hasSave()) {
      const cont = button('▶  Continue saved game', '#8fffa8', () => finish({ kind: 'continue' }));
      cont.style.marginBottom = '14px';
      overlay.append(cont);
    }

    const cols = el('div', { display: 'flex', gap: '18px', alignItems: 'flex-start' });

    // Left: scenario cards.
    const left = el('div', { display: 'flex', flexDirection: 'column', gap: '10px', width: '300px' });
    const cards: { card: HTMLElement; s: Scenario }[] = [];
    const markCards = (): void => {
      for (const { card, s } of cards) {
        const on = s === scenario;
        card.style.borderColor = on ? 'rgba(143,255,168,0.7)' : 'rgba(255,255,255,0.16)';
        card.style.background = on ? 'rgba(143,255,168,0.1)' : 'rgba(255,255,255,0.05)';
      }
    };
    for (const s of SCENARIOS) {
      const card = el('button', {
        textAlign: 'left',
        padding: '12px 14px',
        cursor: 'pointer',
        border: '1px solid rgba(255,255,255,0.16)',
        borderRadius: '10px',
        background: 'rgba(255,255,255,0.05)',
        color: '#f4f0e6',
      });
      card.innerHTML =
        `<div style="font-size:17px;font-weight:700;margin-bottom:2px">${s.name}</div>` +
        `<div style="font-size:12px;opacity:0.7;margin-bottom:6px">${s.blurb}</div>` +
        `<div style="font-size:11px;opacity:0.85">Start ${s.year} · $${(s.startMoney / 1000).toFixed(0)}k · ` +
        `Goal $${(s.goal.targetCash / 1e6).toFixed(1)}M by ${s.goal.byYear}</div>`;
      card.onclick = () => {
        scenario = s;
        markCards();
      };
      cards.push({ card, s });
      left.append(card);
    }
    markCards();

    // Right: opponents + difficulty + start.
    const right = el('div', { display: 'flex', flexDirection: 'column', gap: '14px', width: '300px' });

    right.append(
      groupLabel('Railroads'),
      segmented(
        ['Solo', '2', '3', '4'],
        1,
        (i) => {
          aiCount = i; // index 0→solo(0 AI), 1→1 AI … matches "total railroads = aiCount+1"
        },
        ['1 railroad — you alone', '2 railroads — 1 rival', '3 railroads — 2 rivals', '4 railroads — 3 rivals']
      )
    );

    right.append(
      groupLabel('Difficulty'),
      segmented(
        DIFFICULTIES.map((d) => d.name),
        1,
        (i) => {
          difficulty = DIFFICULTIES[i];
          diffBlurb.textContent = difficulty.blurb;
        },
        DIFFICULTIES.map((d) => d.blurb)
      )
    );
    const diffBlurb = el('div', { fontSize: '12px', opacity: '0.65', marginTop: '-6px' });
    diffBlurb.textContent = difficulty.blurb;
    right.append(diffBlurb);

    const startBtn = button('Start Empire  ▶', '#ffe28a', () =>
      finish({ kind: 'new', setup: { scenario, aiCount, difficulty } })
    );
    startBtn.style.marginTop = '8px';
    startBtn.style.fontSize = '16px';
    right.append(startBtn);

    cols.append(left, right);
    overlay.append(cols);
    document.body.append(overlay);
  });
}

/** A row of mutually-exclusive buttons; calls onPick with the selected index. */
function segmented(labels: string[], initial: number, onPick: (i: number) => void, titles?: string[]): HTMLElement {
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
      padding: '8px 4px',
      cursor: 'pointer',
      borderRadius: '7px',
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'rgba(255,255,255,0.05)',
      color: '#f4f0e6',
      fontSize: '13px',
      fontWeight: '600',
    });
    b.textContent = label;
    if (titles) b.title = titles[i];
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

function groupLabel(text: string): HTMLElement {
  const d = el('div', { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.6px', opacity: '0.55' });
  d.textContent = text;
  return d;
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
