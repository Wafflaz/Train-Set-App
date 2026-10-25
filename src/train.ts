import type { AudioEngine } from './audio';
import type { Track } from './motion';

export interface TrainSettings {
  fullSpeed: number;     // frame-widths/s that counts as full speed
  minRate: number;       // chuffs/s at crawl
  maxRate: number;       // chuffs/s at full speed
  stopSpeed: number;     // below this = stationary
  stopDelay: number;     // s below stopSpeed before "stopped"
  chuffVol: number;
  idleVol: number;
  steamVol: number;
  squealVol: number;     // rail squeal on curves
  curveThr: number;      // curvature (rad per frame-width) where squeal starts
  rockVol: number;       // stones skittering under the wheels
}

export const DEFAULT_TRAIN: TrainSettings = {
  fullSpeed: 0.3, minRate: 1.6, maxRate: 7.5, stopSpeed: 0.025, stopDelay: 0.9,
  chuffVol: 0.8, idleVol: 0.45, steamVol: 0.5, squealVol: 0.28, curveThr: 1.5, rockVol: 0.5,
};

export type Mode = 'stopped' | 'moving';

/** Turns tracker output into chuffs, steam release, idle ambience and tunnel muffling. */
export class TrainSound {
  mode: Mode = 'stopped';
  rate = 0;
  steams = 0;
  squeal = 0;
  private lastSqueal = 0;
  private speed = 0;
  private belowSince = 0;
  private aboveSince = 0;
  private movingSince = 0;
  private lastSteam = -1e9;
  private nextChuff = 0;
  private timer = 0;

  constructor(private audio: AudioEngine, public s: TrainSettings) {}

  start() {
    this.audio.setIdle(this.s.idleVol, 1.5);
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop() {
    clearInterval(this.timer);
    this.audio.setIdle(0, 0.5);
    this.audio.setMuffle(0);
    this.audio.setSqueal(0, 1);
  }

  update(t: Track, now: number) {
    this.speed = t.speed;
    this.audio.setMuffle(t.tunnel);
    // curves squeal, straights do not; nothing while hidden in the tunnel
    if (now - this.lastSqueal > 0.1) {
      this.lastSqueal = now;
      const lv = Math.min(1, t.speed / this.s.fullSpeed);
      this.squeal = t.hidden ? 0 : this.s.squealVol * t.turn * Math.min(1, t.speed / (this.s.fullSpeed * 0.4));
      this.audio.setSqueal(this.squeal, 0.85 + 0.3 * lv);
    }
    const s = this.s;
    const above = t.speed > (this.mode === 'stopped' ? s.stopSpeed * 1.3 : s.stopSpeed);
    if (above) { this.belowSince = 0; if (!this.aboveSince) this.aboveSince = now; }
    else { this.aboveSince = 0; if (!this.belowSince) this.belowSince = now; }

    if (this.mode === 'stopped' && this.aboveSince && now - this.aboveSince > 0.25) {
      this.mode = 'moving';
      this.movingSince = now;
      this.nextChuff = this.audio.ctx.currentTime + 0.03;
      this.audio.stopSteam(0.9);
      this.audio.setIdle(s.idleVol * 0.2, 1.2);
    } else if (this.mode === 'moving' && this.belowSince && now - this.belowSince > s.stopDelay) {
      this.mode = 'stopped';
      const ranFor = now - this.movingSince;
      if (ranFor > 1.5 && now - this.lastSteam > 8) {
        this.lastSteam = now;
        this.steams++;
        this.audio.steamRelease(s.steamVol);
      }
      this.audio.setIdle(s.idleVol, 2.5);
    }
  }

  private schedule() {
    const a = this.audio;
    if (this.mode !== 'moving') { this.rate = 0; return; }
    const s = this.s;
    const level = Math.max(0, Math.min(1.2, this.speed / s.fullSpeed));
    this.rate = s.minRate + (s.maxRate - s.minRate) * Math.min(1, level);
    // fade the last beats out as the train comes to rest
    const settle = Math.max(0, Math.min(1, (this.speed - s.stopSpeed * 0.5) / (s.stopSpeed * 2)));
    const now = a.ctx.currentTime;
    if (this.nextChuff < now) this.nextChuff = now + 0.02;
    // stones skittering: random, denser and a touch louder the faster it goes
    const sp = Math.min(1, level);
    if (Math.random() < (1.5 + 6 * sp) * 0.025) {
      a.playRock(now + Math.random() * 0.025, s.rockVol * 0.4 * (0.4 + 0.6 * sp) * (0.5 + 0.5 * Math.random()) * settle, 0.8 + Math.random() * 0.45);
    }
    while (this.nextChuff < now + 0.1) {
      const gain = s.chuffVol * (0.22 + 0.78 * Math.min(1, level)) * settle * (0.9 + Math.random() * 0.1);
      a.playChuff(this.nextChuff, gain, 0.97 + Math.random() * 0.06 + level * 0.03);
      this.nextChuff += (1 / this.rate) * (0.96 + Math.random() * 0.08);
    }
  }
}
