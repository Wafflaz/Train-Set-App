import './style.css';
import { AudioEngine, DEFAULT_TUNNEL, type TunnelCfg } from './audio';
import { ENGINES, type WhistleParams } from './engines';
import { TrainTracker, type Track, type Zone } from './motion';
import { DEFAULT_TRAIN, TrainSound, type TrainSettings } from './train';
import { startDemo } from './demo';
import { WagonEstimator } from './wagons';
import { connectPhone, phoneUrls } from './phone';

interface Binding { key: string; note: number | null }
interface EnvSettings { birds: number; wind: number; people: number; on: boolean }
interface SlotSaved { engine?: string; wagonMode?: 'auto' | number; wagonGrid?: { base?: number[]; cnt?: number[] } }
interface Saved {
  params?: Record<string, WhistleParams>;
  bindings?: Record<string, Binding>;
  train?: Partial<TrainSettings>;
  tracker?: { threshold?: number; minArea?: number; maxFrac?: number };
  env?: Partial<EnvSettings>;
  slots?: SlotSaved[];
  trains?: number;
  tunnels?: Zone[];
  ignore?: Zone[];
  tunnelCfg?: Partial<TunnelCfg>;
  mix?: { whistle?: number; room?: number };
  autoLag?: boolean;
  track?: { aspect?: number; cells?: number[] } | null;
}

const KEY = 'train-app-v4';
const saved: Saved = (() => {
  try {
    const now = localStorage.getItem(KEY);
    if (now) return JSON.parse(now) as Saved;
    // first run of this version: keep the whistle voicing, key/MIDI bindings and countryside, start the rest afresh
    const old = JSON.parse(localStorage.getItem('train-app-v3') ?? '{}') as Saved;
    return { params: old.params, bindings: old.bindings, env: old.env };
  } catch { return {}; }
})();
const params: Record<string, WhistleParams> = {};
const bindings: Record<string, Binding> = {};
for (const e of ENGINES) {
  params[e.id] = { ...e.params, ...saved.params?.[e.id] };
  bindings[e.id] = saved.bindings?.[e.id] ?? { key: e.key, note: null };
}
const env: EnvSettings = { birds: 0.5, wind: 0.45, people: 0.35, on: true, ...saved.env };

const audio = new AudioEngine();
(window as unknown as { __audio: AudioEngine }).__audio = audio;
const tracker = new TrainTracker();
(window as unknown as { __tracker: TrainTracker }).__tracker = tracker;
const trainSettings: TrainSettings = { ...DEFAULT_TRAIN, ...saved.train };
const tunnelCfg: TunnelCfg = { ...DEFAULT_TUNNEL, ...saved.tunnelCfg };
audio.tunnelCfg = tunnelCfg;
const mix = { whistle: 1, room: 1, ...saved.mix };
let autoLag = saved.autoLag ?? true;

// two trains can run at once: each slot follows one train and gives it one locomotive's voice
const SLOTS = 2;
const defaultEngines = [ENGINES[0].id, ENGINES[2].id];
const slotEngine: string[] = [0, 1].map((i) => (ENGINES.some((e) => e.id === saved.slots?.[i]?.engine) ? saved.slots![i].engine! : defaultEngines[i]));
const sounds = slotEngine.map((id) => new TrainSound(audio, trainSettings, id));
const wagonEsts = [0, 1].map((i) => { const w = new WagonEstimator(); w.fromJSON(saved.slots?.[i]?.wagonGrid); return w; });
const wagonModes: ('auto' | number)[] = [0, 1].map((i) => saved.slots?.[i]?.wagonMode ?? 'auto');
let demoWagons = 0;
if (saved.tracker?.threshold) tracker.threshold = saved.tracker.threshold;
if (saved.tracker?.minArea) tracker.minArea = saved.tracker.minArea;
if (saved.tracker?.maxFrac) tracker.maxFrac = saved.tracker.maxFrac;
tracker.maxTargets = Math.max(1, Math.min(SLOTS, saved.trains ?? 2));
tracker.tunnels = saved.tunnels ?? [];
tracker.ignore = saved.ignore ?? [{ x0: 0, x1: 0.13, y0: 0, y1: 1 }];   // the left edge is where people sit
tracker.loadTrack(saved.track);
let learning: string | null = null;

const persist = () =>
  localStorage.setItem(KEY, JSON.stringify({
    params, bindings, train: trainSettings, env, tunnelCfg, mix, autoLag,
    tracker: { threshold: tracker.threshold, minArea: tracker.minArea, maxFrac: tracker.maxFrac },
    slots: sounds.map((s, i) => ({ engine: s.engine, wagonMode: wagonModes[i], wagonGrid: wagonEsts[i].toJSON() })),
    trains: tracker.maxTargets, tunnels: tracker.tunnels, ignore: tracker.ignore, track: tracker.trackJSON(),
  } satisfies Saved));

const WHISTLE_SLIDERS: { k: keyof WhistleParams; label: string; min: number; max: number; step: number }[] = [
  { k: 'attack', label: 'Attack (s)', min: 0.01, max: 1.5, step: 0.005 },
  { k: 'tail', label: 'Tail length (s)', min: 0.1, max: 3, step: 0.05 },
  { k: 'release', label: 'End fade (s)', min: 0.02, max: 2, step: 0.01 },
  { k: 'loopStart', label: 'Loop start', min: 0, max: 1, step: 0.005 },
  { k: 'loopEnd', label: 'Loop end', min: 0, max: 1, step: 0.005 },
  { k: 'crossfade', label: 'Crossfade (s)', min: 0.02, max: 0.4, step: 0.005 },
  { k: 'pitch', label: 'Pitch', min: 0.5, max: 2, step: 0.01 },
  { k: 'volume', label: 'Volume', min: 0, max: 1, step: 0.01 },
];

type TS = { k: keyof TrainSettings; label: string; min: number; max: number; step: number };
const TRAIN_SLIDERS: TS[] = [
  { k: 'fullSpeed', label: 'Full speed (frame-w/s)', min: 0.05, max: 1, step: 0.01 },
  { k: 'minRate', label: 'Chuffs/s at crawl', min: 0.5, max: 4, step: 0.1 },
  { k: 'maxRate', label: 'Chuffs/s at full', min: 3, max: 12, step: 0.1 },
  { k: 'stopSpeed', label: 'Stopped below', min: 0.005, max: 0.15, step: 0.005 },
  { k: 'stopDelay', label: 'Stop delay (s)', min: 0.3, max: 3, step: 0.1 },
  { k: 'curveThr', label: 'Curve sensitivity (low = more)', min: 0.3, max: 6, step: 0.1 },
  { k: 'panAmt', label: 'Stereo width (pan)', min: 0, max: 1, step: 0.01 },
  { k: 'perWagon', label: 'Wagon length vs engine', min: 0.2, max: 1.8, step: 0.05 },
];

