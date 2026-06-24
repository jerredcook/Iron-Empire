import { Network, GStation } from './Network';

const FIRST_DELAY = 28; // seconds before the first lot comes up
const INTERVAL = 36; // seconds between auctions

/**
 * Periodically puts an unowned city industry up for auction. The player and the rival
 * bid against each other through a modal: each player raise is met by an automatic
 * rival counter until the rival reaches its ceiling, at which point the lot can be
 * claimed. Owning an industry pays a royalty on everything it ships and adds its
 * appraised value to net worth.
 */
export class Auctioneer {
  private timer = FIRST_DELAY;
  private open = false;
  /** Fly the camera to a lot so the player can see what's on the block. */
  onView?: (at: GStation['pos']) => void;

  constructor(private network: Network) {}

  update(dt: number): void {
    if (this.open || this.network.status !== 'playing') return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = INTERVAL;
    const lots = this.network.ownableIndustries();
    if (!lots.length) return;
    this.openModal(lots[Math.floor(Math.random() * lots.length)]);
  }

  private openModal(st: GStation): void {
    this.open = true;
    const player = this.network.player;
    // The wealthiest active rival competes for the lot (none in a solo game).
    const rivals = this.network.rivals;
    const rival = rivals.length ? rivals.reduce((a, b) => (b.money > a.money ? b : a)) : null;
    const appraised = this.network.appraiseIndustry(st);
    const rivalMax = rival ? Math.min(rival.money * 0.6, appraised * 1.5) : 0;
    const inc = Math.max(10_000, Math.round((appraised * 0.12) / 1000) * 1000);
    let price = Math.round((appraised * 0.4) / 1000) * 1000;
    let leader: 'none' | 'player' | 'rival' = 'none';

    // Show what's on the block: fly the camera to the lot and keep the panel off to the side
    // (not a dead-centre modal) so the player can actually see the industry while bidding.
    this.onView?.(st.pos);

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      top: '50%',
      left: '24px',
      transform: 'translateY(-50%)',
      zIndex: '40',
      width: '320px',
      padding: '18px 20px',
      background: 'rgba(18,22,28,0.94)',
      border: '1px solid rgba(255,226,138,0.4)',
      borderRadius: '12px',
      boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
      color: '#f4f0e6',
      font: '14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif',
      pointerEvents: 'auto',
    } as CSSStyleDeclaration);
    document.body.append(panel);

    const close = (): void => {
      panel.remove();
      this.open = false;
    };

    const playerBid = (): void => {
      const bid = leader === 'none' ? price : price + inc;
      if (bid > player.money) return;
      price = bid;
      leader = 'player';
      if (rival && price + inc <= rivalMax) {
        price += inc;
        leader = 'rival';
      }
      render();
    };
    const claim = (): void => {
      if (price <= player.money) this.network.awardIndustry(st, player, price);
      close();
    };
    const pass = (): void => {
      if (rival && leader !== 'player' && rival.money >= price && rivalMax >= price) {
        this.network.awardIndustry(st, rival, price);
      }
      close();
    };

    const render = (): void => {
      const kind = st.archetype.kind;
      const nextBid = leader === 'none' ? price : price + inc;
      const canBid = nextBid <= player.money;
      const rivalName = rival ? rival.name : 'The rival';
      const status =
        leader === 'player'
          ? `<span style="color:#8fffa8">${rival ? `${rivalName} dropped out — ` : ''}it's yours to claim.</span>`
          : leader === 'rival'
            ? `<span style="color:#ff8a4d">${rivalName} bids $${price.toLocaleString()}</span>`
            : `Opening bid $${price.toLocaleString()}`;
      panel.innerHTML =
        `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;opacity:0.55;margin-bottom:4px">Industry Auction</div>` +
        `<div data-view style="font-size:19px;font-weight:700;cursor:pointer" title="Show on the map">📍 ${st.name} ${kind}</div>` +
        `<div style="font-size:12.5px;opacity:0.7;margin:4px 0 10px">Appraised $${appraised.toLocaleString()} · royalty on every shipment</div>` +
        `<div style="margin-bottom:12px">${status}</div>` +
        `<div style="display:flex;gap:8px"></div>`;
      (panel.querySelector('[data-view]') as HTMLElement | null)?.addEventListener('click', () => this.onView?.(st.pos));
      const row = panel.lastElementChild as HTMLElement;
      if (leader === 'player') {
        row.append(btn('Claim', '#8fffa8', true, claim), btn('Pass', '#f4f0e6', true, pass));
      } else {
        row.append(btn(`Bid $${nextBid.toLocaleString()}`, '#ffe28a', canBid, playerBid), btn('Pass', '#f4f0e6', true, pass));
      }
    };
    render();
  }
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
