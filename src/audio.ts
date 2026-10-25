import { SAMPLES, ENGINES, type Engine, type EngineVoice, type EnvLayer, type WhistleParams } from './engines';
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
/** One locomotive's own chuffs and steam release. */
interface EngineSounds { chuffs: AudioBuffer[]; steam?: AudioBuffer }
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

/** What a tunnel does to a train's sound (all adjustable in the app). */
export interface TunnelCfg {
  vol: number;     // level deep inside, 0..1 of the open-air level
  cut: number;     // low-pass cutoff deep inside, Hz
  lowCut: number;  // high-pass deep inside, Hz: takes the boom out of the reverb
  verb: number;    // tunnel reverb send deep inside
}
export const DEFAULT_TUNNEL: TunnelCfg = { vol: 0.3, cut: 480, lowCut: 150, verb: 0.3 };

/**
 * One locomotive's own path to the speakers: whistle and engine sounds meet on a bus, then go through that engine's
 * pan (where it is on the set), tunnel filters and tunnel reverb send. Two trains running at once each have one.
 */
class Channel {
  readonly whistleIn: GainNode;
  readonly voiceIn: GainNode;
  readonly bus: GainNode;
  readonly idleG: GainNode;
  idleStarted = false;
  steam?: { src: AudioBufferSourceNode; gain: GainNode };
  squeal?: { src: AudioBufferSourceNode; gain: GainNode };
  lastChuff: number[] = [];
  tunnel = -1;
  private pan: StereoPannerNode;
  private hp: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private vol: GainNode;
  private roomSend: GainNode;
  private tunSend: GainNode;

  constructor(readonly ctx: BaseAudioContext, readonly id: string, voice: EngineVoice, master: AudioNode, room: AudioNode, tunnel: AudioNode, roomBase: number) {
    this.whistleIn = ctx.createGain();
    this.voiceIn = ctx.createGain();
    this.bus = ctx.createGain();
    this.idleG = ctx.createGain();
    this.idleG.gain.value = 0;
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 220; low.gain.value = voice.low;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = 2800; high.gain.value = voice.high;
    this.voiceIn.connect(low).connect(high).connect(this.bus);
    this.whistleIn.connect(this.bus);
    this.idleG.connect(this.bus);
    this.pan = ctx.createStereoPanner();
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 20; this.hp.Q.value = 0.5;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 18000; this.lp.Q.value = 0.5;
    this.vol = ctx.createGain();
    this.bus.connect(this.pan).connect(this.hp).connect(this.lp).connect(this.vol).connect(master);
    this.roomSend = ctx.createGain(); this.roomSend.gain.value = roomBase;
    this.tunSend = ctx.createGain(); this.tunSend.gain.value = 0;
    this.bus.connect(this.roomSend).connect(room);
    this.bus.connect(this.tunSend).connect(tunnel);
  }

  setPan(p: number) { this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, p)), this.ctx.currentTime, 0.12); }

  /** c: 0 = open air, 1 = deep inside a tunnel. Quick: the sound should follow the train, not trail it. */
  setTunnel(c: number, cfg: TunnelCfg, roomBase: number, force = false) {
    if (!force && Math.abs(c - this.tunnel) < 0.004) return;
    this.tunnel = c;
    const t = this.ctx.currentTime, tc = 0.1;
    this.lp.frequency.setTargetAtTime(18000 * Math.pow(Math.max(100, cfg.cut) / 18000, c), t, tc);
    this.hp.frequency.setTargetAtTime(20 * Math.pow(Math.max(20, cfg.lowCut) / 20, c), t, tc);
    this.vol.gain.setTargetAtTime(1 - (1 - cfg.vol) * c, t, tc);
    this.tunSend.gain.setTargetAtTime(cfg.verb * c, t, tc * 2);
    this.roomSend.gain.setTargetAtTime(roomBase * (1 - 0.85 * c), t, tc);
  }
}

