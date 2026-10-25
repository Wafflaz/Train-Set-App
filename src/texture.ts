import { mono } from './dsp';

export const DEC = 4;

export interface Decimated { xd: Float32Array; pre: Float64Array }

/** 4x decimated mono plus a running sum of squares, for fast normalised cross-correlation. */
export function decimate(x: Float32Array): Decimated {
  const n = Math.floor(x.length / DEC);
  const xd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < DEC; k++) s += x[i * DEC + k];
    xd[i] = s / DEC;
  }
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + xd[i] * xd[i];
  return { xd, pre };
}

/** NCC of tgt (decimated, length W) against windows of d ending at each end in [lo,hi]; best k, separated hits. */
function bestEnds(d: Decimated, tgt: Float32Array, lo: number, hi: number, k: number, sep: number, skip?: (end: number) => boolean, levelGate = true): { end: number; ncc: number }[] {
  const W = tgt.length;
  let et = 0;
  for (let j = 0; j < W; j++) et += tgt[j] * tgt[j];
  const hits: { end: number; ncc: number }[] = [];
  lo = Math.max(lo, W);
  hi = Math.min(hi, d.xd.length);
  for (let end = lo; end <= hi; end++) {
    if (skip?.(end)) continue;
    let dot = 0;
    const base = end - W;
    for (let j = 0; j < W; j++) dot += d.xd[base + j] * tgt[j];
    const e = d.pre[end] - d.pre[base];
    const ratio = e / (et + 1e-12);
    if (levelGate && (ratio < 0.55 || ratio > 1.8)) continue; // keep the loudness steady across a join
    hits.push({ end, ncc: dot / Math.sqrt(e * et + 1e-12) });
  }
  hits.sort((p, q) => q.ncc - p.ncc);
  const out: { end: number; ncc: number }[] = [];
  for (const h of hits) {
    if (out.length >= k) break;
    if (out.every((o) => Math.abs(o.end - h.end) >= sep)) out.push(h);
  }
  return out;
}

/** Full-rate NCC of x[p-W..p) against tgt, searching p in [p0-r, p0+r]. */
function refine(x: Float32Array, tgt: Float32Array, p0: number, r: number): { p: number; ncc: number } {
  const W = tgt.length;
  let et = 0;
  for (let j = 0; j < W; j += 2) et += tgt[j] * tgt[j];
  let best = { p: p0, ncc: -2 };
  for (let p = p0 - r; p <= p0 + r; p++) {
    if (p - W < 0 || p > x.length) continue;
    let dot = 0, e = 0;
    for (let j = 0; j < W; j += 2) { const v = x[p - W + j]; dot += v * tgt[j]; e += v * v; }
    const ncc = dot / Math.sqrt(e * et + 1e-12);
    if (ncc > best.ncc) best = { p, ncc };
  }
  return best;
}

export interface Texture { buf: AudioBuffer; entry: number; xf: number; match: number; mono: Float32Array }

/**
 * A long, non-repeating sustain made from the steady part of a sample (audio-texture synthesis).
 * Each join jumps to a different place whose last xf samples best match what has just been played
 * (same phase, same level), then blends over xf. Nothing repeats on a short cycle, so a held note
 * does not stutter. It is entered at index xf, which equals orig[ls + xf], so it follows the head directly.
 */
