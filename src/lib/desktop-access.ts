import type { LeaseClock } from './idle-lock';

export const DESKTOP_RETURN_MS = 30 * 60 * 1000;

/** Page-memory authority only. Background events and failed entry never renew it. */
export class DesktopAccess<T> {
  private held: { value: T; wall: number; monotonic: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly clock: () => LeaseClock, private readonly dispose: (value: T) => void) {}
  hold(value: T): void {
    this.clear();
    const now = this.clock();
    this.held = { value, wall: now.wall + DESKTOP_RETURN_MS, monotonic: now.monotonic + DESKTOP_RETURN_MS };
    this.timer = setTimeout(() => this.clear(), DESKTOP_RETURN_MS);
  }
  peek(): T | null {
    if (!this.held) return null;
    const now = this.clock();
    if (now.wall >= this.held.wall || now.monotonic >= this.held.monotonic) this.clear();
    return this.held?.value ?? null;
  }
  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const value = this.held?.value;
    this.held = null;
    if (value) this.dispose(value);
  }
}