/** the mixing desk: one fader per kind of sound */
const MIX_SLIDERS: TS[] = [
  { k: 'chuffVol', label: 'Chuffing', min: 0, max: 3, step: 0.01 },
  { k: 'steamVol', label: 'Steam release', min: 0, max: 2, step: 0.01 },
  { k: 'idleVol', label: 'Standing (idle)', min: 0, max: 2, step: 0.01 },
  { k: 'rollVol', label: 'Wagon clatter', min: 0, max: 2, step: 0.01 },
  { k: 'squealVol', label: 'Curve squeal', min: 0, max: 1, step: 0.01 },
  { k: 'rockVol', label: 'Stones', min: 0, max: 1.5, step: 0.01 },
];

// ---- cream-faced gauge: 270 degree sweep, numerals 0..max ----
function gaugeSvg(max: number, label: string): string {
  const ticks: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const a = (-135 + (270 * i) / 20) * (Math.PI / 180);
    const major = i % 5 === 0;
    const r1 = major ? 36 : 40, r2 = 45;
    ticks.push(`<line x1="${50 + r1 * Math.sin(a)}" y1="${50 - r1 * Math.cos(a)}" x2="${50 + r2 * Math.sin(a)}" y2="${50 - r2 * Math.cos(a)}" stroke="#1a1612" stroke-width="${major ? 1.8 : 0.9}"/>`);
    if (major) {
      const rn = 29;
      ticks.push(`<text x="${50 + rn * Math.sin(a)}" y="${50 - rn * Math.cos(a) + 3}" text-anchor="middle" font-size="8" font-family="Georgia,serif" fill="#1a1612">${Math.round((max * i) / 20)}</text>`);
    }
  }
  return `<svg viewBox="0 0 100 100" class="dial">
    <circle cx="50" cy="50" r="49" fill="url(#brass)"/><circle cx="50" cy="50" r="45.5" fill="#f1e8cc"/>
    ${ticks.join('')}
    <text x="50" y="68" text-anchor="middle" font-size="7.5" letter-spacing="1" font-family="'Gill Sans','Gill Sans MT',sans-serif" fill="#8a2a22">${label}</text>
    <g class="needle"><polygon points="49,52 51,52 50.3,14 49.7,14" fill="#8a2a22"/><circle cx="50" cy="50" r="3.2" fill="#1a1612"/></g>
  </svg>`;
}

const app = document.getElementById('app')!;
app.innerHTML = `
<svg width="0" height="0" style="position:absolute"><defs>
  <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3dc92"/><stop offset=".45" stop-color="#b98f2e"/><stop offset=".7" stop-color="#e2c36a"/><stop offset="1" stop-color="#8d6a1c"/></linearGradient>
</defs></svg>
<div class="loco">
  <header class="nameplate-bar">
    <div class="nameplate"><small>Locomotive Sound Control</small><h1>The Footplate</h1></div>
    <div class="start-group">
      <button id="start" class="brass-btn big">Start engine</button>
      <button id="sound" class="brass-btn small" title="Sound on / off (M)" aria-pressed="false">Sound: on</button>
      <label class="reg"><span>Regulator</span> <input id="master" type="range" min="0" max="1" step="0.01" value="0.8"></label>
    </div>
  </header>

  <section class="signalbox panel slim">
    <div class="tag">Signal Box</div>
    <div class="sb-body">
      <span id="midi-status">MIDI: …</span>
      <button id="midi-btn" class="enamel">Connect MIDI</button>
      <div class="lever" role="group" aria-label="Whistle mode">
        <span>Whistles</span>
        <button id="mode-hold" class="seg">Hold</button><button id="mode-oneshot" class="seg">One-shot</button>
      </div>
    </div>
    <div id="midi-monitor">Telegraph: nothing received yet</div>
  </section>

  <main>
    <section id="cam" class="panel">
      <div class="tag">Track Diagram</div>
      <div class="row">
        <select id="device"></select>
        <button id="cam-start" class="enamel">Start camera</button>
        <button id="demo-btn" class="enamel">Demo train</button>
        <button id="demo-wag" class="enamel" title="Wagons the demo train pulls (for trying the wagon sounds)">Demo wagons: 0</button>
      </div>
      <div id="phone-box" class="phone-box" hidden>
        <div id="phone-status">Pick Start camera, then open the address on the phone.</div>
        <div id="phone-urls" class="mono"></div>
        <div class="mini">The phone will warn the page is not private (it is your own computer): tap Advanced, then Proceed. Allow the camera when asked.</div>
      </div>
      <div class="onTrack">
        <span class="mini">Trains running at once</span>
        <div id="train-count" class="seg-group"></div>
      </div>
      <div id="slots"></div>
      <div class="window">
        <div class="video">
          <canvas id="scene"></canvas>
          <video id="video" playsinline muted></video>
          <canvas id="diff"></canvas>
          <canvas id="overlay" width="640" height="480"></canvas>
        </div>
      </div>
      <div class="lamps">
        <span class="lamp" id="lamp-run">Running</span>
        <span class="lamp" id="lamp-stop">Stopped</span>
        <span class="lamp" id="lamp-tunnel">Tunnel</span>
        <span class="lamp" id="lamp-curve">Curve</span>
      </div>
      <div class="gauges">
        <div class="gauge" id="g-speed">${gaugeSvg(10, 'SPEED')}</div>
        <div class="gauge" id="g-chuff">${gaugeSvg(12, 'CHUFFS')}</div>
        <div class="gauge" id="g-squeal">${gaugeSvg(10, 'CURVE')}</div>
      </div>
      <div id="readout">Awaiting orders</div>
      <details><summary>Stereo</summary>
        <div class="onTrack">
          <span class="mini">The sound pans toward the listener's right when the train is toward the camera picture's</span>
          <select id="pan-dir">
            <option value="0">right side</option><option value="1">bottom</option><option value="2">left side</option><option value="3">top</option>
          </select>
        </div>
      </details>
      <details open><summary>Tracking, zones and delay</summary>
        <div class="mini">Drag a box on the picture to draw the selected zone. Tunnel zones muffle the sound. Ignore zones are never searched for trains (where people sit).</div>
        <div class="row">
          <select id="zone-kind"><option value="tunnel">Tunnel zones</option><option value="ignore">Ignore zones</option></select>
          <select id="zone-idx"></select>
          <button id="zone-add" class="enamel">Add</button><button id="zone-del" class="enamel">Delete</button>
        </div>
        <div class="row"><button id="track-learn" class="enamel">Learn the track</button><button id="track-clear" class="enamel">Forget the track</button></div>
        <div id="track-info" class="mini"></div>
        <label class="check"><input id="auto-lag" type="checkbox"> Measure the phone link's delay automatically</label>
        <div id="trk-sliders" class="sl"></div>
      </details>
      <details><summary>Engine room</summary><div id="train-sliders" class="sl"></div></details>
    </section>

    <div class="col">
      <section id="mixer" class="panel">
        <div class="tag">Mixing Desk</div>
        <div id="mix-sliders" class="sl"></div>
        <div class="mini mixhead">Countryside</div>
        <label class="check"><input id="env-on" type="checkbox"> Ambience</label>
        <div id="env-sliders" class="sl"></div>
        <div class="mini mixhead">Inside a tunnel</div>
        <div id="tun-sliders" class="sl"></div>
      </section>
      <section id="whistles" class="panel">
        <div class="tag">Whistles</div>
        <div id="engines"></div>
      </section>

    </div>
  </main>
  <footer>Sounds from the BBC Rewind archive, licensed for personal use.</footer>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- generic slider helper ----
function slider(host: HTMLElement, label: string, min: number, max: number, step: number, value: number, on: (v: number) => void) {
  const l = document.createElement('label');
  l.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output>${value}</output>`;
  const inp = l.querySelector('input')!;
  const out = l.querySelector('output')!;
  const show = () => (out.textContent = Number(inp.value).toFixed(step < 0.01 ? 3 : 2));
  show();
  inp.addEventListener('input', () => { on(Number(inp.value)); show(); persist(); });
  host.appendChild(l);
  return { set: (v: number) => { inp.value = String(v); show(); } };
}

