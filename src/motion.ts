// Multi-train tracker. Lagged frame difference -> cleaned-up moving blobs -> blobs that look like a train
// (size, shape, away from ignore zones, moving smoothly) -> a few persistent targets, each with a speed, a heading,
// a position that is projected ahead to make up for the delay in the video link, and a "still running, just out of
// sight" state for when a house, prop or tunnel hides it.
// Coordinates: x is a fraction of the frame width, y is measured in frame widths too (so distances are isotropic).

export interface Zone { x0: number; x1: number; y0: number; y1: number }   // fractions of width / height

export interface Track {
  id: number;
  present: boolean;     // seen in this frame
  hidden: boolean;      // not seen, but assumed to be still running (behind a prop or in a tunnel)
  x: number; y: number; // last known centroid
  speed: number;        // smoothed, frame-widths/s (held while hidden)
  tunnel: number;       // 0..1 how far into a tunnel, judged at the position the train is about to be in
  turn: number;         // 0..1 how hard the train is curving (drives rail squeal)
  area: number;         // blob area as a fraction of the frame
  len: number;          // length of the whole moving group (loco + anything following it), in frame-widths
}

interface Comp { x: number; y: number; area: number; x0: number; y0: number; x1: number; y1: number; len: number; cx: number; cy: number }
interface Cand { x: number; y: number; t: number; t0: number; n: number; x0: number; y0: number }

class Target {
  hist: { t: number; x: number; y: number }[] = [];
  head: { t: number; th: number }[] = [];
  speedLog: { t: number; v: number }[] = [];
  speedS = 0;
  turnS = 0;
  vx = 0; vy = 0;
  last = { x: 0.5, y: 0.375, t: -1e9, speed: 0, area: 0, len: 0 };
  present = false;
  hidden = false;
  tunnel = 0;
  comp: Comp | null = null;
  constructor(public id: number) {}
}

export class TrainTracker {
  readonly w = 256;
  h = 192;
  aspect = 0.75;
  lagSec = 0.1;
  threshold = 24;
  minArea = 22;               // pixels at w x h
  maxFrac = 0.04;             // a train-shaped blob is smaller than this share of the frame (people are bigger)
  curveThr = 1.5;             // rad per frame-width where squeal starts
  lead = 0.3;                 // seconds the video lags behind the real train: positions are projected this far ahead
  holdTime = 4;               // seconds a train hidden by a prop keeps running before it counts as stopped
  hiddenTimeout = 25;         // seconds a train hidden at a tunnel mouth keeps running
  maxTargets = 2;
  stopSpeed = 0.025;
  tunnels: Zone[] = [{ x0: 0, x1: 0.2, y0: 0, y1: 1 }];
  ignore: Zone[] = [];
  ramp = 0.12;
  margin = 0.12;

  targets: Target[] = [];
  comps: Comp[] = [];         // for the on-screen overlay
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private ring: { t: number; g: Uint8Array }[] = [];
  private spare: Uint8Array[] = [];
  private mask = new Uint8Array(0);
  private mask2 = new Uint8Array(0);
  private label = new Int32Array(0);
  private stack = new Int32Array(0);
  private cands: Cand[] = [];
  private nextId = 1;
  private lastT = 0;
  diffCanvas = document.createElement('canvas');
  private img?: ImageData;

  /** Where trains run, learned by watching them: motion anywhere else (a person, a hand) is not a train. */
  readonly CW = 64;
  heat = new Float32Array(0);
  corridor: Uint8Array | null = null;
  learning = false;
  get CH() { return Math.max(8, Math.round(this.CW * this.aspect)); }

  private inCorridor(fx: number, fy: number): boolean {
    const cx = Math.max(0, Math.min(this.CW - 1, Math.floor(fx * this.CW)));
    const cy = Math.max(0, Math.min(this.CH - 1, Math.floor((fy / this.aspect) * this.CH)));
    return this.corridor![cy * this.CW + cx] === 1;
  }

  learnTrack(on: boolean) {
    if (on) { this.heat = new Float32Array(this.CW * this.CH); this.corridor = null; }
    else if (this.learning) this.buildCorridor();
    this.learning = on;
  }

  clearTrack() { this.corridor = null; this.heat = new Float32Array(0); this.learning = false; }

