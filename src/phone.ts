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
export function connectPhone(video: HTMLVideoElement, onStatus: (s: string) => void): PhoneLink {
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
      pc?.close();
      pc = null;
      if (video.srcObject) { (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop()); video.srcObject = null; }
    },
  };
}
