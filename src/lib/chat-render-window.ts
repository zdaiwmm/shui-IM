/** Geometry only. The full logical timeline remains owned by the application. */
export class ChatRenderWindow {
  readonly size = 96;
  private ids: string[] = [];
  private indices = new Map<string, number>();
  private heights = new Map<string, number>();
  private sums = new Float64Array(1);
  private width = 0;
  start = 0;
  end = 0;
  get active(): boolean { return this.ids.length > 200; }
  get length(): number { return this.ids.length; }
  index(id: string): number | undefined { return this.indices.get(id); }

  sync(ids: readonly string[], width: number): void {
    const resized = Math.abs(width - this.width) > 1;
    if (!resized && ids.length === this.ids.length && ids.every((id, i) => id === this.ids[i])) return;
    const first = this.ids[this.start];
    this.width = width;
    if (resized) this.heights.clear();
    this.ids = [...ids]; this.indices = new Map(ids.map((id, i) => [id, i]));
    for (const id of this.heights.keys()) if (!this.indices.has(id)) this.heights.delete(id);
    this.sums = new Float64Array(ids.length + 1);
    for (let i = 0; i < ids.length; i++) this.add(i, this.heights.get(ids[i]!) ?? 76);
    this.start = Math.min(this.indices.get(first!) ?? this.start, Math.max(0, ids.length - this.size));
    this.end = Math.min(ids.length, this.start + this.size);
  }

  private add(index: number, value: number): void {
    for (let i = index + 1; i < this.sums.length; i += i & -i) this.sums[i]! += value;
  }
  offset(index: number): number {
    let sum = 0;
    for (let i = Math.min(index, this.ids.length); i > 0; i -= i & -i) sum += this.sums[i]!;
    return sum;
  }
  at(offset: number): number {
    let low = 0, high = this.ids.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.offset(mid + 1) <= offset) low = mid + 1;
      else high = mid;
    }
    return Math.min(low, Math.max(0, this.ids.length - 1));
  }
  measure(id: string, height: number): boolean {
    const index = this.indices.get(id);
    if (index === undefined || !Number.isFinite(height) || height <= 0) return false;
    const previous = this.heights.get(id) ?? 76;
    if (Math.abs(previous - height) < .5) return false;
    this.heights.set(id, height); this.add(index, height - previous); return true;
  }
  choose(center: number, frozen = false): void {
    if (!this.active) { this.start = 0; this.end = this.ids.length; return; }
    if (frozen) return;
    this.start = Math.max(0, Math.min(this.ids.length - this.size, center - 24));
    this.end = Math.min(this.ids.length, this.start + this.size);
  }
  mounted(pins: readonly string[] = []): number[] {
    const indices = new Set(Array.from({ length: this.end - this.start }, (_, i) => this.start + i));
    // Focus, action source and active media each have a single owner. Bounding
    // these extra rows avoids turning a long-lived owner into an unbounded range.
    for (const id of pins.slice(0, 4)) {
      const index = this.indices.get(id);
      if (index !== undefined) indices.add(index);
    }
    return [...indices].sort((a, b) => a - b);
  }
}
