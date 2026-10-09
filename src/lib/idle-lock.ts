export const IDLE_DURATIONS = [30, 60, 120, 300] as const;
export const IDLE_WARNING_MS = 10_000;
export const IDLE_PREFERENCE_KEY = 'quiet-room:auto-lock-seconds';
export type IdleSeconds = typeof IDLE_DURATIONS[number];
export type LeaseClock = { wall: number; monotonic: number };
export function idleSeconds(value: unknown): IdleSeconds {
  return IDLE_DURATIONS.includes(Number(value) as IdleSeconds) ? Number(value) as IdleSeconds : 60;
}
export function readIdleSeconds(storage: Pick<Storage, 'getItem'>): IdleSeconds {
  try { return idleSeconds(storage.getItem(IDLE_PREFERENCE_KEY)); } catch { return 60; }
}
export function saveIdleSeconds(storage: Pick<Storage, 'setItem'>, seconds: IdleSeconds): void {
  if (!IDLE_DURATIONS.includes(seconds)) throw new Error('请选择有效的自动锁定时间');
  storage.setItem(IDLE_PREFERENCE_KEY, String(seconds));
}

/** In-memory authority. Neither a timer tick nor a late activity can revive it. */
export class IdleLease {
  wallDeadline = 0;
  monotonicDeadline = 0;
  paused = false;
  private active = false;
  private cap: LeaseClock | null = null;
  constructor(private readonly clock: () => LeaseClock) {}
  start(seconds: IdleSeconds): void {
    this.active = true; this.paused = false;
    this.setDeadline(seconds);
  }
  clear(): void {
    this.active = false; this.paused = false; this.cap = null;
    this.wallDeadline = this.monotonicDeadline = 0;
  }
  private setDeadline(seconds: IdleSeconds): void {
    const now = this.clock();
    this.wallDeadline = now.wall + seconds * 1000;
    this.monotonicDeadline = now.monotonic + seconds * 1000;
  }
  get remaining(): number {
    if (!this.active) return Infinity;
    const now = this.clock();
    return Math.min(this.paused ? Infinity : Math.min(this.wallDeadline - now.wall, this.monotonicDeadline - now.monotonic),
      this.cap ? Math.min(this.cap.wall - now.wall, this.cap.monotonic - now.monotonic) : Infinity);
  }
  get expired(): boolean { return this.active && this.remaining <= 0; }
  get renewable(): boolean {
    if (!this.cap) return true;
    const now = this.clock();
    return !this.paused && Math.min(this.wallDeadline - now.wall, this.monotonicDeadline - now.monotonic)
      < Math.min(this.cap.wall - now.wall, this.cap.monotonic - now.monotonic);
  }
  renew(seconds: IdleSeconds): boolean {
    if (!this.active || this.expired) return false;
    this.setDeadline(seconds); return true;
  }
  setPersistentUse(using: boolean, seconds: IdleSeconds): boolean {
    if (!this.active || this.expired) return false;
    if (this.paused === using) return true;
    this.paused = using;
    if (!using) this.setDeadline(seconds);
    return true;
  }
  limitExposure(milliseconds: number): void {
    const now = this.clock();
    this.cap = { wall: now.wall + milliseconds, monotonic: now.monotonic + milliseconds };
  }
  clearExposureLimit(): void { this.cap = null; }
}
