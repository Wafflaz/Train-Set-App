// Computer side of the phone camera link: picks up the phone's offer, answers it, shows its video.

export interface PhoneLink { stop(): void }

export async function phoneUrls(): Promise<string[]> {
  try {
    const r = await fetch('/phone-api/info', { cache: 'no-store' });
    return ((await r.json()) as { urls?: string[] }).urls ?? [];
  } catch { return []; }
}

function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => { pc.removeEventListener('icegatheringstatechange', on); resolve(); };
    const on = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', on);
    setTimeout(done, ms);
  });
}

/** Waits for a phone page to offer its camera, answers, and plays the stream in `video`. A phone that reconnects replaces the old link. */
export function connectPhone(video: HTMLVideoElement, onStatus: (s: string) => void, onDelay?: (seconds: number) => void): PhoneLink {
  let alive = true;
  let pc: RTCPeerConnection | null = null;
  let handled = '';
  onStatus('Waiting for the phone: open the address below on it, then press Start camera there.');

  const accept = async (id: string, sdp: string) => {
    handled = id;
    pc?.close();
    const conn = new RTCPeerConnection({ iceServers: [] });
    pc = conn;
    conn.ontrack = (ev) => {
      video.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
      void video.play().catch(() => undefined);
      // play frames the moment they arrive: no extra buffering for smoothness (the picture is only analysed, not watched)
      const r = ev.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
      try { r.jitterBufferTarget = 0; } catch { /* older Chrome */ }
      try { r.playoutDelayHint = 0; } catch { /* older Chrome */ }
    };
    conn.onconnectionstatechange = () => {
      if (conn !== pc || !alive) return;
      const s = conn.connectionState;
      if (s === 'connected') onStatus('Phone connected.');
      else if (s === 'failed' || s === 'disconnected') onStatus('Phone link dropped: it will reconnect by itself. If not, press Reconnect on the phone.');
      else onStatus(`Phone: ${s}…`);
    };
    onStatus('Phone found, connecting…');
    await conn.setRemoteDescription({ type: 'offer', sdp });
    await conn.setLocalDescription(await conn.createAnswer());
    await gathered(conn, 2500);
    await fetch('/phone-api/answer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, sdp: conn.localDescription?.sdp }),
    });
  };

  // how late is the picture? jitter buffer + decoding + half the round trip, from the connection's own statistics
  let prev: { delay: number; count: number } | null = null;
  const measure = async () => {
    const conn = pc;
    if (!alive || !conn || conn.connectionState !== 'connected') return;
    let rtt = 0, jb = 0, jbn = 0, dec = 0, decn = 0;
    (await conn.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') { jb = s.jitterBufferDelay ?? 0; jbn = s.jitterBufferEmittedCount ?? 0; dec = s.totalDecodeTime ?? 0; decn = s.framesDecoded ?? 0; }
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) rtt = s.currentRoundTripTime ?? rtt;
    });
    // jitter delay over the last few seconds, not since the start of the call
    let jbAvg = jbn ? jb / jbn : 0;
    if (prev && jbn > prev.count) jbAvg = (jb - prev.delay) / (jbn - prev.count);
    prev = { delay: jb, count: jbn };
    onDelay?.(Math.max(0, jbAvg) + (decn ? dec / decn : 0) + rtt / 2 + 0.04);
  };
  const timer = window.setInterval(() => void measure().catch(() => undefined), 2000);

  const poll = async () => {
    while (alive) {
      try {
        const r = await fetch('/phone-api/offer', { cache: 'no-store' });
        const o = (await r.json()) as { id?: string; sdp?: string };
        if (alive && o.id && o.sdp && o.id !== handled) await accept(o.id, o.sdp);
      } catch (err) {
        onStatus('Phone link error: ' + (err as Error).message);
      }
      await new Promise((res) => setTimeout(res, 800));
    }
  };
  void poll();

  return {
    stop() {
      alive = false;
      clearInterval(timer);
      pc?.close();
      pc = null;
      if (video.srcObject) { (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop()); video.srcObject = null; }
    },
  };
}
