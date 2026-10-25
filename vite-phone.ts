// Phone camera link. The phone opens a small HTTPS page (a phone browser only allows its camera on HTTPS),
// this plugin passes the WebRTC handshake between that page and the app on the computer, and the video
// then flows directly phone -> computer over the Wi-Fi. Nothing leaves the local network.
import type { Plugin } from 'vite';
import https from 'node:https';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import selfsigned from 'selfsigned';

const PHONE_PORT = 5174;

interface Signal { id: string; sdp: string }

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  // home networks first
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return out.sort((x, y) => rank(x) - rank(y));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export function phoneLink(): Plugin {
  let offer: Signal | undefined;
  let answer: Signal | undefined;

  const send = (res: ServerResponse, code: number, type: string, body: string) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const json = (res: ServerResponse, v: unknown) => send(res, 200, 'application/json', JSON.stringify(v));

  /** returns true when the request was ours */
  const handle = async (req: IncomingMessage, res: ServerResponse, isPhoneServer: boolean): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/phone' || (isPhoneServer && (p === '/' || p === '/index.html'))) {
      send(res, 200, 'text/html; charset=utf-8', PHONE_PAGE);
      return true;
    }
    if (!p.startsWith('/phone-api/')) return false;
    const route = p.slice('/phone-api/'.length);
    if (route === 'info' && req.method === 'GET') {
      json(res, { port: PHONE_PORT, urls: lanAddresses().map((ip) => `https://${ip}:${PHONE_PORT}/`) });
    } else if (route === 'offer' && req.method === 'POST') {
      const b = await readJson(req);
      if (typeof b.id === 'string' && typeof b.sdp === 'string') { offer = { id: b.id, sdp: b.sdp }; answer = undefined; }
      json(res, { ok: true });
    } else if (route === 'offer') {
      json(res, offer ?? {});
    } else if (route === 'answer' && req.method === 'POST') {
      const b = await readJson(req);
      if (typeof b.id === 'string' && typeof b.sdp === 'string') answer = { id: b.id, sdp: b.sdp };
      json(res, { ok: true });
    } else if (route === 'answer') {
      const id = url.searchParams.get('id');
      json(res, answer && answer.id === id ? answer : {});
    } else {
      send(res, 404, 'text/plain', 'not found');
    }
    return true;
  };

  return {
    name: 'phone-link',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        handle(req, res, false).then((ours) => { if (!ours) next(); }, next);
      });

      const pems = selfsigned.generate([{ name: 'commonName', value: 'train-phone-link' }], { days: 825, keySize: 2048, algorithm: 'sha256' });
      const phoneServer = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
        handle(req, res, true).then((ours) => { if (!ours) send(res, 404, 'text/plain', 'not found'); }, () => send(res, 500, 'text/plain', 'error'));
      });
      phoneServer.on('error', (err: NodeJS.ErrnoException) => {
        console.warn(`\n  Phone link: could not start on port ${PHONE_PORT} (${err.code ?? err.message}). The phone camera option will not work.\n`);
      });
      phoneServer.listen(PHONE_PORT, '0.0.0.0', () => {
        const urls = lanAddresses().map((ip) => `https://${ip}:${PHONE_PORT}/`);
        console.log(`\n  Phone camera: open ${urls[0] ?? `https://<this computer's address>:${PHONE_PORT}/`} in Chrome on the phone\n`);
      });
      server.httpServer?.once('close', () => phoneServer.close());
    },
  };
}

