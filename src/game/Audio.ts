/**
 * Tiny synthesized sound bus — no asset files, just oscillators through the WebAudio
 * graph. A bright two-note chime rings on each delivery; a short major arpeggio
 * confirms a line built. The context can only start after a user gesture, so unlock()
 * is wired to the first pointer interaction.
 */
export class AudioBus {
  enabled = true;
  private ctx?: AudioContext;
  private master?: GainNode;
  private lastChime = -1;

  /** Lazily create / resume the context — safe to call from a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.28;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Flip mute; returns the new state for the UI. */
  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.master) this.master.gain.value = this.enabled ? 0.28 : 0;
    return this.enabled;
  }

  /** Delivery chime — two quick ascending tones, rate-limited so a busy network
   *  doesn't machine-gun it. */
  chime(): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    if (t - this.lastChime < 0.14) return;
    this.lastChime = t;
    this.blip(880, t, 0.12, 'sine', 0.4);
    this.blip(1320, t + 0.085, 0.16, 'sine', 0.35);
  }

  /** Line-built confirmation — a short major arpeggio. */
  build(): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => this.blip(f, t + i * 0.05, 0.28, 'triangle', 0.28));
  }

  private ready(): boolean {
    return this.enabled && !!this.ctx && this.ctx.state === 'running';
  }

  /** A single enveloped oscillator note. */
  private blip(freq: number, t0: number, dur: number, type: OscillatorType, peak: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(this.master!);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }
}
