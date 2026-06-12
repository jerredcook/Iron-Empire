import * as THREE from 'three';
import { Network } from './Network';
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
  private ledger: HTMLDivElement;
  private labelLayer: HTMLDivElement;
  private labels = new Map<number, HTMLDivElement>();
  private popBars = new Map<number, HTMLDivElement>();
  private v = new THREE.Vector3();
  private lastMoney = NaN;
  private lastYear = NaN;
  private ledgerKey = '';

  private qualityBtns = new Map<QualityLevel, HTMLButtonElement>();
  private upkeep!: HTMLDivElement;
  private goalLine!: HTMLDivElement;
  private rivalLine!: HTMLDivElement;
  private debtLine!: HTMLDivElement;
  private marketLine!: HTMLDivElement;
  private engineSel!: HTMLSelectElement;
  private overlay!: HTMLDivElement;
  private selectedLoco: LocoClass;
  private lastEngineYear = 0;

  constructor(
    private network: Network,
    onBuildToggle: () => void,
    quality: QualityLevel,
    onQuality: (q: QualityLevel) => void,
    private onLoco: (l: LocoClass) => void
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
    this.rivalLine = el('div', { fontSize: '12px', opacity: '0.75', marginTop: '6px' });
    top.append(this.money, this.year, this.upkeep, this.goalLine, this.rivalLine);

    // Finance: outstanding debt + bond/repay controls.
    this.debtLine = el('div', { fontSize: '12px', opacity: '0.7', marginTop: '8px' });
    const finRow = el('div', { display: 'flex', gap: '4px', marginTop: '4px' });
    const bond = financeBtn('Bond +$200k', () => this.network.issueBond(200_000));
    const repay = financeBtn('Repay $100k', () => this.network.repayDebt(100_000));
    finRow.append(bond, repay);
    top.append(this.debtLine, finRow);

    // Stock market: build a stake in the rival; cross 50% to absorb them.
    const mLabel = el('div', {
      marginTop: '10px',
      fontSize: '10.5px',
      textTransform: 'uppercase',
      letterSpacing: '0.6px',
      opacity: '0.55',
    });
    mLabel.textContent = 'Market';
    this.marketLine = el('div', { fontSize: '12px', opacity: '0.8', marginTop: '3px' });
    const mRow = el('div', { display: 'flex', gap: '4px', marginTop: '4px' });
    const buy = financeBtn('Buy 5k shares', () => this.network.buyShares(this.network.rival, 5000));
    const sell = financeBtn('Sell 5k', () => this.network.sellShares(this.network.rival, 5000));
    mRow.append(buy, sell);
    top.append(mLabel, this.marketLine, mRow);

    // System: persist / restore the game.
    const sysRow = el('div', { display: 'flex', gap: '4px', marginTop: '10px' });
    const saveBtn = financeBtn('Save', () => {
      this.network.save();
      saveBtn.textContent = 'Saved ✓';
      setTimeout(() => (saveBtn.textContent = 'Save'), 1200);
    });
    const loadBtn = financeBtn('Load', () => {
      sessionStorage.setItem('ie.load', '1');
      location.reload();
    });
    sysRow.append(saveBtn, loadBtn);
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

    // Build-mode banner, centred at top.
    this.banner = el('div', {
      position: 'absolute',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '9px 16px',
      background: 'rgba(20,28,22,0.82)',
      border: '1px solid rgba(143,255,168,0.4)',
      borderRadius: '8px',
      fontSize: '13px',
      display: 'none',
      whiteSpace: 'nowrap',
    });
    this.root.append(this.banner);

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

    // Bottom-right controls hint.
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
    });
    help.innerHTML = 'Drag pan · Right-drag orbit · Wheel zoom · WASD<br>B build track · Esc cancel';
    this.root.append(help);

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
    const title = won ? 'Empire Secured' : 'Railroad Bankrupt';
    const sub = won
      ? `You reached $${Math.round(this.network.netWorth).toLocaleString()} net worth by ${this.network.year}.`
      : this.network.money < 0
        ? `The treasury collapsed in ${this.network.year}.`
        : `The deadline of ${this.network.goal.byYear} passed short of the target.`;
    this.overlay.innerHTML =
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

  setBuildStatus(s: BuildStatus): void {
    this.buildBtn.style.background = s.active ? 'rgba(143,255,168,0.18)' : 'rgba(255,226,138,0.12)';
    this.buildBtn.style.color = s.active ? '#8fffa8' : '#ffe28a';
    this.buildBtn.textContent = s.active ? '✕  Cancel  (Esc)' : '🛤  Build Track  (B)';
    if (!s.active) {
      this.banner.style.display = 'none';
      return;
    }
    this.banner.style.display = 'block';
    const cost = s.cost > 0 ? `  —  $${s.cost.toLocaleString()}${s.affordable ? '' : ' (too expensive)'}` : '';
    this.banner.innerHTML = `${s.hint}${cost}`;
    this.banner.style.borderColor = s.cost > 0 && !s.affordable ? 'rgba(255,119,102,0.7)' : 'rgba(143,255,168,0.4)';
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
    const g = this.network.goal;
    const pct = Math.max(0, Math.min(100, (this.network.netWorth / g.targetCash) * 100));
    this.goalLine.innerHTML = `🎯 $${(g.targetCash / 1e6).toFixed(1)}M net worth by ${g.byYear}<br><span style="opacity:0.7">${pct.toFixed(
      0
    )}% &middot; worth $${Math.round(this.network.netWorth).toLocaleString()}</span>`;

    const debt = Math.round(this.network.debt);
    this.debtLine.innerHTML =
      debt > 0
        ? `Debt $${debt.toLocaleString()} <span style="opacity:0.6">(−$${Math.round(
            this.network.interestPerYear
          ).toLocaleString()}/yr)</span>`
        : `Debt-free <span style="opacity:0.6">· borrow up to $${Math.round(this.network.creditLimit / 1000)}k</span>`;

    const rival = this.network.rival;
    const rc = `#${rival.color.toString(16).padStart(6, '0')}`;
    if (rival.defunct) {
      this.rivalLine.innerHTML = `<span style="color:${rc}">${rival.name}</span> <span style="opacity:0.6">— acquired</span>`;
      this.marketLine.textContent = 'Rival absorbed into your empire.';
    } else {
      const lead = this.network.netWorth - rival.netWorth;
      this.rivalLine.innerHTML =
        `<span style="color:${rc}">${rival.name}</span> $${Math.round(rival.netWorth).toLocaleString()} ` +
        `<span style="opacity:0.6">(${lead >= 0 ? 'lead' : 'behind'} $${Math.round(Math.abs(lead)).toLocaleString()})</span>`;
      const stake = this.network.stake(rival) * 100;
      this.marketLine.innerHTML = `${rival.name} $${rival.sharePrice.toFixed(2)}/sh · <span style="color:${rc}">${stake.toFixed(
        1
      )}% owned</span>`;
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
          `<b>${st.name}</b> <span style="opacity:0.6">${st.archetype.kind}</span>` +
          this.cargoBadges(st) +
          `<div style="height:3px;margin-top:2px;background:rgba(255,255,255,0.15);border-radius:2px"><div data-pop style="height:100%;width:0;background:#9bd07a;border-radius:2px"></div></div>`;
        this.labelLayer.append(label);
        this.labels.set(st.id, label);
        this.popBars.set(st.id, label.querySelector('[data-pop]') as HTMLDivElement);
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
