import type { Tunnel } from './motion';

// Simulated train on a loop so the whole chain (tracking, chuffs, steam, tunnel) can be tried without hardware.
// Cycle: rest, accelerate, run, brake, rest. The train is hidden while behind the tunnel wall on the left.
export function startDemo(step: (src: CanvasImageSource) => void, tunnel: Tunnel, wagons: () => number = () => 0) {
  const W = 320, H = 240;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  let theta = Math.PI / 2;
  let last = performance.now();
  let t0 = last;
  let timer = 0;
  const OMEGA = 0.95;

  const draw = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const c = ((now - t0) / 1000) % 40;
    let k = 0;
    if (c >= 5 && c < 8) k = (c - 5) / 3;
    else if (c >= 8 && c < 28) k = 1;
    else if (c >= 28 && c < 31) k = 1 - (c - 28) / 3;
    theta += OMEGA * k * dt;

    g.fillStyle = '#9a9488';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#7d8a6a';
    g.fillRect(W * tunnel.x1, 0, W * (1 - tunnel.x1), H);
    g.fillStyle = '#2a2622';
    g.fillRect(0, 0, W * Math.min(tunnel.x1, 0.2), H); // cardboard wall

    const at = (th: number) => ({ x: 0.5 + 0.45 * Math.cos(th), y: (0.5 + 0.12 * Math.sin(th)) * (H / W) });
    const { x, y } = at(theta);
    if (x > tunnel.x1 - 0.06) {
      g.fillStyle = '#1d1a18';
      g.fillRect(x * W - 14, y * W - 6, 28, 12);
      g.fillStyle = '#b84a2a';
      g.fillRect(x * W - 14, y * W - 6, 9, 12);
    }
    // wagons follow behind the loco
    for (let i = 1; i <= wagons(); i++) {
      const w = at(theta - 0.19 * i);
      if (w.x <= tunnel.x1 - 0.06) continue;
      g.fillStyle = i % 2 ? '#5b4636' : '#6d6a5f';
      g.fillRect(w.x * W - 11, w.y * W - 5, 22, 10);
      g.fillStyle = '#2a2622';
      g.fillRect(w.x * W - 11, w.y * W - 5, 22, 2);
    }
    step(cv);
  };

  return {
    start() { t0 = last = performance.now(); timer = window.setInterval(draw, 33); },
    stop() { clearInterval(timer); },
  };
}
