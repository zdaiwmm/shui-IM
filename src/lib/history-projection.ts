/** Merge ascending, paged ciphertext readers without retaining ordinary rows. */
export async function mergeHistoryProjection<T extends { seq: number; clientMsgId: string }>(
  streams: AsyncIterable<T>[],
  { same, event, live, signal }: { same: (a: T, b: T) => boolean; event: (message: T) => boolean;
    live: (message: T) => void; signal?: AbortSignal },
): Promise<T[]> {
  const readers = streams.map(stream => stream[Symbol.asyncIterator]());
  const heads: IteratorResult<T>[] = [];
  const events = new Map<string, T>();
  try {
    for (const reader of readers) { signal?.throwIfAborted(); heads.push(await reader.next()); }
    for (;;) {
      signal?.throwIfAborted();
      const sequence = Math.min(...heads.map(head => head.done ? Infinity : head.value.seq));
      if (sequence === Infinity) break;
      let canonical: T | undefined;
      for (let index = 0; index < heads.length; index++) {
        const head = heads[index]!;
        if (head.done || head.value.seq !== sequence) continue;
        if (canonical && !same(canonical, head.value)) throw new Error('本机加密历史记录存在冲突');
        canonical = head.value; // Last stream (ordinary history) is canonical.
        if (index === heads.length - 1) live(head.value);
      }
      if (canonical && event(canonical)) events.set(canonical.clientMsgId, canonical);
      for (let index = 0; index < heads.length; index++) {
        const head = heads[index]!;
        if (!head.done && head.value.seq === sequence) heads[index] = await readers[index]!.next();
      }
    }
    signal?.throwIfAborted();
    return [...events.values()].sort((a, b) => a.seq - b.seq);
  } finally {
    for (const reader of readers) await reader.return?.();
  }
}
