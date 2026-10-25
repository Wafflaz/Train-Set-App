// Offline sample analysis and slicing helpers (all pure, operate on decoded AudioBuffers).

export function mono(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.length);
  const n = buf.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / n;
  }
  return out;
}

export function envelope(x: Float32Array, sr: number, hopSec: number): Float32Array {
  const hop = Math.max(1, Math.round(sr * hopSec));
  const n = Math.floor(x.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < hop; j++) {
      const v = x[i * hop + j];
      s += v * v;
    }
    env[i] = Math.sqrt(s / hop);
  }
  return env;
}

/** Audible part of a sample (drops leading/trailing near-silence). Seconds. */
export function activeRegion(buf: AudioBuffer, db = -30): { a: number; b: number } {
  const hopSec = 0.01;
  const env = envelope(mono(buf), buf.sampleRate, hopSec);
  const peak = Math.max(...env);
  const sorted = Array.from(env).sort((p, q) => p - q);
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const thr = Math.max(peak * Math.pow(10, db / 20), floor * 3);
  let first = 0;
  let last = env.length - 1;
  while (first < env.length && env[first] < thr) first++;
  while (last > first && env[last] < thr) last--;
  return { a: Math.max(0, first * hopSec - 0.01), b: Math.min(buf.duration, (last + 1) * hopSec + 0.02) };
}

/** Steadiest loud stretch inside the active region, as fractions 0..1. Prefers the longest steady window. */
export function autoLoop(buf: AudioBuffer, region: { a: number; b: number }): { start: number; end: number } {
  const hopSec = 0.01;
  const env = envelope(mono(buf), buf.sampleRate, hopSec);
  const i0 = Math.floor(region.a / hopSec);
  const i1 = Math.min(env.length, Math.ceil(region.b / hopSec));
  const len = i1 - i0;
  let peak = 0;
  for (let i = i0; i < i1; i++) peak = Math.max(peak, env[i]);
  const tailRoom = Math.max(4, Math.round(Math.min(0.25, len * hopSec * 0.2) / hopSec));
  const skip = len > 90 ? 30 : 2;
  // longest window that is loud enough and steady enough; shorter ones only if nothing longer qualifies
  let pick = { s: i0 + skip, w: 12, cv: Infinity };
  let pickScore = Infinity;
  outer: for (const wSec of [1.2, 0.9, 0.65, 0.45, 0.3, 0.2, 0.12]) {
    const w = Math.round(wSec / hopSec);
    if (w > len * 0.7 && wSec > 0.12) continue;
    let best = { s: i0 + skip, w, cv: Infinity };
    for (let s = i0 + skip; s + w + tailRoom <= i1; s++) {
      let sum = 0;
      for (let k = 0; k < w; k++) sum += env[s + k];
      const mean = sum / w;
      if (mean < 0.35 * peak) continue;
      let v = 0;
      for (let k = 0; k < w; k++) v += (env[s + k] - mean) ** 2;
      const cv = Math.sqrt(v / w) / (mean + 1e-9);
      if (cv < best.cv) best = { s, w, cv };
    }
    if (best.cv <= 0.2) { pick = best; break outer; }
    const sc = best.cv - 0.3 * wSec;
    if (sc < pickScore) { pickScore = sc; pick = best; }
  }
  const span = region.b - region.a;
  return { start: (pick.s * hopSec - region.a) / span, end: ((pick.s + pick.w) * hopSec - region.a) / span };
}

/** First upward zero crossing near startSec (sample index). */
export function snapStart(x: Float32Array, sr: number, startSec: number): number {
  const upZero = (i: number) => i > 0 && x[i - 1] <= 0 && x[i] > 0;
  let ls = Math.round(startSec * sr);
  const win = Math.round(0.01 * sr);
  for (let d = 0; d <= win; d++) {
    if (upZero(ls + d)) return ls + d;
    if (upZero(ls - d)) return ls - d;
  }
  return ls;
}

/** Crossfaded loop for noisy ambience: orig[ls, le) with its end folded into its start. */
export function crossLoop(buf: AudioBuffer, ls: number, le: number, xf: number): AudioBuffer {
  xf = Math.min(xf, Math.floor((le - ls) / 2));
  const M = le - ls - xf;
  const out = new AudioBuffer({ length: M, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < M; i++) dst[i] = src[ls + i];
    for (let i = 0; i < xf; i++) {
      const t = (i + 1) / (xf + 1);
      dst[i] = src[ls + i] * Math.sin((t * Math.PI) / 2) + src[ls + M + i] * Math.cos((t * Math.PI) / 2);
    }
  }
  return out;
}

export function sliceBuffer(buf: AudioBuffer, startSec: number, lenSec: number, fadeIn: number, fadeOut: number): AudioBuffer {
  const sr = buf.sampleRate;
  const s = Math.max(0, Math.round(startSec * sr));
  const n = Math.min(Math.round(lenSec * sr), buf.length - s);
  const out = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  const fi = Math.round(fadeIn * sr);
  const fo = Math.round(fadeOut * sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let g = 1;
      if (i < fi) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
      if (i > n - fo) g *= 0.5 + 0.5 * Math.cos((Math.PI * (i - (n - fo))) / fo);
      dst[i] = src[s + i] * g;
    }
  }
  return out;
}

export function rms(buf: AudioBuffer): number {
  const x = mono(buf);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

export function scaleBuffer(buf: AudioBuffer, g: number) {
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}

/** Times (seconds) of exhaust beats in [from,to]; onset = where the rise begins. */
export function detectChuffs(buf: AudioBuffer, from: number, to: number, minGap = 0.2): number[] {
  const hop = 0.005;
  const sm = (() => {
    const e = envelope(mono(buf), buf.sampleRate, hop);
    const o = new Float32Array(e.length);
    for (let i = 0; i < e.length; i++) {
      let s = 0, n = 0;
      for (let k = -2; k <= 2; k++) if (e[i + k] !== undefined) { s += e[i + k]; n++; }
      o[i] = s / n;
    }
    return o;
  })();
  const i0 = Math.floor(from / hop);
  const i1 = Math.min(sm.length - 1, Math.floor(to / hop));
  let mx = 0;
  for (let i = i0; i <= i1; i++) mx = Math.max(mx, sm[i]);
  const gap = Math.round(minGap / hop);
  const peaks: number[] = [];
  for (let i = i0 + 1; i < i1; i++) {
    if (sm[i] < mx * 0.25 || sm[i] < sm[i - 1] || sm[i] <= sm[i + 1]) continue;
    let isMax = true;
    for (let k = -gap; k <= gap && isMax; k++) if (sm[i + k] !== undefined && sm[i + k] > sm[i]) isMax = false;
    if (isMax) peaks.push(i);
  }
  return peaks.map((p) => {
    let i = p;
    while (i > p - 10 && sm[i - 1] !== undefined && sm[i - 1] > sm[p] * 0.4) i--;
    return i * hop;
  });
}

/** Max step across the loop wrap relative to the typical step inside the loop (1 = seamless). */
export function seamRatio(loop: AudioBuffer): number {
  const d = loop.getChannelData(0);
  let sum = 0;
  for (let i = 1; i < d.length; i++) sum += Math.abs(d[i] - d[i - 1]);
  const avg = sum / (d.length - 1);
  return Math.abs(d[0] - d[d.length - 1]) / (avg + 1e-9);
}
