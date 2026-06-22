import * as THREE from 'three';
import { Network, Company, GLine, Contract } from './Network';
import { Train } from './Train';
import { BuildStatus } from './TrackBuilder';
import { CARGO, CargoKind } from './Cargo';
import { QUALITY, QualityLevel } from '../engine/Renderer';
import { LocoClass, availableLocos, defaultLoco } from './Locomotives';

/**
 * The 2D overlay: treasury and calendar, the build-mode banner, a scrolling ledger of
 * recent deliveries, and floating name plates pinned over each city that track with
 * the camera. Pure DOM laid over the canvas — it reads the Network, it never mutates
 * the simulation.
 */
export class HUD {
  private root: HTMLDivElement;
  private money: HTMLDivElement;
  private year: HTMLDivElement;
  private buildBtn: HTMLButtonElement;
  private banner: HTMLDivElement;
  private bannerText!: HTMLDivElement;
  private finishBtn!: HTMLButtonElement;
  private ledger: HTMLDivElement;
  private roster!: HTMLDivElement;
  private rosterKey = '';
  private rosterTrains: { line: GLine; train: Train }[] = [];
  private contractsBtn!: HTMLButtonElement;
  private contractsPanel!: HTMLDivElement;
  private contractsOpen = false;
  private contractsKey = '';
  private helpOverlay!: HTMLDivElement;
  private labelLayer: HTMLDivElement;
  private labels = new Map<number, HTMLDivElement>();
  private popBars = new Map<number, HTMLDivElement>();
  private stageLabels = new Map<number, HTMLElement>();
  private v = new THREE.Vector3();
  private lastMoney = NaN;
  private lastYear = NaN;
  private ledgerKey = '';

  private qualityBtns = new Map<QualityLevel, HTMLButtonElement>();
  private speedBtns: { v: number; btn: HTMLButtonElement }[] = [];
  private newsEl!: HTMLDivElement;
  private newsToken = 0;
  private upkeep!: HTMLDivElement;
  private goalLine!: HTMLDivElement;
  private standings!: HTMLDivElement;
  private debtLine!: HTMLDivElement;
  private marketLine!: HTMLDivElement;
  private marketSel!: HTMLSelectElement;
  private marketWrap!: HTMLDivElement;
  private lastRivalCount = -1;
  private engineSel!: HTMLSelectElement;
  private overlay!: HTMLDivElement;
  private selectedLoco: LocoClass;
  private lastEngineYear = 0;

