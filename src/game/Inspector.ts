import { Network, GStation, GLine, STOCK_CAP } from './Network';
import { CARGO, CargoKind } from './Cargo';
import { Train } from './Train';

export type Selection =
  | { kind: 'station'; station: GStation }
  | { kind: 'train'; line: GLine; train: Train }
  | null;

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

/**
 * The right-hand detail panel. Click a city to read its waiting stock, what it offers
 * and wants, and where it's connected; click a train to read its manifest and route.
 * Refreshed a few times a second from live state while something is selected.
 */
export class Inspector {
  private panel: HTMLDivElement;
  private sel: Selection = null;
  private accum = 0;

  constructor(
    private network: Network,
    private onClose: () => void,
    private onAddTrain: (line: GLine) => void,
    private onBuildIndustry: (st: GStation) => void
  ) {
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'absolute',
      top: '14px',
      right: '14px',
      width: '244px',
      padding: '12px 14px',
      background: 'rgba(18,22,28,0.78)',
      borderRadius: '10px',
      backdropFilter: 'blur(6px)',
      boxShadow: '0 2px 18px rgba(0,0,0,0.35)',
      pointerEvents: 'auto',
      display: 'none',
      font: '13px/1.45 -apple-system, Segoe UI, Roboto, sans-serif',
      color: '#f4f0e6',
    } as CSSStyleDeclaration);
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.body.append(this.panel);
  }

  select(sel: Selection): void {
    this.sel = sel;
    this.accum = 1e9; // force an immediate render
    if (!sel) this.panel.style.display = 'none';
  }

  update(dt: number): void {
    if (!this.sel) return;
    this.accum += dt;
    if (this.accum < 0.2) return;
    this.accum = 0;
    // A selected station/train can be valid only as long as it still exists.
    this.panel.style.display = 'block';
    this.panel.innerHTML =
      this.sel.kind === 'station' ? this.stationHtml(this.sel.station) : this.trainHtml(this.sel.line, this.sel.train);
    const close = this.panel.querySelector('[data-close]') as HTMLElement | null;
    if (close) close.onclick = () => this.onClose();
    const add = this.panel.querySelector('[data-addtrain]') as HTMLElement | null;
    if (add && this.sel.kind === 'train') {
      const line = this.sel.line;
      add.onclick = () => this.onAddTrain(line);
    }
    const ind = this.panel.querySelector('[data-industry]') as HTMLElement | null;
    if (ind && this.sel.kind === 'station') {
      const st = this.sel.station;
      ind.onclick = () => this.onBuildIndustry(st);
    }
  }

  private header(title: string, sub: string): string {
    return (
      `<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">` +
      `<div><div style="font-size:16px;font-weight:700">${title}</div>` +
      `<div style="font-size:11.5px;opacity:0.6">${sub}</div></div>` +
      `<div data-close style="cursor:pointer;opacity:0.6;font-size:16px;line-height:1;padding:0 2px">×</div></div>`
    );
  }

  private bar(label: string, color: string, frac: number, right: string): string {
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    return (
      `<div style="margin:5px 0 2px"><div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:2px">` +
      `<span>${label}</span><span style="opacity:0.7">${right}</span></div>` +
      `<div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.1);overflow:hidden">` +
      `<div style="height:100%;width:${pct}%;background:${color};border-radius:4px"></div></div></div>`
    );
  }

  private stationHtml(st: GStation): string {
    let html = this.header(st.name, st.archetype.kind);

    if (st.owner) {
      const c = '#' + st.owner.color.toString(16).padStart(6, '0');
      html += `<div style="font-size:12px;margin:-4px 0 6px">Industry owned by <span style="color:${c}">${st.owner.name}</span></div>`;
    }

    // Processors: what they consume, with current input inventory, and the recipe.
    if (st.recipe) {
      const ins = Object.keys(st.recipe.inputs) as CargoKind[];
      html += `<div style="opacity:0.55;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;margin-top:8px">Consumes</div>`;
      for (const k of ins) {
        const amt = st.input.get(k) ?? 0;
        html += this.bar(CARGO[k].label, hex(CARGO[k].color), amt / STOCK_CAP, `${Math.floor(amt)}`);
      }
      html += `<div style="opacity:0.6;font-size:11px;margin-top:3px">${ins.map((k) => CARGO[k].label).join(' + ')} → ${
        CARGO[st.recipe.output].label
      }</div>`;
    }

    const produced = [...(Object.keys(st.supplies) as CargoKind[]), ...(st.recipe ? [st.recipe.output] : [])];
    if (produced.length) {
      html += `<div style="opacity:0.55;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;margin-top:8px">Produces</div>`;
      for (const k of produced) {
        const amt = st.stock.get(k) ?? 0;
        html += this.bar(CARGO[k].label, hex(CARGO[k].color), amt / STOCK_CAP, `${Math.floor(amt)}`);
      }
    }

    const recipeIn = st.recipe ? st.recipe.inputs : {};
    const wants = [...st.demands].filter((k) => !(k in st.supplies) && !(k in recipeIn));
    if (wants.length) {
      html += `<div style="opacity:0.55;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;margin-top:10px">Wants</div><div style="margin-top:4px">`;
      for (const k of wants) html += this.chip(CARGO[k].label, hex(CARGO[k].color));
      html += `</div>`;
    }

    const links = this.network.lines
      .filter((l) => l.stops.includes(st))
      .map((l) => l.stops.filter((s) => s !== st).map((s) => s.name).join(', '));
    html += `<div style="opacity:0.55;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;margin-top:10px">Lines</div>`;
    html += links.length
      ? `<div style="margin-top:3px">${links.map((n) => `→ ${n}`).join('<br>')}</div>`
      : `<div style="opacity:0.5;margin-top:3px">Unconnected — build a line here.</div>`;

    // Found a factory here if the city has no industry of its own.
    if (!st.recipe) {
      html += `<div data-industry style="margin-top:12px;text-align:center;cursor:pointer;pointer-events:auto;padding:6px;border-radius:6px;border:1px solid rgba(255,226,138,0.5);color:#ffe28a;font-size:12px">🏭 Build Factory — $160k</div>`;
    }

    return html;
  }

  private trainHtml(line: GLine, t: Train): string {
    const lc = t.locoClass;
    const route = line.stops.map((s) => s.name).join(' → ');
    let html = this.header(`${lc.name} ${lc.wheel}`, route);
    html += `<div style="display:flex;gap:10px;font-size:11.5px;opacity:0.75;margin:-2px 0 6px">` +
      `<span>${lc.speed} mph</span><span>cap ${lc.capacity}</span><span>−$${(lc.upkeep / 1000).toFixed(0)}k/yr</span></div>`;
    const total = t.cargoTotal();
    html += this.bar('Load', '#8fffa8', total / t.capacity, `${Math.floor(total)} / ${t.capacity}`);

    html += `<div style="opacity:0.55;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;margin-top:10px">Manifest</div>`;
    if (t.cargo.size === 0) {
      html += `<div style="opacity:0.5;margin-top:3px">Running empty.</div>`;
    } else {
      html += `<div style="margin-top:4px">`;
      for (const [k, lot] of t.cargo) {
        html += `<div style="display:flex;align-items:center;gap:6px;margin:3px 0">${this.dot(hex(CARGO[k].color))}<span>${Math.floor(
          lot.amount
        )} ${CARGO[k].label}</span></div>`;
      }
      html += `</div>`;
    }

    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.12)">`;
    html += `<span style="opacity:0.7;font-size:11.5px">${line.trains.length} train${line.trains.length > 1 ? 's' : ''} on line</span>`;
    html += line.owner.isAI
      ? `<span style="font-size:11.5px;color:#${line.owner.color.toString(16).padStart(6, '0')}">${line.owner.name}</span>`
      : `<span data-addtrain style="cursor:pointer;pointer-events:auto;padding:4px 10px;border-radius:6px;border:1px solid rgba(143,255,168,0.5);color:#8fffa8;font-size:11.5px">+ Add train</span>`;
    html += `</div>`;
    return html;
  }

  private chip(label: string, color: string): string {
    return `<span style="display:inline-flex;align-items:center;gap:4px;margin:2px 5px 2px 0;padding:2px 7px;border-radius:10px;background:rgba(255,255,255,0.08);font-size:11.5px">${this.dot(
      color
    )}${label}</span>`;
  }

  private dot(color: string): string {
    return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color}"></span>`;
  }
}
