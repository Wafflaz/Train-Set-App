// Train tracker: lagged frame difference -> largest moving blob -> centroid velocity.
// Coordinates are normalised to frame width (so speed is "frame widths per second").

export interface Tunnel { x0: number; x1: number; y0: number; y1: number; ramp: number; margin: number }

export interface Track {
  present: boolean;     // a train-sized blob is visible this frame
  hidden: boolean;      // lost near the tunnel mouth, assumed inside
  x: number; y: number; // last known centroid
  speed: number;        // smoothed, frame-widths/s (held while hidden)
  tunnel: number;       // 0..1 how far into the tunnel (drives the low-pass)
  turn: number;         // 0..1 how hard the train is curving (drives rail squeal)
  area: number;         // blob area as fraction of frame
  len: number;          // length of the whole moving group (loco + anything following it), in frame-widths
}

export class TrainTracker {
  readonly w = 128;
  readonly h = 96;
  lag = 3;
  threshold = 22;
  minArea = 14;               // pixels at w x h
  curveThr = 1.5;             // rad per frame-width where squeal starts
  hiddenTimeout = 25;         // seconds a hidden train keeps "running" before it counts as stopped
  tunnel: Tunnel = { x0: 0, x1: 0.2, y0: 0, y1: 1, ramp: 0.12, margin: 0.12 };

  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private ring: Uint8Array[] = [];
  private mask = new Uint8Array(this.w * this.h);
  private mask2 = new Uint8Array(this.w * this.h);
  private label = new Int32Array(this.w * this.h);
  private stack = new Int32Array(this.w * this.h);
  private hist: { t: number; x: number; y: number }[] = [];
  private speedS = 0;
  private head: { t: number; th: number }[] = [];
  private turnS = 0;
  private vel = { vx: 0, vy: 0 };
  private lastT = 0;
  private last = { x: 0.5, y: 0.5, t: -1e9, speed: 0 };
  diffCanvas = document.createElement('canvas');
  bbox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** union of the main blob and the moving fragments close to it: the whole train, wagons included */
  span: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private spare: Uint8Array[] = [];
  private comps: { area: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  private img?: ImageData;

  constructor() {
    this.canvas.width = this.diffCanvas.width = this.w;
    this.canvas.height = this.diffCanvas.height = this.h;
  }

  reset() {
    this.spare.push(...this.ring);
    this.ring = []; this.hist = []; this.head = []; this.turnS = 0; this.speedS = 0; this.last.t = -1e9; this.last.speed = 0;
  }

  /** distance (normalised to width) from a point to the tunnel rectangle; 0 inside */
  private tunnelDist(x: number, y: number): number {
    const t = this.tunnel;
    const dx = Math.max(t.x0 - x, 0, x - t.x1);
    const dy = Math.max(t.y0 * (this.h / this.w) - y, 0, y - t.y1 * (this.h / this.w));
    return Math.hypot(dx, dy);
  }

  process(src: CanvasImageSource, now: number): Track {
    const { w, h } = this;
    this.ctx.drawImage(src, 0, 0, w, h);
    const data = this.ctx.getImageData(0, 0, w, h).data;
    const gray = this.spare.pop() ?? new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    this.ring.push(gray);
    while (this.ring.length > this.lag + 1) this.spare.push(this.ring.shift()!);

    const dt = this.lastT ? Math.min(0.2, now - this.lastT) : 0.033;
    this.lastT = now;
    let blob: { x: number; y: number; area: number } | null = null;
    this.bbox = null;
    this.span = null;
    const dctx = this.diffCanvas.getContext('2d')!;
    const img = (this.img ??= dctx.createImageData(w, h));
    img.data.fill(0);

    if (this.ring.length > this.lag) {
      const ref = this.ring[0];
      let changed = 0;
      this.mask.fill(0);
      for (let i = 0; i < gray.length; i++) {
        if (Math.abs(gray[i] - ref[i]) > this.threshold) { this.mask[i] = 1; changed++; }
      }
      // ignore global changes (exposure shift, camera bump)
      if (changed < gray.length * 0.35) {
        // dilate 3x3 to join the fragments of one train
        this.mask2.fill(0);
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (this.mask[i] || this.mask[i - 1] || this.mask[i + 1] || this.mask[i - w] || this.mask[i + w]) this.mask2[i] = 1;
          }
        }
        blob = this.largestBlob();
        for (let i = 0; i < gray.length; i++) {
          if (this.mask2[i]) { img.data[i * 4] = 255; img.data[i * 4 + 1] = this.mask[i] ? 170 : 70; img.data[i * 4 + 3] = 200; }
        }
      }
    }
    dctx.putImageData(img, 0, 0);

