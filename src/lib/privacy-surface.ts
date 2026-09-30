export type PrivacyOwner = 'keyboard' | 'accessory' | 'recovery' | 'meme' | 'picker' | 'microphone' | 'camera' | 'system' | 'unknown';
export type PrivacyClock = { monotonic: number; wall: number };
export type PrivacyHold = {
  owner: PrivacyOwner;
  epoch: number;
  deadline: number;
  wallDeadline: number;
};
type Diagnostic = { event: 'conceal' | 'repeat' | 'resume' | 'reject' | 'lock'; owner: PrivacyOwner | null; at: number };

/** Visual concealment does not invalidate the encrypted runtime. Ownership is
 * evidence for bounded retention only; it never authorizes an uncovered blur. */
export class PrivacySurface {
  hold: Readonly<PrivacyHold> | null = null;
  private events: Diagnostic[] = [];

  conceal(hold: PrivacyHold, now: PrivacyClock): void {
    // Repeated OS blur events cannot renew the original absolute deadline.
    if (this.hold && this.hold.epoch === hold.epoch) {
      this.record('repeat', this.hold.owner, now);
      return;
    }
    this.hold = { ...hold };
    this.record('conceal', hold.owner, now);
  }

  expired(now: PrivacyClock): boolean {
    return Boolean(this.hold && (now.monotonic >= this.hold.deadline || now.wall >= this.hold.wallDeadline));
  }

  requireContinuation(now: PrivacyClock, duration: number): void {
    if (!this.hold) return;
    this.hold = { ...this.hold, owner: 'unknown',
      deadline: Math.min(this.hold.deadline, now.monotonic + duration),
      wallDeadline: Math.min(this.hold.wallDeadline, now.wall + duration) };
  }

  resume(epoch: number, foreground: boolean, completed: boolean, continued: boolean, now: PrivacyClock): boolean {
    const hold = this.hold;
    if (!hold) return foreground;
    if (hold.epoch !== epoch || !foreground || this.expired(now)
      || (hold.owner === 'unknown' ? !continued : !completed)) {
      this.record('reject', hold.owner, now);
      return false;
    }
    this.record('resume', hold.owner, now);
    this.hold = null;
    return true;
  }

  lock(now: PrivacyClock): void {
    this.record('lock', this.hold?.owner ?? null, now);
    this.hold = null;
  }

  diagnostics(): ReadonlyArray<Readonly<Diagnostic>> {
    return this.events.map(event => ({ ...event }));
  }

  private record(event: Diagnostic['event'], owner: PrivacyOwner | null, now: PrivacyClock): void {
    // In-memory, bounded, enum-only: no room, message, filename or credential.
    this.events.push({ event, owner, at: Math.floor(now.monotonic / 100) * 100 });
    if (this.events.length > 64) this.events.shift();
  }
}
