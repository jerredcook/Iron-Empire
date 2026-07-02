import { Network, GStation, GLine, STOCK_CAP } from './Network';
import { CARGO, CargoKind, CAR_LABEL, carCapacity } from './Cargo';
import { StationBuilding, STATION_BUILDINGS, STATION_BUILDING_ORDER } from './Depot';
import { Train } from './Train';
import { defaultLoco } from './Locomotives';

export type Selection =
  | { kind: 'station'; station: GStation }
  | { kind: 'train'; line: GLine; train: Train }
  | { kind: 'line'; line: GLine }
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
    private onBuildIndustry: (st: GStation) => void,
    private onUpgrade: (st: GStation) => void,
    private onFollow: (train: Train) => void,
    private onSellTrain: (line: GLine, train: Train) => void,
    private onDemolishLine: (line: GLine) => void,
    private onBuildStation: (st: GStation) => void,
    private onThroughService: (st: GStation) => void,
    private onDemolishStation: (st: GStation) => void,
    private onRepairTrain: (line: GLine, train: Train) => void,
    private onAddStationBuilding: (st: GStation, type: StationBuilding) => void,
    private onUpgradeLoco: (line: GLine, train: Train) => void,
    private onRepairLine: (line: GLine) => void,
    private onConnectLines: (a: GLine, b: GLine) => void = () => {},
    private onThroughTrain: (line: GLine) => void = () => {}
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
    // A selected station/train/line is valid only as long as it still exists.
    this.panel.style.display = 'block';
    this.panel.innerHTML =
      this.sel.kind === 'station'
        ? this.stationHtml(this.sel.station)
        : this.sel.kind === 'line'
          ? this.lineHtml(this.sel.line)
          : this.trainHtml(this.sel.line, this.sel.train);
    const close = this.panel.querySelector('[data-close]') as HTMLElement | null;
    if (close) close.onclick = () => this.onClose();
    if (this.sel.kind === 'train') {
      const { line, train } = this.sel;
      const add = this.panel.querySelector('[data-addtrain]') as HTMLElement | null;
      if (add) add.onclick = () => this.onAddTrain(line);
      const follow = this.panel.querySelector('[data-follow]') as HTMLElement | null;
      if (follow) follow.onclick = () => this.onFollow(train);
      const sell = this.panel.querySelector('[data-sell]') as HTMLElement | null;
      if (sell) sell.onclick = () => this.onSellTrain(line, train);
      const demo = this.panel.querySelector('[data-demolish]') as HTMLElement | null;
      if (demo) demo.onclick = () => this.onDemolishLine(line);
      const repair = this.panel.querySelector('[data-repair]') as HTMLElement | null;
      if (repair) repair.onclick = () => this.onRepairTrain(line, train);
      const upg = this.panel.querySelector('[data-upgradeloco]') as HTMLElement | null;
      if (upg) upg.onclick = () => this.onUpgradeLoco(line, train);
    }
    if (this.sel.kind === 'line') {
      const line = this.sel.line;
      const add = this.panel.querySelector('[data-addtrain]') as HTMLElement | null;
      if (add) add.onclick = () => this.onAddTrain(line);
      const demo = this.panel.querySelector('[data-demolish]') as HTMLElement | null;
      if (demo) demo.onclick = () => this.onDemolishLine(line);
      const fix = this.panel.querySelector('[data-repairline]') as HTMLElement | null;
      if (fix) fix.onclick = () => this.onRepairLine(line);
      this.panel.querySelectorAll('[data-connect]').forEach((el) => {
        const other = this.network.lines[+(el.getAttribute('data-connect') ?? -1)];
        if (other) (el as HTMLElement).onclick = () => this.onConnectLines(line, other);
      });
      const thr = this.panel.querySelector('[data-throughtrain]') as HTMLElement | null;
      if (thr) thr.onclick = () => this.onThroughTrain(line);
    }
    const ds = this.panel.querySelector('[data-demolishstation]') as HTMLElement | null;
    if (ds && this.sel.kind === 'station') {
      const st = this.sel.station;
      ds.onclick = () => this.onDemolishStation(st);
    }
    if (this.sel.kind === 'station') {
      const st = this.sel.station;
      this.panel.querySelectorAll('[data-building]').forEach((node) => {
        const b = (node as HTMLElement).dataset.building as StationBuilding;
        (node as HTMLElement).onclick = () => this.onAddStationBuilding(st, b);
      });
    }
    const ind = this.panel.querySelector('[data-industry]') as HTMLElement | null;
    if (ind && this.sel.kind === 'station') {
      const st = this.sel.station;
      ind.onclick = () => this.onBuildIndustry(st);
    }
    const upg = this.panel.querySelector('[data-upgrade]') as HTMLElement | null;
    if (upg && this.sel.kind === 'station') {
      const st = this.sel.station;
      upg.onclick = () => this.onUpgrade(st);
    }
    const bs = this.panel.querySelector('[data-buildstation]') as HTMLElement | null;
    if (bs && this.sel.kind === 'station') {
      const st = this.sel.station;
      bs.onclick = () => this.onBuildStation(st);
    }
    const ts = this.panel.querySelector('[data-through]') as HTMLElement | null;
    if (ts && this.sel.kind === 'station') {
      const st = this.sel.station;
      ts.onclick = () => this.onThroughService(st);
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
    let html = this.header(st.name, this.network.stationLabel(st));

    if (st.owner) {
      const c = '#' + st.owner.color.toString(16).padStart(6, '0');
      html += `<div style="font-size:12px;margin:-4px 0 4px">Industry owned by <span style="color:${c}">${st.owner.name}</span></div>`;
    }

    if (st.hasStation) {
      // Depot level, its revenue bonus, and earnings booked here so far.
      const stars = '★'.repeat(st.level) + '☆'.repeat(3 - st.level);
      html += `<div style="display:flex;justify-content:space-between;font-size:12px;margin:2px 0 6px">` +
        `<span style="color:#ffe28a">Depot ${stars}</span>` +
        `<span style="opacity:0.75">+${Math.round(st.level * 18)}% haul</span></div>`;
      html += `<div style="font-size:12px;opacity:0.75;margin-bottom:4px">Earned here: $${Math.round(st.revenue).toLocaleString()}</div>`;
      if (st.catchment.length) {
        html += `<div style="font-size:11.5px;opacity:0.7;margin-bottom:4px">Catchment serves: ${st.catchment
          .map((c) => c.name)
          .join(', ')}</div>`;
      }
      const reach = this.network.reachableFrom(st).size - 1;
      if (reach > 0) html += `<div style="font-size:11.5px;opacity:0.7;margin-bottom:4px">🌐 Network: reaches ${reach} other station${reach === 1 ? '' : 's'}</div>`;

      // Maintenance facilities — built ones as green pills, the rest as buy buttons.
      if (this.network.hasDepot(st, this.network.player)) {
        html += `<div style="opacity:0.55;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;margin-top:8px">Facilities</div>`;
        const owned = STATION_BUILDING_ORDER.filter((b) => st.buildings.has(b));
        if (owned.length) {
          html += `<div style="margin-top:3px">${owned
            .map((b) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 7px;border-radius:10px;background:rgba(143,255,168,0.14);color:#bff6c9;font-size:11px">${STATION_BUILDINGS[b].icon} ${STATION_BUILDINGS[b].label}</span>`)
            .join('')}</div>`;
        }
        for (const b of STATION_BUILDING_ORDER) {
          if (st.buildings.has(b)) continue;
          const def = STATION_BUILDINGS[b];
          html += `<div data-building="${b}" title="${def.blurb}" style="margin-top:5px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;pointer-events:auto;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,226,138,0.4);color:#ffe28a;font-size:11.5px">` +
            `<span>${def.icon} ${def.label}</span><span style="opacity:0.8">$${(def.cost / 1000).toFixed(0)}k</span></div>`;
        }
      }
    } else {
      html += `<div style="font-size:12px;opacity:0.7;margin:2px 0 6px">No depot — build one to route trains here.</div>`;
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

    const btn = (attr: string, label: string): string =>
      `<div ${attr} style="margin-top:8px;text-align:center;cursor:pointer;pointer-events:auto;padding:6px;border-radius:6px;border:1px solid rgba(255,226,138,0.5);color:#ffe28a;font-size:12px">${label}</div>`;
    // The core station-first step: a city can't be routed to without a depot. Rendered as a
    // filled green primary action so a new player sees it's the thing to do here.
    if (!st.hasStation) {
      html += `<div data-buildstation style="margin-top:8px;text-align:center;cursor:pointer;pointer-events:auto;padding:9px;border-radius:7px;border:1px solid rgba(143,255,168,0.7);background:rgba(143,255,168,0.16);color:#8fffa8;font-size:13px;font-weight:700">🚉 Build Station — $70k</div>` +
        `<div style="font-size:11px;opacity:0.6;text-align:center;margin-top:3px">Trains can stop here once this is built.</div>`;
    }
    // Run one train across the whole connected network through its junctions.
    if (st.hasStation && this.network.reachableFrom(st).size > 1) {
      html += btn('data-through', '🚆 Run Through-Service across network');
    }
    // A depot can be upgraded; an industry can be founded regardless of a depot.
    if (st.hasStation && st.level < 3) html += btn('data-upgrade', `⬆ Upgrade Depot — $${(90 * (st.level + 1)).toFixed(0)}k`);
    if (!st.recipe) html += btn('data-industry', '🏭 Build Factory — $160k');
    // Demolish your own depot (scraps lines that stop here) for a partial refund.
    if (this.network.hasDepot(st, this.network.player)) {
      html += `<div data-demolishstation style="margin-top:8px;text-align:center;cursor:pointer;pointer-events:auto;padding:6px;border-radius:6px;border:1px solid rgba(255,119,102,0.5);color:#ff7766;font-size:12px">✕ Demolish Station — +$28k</div>`;
    }

    return html;
  }

  /** Panel for a rail line selected by clicking its track. */
  /** The line's running profit-and-loss — the "is this route paying?" readout. */
  private plHtml(line: GLine): string {
    const s = this.network.lineStats(line);
    const profit = Math.round(s.profitPerYear);
    const col = profit >= 0 ? '#8fffa8' : '#ff7766';
    const sign = profit >= 0 ? '+' : '−';
    const money = (n: number): string => `$${Math.abs(Math.round(n)).toLocaleString()}`;
    return (
      `<div style="margin-top:8px;padding:7px 9px;border-radius:7px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)">` +
      `<div style="display:flex;justify-content:space-between;align-items:baseline">` +
      `<span style="opacity:0.6;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px">Profit / year</span>` +
      `<span style="color:${col};font-weight:700">${sign}${money(profit)}</span></div>` +
      `<div style="display:flex;justify-content:space-between;font-size:11px;opacity:0.7;margin-top:3px">` +
      `<span>${money(s.perTrip)}/trip · ${s.trips} trips</span>` +
      `<span>−${money(s.upkeepPerYear)}/yr upkeep</span></div></div>`
    );
  }

  private lineHtml(line: GLine): string {
    const route = line.stops.length ? line.stops.map((s) => s.name).join(' → ') : 'Unconnected track';
    const oc = '#' + line.owner.color.toString(16).padStart(6, '0');
    let html = this.header(line.through ? 'Through-Service' : 'Rail Line', route);
    html += `<div style="display:flex;gap:10px;font-size:11.5px;opacity:0.78;margin:-2px 0 6px">` +
      `<span style="color:${oc}">${line.owner.name}</span><span>${line.trains.length} train${line.trains.length === 1 ? '' : 's'}</span>` +
      (line.through ? '' : `<span>value $${Math.round(line.value).toLocaleString()}</span>`) +
      `</div>`;
    html += this.plHtml(line);
    // A washed-out line: a halted-service banner plus a one-click emergency repair.
    if (this.network.isBlocked(line)) {
      const cost = this.network.washoutRepairCost(line);
      html += `<div style="margin-top:8px;padding:7px 9px;border-radius:7px;background:rgba(255,150,90,0.12);border:1px solid rgba(255,150,90,0.45);color:#ffb784;font-size:12px">⛈ Washed out — service halted while it rebuilds.</div>`;
      if (line.owner === this.network.player) {
        html += `<div data-repairline style="margin-top:6px;text-align:center;cursor:pointer;pointer-events:auto;padding:6px;border-radius:6px;border:1px solid rgba(255,200,120,0.6);color:#ffd089;font-size:12px">🛠 Repair now — $${Math.round(cost / 1000)}k</div>`;
      }
    }
    // Running trains is done from the line panel (where a player lands after laying track):
    // a prominent CTA when the line has none yet, a quieter one to add more, or a clear note
    // on what's missing if the line can't run a train yet.
    if (!line.owner.isAI && !line.through) {
      const stationed = line.stops.filter((s) => s.hasStation).length;
      if (stationed >= 2) {
        html += line.trains.length === 0
          ? `<div data-addtrain style="margin-top:10px;text-align:center;cursor:pointer;pointer-events:auto;padding:9px;border-radius:7px;border:1px solid rgba(143,255,168,0.7);background:rgba(143,255,168,0.16);color:#8fffa8;font-size:13px;font-weight:700">🚂 Start a train</div>` +
            `<div style="font-size:11px;opacity:0.6;text-align:center;margin-top:3px">Pick a locomotive and what it should haul.</div>`
          : `<div data-addtrain style="margin-top:9px;text-align:center;cursor:pointer;pointer-events:auto;padding:6px;border-radius:6px;border:1px solid rgba(143,255,168,0.5);color:#8fffa8;font-size:12px">＋ Add another train</div>`;
      } else {
        // A spur with ONE stationed stop isn't a dead end: its rails weld onto the rest of the
        // network at the turnout, so a through-train can run from here across the junction to
        // the nearest connected station.
        const s0 = line.stops.find((s) => s.hasStation);
        const partner = s0 ? this.network.nearestRailPartner(line.owner, s0) : null;
        if (s0 && partner) {
          html +=
            `<div data-throughtrain style="margin-top:10px;text-align:center;cursor:pointer;pointer-events:auto;padding:9px;border-radius:7px;border:1px solid rgba(143,255,168,0.7);background:rgba(143,255,168,0.16);color:#8fffa8;font-size:13px;font-weight:700">🚂 Start a through train — ${s0.name} ↔ ${partner.name}</div>` +
            `<div style="font-size:11px;opacity:0.6;text-align:center;margin-top:3px">Runs across the junction onto your connected rails.</div>`;
        } else {
          html += `<div style="margin-top:9px;padding:7px 9px;border-radius:7px;background:rgba(255,200,120,0.1);border:1px solid rgba(255,200,120,0.4);color:#ffd089;font-size:11.5px">⚠ Needs a Station at two of these cities before a train can run — click a city → Build Station.</div>`;
        }
      }
    }
    if (!line.owner.isAI) {
      // Join this line to another of yours that meets it at a station — the two weld into one
      // continuous through-route (a real junction: both rails join, a train runs straight through).
      for (const { other, at } of this.network.connectableLines(line)) {
        const far = other.stops[0] === at ? other.stops[other.stops.length - 1] : other.stops[0];
        const idx = this.network.lines.indexOf(other);
        html += `<div data-connect="${idx}" style="margin-top:8px;text-align:center;cursor:pointer;pointer-events:auto;padding:6px;border-radius:6px;border:1px solid rgba(95,224,255,0.55);color:#5fe0ff;font-size:12px">🔗 Connect through ${at.name}${far ? ` → ${far.name}` : ''}</div>`;
      }
      if (line.trains.length === 0) {
        const refund = Math.round(line.value * 0.4);
        html += `<div data-demolish style="margin-top:10px;text-align:center;cursor:pointer;pointer-events:auto;padding:6px;border-radius:6px;border:1px solid rgba(255,119,102,0.5);color:#ff7766;font-size:12px">✕ Delete track${refund > 0 ? `  (+$${Math.round(refund / 1000)}k)` : ''}</div>`;
      } else {
        html += `<div style="margin-top:10px;text-align:center;padding:6px;border-radius:6px;background:rgba(255,200,120,0.1);border:1px solid rgba(255,200,120,0.35);color:#ffd089;font-size:11.5px">🚂 A train runs here — sell it first to delete this track.</div>`;
      }
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
    if (t.broken) {
      html += `<div style="margin-top:8px;padding:6px 9px;border-radius:7px;background:rgba(255,119,102,0.12);border:1px solid rgba(255,119,102,0.4);color:#ff7766;font-size:12px;display:flex;align-items:center;justify-content:space-between">` +
        `<span>⚠ Broken down — in the shop</span>` +
        (line.owner.isAI ? '' : `<span data-repair style="cursor:pointer;pointer-events:auto;padding:3px 9px;border-radius:5px;border:1px solid rgba(255,226,138,0.6);color:#ffe28a">🔧 Repair</span>`) +
        `</div>`;
    }
    html += this.plHtml(line);

    html += `<div style="opacity:0.55;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;margin-top:10px">Consist (${t.consist.length} cars)</div>`;
    html += `<div style="margin-top:4px">`;
    const routeWants = new Set(line.stops.flatMap((s) => [...s.demands]));
    t.consist.forEach((car) => {
      const warn = !routeWants.has(car.kind);
      const cap = carCapacity(car.kind);
      html += `<div style="display:flex;align-items:center;gap:6px;margin:3px 0">${this.dot(hex(CARGO[car.kind].color))}` +
        `<span>${CAR_LABEL[CARGO[car.kind].car]} · ${CARGO[car.kind].label} — ${Math.floor(car.amount)}/${cap}</span>` +
        (warn ? `<span title="No stop on this line demands this cargo" style="color:#ffb454">⚠</span>` : '') +
        `</div>`;
    });
    html += `</div>`;

    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.12)">`;
    html += `<span style="opacity:0.7;font-size:11.5px">${line.trains.length} train${line.trains.length > 1 ? 's' : ''} on line</span>`;
    html += line.owner.isAI
      ? `<span style="font-size:11.5px;color:#${line.owner.color.toString(16).padStart(6, '0')}">${line.owner.name}</span>`
      : `<span data-addtrain style="cursor:pointer;pointer-events:auto;padding:4px 10px;border-radius:6px;border:1px solid rgba(143,255,168,0.5);color:#8fffa8;font-size:11.5px">+ Add train</span>`;
    html += `</div>`;

    // Train actions.
    const action = (attr: string, label: string, color: string): string =>
      `<span ${attr} style="flex:1;text-align:center;cursor:pointer;pointer-events:auto;padding:5px 4px;border-radius:6px;border:1px solid ${color}66;color:${color};font-size:11.5px">${label}</span>`;
    html += `<div style="display:flex;gap:5px;margin-top:8px">`;
    html += action('data-follow', '🎥 Follow', '#8fffa8');
    if (!line.owner.isAI) {
      // No delete-track here: a line with a train is protected. Sell the train, then delete the
      // idle track from the line panel.
      html += action('data-sell', 'Sell train', '#ffe28a');
    }
    html += `</div>`;

    // Modernise: re-engine this train with the best class the era offers, keeping its
    // consist and place on the line, for the price difference.
    const best = defaultLoco(this.network.year);
    if (!line.owner.isAI && best.id !== lc.id) {
      const net = this.network.reLocoCost(t, best);
      html += `<div data-upgradeloco style="margin-top:6px;text-align:center;cursor:pointer;pointer-events:auto;padding:6px;border-radius:6px;border:1px solid rgba(109,180,214,0.5);color:#8fd0ff;font-size:11.5px">⬆ Re-engine → ${best.name} — $${Math.round(net / 1000)}k</div>`;
    }
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