    let present = false;
    let rawSpeed = 0;
    if (blob && blob.area >= this.minArea) {
      present = true;
      const x = blob.x / w;
      const y = blob.y / w; // isotropic units
      this.hist.push({ t: now, x, y });
      while (this.hist.length && now - this.hist[0].t > 0.5) this.hist.shift();
      rawSpeed = this.regressSpeed();
      if (rawSpeed > 0.04) {
        let th = Math.atan2(this.vel.vy, this.vel.vx);
        const prev = this.head[this.head.length - 1];
        if (prev) {
          while (th - prev.th > Math.PI) th -= 2 * Math.PI;
          while (th - prev.th < -Math.PI) th += 2 * Math.PI;
        }
        this.head.push({ t: now, th });
      }
      this.last = { x, y, t: now, speed: this.speedS };
    } else {
      while (this.hist.length && now - this.hist[0].t > 0.5) this.hist.shift();
      if (now - this.last.t > 0.5) this.head = [];
    }
    while (this.head.length && now - this.head[0].t > 0.9) this.head.shift();

    // quick to speed up; slow to drop while the train is still in view (an oval track looks slower end-on)
    const k = 1 - Math.exp(-dt / (rawSpeed > this.speedS ? 0.15 : 1.0));
    let hidden = false;
    let speedOut: number;
    const sinceSeen = now - this.last.t;
    if (present) {
      this.speedS += (rawSpeed - this.speedS) * k;
      speedOut = this.speedS;
    } else if (sinceSeen < this.hiddenTimeout && this.tunnelDist(this.last.x, this.last.y) < this.tunnel.margin) {
      hidden = true; // vanished at the tunnel mouth: still running, out of sight
      const decay = Math.max(0.7, 1 - (sinceSeen / 30) * 0.3);
      this.speedS = this.last.speed * decay;
      speedOut = this.speedS;
    } else {
      this.speedS += (0 - this.speedS) * (1 - Math.exp(-dt / 0.25));
      speedOut = this.speedS;
    }

    // curvature = heading change per distance travelled; straight track gives ~0
    let turnTarget = 0;
    if (present && this.head.length >= 8 && this.head[this.head.length - 1].t - this.head[0].t > 0.45) {
      const n = this.head.length, t0 = this.head[0].t;
      let st = 0, sy = 0, stt = 0, sty = 0;
      for (const p of this.head) { const t = p.t - t0; st += t; sy += p.th; stt += t * t; sty += t * p.th; }
      const den = n * stt - st * st;
      const slope = Math.abs(den) < 1e-9 ? 0 : (n * sty - st * sy) / den;
      const curv = Math.abs(slope) / Math.max(this.speedS, 0.08);
      turnTarget = Math.max(0, Math.min(1, (curv - this.curveThr) / (this.curveThr * 1.5)));
    }
    this.turnS += (turnTarget - this.turnS) * (1 - Math.exp(-dt / (turnTarget > this.turnS ? 0.35 : 0.6)));