const trk = $('trk-sliders');
slider(trk, 'Latency compensation (s)', 0, 1, 0.01, trainSettings.lead, (v) => (trainSettings.lead = v));
slider(trk, 'Hold when hidden by a prop (s)', 0.5, 15, 0.5, trainSettings.holdTime, (v) => (trainSettings.holdTime = v));
slider(trk, 'Motion threshold', 8, 80, 1, tracker.threshold, (v) => (tracker.threshold = v));
slider(trk, 'Smallest train (px)', 6, 200, 1, tracker.minArea, (v) => (tracker.minArea = v));
slider(trk, 'Largest train (% of picture)', 0.5, 15, 0.5, tracker.maxFrac * 100, (v) => (tracker.maxFrac = v / 100));
slider(trk, 'Tunnel fade-in zone', 0.02, 0.4, 0.01, tracker.ramp, (v) => (tracker.ramp = v));
slider(trk, 'Hold inside a tunnel (s)', 5, 40, 1, tracker.hiddenTimeout, (v) => (tracker.hiddenTimeout = v));
const autoLagEl = $('auto-lag') as HTMLInputElement;
autoLagEl.checked = autoLag;
autoLagEl.addEventListener('change', () => { autoLag = autoLagEl.checked; persist(); });
for (const s of TRAIN_SLIDERS) slider($('train-sliders'), s.label, s.min, s.max, s.step, trainSettings[s.k], (v) => { trainSettings[s.k] = v; });

// ---- mixing desk ----
const mixHost = $('mix-sliders');
slider(mixHost, 'Whistles', 0, 2, 0.01, mix.whistle, (v) => { mix.whistle = v; audio.setWhistleLevel(v); });
for (const s of MIX_SLIDERS) slider(mixHost, s.label, s.min, s.max, s.step, trainSettings[s.k], (v) => { trainSettings[s.k] = v; sounds.forEach((t) => t.refresh()); });
slider(mixHost, 'Room reverb', 0, 3, 0.01, mix.room, (v) => { mix.room = v; audio.setRoom(v); });
const tunHost = $('tun-sliders');
slider(tunHost, 'Level inside (1 = same as outside)', 0, 1, 0.01, tunnelCfg.vol, (v) => audio.setTunnelCfg({ vol: v }));
slider(tunHost, 'Muffle: top cut-off (Hz)', 150, 3000, 10, tunnelCfg.cut, (v) => audio.setTunnelCfg({ cut: v }));
slider(tunHost, 'Boom cut: bottom cut-off (Hz)', 20, 500, 5, tunnelCfg.lowCut, (v) => audio.setTunnelCfg({ lowCut: v }));
slider(tunHost, 'Tunnel echo', 0, 1.5, 0.01, tunnelCfg.verb, (v) => audio.setTunnelCfg({ verb: v }));

// ---- countryside ----
function applyEnv() {
  audio.setEnvGroup('birds', env.on ? env.birds : 0);
  audio.setEnvGroup('wind', env.on ? env.wind : 0);
  audio.setEnvGroup('people', env.on ? env.people : 0);
}
slider($('env-sliders'), 'Birds', 0, 1, 0.01, env.birds, (v) => { env.birds = v; applyEnv(); });
slider($('env-sliders'), 'Wind and trees', 0, 1, 0.01, env.wind, (v) => { env.wind = v; applyEnv(); });
slider($('env-sliders'), 'People', 0, 1, 0.01, env.people, (v) => { env.people = v; applyEnv(); });
const envOn = $('env-on') as HTMLInputElement;
envOn.checked = env.on;
envOn.addEventListener('change', () => { env.on = envOn.checked; applyEnv(); persist(); });

// ---- whistle cards ----
const engBox = $('engines');
const sliderSetters: Record<string, Record<string, (v: number) => void>> = {};
for (const e of ENGINES) {
  const card = document.createElement('div');
  card.className = 'card';
  card.id = `card-${e.id}`;
  card.innerHTML = `
    <div class="cabplate"><span class="pl">${e.plate}</span><strong>${e.name}</strong></div>
    <div class="card-ctl">
      <button class="pull hold" data-id="${e.id}" aria-label="Blow ${e.name} whistle"><span>Pull</span></button>
      <div class="card-info">
        <small>${e.note} (${e.sample})</small>
        <div class="seg-group"><button class="seg m-hold" data-id="${e.id}">Hold</button><button class="seg m-one" data-id="${e.id}">One-shot</button></div>
        <div class="bind">
          Key <button class="enamel bind-key" data-id="${e.id}"></button>
          MIDI <button class="enamel bind-midi" data-id="${e.id}"></button>
        </div>
      </div>
    </div>
    <canvas class="wave" width="480" height="56"></canvas>
    <div class="loopinfo"></div>
    <details><summary>Voicing</summary><div class="sl"></div><button class="enamel auto" data-id="${e.id}">Auto loop</button></details>`;
  engBox.appendChild(card);
  sliderSetters[e.id] = {};
  const host = card.querySelector<HTMLElement>('.sl')!;
  for (const s of WHISTLE_SLIDERS) {
    const h = slider(host, s.label, s.min, s.max, s.step, params[e.id][s.k] as number, (v) => {
      (params[e.id][s.k] as number) = v;
      if (s.k === 'loopStart' || s.k === 'loopEnd') params[e.id].auto = false;
      audio.whistleUpdate(e, params[e.id]);
      drawWave(e.id);
      scheduleInfo(e.id);
    });
    sliderSetters[e.id][s.k] = h.set;
  }
}

