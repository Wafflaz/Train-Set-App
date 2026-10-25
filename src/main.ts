import './style.css';
import { AudioEngine } from './audio';
import { ENGINES, type WhistleParams } from './engines';
import { TrainTracker, type Track } from './motion';
import { DEFAULT_TRAIN, TrainSound, type TrainSettings } from './train';
import { startDemo } from './demo';
import { WagonEstimator } from './wagons';
import { connectPhone, phoneUrls } from './phone';

interface Binding { key: string; note: number | null }
interface EnvSettings { birds: number; wind: number; people: number; on: boolean }
interface Saved {
  params?: Record<string, WhistleParams>;
  bindings?: Record<string, Binding>;
  train?: Partial<TrainSettings>;
  tunnel?: Partial<TrainTracker['tunnel']>;
  tracker?: { threshold?: number; minArea?: number };
  env?: Partial<EnvSettings>;
  engine?: string;
  wagonMode?: 'auto' | number;
  wagonGrid?: { base?: number[]; cnt?: number[] };
}

const KEY = 'train-app-v3';
const saved: Saved = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '') as Saved; } catch { return {}; }
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
const trainSettings: TrainSettings = { ...DEFAULT_TRAIN, ...saved.train };
const sound = new TrainSound(audio, trainSettings);
const wagonEst = new WagonEstimator();
wagonEst.fromJSON(saved.wagonGrid);
let wagonMode: 'auto' | number = saved.wagonMode ?? 'auto';
let activeEngine = ENGINES.some((e) => e.id === saved.engine) ? saved.engine! : ENGINES[0].id;
let demoWagons = 0;
Object.assign(tracker.tunnel, saved.tunnel);
if (saved.tracker?.threshold) tracker.threshold = saved.tracker.threshold;
if (saved.tracker?.minArea) tracker.minArea = saved.tracker.minArea;
let learning: string | null = null;

