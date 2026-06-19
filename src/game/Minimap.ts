import * as THREE from 'three';
import { Heightfield } from '../world/Heightfield';
import { Network } from './Network';
import { Selection } from './Inspector';

const SIZE = 190; // on-screen px
const TERR = 144; // baked terrain resolution

const ARCH_COLOR: Record<string, string> = {
  City: '#ffe28a',
  Town: '#d8c79a',
  Farmstead: '#9bd07a',
  'Mining Camp': '#9aa0a8',
  'Iron Mine': '#b08160',
  'Timber Mill': '#c0824a',
  Factory: '#d0703a',
  Steelworks: '#8f9bab',
};

/**
 * Top-down strategic map: a baked elevation/water render of the whole world with the
 * rail network, cities, and live train positions over it, plus a marker for where the
 * camera is looking. Click anywhere to fly the camera there.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  onPan?: (x: number, z: number) => void;

  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement;
  private sel: Selection = null;
  private eye = new THREE.Vector3();
  private pulse = 0;

  constructor(private field: Heightfield, private network: Network) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    Object.assign(this.canvas.style, {
      position: 'fixed',
      bottom: '14px',
      right: '14px',
      width: `${SIZE}px`,
      height: `${SIZE}px`,
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.18)',
      boxShadow: '0 2px 18px rgba(0,0,0,0.4)',
      cursor: 'crosshair',
      zIndex: '10',
    } as CSSStyleDeclaration);
    this.ctx = this.canvas.getContext('2d')!;

    this.terrain = this.bakeTerrain();
    this.canvas.addEventListener('pointerdown', this.onClick);
    document.body.append(this.canvas);
  }

  setSelection(sel: Selection): void {
    this.sel = sel;
  }

  /** Bake the elevation/water raster once — it never changes. */
  private bakeTerrain(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = TERR;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(TERR, TERR);
    const sea = this.field.params.seaLevel;
    const world = this.field.params.size;
    const half = this.field.half;
    for (let py = 0; py < TERR; py++) {
      for (let px = 0; px < TERR; px++) {
        const x = (px / TERR) * world - half;
        const z = (py / TERR) * world - half;
        const h = this.field.height(x, z);
        const hE = this.field.height(x + world / TERR, z); // cheap east-facing shade
        let r: number, g: number, b: number;
        if (h < sea) {
          const d = Math.min(1, (sea - h) / 80);
          r = 30 + 20 * (1 - d);
          g = 70 + 40 * (1 - d);
          b = 110 + 60 * (1 - d);
        } else {
          const t = Math.min(1, h / 240);
          // grass → rock → snow ramp
          r = 70 + t * 150;
          g = 95 + t * 95;
          b = 60 + t * 130;
          const shade = THREE.MathUtils.clamp(1 + (h - hE) * 0.04, 0.7, 1.3);
          r *= shade;
          g *= shade;
          b *= shade;
        }
        const i = (py * TERR + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private wx(x: number): number {
    return ((x + this.field.half) / this.field.params.size) * SIZE;
  }
  private wy(z: number): number {
    return ((z + this.field.half) / this.field.params.size) * SIZE;
  }

  private onClick = (e: PointerEvent): void => {
    const r = this.canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const x = px * this.field.params.size - this.field.half;
    const z = py * this.field.params.size - this.field.half;
    this.onPan?.(x, z);
  };

  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(this.terrain, 0, 0, SIZE, SIZE);
    this.pulse += 0.12; // drives the washed-out-line flash

    // Rail lines, tinted by their owner, drawn through every stop. The selected line
    // (via clicking its track or one of its trains) is highlighted white + thicker; a
    // washed-out line flashes orange so you can spot the trouble at a glance.
    const selLineDirect = this.sel?.kind === 'line' ? this.sel.line : null;
    const selLineViaTrain = this.sel?.kind === 'train' ? this.sel.line : null;
    const flash = 0.5 + 0.5 * Math.sin(this.pulse);
    for (const l of this.network.lines) {
      const on = l === selLineDirect || l === selLineViaTrain;
      const blocked = this.network.isBlocked(l);
      if (blocked) {
        ctx.strokeStyle = `rgba(255,${Math.round(120 + 60 * flash)},60,${0.55 + 0.45 * flash})`;
        ctx.lineWidth = 3;
      } else {
        ctx.strokeStyle = on ? '#ffffff' : '#' + l.owner.color.toString(16).padStart(6, '0');
        ctx.lineWidth = on ? 3 : 1.6;
      }
      ctx.beginPath();
      l.stops.forEach((s, i) => {
        const x = this.wx(s.pos.x);
        const y = this.wy(s.pos.z);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Cities.
    const selStation = this.sel?.kind === 'station' ? this.sel.station : null;
    for (const s of this.network.stations) {
      const x = this.wx(s.pos.x);
      const y = this.wy(s.pos.z);
      if (s === selStation) {
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, 2.6 + s.stage * 0.7, 0, Math.PI * 2); // bigger dots for grown settlements
      ctx.fillStyle = ARCH_COLOR[s.archetype.kind] ?? '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Trains, tinted by owner (selected one in white).
    const selTrain = this.sel?.kind === 'train' ? this.sel.train : null;
    for (const l of this.network.lines) {
      const color = '#' + l.owner.color.toString(16).padStart(6, '0');
      for (const t of l.trains) {
        const p = t.headPosition;
        const on = t === selTrain;
        ctx.beginPath();
        ctx.arc(this.wx(p.x), this.wy(p.z), on ? 3.4 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = on ? '#ffffff' : color;
        ctx.fill();
      }
    }

    // Camera look marker + view direction.
    camera.getWorldDirection(this.eye);
    const tx = this.wx(target.x);
    const ty = this.wy(target.z);
    ctx.beginPath();
    ctx.arc(tx, ty, 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#8fffa8';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + this.eye.x * 14, ty + this.eye.z * 14);
    ctx.stroke();
  }
}