const infoTimers: Record<string, number> = {};
function scheduleInfo(id: string) {
  clearTimeout(infoTimers[id]);
  infoTimers[id] = window.setTimeout(() => updateInfo(id), 250);
}
function updateInfo(id: string) {
  const e = ENGINES.find((x) => x.id === id)!;
  if (!audio.buffers.has(e.sample)) return;
  const prep = audio.prepare(e, params[id]);
  $(`card-${id}`).querySelector('.loopinfo')!.textContent =
    `sustain ${(prep.leS - prep.lsS).toFixed(2)} s of source, joins blend ${(prep.xfS * 1000).toFixed(0)} ms, join match ${(Math.max(0, prep.match) * 100).toFixed(0)}%`;
}

function drawWave(id: string) {
  const e = ENGINES.find((x) => x.id === id)!;
  const buf = audio.buffers.get(e.sample);
  if (!buf) return;
  const cv = $(`card-${id}`).querySelector<HTMLCanvasElement>('canvas.wave')!;
  const g = cv.getContext('2d')!;
  const { width: W, height: H } = cv;
  g.clearRect(0, 0, W, H);
  const r = audio.region(e.sample);
  const x = r.mono;
  const px = (t: number) => (t / buf.duration) * W;
  const p = params[id];
  const lsT = r.a + p.loopStart * (r.b - r.a);
  const leT = r.a + p.loopEnd * (r.b - r.a);
  g.fillStyle = 'rgba(200,162,74,0.28)';
  g.fillRect(px(lsT), 0, px(leT) - px(lsT), H);
  const per = Math.floor(x.length / W);
  for (let c = 0; c < W; c++) {
    let m = 0;
    for (let i = 0; i < per; i += 8) m = Math.max(m, Math.abs(x[c * per + i]));
    const t = (c / W) * buf.duration;
    g.fillStyle = t < r.a || t > r.b ? '#3d5a47' : '#efe4c4';
    const hh = Math.max(1, m * H * 0.95);
    g.fillRect(c, (H - hh) / 2, 1, hh);
  }
  g.fillStyle = '#c8a24a';
  g.fillRect(px(lsT), 0, 1.5, H);
  g.fillRect(px(leT), 0, 1.5, H);
}

function applyAuto(id: string) {
  const e = ENGINES.find((x) => x.id === id)!;
  const { start, end } = audio.autoLoopFor(e);
  params[id].loopStart = start; params[id].loopEnd = end; params[id].auto = true;
  sliderSetters[id].loopStart(start); sliderSetters[id].loopEnd(end);
  persist(); drawWave(id); updateInfo(id);
}

function refreshLabels() {
  for (const e of ENGINES) {
    const b = bindings[e.id];
    const card = $(`card-${e.id}`);
    card.querySelector<HTMLButtonElement>('.bind-key')!.textContent = learning === `k:${e.id}` ? 'press key…' : b.key === ' ' ? 'Space' : b.key;
    card.querySelector<HTMLButtonElement>('.bind-midi')!.textContent = learning === `m:${e.id}` ? 'hit a note…' : b.note === null ? 'learn' : `note ${b.note}`;
    card.querySelector('.m-hold')!.classList.toggle('active', !params[e.id].oneShot);
    card.querySelector('.m-one')!.classList.toggle('active', params[e.id].oneShot);
  }
  $('mode-hold').classList.toggle('active', ENGINES.every((e) => !params[e.id].oneShot));
  $('mode-oneshot').classList.toggle('active', ENGINES.every((e) => params[e.id].oneShot));
}
refreshLabels();

function setMode(id: string, oneShot: boolean) {
  if (audio.isHeld(id)) release(id);
  params[id].oneShot = oneShot;
}

engBox.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const id = t.dataset.id;
  if (!id) return;
  if (t.classList.contains('bind-key')) learning = `k:${id}`;
  if (t.classList.contains('bind-midi')) learning = `m:${id}`;
  if (t.classList.contains('auto') && audio.buffers.size) applyAuto(id);
  if (t.classList.contains('m-hold')) { setMode(id, false); persist(); }
  if (t.classList.contains('m-one')) { setMode(id, true); persist(); }
  refreshLabels();
});
$('mode-hold').addEventListener('click', () => { ENGINES.forEach((e) => setMode(e.id, false)); persist(); refreshLabels(); });
$('mode-oneshot').addEventListener('click', () => { ENGINES.forEach((e) => setMode(e.id, true)); persist(); refreshLabels(); });

// ---- whistle triggering (shared by mouse, key, MIDI) ----
function press(id: string, velocity = 1) {
  if (audio.muted) return;
  const e = ENGINES.find((x) => x.id === id)!;
  void audio.resume();
  const card = $(`card-${id}`);
  if (params[id].oneShot) {
    audio.whistleOneShot(e, params[id], velocity);
    card.classList.add('on');
    setTimeout(() => card.classList.remove('on'), 350);
    return;
  }
  audio.whistleOn(e, params[id], velocity);
  card.classList.add('on');
}
function release(id: string) {
  if (params[id].oneShot) return;
  const e = ENGINES.find((x) => x.id === id)!;
  audio.whistleOff(e, params[id]);
  $(`card-${id}`).classList.remove('on');
}

engBox.addEventListener('pointerdown', (ev) => {
  const t = (ev.target as HTMLElement).closest('.pull') as HTMLElement | null;
  if (t) { t.setPointerCapture(ev.pointerId); press(t.dataset.id!); }
});
engBox.addEventListener('pointerup', (ev) => {
  const t = (ev.target as HTMLElement).closest('.pull') as HTMLElement | null;
  if (t) release(t.dataset.id!);
});

window.addEventListener('keydown', (ev) => {
  if (learning?.startsWith('k:')) {
    ev.preventDefault();
    bindings[learning.slice(2)].key = ev.key;
    learning = null; persist(); refreshLabels();
    return;
  }
  const tag = (ev.target as HTMLElement).tagName;
  if (ev.repeat || tag === 'INPUT' || tag === 'SELECT') return;
  if (ev.key.toLowerCase() === 'm' && !ENGINES.some((x) => bindings[x.id].key === ev.key)) { ev.preventDefault(); void toggleSound(); return; }
  const e = ENGINES.find((x) => bindings[x.id].key === ev.key);
  if (e) { ev.preventDefault(); press(e.id); }
});
window.addEventListener('keyup', (ev) => {
  const e = ENGINES.find((x) => bindings[x.id].key === ev.key);
  if (e) release(e.id);
});
window.addEventListener('blur', () => ENGINES.forEach((e) => audio.isHeld(e.id) && release(e.id)));