  private buildCorridor() {
    const { CW, CH } = this;
    if (this.heat.length !== CW * CH) return;
    const base = new Uint8Array(CW * CH);
    let n = 0;
    for (let i = 0; i < base.length; i++) if (this.heat[i] >= 2) { base[i] = 1; n++; }
    if (n < 12) { this.corridor = null; return; }   // not enough laps seen: keep using the plain rules
    const out = new Uint8Array(CW * CH);
    const R = 2;                                     // generous: the train is wider than its centre line
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      if (!base[y * CW + x]) continue;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < CH && xx >= 0 && xx < CW) out[yy * CW + xx] = 1;
      }
    }
    this.corridor = out;
  }

  trackJSON() { return this.corridor ? { aspect: this.aspect, cells: Array.from(this.corridor) } : null; }
  loadTrack(j: { aspect?: number; cells?: number[] } | null | undefined) {
    if (!j?.cells || !j.aspect) return;
    this.setAspect(j.aspect);
    if (j.cells.length === this.CW * this.CH) this.corridor = Uint8Array.from(j.cells);
  }

  constructor() { this.setAspect(0.75); }

  private setAspect(a: number) {
    this.aspect = a;
    this.h = Math.max(16, Math.round(this.w * a));
    const n = this.w * this.h;
    this.canvas.width = this.diffCanvas.width = this.w;
    this.canvas.height = this.diffCanvas.height = this.h;
    this.mask = new Uint8Array(n); this.mask2 = new Uint8Array(n);
    this.label = new Int32Array(n); this.stack = new Int32Array(n);
    this.ring = []; this.spare = [];
    this.img = undefined;
  }

  reset() {
    this.ring = []; this.targets = []; this.cands = []; this.comps = []; this.lastT = 0;
  }

  /** distance (frame widths) from a point to the nearest tunnel zone; 0 inside */
  tunnelDist(x: number, y: number): number {
    let best = Infinity;
    for (const t of this.tunnels) {
      const dx = Math.max(t.x0 - x, 0, x - t.x1);
      const dy = Math.max(t.y0 * this.aspect - y, 0, y - t.y1 * this.aspect);
      best = Math.min(best, Math.hypot(dx, dy));
    }
    return best;
  }

  private tunnelAt(x: number, y: number): number {
    return Math.max(0, Math.min(1, 1 - this.tunnelDist(x, y) / this.ramp));
  }

  process(src: CanvasImageSource, now: number): Track[] {
    const sw = (src as HTMLVideoElement).videoWidth || (src as HTMLCanvasElement).width || 4;
    const sh = (src as HTMLVideoElement).videoHeight || (src as HTMLCanvasElement).height || 3;
    const asp = Math.max(0.3, Math.min(1.5, sh / sw));
    if (Math.abs(asp - this.aspect) > 0.02) this.setAspect(asp);
    const { w, h } = this;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(src, 0, 0, w, h);
    const data = this.ctx.getImageData(0, 0, w, h).data;
    const gray = this.spare.pop() ?? new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    this.ring.push({ t: now, g: gray });
    while (this.ring.length > 2 && now - this.ring[1].t >= this.lagSec) this.spare.push(this.ring.shift()!.g);
    while (this.ring.length > 12) this.spare.push(this.ring.shift()!.g);

    const dt = this.lastT ? Math.min(0.2, Math.max(0.001, now - this.lastT)) : 0.033;
    this.lastT = now;
    this.comps = [];
    this.diffInto(gray);

    if (this.ring.length > 1 && this.maskOk) this.findComps();
    this.associate(now, dt);
    this.birth(now);
    if (this.learning) {
      if (this.heat.length !== this.CW * this.CH) this.heat = new Float32Array(this.CW * this.CH);
      for (const t of this.targets) {
        if (!t.present || t.speedS < 0.06) continue;
        const cx = Math.max(0, Math.min(this.CW - 1, Math.floor(t.last.x * this.CW)));
        const cy = Math.max(0, Math.min(this.CH - 1, Math.floor((t.last.y / this.aspect) * this.CH)));
        this.heat[cy * this.CW + cx] += 1;
      }
    }
    return this.targets.map((t) => this.outTrack(t, now));
  }

  private maskOk = false;

  /** |frame - frame a moment ago| above threshold, cleaned of speckle, fragments joined */
  private diffInto(gray: Uint8Array) {
    const { w, h } = this;
    const dctx = this.diffCanvas.getContext('2d')!;
    const img = (this.img ??= dctx.createImageData(w, h));
    img.data.fill(0);
    this.maskOk = false;
    if (this.ring.length > 1) {
      const ref = this.ring[0].g;
      let changed = 0;
      this.mask.fill(0);
      for (let i = 0; i < gray.length; i++) {
        if (Math.abs(gray[i] - ref[i]) > this.threshold) { this.mask[i] = 1; changed++; }
      }
      // a bump of the camera or an exposure shift changes everything: skip such frames
      if (changed < gray.length * 0.25) {
        for (const z of this.ignore) {
          const x0 = Math.max(0, Math.floor(z.x0 * w)), x1 = Math.min(w - 1, Math.ceil(z.x1 * w));
          const y0 = Math.max(0, Math.floor(z.y0 * h)), y1 = Math.min(h - 1, Math.ceil(z.y1 * h));
          for (let y = y0; y <= y1; y++) this.mask.fill(0, y * w + x0, y * w + x1 + 1);
        }
        // open: drop specks and thin edges (sensor noise, shimmer on the textured scenery) ...
        this.shrink(this.mask, this.mask2);
        this.grow(this.mask2, this.mask);
        // ... then close up the gaps inside one train
        this.grow(this.mask, this.mask2);
        this.grow(this.mask2, this.mask);
        this.maskOk = true;
        for (let i = 0; i < gray.length; i++) {
          if (this.mask[i]) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 170; img.data[i * 4 + 3] = 200; }
        }
      }
    }
    dctx.putImageData(img, 0, 0);
  }

  private shrink(a: Uint8Array, b: Uint8Array) {
    const { w, h } = this;
    b.fill(0);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (a[i] && a[i - 1] && a[i + 1] && a[i - w] && a[i + w]) b[i] = 1;
      }
    }
  }

  private grow(a: Uint8Array, b: Uint8Array) {
    const { w, h } = this;
    b.fill(0);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (a[i] || a[i - 1] || a[i + 1] || a[i - w] || a[i + w]) b[i] = 1;
      }
    }
  }

  /** connected blobs of the mask; keeps the ones that look like a train */
  private findComps() {
    const { w, h } = this;
    const all: Comp[] = [];
    this.label.fill(0);
    let id = 0;
    for (let s = 0; s < w * h; s++) {
      if (!this.mask[s] || this.label[s]) continue;
      id++;
      let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      this.stack[sp++] = s;
      this.label[s] = id;
      while (sp) {
        const i = this.stack[--sp];
        const x = i % w, y = (i / w) | 0;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && this.mask[i - 1] && !this.label[i - 1]) { this.label[i - 1] = id; this.stack[sp++] = i - 1; }
        if (x < w - 1 && this.mask[i + 1] && !this.label[i + 1]) { this.label[i + 1] = id; this.stack[sp++] = i + 1; }
        if (y > 0 && this.mask[i - w] && !this.label[i - w]) { this.label[i - w] = id; this.stack[sp++] = i - w; }
        if (y < h - 1 && this.mask[i + w] && !this.label[i + w]) { this.label[i + w] = id; this.stack[sp++] = i + w; }
      }
      if (all.length < 80) all.push({ x: sx / area, y: sy / area, area, x0, y0, x1, y1, len: 0, cx: sx / area, cy: sy / area });
    }
    const maxArea = this.maxFrac * w * h;
    for (const c of all) {
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      if (c.area < this.minArea || c.area > maxArea) continue;      // too small = speck, too big = a person or a hand
      if (Math.max(bw, bh) > 0.3 * w) continue;                      // a train is not longer than that
      if (c.area / (bw * bh) < 0.2) continue;                        // thin, ragged outlines: arms, not a rigid train
      // the whole moving group: this blob plus the fragments close to it (a long train lights up in pieces)
      const link = 0.14 * w;
      const u = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
      for (const o of all) {
        if (o === c || o.area < 4 || o.area > maxArea) continue;
        const gx = Math.max(o.x0 - u.x1, u.x0 - o.x1, 0), gy = Math.max(o.y0 - u.y1, u.y0 - o.y1, 0);
        if (Math.hypot(gx, gy) <= link) { u.x0 = Math.min(u.x0, o.x0); u.y0 = Math.min(u.y0, o.y0); u.x1 = Math.max(u.x1, o.x1); u.y1 = Math.max(u.y1, o.y1); }
      }
      c.len = Math.hypot(u.x1 - u.x0 + 1, u.y1 - u.y0 + 1) / w;
      c.cx = (u.x0 + u.x1) / 2; c.cy = (u.y0 + u.y1) / 2;   // centre of the whole group: steadier than the centre of one fragment
      if (this.corridor && !this.inCorridor(c.cx / w, c.cy / w)) continue;
      this.comps.push(c);
    }
    this.comps.sort((p, q) => q.area - p.area);
    if (this.comps.length > 12) this.comps.length = 12;
  }

  /** hand each known train the blob nearest to where it should be; the rest are candidates for new trains */
  private associate(now: number, dt: number) {
    const w = this.w;
    const free = new Set(this.comps);
    for (const t of this.targets) {
      t.present = false; t.comp = null;
      const since = now - t.last.t;
      const px = t.last.x + (t.speedS > this.stopSpeed ? t.vx * Math.min(since, 1) : 0);
      const py = t.last.y + (t.speedS > this.stopSpeed ? t.vy * Math.min(since, 1) : 0);
      // a train that has been out of sight may come back a long way along the track: the longer it was away, the wider the net
      const gate = Math.min(0.5, 0.09 + (since < 0.3 ? 0.5 : 0.9) * Math.max(t.speedS, t.last.speed) * Math.min(since, 4) + (since > 1 ? 0.06 : 0));
      let best: Comp | null = null, bd = Infinity;
      for (const c of free) {
        const d = Math.hypot(c.cx / w - px, c.cy / w - py);
        if (d < gate && d < bd) { bd = d; best = c; }
      }
      if (best) { free.delete(best); t.comp = best; }
    }
    this.leftover = [...free];
    for (const t of this.targets) this.updateTarget(t, now, dt);
  }

  private leftover: Comp[] = [];

  private updateTarget(t: Target, now: number, dt: number) {
    const w = this.w;
    const c = t.comp;
    let raw = 0;
    if (c) {
      t.present = true;
      const x = c.cx / w, y = c.cy / w;
      t.hist.push({ t: now, x, y });
      while (t.hist.length && now - t.hist[0].t > 0.4) t.hist.shift();
      raw = this.regress(t);
      if (raw > 0.04) {
        let th = Math.atan2(t.vy, t.vx);
        const prev = t.head[t.head.length - 1];
        if (prev) {
          while (th - prev.th > Math.PI) th -= 2 * Math.PI;
          while (th - prev.th < -Math.PI) th += 2 * Math.PI;
        }
        t.head.push({ t: now, th });
      }
      t.last = { x, y, t: now, speed: t.speedS, area: c.area / (w * this.h), len: c.len };
    } else {
      while (t.hist.length && now - t.hist[0].t > 0.4) t.hist.shift();
      if (now - t.last.t > 0.5) t.head = [];
    }
    while (t.head.length && now - t.head[0].t > 0.9) t.head.shift();

    // quick to speed up; slow to drop while the train is still in view (an oval track looks slower end-on)
    const k = 1 - Math.exp(-dt / (raw > t.speedS ? 0.1 : 0.8));
    const since = now - t.last.t;
    t.hidden = false;
    if (t.present) {
      t.speedS += (raw - t.speedS) * k;
    } else {
      // a train that vanishes while still going at speed (not slowing down first) is behind a prop or in a tunnel
      const recent = t.speedLog.filter((s) => now - s.t < 1.6);
      const peak = recent.reduce((m, s) => Math.max(m, s.v), 0);
      const slowing = recent.length > 4 && t.last.speed < 0.6 * peak;
      const nearTunnel = this.tunnelDist(t.last.x, t.last.y) < this.margin;
      const limit = nearTunnel ? this.hiddenTimeout : this.holdTime;
      if (t.last.speed > this.stopSpeed * 2.5 && !slowing && since < limit) {
        t.hidden = true;
        t.speedS = t.last.speed * Math.max(0.75, 1 - (since / limit) * 0.25);
      } else {
        t.speedS += (0 - t.speedS) * (1 - Math.exp(-dt / 0.25));
      }
    }
    if (t.present) { t.speedLog.push({ t: now, v: t.speedS }); while (t.speedLog.length && now - t.speedLog[0].t > 2) t.speedLog.shift(); }

    // curvature = heading change per distance travelled; straight track gives ~0
    let turnTarget = 0;
    if (t.present && t.head.length >= 6 && t.head[t.head.length - 1].t - t.head[0].t > 0.4) {
      const n = t.head.length, t0 = t.head[0].t;
      let st = 0, sy = 0, stt = 0, sty = 0;
      for (const p of t.head) { const tt = p.t - t0; st += tt; sy += p.th; stt += tt * tt; sty += tt * p.th; }
      const den = n * stt - st * st;
      const slope = Math.abs(den) < 1e-9 ? 0 : (n * sty - st * sy) / den;
      const curv = Math.abs(slope) / Math.max(t.speedS, 0.08);
      turnTarget = Math.max(0, Math.min(1, (curv - this.curveThr) / (this.curveThr * 1.5)));
    }
    t.turnS += (turnTarget - t.turnS) * (1 - Math.exp(-dt / (turnTarget > t.turnS ? 0.35 : 0.6)));

    // tunnel muffle: judged where the train will be by the time this sound is heard (the video is late)
    const run = t.speedS > this.stopSpeed ? this.lead : 0;
    const ax = t.last.x + t.vx * run, ay = t.last.y + t.vy * run;
    t.tunnel = t.hidden
      ? (this.tunnelDist(t.last.x, t.last.y) < this.margin ? 1 : t.tunnel)
      : since < 0.6 ? this.tunnelAt(ax, ay) : this.tunnelAt(t.last.x, t.last.y);
  }

  /** velocity from a straight-line fit of the recent positions; returns speed */
  private regress(t: Target): number {
    const n = t.hist.length;
    if (n < 3) return t.speedS;
    const t0 = t.hist[0].t;
    if (t.hist[n - 1].t - t0 < 0.1) return t.speedS;
    let st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
    for (const p of t.hist) {
      const tt = p.t - t0;
      st += tt; sx += p.x; sy += p.y; stt += tt * tt; stx += tt * p.x; sty += tt * p.y;
    }
    const den = n * stt - st * st;
    if (Math.abs(den) < 1e-9) return 0;
    t.vx = (n * stx - st * sx) / den;
    t.vy = (n * sty - st * sy) / den;
    return Math.hypot(t.vx, t.vy);
  }

  /** a blob nobody owns becomes a new train once it has moved like one for half a second */
  private birth(now: number) {
    const w = this.w;
    const next: Cand[] = [];
    for (const c of this.leftover) {
      const x = c.cx / w, y = c.cy / w;
      let m = this.cands.find((q) => now - q.t < 0.5 && Math.hypot(q.x - x, q.y - y) < 0.07);
      if (m) {
        this.cands.splice(this.cands.indexOf(m), 1);
        m = { x, y, t: now, t0: m.t0, n: m.n + 1, x0: m.x0, y0: m.y0 };
      } else m = { x, y, t: now, t0: now, n: 1, x0: x, y0: y };
      next.push(m);
      const moved = Math.hypot(x - m.x0, y - m.y0);
      if (m.n >= 6 && now - m.t0 >= 0.45 && moved > 0.05 && moved / (now - m.t0) < 2) {
        // a piece of a train we already follow (loco and wagons light up separately) is not a new train
        const nearKnown = this.targets.some((o) => now - o.last.t < 2 && Math.hypot(o.last.x - x, o.last.y - y) < 0.22);
        if (nearKnown) continue;
        let slot = -1;
        if (this.targets.length < this.maxTargets) slot = this.targets.length;
        else {
          // all slots taken: take over the one that has been out of sight longest, if it is long gone (a train that stopped somewhere)
          let stale = 5;
          this.targets.forEach((o, i) => { if (!o.hidden && now - o.last.t > stale) { stale = now - o.last.t; slot = i; } });
        }
        if (slot >= 0) {
          const t = new Target(this.nextId++);
          t.last = { x, y, t: now, speed: 0, area: c.area / (w * this.h), len: c.len };
          t.present = true;
          this.targets[slot] = t;
          next.pop();
        }
      }
    }
    this.cands = next;
  }

  private outTrack(t: Target, now: number): Track {
    return {
      id: t.id, present: t.present, hidden: t.hidden, x: t.last.x, y: t.last.y, speed: t.speedS,
      tunnel: t.tunnel, turn: t.turnS, area: t.last.area, len: t.present ? t.last.len : 0,
    };
  }
}
