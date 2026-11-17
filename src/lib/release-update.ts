export type ReleaseInfo = {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: string;
  readonly notes: readonly string[];
};

const CURRENT_RELEASE_KEY = 'quiet-room.current-release';
const SEEN_RELEASE_KEY = 'quiet-room.seen-release-notes';
const PENDING_RELEASE_KEY = 'quiet-room.pending-release-notes';
const BASE_RELEASE_KEY = 'quiet-room.release-notes-base';

export const currentRelease: ReleaseInfo = release;
export const releaseLog: readonly ReleaseInfo[] = [...history, currentRelease].reverse();

let releaseNotesPending = false;
let availableReleaseId: string | null = null;
const updateListeners = new Set<(releaseId: string | null) => void>();

function olderRelease(id: string, reference: string): boolean {
  const parts = (value: string) => /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(value) ? value.split('.').map(Number) : null;
  const left = parts(id), right = parts(reference);
  if (!left || !right) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! < right[i]!;
  return false;
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function prepareReleaseVisit(storage: Pick<Storage, 'getItem' | 'setItem'> | null, releaseId: string): boolean {
  if (!storage) return false;
  try {
    const previousRelease = storage.getItem(CURRENT_RELEASE_KEY);
    if (storage.getItem(BASE_RELEASE_KEY) === null) {
      storage.setItem(BASE_RELEASE_KEY, storage.getItem(SEEN_RELEASE_KEY) ?? previousRelease ?? releaseId);
    }
    const seen = storage.getItem(SEEN_RELEASE_KEY) === releaseId;
    if (previousRelease !== null && previousRelease !== releaseId && !seen) {
      storage.setItem(PENDING_RELEASE_KEY, releaseId);
    }
    storage.setItem(CURRENT_RELEASE_KEY, releaseId);
    return !seen && storage.getItem(PENDING_RELEASE_KEY) === releaseId;
  } catch {
    // A one-time notice cannot be guaranteed without durable local state.
    return false;
  }
}

releaseNotesPending = prepareReleaseVisit(browserStorage(), currentRelease.id);

export function hasPendingReleaseNotes(): boolean {
  return releaseNotesPending;
}

export function collectReleaseNotes(baseId: string | null, releases: readonly ReleaseInfo[]): string[] {
  const index = releases.findIndex(item => item.id === baseId);
  return [...new Set(releases.slice(index < 0 ? 0 : index + 1).flatMap(item => item.notes))];
}

export function pendingReleaseNotes(): string[] {
  let base: string | null = null;
  try {
    const storage = browserStorage();
    base = storage?.getItem(SEEN_RELEASE_KEY) ?? storage?.getItem(BASE_RELEASE_KEY) ?? null;
  } catch { /* Keep the update readable when storage becomes unavailable. */ }
  return collectReleaseNotes(base, [...history, currentRelease]);
}

export function markReleaseNotesSeen(): void {
  if (!releaseNotesPending) return;
  releaseNotesPending = false;
  try {
    const storage = browserStorage();
    storage?.setItem(SEEN_RELEASE_KEY, currentRelease.id);
    storage?.setItem(BASE_RELEASE_KEY, currentRelease.id);
    storage?.removeItem(PENDING_RELEASE_KEY);
  } catch {
    // The in-memory latch still prevents repeated dialogs in this page lifetime.
  }
}

export function pendingReleaseUpdate(): string | null {
  return availableReleaseId;
}

export function subscribeReleaseUpdate(listener: (releaseId: string | null) => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

export function acceptReleaseWorkerMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const message = data as { type?: unknown; releaseId?: unknown };
  if (message.type !== 'quiet-room-release-ready'
    || typeof message.releaseId !== 'string'
    || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(message.releaseId)
    || message.releaseId === currentRelease.id
    || olderRelease(message.releaseId, currentRelease.id)
    || availableReleaseId !== null && olderRelease(message.releaseId, availableReleaseId)
    || message.releaseId === availableReleaseId) return false;
  availableReleaseId = message.releaseId;
  for (const listener of updateListeners) listener(availableReleaseId);
  return true;
}

export function startReleaseUpdateDetection(): void {
  const workers = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
  workers?.addEventListener('message', event => acceptReleaseWorkerMessage(event.data));
  let registration: ServiceWorkerRegistration | null = null;
  let checking = false;
  let registering = false;
  const register = async () => {
    if (!workers || registration || registering) return;
    registering = true;
    try { registration = await workers.register('/sw.js', { updateViaCache: 'none' }); }
    catch { /* Retry on the next foreground/online check. */ }
    finally { registering = false; }
  };
  const check = async () => {
    if (checking || document.hidden || !navigator.onLine) return;
    checking = true;
    try {
      // A worker may activate while Safari has suspended this page, or before
      // its listener exists. The uncached manifest also works without workers.
      await Promise.allSettled([
        (async () => {
          const response = await fetch('/release.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
          if (!response.ok || response.redirected) return;
          const manifest = await response.json() as { id?: unknown };
          acceptReleaseWorkerMessage({ type: 'quiet-room-release-ready', releaseId: manifest?.id });
        })(),
        (async () => {
          await register();
          await registration?.update();
          registration?.active?.postMessage({ type: 'quiet-room-release-query' });
        })(),
      ]);
    }
    finally { checking = false; }
  };
  // Language initialization can finish after load. An existing controller must
  // still be updated, including its imported transfer protocol.
  if (document.readyState === 'complete') void check();
  else window.addEventListener('load', () => void check(), { once: true });
  document.addEventListener('visibilitychange', () => void check());
  window.addEventListener('pageshow', () => void check());
  window.addEventListener('focus', () => void check());
  window.addEventListener('online', () => void check());
  workers?.addEventListener('controllerchange', () => void check());
  window.setInterval(() => void check(), 60 * 1000);
}
import release from '../../release.json';
import history from '../../release-history.json';