    const dist = this.tunnelDist(this.last.x, this.last.y);
    const tunnelAmt = hidden ? 1 : present || sinceSeen < 0.6 ? Math.max(0, Math.min(1, 1 - dist / this.tunnel.ramp)) : 0;
    const sp = this.span as TrainTracker['span']; // set inside largestBlob(), which the compiler cannot see through
    const len = present && sp ? Math.hypot(sp.x1 - sp.x0 + 1, sp.y1 - sp.y0 + 1) / w : 0;
    return { present, hidden, x: this.last.x, y: this.last.y, speed: speedOut, tunnel: tunnelAmt, turn: this.turnS, area: blob ? blob.area / (w * h) : 0, len };
  }

  private regressSpeed(): number {
    const n = this.hist.length;
    if (n < 3) return n === 2 ? 0 : this.speedS;
    const t0 = this.hist[0].t;
    if (this.hist[n - 1].t - t0 < 0.12) return this.speedS;
    let st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
    for (const p of this.hist) {
      const t = p.t - t0;
      st += t; sx += p.x; sy += p.y; stt += t * t; stx += t * p.x; sty += t * p.y;
    }
    const den = n * stt - st * st;
    if (Math.abs(den) < 1e-9) return 0;
    const vx = (n * stx - st * sx) / den;
    const vy = (n * sty - st * sy) / den;
    this.vel = { vx, vy };
    return Math.hypot(vx, vy);
  }

  /** flood-fill the dilated mask, return the largest component's centroid (pixels) */
  private largestBlob(): { x: number; y: number; area: number } | null {
    const { w, h } = this;
    this.label.fill(0);
    this.comps.length = 0;
    let best: { x: number; y: number; area: number } | null = null;
    let bestIdx = -1;
    let id = 0;
    for (let s = 0; s < w * h; s++) {
      if (!this.mask2[s] || this.label[s]) continue;
      id++;
      let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      this.stack[sp++] = s;
      this.label[s] = id;
      while (sp) {
        const i = this.stack[--sp];
        const x = i % w, y = (i / w) | 0;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && this.mask2[i - 1] && !this.label[i - 1]) { this.label[i - 1] = id; this.stack[sp++] = i - 1; }
        if (x < w - 1 && this.mask2[i + 1] && !this.label[i + 1]) { this.label[i + 1] = id; this.stack[sp++] = i + 1; }
        if (y > 0 && this.mask2[i - w] && !this.label[i - w]) { this.label[i - w] = id; this.stack[sp++] = i - w; }
        if (y < h - 1 && this.mask2[i + w] && !this.label[i + w]) { this.label[i + w] = id; this.stack[sp++] = i + w; }
      }
      if (this.comps.length < 64) this.comps.push({ area, x0, y0, x1, y1 });
      if (!best || area > best.area) {
        best = { x: sx / area, y: sy / area, area };
        this.bbox = { x0, y0, x1, y1 };
        bestIdx = this.comps.length - 1;
      }
    }
    if (best && bestIdx >= 0) {
      // frame differencing lights up a long train as separate pieces (leading edge, trailing edge, detail):
      // gather the pieces near the main blob to measure the train's whole length
      const u = { ...this.comps[bestIdx] };
      const link = 0.26 * w;
      const minPiece = Math.max(3, this.minArea * 0.2);
      for (let pass = 0; pass < 2; pass++) {
        for (const c of this.comps) {
          if (c.area < minPiece) continue;
          const gx = Math.max(c.x0 - u.x1, u.x0 - c.x1, 0);
          const gy = Math.max(c.y0 - u.y1, u.y0 - c.y1, 0);
          if (Math.hypot(gx, gy) <= link) {
            u.x0 = Math.min(u.x0, c.x0); u.y0 = Math.min(u.y0, c.y0);
            u.x1 = Math.max(u.x1, c.x1); u.y1 = Math.max(u.y1, c.y1);
          }
        }
      }
      this.span = u;
    }
    return best;
  }
}