export class AudioEngine {
  ctx: BaseAudioContext;
  master: GainNode;
  private compressor: DynamicsCompressorNode;
  private envBus: GainNode;
  private chans = new Map<string, Channel>();
  private roomOut: GainNode;
  tunnelCfg: TunnelCfg = { ...DEFAULT_TUNNEL };
  roomLevel = 1;
  buffers = new Map<string, AudioBuffer>();
  private regions = new Map<string, Region>();
  private prepared = new Map<string, Prepared>();
  private held = new Map<string, Voice>();
  private oneShots = new Map<string, GainNode>();

  private voices = new Map<string, EngineSounds>();
  whistleLevel = 1;
  private masterLevel = 0.8;
  private suspendTimer = 0;
  muted = false;
  rocks: AudioBuffer[] = [];
  clacks: AudioBuffer[] = [];
  clackCount = 0;
  private idleBuf?: AudioBuffer;
  private squealBuf?: AudioBuffer;
  private envLayers: { layer: EnvLayer; buf: AudioBuffer; gain: GainNode }[] = [];
  private envGroups = new Map<string, GainNode>();
  private envTimer = 0;
  chuffCount = 0;
  rockCount = 0;
  failed: string[] = [];

  // 'interactive': the shortest delay the computer manages. The video link is already late; do not add to it.
  constructor(ctx: BaseAudioContext = new AudioContext({ latencyHint: 'interactive' })) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.envBus = ctx.createGain();
    // a gentle limiter so the engines can sit loud on the set without clipping when several sounds land together
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 14;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.22;
    this.envBus.connect(this.master);
    this.master.connect(this.compressor).connect(ctx.destination);

    // subtle room reverb shared by every engine (needs air around the horn)
    const room = ctx.createConvolver();
    room.buffer = makeIR(ctx, 2.4, 1.7, 0.4);
    this.roomOut = ctx.createGain(); this.roomOut.gain.value = 0.9;
    room.connect(this.roomOut).connect(this.master);

    // tunnel: long, dark, flutter-echo reverb; thinned at the bottom so it does not boom
    const tunnel = ctx.createConvolver();
    tunnel.buffer = makeIR(ctx, 3.6, 2.8, 0.85, [0.031, 0.062, 0.094, 0.127, 0.16, 0.2]);
    const tHp = ctx.createBiquadFilter(); tHp.type = 'highpass'; tHp.frequency.value = 160;
    const tOut = ctx.createGain(); tOut.gain.value = 0.9;
    tunnel.connect(tHp).connect(tOut).connect(this.master);