  constructor(
    private network: Network,
    onBuildToggle: () => void,
    onFinishRoute: () => void,
    quality: QualityLevel,
    onQuality: (q: QualityLevel) => void,
    private onLoco: (l: LocoClass) => void,
    onToggleSound: () => boolean,
    onSpeed: (scale: number) => void,
    private onSelectTrain: (line: GLine, train: Train) => void,
    private onAcceptContract: (c: Contract) => void
  ) {
    this.selectedLoco = defaultLoco(network.year);
    this.root = el('div', {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      font: '14px/1.4 -apple-system, Segoe UI, Roboto, sans-serif',
      color: '#f4f0e6',
      userSelect: 'none',
    });

    // Top-left treasury panel.
    const top = el('div', {
      position: 'absolute',
      top: '14px',
      left: '14px',
      padding: '12px 16px',
      background: 'rgba(18,22,28,0.72)',
      borderRadius: '10px',
      backdropFilter: 'blur(6px)',
      boxShadow: '0 2px 18px rgba(0,0,0,0.35)',
      minWidth: '190px',
    });
    this.money = el('div', { fontSize: '22px', fontWeight: '700', letterSpacing: '0.3px' });
    this.year = el('div', { fontSize: '13px', opacity: '0.75', marginTop: '2px' });
    this.upkeep = el('div', { fontSize: '12px', opacity: '0.65', marginTop: '1px' });
    this.goalLine = el('div', {
      fontSize: '12px',
      marginTop: '7px',
      padding: '5px 8px',
      background: 'rgba(143,255,168,0.08)',
      border: '1px solid rgba(143,255,168,0.25)',
      borderRadius: '6px',
    });
    // Standings: every railroad ranked by net worth.
    this.standings = el('div', { fontSize: '12px', marginTop: '8px', lineHeight: '1.5' });
    top.append(this.money, this.year, this.upkeep, this.goalLine, this.standings);

    // Finance: outstanding debt + bond/repay controls.
    this.debtLine = el('div', { fontSize: '12px', opacity: '0.7', marginTop: '8px' });
    const finRow = el('div', { display: 'flex', gap: '4px', marginTop: '4px' });
    const bond = financeBtn('Bond +$200k', () => this.network.issueBond(200_000));
    const repay = financeBtn('Repay $100k', () => this.network.repayDebt(100_000));
    finRow.append(bond, repay);
    top.append(this.debtLine, finRow);

    // Stock market: pick a rival, build a stake, cross 50% to absorb them.
    const mLabel = groupLabelEl('Market');
    this.marketSel = document.createElement('select');
    Object.assign(this.marketSel.style, {
      marginTop: '4px',
      width: '100%',
      padding: '5px',
      pointerEvents: 'auto',
      cursor: 'pointer',
      borderRadius: '6px',
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'rgba(12,16,20,0.9)',
      color: '#f4f0e6',
      fontSize: '12px',
    } as CSSStyleDeclaration);
    this.marketLine = el('div', { fontSize: '12px', opacity: '0.8', marginTop: '4px' });
    const mRow = el('div', { display: 'flex', gap: '4px', marginTop: '4px' });
    const target = (): Company | undefined => this.network.companies.find((c) => c.name === this.marketSel.value);
    const buy = financeBtn('Buy 5k shares', () => {
      const t = target();
      if (t) this.network.buyShares(t, 5000);
    });
    const sell = financeBtn('Sell 5k', () => {
      const t = target();
      if (t) this.network.sellShares(t, 5000);
    });
    mRow.append(buy, sell);
    // Solo games have no market.
    this.marketWrap = el('div', {});
    if (this.network.rivals.length > 0) this.marketWrap.append(mLabel, this.marketSel, this.marketLine, mRow);
    top.append(this.marketWrap);

    // System: persist / restore the game.
    const sysRow = el('div', { display: 'flex', gap: '4px', marginTop: '10px' });
    const saveBtn = financeBtn('Save', () => {
      this.network.save();
      saveBtn.textContent = 'Saved ✓';
      setTimeout(() => (saveBtn.textContent = 'Save'), 1200);
    });
    const loadBtn = financeBtn('Menu', () => location.reload());
    const soundBtn = financeBtn('🔊', () => {
      soundBtn.textContent = onToggleSound() ? '🔊' : '🔇';
    });
    soundBtn.style.flex = '0 0 36px';
    sysRow.append(saveBtn, loadBtn, soundBtn);
    top.append(sysRow);

    this.buildBtn = document.createElement('button');
    Object.assign(this.buildBtn.style, {
      marginTop: '10px',
      width: '100%',
      padding: '8px 10px',
      pointerEvents: 'auto',
      cursor: 'pointer',
      border: '1px solid rgba(255,226,138,0.5)',
      borderRadius: '7px',
      background: 'rgba(255,226,138,0.12)',
      color: '#ffe28a',
      fontWeight: '600',
      fontSize: '13px',
    } as CSSStyleDeclaration);
    this.buildBtn.textContent = '🛤  Build Track  (B)';
    this.buildBtn.onclick = onBuildToggle;
    top.append(this.buildBtn);

    // Contracts board: a toggle button (badged with how many jobs are on offer) and the
    // centred panel it opens.
    this.contractsBtn = document.createElement('button');
    Object.assign(this.contractsBtn.style, {
      marginTop: '6px',
      width: '100%',
      padding: '7px 10px',
      pointerEvents: 'auto',
      cursor: 'pointer',
      border: '1px solid rgba(143,200,255,0.45)',
      borderRadius: '7px',
      background: 'rgba(143,200,255,0.1)',
      color: '#bfe0ff',
      fontWeight: '600',
      fontSize: '12.5px',
    } as CSSStyleDeclaration);
    this.contractsBtn.textContent = '📋  Contracts';
    this.contractsBtn.onclick = () => this.toggleContracts();
    top.append(this.contractsBtn);

    this.contractsPanel = el('div', {
      position: 'absolute',
      top: '60px',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '380px',
      maxHeight: '64vh',
      overflowY: 'auto',
      padding: '12px 14px',
      background: 'rgba(16,20,26,0.92)',
      borderRadius: '12px',
      backdropFilter: 'blur(8px)',
      boxShadow: '0 6px 28px rgba(0,0,0,0.5)',
      pointerEvents: 'auto',
      display: 'none',
    });
    this.root.append(this.contractsPanel);

    // Engine picker — the class a finished line will be staffed with.
    const eLabel = el('div', {
      marginTop: '10px',
      fontSize: '10.5px',
      textTransform: 'uppercase',
      letterSpacing: '0.6px',
      opacity: '0.55',
    });
    eLabel.textContent = 'Locomotive';
    this.engineSel = document.createElement('select');
    Object.assign(this.engineSel.style, {
      marginTop: '4px',
      width: '100%',
      padding: '6px',
      pointerEvents: 'auto',
      cursor: 'pointer',
      borderRadius: '6px',
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'rgba(12,16,20,0.9)',
      color: '#f4f0e6',
      fontSize: '12px',
    } as CSSStyleDeclaration);
    this.engineSel.onchange = () => {
      const loco = availableLocos(this.network.year).find((l) => l.id === this.engineSel.value);
      if (loco) {
        this.selectedLoco = loco;
        this.onLoco(loco);
      }
    };
    this.populateEngines();
    top.append(eLabel, this.engineSel);

    // Quality tier selector — a segmented row of three.
    const qLabel = el('div', {
      marginTop: '10px',
      fontSize: '10.5px',
      textTransform: 'uppercase',
      letterSpacing: '0.6px',
      opacity: '0.55',
    });
    qLabel.textContent = 'Graphics';
    top.append(qLabel);
    const qRow = el('div', { display: 'flex', gap: '4px', marginTop: '4px' });
    for (const key of Object.keys(QUALITY) as QualityLevel[]) {
      const btn = document.createElement('button');
      Object.assign(btn.style, {
        flex: '1',
        padding: '5px 4px',
        pointerEvents: 'auto',
        cursor: 'pointer',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: '6px',
        background: 'transparent',
        color: '#f4f0e6',
        fontSize: '11px',
        fontWeight: '600',
      } as CSSStyleDeclaration);
      btn.textContent = QUALITY[key].label;
      btn.onclick = () => {
        onQuality(key);
        this.markQuality(key);
      };
      this.qualityBtns.set(key, btn);
      qRow.append(btn);
    }
    top.append(qRow);
    this.markQuality(quality);
    this.root.append(top);

    // Build-mode banner, centred at top: an instruction line plus explicit Finish/Cancel
    // controls so finishing a route never depends on knowing the Enter shortcut.
    this.banner = el('div', {
      position: 'absolute',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '9px 16px',
      background: 'rgba(20,28,22,0.86)',
      border: '1px solid rgba(143,255,168,0.4)',
      borderRadius: '8px',
      fontSize: '13px',
      display: 'none',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '7px',
      maxWidth: '560px',
      textAlign: 'center',
    });
    this.bannerText = el('div', { lineHeight: '1.45' }) as HTMLDivElement;
    const bannerBtns = el('div', { display: 'flex', gap: '8px', pointerEvents: 'auto' });
    this.finishBtn = bannerButton('✓ Finish line', '#8fffa8', onFinishRoute);
    this.finishBtn.setAttribute('data-finishroute', '');
    const cancelRouteBtn = bannerButton('✕ Cancel', '#ff9a86', onBuildToggle);
    bannerBtns.append(this.finishBtn, cancelRouteBtn);
    this.banner.append(this.bannerText, bannerBtns);
    this.root.append(this.banner);

    // News toast — economic events scroll across just under the build banner.
    this.newsEl = el('div', {
      position: 'absolute',
      top: '54px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 16px',
      background: 'rgba(20,24,30,0.86)',
      border: '1px solid rgba(255,226,138,0.45)',
      borderRadius: '8px',
      fontSize: '13px',
      fontWeight: '600',
      display: 'none',
      whiteSpace: 'nowrap',
      boxShadow: '0 2px 18px rgba(0,0,0,0.4)',
    });
    this.newsEl.setAttribute('data-news', '');
    this.root.append(this.newsEl);

    // Time controls, bottom-centre: pause / 1× / 2× / 3× (also Space and keys 1–3).
    const speedBar = el('div', {
      position: 'absolute',
      bottom: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '4px',
      padding: '5px',
      background: 'rgba(18,22,28,0.72)',
      borderRadius: '10px',
      backdropFilter: 'blur(6px)',
      boxShadow: '0 2px 18px rgba(0,0,0,0.35)',
      pointerEvents: 'auto',
    });
    const speeds = [
      { label: '❚❚', v: 0, title: 'Pause (Space)' },
      { label: '▶', v: 1, title: '1× (1)' },
      { label: '▶▶', v: 2, title: '2× (2)' },
      { label: '▶▶▶', v: 3, title: '3× (3)' },
    ];
    for (const s of speeds) {
      const btn = document.createElement('button');
      Object.assign(btn.style, {
        minWidth: '40px',
        padding: '5px 8px',
        pointerEvents: 'auto',
        cursor: 'pointer',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: '6px',
        background: 'transparent',
        color: '#f4f0e6',
        fontSize: '12px',
        fontWeight: '600',
      } as CSSStyleDeclaration);
      btn.textContent = s.label;
      btn.title = s.title;
      btn.onclick = () => onSpeed(s.v);
      this.speedBtns.push({ v: s.v, btn });
      speedBar.append(btn);
    }
    this.root.append(speedBar);
    this.setSpeed(1);

    // Delivery ledger, bottom-left.
    this.ledger = el('div', {
      position: 'absolute',
      bottom: '14px',
      left: '14px',
      padding: '10px 14px',
      background: 'rgba(18,22,28,0.6)',
      borderRadius: '9px',
      fontSize: '12.5px',
      minWidth: '210px',
      lineHeight: '1.6',
    });
    this.root.append(this.ledger);

    // Fleet roster, bottom-right: every train at a glance, click to jump to it.
    this.roster = el('div', {
      position: 'absolute',
      bottom: '14px',
      right: '14px',
      width: '244px',
      maxHeight: '40vh',
      overflowY: 'auto',
      padding: '8px 10px',
      background: 'rgba(18,22,28,0.72)',
      borderRadius: '10px',
      backdropFilter: 'blur(6px)',
      boxShadow: '0 2px 18px rgba(0,0,0,0.35)',
      pointerEvents: 'auto',
      display: 'none',
      fontSize: '12px',
    });
    this.root.append(this.roster);

    // Bottom-centre controls hint — click it (or the ❓) to open the full how-to-play card.
    const help = el('div', {
      position: 'absolute',
      bottom: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 12px',
      background: 'rgba(18,22,28,0.5)',
      borderRadius: '8px',
      fontSize: '11.5px',
      opacity: '0.8',
      textAlign: 'center',
      pointerEvents: 'auto',
      cursor: 'pointer',
    });
    help.innerHTML =
      'Drag pan · Right-drag orbit · Wheel zoom · WASD · Space pause<br>B build track · Esc cancel · <b style="color:#bfe0ff">❓ How to play</b>';
    help.onclick = () => this.showHelp();
    this.root.append(help);

    // How-to-play overlay (shown once for a new player; reopenable from the hint).
    this.helpOverlay = el('div', {
      position: 'absolute',
      inset: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(8,10,14,0.55)',
      pointerEvents: 'auto',
      zIndex: '50',
    });
    const card = el('div', {
      width: '460px',
      maxWidth: '88vw',
      maxHeight: '82vh',
      overflowY: 'auto',
      padding: '22px 26px',
      background: 'rgba(18,22,28,0.97)',
      borderRadius: '14px',
      boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
      lineHeight: '1.5',
    });
    card.innerHTML =
      `<div style="font-size:22px;font-weight:800;margin-bottom:2px">Iron Empire</div>` +
      `<div style="opacity:0.7;font-size:13px;margin-bottom:12px">Build a railroad empire — connect the country, carry what it needs, grow rich.</div>` +
      [
        ['🎯', '<b>The goal</b> — reach the medal target by the deadline (top-left). The objective varies by scenario: net worth, cargo hauled, cities linked, or contracts filled. 🥉 → 🥈 → 🥇.'],
        ['🚉', '<b>Step 1 — Stations.</b> Click a city, then <b>Build Station — $70k</b> in its panel. Trains only stop where you’ve built a station, so do this at each city you want to serve.'],
        ['🛤', '<b>Step 2 — Track.</b> Click <b>Build Track</b> (or <b>B</b>), click your stationed cities in order, then press <b>✓ Finish line</b>. You’ll pick a train to run the route.'],
        ['🚂', '<b>Step 3 — Run goods.</b> Each city <b>wants</b> certain cargo (the ringed dots over it). Carry what it wants from where it’s produced; long hauls of fresh freight pay most. (Add more trains from a line’s panel: <b>+ Add train</b>.)'],
        ['📋', '<b>Contracts</b> — accept time-limited haul jobs for a premium reward (the Contracts button, top-left).'],
        ['🔍', '<b>Inspect</b> — click a train, a length of track, or a city for details. The fleet list (bottom-right) jumps the camera to any train.'],
        ['⏱', '<b>Pace it</b> — Space pauses; 1 / 2 / 3 set speed. Watch out for storms that wash out a line — repair it or wait it out.'],
      ]
        .map(
          ([icon, text]) =>
            `<div style="display:flex;gap:10px;margin:8px 0"><span style="font-size:16px">${icon}</span><span style="font-size:13px;opacity:0.92">${text}</span></div>`
        )
        .join('') +
      `<div data-closehelp style="margin-top:16px;text-align:center;cursor:pointer;pointer-events:auto;padding:9px;border-radius:8px;border:1px solid rgba(143,255,168,0.5);color:#8fffa8;font-weight:700">Got it — let’s build</div>`;
    this.helpOverlay.append(card);
    this.helpOverlay.onclick = (e) => {
      if (e.target === this.helpOverlay || (e.target as HTMLElement).dataset.closehelp !== undefined) this.hideHelp();
    };
    this.helpOverlay.setAttribute('data-helpoverlay', '');
    this.root.append(this.helpOverlay);

    this.labelLayer = el('div', { position: 'absolute', inset: '0' });
    this.root.append(this.labelLayer);

    // Win/lose overlay — hidden until the objective resolves.
    this.overlay = el('div', {
      position: 'absolute',
      inset: '0',
      display: 'none',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '16px',
      background: 'rgba(8,10,14,0.72)',
      backdropFilter: 'blur(3px)',
      pointerEvents: 'auto',
      textAlign: 'center',
    });
    this.root.append(this.overlay);

    document.body.append(this.root);
    this.onLoco(this.selectedLoco); // sync the initial engine to the builder
  }