// ---- MIDI ----
let midiAccess: MIDIAccess | null = null;
const midiNames = (a: MIDIAccess) => [...a.inputs.values()].map((i) => i.name ?? i.id);

async function initMidi() {
  const st = $('midi-status');
  if (!('requestMIDIAccess' in navigator)) { st.textContent = 'MIDI: this browser has no Web MIDI. Use Chrome or Edge (Safari and Firefox do not support it).'; return; }
  if (!window.isSecureContext) { st.textContent = `MIDI: blocked on ${location.origin}. Open http://localhost:5173 on this computer (a LAN address is not allowed).`; return; }
  st.textContent = 'MIDI: asking for access… allow the browser prompt';
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
  } catch (err) {
    st.textContent = `MIDI: access refused (${(err as Error).name}). Click the lock icon in the address bar, allow MIDI, then press Connect MIDI.`;
    return;
  }
  const hook = () => {
    const a = midiAccess!;
    a.inputs.forEach((inp) => { inp.onmidimessage = onMidi; });
    const names = midiNames(a);
    st.textContent = names.length ? `MIDI: ${names.join(', ')}` : 'MIDI: allowed, but no input device found. Plug in or turn on the keyboard, then press Connect MIDI.';
  };
  midiAccess.onstatechange = hook;
  hook();
}

function onMidi(m: MIDIMessageEvent) {
  if (!m.data) return;
  const [status, d1, d2] = m.data;
  const cmd = status & 0xf0;
  const on = cmd === 0x90 && d2 > 0;
  const off = cmd === 0x80 || (cmd === 0x90 && d2 === 0);
  if (cmd !== 0xf0 && status !== 0xfe) {
    const src = (m.target as MIDIInput | null)?.name ?? '';
    $('midi-monitor').textContent = `Telegraph: ${on ? 'note on' : off ? 'note off' : cmd === 0xb0 ? 'CC' : '0x' + status.toString(16)} ${d1} ${d2 ?? ''} ch${(status & 15) + 1} ${src}`;
  }
  if (on && learning?.startsWith('m:')) {
    bindings[learning.slice(2)].note = d1;
    learning = null; persist(); refreshLabels();
    return;
  }
  const e = ENGINES.find((x) => bindings[x.id].note === d1);
  if (!e) return;
  if (on) press(e.id, 0.4 + (d2 / 127) * 0.6);
  else if (off) release(e.id);
}
$('midi-btn').addEventListener('click', () => void initMidi());
void initMidi();

// ---- camera + tracking ----
const video = $('video') as HTMLVideoElement;
const diff = $('diff') as HTMLCanvasElement;
const scene = $('scene') as HTMLCanvasElement;
const sceneCtx = scene.getContext('2d')!;
const overlay = $('overlay') as HTMLCanvasElement;
const diffCtx = diff.getContext('2d')!;
const ovCtx = overlay.getContext('2d')!;
const deviceSel = $('device') as HTMLSelectElement;
const phoneBox = $('phone-box');
const videoBox = document.querySelector<HTMLElement>('.video')!;
let stopSource: (() => void) | null = null;
let frame = 0;
let lastFrameAt = 0;
let linkDelay = 0;          // measured delay of the phone link, seconds (0 = unknown)

const QUIET: Track = { id: 0, present: false, hidden: false, x: 0.5, y: 0.375, speed: 0, tunnel: 0, turn: 0, area: 0, len: 0 };
const effectiveLead = () => (autoLag && linkDelay > 0 ? Math.max(0.1, Math.min(0.9, linkDelay + 0.12)) : trainSettings.lead);

async function listDevices() {
  const keep = deviceSel.value;
  let devs: MediaDeviceInfo[] = [];
  try {
    devs = ((await navigator.mediaDevices?.enumerateDevices()) ?? []).filter((d) => d.kind === 'videoinput');
  } catch { /* no camera API on this page */ }
  deviceSel.innerHTML =
    '<option value="phone">Phone over Wi-Fi (Samsung S9+)</option><option value="file">A recorded video file (to test the tracking)</option>' +
    devs.map((d, i) => `<option value="${d.deviceId}">${d.label || `Camera ${i + 1}`}</option>`).join('');
  if ([...deviceSel.options].some((o) => o.value === keep)) deviceSel.value = keep;
}

async function showPhoneInfo() {
  const on = deviceSel.value === 'phone';
  phoneBox.hidden = !on;
  if (!on) return;
  const urls = await phoneUrls();
  $('phone-urls').textContent = urls.length
    ? urls.join('    ')
    : "Could not read this computer's address. The Terminal running npm run dev prints the phone address.";
}
deviceSel.addEventListener('change', () => void showPhoneInfo());

function step(src: CanvasImageSource, at?: number) {
  const now = at ?? performance.now() / 1000;
  lastFrameAt = now;
  tracker.curveThr = trainSettings.curveThr;
  tracker.lead = effectiveLead();
  tracker.holdTime = trainSettings.holdTime;
  tracker.stopSpeed = trainSettings.stopSpeed;
  const tracks = tracker.process(src, now);
  for (let i = 0; i < SLOTS; i++) {
    const tr = tracks[i] ?? QUIET;
    sounds[i].update(tr, now);
    const counted = wagonEsts[i].update(tr, now, trainSettings.perWagon);
    const m = wagonModes[i];
    sounds[i].wagons = m === 'auto' ? (wagonEsts[i].calibrated && !wagonEsts[i].learning ? counted : 0) : m;
  }
  // the screen only needs ~10 updates a second; the analysis and the sound still run on every frame
  if (++frame % 3 === 0) {
    if (src instanceof HTMLCanvasElement) {
      if (scene.width !== src.width) { scene.width = src.width; scene.height = src.height; }
      sceneCtx.drawImage(src, 0, 0);
    }
    render(tracks);
  }
}

const needleEls = new Map<string, SVGGElement>();
const needleAt = new Map<string, number>();
function needle(id: string, v01: number) {
  const a = Math.round((-135 + 270 * Math.max(0, Math.min(1, v01))) * 2) / 2;
  if (needleAt.get(id) === a) return;
  needleAt.set(id, a);
  let g = needleEls.get(id);
  if (!g) { g = $(id).querySelector<SVGGElement>('.needle')!; needleEls.set(id, g); }
  g.style.transform = `rotate(${a}deg)`;
  g.style.transformOrigin = '50px 50px';
}

