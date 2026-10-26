/** One opening owns all asynchronous projections, even when the VaultSession is reused. */
export class RoomRuntime<T> {
  readonly id = Symbol('room-runtime');
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private releases = new Set<() => void>();
  private readonly owner: string;
  constructor(readonly session: T, private readonly current: () => boolean, private readonly identity:()=>string=()=>'') { this.owner=identity(); }
  isCurrent(): boolean {
    if(this.signal.aborted)return false;
    if(this.identity()!==this.owner||!this.current()){this.dispose();return false;}
    return true;
  }
  assertCurrent(): void { if (!this.isCurrent()) throw new DOMException('会话已经结束', 'AbortError'); }
  commit(update: () => void): boolean { if (!this.isCurrent()) return false; update(); return true; }
  own(release: () => void): void { if (this.signal.aborted) release(); else this.releases.add(release); }
  dispose(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    for (const release of this.releases) { try { release(); } catch { /* Continue synchronous privacy teardown. */ } }
    this.releases.clear();
  }
}
