import * as THREE from 'three';
import { Network } from './Network';
import { BuildStatus } from './TrackBuilder';
import { CARGO, CargoKind } from './Cargo';
import { QUALITY, QualityLevel } from '../engine/Renderer';

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
  private v = new THREE.Vector3();
  private lastMoney = NaN;
  private lastYear = NaN;
  private ledgerKey = '';

  private qualityBtns = new Map<QualityLevel, HTMLButtonElement>();

  constructor(
    private network: Network,
    onBuildToggle: () => void,
    quality: QualityLevel,
    onQuality: (q: QualityLevel) => void
  ) {
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
    top.append(this.money, this.year);

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

    document.body.append(this.root);
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
    }

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
        label.innerHTML = `<b>${st.name}</b> <span style="opacity:0.6">${st.archetype.kind}</span>` + this.cargoBadges(st);
        this.labelLayer.append(label);
        this.labels.set(st.id, label);
      }
      this.v.copy(st.pos);
      this.v.y += 14;
      this.v.project(camera);
      const visible = this.v.z < 1 && this.v.x > -1.1 && this.v.x < 1.1 && this.v.y > -1.1 && this.v.y < 1.1;
      label.style.display = visible ? 'block' : 'none';
      if (visible) {
        label.style.left = `${(this.v.x * 0.5 + 0.5) * w}px`;
        label.style.top = `${(-this.v.y * 0.5 + 0.5) * h}px`;
      }
    }
  }

  /** Small coloured dots: what the city offers (filled) and wants (ringed). */
  private cargoBadges(st: { supplies: Partial<Record<CargoKind, number>>; demands: Set<CargoKind> }): string {
    const dot = (k: CargoKind, filled: boolean): string => {
      const c = '#' + CARGO[k].color.toString(16).padStart(6, '0');
      return `<span title="${CARGO[k].label}" style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-left:3px;vertical-align:middle;${
        filled ? `background:${c}` : `border:1.5px solid ${c}`
      }"></span>`;
    };
    let out = '<span style="margin-left:6px">';
    for (const k of Object.keys(st.supplies) as CargoKind[]) out += dot(k, true);
    for (const k of st.demands) if (!(k in st.supplies)) out += dot(k, false);
    return out + '</span>';
  }
}

function el(tag: string, style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const e = document.createElement(tag) as HTMLDivElement;
  Object.assign(e.style, style);
  return e;
}