const SLOT_COLOURS = ['#7be08a', '#7bc8ff'];
let lastReadout = '';
let zoneKind: 'tunnel' | 'ignore' = 'tunnel';
let zoneIdx = 0;

function render(tracks: Track[]) {
  // the picture's shape follows the camera (phone video is usually 16:9)
  const oh = Math.round(640 * tracker.aspect);
  if (overlay.height !== oh) {
    overlay.height = oh;
    videoBox.style.aspectRatio = `1 / ${tracker.aspect}`;
  }
  if (diff.width !== tracker.w || diff.height !== tracker.h) { diff.width = tracker.w; diff.height = tracker.h; }
  diffCtx.clearRect(0, 0, diff.width, diff.height);
  diffCtx.drawImage(tracker.diffCanvas, 0, 0);
  const W = overlay.width, H = overlay.height;
  ovCtx.clearRect(0, 0, W, H);
  const tmax = tracks.reduce((m, t) => Math.max(m, t.tunnel), 0);
  ovCtx.font = '600 13px "Gill Sans", sans-serif';
  tracker.tunnels.forEach((t, i) => {
    const sel = zoneKind === 'tunnel' && i === zoneIdx;
    ovCtx.fillStyle = `rgba(20,40,30,${0.22 + 0.3 * tmax})`;
    ovCtx.fillRect(t.x0 * W, t.y0 * H, (t.x1 - t.x0) * W, (t.y1 - t.y0) * H);
    ovCtx.strokeStyle = '#c8a24a'; ovCtx.lineWidth = sel ? 3 : 1.5;
    ovCtx.setLineDash([6, 4]);
    ovCtx.strokeRect(t.x0 * W, t.y0 * H, (t.x1 - t.x0) * W, (t.y1 - t.y0) * H);
    ovCtx.setLineDash([]);
    ovCtx.fillStyle = '#efe4c4';
    ovCtx.fillText(`TUNNEL ${i + 1}`, t.x0 * W + 6, t.y0 * H + 16);
  });
  tracker.ignore.forEach((t, i) => {
    const sel = zoneKind === 'ignore' && i === zoneIdx;
    ovCtx.fillStyle = 'rgba(168,50,42,0.22)';
    ovCtx.fillRect(t.x0 * W, t.y0 * H, (t.x1 - t.x0) * W, (t.y1 - t.y0) * H);
    ovCtx.strokeStyle = '#e45a4c'; ovCtx.lineWidth = sel ? 3 : 1.5;
    ovCtx.setLineDash([3, 4]);
    ovCtx.strokeRect(t.x0 * W, t.y0 * H, (t.x1 - t.x0) * W, (t.y1 - t.y0) * H);
    ovCtx.setLineDash([]);
    ovCtx.fillStyle = '#f2b0a8';
    ovCtx.fillText(`IGNORE ${i + 1}`, t.x0 * W + 6, t.y0 * H + 16);
  });
  ovCtx.lineWidth = 1;
  // what looked like a train this frame, and the trains being followed
  ovCtx.strokeStyle = 'rgba(255,230,120,0.55)';
  const sx = W / tracker.w, sy = H / tracker.h;
  for (const c of tracker.comps) ovCtx.strokeRect(c.x0 * sx, c.y0 * sy, (c.x1 - c.x0) * sx, (c.y1 - c.y0) * sy);
  tracks.forEach((t, i) => {
    const px = t.x * W, py = (t.y / tracker.aspect) * H;
    ovCtx.strokeStyle = SLOT_COLOURS[i];
    ovCtx.lineWidth = 2;
    ovCtx.setLineDash(t.present ? [] : [4, 3]);
    ovCtx.strokeRect(px - 14, py - 11, 28, 22);
    ovCtx.setLineDash([]);
    ovCtx.fillStyle = SLOT_COLOURS[i];
    ovCtx.fillText(`${i + 1} ${ENGINES.find((e) => e.id === sounds[i].engine)!.name}${t.present ? '' : t.hidden ? ' (out of sight)' : ' (stopped)'}`, px - 14, py - 15);
  });
  ovCtx.lineWidth = 1;

  const lead = tracks[0] ?? QUIET;
  needle('g-speed', lead.speed / (trainSettings.fullSpeed * 1.2));
  needle('g-chuff', sounds[0].rate / 12);
  needle('g-squeal', Math.min(1, lead.turn));
  $('lamp-run').classList.toggle('lit', sounds.some((s) => s.mode === 'moving'));
  $('lamp-stop').classList.toggle('lit', sounds.every((s) => s.mode === 'stopped'));
  $('lamp-tunnel').classList.toggle('lit', tmax > 0.5);
  $('lamp-curve').classList.toggle('lit', tracks.some((t) => t.turn > 0.25));

  const lines = sounds.map((s, i) => {
    const t = tracks[i];
    const name = ENGINES.find((e) => e.id === s.engine)!.name;
    if (!t) return `${i + 1} ${name}: no train followed yet`;
    const state = t.hidden ? 'out of sight, still running' : t.present ? 'tracking' : 'stopped';
    return `${i + 1} ${name}: ${s.mode.toUpperCase()} · ${state} · speed ${t.speed.toFixed(2)} · chuffs ${s.rate.toFixed(1)}/s · muffle ${(t.tunnel * 100).toFixed(0)}% · pan ${s.pan.toFixed(2)} · wagons ${s.wagons}`;
  });
  lines.push(`latency compensation ${effectiveLead().toFixed(2)} s${autoLag && linkDelay > 0 ? ` (phone link ~${Math.round(linkDelay * 1000)} ms + 120 ms)` : ''}`);
  const text = lines.join('\n');
  if (text !== lastReadout) { lastReadout = text; $('readout').textContent = text; }
  slotInfo(tracks);
  trackInfo();
  (window as unknown as { __train: unknown }).__train = {
    tracks, slots: sounds.map((s) => ({ engine: s.engine, mode: s.mode, rate: s.rate, pan: s.pan, wagons: s.wagons })),
    chuffs: audio.chuffCount, steams: sounds.reduce((n, s) => n + s.steams, 0), rocks: audio.rockCount, clacks: audio.clackCount, lead: effectiveLead(),
  };
}

function begin(stop: () => void) {
  stopSource?.();
  tracker.reset();
  wagonEsts.forEach((w) => w.reset());
  stopSource = () => { stop(); sounds.forEach((s) => s.stop()); };
  void audio.resume();
  sounds.forEach((s) => s.start());
}

