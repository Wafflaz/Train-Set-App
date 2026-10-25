import { SAMPLES, ENGINES, type Engine, type EnvLayer, type WhistleParams } from './engines';
import { activeRegion, autoLoop, crossLoop, detectChuffs, mono, rms, scaleBuffer, sliceBuffer, snapStart } from './dsp';
import { buildTexture, decimate, findTail, type Decimated, type Texture } from './texture';

interface Region { a: number; b: number; mono: Float32Array; dec: Decimated }
interface Prepared {
  key: string; a: number; b: number;
  lsS: number;      // sustain region start in the source (s)
  leS: number;      // sustain region end in the source (s)
  xfS: number;      // blend length (s); the sustain is entered at offset xfS
  seg: number;      // length of the generated sustain (s)
  match: number;    // average quality of the joins inside the sustain (1 = seamless)
  tex: Texture; buf: AudioBuffer;
}
interface Voice {
  prep: Prepared; pitch: number; loopT: number; xf: number; t0: number; peak: number; attack: number;
  voiceGain: GainNode; loop: AudioBufferSourceNode; loopGain: GainNode;
  srcs: AudioBufferSourceNode[]; lfos: OscillatorNode[];
}

/** Synthetic room/tunnel response: decaying noise that darkens as it fades, plus optional early echoes. */
function makeIR(ctx: BaseAudioContext, seconds: number, t60: number, dark: number, echoes: number[] = []): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const ir = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const k = Math.min(1, t / t60);
      const a = (0.85 - 0.7 * dark) * (1 - k) + (0.12 - 0.08 * dark) * k;
      lp += ((Math.random() * 2 - 1) - lp) * a;
      d[i] = lp * Math.pow(10, (-3 * t) / t60) * (t < 0.015 ? t / 0.015 : 1);
    }
    for (const e of echoes) {
      const idx = Math.floor((e + ch * 0.0037) * sr);
      if (idx < n) d[idx] += 0.5 * Math.pow(10, (-3 * e) / t60);
    }
  }
  return ir;
}

export class AudioEngine {
  ctx: BaseAudioContext;
  master: GainNode;
  private muffleGain: GainNode;
  private lowpass: BiquadFilterNode;
  private whistleBus: GainNode;
  private engineBus: GainNode;
  private envBus: GainNode;
  private tunnelSend: GainNode;
  buffers = new Map<string, AudioBuffer>();
  private regions = new Map<string, Region>();
  private prepared = new Map<string, Prepared>();
  private held = new Map<string, Voice>();
  private oneShots = new Map<string, GainNode>();

  chuffs: AudioBuffer[] = [];
  rocks: AudioBuffer[] = [];
  private lastChuff: number[] = [];
  private idleGain: GainNode;
  private idleStarted = false;
  private idleBuf?: AudioBuffer;
  private steamBuf?: AudioBuffer;
  private steam?: { src: AudioBufferSourceNode; gain: GainNode };
  private squealBuf?: AudioBuffer;
  private squeal?: { src: AudioBufferSourceNode; gain: GainNode };
  private envLayers: { layer: EnvLayer; buf: AudioBuffer; gain: GainNode }[] = [];
  private envGroups = new Map<string, GainNode>();
  private envTimer = 0;
  chuffCount = 0;
  rockCount = 0;
  failed: string[] = [];

  constructor(ctx: BaseAudioContext = new AudioContext()) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.muffleGain = ctx.createGain();
    this.lowpass = ctx.createBiquadFilter();
    this.whistleBus = ctx.createGain();
    this.engineBus = ctx.createGain();
    this.envBus = ctx.createGain();
    this.idleGain = ctx.createGain();
    this.tunnelSend = ctx.createGain();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 18000;
    this.lowpass.Q.value = 0.6;
    this.idleGain.gain.value = 0;
    this.tunnelSend.gain.value = 0;
    this.idleGain.connect(this.engineBus);

    // dry path: buses -> tunnel muffle -> master
    this.whistleBus.connect(this.muffleGain);
    this.engineBus.connect(this.muffleGain);
    this.muffleGain.connect(this.lowpass).connect(this.master);
    this.envBus.connect(this.master);
    this.master.connect(ctx.destination);

