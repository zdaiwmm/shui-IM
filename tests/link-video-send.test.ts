import { afterEach, describe, expect, it, vi } from 'vitest';

const intent = vi.hoisted(() => ({ pending: false, cancelled: false }));
vi.mock('../src/lib/vault', () => ({
  setLinkVideoPendingSend: async (_session: unknown, _id: string, pending: boolean) => {
    if (pending && intent.cancelled) throw new DOMException('Send cancelled', 'AbortError');
    intent.pending = pending;
  },
}));
import { withSavedLinkVideoSend } from '../src/lib/link-video-send';
import type { VaultSession } from '../src/lib/vault';

afterEach(() => { intent.pending = false; intent.cancelled = false; });
const session = {} as VaultSession;

describe('saved video send handoff', () => {
  it('keeps the authorized send recoverable when preparation is interrupted', async () => {
    const controller = new AbortController();
    await expect(withSavedLinkVideoSend(session, 'video', controller.signal, async () => {
      expect(intent.pending).toBe(true);
      controller.abort();
      controller.signal.throwIfAborted();
      return true;
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(intent.pending).toBe(true);
    await withSavedLinkVideoSend(session, 'video', new AbortController().signal, async () => true);
    expect(intent.pending).toBe(false);
  });

  it('retains a failed send and clears it only after durable outbox acceptance', async () => {
    const signal = new AbortController().signal;
    expect(await withSavedLinkVideoSend(session, 'video', signal, async () => false)).toBe(false);
    expect(intent.pending).toBe(true);
    expect(await withSavedLinkVideoSend(session, 'video', signal, async () => true)).toBe(true);
    expect(intent.pending).toBe(false);
  });

  it('cannot restart preparation for a cancelled message generation', async () => {
    intent.cancelled = true;
    let prepared = false;
    await expect(withSavedLinkVideoSend(session, 'video', new AbortController().signal, async () => {
      prepared = true; return true;
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(prepared).toBe(false);
  });

  it('retains acceptance interrupted before cleanup so recovery can deduplicate the same ID', async () => {
    const controller = new AbortController();
    await expect(withSavedLinkVideoSend(session, 'video', controller.signal, async () => {
      controller.abort(); return true;
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(intent.pending).toBe(true);
  });
});