/** drive step() from the <video>; if frames stop arriving (phone dropped, camera froze) the trains are allowed to come to rest */
function runVideo(onStop: () => void) {
  let alive = true;
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };
  let lastCT = -1;
  // next frame: the browser's per-frame callback when it fires, else a short timer (a hidden pane or tab presents no frames)
  const schedule = () => {
    let done = false;
    let to = 0;
    let h = 0;
    const run = () => {
      if (done) return;
      done = true;
      clearTimeout(to);
      v.cancelVideoFrameCallback?.(h);
      tick();
    };
    h = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(run) : 0;
    to = window.setTimeout(run, 50);
  };
  const tick = () => {
    if (!alive) return;
    if (video.currentTime !== lastCT) { lastCT = video.currentTime; step(video); } // never analyse the same frame twice
    schedule();
  };
  const watchdog = window.setInterval(() => {
    const now = performance.now() / 1000;
    if (now - lastFrameAt > 1.5) sounds.forEach((s) => s.update(QUIET, now));
  }, 500);
  begin(() => { alive = false; clearInterval(watchdog); linkDelay = 0; onStop(); });
  lastFrameAt = performance.now() / 1000;
  tick();
}

/** play a recorded video through the same tracking, looping, in place of a live camera */
function playVideo(url: string, manual = false) {
  video.srcObject = null;
  video.src = url;
  video.muted = true;
  video.loop = true;
  const off = () => { video.pause(); video.removeAttribute('src'); video.load(); };
  if (manual) { begin(off); return; }   // the caller feeds frames with __stepVideo
  void video.play();
  runVideo(off);
}
(window as unknown as { __playVideo: (u: string, manual?: boolean) => void }).__playVideo = playVideo;
/** test hook: analyse the recorded video frame at time t, frame by frame, on a clock of its own (deterministic, any speed) */
(window as unknown as { __stepVideo: (t: number) => Promise<void> }).__stepVideo = async (t: number) => {
  video.currentTime = t;
  await new Promise<void>((r) => { video.onseeked = () => r(); });
  step(video, t);
};
const fileIn = document.createElement('input');
fileIn.type = 'file'; fileIn.accept = 'video/*';
fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) playVideo(URL.createObjectURL(f)); });

$('cam-start').addEventListener('click', async () => {
  const id = deviceSel.value;
  if (id === 'file') { fileIn.click(); return; }
  if (id === 'phone') {
    void showPhoneInfo();
    const link = connectPhone(video, (s) => { $('phone-status').textContent = s; }, (d) => { linkDelay = d; });
    runVideo(() => link.stop());
    return;
  }
  try {
    if (!navigator.mediaDevices) throw new Error('the camera is only available on http://localhost:5173 (or https)');
    const stream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id }, width: 640, height: 480 } : { width: 640, height: 480 } });
    video.srcObject = stream;
    await video.play();
    await listDevices();
    runVideo(() => { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; });
  } catch (err) {
    $('readout').textContent = 'Camera failed: ' + (err as Error).message;
  }
});

$('demo-btn').addEventListener('click', () => {
  const demo = startDemo(step, tracker.tunnels[0] ?? { x0: 0, x1: 0.2, y0: 0, y1: 1 }, () => demoWagons);
  begin(demo.stop);
  demo.start();
});
$('demo-wag').addEventListener('click', () => {
  demoWagons = (demoWagons + 1) % 4;
  $('demo-wag').textContent = `Demo wagons: ${demoWagons}`;
});
void listDevices();
void showPhoneInfo();