    // subtle room: a little more on the whistles (the horn needs air around it), less on the engine
    const room = ctx.createConvolver();
    room.buffer = makeIR(ctx, 2.4, 1.7, 0.4);
    const wSend = ctx.createGain(); wSend.gain.value = 0.3;
    const eSend = ctx.createGain(); eSend.gain.value = 0.1;
    const roomOut = ctx.createGain(); roomOut.gain.value = 0.9;
    this.whistleBus.connect(wSend).connect(room);
    this.engineBus.connect(eSend).connect(room);
    room.connect(roomOut).connect(this.muffleGain);

    // tunnel: long, dark, flutter-echo reverb that swells in as the train goes inside
    const tunnel = ctx.createConvolver();
    tunnel.buffer = makeIR(ctx, 4.2, 3.4, 0.85, [0.031, 0.062, 0.094, 0.127, 0.16, 0.2]);
    const tOut = ctx.createGain(); tOut.gain.value = 1.1;
    this.whistleBus.connect(this.tunnelSend);
    this.engineBus.connect(this.tunnelSend);
    this.tunnelSend.connect(tunnel).connect(tOut).connect(this.master);
  }

  resume() { return (this.ctx as AudioContext).resume?.() ?? Promise.resolve(); }

  private async fetchBuf(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const data = await res.arrayBuffer();
    // some browsers never settle decodeAudioData on a bad file, which would leave the Start button stuck
    return Promise.race([
      this.ctx.decodeAudioData(data),
      new Promise<AudioBuffer>((_, rej) => setTimeout(() => rej(new Error('decode timed out')), 20000)),
    ]);
  }

  /** like fetchBuf, but a missing or undecodable file is recorded and skipped instead of aborting the load */
  private async fetchOpt(url: string): Promise<AudioBuffer | undefined> {
    try { return await this.fetchBuf(url); } catch (err) { this.failed.push(`${url} (${(err as Error).message})`); return undefined; }
  }

  async load(onProgress?: (done: number, total: number) => void): Promise<void> {
    this.failed = [];
    await Promise.all(ENGINES.map(async (e) => {
      if (!this.buffers.has(e.sample)) this.buffers.set(e.sample, await this.fetchBuf(`${SAMPLES.whistleDir}/${e.sample}.mp3`));
    }));
    let done = 0;
    const total = 4 + SAMPLES.rocks.length + SAMPLES.env.length;
    const opt = async (url: string) => { const b = await this.fetchOpt(url); onProgress?.(++done, total); return b; };
    const [chuffSrc, steamSrc, idleSrc, squealSrc, ...rest] = await Promise.all([
      opt(SAMPLES.chuff.url), opt(SAMPLES.steam.url), opt(SAMPLES.idle.url), opt(SAMPLES.squeal.url),
      ...SAMPLES.rocks.map((r) => opt(r.url)),
      ...SAMPLES.env.map((l) => opt(l.url)),
    ]);
    const rockSrcs = rest.slice(0, SAMPLES.rocks.length);
    const envSrcs = rest.slice(SAMPLES.rocks.length);

    // single exhaust beats, level-matched, soft edges
    if (chuffSrc) {
      const onsets = detectChuffs(chuffSrc, SAMPLES.chuff.from, SAMPLES.chuff.to);
      this.chuffs = this.levelMatch(onsets.map((t) => sliceBuffer(chuffSrc, t - 0.025, 0.34, 0.012, 0.12)));
    }

    // little stone clacks
    const clacks: AudioBuffer[] = [];
    rockSrcs.forEach((buf, i) => {
      if (!buf) return;
      const { from, to } = SAMPLES.rocks[i];
      for (const t of detectChuffs(buf, from, to, 0.07)) clacks.push(sliceBuffer(buf, t - 0.006, 0.16, 0.004, 0.09));
    });
    this.rocks = this.levelMatch(clacks);

    if (steamSrc) this.steamBuf = sliceBuffer(steamSrc, SAMPLES.steam.from, SAMPLES.steam.len, 0.15, 3.5);

    if (idleSrc) {
      const sr = idleSrc.sampleRate;
      this.idleBuf = crossLoop(idleSrc, Math.round(SAMPLES.idle.from * sr), Math.round(SAMPLES.idle.to * sr), Math.round(1.5 * sr));
    }
    if (squealSrc) {
      const ss = squealSrc.sampleRate;
      this.squealBuf = crossLoop(squealSrc, Math.round(SAMPLES.squeal.from * ss), Math.round(SAMPLES.squeal.to * ss), Math.round(1 * ss));
    }

    this.envGroups.clear();
    this.envLayers = SAMPLES.env.flatMap((layer, i) => {
      const b = envSrcs[i];
      if (!b) return [];
      const rate = b.sampleRate;
      const buf = crossLoop(b, Math.round(layer.from * rate), Math.round(layer.to * rate), Math.round(layer.xf * rate));
      if (!this.envGroups.has(layer.group)) {
        const g = this.ctx.createGain();
        g.gain.value = 0.5;
        g.connect(this.envBus);
        this.envGroups.set(layer.group, g);
      }
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.envGroups.get(layer.group)!);
      return [{ layer, buf, gain }];
    });
  }

  private levelMatch(slices: AudioBuffer[]): AudioBuffer[] {
    if (!slices.length) return slices;
    const levels = slices.map(rms).sort((x, y) => x - y);
    const median = levels[Math.floor(levels.length / 2)] || 1;
    for (const s of slices) scaleBuffer(s, Math.max(0.5, Math.min(2, median / (rms(s) || 1))));
    return slices;
  }

  setMaster(v: number) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  // ---------- whistle ----------
  region(sample: string): Region {
    let r = this.regions.get(sample);
    if (!r) {
      const buf = this.buffers.get(sample)!;
      const { a, b } = activeRegion(buf);
      const m = mono(buf);
      r = { a, b, mono: m, dec: decimate(m) };
      this.regions.set(sample, r);
    }
    return r;
  }

  autoLoopFor(engine: Engine): { start: number; end: number } {
    return autoLoop(this.buffers.get(engine.sample)!, this.region(engine.sample));
  }

  prepare(engine: Engine, p: WhistleParams): Prepared {
    const buf = this.buffers.get(engine.sample)!;
    const r = this.region(engine.sample);
    const key = `${engine.sample}:${p.loopStart.toFixed(4)}:${p.loopEnd.toFixed(4)}:${p.crossfade.toFixed(3)}`;
    const hit = this.prepared.get(engine.sample);
    if (hit && hit.key === key) return hit;
    const sr = buf.sampleRate;
    const span = r.b - r.a;
    const ls = snapStart(r.mono, sr, r.a + p.loopStart * span);
    let le = Math.round((r.a + p.loopEnd * span) * sr);
    const minLen = Math.round(0.12 * sr);
    if (le - ls < minLen) le = Math.min(Math.round(r.b * sr) - 1, ls + minLen);
    const tex = buildTexture(buf, r.mono, r.dec, ls, le, Math.round(p.crossfade * sr));
    const prep: Prepared = {
      key, a: r.a, b: r.b, lsS: ls / sr, leS: le / sr, xfS: tex.xf / sr, seg: tex.buf.duration, match: tex.match, tex, buf,
    };
    this.prepared.set(engine.sample, prep);
    return prep;
  }

  /** Head plays once, the lag-matched loop repeats while held, release hands over to the natural tail. */
  whistleOn(engine: Engine, p: WhistleParams, velocity = 1) {
    if (!this.buffers.has(engine.sample) || this.held.has(engine.id)) return;
    const prep = this.prepare(engine, p);
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.01;
    const rate = p.pitch;
    const peak = p.volume * velocity;
    const attack = Math.max(p.attack, 0.01);
    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, t0);
    voiceGain.gain.linearRampToValueAtTime(peak, t0 + attack);
    voiceGain.connect(this.whistleBus);

    const srcs: AudioBufferSourceNode[] = [];
    const lfos: OscillatorNode[] = [];
    const headLen = prep.lsS + prep.xfS - prep.a;
    if (headLen > 0.002) {
      const head = ctx.createBufferSource();
      head.buffer = prep.buf;
      head.playbackRate.value = rate;
      head.connect(voiceGain);
      head.start(t0, prep.a, headLen);
      srcs.push(head);
    }
    const loopT = t0 + headLen / rate;
    const loop = ctx.createBufferSource();
    loop.buffer = prep.tex.buf;
    loop.loop = true;
    loop.playbackRate.value = rate;
    const loopGain = ctx.createGain();
    loop.connect(loopGain).connect(voiceGain);
    loop.start(loopT, prep.xfS);
    srcs.push(loop);

    // breath: slight slow wobble in level and pitch so a held note never repeats mechanically
    const trem = ctx.createOscillator();
    trem.frequency.value = 0.55 + Math.random() * 0.5;
    const tremAmt = ctx.createGain();
    tremAmt.gain.value = peak * 0.05;
    trem.connect(tremAmt).connect(voiceGain.gain);
    const drift = ctx.createOscillator();
    drift.frequency.value = 0.31 + Math.random() * 0.2;
    const driftAmt = ctx.createGain();
    driftAmt.gain.value = rate * 0.004;
    drift.connect(driftAmt);
    driftAmt.connect(loop.playbackRate);
    trem.start(loopT);
    drift.start(loopT);
    lfos.push(trem, drift);

    const xf = Math.min(0.08, Math.max(0.02, p.crossfade * 0.5));
    this.held.set(engine.id, { prep, pitch: rate, loopT, xf, t0, peak, attack, voiceGain, loop, loopGain, srcs, lfos });
  }

  /** One-shot mode: the whole audible whistle plays once; letting go of the key changes nothing. */
  whistleOneShot(engine: Engine, p: WhistleParams, velocity = 1) {
    const buf = this.buffers.get(engine.sample);
    if (!buf) return;
    const ctx = this.ctx;
    const r = this.region(engine.sample);
    const prev = this.oneShots.get(engine.id);
    const t0 = ctx.currentTime + 0.01;
    if (prev) {
      prev.gain.cancelScheduledValues(t0);
      prev.gain.setTargetAtTime(0, t0, 0.04);
    }
    const peak = p.volume * velocity;
    const dur = (r.b - r.a) / p.pitch;
    const fade = Math.min(Math.max(p.release, 0.05), dur * 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + Math.min(Math.max(p.attack, 0.01), dur * 0.3));
    g.gain.setValueAtTime(peak, t0 + dur - fade);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = p.pitch;
    src.connect(g).connect(this.whistleBus);
    src.start(t0, r.a, r.b - r.a);
    src.stop(t0 + dur + 0.05);
    this.oneShots.set(engine.id, g);
  }

  whistleUpdate(engine: Engine, p: WhistleParams) {
    const v = this.held.get(engine.id);
    if (!v) return;
    v.pitch = p.pitch;
    for (const s of v.srcs) s.playbackRate.setTargetAtTime(p.pitch, this.ctx.currentTime, 0.03);
  }

  whistleOff(engine: Engine, p: WhistleParams) {
    const v = this.held.get(engine.id);
    if (!v) return;
    this.held.delete(engine.id);
    const ctx = this.ctx;
    const { prep } = v;
    const now = ctx.currentTime;
    const rate = v.pitch;
    const xf = v.xf;

    if (now < v.loopT) {
      // released before the sustain began: close the valve with a soft fade
      const fade = Math.max(p.release, 0.1);
      const cur = v.peak * Math.min(1, Math.max(0, (now - v.t0) / v.attack));
      v.voiceGain.gain.cancelScheduledValues(now);
      v.voiceGain.gain.setValueAtTime(cur, now);
      v.voiceGain.gain.linearRampToValueAtTime(0, now + fade);
      for (const s of v.srcs) s.stop(now + fade + 0.05);
      for (const o of v.lfos) o.stop(now + fade + 0.1);
      return;
    }

    // released during the sustain: carry on from the point in the sample's own tail whose waveform
    // continues, in phase, from what the sustain is playing a few ms from now
    const sr = prep.buf.sampleRate;
    const r = this.region(engine.sample);
    const tailStart = now + 0.035;
    const q = Math.floor(((prep.xfS + (tailStart - v.loopT) * rate) % prep.seg) * sr);
    const ft = findTail(r.mono, r.dec, prep.tex, q, sr, Math.max(prep.lsS, prep.leS - 0.1), Math.min(prep.b - 0.08, prep.leS + 1.0));
    const offset = Math.max(0, Math.min(ft.offset, prep.b - 0.06));
    v.loopGain.gain.setValueAtTime(1, tailStart);
    v.loopGain.gain.linearRampToValueAtTime(0, tailStart + xf);
    v.loop.stop(tailStart + xf + 0.02);

    const tail = ctx.createBufferSource();
    tail.buffer = prep.buf;
    tail.playbackRate.value = rate;
    const tailGain = ctx.createGain();
    tail.connect(tailGain).connect(v.voiceGain);
    const natural = Math.max(0.05, (prep.b - offset) / rate);
    const dur = Math.max(xf + 0.03, Math.min(natural, p.tail));
    const end = tailStart + dur;
    const fade = Math.min(Math.max(p.release, 0.02), dur - xf);
    tailGain.gain.setValueAtTime(0, tailStart);
    tailGain.gain.linearRampToValueAtTime(1, tailStart + xf);
    tailGain.gain.setValueAtTime(1, Math.max(tailStart + xf, end - fade));
    tailGain.gain.linearRampToValueAtTime(0, end);
    tail.start(tailStart, offset, prep.b - offset);
    tail.stop(end + 0.05);
    for (const o of v.lfos) o.stop(end + 0.1);
  }

  isHeld(id: string) { return this.held.has(id); }

  // ---------- engine sounds ----------
  playChuff(when: number, gain: number, rate = 1) {
    if (!this.chuffs.length) return;
    let idx = 0;
    for (let tries = 0; tries < 6; tries++) {
      idx = Math.floor(Math.random() * this.chuffs.length);
      if (!this.lastChuff.includes(idx)) break;
    }
    this.lastChuff = [idx, ...this.lastChuff].slice(0, 3);
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    src.buffer = this.chuffs[idx];
    src.playbackRate.value = rate;
    g.gain.value = gain;
    src.connect(g).connect(this.engineBus);
    src.start(when);
    this.chuffCount++;
  }

  playRock(when: number, gain: number, rate = 1) {
    if (!this.rocks.length) return;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    src.buffer = this.rocks[Math.floor(Math.random() * this.rocks.length)];
    src.playbackRate.value = rate;
    g.gain.value = gain;
    src.connect(g).connect(this.engineBus);
    src.start(when);
    this.rockCount++;
  }

  /** Stationary ambience: loops forever, level eased with a long time constant. */
  setIdle(level: number, tc = 1) {
    if (!this.idleBuf) return;
    if (!this.idleStarted) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.idleBuf;
      src.loop = true;
      src.connect(this.idleGain);
      src.start();
      this.idleStarted = true;
    }
    this.idleGain.gain.setTargetAtTime(level, this.ctx.currentTime, tc);
  }

  /** Rail squeal on curves: looped squeal stretch, high-passed so the crane's thump is left out. */
  setSqueal(level: number, rate: number) {
    if (!this.squealBuf) return;
    const t = this.ctx.currentTime;
    if (!this.squeal) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.squealBuf;
      src.loop = true;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1700;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 9000;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(hp).connect(lp).connect(gain).connect(this.engineBus);
      src.start(0, Math.random() * this.squealBuf.duration);
      this.squeal = { src, gain };
    }
    this.squeal.gain.gain.setTargetAtTime(level, t, 0.4);
    this.squeal.src.playbackRate.setTargetAtTime(rate, t, 0.6);
  }

  steamRelease(level: number) {
    if (!this.steamBuf) return;
    this.stopSteam(0.3);
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = this.steamBuf;
    gain.gain.value = level;
    src.connect(gain).connect(this.engineBus);
    src.start();
    this.steam = { src, gain };
  }

  stopSteam(fade = 0.8) {
    if (!this.steam) return;
    const { src, gain } = this.steam;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + fade);
    src.stop(t + fade + 0.05);
    this.steam = undefined;
  }

  /** 0 = open, 1 = deep in tunnel (low-pass, slight level drop, long dark reverb swells in). */
  setMuffle(c: number) {
    const t = this.ctx.currentTime;
    this.lowpass.frequency.setTargetAtTime(18000 * Math.pow(550 / 18000, c), t, 0.3);
    this.muffleGain.gain.setTargetAtTime(1 - 0.3 * c, t, 0.3);
    this.tunnelSend.gain.setTargetAtTime(0.85 * c, t, 0.5);
  }

  // ---------- environment ----------
  startEnv() {
    if (this.envTimer || !this.envLayers.length) return;
    for (const l of this.envLayers) {
      const src = this.ctx.createBufferSource();
      src.buffer = l.buf;
      src.loop = true;
      src.connect(l.gain);
      src.start(0, Math.random() * l.buf.duration);
      l.gain.gain.setTargetAtTime(l.layer.gain, this.ctx.currentTime, 2);
    }
    // slow drift so the beds breathe rather than sit at one fixed level
    this.envTimer = window.setInterval(() => {
      const t = this.ctx.currentTime;
      for (const l of this.envLayers) l.gain.gain.setTargetAtTime(l.layer.gain * (0.6 + Math.random() * 0.55), t, 2.5);
    }, 4000);
  }

  setEnvGroup(group: string, level: number) {
    this.envGroups.get(group)?.gain.setTargetAtTime(level, this.ctx.currentTime, 0.3);
  }
}
