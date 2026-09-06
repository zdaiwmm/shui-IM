export type ReleaseInfo = {
  readonly id: string;
  readonly title: string;
  readonly notes: readonly string[];
};

const CURRENT_RELEASE_KEY = 'quiet-room.current-release';
const SEEN_RELEASE_KEY = 'quiet-room.seen-release-notes';
const PENDING_RELEASE_KEY = 'quiet-room.pending-release-notes';

export const currentRelease: ReleaseInfo = release;

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

export function markReleaseNotesSeen(): void {
  if (!releaseNotesPending) return;
  releaseNotesPending = false;
  try {
    const storage = browserStorage();
    storage?.setItem(SEEN_RELEASE_KEY, currentRelease.id);
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