export function buildTexture(buf: AudioBuffer, x: Float32Array, dx: Decimated, ls: number, leMax: number, xfWanted: number, lenSec = 6): Texture {
  const sr = buf.sampleRate;
  const R = leMax - ls;
  const xf = Math.max(128, Math.min(xfWanted, Math.floor(R * 0.3)));
  const S = Math.round(lenSec * sr);
  const total = S + xf;
  const nCh = buf.numberOfChannels;
  const chans: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) chans.push(buf.getChannelData(c));
  const out = chans.map(() => new Float32Array(total));
  const segMax = Math.max(xf * 2, Math.floor(R * 0.7));
  const minJump = Math.floor(0.03 * sr);
  const segLen = Math.min(segMax, R);
  for (let c = 0; c < nCh; c++) out[c].set(chans[c].subarray(ls, ls + segLen), 0);
  let pos = segLen;
  let curEnd = ls + segLen;
  const used: number[] = [];
  let matchSum = 0, matchN = 0;
  const W = Math.floor(xf / DEC);

  while (pos < total) {
    const tgt = new Float32Array(W);
    for (let j = 0; j < W; j++) {
      let s = 0;
      for (let k = 0; k < DEC; k++) s += out[0][pos - xf + j * DEC + k];
      tgt[j] = s / DEC;
    }
    const lo = Math.ceil((ls + xf) / DEC);
    const hi = Math.floor((leMax - Math.floor(segMax * 0.6)) / DEC);
    const sepD = Math.max(1, Math.floor(minJump / DEC));
    const cands = hi > lo + 2
      ? bestEnds(dx, tgt, lo, hi, 4, sepD, (end) => {
          const p = end * DEC;
          if (Math.abs(p - curEnd) < minJump) return true;
          for (const u of used) if (Math.abs(p - u) < minJump) return true;
          return false;
        })
      : [];
    let pf: number;
    let ncc: number;
    if (cands.length) {
      const pick = cands[Math.floor(Math.random() * Math.min(3, cands.length))];
      const ref = refine(x, new Float32Array(out[0].subarray(pos - xf, pos)), pick.end * DEC, DEC);
      pf = ref.p;
      ncc = ref.ncc;
    } else {
      pf = ls + xf; // nothing to jump to: replay from the start of the region
      ncc = 0;
    }
    pf = Math.max(pf, ls + xf);
    const seg = Math.max(xf + 16, Math.min(leMax - pf, Math.floor(segMax * (0.6 + 0.4 * Math.random()))));
    const power = ncc < 0.6;
    for (let c = 0; c < nCh; c++) {
      const o = out[c], src = chans[c];
      for (let i = 0; i < xf; i++) {
        const t = (i + 1) / (xf + 1);
        const wIn = power ? Math.sin((t * Math.PI) / 2) : t;
        const wOut = power ? Math.cos((t * Math.PI) / 2) : 1 - t;
        o[pos - xf + i] = o[pos - xf + i] * wOut + src[pf - xf + i] * wIn;
      }
      const n = Math.min(seg, total - pos);
      o.set(src.subarray(pf, pf + n), pos);
    }
    pos += seg;
    curEnd = pf + seg;
    used.push(pf);
    if (used.length > 3) used.shift();
    matchSum += Math.max(0, ncc); matchN++;
  }

  // close the loop: fold the extra xf samples into the start so the wrap is continuous
  const fin = new AudioBuffer({ length: S, numberOfChannels: nCh, sampleRate: sr });
  for (let c = 0; c < nCh; c++) {
    const d = fin.getChannelData(c);
    d.set(out[c].subarray(0, S));
    for (let i = 0; i < xf; i++) {
      const t = (i + 1) / (xf + 1);
      d[i] = out[c][S + i] * Math.cos((t * Math.PI) / 2) + out[c][i] * Math.sin((t * Math.PI) / 2);
    }
  }
  return { buf: fin, entry: xf, xf, match: matchN ? matchSum / matchN : 0, mono: mono(fin) };
}

/**
 * Where in the sample's own tail to carry on from so the waveform continues in phase from
 * texture[q-N, q). Searches [from,to) seconds; later positions score slightly higher (longer natural tail).
 */
export function findTail(x: Float32Array, dx: Decimated, tex: Texture, q: number, sr: number, from: number, to: number): { offset: number; ncc: number } {
  const N = Math.round(0.025 * sr);
  const seg = new Float32Array(N);
  const L = tex.mono.length;
  for (let j = 0; j < N; j++) seg[j] = tex.mono[(((q - N + j) % L) + L) % L];
  const W = Math.floor(N / DEC);
  const tgt = new Float32Array(W);
  for (let j = 0; j < W; j++) {
    let s = 0;
    for (let k = 0; k < DEC; k++) s += seg[j * DEC + k];
    tgt[j] = s / DEC;
  }
  const lo = Math.max(W, Math.floor((from * sr) / DEC));
  const hi = Math.min(dx.xd.length, Math.floor((to * sr) / DEC));
  if (hi <= lo) return { offset: Math.max(0, to - 0.1), ncc: 0 };
  const hits = bestEnds(dx, tgt, lo, hi, 6, Math.max(1, Math.floor((0.01 * sr) / DEC)), undefined, false);
  let best = hits[0];
  let bestScore = -Infinity;
  for (const h of hits) {
    const score = h.ncc + 0.15 * ((h.end - lo) / Math.max(1, hi - lo));
    if (score > bestScore) { bestScore = score; best = h; }
  }
  const ref = refine(x, seg, best.end * DEC, DEC);
  return { offset: ref.p / sr, ncc: ref.ncc };
}
