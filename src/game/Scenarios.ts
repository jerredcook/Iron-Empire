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

export const SCENARIOS: Scenario[] = [
  {
    id: 'pioneer',
    name: 'Pioneer Valley',
    blurb: 'A temperate frontier of farms and forests. A gentle start to learn the trade.',
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
    blurb: 'Thin capital and a hungry rival. Outbuild them — or buy them out.',
    seed: 9123456,
    year: 1860,
    startMoney: 500_000,
    cities: 8,
    goal: { targetCash: 3_500_000, byYear: 1885 },
  },
];

/** Show the start menu and resolve with the chosen scenario, or 'continue' to resume
 *  the saved game. */
export function chooseScenario(): Promise<Scenario | 'continue'> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '50',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      background: 'radial-gradient(circle at 50% 30%, #1b2733, #0a0e13)',
      color: '#f4f0e6',
      font: '15px/1.5 -apple-system, Segoe UI, Roboto, sans-serif',
    } as CSSStyleDeclaration);

    const title = document.createElement('div');
    title.textContent = 'IRON EMPIRE';
    Object.assign(title.style, { fontSize: '52px', fontWeight: '800', letterSpacing: '3px' });
    const sub = document.createElement('div');
    sub.textContent = 'Choose your venture';
    Object.assign(sub.style, { opacity: '0.7', marginBottom: '18px' });
    overlay.append(title, sub);

    const finish = (choice: Scenario | 'continue'): void => {
      overlay.remove();
      resolve(choice);
    };

    if (Network.hasSave()) {
      const cont = document.createElement('button');
      cont.textContent = '▶  Continue saved game';
      Object.assign(cont.style, {
        marginBottom: '16px',
        padding: '10px 22px',
        cursor: 'pointer',
        border: '1px solid rgba(143,255,168,0.6)',
        borderRadius: '8px',
        background: 'rgba(143,255,168,0.14)',
        color: '#8fffa8',
        fontSize: '15px',
        fontWeight: '700',
      } as CSSStyleDeclaration);
      cont.onclick = () => finish('continue');
      overlay.append(cont);
    }

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(2, 280px)',
      gap: '12px',
    } as CSSStyleDeclaration);
    for (const s of SCENARIOS) {
      const card = document.createElement('button');
      Object.assign(card.style, {
        textAlign: 'left',
        padding: '14px 16px',
        cursor: 'pointer',
        border: '1px solid rgba(255,255,255,0.16)',
        borderRadius: '10px',
        background: 'rgba(255,255,255,0.05)',
        color: '#f4f0e6',
        transition: 'background 0.15s',
      } as CSSStyleDeclaration);
      card.onmouseenter = () => (card.style.background = 'rgba(255,226,138,0.12)');
      card.onmouseleave = () => (card.style.background = 'rgba(255,255,255,0.05)');
      card.innerHTML =
        `<div style="font-size:18px;font-weight:700;margin-bottom:3px">${s.name}</div>` +
        `<div style="font-size:12.5px;opacity:0.7;margin-bottom:8px">${s.blurb}</div>` +
        `<div style="font-size:11.5px;opacity:0.85">Start ${s.year} · $${(s.startMoney / 1000).toFixed(0)}k · ` +
        `Goal $${(s.goal.targetCash / 1e6).toFixed(1)}M by ${s.goal.byYear}</div>`;
      card.onclick = () => finish(s);
      grid.append(card);
    }
    overlay.append(grid);
    document.body.append(overlay);
  });
}