    for (const e of ENGINES) this.chans.set(e.id, new Channel(ctx, e.id, e.voice, this.master, room, tunnel, this.roomBase(e.id)));
  }

  private roomBase(_id: string) { return 0.22 * this.roomLevel; }
  private ch(id: string): Channel { return this.chans.get(id) ?? this.chans.values().next().value!; }

  /** The mixer's room-reverb fader. */
  setRoom(v: number) {
    this.roomLevel = v;
    for (const c of this.chans.values()) c.setTunnel(Math.max(0, c.tunnel), this.tunnelCfg, this.roomBase(c.id), true);
  }

  /** The mixer's whistle fader. */
  setWhistleLevel(v: number) {
    this.whistleLevel = v;
    for (const c of this.chans.values()) c.whistleIn.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  setTunnelCfg(p: Partial<TunnelCfg>) {
    Object.assign(this.tunnelCfg, p);
    for (const c of this.chans.values()) c.setTunnel(Math.max(0, c.tunnel), this.tunnelCfg, this.roomBase(c.id), true);
  }

  resume() {
    if (this.muted) return Promise.resolve(); // sound is off: leave the context asleep
    return (this.ctx as AudioContext).resume?.() ?? Promise.resolve();
  }

  /** Sound off: fade out, then suspend the context so it costs no CPU. Sound on: wake it and fade back in. */
  async setMuted(m: boolean) {
    this.muted = m;
    clearTimeout(this.suspendTimer);
    const ctx = this.ctx as AudioContext;
    if (m) {
      this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.06);
      this.suspendTimer = window.setTimeout(() => { if (this.muted) void ctx.suspend?.(); }, 500);
    } else {
      await ctx.resume?.();
      this.master.gain.setTargetAtTime(this.masterLevel, ctx.currentTime, 0.08);
    }
  }

  /** -1 (left) .. 1 (right): where that engine is on the set, as heard by the listener. */
  setPan(engine: string, p: number) { this.ch(engine).setPan(p); }

  /** 0 = in the open, 1 = deep in a tunnel, for that engine (its whistle follows it). */
  setMuffle(engine: string, c: number) { this.ch(engine).setTunnel(c, this.tunnelCfg, this.roomBase(engine)); }

  get chuffs(): AudioBuffer[] { return this.voices.get(ENGINES[0].id)?.chuffs ?? []; }

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
    const voiceUrls = [...new Set(ENGINES.flatMap((e) => [e.voice.chuff.url, e.voice.steam.url]))];
    const total = 2 + voiceUrls.length + SAMPLES.clacks.length + SAMPLES.rocks.length + SAMPLES.env.length;
    const opt = async (url: string) => { const b = await this.fetchOpt(url); onProgress?.(++done, total); return b; };
    const [idleSrc, squealSrc, ...rest] = await Promise.all([
      opt(SAMPLES.idle.url), opt(SAMPLES.squeal.url),
      ...voiceUrls.map((u) => opt(u)),
      ...SAMPLES.clacks.map((c) => opt(c.url)),
      ...SAMPLES.rocks.map((r) => opt(r.url)),
      ...SAMPLES.env.map((l) => opt(l.url)),
    ]);
    const voiceSrcs = new Map(voiceUrls.map((u, i) => [u, rest[i]] as const));
    let at = voiceUrls.length;
    const clackSrcs = rest.slice(at, (at += SAMPLES.clacks.length));
    const rockSrcs = rest.slice(at, (at += SAMPLES.rocks.length));
    const envSrcs = rest.slice(at);

    // each locomotive: single exhaust beats (level-matched, soft edges) and its own steam release
    this.voices.clear();
    for (const e of ENGINES) {
      const cs = voiceSrcs.get(e.voice.chuff.url);
      const ss = voiceSrcs.get(e.voice.steam.url);
      const chuffs = cs
        ? this.levelMatch(detectChuffs(cs, e.voice.chuff.from, e.voice.chuff.to).map((t) => sliceBuffer(cs, t - 0.025, 0.34, 0.012, 0.12)))
        : [];
      const steam = ss ? sliceBuffer(ss, e.voice.steam.from, e.voice.steam.len, 0.15, Math.min(3.5, e.voice.steam.len * 0.4)) : undefined;
      this.voices.set(e.id, { chuffs, steam });
    }
    // bring every engine to the loudness of the reference (Pug) so only the character differs
    const ref = this.voices.get('pug');
    const med = (bs: AudioBuffer[]) => { const l = bs.map(rms).sort((x, y) => x - y); return l[Math.floor(l.length / 2)] || 0; };
    const refChuff = ref ? med(ref.chuffs) : 0;
    const refSteam = ref?.steam ? rms(ref.steam) : 0;
    const fit = (g: number) => Math.max(0.3, Math.min(4, g));
    const limit = (b: AudioBuffer, peak: number) => {
      let p = 0;
      for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i])); }
      if (p > peak) scaleBuffer(b, peak / p);
    };
    for (const v of this.voices.values()) {
      const m = med(v.chuffs);
      if (refChuff && m) for (const b of v.chuffs) scaleBuffer(b, fit(refChuff / m));
      if (refSteam && v.steam) scaleBuffer(v.steam, fit(refSteam / (rms(v.steam) || 1)));
      for (const b of v.chuffs) limit(b, 0.85); // a hot slice must not clip when several overlap
      if (v.steam) limit(v.steam, 0.85);
    }

    // wheel clacks of wagons going over rail joints (from steam goods trains passing)
    const wc: AudioBuffer[] = [];
    clackSrcs.forEach((buf, i) => {
      if (!buf) return;
      const { from, to } = SAMPLES.clacks[i];
      for (const t of detectChuffs(buf, from, to, 0.04)) wc.push(sliceBuffer(buf, t - 0.004, 0.14, 0.003, 0.08));
    });
    this.clacks = this.levelMatch(wc.length > 360 ? wc.filter((_, i) => i % Math.ceil(wc.length / 360) === 0) : wc);

    // little stone clacks
    const clacks: AudioBuffer[] = [];
    rockSrcs.forEach((buf, i) => {
      if (!buf) return;
      const { from, to } = SAMPLES.rocks[i];
      for (const t of detectChuffs(buf, from, to, 0.07)) clacks.push(sliceBuffer(buf, t - 0.006, 0.16, 0.004, 0.09));
    });
    this.rocks = this.levelMatch(clacks);

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

  setMaster(v: number) {
    this.masterLevel = v;
    if (!this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

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
    voiceGain.connect(this.ch(engine.id).whistleIn);

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
    src.connect(g).connect(this.ch(engine.id).whistleIn);
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

  // ---------- engine sounds (each addressed to an engine's channel) ----------
  playChuff(engine: string, when: number, gain: number, rate = 1) {
    const set = this.voices.get(engine)?.chuffs ?? [];
    if (!set.length) return;
    const v = ENGINES.find((x) => x.id === engine)!.voice;
    const ch = this.ch(engine);
    let idx = 0;
    for (let tries = 0; tries < 6; tries++) {
      idx = Math.floor(Math.random() * set.length);
      if (!ch.lastChuff.includes(idx)) break;
    }
    ch.lastChuff = [idx, ...ch.lastChuff].slice(0, 3);
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    src.buffer = set[idx];
    src.playbackRate.value = rate * v.pitch;
    g.gain.value = gain * v.level;
    src.connect(g).connect(ch.voiceIn);
    src.start(when);
    this.chuffCount++;
  }

  /** One wagon wheel over a rail joint. */
  playClack(engine: string, when: number, gain: number, rate = 1) {
    if (!this.clacks.length) return;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    src.buffer = this.clacks[Math.floor(Math.random() * this.clacks.length)];
    src.playbackRate.value = rate;
    g.gain.value = gain;
    src.connect(g).connect(this.ch(engine).bus);
    src.start(when);
    this.clackCount++;
  }

  playRock(engine: string, when: number, gain: number, rate = 1) {
    if (!this.rocks.length) return;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    src.buffer = this.rocks[Math.floor(Math.random() * this.rocks.length)];
    src.playbackRate.value = rate;
    g.gain.value = gain;
    src.connect(g).connect(this.ch(engine).bus);
    src.start(when);
    this.rockCount++;
  }

  /** Stationary ambience: loops forever, level eased with a long time constant. */
  setIdle(engine: string, level: number, tc = 1) {
    if (!this.idleBuf) return;
    const ch = this.ch(engine);
    if (!ch.idleStarted) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.idleBuf;
      src.loop = true;
      src.connect(ch.idleG);
      src.start(0, Math.random() * this.idleBuf.duration);
      ch.idleStarted = true;
    }
    ch.idleG.gain.setTargetAtTime(level, this.ctx.currentTime, tc);
  }

  /** Rail squeal on curves: looped squeal stretch, high-passed so the crane's thump is left out. */
  setSqueal(engine: string, level: number, rate: number) {
    if (!this.squealBuf) return;
    const ch = this.ch(engine);
    const t = this.ctx.currentTime;
    if (!ch.squeal) {
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
      src.connect(hp).connect(lp).connect(gain).connect(ch.bus);
      src.start(0, Math.random() * this.squealBuf.duration);
      ch.squeal = { src, gain };
    }
    ch.squeal.gain.gain.setTargetAtTime(level, t, 0.4);
    ch.squeal.src.playbackRate.setTargetAtTime(rate, t, 0.6);
  }

  steamRelease(engine: string, level: number) {
    const buf = this.voices.get(engine)?.steam;
    if (!buf) return;
    const v = ENGINES.find((x) => x.id === engine)!.voice;
    const ch = this.ch(engine);
    this.stopSteam(engine, 0.3);
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = v.pitch;
    gain.gain.value = level * v.level * v.steamTrim;
    src.connect(gain).connect(ch.voiceIn);
    src.start();
    ch.steam = { src, gain };
  }

  stopSteam(engine: string, fade = 0.8) {
    const ch = this.ch(engine);
    if (!ch.steam) return;
    const { src, gain } = ch.steam;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + fade);
    src.stop(t + fade + 0.05);
    ch.steam = undefined;
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
