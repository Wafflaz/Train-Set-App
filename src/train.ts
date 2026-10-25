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
  rollVol: number;       // wagon wheels over rail joints
  perWagon: number;      // length of one wagon compared with the loco (for counting wagons by length)
  panAmt: number;        // 0 = centred, 1 = full left/right as the train crosses the set
  panDir: number;        // which way across the camera picture is the listener's right: 0 right, 1 down, 2 left, 3 up
}

export const DEFAULT_TRAIN: TrainSettings = {
  fullSpeed: 0.3, minRate: 1.6, maxRate: 7.5, stopSpeed: 0.025, stopDelay: 0.9,
  chuffVol: 0.8, idleVol: 0.45, steamVol: 0.5, squealVol: 0.28, curveThr: 1.5, rockVol: 0.5,
  rollVol: 0.55, perWagon: 0.45, panAmt: 0.8, panDir: 1,
};

export type Mode = 'stopped' | 'moving';

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** Turns tracker output into chuffs, steam release, idle ambience, wagon clatter, panning and tunnel muffling. */
export class TrainSound {
  mode: Mode = 'stopped';
  rate = 0;
  steams = 0;
  squeal = 0;
  pan = 0;
  wagons = 0;            // set by whoever counts them (manual buttons or the length estimator)
  beat = 1;              // the loco's own chuff-rate multiplier
  private lastSqueal = 0;
  private sqLevel = -1;
  private speed = 0;
  private belowSince = 0;
  private aboveSince = 0;
  private movingSince = 0;
  private lastSteam = -1e9;
  private nextChuff = 0;
  private clackAcc = 0;
  private timer = 0;
  private lo = -0.1;
  private hi = 0.1;
  private seen = false;
  private lastPan = 0;
  private lastT = 0;

  constructor(private audio: AudioEngine, public s: TrainSettings) {}

  start() {
    this.lo = -0.1; this.hi = 0.1; this.seen = false; this.lastT = 0;
    this.audio.setIdle(this.s.idleVol, 1.5);
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop() {
    clearInterval(this.timer);
    this.audio.setIdle(0, 0.5);
    this.audio.setMuffle(0);
    this.audio.setSqueal(0, 1);
    this.audio.setPan(0);
  }

  /** where the train is across the set, -1 (listener's left) .. 1 (right); the range adapts to what the camera has seen */
  private panOf(t: Track, dt: number): number {
    const [dx, dy] = DIRS[Math.max(0, Math.min(3, Math.round(this.s.panDir)))];
    const p = (t.x - 0.5) * dx + (t.y - 0.375) * dy;
    if (!this.seen) { this.seen = true; this.lo = p - 0.1; this.hi = p + 0.1; }
    if (p < this.lo) this.lo = p;
    if (p > this.hi) this.hi = p;
    const c = (this.lo + this.hi) / 2;
    const shrink = Math.min(1, 0.004 * dt); // the range slowly forgets, so moving the camera re-calibrates it
    this.lo += (c - this.lo) * shrink;
    this.hi += (c - this.hi) * shrink;
    const half = Math.max(0.08, (this.hi - this.lo) / 2);
    return Math.max(-1, Math.min(1, (p - c) / half)) * this.s.panAmt;
  }

  update(t: Track, now: number) {
    const dt = this.lastT ? Math.min(0.2, now - this.lastT) : 0.033;
    this.lastT = now;
    this.speed = t.speed;
    this.audio.setMuffle(t.tunnel);
    // curves squeal, straights do not; nothing while hidden in the tunnel
    if (now - this.lastSqueal > 0.1) {
      this.lastSqueal = now;
      const lv = Math.min(1, t.speed / this.s.fullSpeed);
      this.squeal = t.hidden ? 0 : this.s.squealVol * t.turn * Math.min(1, t.speed / (this.s.fullSpeed * 0.4));
      if (Math.abs(this.squeal - this.sqLevel) > 0.004 || this.squeal === 0 !== (this.sqLevel === 0)) {
        this.sqLevel = this.squeal;
        this.audio.setSqueal(this.squeal, 0.85 + 0.3 * lv);
      }
      // pan follows the train; while it is hidden in the tunnel or lost, hold the last position
      if (t.present || t.hidden || this.seen) {
        if (t.present) this.lastPan = this.panOf(t, dt * 3);
        if (Math.abs(this.lastPan - this.pan) > 0.01) { this.pan = this.lastPan; this.audio.setPan(this.pan); }
      }
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
    if (this.mode !== 'moving') { this.rate = 0; this.clackAcc = 0; return; }
    const s = this.s;
    const level = Math.max(0, Math.min(1.2, this.speed / s.fullSpeed));
    this.rate = (s.minRate + (s.maxRate - s.minRate) * Math.min(1, level)) * this.beat;
    // fade the last beats out as the train comes to rest
    const settle = Math.max(0, Math.min(1, (this.speed - s.stopSpeed * 0.5) / (s.stopSpeed * 2)));
    const now = a.ctx.currentTime;
    if (this.nextChuff < now) this.nextChuff = now + 0.02;
    // stones skittering: random, denser and a touch louder the faster it goes
    const sp = Math.min(1, level);
    if (Math.random() < (1.5 + 6 * sp) * 0.025) {
      a.playRock(now + Math.random() * 0.025, s.rockVol * 0.4 * (0.4 + 0.6 * sp) * (0.5 + 0.5 * Math.random()) * settle, 0.8 + Math.random() * 0.45);
    }
    // wagons: a wheel clack every time a wheel crosses a rail joint; more wagons, more axles, more clatter
    if (this.wagons > 0 && s.rollVol > 0) {
      this.clackAcc += Math.min(26, sp * (1.2 + 3.4 * this.wagons)) * 0.025;
      const body = Math.min(1, 0.45 + 0.17 * this.wagons);
      while (this.clackAcc >= 1) {
        this.clackAcc -= 1;
        a.playClack(now + Math.random() * 0.024, s.rollVol * 0.5 * body * (0.3 + 0.7 * sp) * settle * (0.55 + 0.45 * Math.random()), 1.02 + Math.random() * 0.2);
      }
    } else this.clackAcc = 0;
    while (this.nextChuff < now + 0.1) {
      const gain = s.chuffVol * (0.22 + 0.78 * Math.min(1, level)) * settle * (0.9 + Math.random() * 0.1);
      a.playChuff(this.nextChuff, gain, 0.97 + Math.random() * 0.06 + level * 0.03);
      this.nextChuff += (1 / this.rate) * (0.96 + Math.random() * 0.08);
    }
  }
}
