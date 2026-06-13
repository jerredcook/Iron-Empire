import { Network, GStation } from './Network';
import { LocoClass } from './Locomotives';
import { ALL_CARGO, CARGO, CargoKind } from './Cargo';

/**
 * Modal for configuring a train's consist: how many cars (up to what the chosen
 * locomotive can pull) and the cargo type each car hauls. You may assign a car a cargo
 * no stop on the route demands — it's allowed, but flagged with a warning, since that
 * car will ride empty of revenue. On confirm it hands back the chosen car list, so the
 * same dialog serves both building a new line and adding a train to an existing one.
 */
export function configureConsist(
  network: Network,
  stops: GStation[],
  loco: LocoClass,
  onConfirm: (cars: CargoKind[]) => void
): void {
  const maxCars = network.maxCars(loco);
  const routeWants = new Set<CargoKind>(stops.flatMap((s) => [...s.demands]));
  let cars = network.defaultConsist(stops, loco).slice(0, maxCars);
  if (cars.length === 0) cars = ['goods'];

  const panel = document.createElement('div');
  panel.setAttribute('data-consist', '1');
  Object.assign(panel.style, {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    zIndex: '42',
    width: '340px',
    padding: '18px 20px',
    background: 'rgba(18,22,28,0.95)',
    border: '1px solid rgba(143,255,168,0.4)',
    borderRadius: '12px',
    boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
    color: '#f4f0e6',
    font: '14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif',
    pointerEvents: 'auto',
  } as CSSStyleDeclaration);
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.append(panel);
  const close = (): void => panel.remove();

  const render = (): void => {
    const affordable = loco.cost <= network.money;
    const warnCount = cars.filter((k) => !routeWants.has(k)).length;
    panel.innerHTML =
      `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;opacity:0.55;margin-bottom:3px">New Train</div>` +
      `<div style="font-size:18px;font-weight:700">${loco.name} ${loco.wheel}</div>` +
      `<div style="font-size:12px;opacity:0.7;margin:3px 0 10px">Cost $${loco.cost.toLocaleString()} · pulls up to ${maxCars} cars · ${stops
        .map((s) => s.name)
        .join(' → ')}</div>` +
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="opacity:0.6;font-size:11px">CARS</span><span data-dec style="cursor:pointer;padding:1px 9px;border:1px solid rgba(255,255,255,0.25);border-radius:5px">−</span><b>${cars.length}</b><span data-inc style="cursor:pointer;padding:1px 8px;border:1px solid rgba(255,255,255,0.25);border-radius:5px">+</span></div>` +
      `<div data-cars></div>` +
      (warnCount > 0
        ? `<div style="color:#ffb454;font-size:11.5px;margin-top:6px">⚠ ${warnCount} car${warnCount > 1 ? 's carry' : ' carries'} cargo no stop on this line demands.</div>`
        : '') +
      `<div style="display:flex;gap:8px;margin-top:14px"></div>`;

    // Per-car cargo selectors.
    const carsBox = panel.querySelector('[data-cars]') as HTMLElement;
    cars.forEach((kind, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0';
      const dot = `<span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:#${CARGO[kind].color
        .toString(16)
        .padStart(6, '0')}"></span>`;
      const sel = document.createElement('select');
      sel.style.cssText =
        'flex:1;padding:5px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(12,16,20,0.9);color:#f4f0e6;font-size:12.5px';
      for (const k of ALL_CARGO) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = CARGO[k].label + (routeWants.has(k) ? '' : '  (no demand)');
        if (k === kind) o.selected = true;
        sel.append(o);
      }
      sel.onchange = () => {
        cars[i] = sel.value as CargoKind;
        render();
      };
      const warn = routeWants.has(kind) ? '' : '<span title="No stop demands this" style="color:#ffb454">⚠</span>';
      row.innerHTML = `${dot}<span style="width:42px;opacity:0.6;font-size:12px">Car ${i + 1}</span>`;
      row.append(sel);
      const w = document.createElement('span');
      w.innerHTML = warn;
      row.append(w);
      carsBox.append(row);
    });

    (panel.querySelector('[data-dec]') as HTMLElement).onclick = () => {
      if (cars.length > 1) {
        cars.pop();
        render();
      }
    };
    (panel.querySelector('[data-inc]') as HTMLElement).onclick = () => {
      if (cars.length < maxCars) {
        cars.push(cars[cars.length - 1] ?? 'goods');
        render();
      }
    };

    const row = panel.lastElementChild as HTMLElement;
    row.append(
      btn(`Buy $${Math.round(loco.cost / 1000)}k`, '#8fffa8', affordable, () => {
        onConfirm(cars.slice());
        close();
      }),
      btn('Cancel', '#f4f0e6', true, close)
    );
  };
  render();
}

function btn(label: string, color: string, enabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  Object.assign(b.style, {
    flex: '1',
    padding: '9px 8px',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? '1' : '0.4',
    border: `1px solid ${color}66`,
    borderRadius: '7px',
    background: `${color}1f`,
    color,
    fontSize: '13px',
    fontWeight: '700',
  } as CSSStyleDeclaration);
  b.textContent = label;
  if (enabled) b.onclick = onClick;
  return b;
}