// ---- trains: which locomotive each followed train is, and its wagons ----
const slotsEl = $('slots');
const WAGON_CHOICES: [string, string][] = [['auto', 'Auto'], ['0', 'None'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4+']];
for (let i = 0; i < SLOTS; i++) {
  const box = document.createElement('div');
  box.className = 'slotbox';
  box.id = `slot-${i}`;
  box.style.borderColor = SLOT_COLOURS[i];
  box.innerHTML = `
    <div class="slot-head"><b style="color:${SLOT_COLOURS[i]}">Train ${i + 1}</b>
      <select class="slot-eng">${ENGINES.map((e) => `<option value="${e.id}">${e.name}</option>`).join('')}</select></div>
    <div class="mini slot-desc"></div>
    <div class="mini">Wagons behind the engine</div>
    <div class="seg-group slot-wag">${WAGON_CHOICES.map(([v, l]) => `<button class="seg" data-v="${v}">${l}</button>`).join('')}</div>
    <div class="mini slot-winfo"></div>
    <div class="row"><button class="enamel slot-learn">Learn engine alone</button></div>`;
  slotsEl.appendChild(box);
}
function paintSlots() {
  for (let i = 0; i < SLOTS; i++) {
    const box = $(`slot-${i}`);
    box.hidden = i >= tracker.maxTargets;
    const e = ENGINES.find((x) => x.id === sounds[i].engine)!;
    (box.querySelector('.slot-eng') as HTMLSelectElement).value = e.id;
    box.querySelector('.slot-desc')!.textContent = e.voice.desc;
    box.querySelectorAll<HTMLButtonElement>('.slot-wag button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(wagonModes[i])));
  }
  for (const e of ENGINES) $(`card-${e.id}`).classList.toggle('track', sounds.some((s, i) => s.engine === e.id && i < tracker.maxTargets));
  document.querySelectorAll<HTMLButtonElement>('#train-count button').forEach((b) => b.classList.toggle('active', Number(b.dataset.n) === tracker.maxTargets));
}
slotsEl.addEventListener('change', (ev) => {
  const sel = ev.target as HTMLSelectElement;
  if (!sel.classList.contains('slot-eng')) return;
  const i = Number(sel.closest('.slotbox')!.id.slice(5));
  const id = sel.value;
  const other = sounds.findIndex((s, j) => j !== i && s.engine === id);
  const mine = sounds[i].engine;
  if (other >= 0) sounds[other].setEngine(mine);   // two slots cannot be the same locomotive: swap
  sounds[i].setEngine(id);
  paintSlots();
  persist();
});
slotsEl.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const i = Number(t.closest('.slotbox')?.id.slice(5));
  if (Number.isNaN(i)) return;
  if (t.matches('.slot-wag button')) {
    const v = t.dataset.v!;
    wagonModes[i] = v === 'auto' ? 'auto' : Number(v);
    paintSlots();
    persist();
  } else if (t.matches('.slot-learn')) {
    const on = !wagonEsts[i].learning;
    wagonEsts[i].learn(on);
    t.textContent = on ? 'Finish learning' : 'Learn engine alone';
    if (!on) persist();
  }
});
const countEl = $('train-count');
for (const n of [1, 2]) {
  const b = document.createElement('button');
  b.className = 'seg'; b.dataset.n = String(n); b.textContent = n === 1 ? 'One train' : 'Two trains';
  countEl.appendChild(b);
}
countEl.addEventListener('click', (ev) => {
  const n = Number((ev.target as HTMLElement).dataset.n);
  if (!n) return;
  tracker.maxTargets = n;
  paintSlots();
  persist();
});
paintSlots();

const lastWinfo: string[] = ['', ''];
function slotInfo(tracks: Track[]) {
  for (let i = 0; i < SLOTS; i++) {
    const w = wagonEsts[i];
    const tr = tracks[i];
    let text: string;
    if (w.learning) text = `Learning the engine alone: ${w.samples} measurements. Run it round the track by itself, then press Finish.`;
    else if (wagonModes[i] !== 'auto') text = `Set by hand: ${wagonModes[i] === 0 ? 'no wagons' : wagonModes[i] + (wagonModes[i] === 1 ? ' wagon' : ' wagons')}.`;
    else if (!w.calibrated) text = 'Auto counts wagons by length. First press Learn, run the engine alone round the track, then press Finish.';
    else text = `Counting by length: ${sounds[i].wagons} ${sounds[i].wagons === 1 ? 'wagon' : 'wagons'} (train is ${w.ratio.toFixed(2)}x the engine's length${tr?.present ? '' : ', last seen'}).`;
    if (text !== lastWinfo[i]) { lastWinfo[i] = text; $(`slot-${i}`).querySelector('.slot-winfo')!.textContent = text; }
  }
}

// ---- stereo ----
const panSel = $('pan-dir') as HTMLSelectElement;
panSel.value = String(trainSettings.panDir);
panSel.addEventListener('change', () => { trainSettings.panDir = Number(panSel.value); persist(); });

// ---- zones: tunnels (muffle) and ignore areas (a person sitting beside the set) ----
const zoneKindSel = $('zone-kind') as HTMLSelectElement;
const zoneIdxSel = $('zone-idx') as HTMLSelectElement;
const zonesOf = () => (zoneKind === 'tunnel' ? tracker.tunnels : tracker.ignore);
function refreshZones() {
  const z = zonesOf();
  zoneIdx = Math.max(0, Math.min(zoneIdx, z.length - 1));
  zoneIdxSel.innerHTML = z.length ? z.map((_, i) => `<option value="${i}">${zoneKind === 'tunnel' ? 'Tunnel' : 'Ignore'} ${i + 1}</option>`).join('') : '<option value="-1">none yet: drag on the picture</option>';
  zoneIdxSel.value = z.length ? String(zoneIdx) : '-1';
}
zoneKindSel.addEventListener('change', () => { zoneKind = zoneKindSel.value as 'tunnel' | 'ignore'; zoneIdx = 0; refreshZones(); });
zoneIdxSel.addEventListener('change', () => { zoneIdx = Math.max(0, Number(zoneIdxSel.value)); });
$('zone-add').addEventListener('click', () => {
  const z = zonesOf();
  z.push(zoneKind === 'tunnel' ? { x0: 0.4, x1: 0.6, y0: 0, y1: 0.25 } : { x0: 0, x1: 0.13, y0: 0, y1: 1 });
  zoneIdx = z.length - 1;
  refreshZones(); persist();
});
$('zone-del').addEventListener('click', () => {
  const z = zonesOf();
  if (z.length) z.splice(zoneIdx, 1);
  refreshZones(); persist();
});
refreshZones();

let drag: { x: number; y: number } | null = null;
const unit = (ev: PointerEvent) => {
  const r = overlay.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) };
};
overlay.style.touchAction = 'none';
overlay.style.cursor = 'crosshair';
overlay.addEventListener('pointerdown', (ev) => { overlay.setPointerCapture(ev.pointerId); drag = unit(ev); });
overlay.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const p = unit(ev);
  if (Math.abs(p.x - drag.x) < 0.02 || Math.abs(p.y - drag.y) < 0.02) return;
  const z = zonesOf();
  if (!z.length) { z.push({ x0: 0, x1: 0, y0: 0, y1: 0 }); zoneIdx = 0; refreshZones(); }
  z[zoneIdx] = { x0: Math.min(drag.x, p.x), x1: Math.max(drag.x, p.x), y0: Math.min(drag.y, p.y), y1: Math.max(drag.y, p.y) };
});
overlay.addEventListener('pointerup', () => { if (drag) persist(); drag = null; });

// ---- learn where the track is, so that a person's hand is never taken for a train ----
$('track-learn').addEventListener('click', () => {
  const on = !tracker.learning;
  tracker.learnTrack(on);
  $('track-learn').textContent = on ? 'Finish learning the track' : 'Learn the track';
  if (!on) persist();
});
$('track-clear').addEventListener('click', () => { tracker.clearTrack(); $('track-learn').textContent = 'Learn the track'; persist(); });
let lastTrackText = '';
function trackInfo() {
  const text = tracker.learning
    ? 'Learning: run the trains round the track while everyone keeps still and out of the picture.'
    : tracker.corridor ? 'Track learned: only motion along it counts as a train.' : 'Track not learned: size and shape rules only. People are kept out with ignore zones.';
  if (text !== lastTrackText) { lastTrackText = text; $('track-info').textContent = text; }
}

// ---- sound on / off ----
async function toggleSound() {
  const off = !audio.muted;
  if (off) ENGINES.forEach((e) => audio.isHeld(e.id) && release(e.id));
  await audio.setMuted(off);
  const b = $('sound');
  b.textContent = off ? 'Sound: off' : 'Sound: on';
  b.classList.toggle('off', off);
  b.setAttribute('aria-pressed', String(off));
}
$('sound').addEventListener('click', () => void toggleSound());

// ---- boot ----
$('start').addEventListener('click', async () => {
  const b = $('start') as HTMLButtonElement;
  b.disabled = true; b.textContent = 'Raising steam…';
  try {
    await audio.resume();
    await audio.load((d, t) => { b.textContent = `Raising steam… ${d}/${t}`; });
    audio.setMaster(Number(($('master') as HTMLInputElement).value));
    audio.setWhistleLevel(mix.whistle);
    audio.setRoom(mix.room);
    for (const e of ENGINES) {
      if (params[e.id].auto) applyAuto(e.id); else { drawWave(e.id); updateInfo(e.id); }
    }
    applyEnv();
    audio.startEnv();
    b.textContent = audio.failed.length ? `Steam up (${audio.failed.length} sounds missing)` : 'Steam up';
    b.classList.add('lit');
    if (audio.failed.length) {
      $('readout').textContent = 'Missing sounds, check public/audio was copied in full: ' + audio.failed.join(' · ');
      console.warn('Missing sounds', audio.failed);
    }
  } catch (err) {
    console.error(err);
    b.disabled = false;
    b.textContent = 'Start engine (failed, click to retry)';
    $('readout').textContent = 'Start failed: ' + (err as Error).message;
  }
});
$('master').addEventListener('input', (e) => audio.setMaster(Number((e.target as HTMLInputElement).value)));
