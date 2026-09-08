export type ReleaseInfo = {
  readonly id: string;
  readonly title: string;
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
    || message.releaseId.length === 0
    || message.releaseId === currentRelease.id
    || message.releaseId === availableReleaseId) return false;
  availableReleaseId = message.releaseId;
  for (const listener of updateListeners) listener(availableReleaseId);
  return true;
}

export function startReleaseUpdateDetection(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', event => acceptReleaseWorkerMessage(event.data));
  let registration: ServiceWorkerRegistration | null = null;
  let checking = false;
  const check = async () => {
    if (!registration || checking || document.hidden || !navigator.onLine) return;
    checking = true;
    try { await registration.update(); } catch { /* A later visibility/online check retries. */ }
    finally { checking = false; }
  };
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then(value => {
      registration = value;
      return check();
    }).catch(() => {
      // The application remains usable online when worker registration fails.
    });
  });
  document.addEventListener('visibilitychange', () => void check());
  window.addEventListener('online', () => void check());
  window.setInterval(() => void check(), 15 * 60 * 1000);
}
import release from '../../release.json';
import history from '../../release-history.json';