const PHONE_PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phone camera</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif; background: #0b2017; color: #efe4c4; min-height: 100vh; display: flex; flex-direction: column; }
  header { padding: 14px 16px 6px; }
  h1 { margin: 0; font: 700 20px Georgia, serif; letter-spacing: .14em; text-transform: uppercase; color: #e2c36a; }
  p { margin: 6px 0; color: #cdbf94; }
  video { width: 100%; background: #000; aspect-ratio: 4 / 3; object-fit: contain; display: block; }
  .bar { display: flex; gap: 10px; padding: 12px 16px; flex-wrap: wrap; }
  button { font: 700 15px system-ui, sans-serif; padding: 12px 18px; border-radius: 8px; border: 2px solid #000; background: #e2c36a; color: #14110d; }
  button.alt { background: #efe4c4; }
  button:disabled { opacity: .45; }
  #status { padding: 0 16px 16px; font: 14px ui-monospace, Menlo, monospace; color: #7be08a; word-break: break-word; }
</style></head>
<body>
<header><h1>Phone camera</h1><p>Prop the phone up still, landscape, looking at the layout. Then start the camera and keep this page open.</p></header>
<video id="v" playsinline muted autoplay></video>
<div class="bar">
  <button id="go">Start camera</button>
  <button id="flip" class="alt" disabled>Flip camera</button>
</div>
<div id="status">Not started.</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const say = (m) => { $('status').textContent = m; };
  let stream = null, pc = null, facing = 'environment', gen = 0, wake = null, retry = 0;

  const post = (route, body) => fetch('/phone-api/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (route) => fetch('/phone-api/' + route, { cache: 'no-store' }).then((r) => r.json());

  function fakeStream() {
    // ?test=1: a moving block instead of the real camera, for trying the link without a phone
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d'); let th = 0;
    setInterval(() => {
      th += 0.05;
      g.fillStyle = '#9a9488'; g.fillRect(0, 0, 640, 480);
      g.fillStyle = '#1d1a18'; g.fillRect(320 + 250 * Math.cos(th) - 30, 240 + 90 * Math.sin(th) - 12, 60, 24);
    }, 33);
    return c.captureStream(30);
  }

  async function open() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = params.has('test') ? fakeStream() : await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
    });
    $('v').srcObject = stream;
    $('flip').disabled = false;
    try { wake = await navigator.wakeLock?.request('screen'); } catch (e) { /* screen may sleep: fine */ }
  }

  function gathered(conn, ms) {
    return new Promise((resolve) => {
      if (conn.iceGatheringState === 'complete') return resolve();
      const done = () => { conn.removeEventListener('icegatheringstatechange', on); resolve(); };
      const on = () => { if (conn.iceGatheringState === 'complete') done(); };
      conn.addEventListener('icegatheringstatechange', on);
      setTimeout(done, ms);
    });
  }

  async function connect() {
    const my = ++gen;
    if (pc) { try { pc.close(); } catch (e) {} }
    pc = new RTCPeerConnection({ iceServers: [] });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 2500);
    const id = Math.random().toString(36).slice(2);
    await post('offer', { id, sdp: pc.localDescription.sdp });
    say('Waiting for the computer. On the computer pick "Phone" and press Start camera.');
    for (let i = 0; i < 600 && my === gen; i++) {
      const a = await get('answer?id=' + id).catch(() => ({}));
      if (a.sdp) { await pc.setRemoteDescription({ type: 'answer', sdp: a.sdp }); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (my !== gen) return;
    const conn = pc;
    conn.onconnectionstatechange = () => {
      if (conn !== pc) return;
      const s = conn.connectionState;
      if (s === 'connected') { retry = 0; say('Streaming to the computer. Leave this page open.'); }
      else if (s === 'failed' || s === 'closed') { say('Connection lost, reconnecting...'); setTimeout(() => { if (conn === pc) connect().catch((e) => say(String(e))); }, 1500 + 1000 * Math.min(retry++, 5)); }
      else if (s === 'disconnected') setTimeout(() => { if (conn === pc && conn.connectionState === 'disconnected') connect().catch((e) => say(String(e))); }, 4000);
      else say('Connecting: ' + s);
    };
  }

  $('go').addEventListener('click', async () => {
    $('go').disabled = true;
    try {
      if (!stream) await open();
      await connect();
      $('go').textContent = 'Reconnect';
    } catch (e) {
      say('Could not start: ' + (e && e.message ? e.message : e) + (window.isSecureContext ? '' : ' (this page is not secure: use the https address)'));
    }
    $('go').disabled = false;
  });
  $('flip').addEventListener('click', async () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    try { await open(); await connect(); } catch (e) { say('Could not switch: ' + e); }
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && stream && !wake) { try { wake = await navigator.wakeLock?.request('screen'); } catch (e) {} }
  });
  if (params.has('test')) $('go').click();
})();
</script>
</body></html>`;
