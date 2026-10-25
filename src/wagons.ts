import type { Track } from './motion';

const GX = 6;
const GY = 4;
const MOVING = 0.03; // frame-widths/s: only measure length while the train is clearly moving

/**
 * Counts the wagons behind the locomotive by length. The tracker measures how long the moving group is;
 * learning a lap with the loco on its own records its length at each place on the layout (perspective makes
 * the same train look longer near the camera). Later laps are compared with that: twice as long = one wagon.
 */
export class WagonEstimator {
  private base = new Float32Array(GX * GY);
  private cnt = new Uint16Array(GX * GY);
  private win: { t: number; r: number }[] = [];
  private est = 1;
  learning = false;
  count = 0;       // wagons currently believed to be behind the loco
  ratio = 1;       // smoothed length / loco-alone length

  get samples(): number { let n = 0; for (const c of this.cnt) n += c; return n; }
  get calibrated(): boolean { return this.samples >= 40; }

  private cell(x: number, y: number): number {
    const gx = Math.max(0, Math.min(GX - 1, Math.floor(x * GX)));
    const gy = Math.max(0, Math.min(GY - 1, Math.floor((y / 0.75) * GY)));
    return gy * GX + gx;
  }

  private baseAt(x: number, y: number): number {
    const c = this.cell(x, y);
    if (this.cnt[c] >= 3) return this.base[c];
    let s = 0, n = 0;
    for (let i = 0; i < this.base.length; i++) { s += this.base[i] * this.cnt[i]; n += this.cnt[i]; }
    return n ? s / n : 0;
  }

  /** start (true) or finish (false) a lap with the loco alone */
  learn(on: boolean) {
    if (on) { this.base.fill(0); this.cnt.fill(0); this.win = []; this.count = 0; this.est = 1; }
    this.learning = on;
  }

  reset() { this.win = []; this.est = 1; this.ratio = 1; this.count = 0; }

  update(t: Track, now: number, perWagon: number): number {
    if (!t.present || t.speed < MOVING || t.len <= 0) return this.count;
    if (this.learning) {
      const c = this.cell(t.x, t.y);
      const n = Math.min(this.cnt[c], 60);
      this.base[c] = (this.base[c] * n + t.len) / (n + 1);
      this.cnt[c] = Math.min(65000, this.cnt[c] + 1);
      return 0;
    }
    if (!this.calibrated) return this.count;
    const b = this.baseAt(t.x, t.y);
    if (b <= 0) return this.count;
    this.win.push({ t: now, r: t.len / b });
    while (this.win.length && now - this.win[0].t > 2.5) this.win.shift();
    if (this.win.length >= 5) {
      const rs = this.win.map((w) => w.r).sort((p, q) => p - q);
      const med = rs[Math.floor(rs.length / 2)];
      this.est += (med - this.est) * 0.12;
      this.ratio = this.est;
      const wagons = (this.est - 1) / Math.max(0.2, perWagon);
      // hysteresis: only change the count when the estimate is clearly past the halfway point
      if (Math.abs(wagons - this.count) > 0.62) this.count = Math.max(0, Math.min(8, Math.round(wagons)));
    }
    return this.count;
  }

  toJSON() { return { base: Array.from(this.base), cnt: Array.from(this.cnt) }; }
  fromJSON(j: { base?: number[]; cnt?: number[] } | undefined) {
    if (!j?.base || !j.cnt || j.base.length !== this.base.length) return;
    this.base.set(j.base);
    this.cnt.set(j.cnt);
  }
}