const persist = () =>
  localStorage.setItem(KEY, JSON.stringify({
    params, bindings, train: trainSettings, tunnel: tracker.tunnel, env,
    tracker: { threshold: tracker.threshold, minArea: tracker.minArea },
    engine: activeEngine, wagonMode, wagonGrid: wagonEst.toJSON(),
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

const TRAIN_SLIDERS: { k: keyof TrainSettings; label: string; min: number; max: number; step: number }[] = [
  { k: 'fullSpeed', label: 'Full speed (frame-w/s)', min: 0.05, max: 1, step: 0.01 },
  { k: 'minRate', label: 'Chuffs/s at crawl', min: 0.5, max: 4, step: 0.1 },
  { k: 'maxRate', label: 'Chuffs/s at full', min: 3, max: 12, step: 0.1 },
  { k: 'stopSpeed', label: 'Stopped below', min: 0.005, max: 0.15, step: 0.005 },
  { k: 'stopDelay', label: 'Stop delay (s)', min: 0.3, max: 3, step: 0.1 },
  { k: 'chuffVol', label: 'Chuff volume', min: 0, max: 1.5, step: 0.01 },
  { k: 'idleVol', label: 'Idle volume', min: 0, max: 1.5, step: 0.01 },
  { k: 'steamVol', label: 'Steam volume', min: 0, max: 1.5, step: 0.01 },
  { k: 'squealVol', label: 'Curve squeal', min: 0, max: 1, step: 0.01 },
  { k: 'curveThr', label: 'Curve sensitivity (low = more)', min: 0.3, max: 6, step: 0.1 },
  { k: 'rockVol', label: 'Stones volume', min: 0, max: 1.5, step: 0.01 },
  { k: 'rollVol', label: 'Wagon clatter volume', min: 0, max: 1.5, step: 0.01 },
  { k: 'panAmt', label: 'Stereo width (pan)', min: 0, max: 1, step: 0.01 },
  { k: 'perWagon', label: 'Wagon length vs engine', min: 0.4, max: 1.8, step: 0.05 },
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
        <span class="mini">Locomotive on the track</span>
        <div id="engine-pick" class="seg-group"></div>
        <div id="engine-desc" class="mini"></div>
      </div>
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
      <details open><summary>Wagons and stereo</summary>
        <div class="onTrack">
          <span class="mini">Wagons behind the engine</span>
          <div id="wagon-pick" class="seg-group"></div>
          <div id="wagon-info" class="mini"></div>
          <div class="row"><button id="wagon-learn" class="enamel">Learn engine alone</button></div>
        </div>
        <div class="onTrack">
          <span class="mini">Sound pans toward the listener's right when the train is toward the camera picture's</span>
          <select id="pan-dir">
            <option value="0">right side</option><option value="1">bottom</option><option value="2">left side</option><option value="3">top</option>
          </select>
        </div>
      </details>
      <details open><summary>Tracking and tunnel</summary><div class="mini">Drag a box on the picture to mark the tunnel mouth.</div><div id="trk-sliders" class="sl"></div></details>
      <details><summary>Engine room</summary><div id="train-sliders" class="sl"></div></details>
    </section>

    <div class="col">
      <section id="whistles" class="panel">
        <div class="tag">Whistles</div>
        <div id="engines"></div>
      </section>
      <section id="country" class="panel">
        <div class="tag">Countryside</div>
        <label class="check"><input id="env-on" type="checkbox"> Ambience</label>
        <div id="env-sliders" class="sl"></div>
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
slider(trk, 'Motion threshold', 5, 80, 1, tracker.threshold, (v) => (tracker.threshold = v));
slider(trk, 'Min train size (px)', 3, 80, 1, tracker.minArea, (v) => (tracker.minArea = v));
const tunnelSet = {
  x0: slider(trk, 'Tunnel left', 0, 1, 0.01, tracker.tunnel.x0, (v) => (tracker.tunnel.x0 = v)).set,
  x1: slider(trk, 'Tunnel right', 0, 1, 0.01, tracker.tunnel.x1, (v) => (tracker.tunnel.x1 = v)).set,
  y0: slider(trk, 'Tunnel top', 0, 1, 0.01, tracker.tunnel.y0, (v) => (tracker.tunnel.y0 = v)).set,
  y1: slider(trk, 'Tunnel bottom', 0, 1, 0.01, tracker.tunnel.y1, (v) => (tracker.tunnel.y1 = v)).set,
};
slider(trk, 'Muffle fade-in zone', 0.02, 0.4, 0.01, tracker.tunnel.ramp, (v) => (tracker.tunnel.ramp = v));
for (const s of TRAIN_SLIDERS) slider($('train-sliders'), s.label, s.min, s.max, s.step, trainSettings[s.k], (v) => { trainSettings[s.k] = v; });

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
diff.width = tracker.w; diff.height = tracker.h;
const diffCtx = diff.getContext('2d')!;
const ovCtx = overlay.getContext('2d')!;
const deviceSel = $('device') as HTMLSelectElement;
const phoneBox = $('phone-box');
let stopSource: (() => void) | null = null;
let frame = 0;
let lastFrameAt = 0;

async function listDevices() {
  const keep = deviceSel.value;
  let devs: MediaDeviceInfo[] = [];
  try {
    devs = ((await navigator.mediaDevices?.enumerateDevices()) ?? []).filter((d) => d.kind === 'videoinput');
  } catch { /* no camera API on this page */ }
  deviceSel.innerHTML =
    '<option value="phone">Phone over Wi-Fi (Samsung S9+)</option>' +
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

function step(src: CanvasImageSource) {
  const now = performance.now() / 1000;
  lastFrameAt = now;
  tracker.curveThr = trainSettings.curveThr;
  const tr = tracker.process(src, now);
  sound.update(tr, now);
  const counted = wagonEst.update(tr, now, trainSettings.perWagon);
  sound.wagons = wagonMode === 'auto' ? (wagonEst.calibrated && !wagonEst.learning ? counted : 0) : wagonMode;
  // the screen only needs ~10 updates a second; the analysis and the sound still run on every frame
  if (++frame % 3 === 0) {
    if (src instanceof HTMLCanvasElement) {
      if (scene.width !== src.width) { scene.width = src.width; scene.height = src.height; }
      sceneCtx.drawImage(src, 0, 0);
    }
    render(tr);
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

let lastReadout = '';
function render(tr: Track) {
  diffCtx.clearRect(0, 0, diff.width, diff.height);
  diffCtx.drawImage(tracker.diffCanvas, 0, 0);
  const W = overlay.width, H = overlay.height;
  ovCtx.clearRect(0, 0, W, H);
  const t = tracker.tunnel;
  ovCtx.fillStyle = `rgba(20,40,30,${0.25 + 0.3 * tr.tunnel})`;
  ovCtx.fillRect(t.x0 * W, t.y0 * H, (t.x1 - t.x0) * W, (t.y1 - t.y0) * H);
  ovCtx.strokeStyle = '#c8a24a';
  ovCtx.setLineDash([6, 4]);
  ovCtx.strokeRect(t.x0 * W, t.y0 * H, (t.x1 - t.x0) * W, (t.y1 - t.y0) * H);
  ovCtx.setLineDash([]);
  ovCtx.fillStyle = '#efe4c4';
  ovCtx.font = '600 14px "Gill Sans", sans-serif';
  ovCtx.fillText('TUNNEL', t.x0 * W + 6, t.y0 * H + 18);
  if (tr.present && tracker.bbox) {
    const b = tracker.bbox;
    ovCtx.strokeStyle = '#d9772b';
    ovCtx.lineWidth = 2;
    ovCtx.strokeRect((b.x0 / tracker.w) * W, (b.y0 / tracker.h) * H, ((b.x1 - b.x0) / tracker.w) * W, ((b.y1 - b.y0) / tracker.h) * H);
    const sp = tracker.span;
    if (sp) {
      ovCtx.strokeStyle = '#7be08a';
      ovCtx.setLineDash([4, 3]);
      ovCtx.strokeRect((sp.x0 / tracker.w) * W, (sp.y0 / tracker.h) * H, ((sp.x1 - sp.x0) / tracker.w) * W, ((sp.y1 - sp.y0) / tracker.h) * H);
      ovCtx.setLineDash([]);
    }
    ovCtx.lineWidth = 1;
  }
  needle('g-speed', tr.speed / (trainSettings.fullSpeed * 1.2));
  needle('g-chuff', sound.rate / 12);
  needle('g-squeal', Math.min(1, tr.turn));
  $('lamp-run').classList.toggle('lit', sound.mode === 'moving');
  $('lamp-stop').classList.toggle('lit', sound.mode === 'stopped');
  $('lamp-tunnel').classList.toggle('lit', tr.tunnel > 0.5);
  $('lamp-curve').classList.toggle('lit', tr.turn > 0.25);
  const state = tr.hidden ? 'in tunnel (hidden)' : tr.present ? 'tracking' : 'no train seen';
  const text =
    `${sound.mode.toUpperCase()} · ${state} · speed ${tr.speed.toFixed(3)} · chuffs ${sound.rate.toFixed(1)}/s · curve ${(tr.turn * 100).toFixed(0)}% · muffle ${(tr.tunnel * 100).toFixed(0)}% · pan ${sound.pan.toFixed(2)} · wagons ${sound.wagons}`;
  if (text !== lastReadout) { lastReadout = text; $('readout').textContent = text; }
  wagonInfo(tr);
  (window as unknown as { __train: unknown }).__train = {
    tr, mode: sound.mode, rate: sound.rate, chuffs: audio.chuffCount, steams: sound.steams, rocks: audio.rockCount,
    squeal: sound.squeal, pan: sound.pan, wagons: sound.wagons, clacks: audio.clackCount, ratio: wagonEst.ratio, engine: activeEngine,
  };
}

function begin(stop: () => void) {
  stopSource?.();
  tracker.reset();
  wagonEst.reset();
  stopSource = () => { stop(); sound.stop(); };
  void audio.resume();
  sound.start();
}

/** drive step() from the <video>; if frames stop arriving (phone dropped, camera froze) the train is allowed to come to rest */
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
  const quiet: Track = { present: false, hidden: false, x: 0.5, y: 0.375, speed: 0, tunnel: 0, turn: 0, area: 0, len: 0 };
  const watchdog = window.setInterval(() => {
    const now = performance.now() / 1000;
    if (now - lastFrameAt > 1.5) sound.update(quiet, now);
  }, 500);
  begin(() => { alive = false; clearInterval(watchdog); onStop(); });
  lastFrameAt = performance.now() / 1000;
  tick();
}

$('cam-start').addEventListener('click', async () => {
  const id = deviceSel.value;
  if (id === 'phone') {
    void showPhoneInfo();
    const link = connectPhone(video, (s) => { $('phone-status').textContent = s; });
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
  const demo = startDemo(step, tracker.tunnel, () => demoWagons);
  begin(demo.stop);
  demo.start();
});
$('demo-wag').addEventListener('click', () => {
  demoWagons = (demoWagons + 1) % 4;
  $('demo-wag').textContent = `Demo wagons: ${demoWagons}`;
});
void listDevices();
void showPhoneInfo();

// ---- locomotive on the track: its own chuffs, steam release and tone ----
const enginePick = $('engine-pick');
for (const e of ENGINES) {
  const b = document.createElement('button');
  b.className = 'seg';
  b.dataset.id = e.id;
  b.textContent = e.name;
  enginePick.appendChild(b);
}
function applyEngine() {
  const e = ENGINES.find((x) => x.id === activeEngine)!;
  audio.setVoice(e.id);
  sound.beat = e.voice.beat;
  enginePick.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', b.dataset.id === e.id));
  $('engine-desc').textContent = e.voice.desc;
  for (const x of ENGINES) $(`card-${x.id}`).classList.toggle('track', x.id === e.id);
}
enginePick.addEventListener('click', (ev) => {
  const id = (ev.target as HTMLElement).dataset.id;
  if (!id) return;
  activeEngine = id;
  applyEngine();
  persist();
});
applyEngine();

// ---- wagons ----
const wagonPick = $('wagon-pick');
const WAGON_CHOICES: [string, string][] = [['auto', 'Auto'], ['0', 'None'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4+']];
for (const [v, label] of WAGON_CHOICES) {
  const b = document.createElement('button');
  b.className = 'seg';
  b.dataset.v = v;
  b.textContent = label;
  wagonPick.appendChild(b);
}
function applyWagons() {
  wagonPick.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(wagonMode)));
}
wagonPick.addEventListener('click', (ev) => {
  const v = (ev.target as HTMLElement).dataset.v;
  if (!v) return;
  wagonMode = v === 'auto' ? 'auto' : Number(v);
  applyWagons();
  persist();
});
applyWagons();
let lastWagonText = '';
function wagonInfo(tr: Track) {
  let text: string;
  if (wagonEst.learning) text = `Learning the engine alone: ${wagonEst.samples} measurements. Let it run a full lap or two, then press Finish.`;
  else if (wagonMode !== 'auto') text = `Set by hand: ${wagonMode === 0 ? 'no wagons' : wagonMode + (wagonMode === 1 ? ' wagon' : ' wagons')}.`;
  else if (!wagonEst.calibrated) text = 'Auto counts wagons by length. First press Learn, run the engine alone round the track, then press Finish.';
  else text = `Counting by length: ${sound.wagons} ${sound.wagons === 1 ? 'wagon' : 'wagons'} (train is ${wagonEst.ratio.toFixed(2)}x the engine's length${tr.present ? '' : ', last seen'}).`;
  if (text !== lastWagonText) { lastWagonText = text; $('wagon-info').textContent = text; }
}
$('wagon-learn').addEventListener('click', () => {
  const on = !wagonEst.learning;
  wagonEst.learn(on);
  $('wagon-learn').textContent = on ? 'Finish learning' : 'Learn engine alone';
  if (!on) persist();
});
const panSel = $('pan-dir') as HTMLSelectElement;
panSel.value = String(trainSettings.panDir);
panSel.addEventListener('change', () => { trainSettings.panDir = Number(panSel.value); persist(); });

// ---- drag a box on the picture to mark the tunnel mouth ----
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
  const t = tracker.tunnel;
  t.x0 = Math.min(drag.x, p.x); t.x1 = Math.max(drag.x, p.x);
  t.y0 = Math.min(drag.y, p.y); t.y1 = Math.max(drag.y, p.y);
  tunnelSet.x0(t.x0); tunnelSet.x1(t.x1); tunnelSet.y0(t.y0); tunnelSet.y1(t.y1);
});
overlay.addEventListener('pointerup', () => { if (drag) persist(); drag = null; });

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