  /** Fill the engine dropdown with the classes available this year. */
  private populateEngines(): void {
    const avail = availableLocos(this.network.year);
    if (!avail.some((l) => l.id === this.selectedLoco.id)) {
      this.selectedLoco = avail[avail.length - 1];
      this.onLoco(this.selectedLoco);
    }
    this.engineSel.innerHTML = '';
    for (const l of avail) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = `${l.name} ${l.wheel} · cap ${l.capacity} · $${Math.round(l.cost / 1000)}k`;
      if (l.id === this.selectedLoco.id) o.selected = true;
      this.engineSel.append(o);
    }
    this.lastEngineYear = this.network.year;
  }

  /** Render the end-of-game overlay for the resolved objective. */
  private showEnd(): void {
    const won = this.network.status === 'won';
    const medal = this.network.earnedMedal;
    const medalLine: Record<string, string> = {
      gold: '🥇 Gold — a transcontinental triumph',
      silver: '🥈 Silver — a railroad to be proud of',
      bronze: '🥉 Bronze — the target met',
      none: '',
    };
    const title = won ? 'Empire Secured' : 'Railroad Bankrupt';
    const reached = this.network.formatObjective(this.network.objectiveProgress());
    const target = this.network.formatObjective(this.network.goal.bronze);
    const sub = won
      ? `${reached} by ${this.network.year} — objective complete.`
      : this.network.money < 0
        ? `The treasury collapsed in ${this.network.year}.`
        : `By ${this.network.goal.byYear} you reached only ${reached}, short of the ${target} target.`;
    this.overlay.innerHTML =
      (won && medal !== 'none' ? `<div style="font-size:30px;font-weight:700">${medalLine[medal]}</div>` : '') +
      `<div style="font-size:40px;font-weight:800;color:${won ? '#8fffa8' : '#ff7766'}">${title}</div>` +
      `<div style="font-size:15px;opacity:0.85;max-width:420px">${sub}</div>`;
    const again = document.createElement('button');
    Object.assign(again.style, {
      marginTop: '6px',
      padding: '10px 22px',
      cursor: 'pointer',
      border: '1px solid rgba(255,255,255,0.3)',
      borderRadius: '8px',
      background: 'rgba(255,255,255,0.1)',
      color: '#f4f0e6',
      fontSize: '15px',
      fontWeight: '700',
    } as CSSStyleDeclaration);
    again.textContent = 'New Empire';
    again.onclick = () => location.reload();
    this.overlay.append(again);
    this.overlay.style.display = 'flex';
  }

  /** Highlight the active graphics tier. */
  private markQuality(active: QualityLevel): void {
    for (const [key, btn] of this.qualityBtns) {
      const on = key === active;
      btn.style.background = on ? 'rgba(143,255,168,0.18)' : 'transparent';
      btn.style.borderColor = on ? 'rgba(143,255,168,0.6)' : 'rgba(255,255,255,0.18)';
      btn.style.color = on ? '#8fffa8' : '#f4f0e6';
    }
  }

  /** Render the fleet roster from the current train list, wiring each row to select it. */
  private rebuildRoster(fleet: { line: GLine; train: Train }[]): void {
    if (!fleet.length) {
      this.roster.style.display = 'none';
      this.roster.innerHTML = '';
      return;
    }
    this.roster.style.display = 'block';
    const rows = fleet
      .map(({ line, train }, i) => {
        const lc = train.locoClass;
        const route = line.stops.length ? `${line.stops[0].name} → ${line.stops[line.stops.length - 1].name}` : 'unrouted';
        const load = train.capacity > 0 ? Math.round((train.cargoTotal() / train.capacity) * 100) : 0;
        const profit = Math.round(this.network.lineStats(line).profitPerYear);
        const pc = profit >= 0 ? '#8fffa8' : '#ff7766';
        const money = `${profit >= 0 ? '+' : '−'}$${Math.abs(Math.round(profit / 1000))}k/yr`;
        const badge = train.broken ? ` <span style="color:#ff7766">⚠</span>` : '';
        return (
          `<div data-rosterrow="${i}" style="cursor:pointer;pointer-events:auto;padding:5px 6px;border-radius:6px;margin:2px 0;border:1px solid rgba(255,255,255,0.08)">` +
          `<div style="display:flex;justify-content:space-between;align-items:baseline">` +
          `<span><b>${lc.name}</b> <span style="opacity:0.55">${lc.wheel}</span>${badge}</span>` +
          `<span style="color:${pc};font-size:11px">${money}</span></div>` +
          `<div style="opacity:0.65;font-size:11px;margin-top:1px">${route} · ${load}% load</div></div>`
        );
      })
      .join('');
    this.roster.innerHTML =
      `<div style="opacity:0.6;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px">Fleet (${fleet.length})</div>` +
      rows;
    this.roster.querySelectorAll('[data-rosterrow]').forEach((node) => {
      const i = Number((node as HTMLElement).dataset.rosterrow);
      // Read the current entry at click time — the array is refreshed every frame, so a
      // row never points at a stale/disposed train even if the DOM wasn't rebuilt.
      (node as HTMLElement).onclick = () => {
        const entry = this.rosterTrains[i];
        if (entry) this.onSelectTrain(entry.line, entry.train);
      };
    });
  }

  /** Open the how-to-play card. */
  showHelp(): void {
    this.helpOverlay.style.display = 'flex';
  }

  private hideHelp(): void {
    this.helpOverlay.style.display = 'none';
  }

  /** Flash an economic-event headline for a few seconds (green = good for the player). */
  news(text: string, good: boolean): void {
    this.newsEl.textContent = (good ? '📈 ' : '📉 ') + text;
    this.newsEl.style.borderColor = good ? 'rgba(143,255,168,0.5)' : 'rgba(255,150,120,0.5)';
    this.newsEl.style.color = good ? '#bff6c9' : '#ffc6b6';
    this.newsEl.style.display = 'block';
    const tok = ++this.newsToken;
    setTimeout(() => {
      if (tok === this.newsToken) this.newsEl.style.display = 'none';
    }, 6500);
  }

  private toggleContracts(): void {
    this.contractsOpen = !this.contractsOpen;
    this.contractsPanel.style.display = this.contractsOpen ? 'block' : 'none';
    if (this.contractsOpen) {
      this.contractsKey = '';
      this.refreshContracts();
    }
  }

  /** Render the contracts board: jobs under way (with progress) and jobs on offer. */
  private refreshContracts(): void {
    const cs = this.network.contracts;
    const active = cs.filter((c) => c.status === 'active');
    const offered = cs.filter((c) => c.status === 'offered');
    const atCap = this.network.activeContracts() >= 3;
    const money = (n: number): string => `$${Math.round(n).toLocaleString()}`;
    const label = (t: string): string =>
      `<div style="opacity:0.55;font-size:10.5px;text-transform:uppercase;letter-spacing:0.6px;margin:10px 0 4px">${t}</div>`;
    const card = (inner: string): string =>
      `<div style="padding:8px 10px;border-radius:8px;margin:4px 0;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)">${inner}</div>`;

    let html =
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">` +
      `<b style="font-size:14px">📋 Contracts</b>` +
      `<span data-closecontracts style="cursor:pointer;pointer-events:auto;opacity:0.6;font-size:16px">✕</span></div>`;

    html += label(`Under way (${active.length})`);
    html += active.length
      ? active
          .map((c) => {
            const pct = Math.min(100, (c.delivered / c.quantity) * 100);
            return card(
              `<div>${c.quantity} ${c.cargo} → <b>${c.station.name}</b> <span style="opacity:0.55;font-size:11px">by ${c.deadlineYear}</span></div>` +
                `<div style="display:flex;justify-content:space-between;font-size:11px;opacity:0.7;margin-top:2px"><span>${Math.floor(c.delivered)}/${c.quantity} delivered</span><span style="color:#8fffa8">${money(c.reward)}</span></div>` +
                `<div style="height:5px;margin-top:3px;background:rgba(255,255,255,0.12);border-radius:3px"><div style="height:100%;width:${pct}%;background:#8fffa8;border-radius:3px"></div></div>`
            );
          })
          .join('')
      : `<div style="opacity:0.5;font-size:12px">None yet — accept a job below.</div>`;

    html += label('On offer');
    html += offered.length
      ? offered
          .map((c) =>
            card(
              `<div>Haul <b>${c.quantity} ${c.cargo}</b> → <b>${c.station.name}</b></div>` +
                `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px">` +
                `<span style="font-size:11px;opacity:0.7">Reward <span style="color:#8fffa8">${money(c.reward)}</span> · by ${c.deadlineYear}</span>` +
                (atCap
                  ? `<span style="font-size:11px;opacity:0.5">Slots full</span>`
                  : `<span data-accept="${c.id}" style="cursor:pointer;pointer-events:auto;padding:3px 12px;border-radius:6px;border:1px solid rgba(143,255,168,0.5);color:#8fffa8;font-size:11.5px">Accept</span>`) +
                `</div>`
            )
          )
          .join('')
      : `<div style="opacity:0.5;font-size:12px">The board is empty — check back soon.</div>`;

    this.contractsPanel.innerHTML = html;
    const close = this.contractsPanel.querySelector('[data-closecontracts]') as HTMLElement | null;
    if (close) close.onclick = () => this.toggleContracts();
    this.contractsPanel.querySelectorAll('[data-accept]').forEach((node) => {
      const id = Number((node as HTMLElement).dataset.accept);
      const c = this.network.contracts.find((x) => x.id === id);
      if (c)
        (node as HTMLElement).onclick = () => {
          this.onAcceptContract(c);
          this.contractsKey = '';
          this.refreshContracts();
        };
    });
  }

  /** Highlight the active time-control button (driven by main's speed state). */
  setSpeed(scale: number): void {
    for (const { v, btn } of this.speedBtns) {
      const on = v === scale;
      btn.style.background = on ? 'rgba(143,255,168,0.18)' : 'transparent';
      btn.style.borderColor = on ? 'rgba(143,255,168,0.6)' : 'rgba(255,255,255,0.18)';
      btn.style.color = on ? '#8fffa8' : '#f4f0e6';
    }
  }

  setBuildStatus(s: BuildStatus): void {
    this.buildBtn.style.background = s.active ? 'rgba(143,255,168,0.18)' : 'rgba(255,226,138,0.12)';
    this.buildBtn.style.color = s.active ? '#8fffa8' : '#ffe28a';
    this.buildBtn.textContent = s.active ? '✕  Cancel  (Esc)' : '🛤  Build Track  (B)';
    if (!s.active) {
      this.banner.style.display = 'none';
      return;
    }
    this.banner.style.display = 'flex';
    const cost = s.cost > 0 ? `  —  $${s.cost.toLocaleString()}${s.affordable ? '' : ' (too expensive)'}` : '';
    this.bannerText.innerHTML = `${s.hint}${cost}`;
    this.banner.style.borderColor = s.cost > 0 && !s.affordable ? 'rgba(255,119,102,0.7)' : 'rgba(143,255,168,0.4)';
    // The ✓ Finish button only lights up once the route can actually be committed.
    const ready = s.canFinish && s.affordable;
    this.finishBtn.disabled = !ready;
    this.finishBtn.style.opacity = ready ? '1' : '0.4';
    this.finishBtn.style.cursor = ready ? 'pointer' : 'not-allowed';
  }

  /** Per-frame: refresh treasury/ledger and reposition the city name plates. */
  update(camera: THREE.PerspectiveCamera, w: number, h: number): void {
    // DOM writes force reflow, so touch each element only when its value changes.
    const money = Math.round(this.network.money);
    if (money !== this.lastMoney) {
      this.money.textContent = `$${money.toLocaleString()}`;
      this.lastMoney = money;
    }
    if (this.network.year !== this.lastYear) {
      this.year.textContent = `Year ${this.network.year}`;
      this.lastYear = this.network.year;
      if (this.network.year !== this.lastEngineYear) this.populateEngines();
    }

    const up = Math.round(this.network.upkeepPerYear);
    this.upkeep.textContent = up > 0 ? `Upkeep −$${up.toLocaleString()}/yr` : 'No fleet in service';
    const progress = this.network.objectiveProgress();
    const th = this.network.medalThresholds();
    const here = this.network.medalFor(progress);
    const pct = Math.max(0, Math.min(100, (progress / th.gold) * 100));
    const tier = (icon: string, value: number, reached: boolean): string =>
      `<span style="opacity:${reached ? 1 : 0.45};${reached ? 'color:#8fffa8' : ''}">${icon}${this.network.formatObjective(value)}</span>`;
    this.goalLine.innerHTML =
      `🎯 ${this.network.objectiveLabel()}` +
      `<div style="display:flex;gap:8px;font-size:11px;margin-top:3px">${tier('🥉', th.bronze, progress >= th.bronze)} ${tier(
        '🥈',
        th.silver,
        progress >= th.silver
      )} ${tier('🥇', th.gold, progress >= th.gold)}</div>` +
      `<div style="height:4px;margin-top:3px;background:rgba(255,255,255,0.12);border-radius:2px"><div style="height:100%;width:${pct}%;background:#ffe28a;border-radius:2px"></div></div>` +
      `<span style="opacity:0.7;font-size:11px">${this.network.formatObjective(progress)} so far${
        here !== 'none' ? ` · ${here}` : ''
      }</span>`;

    const debt = Math.round(this.network.debt);
    this.debtLine.innerHTML =
      debt > 0
        ? `Debt $${debt.toLocaleString()} <span style="opacity:0.6">(−$${Math.round(
            this.network.interestPerYear
          ).toLocaleString()}/yr)</span>`
        : `Debt-free <span style="opacity:0.6">· borrow up to $${Math.round(this.network.creditLimit / 1000)}k</span>`;

    // Standings: rank all railroads by net worth, highlighting the player.
    const ranked = [...this.network.companies].sort((a, b) => b.netWorth - a.netWorth);
    this.standings.innerHTML = ranked
      .map((c, i) => {
        const cc = `#${c.color.toString(16).padStart(6, '0')}`;
        const me = c === this.network.player;
        const tag = c.defunct ? ' <span style="opacity:0.5">— acquired</span>' : '';
        return `<div style="${me ? 'font-weight:700' : 'opacity:0.85'}">${i + 1}. <span style="color:${cc}">${
          c.name
        }</span> $${Math.round(c.netWorth).toLocaleString()}${tag}</div>`;
      })
      .join('');

    // Market: keep the rival dropdown in sync and show the selected stake.
    const rivals = this.network.rivals;
    if (rivals.length !== this.lastRivalCount) {
      this.lastRivalCount = rivals.length;
      this.marketWrap.style.display = rivals.length ? 'block' : 'none';
      this.marketSel.innerHTML = '';
      for (const r of rivals) {
        const o = document.createElement('option');
        o.value = r.name;
        o.textContent = r.name;
        this.marketSel.append(o);
      }
    }
    const sel = this.network.companies.find((c) => c.name === this.marketSel.value && !c.defunct);
    if (sel) {
      const stake = this.network.stake(sel) * 100;
      const sc = `#${sel.color.toString(16).padStart(6, '0')}`;
      this.marketLine.innerHTML = `$${sel.sharePrice.toFixed(2)}/sh · <span style="color:${sc}">${stake.toFixed(1)}% owned</span>`;
    }

    if (this.network.status !== 'playing' && this.overlay.style.display === 'none') this.showEnd();

    const key = this.network.deliveries.map((d) => d.amount + d.text).join('|');
    if (key !== this.ledgerKey) {
      this.ledgerKey = key;
      const rows = this.network.deliveries
        .map((d) => `<div><span style="color:#8fffa8">+$${d.amount.toLocaleString()}</span> &nbsp;${d.text}</div>`)
        .join('');
      this.ledger.innerHTML =
        `<div style="opacity:0.6;font-size:11px;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px">Deliveries</div>` +
        (rows || '<div style="opacity:0.5">No shipments yet — build a line.</div>');
    }

    // Fleet roster: rebuilt only when its shape changes (a train added/removed/broken, or
    // its load/profitability shifts) — the per-frame check is a cheap signature compare.
    const fleet: { line: GLine; train: Train }[] = [];
    for (const l of this.network.player.lines) for (const t of l.trains) fleet.push({ line: l, train: t });
    this.rosterTrains = fleet; // keep click targets current even when the DOM isn't rebuilt
    const rosterKey = fleet
      .map(({ line, train }) => {
        // Bucket the live figures so the row's displayed load% (~5%) and profit (~$10k)
        // stay reasonably fresh without rebuilding the DOM every single frame.
        const load = train.capacity > 0 ? Math.round((train.cargoTotal() / train.capacity) * 20) : 0;
        const profit = Math.round(this.network.lineStats(line).profitPerYear / 10000);
        return `${train.locoClass.id}${train.broken ? 'B' : ''}|${load}|${profit}`;
      })
      .join('~');
    if (rosterKey !== this.rosterKey) {
      this.rosterKey = rosterKey;
      this.rebuildRoster(fleet);
    }

    // Contracts: badge the toggle with how many jobs are on offer, and refresh the board
    // (only when its shape changes) while it's open.
    const offeredCount = this.network.contracts.filter((c) => c.status === 'offered').length;
    this.contractsBtn.textContent = offeredCount ? `📋  Contracts (${offeredCount})` : '📋  Contracts';
    this.contractsBtn.style.borderColor = offeredCount ? 'rgba(143,200,255,0.8)' : 'rgba(143,200,255,0.45)';
    if (this.contractsOpen) {
      const ckey = this.network.contracts.map((c) => `${c.id}${c.status}${Math.floor(c.delivered)}`).join('|');
      if (ckey !== this.contractsKey) {
        this.contractsKey = ckey;
        this.refreshContracts();
      }
    }

    for (const st of this.network.stations) {
      let label = this.labels.get(st.id);
      if (!label) {
        label = el('div', {
          position: 'absolute',
          transform: 'translate(-50%,-100%)',
          padding: '2px 8px',
          background: 'rgba(12,16,20,0.7)',
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: '6px',
          fontSize: '12px',
          whiteSpace: 'nowrap',
        });
        label.innerHTML =
          `<b>${st.name}</b> <span data-stage style="opacity:0.6">${this.network.stationLabel(st)}</span>` +
          this.cargoBadges(st) +
          `<div style="height:3px;margin-top:2px;background:rgba(255,255,255,0.15);border-radius:2px"><div data-pop style="height:100%;width:0;background:#9bd07a;border-radius:2px"></div></div>`;
        this.labelLayer.append(label);
        this.labels.set(st.id, label);
        this.popBars.set(st.id, label.querySelector('[data-pop]') as HTMLDivElement);
        this.stageLabels.set(st.id, label.querySelector('[data-stage]') as HTMLElement);
      }
      this.v.copy(st.pos);
      this.v.y += 14;
      this.v.project(camera);
      const visible = this.v.z < 1 && this.v.x > -1.1 && this.v.x < 1.1 && this.v.y > -1.1 && this.v.y < 1.1;
      label.style.display = visible ? 'block' : 'none';
      if (visible) {
        label.style.left = `${(this.v.x * 0.5 + 0.5) * w}px`;
        label.style.top = `${(-this.v.y * 0.5 + 0.5) * h}px`;
        const pop = this.popBars.get(st.id);
        if (pop) pop.style.width = `${Math.min(100, ((st.growth - 1) / 2) * 100)}%`;
        // Keep the plate's stage subtitle live as the settlement grows.
        const sl = this.stageLabels.get(st.id);
        if (sl) {
          const txt = this.network.stationLabel(st);
          if (sl.textContent !== txt) sl.textContent = txt;
        }
      }
    }
  }

  /** Small coloured dots: what the city offers (filled) and wants (ringed). */
  private cargoBadges(st: {
    supplies: Partial<Record<CargoKind, number>>;
    demands: Set<CargoKind>;
    recipe?: { output: CargoKind };
  }): string {
    const dot = (k: CargoKind, filled: boolean): string => {
      const c = '#' + CARGO[k].color.toString(16).padStart(6, '0');
      return `<span title="${CARGO[k].label}" style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-left:3px;vertical-align:middle;${
        filled ? `background:${c}` : `border:1.5px solid ${c}`
      }"></span>`;
    };
    const offers = new Set<CargoKind>(Object.keys(st.supplies) as CargoKind[]);
    if (st.recipe) offers.add(st.recipe.output);
    let out = '<span style="margin-left:6px">';
    for (const k of offers) out += dot(k, true);
    for (const k of st.demands) if (!offers.has(k)) out += dot(k, false);
    return out + '</span>';
  }
}

function el(tag: string, style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  Object.assign(e.style, style);
  return e;
}

function groupLabelEl(text: string): HTMLDivElement {
  const d = el('div', {
    marginTop: '10px',
    fontSize: '10.5px',
    textTransform: 'uppercase',
    letterSpacing: '0.6px',
    opacity: '0.55',
  });
  d.textContent = text;
  return d;
}

function financeBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  Object.assign(b.style, {
    flex: '1',
    padding: '5px 4px',
    pointerEvents: 'auto',
    cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: '6px',
    background: 'rgba(255,255,255,0.06)',
    color: '#f4f0e6',
    fontSize: '11px',
    fontWeight: '600',
  } as CSSStyleDeclaration);
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function bannerButton(label: string, color: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  Object.assign(b.style, {
    padding: '7px 16px',
    pointerEvents: 'auto',
    cursor: 'pointer',
    border: `1px solid ${color}88`,
    borderRadius: '7px',
    background: `${color}22`,
    color,
    fontSize: '13px',
    fontWeight: '700',
  } as CSSStyleDeclaration);
  b.textContent = label;
  b.onclick = onClick;
  return b;
}
