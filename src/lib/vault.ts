import { compareOutboxItems } from './outbox-order';
import { isWindowMessage, expiredMessage } from './message-window';
import { mergeHistoryProjection } from './history-projection';
import { mediaCacheBudget, mediaCacheEvictions, MEDIA_CACHE_FILE_BYTES, type MediaCacheEntry } from './media-cache-policy';
import { argon2id } from 'hash-wasm';
import { derivePasswordCredential, isPasswordCredential, validPasswordKdf, wrapPasswordMaster, unwrapPasswordMaster, type LocalCredentialResult } from './password-protection';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { clearDraftCheckpoints, openDraftCheckpoint, type DraftSubmission } from './draft-checkpoint';
import { normalizeMemeIndex, MAX_MEME_FAVORITES, MAX_MEME_LIBRARY_BYTES, MAX_MEME_BYTES, MEME_TYPES, type MemeFavorite } from './meme-media';
import { MAX_PACK_BYTES, MAX_PACK_ITEMS, MAX_PACK_LIBRARY_BYTES, MAX_STICKER_PACKS, type StickerPack } from './sticker-library';
import { downloadBlob } from './download';
import { encryptMessage, generateIdentity } from './crypto';
import { createRecoveryRequest } from './mls';
import { isMessagePayload, MAX_IMAGE_BYTES } from './message-payload';
import { isGalleryMediaPayload } from './video-media';
import { galleryCurationKey, normalizeGalleryCurationRecords, type GalleryCurationRecord } from './gallery-curation';
import { normalizeAttachmentFavorites, type AttachmentFavorite } from './attachment-favorites';
import type { CloudRecoveryBundle } from './backup-types';
import { parseCloudRecoveryCode } from './backup-crypto';
import {
  createPlatformCredential,
  isPlatformVaultCancellation,
  unlockPlatformCredential,
  UnlockStageError,
  takeBrowserAccessPrf,
  type PlatformCredentialResult,
} from './platform-vault';
import type {
  DecryptedMessage,
  DeliveryReceipt,
  ImageUploadPlan,
  LegacyStoredVault,
  OutboxItem,
  PlatformCredentialRecord,
  RecoveryExport,
  StoredPlatformVault,
  StoredPasswordVault,
  StoredRecoveryVault,
  StoredVault,
  Vault,
  VaultKdf,
} from './types';

const DB_NAME = 'quiet-room';
const DB_VERSION = 15;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PLATFORM_PAYLOAD_AAD = encoder.encode('quiet-room-vault-payload-v2');
const MAX_LEGACY_VAULT_CIPHERTEXT_LENGTH = 2 * 1024 * 1024;
// A crash-safe archive checkpoint can contain one full 2 MiB attachment chunk,
// encoded and encrypted again inside the vault (~5 MiB of base64url). Leave
// bounded room for its manifest, MLS state and other existing vault metadata.
const MAX_VAULT_PAYLOAD_CIPHERTEXT_LENGTH = 8 * 1024 * 1024;

const SPACE_SELECTION = 'quiet-room:space';
function savedSpace(): string {
  try { return sessionStorage.getItem(SPACE_SELECTION) || localStorage.getItem(SPACE_SELECTION) || 'current'; }
  catch { return 'current'; }
}
let selectedSpace = savedSpace();
export function currentSpaceId(): string { return selectedSpace; }
export function vaultSpaceId(stored: StoredVault): string { return stored.spaceId ?? 'current'; }
export async function selectLocalSpace(id: string): Promise<void> {
  if (id !== 'current' && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('密室编号不正确');
  await withVaultLifecycle(async () => { selectedSpace = id; });
}
function rememberSpace(id: string): void {
  try { sessionStorage.setItem(SPACE_SELECTION, id); } catch { /* Try the durable selection independently. */ }
  try { localStorage.setItem(SPACE_SELECTION, id); } catch { /* This tab retains its own selection. */ }
}
export async function localSpaceExists(id: string): Promise<boolean> {
  return (await transaction('vault', 'readonly', store => store.get(id))) !== undefined;
}


export type VaultSession = {
  /** Ephemeral, client-only rendezvous material from this native unlock. */
  browserAccessPrf?: Uint8Array<ArrayBuffer>;
  vault: Vault;
  key: CryptoKey;
  stored: StoredVault;
};

/** A lease for one complete read/derive/write operation, never for a DB put alone. */
export type VaultMutation = { readonly session: VaultSession; readonly id: symbol };
let vaultLifecycle: Promise<unknown> = Promise.resolve();
let activeVaultMutation: VaultMutation | undefined;
const deviceCredentials = new WeakMap<VaultSession, { record: PlatformCredentialRecord; proof: Uint8Array<ArrayBuffer> }>();

function retainDeviceCredential(session: VaultSession, record: PlatformCredentialRecord, proof: Uint8Array<ArrayBuffer>): void {
  const previous = deviceCredentials.get(session);
  previous?.proof.fill(0);
  deviceCredentials.set(session, { record, proof });
}

/** Copy of the passkey proof that opened this session. The stored copy stays usable. */
export function cloneDeviceCredential(session: VaultSession): PlatformCredentialResult | null {
  const held = deviceCredentials.get(session);
  return held ? { record: held.record, prfOutput: held.proof.slice(), browserAccessPrf: session.browserAccessPrf?.slice() } : null;
}

export function releaseDeviceCredential(session: VaultSession): void {
  const held = deviceCredentials.get(session);
  if (!held) return;
  held.proof.fill(0);
  deviceCredentials.delete(session);
}

// Serialize read/derive/commit across tabs. Each session keeps its immutable slot;
// changing this tab's selection never changes an existing session's write target.
function withVaultLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const next = vaultLifecycle.catch(() => undefined).then(async () =>
    typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('quiet-room:vault:current', operation)
      : operation());
  vaultLifecycle = next;
  return next;
}

function sameStoredVault(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function staleVaultError(): Error {
  return new Error('本机会话已在其它窗口或设备流程中更新，请锁定后重新解锁');
}

function putCurrentVault(tx: IDBTransaction, next: StoredVault, expected?: StoredVault): void {
  const store = tx.objectStore('vault');
  const id = expected ? vaultSpaceId(expected) : next.spaceId ?? selectedSpace;
  next.spaceId = id;
  if (!expected) { store.put(next, id); return; }
  const request = store.get(id);
  request.onsuccess = () => {
    if (!sameStoredVault(request.result, expected)) { tx.abort(); return; }
    store.put(next, id);
  };
}

async function installStoredVault(next: StoredVault, expected?: StoredVault, roomProtectionRevision?: string,
  guards: StoredVault[] = [], isActive: () => boolean = () => true, signal?: AbortSignal): Promise<void> {
  if (!validateStoredVault(next)) throw new Error('本机保险库格式不受支持，本次更改未保存');
  const database = await openDatabase();
  if (!isActive() || signal?.aborted) { database.close(); throw new DOMException('保险库创建流程已经结束', 'AbortError'); }
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(roomProtectionRevision ? ['vault', 'security'] : ['vault'], 'readwrite');
    const abort = () => { try { tx.abort(); } catch { /* Already committed. */ } };
    const release = () => { signal?.removeEventListener('abort', abort); database.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    for (const guard of guards) {
      const request = tx.objectStore('vault').get(vaultSpaceId(guard));
      request.onsuccess = () => { if (!isActive() || !sameStoredVault(request.result, guard)) tx.abort(); };
    }
    if (roomProtectionRevision) {
      const request = tx.objectStore('security').get('room-protection-v2');
      request.onsuccess = () => {
        if (!isActive() || request.result?.revision !== roomProtectionRevision) { tx.abort(); return; }
        putCurrentVault(tx, next, expected);
      };
    } else putCurrentVault(tx, next, expected);
    tx.oncomplete = () => { release(); resolve(); };
    tx.onabort = () => { release(); reject(signal?.reason ?? tx.error ?? staleVaultError()); };
    tx.onerror = () => { release(); reject(signal?.reason ?? tx.error ?? new Error('保险库写入失败')); };
  });
}

export async function withVaultMutation<T>(
  session: VaultSession,
  operation: (mutation: VaultMutation) => Promise<T>,
): Promise<T> {
  return withVaultLifecycle(async () => {
    if (!sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(session.stored)), session.stored)) throw staleVaultError();
    const mutation: VaultMutation = { session, id: Symbol('vault-mutation') };
    activeVaultMutation = mutation;
    try {
      return await operation(mutation);
    } finally {
      activeVaultMutation = undefined;
    }
  });
}

function ownsVaultMutation(session: VaultSession, mutation?: VaultMutation): boolean {
  return Boolean(mutation && mutation.session === session && activeVaultMutation === mutation);
}

type StoredHistory = {
  id: string;
  roomId: string;
  seq: number;
  iv: string;
  ciphertext: string;
};

type StoredLocalRecord = {
  id: string;
  roomId: string;
  iv: string;
  ciphertext: string;
};

type StoredMediaChunk = {
  id: string;
  roomId: string;
  blobKey: string;
  blobId: string;
  index: number;
  bytes: ArrayBuffer;
  cachedAt: number;
  iv?: Uint8Array<ArrayBuffer>;
  mimeType?: string;
};

type LocalStore = 'privateArchiveStaging' | 'privateMedia' | 'privateArchive' | 'outbox' | 'receiptOutbox' | 'uploads' | 'preferences' | 'memeFavorites';

export type ChatScrollAnchor = {
  clientMsgId: string;
  seq: number;
  offset: number;
  pinnedToBottom: boolean;
};

export type UiPreferences = {
  composerDraft?: string;
  chatAnchor?: ChatScrollAnchor;
  recoveryReminderDismissed?: boolean;
  entranceCardDismissed?: boolean;
  hiddenAlbumHintDismissed?: boolean;
  historyImportDismissed?: boolean;
  recoveryShieldHintSeen?: boolean;
  /** Device-local chat projection; it never mutates encrypted room history. */
  hiddenChatMessageIds?: string[];
  /** GIFs sent without expressionKind still use the GIF box on this device. */
  gifChatMessageIds?: string[];
  /** Device-local Safe ordering/removal projection. */
  galleryCuration?: GalleryCurationRecord[];
  attachmentFavorites?: AttachmentFavorite[];
};

type UnlockThrottle = {
  failures: number;
  nextAllowedAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('restoredGallery')) {
        const gallery = database.createObjectStore('restoredGallery', { keyPath: 'id' });
        gallery.createIndex('roomId', 'roomId', { unique: false });
        gallery.createIndex('roomSeq', ['roomId', 'seq'], { unique: false });
      }
      if (!database.objectStoreNames.contains('galleryHistory')) {
        const galleryHistory = database.createObjectStore('galleryHistory', { keyPath: 'id' });
        galleryHistory.createIndex('roomId', 'roomId', { unique: false });
        galleryHistory.createIndex('roomSeq', ['roomId', 'seq'], { unique: false });
      }
      if (!database.objectStoreNames.contains('vault')) database.createObjectStore('vault');
      if (!database.objectStoreNames.contains('spaces')) database.createObjectStore('spaces');
      if (!database.objectStoreNames.contains('history')) {
        const history = database.createObjectStore('history', { keyPath: 'id' });
        history.createIndex('roomId', 'roomId', { unique: false });
        history.createIndex('roomSeq', ['roomId', 'seq'], { unique: false });
      } else {
        const history = request.transaction!.objectStore('history');
        if (!history.indexNames.contains('roomSeq')) history.createIndex('roomSeq', ['roomId', 'seq'], { unique: false });
      }
      if (!database.objectStoreNames.contains('mediaChunks')) {
        const mediaChunks = database.createObjectStore('mediaChunks', { keyPath: 'id' });
        mediaChunks.createIndex('roomId', 'roomId', { unique: false });
        mediaChunks.createIndex('blobKey', 'blobKey', { unique: false });
      }
      if (!database.objectStoreNames.contains('mediaCacheEntries')) {
        const entries = database.createObjectStore('mediaCacheEntries', { keyPath: 'id' });
        entries.createIndex('roomId', 'roomId', { unique: false });
        const grouped = new Map<string, MediaCacheEntry>();
        const scan = request.transaction!.objectStore('mediaChunks').openCursor();
        scan.onsuccess = () => {
          const cursor = scan.result;
          if (!cursor) {
            let total = [...grouped.values()].reduce((sum, entry) => sum + entry.bytes, 0);
            for (const entry of [...grouped.values()].sort((a, b) => a.usedAt - b.usedAt)) {
              if (total <= 1024 ** 3) { entries.put(entry); continue; }
              total -= entry.bytes;
              const old = request.transaction!.objectStore('mediaChunks');
              const remove = old.index('blobKey').openKeyCursor(IDBKeyRange.only(entry.id));
              remove.onsuccess = () => { const item = remove.result; if (item) { old.delete(item.primaryKey); item.continue(); } };
            }
            return;
          }
          const record = cursor.value as StoredMediaChunk;
          const entry = grouped.get(record.blobKey) ?? { id: record.blobKey, roomId: record.roomId, bytes: 0, usedAt: 0 };
          entry.bytes += record.bytes?.byteLength ?? 0;
          entry.usedAt = Math.max(entry.usedAt, record.cachedAt || 0);
          grouped.set(entry.id, entry); cursor.continue();
        };
      }
      for (const storeName of ['outbox', 'receiptOutbox', 'uploads', 'preferences', 'memeFavorites', 'privateArchive', 'privateMedia', 'privateArchiveStaging'] as const) {
        if (!database.objectStoreNames.contains(storeName)) {
          const store = database.createObjectStore(storeName, { keyPath: 'id' });
          store.createIndex('roomId', 'roomId', { unique: false });
        }
      }
      if (!database.objectStoreNames.contains('security')) database.createObjectStore('security');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

/** Probe an atomic temporary write before offering new local protection. */
export async function assertPasswordProtectionEnvironment(): Promise<void> {
  if (!window.isSecureContext) throw new Error('请通过浏览器信任的安全连接打开此页面');
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function' || typeof globalThis.crypto.randomUUID !== 'function') throw new Error('此浏览器无法使用所需的本机加密，请换用支持的浏览器');
  if (typeof indexedDB === 'undefined') throw new Error('此浏览器无法保存本机加密数据，请检查存储权限');
  try {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('vault', 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('无法保存本机数据'));
        try {
          const store = tx.objectStore('vault'), key = `quiet-room:storage-probe:${crypto.randomUUID()}`;
          store.put(1, key); store.delete(key);
        } catch (cause) { tx.abort(); reject(cause); }
      });
    } finally { database.close(); }
  } catch { throw new Error('此浏览器暂时无法保存本机加密数据，请检查存储权限或可用容量后重试'); }
}

async function transaction<T>(
  storeName: 'spaces' | 'vault' | 'history' | 'galleryHistory' | 'restoredGallery' | 'mediaChunks' | 'mediaCacheEntries' | 'security' | LocalStore,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
  expectedVault?: StoredVault | (() => StoredVault),
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(expectedVault ? [storeName, 'vault'] : storeName, mode);
    let stale = false;
    if (expectedVault) {
      const snapshot = () => typeof expectedVault === 'function' ? expectedVault() : expectedVault;
      const current = tx.objectStore('vault').get(vaultSpaceId(snapshot()));
      current.onsuccess = () => { if (!sameStoredVault(current.result, snapshot())) { stale = true; tx.abort(); } };
    }
    const request = action(tx.objectStore(storeName));
    // An explicit stale-session abort also aborts requests. Let the transaction
    // report its cause instead of turning it into a misleading AbortError.
    tx.onabort = () => { database.close(); reject(stale ? staleVaultError() : tx.error ?? request.error ?? new Error('本机数据读取失败')); };
    tx.oncomplete = () => {
      resolve(request.result);
      database.close();
    };
  });
}

/** New-room browser key is separate from legacy personal roots and never exported. */
export async function readRoomProtection(): Promise<import('./browser-room-key').RoomProtection | null> {
  return (await transaction<import('./browser-room-key').RoomProtection | undefined>('security', 'readonly', store => store.get('room-protection-v2'))) ?? null;
}
export async function replaceRoomProtection(expected: import('./browser-room-key').RoomProtection | null, next: import('./browser-room-key').RoomProtection): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('security', 'readwrite'), store = tx.objectStore('security');
    const current = store.get('room-protection-v2');
    current.onsuccess = () => { if (canonicalStringify(current.result ?? null) !== canonicalStringify(expected)) tx.abort(); else store.put(next, 'room-protection-v2'); };
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onabort = () => { database.close(); reject(new Error('另一页面已修改本机保护，请重试')); };
    tx.onerror = () => { database.close(); reject(tx.error); };
  });
}

/** Explicit destructive reset from the locked help dialog; never an unlock or
 * password reset. A single transaction removes every local room and its keys. */
export async function clearAllRoomBrowserData(expected: import('./browser-room-key').RoomProtection): Promise<void> {
  await withVaultLifecycle(async () => {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const names = [...database.objectStoreNames], tx = database.transaction(names, 'readwrite');
      const request = tx.objectStore('security').get('room-protection-v2');
      request.onsuccess = () => {
        if (canonicalStringify(request.result ?? null) !== canonicalStringify(expected)) { tx.abort(); return; }
        for (const name of names) tx.objectStore(name).clear();
      };
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onabort = () => { database.close(); reject(tx.error ?? new Error('本机保护已改变，请重新打开后再清除')); };
    });
    selectedSpace = 'current';
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      try {
        const storage = window[name];
        for (let index = storage.length - 1; index >= 0; index--) {
          const key = storage.key(index); if (key?.startsWith('quiet-room:')) storage.removeItem(key);
        }
      } catch { /* The committed key/data deletion remains authoritative. */ }
    }
    try { localStorage.setItem('quiet-room:room-data-cleared', crypto.randomUUID()); } catch { /* Vault CAS still rejects stale writes. */ }
  });
}

/** Personal roots are deliberately outside room vaults and all cloud checkpoint serializers. */
export async function readPersonalIdentity(id?: string): Promise<import('./personal-identity-vault').StoredPersonalIdentity | null> {
  const { validStoredPersonalIdentity } = await import('./personal-identity-vault');
  const selected = id ?? await transaction<string | undefined>('security', 'readonly', store => store.get('chamber:personal-current'));
  if (!selected) return null;
  const stored = await transaction('security', 'readonly', store => store.get(`chamber:personal:${selected}`));
  if (!validStoredPersonalIdentity(stored) || stored.identity.id !== selected) throw new Error('本机身份保管数据损坏，请保留数据并使用自己的助记词恢复');
  return stored;
}

/** Insert only: never overwrite another tab's identity or replace its encryption wrapper. */
export async function saveNewPersonalIdentity(stored: import('./personal-identity-vault').StoredPersonalIdentity): Promise<void> {
  const { validStoredPersonalIdentity } = await import('./personal-identity-vault');
  if (!validStoredPersonalIdentity(stored)) throw new Error('身份保管数据不正确');
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('security', 'readwrite'), store = tx.objectStore('security');
    let conflict = false;
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onabort = () => { database.close(); reject(conflict ? new Error('另一页面已经创建身份，请重新打开并使用已有身份') : tx.error ?? new Error('身份未能保存')); };
    const current = store.get('chamber:personal-current');
    current.onsuccess = () => {
      if (current.result) { conflict = true; tx.abort(); return; }
      store.add(stored, `chamber:personal:${stored.identity.id}`);
      store.add(stored.identity.id, 'chamber:personal-current');
    };
  });
  const readback = await readPersonalIdentity(stored.identity.id);
  if (JSON.stringify(readback) !== JSON.stringify(stored)) throw new Error('身份保存回读不一致');
}

/** Explicit full-mnemonic recovery may replace only this identity's protection.
 * It never rewrites or deletes any room vault, history or other identity. */
export async function replacePersonalIdentityProtection(expected:import('./personal-identity-vault').StoredPersonalIdentity,next:import('./personal-identity-vault').StoredPersonalIdentity,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();
  const {validStoredPersonalIdentity}=await import('./personal-identity-vault');
  if(!validStoredPersonalIdentity(expected)||!validStoredPersonalIdentity(next)||canonicalStringify(expected.identity)!==canonicalStringify(next.identity))throw new Error('不能替换其他身份的应用锁');
  const database=await openDatabase();
  if(signal?.aborted){database.close();signal.throwIfAborted();}
  await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction('security','readwrite'),store=tx.objectStore('security'),id=`chamber:personal:${expected.identity.id}`;let stale=false;
    const abort=()=>{try{tx.abort();}catch{/* Already committed or aborted. */}};
    signal?.addEventListener('abort',abort,{once:true});
    const finish=()=>{signal?.removeEventListener('abort',abort);database.close();};
    const current=store.get(id);current.onsuccess=()=>{if(signal?.aborted||canonicalStringify(current.result)!==canonicalStringify(expected)){stale=!signal?.aborted;tx.abort();return;}store.put(next,id);};
    tx.oncomplete=()=>{finish();resolve();};tx.onabort=()=>{finish();reject(signal?.aborted?signal.reason:stale?new Error('身份应用锁已被另一页面更新，请重新开始'):tx.error??new Error('身份应用锁未能保存'));};
  });
  if(canonicalStringify(await readPersonalIdentity(next.identity.id))!==canonicalStringify(next))throw new Error('身份应用锁保存回读不一致');
}

/** Legacy records retain their room namespace. Independent root-recovered
 * devices never overwrite ciphertext encrypted under another local master. */
function localDataScope(vault: Pick<Vault, 'roomId' | 'localDataScope'>): string {
  if (!vault.localDataScope) return vault.roomId;
  if (!/^[0-9a-f-]{36}(?::private:[0-9a-f-]{36})?$/i.test(vault.localDataScope)) throw new Error('本机数据范围不正确');
  return vault.localDataScope;
}

function mediaBlobKey(roomId: string, blobId: string): string {
  return `${roomId}\u0000${blobId}`;
}

/** Large recovery manifests stay outside the frequently rewritten room payload.
 * Ciphertext is durable before the small pending reference or network mutation. */
export async function saveChamberRecoveryManifest(session: VaultSession, requestId: string, value: unknown, signal: AbortSignal): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('恢复请求编号不正确');
  const id = `chamber:history-job:${vaultSpaceId(session.stored)}:${requestId}`;
  const raw = encoder.encode(canonicalStringify(value)), iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    if (raw.length > 8 * 1024 ** 2) throw new Error('恢复范围超过安全处理上限');
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) },session.key,raw);
    await withVaultMutation(session, async () => {
      signal.throwIfAborted();
      const database = await openDatabase();
      await new Promise<void>((resolve,reject) => {
        const tx = database.transaction(['security','vault'],'readwrite');
        const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
        current.onsuccess = () => { if (!sameStoredVault(current.result,session.stored) || signal.aborted) tx.abort(); };
        tx.objectStore('security').put({ iv, ciphertext },id);
        tx.oncomplete = () => { database.close(); resolve(); };
        tx.onabort = () => { database.close(); reject(tx.error ?? staleVaultError()); };
      });
    });
  } finally { raw.fill(0); }
}
export async function readChamberRecoveryManifest<T>(session: VaultSession,requestId: string): Promise<T> {
  const id = `chamber:history-job:${vaultSpaceId(session.stored)}:${requestId}`;
  const record = await transaction<{iv:Uint8Array<ArrayBuffer>;ciphertext:ArrayBuffer}>('security','readonly',store => store.get(id));
  if (!record) throw new Error('本机恢复请求缺失，请重新发起');
  const raw = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:encoder.encode(id)},session.key,record.ciphertext));
  try { return JSON.parse(decoder.decode(raw)) as T; } finally { raw.fill(0); }
}

function mediaChunkId(roomId: string, blobId: string, index: number): string {
  return `${mediaBlobKey(roomId, blobId)}\u0000${index}`;
}

/** Disposable, locally encrypted copies of already verified cloud ciphertext.
 * These contain no released data keys or root material. They allow a bounded
 * root operation to resume slow downloads without retaining root authority. */
export async function cacheChamberHistoryCipher(session:VaultSession,record:import('./chamber-history-record').ChamberHistoryRecord,signal:AbortSignal):Promise<void> {
  const blobId=`chamber-unit:${record.id}`,scope=localDataScope(session.vault),iv=crypto.getRandomValues(new Uint8Array(12)),raw=encoder.encode(canonicalStringify(record));
  try {
    if(raw.length>4_300_000)throw new Error('历史密文分块过大');
    const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`chamber-unit-cache-v1:${scope}:${record.id}`)},session.key,raw);
    await writeMediaCacheRecord(session,{id:mediaChunkId(scope,blobId,0),roomId:scope,blobKey:mediaBlobKey(scope,blobId),blobId,index:0,bytes,iv,cachedAt:Date.now()},signal);
  }finally{raw.fill(0);}
}
export async function loadChamberHistoryCipher(session:VaultSession,id:string):Promise<import('./chamber-history-record').ChamberHistoryRecord|null> {
  const scope=localDataScope(session.vault),record=await transaction<StoredMediaChunk|undefined>('mediaChunks','readonly',store=>store.get(mediaChunkId(scope,`chamber-unit:${id}`,0)),()=>session.stored);
  if(!record?.iv)return null;
  try {
    const raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:encoder.encode(`chamber-unit-cache-v1:${scope}:${id}`)},session.key,record.bytes));
    try {const value=JSON.parse(decoder.decode(raw)) as import('./chamber-history-record').ChamberHistoryRecord;return value.id===id?value:null;}finally{raw.fill(0);}
  }catch{return null;}
}

/**
 * Persist only the server ciphertext. Plaintext blobs and object URLs remain
 * memory-only and are still cleared synchronously on privacy teardown.
 */
export async function loadCachedMediaChunk(
  session: VaultSession,
  blobId: string,
  index: number,
  expectedBytes: number,
): Promise<ArrayBuffer | null> {
  const record = await transaction<StoredMediaChunk | undefined>('mediaChunks', 'readonly', store =>
    store.get(mediaChunkId(localDataScope(session.vault), blobId, index)), () => session.stored);
  if (!record || record.roomId !== localDataScope(session.vault) || record.blobId !== blobId || record.index !== index ||
      !(record.bytes instanceof ArrayBuffer) || record.bytes.byteLength !== expectedBytes) return null;
  await touchMediaCache(session, record.blobKey).catch(() => undefined);
  return record.bytes.slice(0);
}

export async function saveCachedMediaChunk(
  session: VaultSession,
  blobId: string,
  index: number,
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<void> {
  const roomId = localDataScope(session.vault);
  const record: StoredMediaChunk = {
    id: mediaChunkId(roomId, blobId, index),
    roomId,
    blobKey: mediaBlobKey(roomId, blobId),
    blobId,
    index,
    bytes: bytes.slice(0),
    cachedAt: Date.now(),
  };
  await writeMediaCacheRecord(session, record, signal);
}

/** Explicit verified history restoration supports the existing 256 MiB
 * attachment limit. The shared total/reserve/quota budget remains unchanged. */
export async function saveChamberRecoveredMediaChunk(session:VaultSession,blobId:string,index:number,bytes:ArrayBuffer,signal:AbortSignal):Promise<void> {
  const roomId=localDataScope(session.vault);
  await writeMediaCacheRecord(session,{id:mediaChunkId(roomId,blobId,index),roomId,blobKey:mediaBlobKey(roomId,blobId),blobId,index,bytes:bytes.slice(0),cachedAt:Date.now()},signal,MAX_IMAGE_BYTES+1024**2);
}

async function touchMediaCache(session: VaultSession, id: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['mediaCacheEntries', 'vault'], 'readwrite');
    const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
    current.onsuccess = () => {
      if (!sameStoredVault(current.result, session.stored)) { tx.abort(); return; }
      const entries = tx.objectStore('mediaCacheEntries'); const read = entries.get(id);
      read.onsuccess = () => { if (read.result && Date.now() - read.result.usedAt > 60_000) entries.put({ ...read.result, usedAt: Date.now() }); };
    };
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onabort = () => { database.close(); reject(tx.error ?? staleVaultError()); };
  });
}

// After an unexpected quota failure, leave space for durable history and stop
// filling it again during this unlocked session. Only disposable stores are cleared.
const mediaCacheQuotaBlocked = new WeakSet<VaultSession>();
async function releaseMediaCachePressure(session: VaultSession): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['vault', 'mediaChunks', 'mediaCacheEntries'], 'readwrite');
    const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
    current.onsuccess = () => {
      if (!sameStoredVault(current.result, session.stored)) { tx.abort(); return; }
      tx.objectStore('mediaChunks').clear(); tx.objectStore('mediaCacheEntries').clear();
    };
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onabort = () => { database.close(); reject(tx.error ?? staleVaultError()); };
  });
}

async function writeMediaCacheRecord(session: VaultSession, record: StoredMediaChunk, signal?: AbortSignal,maxBlobBytes=MEDIA_CACHE_FILE_BYTES+1024**2): Promise<void> {
  signal?.throwIfAborted();
  if (mediaCacheQuotaBlocked.has(session)) return;
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['mediaChunks', 'mediaCacheEntries', 'vault'], 'readwrite');
    const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
    current.onsuccess = () => {
      if (signal?.aborted || !sameStoredVault(current.result, session.stored)) { tx.abort(); return; }
      const chunks = tx.objectStore('mediaChunks'), entries = tx.objectStore('mediaCacheEntries');
      const all = entries.getAll(); const old = chunks.get(record.id);
      old.onsuccess = () => {
        const rows = all.result as MediaCacheEntry[];
        const previous = rows.find(item => item.id === record.blobKey);
        const delta = record.bytes.byteLength - (record.index === -1 ? previous?.bytes ?? 0 : old.result?.bytes.byteLength ?? 0);
        const next = { id: record.blobKey, roomId: record.roomId, bytes: (previous?.bytes ?? 0) + delta, usedAt: Date.now() };
        const total = rows.reduce((sum, item) => sum + item.bytes, 0);
        const budget = mediaCacheBudget(estimate, total);
        const remove = (id: string) => {
          entries.delete(id);
          const request = chunks.index('blobKey').openKeyCursor(IDBKeyRange.only(id));
          request.onsuccess = () => { const cursor = request.result; if (cursor) { chunks.delete(cursor.primaryKey); cursor.continue(); } };
        };
        if (next.bytes > maxBlobBytes || next.bytes > budget) { remove(next.id); return; }
        for (const id of mediaCacheEvictions(rows, { ...next, bytes: delta }, budget)) remove(id);
        if (record.index === -1) {
          const request = chunks.index('blobKey').openCursor(IDBKeyRange.only(record.blobKey));
          request.onsuccess = () => { const cursor = request.result; if (cursor) { if (cursor.value.index >= 0) cursor.delete(); cursor.continue(); } };
        }
        chunks.put(record); entries.put(next);
      };
    };
    const abort = () => { try { tx.abort(); } catch { /* already closed */ } };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = () => { signal?.removeEventListener('abort', abort); database.close(); };
    tx.oncomplete = () => { finish(); resolve(); };
    tx.onabort = () => { finish(); reject(tx.error ?? staleVaultError()); };
  }).catch(async error => {
    if (error?.name !== 'QuotaExceededError') throw error;
    mediaCacheQuotaBlocked.add(session);
    await releaseMediaCachePressure(session).catch(() => undefined);
  });
}

async function mediaPreviewKey(session: VaultSession): Promise<CryptoKey> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', session.key));
  try {
    const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
      salt: encoder.encode(localDataScope(session.vault)), info: encoder.encode('quiet-room-media-preview-v1') },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { raw.fill(0); }
}

/** Derived bytes are authenticated to the complete original manifest and local room. */
export async function saveMediaPreview(session: VaultSession, manifest: import('./types').ImageManifest, blob: Blob, signal?: AbortSignal, variant: 'preview' | 'concealed' = 'preview'): Promise<void> {
  if (blob.size > 16 * 1024 ** 2 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(blob.type)) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(canonicalStringify({ purpose: `quiet-room-media-${variant}-v1`, roomId: localDataScope(session.vault), manifest, mimeType: blob.type }));
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await mediaPreviewKey(session), await blob.arrayBuffer());
  signal?.throwIfAborted();
  const index = variant === 'preview' ? -1 : -3;
  await writeMediaCacheRecord(session, { id: mediaChunkId(localDataScope(session.vault), manifest.blobId, index), roomId: localDataScope(session.vault), blobKey: mediaBlobKey(localDataScope(session.vault), manifest.blobId), blobId: manifest.blobId, index, bytes, iv, mimeType: blob.type, cachedAt: Date.now() }, signal);
}

export async function loadMediaPreview(session: VaultSession, manifest: import('./types').ImageManifest, signal?: AbortSignal, variant: 'preview' | 'concealed' = 'preview'): Promise<Blob | null> {
  const record = await transaction<StoredMediaChunk | undefined>('mediaChunks', 'readonly', store => store.get(mediaChunkId(localDataScope(session.vault), manifest.blobId, variant === 'preview' ? -1 : -3)), () => session.stored);
  if (!record?.iv || !record.mimeType || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(record.mimeType)) return null;
  try {
    const additionalData = encoder.encode(canonicalStringify({ purpose: `quiet-room-media-${variant}-v1`, roomId: localDataScope(session.vault), manifest, mimeType: record.mimeType }));
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData }, await mediaPreviewKey(session), record.bytes);
    signal?.throwIfAborted();
    await touchMediaCache(session, record.blobKey).catch(() => undefined);
    return new Blob([bytes], { type: record.mimeType });
  } catch (error) {
    signal?.throwIfAborted();
    await deleteCachedMediaBlob(session, manifest.blobId).catch(() => undefined);
    return null;
  }
}

const playbackMimes = ['video/mp4', 'video/webm'];

/** Authenticated local playback file. It does not replace the poster or the server original. */
export async function saveMediaPlayback(session: VaultSession, manifest: import('./types').ImageManifest, blob: Blob, signal?: AbortSignal): Promise<void> {
  if (blob.size > 48 * 1024 ** 2 || !playbackMimes.includes(blob.type)) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(canonicalStringify({ purpose: 'quiet-room-media-playback-v1', roomId: localDataScope(session.vault), manifest, mimeType: blob.type }));
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await mediaPreviewKey(session), await blob.arrayBuffer());
  signal?.throwIfAborted();
  await writeMediaCacheRecord(session, { id: mediaChunkId(localDataScope(session.vault), manifest.blobId, -2), roomId: localDataScope(session.vault), blobKey: mediaBlobKey(localDataScope(session.vault), manifest.blobId), blobId: manifest.blobId, index: -2, bytes, iv, mimeType: blob.type, cachedAt: Date.now() }, signal);
}

export async function loadMediaPlayback(session: VaultSession, manifest: import('./types').ImageManifest, signal?: AbortSignal): Promise<Blob | null> {
  const record = await transaction<StoredMediaChunk | undefined>('mediaChunks', 'readonly', store => store.get(mediaChunkId(localDataScope(session.vault), manifest.blobId, -2)), () => session.stored);
  if (!record?.iv || !record.mimeType || !playbackMimes.includes(record.mimeType)) return null;
  try {
    const additionalData = encoder.encode(canonicalStringify({ purpose: 'quiet-room-media-playback-v1', roomId: localDataScope(session.vault), manifest, mimeType: record.mimeType }));
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData }, await mediaPreviewKey(session), record.bytes);
    signal?.throwIfAborted();
    await touchMediaCache(session, record.blobKey).catch(() => undefined);
    return new Blob([bytes], { type: record.mimeType });
  } catch (error) {
    signal?.throwIfAborted();
    await deleteCachedMediaBlob(session, manifest.blobId).catch(() => undefined);
    return null;
  }
}

export async function deleteCachedMediaBlob(session: VaultSession, blobId: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['mediaChunks', 'mediaCacheEntries', 'vault'], 'readwrite');
    const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
    current.onsuccess = () => {
      if (!sameStoredVault(current.result, session.stored)) {
        tx.abort();
        return;
      }
      tx.objectStore('mediaCacheEntries').delete(mediaBlobKey(localDataScope(session.vault), blobId));
      const request = tx.objectStore('mediaChunks').index('blobKey')
        .openKeyCursor(IDBKeyRange.only(mediaBlobKey(localDataScope(session.vault), blobId)));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        tx.objectStore('mediaChunks').delete(cursor.primaryKey);
        cursor.continue();
      };
    };
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onabort = () => { database.close(); reject(tx.error ?? staleVaultError()); };
    tx.onerror = () => reject(tx.error ?? new Error('媒体密文缓存清理失败'));
  });
}

function isBoundedBase64(value: unknown, minimum = 16, maximum = MAX_LEGACY_VAULT_CIPHERTEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}

function validateKdf(value: unknown): value is VaultKdf {
  if (!value || typeof value !== 'object') return false;
  const kdf = value as VaultKdf;
  return Boolean(
    kdf.name === 'argon2id' &&
    Number.isInteger(kdf.memorySize) && kdf.memorySize >= 8 * 1024 && kdf.memorySize <= 256 * 1024 &&
    Number.isInteger(kdf.iterations) && kdf.iterations >= 1 && kdf.iterations <= 10 &&
    Number.isInteger(kdf.parallelism) && kdf.parallelism >= 1 && kdf.parallelism <= 4 &&
    isBoundedBase64(kdf.salt, 20, 128)
  );
}

function validatePlatformRecord(value: unknown): value is PlatformCredentialRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as PlatformCredentialRecord;
  return Boolean(
    isBoundedBase64(record.credentialId, 16, 2048) &&
    (record.rpId === undefined || (typeof record.rpId === 'string' && record.rpId.length >= 1 && record.rpId.length <= 253)) &&
    (record.origin === undefined || (typeof record.origin === 'string' && record.origin.length >= 1 && record.origin.length <= 2048)) &&
    (record.userId === undefined || isBoundedBase64(record.userId, 1, 86)) &&
    (record.userName === undefined || (typeof record.userName === 'string' && record.userName.length <= 4096)) &&
    isBoundedBase64(record.prfSalt, 20, 128) &&
    Array.isArray(record.transports) && record.transports.length <= 8 &&
    record.transports.every((transport) => typeof transport === 'string' && transport.length <= 32) &&
    (record.authenticatorAttachment === null || record.authenticatorAttachment === 'platform' || record.authenticatorAttachment === 'cross-platform') &&
    typeof record.backupEligible === 'boolean' &&
    typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
  );
}

function validateLegacyStoredVault(value: unknown): value is LegacyStoredVault {
  if (!value || typeof value !== 'object') return false;
  const stored = value as LegacyStoredVault;
  return Boolean(
    stored.v === 1 &&
    (stored.unlockMethod === undefined || stored.unlockMethod === 'password' || stored.unlockMethod === 'gesture') &&
    validateKdf(stored.kdf) &&
    isBoundedBase64(stored.iv, 16, 128) &&
    isBoundedBase64(stored.ciphertext)
  );
}

function validatePlatformStoredVault(value: unknown): value is StoredPlatformVault {
  if (!value || typeof value !== 'object') return false;
  const stored = value as StoredPlatformVault;
  return Boolean(
    (stored.v === 2 || stored.v === 3) && stored.unlockMethod === 'platform' &&
    (stored.v === 3 || validateKdf(stored.kdf)) &&
    validatePlatformRecord(stored.platform) &&
    isBoundedBase64(stored.wrappedKey?.iv, 16, 128) &&
    isBoundedBase64(stored.wrappedKey?.ciphertext, 48, 256) &&
    isBoundedBase64(stored.payload?.iv, 16, 128) &&
    isBoundedBase64(stored.payload?.ciphertext, 16, MAX_VAULT_PAYLOAD_CIPHERTEXT_LENGTH)
  );
}

function validateRecoveryStoredVault(value: unknown): value is StoredRecoveryVault {
  if (!value || typeof value !== 'object') return false;
  const stored = value as StoredRecoveryVault;
  return Boolean(
    (stored.v === 2 || stored.v === 3) && stored.unlockMethod === 'recovery' &&
    typeof stored.exportedAt === 'string' && Number.isFinite(Date.parse(stored.exportedAt)) &&
    isBoundedBase64(stored.payload?.iv, 16, 128) &&
    isBoundedBase64(stored.payload?.ciphertext, 16, MAX_VAULT_PAYLOAD_CIPHERTEXT_LENGTH) &&
    isBoundedBase64(stored.recovery?.salt, 20, 128) &&
    isBoundedBase64(stored.recovery?.iv, 16, 128) &&
    isBoundedBase64(stored.recovery?.ciphertext, 48, 256)
  );
}

function validateStoredVault(value: unknown): value is StoredVault {
  const stored = value as StoredPasswordVault | null;
  const password = stored?.v === 3 && stored.unlockMethod === 'password' && validPasswordKdf(stored.kdf) &&
    (stored.passwordFormat === undefined || stored.passwordFormat === 'numeric-6') &&
    isBoundedBase64(stored.wrappedKey?.iv, 16, 16) && isBoundedBase64(stored.wrappedKey?.ciphertext, 64, 64) &&
    isBoundedBase64(stored.payload?.iv, 16, 16) && isBoundedBase64(stored.payload?.ciphertext, 16, MAX_VAULT_PAYLOAD_CIPHERTEXT_LENGTH);
  return Boolean(password) || validateLegacyStoredVault(value) || validatePlatformStoredVault(value) || validateRecoveryStoredVault(value);
}

async function deriveGestureBytes(secret: string, existing?: VaultKdf): Promise<{ bytes: Uint8Array<ArrayBuffer>; kdf: VaultKdf }> {
  const kdf = existing ?? {
    name: 'argon2id' as const,
    memorySize: 19_456,
    iterations: 2,
    parallelism: 1,
    salt: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const result = await argon2id({
    password: secret,
    salt: fromBase64Url(kdf.salt),
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memorySize,
    hashLength: 32,
    outputType: 'binary',
  });
  return { bytes: Uint8Array.from(result as Uint8Array), kdf };
}

async function importMasterKey(bytes: BufferSource): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

async function derivePlatformKek(
  prfOutput: Uint8Array<ArrayBuffer>,
  gestureBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: gestureBytes,
      info: encoder.encode('quiet-room-platform-kek-v2'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  prfOutput.fill(0);
  gestureBytes.fill(0);
  return key;
}

async function derivePasskeyKek(
  prfOutput: Uint8Array<ArrayBuffer>,
  platform: PlatformCredentialRecord,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: fromBase64Url(platform.prfSalt),
      info: encoder.encode(`quiet-room-platform-kek-v3:${platform.credentialId}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  prfOutput.fill(0);
  return key;
}

function wrapperAad(platform: PlatformCredentialRecord, version: 2 | 3): Uint8Array<ArrayBuffer> {
  return encoder.encode(`quiet-room-master-key-v${version}:${platform.credentialId}`);
}

function encodeVaultPlaintext(vault: Vault, maximum: number): Uint8Array<ArrayBuffer> {
  // All vault writers, including atomic MLS/history/outbox commits, pass here
  // before opening their write transaction. Never commit a payload the reader
  // would later reject. AES-GCM adds a 16-byte tag; base64url omits padding.
  const text = JSON.stringify(vault);
  const maximumBytes = Math.floor(maximum * 3 / 4) - 16;
  if (text.length > maximumBytes) throw new Error('本机保险库容量超过支持上限，本次更改未保存');
  const plaintext = encoder.encode(text);
  if (plaintext.length > maximumBytes) throw new Error('本机保险库容量超过支持上限，本次更改未保存');
  return plaintext;
}

async function encryptPayload(vault: Vault, key: CryptoKey): Promise<StoredPlatformVault['payload']> {
  const plaintext = encodeVaultPlaintext({ ...vault, v: 3 }, MAX_VAULT_PAYLOAD_CIPHERTEXT_LENGTH);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: PLATFORM_PAYLOAD_AAD, tagLength: 128 },
    key,
    plaintext,
  );
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
}

async function decryptPayload(payload: StoredPlatformVault['payload'], key: CryptoKey): Promise<Vault> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(payload.iv),
      additionalData: PLATFORM_PAYLOAD_AAD,
      tagLength: 128,
    },
    key,
    fromBase64Url(payload.ciphertext),
  );
  const vault = JSON.parse(decoder.decode(plaintext)) as Vault;
  if ((vault.v !== 1 && vault.v !== 2 && vault.v !== 3) || !vault.roomId || !vault.identity?.publicBundle?.deviceId) {
    throw new Error('INVALID_VAULT');
  }
  return vault;
}

async function wrapMasterKey(
  masterBytes: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
  platform: PlatformCredentialRecord,
): Promise<StoredPlatformVault['wrappedKey']> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: wrapperAad(platform, 3), tagLength: 128 },
    kek,
    masterBytes,
  );
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
}

async function unwrapMasterKey(stored: StoredPlatformVault, kek: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(stored.wrappedKey.iv),
      additionalData: wrapperAad(stored.platform, stored.v),
      tagLength: 128,
    },
    kek,
    fromBase64Url(stored.wrappedKey.ciphertext),
  );
  if (plaintext.byteLength !== 32) throw new Error('INVALID_MASTER_KEY');
  return new Uint8Array(plaintext);
}

async function encryptLegacyVault(
  vault: Vault,
  key: CryptoKey,
  kdf: VaultKdf,
  unlockMethod: 'password' | 'gesture',
): Promise<LegacyStoredVault> {
  const plaintext = encodeVaultPlaintext(vault, MAX_LEGACY_VAULT_CIPHERTEXT_LENGTH);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode('quiet-room-vault-v1'), tagLength: 128 },
    key,
    plaintext,
  );
  return { v: 1, unlockMethod, kdf, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
}

export async function hasStoredVault(): Promise<boolean> {
  // Presence, not truthiness, matters here: a truncated/invalid record may be
  // a falsy value and must still reach the recovery/diagnostic screen instead
  // of being mistaken for a first-run vault.
  if (await localSpaceExists(selectedSpace)) return true;
  // A cancelled creation does not displace the last durable room on reload.
  const fallback = savedSpace();
  if (fallback !== selectedSpace && await localSpaceExists(fallback)) selectedSpace = fallback;
  else if (await localSpaceExists('current')) selectedSpace = 'current';
  else {
    const keys = await transaction<IDBValidKey[]>('vault', 'readonly', store => store.getAllKeys());
    const first = keys.find(key => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(key));
    if (typeof first === 'string') selectedSpace = first;
  }
  return localSpaceExists(selectedSpace);
}

export async function readStoredVault(): Promise<StoredVault | null> {
  return withVaultLifecycle(() => readStoredVaultUnlocked());
}

async function readStoredVaultUnlocked(id = selectedSpace): Promise<StoredVault | null> {
  const value: unknown = await transaction('vault', 'readonly', (store) => store.get(id));
  return validateStoredVault(value) && vaultSpaceId(value) === id ? value : null;
}

export async function deleteCurrentVault(): Promise<void> {
  await withVaultLifecycle(async () => {
    const id = selectedSpace;
    await transaction('vault', 'readwrite', store => store.delete(id));
    clearDraftCheckpoints(id);
  });
}

/** Delete the verified target, independent of concurrent selected-space changes. */
export async function deleteSpaceVault(session: VaultSession): Promise<void> {
  await withVaultLifecycle(async () => {
    const id = vaultSpaceId(session.stored);
    const stored = await readStoredVaultUnlocked(id);
    if (!stored) return;
    if (!sameStoredVault(stored, session.stored)) throw new Error('密室状态已变化，请重新打开后重试');
    await transaction('vault', 'readwrite', store => store.delete(id));
    clearDraftCheckpoints(id);
  });
}

/** Remove room-scoped browser data while keeping the current vault record. */
export async function clearLocalBrowserData(session: VaultSession): Promise<void> {
  await withVaultLifecycle(async () => {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const stores = ['history', 'galleryHistory', 'restoredGallery', 'mediaCacheEntries', 'mediaChunks', 'outbox', 'receiptOutbox', 'uploads', 'preferences', 'memeFavorites', 'privateArchive', 'privateMedia', 'privateArchiveStaging'];
      const tx = database.transaction(['vault', ...stores], 'readwrite');
      const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
      current.onsuccess = () => {
        if (!sameStoredVault(current.result, session.stored)) tx.abort();
      };
      for (const name of stores) {
        const request = tx.objectStore(name).index('roomId').openKeyCursor(IDBKeyRange.bound(localDataScope(session.vault), `${localDataScope(session.vault)}\uffff`));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          tx.objectStore(name).delete(cursor.primaryKey);
          cursor.continue();
        };
      }
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onabort = () => { database.close(); reject(tx.error ?? new Error('本地数据清理失败')); };
      tx.onerror = () => reject(tx.error ?? new Error('本地数据清理失败'));
    });
    // An authenticated empty checkpoint also fences older queued preference
    // saves. Removing it alone would let their legacy draft become the fallback.
    const cleared = await openDraftCheckpoint(session.key, composerDraftScope(session), '', undefined, localStorage, true);
    cleared.dispose();
  });
}

export async function downloadVaultDiagnostic(): Promise<void> {
  const value: unknown = await transaction('vault', 'readonly', (store) => store.get(selectedSpace));
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const diagnostic = {
    format: 'quiet-room-vault-diagnostic',
    version: 1,
    exportedAt: new Date().toISOString(),
    stored: value !== undefined,
    schemaVersion: typeof record?.v === 'number' ? record.v : null,
    unlockMethod: typeof record?.unlockMethod === 'string' ? record.unlockMethod : null,
    valid: validateStoredVault(value),
  };
  await downloadBlob(
    new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }),
    `quiet-room-vault-diagnostic-${new Date().toISOString().slice(0, 10)}.json`,
  );
}

export async function createVault(
  vault: Vault,
  legacySecret = '',
  unlockMethod: 'password' | 'platform' = 'platform',
  preparedPlatformCredential?: LocalCredentialResult,
  isActive: () => boolean = () => true,
): Promise<VaultSession> {
  return withVaultLifecycle(async () => {
    // A second first-run tab must never replace the first tab's newly created room.
    if (await localSpaceExists(selectedSpace)) selectedSpace = crypto.randomUUID();
    return createVaultLocked(vault, legacySecret, unlockMethod, preparedPlatformCredential, isActive);
  });
}

/** Discover only locally authenticated owners; a live-room link grants no history key. */
export async function findArchiveHistoryOwner(target: Vault, secret: string,
  isActive: () => boolean, sourceDeviceId = target.identity.publicBundle.deviceId, signal?: AbortSignal): Promise<VaultSession | null> {
  if (!target.roomArchiveV2 || !secret) return null;
  const check = () => { signal?.throwIfAborted(); if (!isActive()) throw new DOMException('历史核验流程已经结束', 'AbortError'); };
  check();
  const ids = await transaction<IDBValidKey[]>('vault', 'readonly', store => store.getAllKeys(undefined, 257));
  if (ids.length > 256) throw new Error('本机保险库数量超出自动核验范围，原数据已保留');
  let preferred: VaultSession | null = null, fallback: VaultSession | null = null, preferredAmbiguous = false, fallbackAmbiguous = false;
  const damagedOwners = new Set<string>();
  const ownerTag = async (session: VaultSession) => {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', session.key));
    const scope = encoder.encode(localDataScope(session.vault)), material = new Uint8Array(raw.length + scope.length);
    try { material.set(raw); material.set(scope, raw.length); return toBase64Url(await crypto.subtle.digest('SHA-256', material)); }
    finally { raw.fill(0); material.fill(0); }
  };
  const sameOwner = async (left: VaultSession, right: VaultSession) => {
    if (localDataScope(left.vault) !== localDataScope(right.vault) ||
        canonicalStringify(left.vault.roomArchiveV2!.key) !== canonicalStringify(right.vault.roomArchiveV2!.key)) return false;
    const a = new Uint8Array(await crypto.subtle.exportKey('raw', left.key)), b = new Uint8Array(await crypto.subtle.exportKey('raw', right.key));
    try { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
    finally { a.fill(0); b.fill(0); }
  };
  for (const id of ids) {
    check();
    if (typeof id !== 'string') continue;
    const stored = await withVaultLifecycle(() => readStoredVaultUnlocked(id));
    if (!stored || stored.v !== 3 || stored.unlockMethod !== 'password' || !stored.browserRoomKey) continue;
    let candidate: VaultSession;
    try {
      const master = await unwrapPasswordMaster(stored, secret);
      try { const key = await importMasterKey(master); candidate = { stored, key, vault: await decryptPayload(stored.payload, key) }; }
      finally { master.fill(0); }
    } catch { check(); continue; } // Another protection or invalid envelope remains untouched.
    check();
    const vault = candidate.vault, own = vault.identity.publicBundle.deviceId;
    if (!vault.roomArchiveV2 || vault.roomId !== target.roomId || vault.role !== target.role || vault.creatorFingerprint !== target.creatorFingerprint) continue;
    if (own !== sourceDeviceId && target.members.some(m => m.deviceId === own && m.status === 'active')) continue;
    try {
      await loadMessageEventHistory(candidate, { signal });
      check();
      const rows = await Promise.all((['history', 'galleryHistory', 'restoredGallery'] as const).map(store =>
        loadHistoryRecordsAfter(candidate, { limit: 1, afterSeq: 0, signal }, store)));
      if (!rows.some(page => page.length) && own !== sourceDeviceId) continue;
    } catch (cause) {
      check();
      if (cause instanceof HistoryIntegrityError) { damagedOwners.add(await ownerTag(candidate)); continue; }
      throw cause; // A raced owner or storage failure is not permission to choose another key.
    }
    if (own === sourceDeviceId) {
      if (preferred && !await sameOwner(preferred, candidate)) preferredAmbiguous = true;
      preferred ??= candidate;
    } else {
      if (fallback && !await sameOwner(fallback, candidate)) fallbackAmbiguous = true;
      fallback ??= candidate;
    }
  }
  // Multiple snapshots of the same key/scope are one owner. Distinct owners
  // are ambiguous, so retain all of them rather than choosing by timestamp.
  check();
  const chosen = preferred ? (preferredAmbiguous ? null : preferred) : (fallbackAmbiguous ? null : fallback);
  // A lower/older checkpoint cannot conceal a missing tombstone required by
  // another authenticated snapshot of this same local key and namespace.
  if (chosen && damagedOwners.has(await ownerTag(chosen))) return null;
  check(); return chosen;
}

/** Discover already-installed successors; neither links nor storage selection grant membership. */
export async function findLocalArchiveSuccessors(source: VaultSession, secret: string,
  isActive: () => boolean, signal?: AbortSignal): Promise<VaultSession[]> {
  const check = () => { signal?.throwIfAborted(); if (!isActive()) throw new DOMException('本机接入核验已结束', 'AbortError'); };
  check();
  if (!source.vault.roomArchiveV2 || !secret) return [];
  const ids = await transaction<IDBValidKey[]>('vault', 'readonly', store => store.getAllKeys(undefined, 257));
  if (ids.length > 256) throw new Error('本机保险库数量超出自动核验范围，原数据已保留');
  const master = new Uint8Array(await crypto.subtle.exportKey('raw', source.key));
  const result: VaultSession[] = [];
  try {
    for (const id of ids) {
      check();
      if (typeof id !== 'string' || id === vaultSpaceId(source.stored)) continue;
      const stored = await withVaultLifecycle(() => readStoredVaultUnlocked(id));
      if (!stored || stored.v !== 3 || stored.unlockMethod !== 'password' || !stored.browserRoomKey) continue;
      let candidate: VaultSession;
      let sharedMaster = false;
      try {
        const raw = await unwrapPasswordMaster(stored, secret);
        try {
          if (raw.length !== master.length || !raw.every((byte, i) => byte === master[i])) continue;
          sharedMaster = true;
          const key = await importMasterKey(raw);
          candidate = { stored, key, vault: await decryptPayload(stored.payload, key) };
        } finally { raw.fill(0); }
      } catch {
        check();
        if (sharedMaster) throw new Error('本机同历史保险库无法验证，原数据已保留');
        continue;
      }
      check();
      const vault = candidate.vault, before = source.vault, oldId = before.identity.publicBundle.deviceId;
      const own = vault.identity.publicBundle.deviceId;
      if (!vault.roomArchiveV2 || vault.roomId !== before.roomId || vault.role !== before.role || vault.creatorFingerprint !== before.creatorFingerprint ||
        localDataScope(vault) !== localDataScope(before) || canonicalStringify(vault.roomArchiveV2.key) !== canonicalStringify(before.roomArchiveV2!.key) ||
        own === oldId || vault.pairingState !== 'ready' || vault.mls?.phase !== 'active') continue;
      const previous = vault.members.find(m => m.deviceId === oldId), current = vault.members.find(m => m.deviceId === own);
      if (previous?.status !== 'revoked' || previous.role !== before.role || current?.status !== 'active' || current.role !== before.role ||
        canonicalStringify(previous.signingKey) !== canonicalStringify(before.identity.publicBundle.signingKey) ||
        canonicalStringify(previous.encryptionKey) !== canonicalStringify(before.identity.publicBundle.encryptionKey) ||
        previous.mlsKeyPackage !== before.identity.publicBundle.mlsKeyPackage) continue;
      result.push(candidate);
    }
    check(); return result;
  } finally { master.fill(0); }
}

/** Move only the selection after both immutable encrypted snapshots and lifetime are rechecked. */
export async function selectVerifiedArchiveSuccessor(source: VaultSession, target: VaultSession, isActive: () => boolean): Promise<void> {
  await withVaultLifecycle(async () => {
    if (!sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(source.stored)), source.stored) ||
      !sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(target.stored)), target.stored)) throw staleVaultError();
    if (!isActive()) throw new DOMException('本机接入核验已结束', 'AbortError');
    selectedSpace = vaultSpaceId(target.stored); rememberSpace(selectedSpace);
  });
}

/** Fork an authenticated local owner without overwriting either original slot or its records. */
export async function createArchiveRepairVault(vault: Vault, owner: VaultSession, credential: LocalCredentialResult,
  isActive: () => boolean, current?: VaultSession, signal?: AbortSignal): Promise<VaultSession> {
  return withVaultMutation(owner, async mutation => {
    if (!isActive()) throw new DOMException('历史关联流程已经结束', 'AbortError');
    if (!vault.roomArchiveV2 || !owner.vault.roomArchiveV2 || vault.roomId !== owner.vault.roomId || vault.role !== owner.vault.role ||
        vault.creatorFingerprint !== owner.vault.creatorFingerprint || !isPasswordCredential(credential) || !credential.roomProtectionRevision) {
      throw new Error('本机历史归属不一致，原数据已保留');
    }
    const guards = [owner.stored, ...(current ? [current.stored] : [])];
    for (const guard of guards) if (!sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(guard)), guard)) throw staleVaultError();
    await loadMessageEventHistory(owner, { mutation, signal });
    const next: Vault = { ...vault, localDataScope: localDataScope(owner.vault),
      localPreferenceDeviceId: owner.vault.localPreferenceDeviceId ?? owner.vault.identity.publicBundle.deviceId,
      roomArchiveV2: structuredClone(owner.vault.roomArchiveV2), archiveState: structuredClone(owner.vault.archiveState) };
    const id = crypto.randomUUID(), master = new Uint8Array(await crypto.subtle.exportKey('raw', owner.key));
    try {
      const stored: StoredPasswordVault = { v: 3, unlockMethod: 'password', browserRoomKey: true, spaceId: id,
        kdf: credential.kdf, ...(credential.passwordFormat ? { passwordFormat: credential.passwordFormat } : {}),
        wrappedKey: await wrapPasswordMaster(master, credential, id), payload: await encryptPayload(next, owner.key) };
      await installStoredVault(stored, undefined, credential.roomProtectionRevision, guards, isActive, signal);
      selectedSpace = id; rememberSpace(id);
      return { vault: next, key: owner.key, stored };
    } finally { master.fill(0); }
  });
}

/** Explicitly replace this browser's inaccessible vault after the recovery screen's confirmation. */
export async function createJointRecoveryVault(vault: Vault, credential: LocalCredentialResult, expected: StoredVault | null, signal: AbortSignal): Promise<VaultSession> {
  return withVaultLifecycle(async () => {
    signal.throwIfAborted();
    if (!sameStoredVault(await readStoredVaultUnlocked(), expected)) throw staleVaultError();
    return createVaultLocked(vault, '', 'platform', credential, () => !signal.aborted, expected ?? undefined);
  });
}

/** Discard only the authenticated, server-cancelled staging session. */
export async function discardJointRecovery(session: VaultSession, signal: AbortSignal): Promise<boolean> {
  return withVaultMutation(session, async mutation => {
    const pending = session.vault.pendingJointRecovery;
    if (!pending) throw new Error('本机恢复状态已变化');
    signal.throwIfAborted();
    if (pending.preserveHistory) {
      delete session.vault.pendingJointRecovery;
      await saveVault(session, mutation); return true;
    }
    await transaction('vault', 'readwrite', store => store.delete(vaultSpaceId(session.stored)));
    return false;
  });
}

/** Keep a helper's master key/history; clear transient old-epoch sends for both roles atomically. */
export async function finishJointRecovery(session: VaultSession, nextVault: Vault, signal: AbortSignal): Promise<void> {
  return withVaultMutation(session, async () => {
    const pending = session.vault.pendingJointRecovery;
    if (!pending || (session.stored.unlockMethod !== 'platform' && !(session.stored.v === 3 && session.stored.unlockMethod === 'password'))) throw new Error('双人恢复状态不存在');
    const preferences = pending.preserveHistory ? await loadUiPreferences(session) : {};
    const nextSession = { ...session, vault: nextVault };
    const preferenceRecord = await encryptLocalRecord(nextSession, 'preferences', uiPreferenceId(nextSession), preferences);
    const nextStored: StoredPlatformVault | StoredPasswordVault = { ...session.stored, payload: await encryptPayload(nextVault, session.key) };
    signal.throwIfAborted();
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const stores = ['vault', 'history', 'galleryHistory', 'restoredGallery', 'mediaCacheEntries', 'mediaChunks', 'outbox', 'receiptOutbox', 'uploads', 'preferences', 'memeFavorites', 'privateArchive', 'privateMedia', 'privateArchiveStaging'];
      const tx = database.transaction(stores, 'readwrite');
      putCurrentVault(tx, nextStored, session.stored);
      for (const name of stores.slice(1)) {
        if (pending.preserveHistory && ['history', 'galleryHistory', 'restoredGallery', 'mediaCacheEntries', 'mediaChunks'].includes(name)) continue;
        const store = tx.objectStore(name);
        const request = store.index('roomId').openCursor(IDBKeyRange.only(localDataScope(nextVault)));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
          else if (name === 'preferences') store.put(preferenceRecord);
        };
      }
      const abort = () => { try { tx.abort(); } catch { /* settled */ } };
      signal.addEventListener('abort', abort, { once: true });
      const release = () => { signal.removeEventListener('abort', abort); database.close(); };
      tx.oncomplete = () => { release(); session.vault = nextVault; session.stored = nextStored; resolve(); };
      tx.onabort = () => { release(); reject(signal.reason ?? tx.error ?? staleVaultError()); };
      tx.onerror = () => reject(tx.error);
    });
  });
}

async function createVaultLocked(
  vault: Vault,
  legacySecret = '',
  unlockMethod: 'password' | 'platform' = 'platform',
  preparedPlatformCredential?: LocalCredentialResult,
  isActive: () => boolean = () => true,
  expected?: StoredVault,
): Promise<VaultSession> {
  if (!isActive()) throw new DOMException('保险库创建流程已经结束', 'AbortError');
  // Every new master owns its own record namespace, even when the live room
  // already exists in another local slot. Ordinary same-key saves retain it.
  if (vault.roomArchiveV2) vault = { ...vault, localDataScope: crypto.randomUUID() };
  if (unlockMethod === 'password' || (preparedPlatformCredential && isPasswordCredential(preparedPlatformCredential))) {
    const credential = preparedPlatformCredential && isPasswordCredential(preparedPlatformCredential)
      ? preparedPlatformCredential : await derivePasswordCredential(legacySecret);
    if (vault.roomArchiveV2 && !credential.roomProtectionRevision) throw new Error('新密室的本机访问材料已失效，请重试');
    const master = crypto.getRandomValues(new Uint8Array(32));
    try {
      const key = await importMasterKey(master);
      const stored: StoredPasswordVault = { v: 3, unlockMethod: 'password', spaceId: selectedSpace, kdf: credential.kdf,
        ...(vault.roomArchiveV2 ? { browserRoomKey: true as const } : {}),
        ...(credential.passwordFormat ? { passwordFormat: credential.passwordFormat } : {}),
        wrappedKey: await wrapPasswordMaster(master, credential, selectedSpace), payload: await encryptPayload(vault, key) };
      if (!isActive()) throw new DOMException('保险库创建流程已经结束', 'AbortError');
      await installStoredVault(stored, expected, vault.roomArchiveV2 ? credential.roomProtectionRevision : undefined);
      rememberSpace(vaultSpaceId(stored)); await clearUnlockThrottle(); vault.v = 3;
      return { vault, key, stored };
    } finally { master.fill(0); }
  }
  const platformResult = preparedPlatformCredential ?? await createPlatformCredential();
  const browserAccessPrf = takeBrowserAccessPrf(platformResult.prfOutput) ?? platformResult.browserAccessPrf?.slice();
  const retainedProof = platformResult.prfOutput.slice();
  const kek = await derivePasskeyKek(platformResult.prfOutput, platformResult.record);
  const masterBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await importMasterKey(masterBytes);
  const stored: StoredPlatformVault = {
    v: 3,
    unlockMethod: 'platform',
    platform: platformResult.record,
    wrappedKey: await wrapMasterKey(masterBytes, kek, platformResult.record),
    payload: await encryptPayload(vault, key),
  };
  masterBytes.fill(0);
  if (!isActive()) throw new DOMException('保险库创建流程已经结束', 'AbortError');
  await installStoredVault(stored, expected);
  rememberSpace(vaultSpaceId(stored));
  await clearUnlockThrottle();
  vault.v = 3;
  const session = { vault, key, stored, browserAccessPrf };
  retainDeviceCredential(session, platformResult.record, retainedProof);
  return session;
}

/** Wrap an already-open vault with the device passkey that is currently unlocked. */
export async function adoptDeviceCredential(
  session: VaultSession,
  credential: { record: PlatformCredentialRecord; prfOutput: Uint8Array<ArrayBuffer> },
): Promise<void> {
  const current = session.stored;
  if (current.unlockMethod !== 'platform' || current.v !== 3) return;
  if (current.platform.credentialId === credential.record.credentialId) return;
  await withVaultMutation(session, async () => {
    const master = new Uint8Array(await crypto.subtle.exportKey('raw', session.key));
    try {
      const proof = credential.prfOutput.slice();
      const kek = await derivePasskeyKek(proof, credential.record);
      const next: StoredPlatformVault = {
        v: 3,
        unlockMethod: 'platform',
        spaceId: current.spaceId,
        platform: credential.record,
        wrappedKey: await wrapMasterKey(master, kek, credential.record),
        payload: current.payload,
      };
      await installStoredVault(next, current);
      session.stored = next;
    } finally {
      master.fill(0);
    }
  });
}

async function readUnlockThrottle(scope = 'unlock-throttle'): Promise<UnlockThrottle> {
  const value = await transaction<UnlockThrottle | undefined>('security', 'readonly', (store) => store.get(scope));
  return value && Number.isInteger(value.failures) && Number.isFinite(value.nextAllowedAt)
    ? value
    : { failures: 0, nextAllowedAt: 0 };
}

async function recordUnlockFailure(scope = 'unlock-throttle'): Promise<void> {
  const current = await readUnlockThrottle(scope);
  const failures = current.failures + 1;
  const delay = failures <= 3 ? 0 : Math.min(30_000, 1000 * 2 ** (failures - 4));
  await transaction('security', 'readwrite', (store) => store.put({ failures, nextAllowedAt: Date.now() + delay }, scope));
}

async function clearUnlockThrottle(scope = 'unlock-throttle'): Promise<void> {
  await transaction('security', 'readwrite', (store) => store.delete(scope));
}

async function enforceUnlockThrottle(): Promise<void> {
  const waitMs = await passwordUnlockWaitMs();
  if (waitMs > 0) throw new Error(`尝试次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
}

/** Read-only presentation of the existing guessing delay; never clears or extends it. */
export async function passwordUnlockWaitMs(): Promise<number> {
  return Math.max(0, (await readUnlockThrottle()).nextAllowedAt - Date.now());
}

/** A separate local guessing delay for root verification; it cannot strengthen an offline six-digit password. */
export async function unlockPersonalIdentityPassword(stored: import('./personal-identity-vault').StoredPersonalIdentity, password: string): Promise<import('./password-protection').PasswordCredentialResult> {
  if (stored.protection.method !== 'password') throw new Error('请使用原通行密钥验证');
  const protection = stored.protection, scope = `chamber:identity-throttle:${stored.identity.id}`;
  return withVaultLifecycle(async () => {
    const waitMs = Math.max(0, (await readUnlockThrottle(scope)).nextAllowedAt - Date.now());
    if (waitMs > 0) throw new Error(`尝试次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
    try {
      const credential = await derivePasswordCredential(password, protection.kdf, protection.passwordFormat);
      await (await import('./personal-identity-vault')).usePersonalIdentity(stored, credential, () => undefined);
      await clearUnlockThrottle(scope); return credential;
    } catch {
      await recordUnlockFailure(scope); throw new Error('应用锁不正确，或本机身份保管数据损坏');
    }
  });
}

export async function unlockVault(secret = '', preparedPlatformProof?: Promise<Uint8Array<ArrayBuffer>>, expectedStored?: StoredVault): Promise<VaultSession> {
  // A UI-provided WebAuthn request starts in the trusted gesture stack, but it
  // must settle before taking the cross-tab lifecycle lock. Otherwise a
  // cancelled/abandoned system sheet can block a fresh verification attempt.
  const platformProof = preparedPlatformProof ? await preparedPlatformProof : undefined;
  return withVaultLifecycle(async () => {
    if (expectedStored && !sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(expectedStored)), expectedStored)) throw staleVaultError();
    const session = await unlockVaultLocked(secret, platformProof, expectedStored);
    if (expectedStored) { selectedSpace = vaultSpaceId(session.stored); rememberSpace(selectedSpace); }
    return session;
  }).finally(() => { if (platformProof) { platformProof.fill(0); takeBrowserAccessPrf(platformProof)?.fill(0); } });
}

/** Background directory sync must never change the user's selected room.
 * Only an already unlocked browser collection can open these modern vaults. */
export async function unlockDirectorySyncRoom(secret: string, expected: StoredVault): Promise<VaultSession> {
  if (expected.v !== 3 || expected.unlockMethod !== 'password' || !expected.browserRoomKey) throw new Error('此密室不能用于后台目录同步');
  return withVaultLifecycle(async () => {
    if (!sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(expected)), expected)) throw staleVaultError();
    const session = await unlockVaultLocked(secret, undefined, expected);
    if (!session.vault.roomArchiveV2) throw new Error('此密室不能用于后台目录同步');
    return session;
  });
}

/** Prepare management of already-owned pending slots without changing selection. */
export async function unlockOwnedPendingSpace(id: string, credential: PlatformCredentialResult): Promise<VaultSession | null> {
  return withVaultLifecycle(async () => {
    const stored = await readStoredVaultUnlocked(id);
    if (!stored || stored.v !== 3 || stored.unlockMethod !== 'platform' || stored.platform.credentialId !== credential.record.credentialId) return null;
    const session = await unlockVaultLocked('', credential.prfOutput.slice(), stored);
    if (session.vault.role === 'creator' && session.vault.mls?.phase === 'awaiting-peer' &&
        session.vault.members.every(member => member.role === 'creator')) return session;
    releaseDeviceCredential(session);
    return null;
  });
}

/** Verify only the requested local slot for explicit management, without changing selection. */
export async function unlockLocalSpaceForManagement(id: string, credential: PlatformCredentialResult | null,
  verify: (record: PlatformCredentialRecord) => Promise<Uint8Array<ArrayBuffer>>,
  passwordVerification?: (verify: (password: string) => Promise<VaultSession>, passwordFormat?: 'numeric-6') => Promise<VaultSession>): Promise<VaultSession> {
  const stored = await withVaultLifecycle(() => readStoredVaultUnlocked(id));
  if (stored?.v === 3 && stored.unlockMethod === 'password' && passwordVerification) {
    return passwordVerification(password => withVaultLifecycle(async () => {
      if (!sameStoredVault(await readStoredVaultUnlocked(id), stored)) throw staleVaultError();
      const session = await unlockVaultLocked(password, undefined, stored);
      if (!sameStoredVault(await readStoredVaultUnlocked(id), stored)) throw staleVaultError();
      return session;
    }), stored.passwordFormat);
  }
  if (!stored || stored.v !== 3 || stored.unlockMethod !== 'platform') {
    throw new Error('请先打开此密室完成访问密钥升级');
  }
  const proof = credential?.record.credentialId === stored.platform.credentialId
    ? credential.prfOutput.slice() : await verify(stored.platform);
  try {
    return await withVaultLifecycle(async () => {
      if (!sameStoredVault(await readStoredVaultUnlocked(id), stored)) throw staleVaultError();
      return unlockVaultLocked('', proof, stored);
    });
  } finally { proof.fill(0); }
}

export const unlockSpaceForRemoval = unlockLocalSpaceForManagement;

/** Resume an in-memory capability only from its unchanged, authenticated durable snapshot. */
export async function resumeVaultSession(session: Pick<VaultSession, 'key' | 'stored' | 'browserAccessPrf'>): Promise<VaultSession> {
  return withVaultLifecycle(async () => {
    const stored = await readStoredVaultUnlocked(vaultSpaceId(session.stored));
    if (!stored || !sameStoredVault(stored, session.stored)) throw staleVaultError();
    if (stored.unlockMethod === 'recovery') throw new Error('恢复保险库尚未绑定到本设备');
    let vault: Vault;
    if (stored.v === 1) {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: fromBase64Url(stored.iv),
          additionalData: encoder.encode('quiet-room-vault-v1'),
          tagLength: 128,
        },
        session.key,
        fromBase64Url(stored.ciphertext),
      );
      vault = JSON.parse(decoder.decode(plaintext)) as Vault;
      if (vault.v !== 1 || !vault.roomId || !vault.identity?.publicBundle?.deviceId) throw new Error('INVALID_VAULT');
    } else {
      vault = await decryptPayload(stored.payload, session.key);
    }
    // Pending operations may have changed the old object before failing to
    // commit. Never let those partial in-memory changes become resumed state.
    return { vault, key: session.key, stored, browserAccessPrf: session.browserAccessPrf };
  });
}

/** Re-read and authenticate the original wrapper for this exact operation/slot. */
export async function reauthenticateVault(session: VaultSession, secret = '', signal?: AbortSignal): Promise<VaultSession> {
  return withVaultLifecycle(async () => {
    signal?.throwIfAborted();
    const stored = await readStoredVaultUnlocked(vaultSpaceId(session.stored));
    if (!stored || !sameStoredVault(stored, session.stored)) throw staleVaultError();
    const verified = await unlockVaultLocked(secret, undefined, stored);
    signal?.throwIfAborted();
    if (!sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(stored)), stored)) throw staleVaultError();
    return verified;
  });
}

function isPasskeyOnlyVault(stored: { v?: number; unlockMethod?: string }): boolean {
  return stored.v === 3 && stored.unlockMethod === 'platform';
}

async function unlockVaultLocked(secret: string, preparedPlatformProof?: Uint8Array<ArrayBuffer>, explicitStored?: StoredVault): Promise<VaultSession> {
  const stored = explicitStored ?? await readStoredVaultUnlocked();
  if (!stored) throw new Error('本机没有可解锁的会话');
  if (stored.unlockMethod === 'recovery') throw new Error('恢复包需要先输入独立恢复码');
  const passkeyOnly = isPasskeyOnlyVault(stored);
  if (!passkeyOnly) await enforceUnlockThrottle();
  const decryptStarted = performance.now();
  try {
    let unlocked: VaultSession;
    if (stored.v === 1) {
      const { bytes } = await deriveGestureBytes(secret, stored.kdf);
      const key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
      bytes.fill(0);
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: fromBase64Url(stored.iv),
          additionalData: encoder.encode('quiet-room-vault-v1'),
          tagLength: 128,
        },
        key,
        fromBase64Url(stored.ciphertext),
      );
      const vault = JSON.parse(decoder.decode(plaintext)) as Vault;
      if (vault.v !== 1 || !vault.roomId || !vault.identity?.publicBundle?.deviceId) throw new Error('INVALID_VAULT');
      unlocked = { vault, key, stored };
    } else if (stored.unlockMethod === 'password') {
      const master = await unwrapPasswordMaster(stored, secret);
      try {
        const key = await importMasterKey(master);
        unlocked = { vault: await decryptPayload(stored.payload, key), key, stored };
      } finally { master.fill(0); }
    } else {
      // UI callers prepare WebAuthn before lifecycle/IndexedDB work so Safari
      // keeps trusted activation. Non-UI diagnostics retain the direct path.
      const prfOutput = preparedPlatformProof ?? await unlockPlatformCredential(stored.platform);
      const browserAccessPrf = takeBrowserAccessPrf(prfOutput);
      const retainedProof = prfOutput.slice();
      const migrationPrfOutput = stored.v === 2 ? prfOutput.slice() : null;
      if (stored.v === 2 && !stored.kdf) throw new Error('INVALID_VAULT');
      const kek = stored.v === 2
        ? await derivePlatformKek(prfOutput, (await deriveGestureBytes(secret, stored.kdf!)).bytes)
        : await derivePasskeyKek(prfOutput, stored.platform);
      const masterBytes = await unwrapMasterKey(stored, kek);
      const key = await importMasterKey(masterBytes);
      const vault = await decryptPayload(stored.payload, key);
      if (stored.v === 2 && migrationPrfOutput) {
        const nextKek = await derivePasskeyKek(migrationPrfOutput, stored.platform);
        vault.v = 3;
        const migrated: StoredPlatformVault = {
          v: 3,
          unlockMethod: 'platform',
          platform: stored.platform,
          wrappedKey: await wrapMasterKey(masterBytes, nextKek, stored.platform),
          payload: await encryptPayload(vault, key),
        };
        await installStoredVault(migrated, stored);
        unlocked = { vault, key, stored: migrated, browserAccessPrf };
      } else {
        unlocked = { vault, key, stored, browserAccessPrf };
      }
      if (unlocked.stored.unlockMethod === 'platform' && unlocked.stored.v === 3) {
        retainDeviceCredential(unlocked, unlocked.stored.platform, retainedProof);
      } else retainedProof.fill(0);
      masterBytes.fill(0);
    }
    if (!explicitStored) rememberSpace(vaultSpaceId(unlocked.stored));
    if (!passkeyOnly) await clearUnlockThrottle();
    return unlocked;
  } catch (error) {
    if (isPlatformVaultCancellation(error) || error instanceof UnlockStageError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (passkeyOnly) {
      preparedPlatformProof?.fill(0);
      throw new UnlockStageError('本机保险库无法用这次验证结果打开。请重试或一起恢复。', 'S4', performance.now() - decryptStarted);
    }
    await recordUnlockFailure().catch(() => undefined);
    throw new Error(stored.v === 2
      ? '手势、设备安全凭据不正确，或本机保险库已经损坏'
      : stored.unlockMethod === 'gesture'
        ? '手势不正确，或本机保险库已经损坏'
        : '密码不正确，或本机保险库已经损坏');
  }
}

export async function saveVault(session: VaultSession, mutation?: VaultMutation): Promise<void> {
  if (!ownsVaultMutation(session, mutation)) return withVaultMutation(session, (lease) => saveVault(session, lease));
  if (session.stored.unlockMethod === 'recovery') throw new Error('恢复保险库尚未绑定到本设备');
  let nextStored: StoredVault;
  if (session.stored.v === 1) {
    nextStored = await encryptLegacyVault(
      session.vault,
      session.key,
      session.stored.kdf,
      session.stored.unlockMethod ?? 'password',
    );
  } else {
    nextStored = { ...session.stored, payload: await encryptPayload(session.vault, session.key) };
  }
  await installStoredVault(nextStored, session.stored);
  session.stored = nextStored;
}

async function reencryptAllLocalData(session: VaultSession, migratedSession: VaultSession): Promise<void> {
  const [history, outbox, pendingReceipts, uploadPlans, preferences] = await Promise.all([
    loadHistory(session),
    loadOutbox(session),
    loadPendingReceipts(session),
    loadUploadPlans(session),
    loadUiPreferences(session),
  ]);
  const [historyRecords, outboxRecords, receiptRecords, uploadRecords, preferenceRecord] = await Promise.all([
    Promise.all(history.map((message) => encryptHistoryRecord(migratedSession, message))),
    Promise.all(outbox.map((item) => encryptLocalRecord(migratedSession, 'outbox', item.clientMsgId, item))),
    Promise.all(pendingReceipts.map((receipt) =>
      encryptLocalRecord(migratedSession, 'receiptOutbox', receipt.clientMsgId, receipt))),
    Promise.all(uploadPlans.map((plan) => encryptLocalRecord(migratedSession, 'uploads', plan.blobId, plan))),
    encryptLocalRecord(
      migratedSession,
      'preferences',
      `ui:${migratedSession.vault.identity.publicBundle.deviceId}`,
      preferences,
    ),
  ]);

  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['vault', 'history', 'outbox', 'receiptOutbox', 'uploads', 'preferences'], 'readwrite');
    putCurrentVault(tx, migratedSession.stored, session.stored);
    for (const record of historyRecords) tx.objectStore('history').put(record);
    for (const record of outboxRecords) tx.objectStore('outbox').put(record);
    for (const record of receiptRecords) tx.objectStore('receiptOutbox').put(record);
    for (const record of uploadRecords) tx.objectStore('uploads').put(record);
    tx.objectStore('preferences').put(preferenceRecord);
    tx.oncomplete = () => {
      database.close();
      resolve();
    };
    tx.onabort = () => {
      database.close();
      reject(tx.error ?? new Error('设备保险库迁移事务失败'));
    };
    tx.onerror = () => reject(tx.error ?? new Error('设备保险库迁移事务失败'));
  });
}

export async function migrateVaultToPlatform(
  session: VaultSession,
  _legacySecret = '',
  preparedPlatformCredential?: PlatformCredentialResult,
): Promise<void> {
  return withVaultMutation(session, () => migrateVaultToPlatformLocked(session, preparedPlatformCredential));
}

async function migrateVaultToPlatformLocked(
  session: VaultSession,
  preparedPlatformCredential?: PlatformCredentialResult,
): Promise<void> {
  if (session.stored.v !== 1) return;
  const platformResult = preparedPlatformCredential ?? await createPlatformCredential();
  const kek = await derivePasskeyKek(platformResult.prfOutput, platformResult.record);
  const masterBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await importMasterKey(masterBytes);
  session.vault.v = 3;
  const stored: StoredPlatformVault = {
    v: 3,
    unlockMethod: 'platform',
    platform: platformResult.record,
    wrappedKey: await wrapMasterKey(masterBytes, kek, platformResult.record),
    payload: await encryptPayload(session.vault, key),
  };
  masterBytes.fill(0);
  const migratedSession: VaultSession = { vault: session.vault, key, stored };
  await reencryptAllLocalData(session, migratedSession);
  session.key = key;
  session.stored = stored;
  await clearUnlockThrottle();
}

async function recoveryKek(codeBytes: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', codeBytes, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('quiet-room-recovery-kek-v2') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  codeBytes.fill(0);
  return key;
}

function formatRecoveryCode(bytes: Uint8Array<ArrayBuffer>): string {
  const body = toBase64Url(bytes);
  return `QR2-${body.match(/.{1,5}/g)?.join(' ') ?? body}`;
}

function parseRecoveryCode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized.startsWith('QR2-')) throw new Error('恢复码格式不正确');
  const bytes = fromBase64Url(normalized.slice(4));
  if (bytes.length !== 32) throw new Error('恢复码长度不正确');
  return bytes;
}

export type PreparedRecoveryExport = RecoveryExport & { blob: Blob; filename: string };

export async function prepareRecoveryPackage(session: VaultSession): Promise<PreparedRecoveryExport> {
  return withVaultMutation(session, (mutation) => prepareRecoveryPackageLocked(session, mutation));
}

async function prepareRecoveryPackageLocked(session: VaultSession, mutation: VaultMutation): Promise<PreparedRecoveryExport> {
  if(session.vault.migrationSource||session.vault.personalBinding&&session.vault.personalMigration?.state!=='staged')throw new Error('此密室使用助记词身份恢复，不能导出旧设备私钥恢复包');
  if ((session.stored.v !== 2 && session.stored.v !== 3) || (session.stored.unlockMethod !== 'platform' && session.stored.unlockMethod !== 'password')) {
    throw new Error('请先完成设备保险库升级');
  }
  await saveVault(session, mutation);
  const exportedAt = new Date().toISOString();
  const recoveryCodeBytes = crypto.getRandomValues(new Uint8Array(32));
  const displayCode = formatRecoveryCode(recoveryCodeBytes.slice());
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await recoveryKek(recoveryCodeBytes, salt);
  const masterBytes = new Uint8Array(await crypto.subtle.exportKey('raw', session.key));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(`quiet-room-recovery-v3:${exportedAt}`),
      tagLength: 128,
    },
    kek,
    masterBytes,
  );
  masterBytes.fill(0);
  const exportVault = structuredClone(session.vault);
  delete exportVault.backup;
  delete exportVault.spaceRecoveryCode;
  delete exportVault.historyRestoreTask;
  delete exportVault.recoverySource;
  const body = JSON.stringify({
    format: 'quiet-room-recovery',
    version: 3,
    exportedAt,
    payload: await encryptPayload(exportVault, session.key),
    recovery: {
      salt: toBase64Url(salt),
      iv: toBase64Url(iv),
      ciphertext: toBase64Url(ciphertext),
    },
  }, null, 2);
  // Preparing a package must not open an OS save surface. The caller displays
  // the independent code before the user explicitly starts the file download.
  return {
    exportedAt,
    recoveryCode: displayCode,
    blob: new Blob([body], { type: 'application/json' }),
    filename: `quiet-room-recovery-${exportedAt.slice(0, 10)}.json`,
  };
}

export async function importRecoveryPackage(file: File): Promise<void> {
  return withVaultLifecycle(() => importRecoveryPackageLocked(file));
}

async function importRecoveryPackageLocked(file: File): Promise<void> {
  const parsed: unknown = JSON.parse(await file.text());
  if (!parsed || typeof parsed !== 'object') throw new Error('恢复包格式不正确');
  const record = parsed as Record<string, unknown>;
  if (record.format !== 'quiet-room-recovery') throw new Error('这不是有效的 Chamber 恢复包');
  if (record.version === 2 || record.version === 3) {
    const stored: StoredRecoveryVault = {
      v: record.version,
      unlockMethod: 'recovery',
      exportedAt: String(record.exportedAt ?? ''),
      payload: record.payload as StoredRecoveryVault['payload'],
      recovery: record.recovery as StoredRecoveryVault['recovery'],
    };
    if (!validateRecoveryStoredVault(stored)) throw new Error('恢复包格式或安全参数不正确');
    await transaction('vault', 'readwrite', (store) => store.put({ ...stored, spaceId: selectedSpace }, selectedSpace));
    return;
  }
  if (!validateLegacyStoredVault(record.vault)) throw new Error('这不是有效的 Chamber 恢复包');
  await transaction('vault', 'readwrite', (store) => store.put({ ...(record.vault as LegacyStoredVault), spaceId: selectedSpace }, selectedSpace));
}

export async function unlockRecoveryVault(recoveryCode: string): Promise<VaultSession> {
  return withVaultLifecycle(() => unlockRecoveryVaultLocked(recoveryCode));
}

/** Install only a locally authenticated cloud checkpoint. Never install old MLS sender state as an active device. */
export async function installCloudRecovery(bundle: CloudRecoveryBundle, recoveryBytes: Uint8Array<ArrayBuffer>, expected: StoredVault | null, signal: AbortSignal): Promise<VaultSession> {
  return withVaultLifecycle(async () => {
    signal.throwIfAborted();
    if (!sameStoredVault(await readStoredVaultUnlocked(), expected)) throw staleVaultError();
    const vault = structuredClone(bundle.checkpoint);
    delete vault.backup;
    delete vault.historyRestoreTask;
    vault.recoverySource = { backupId: bundle.backupId, archives: structuredClone(bundle.archives), galleryHidden: structuredClone(bundle.galleryHidden ?? []) };
    const masterBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await importMasterKey(masterBytes);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const exportedAt = new Date().toISOString();
    try {
      const kek = await recoveryKek(recoveryBytes, salt);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
        additionalData: encoder.encode(`quiet-room-recovery-v3:${exportedAt}`), tagLength: 128 }, kek, masterBytes);
      const stored: StoredRecoveryVault = { spaceId: expected ? vaultSpaceId(expected) : selectedSpace, v: 3, unlockMethod: 'recovery', exportedAt,
        payload: await encryptPayload(vault, key), recovery: { salt: toBase64Url(salt), iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) } };
      signal.throwIfAborted();
      const database = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('vault', 'readwrite');
        const current = tx.objectStore('vault').get(expected ? vaultSpaceId(expected) : selectedSpace);
        current.onsuccess = () => {
          const actual = validateStoredVault(current.result) ? current.result : null;
          if (signal.aborted || !sameStoredVault(actual, expected)) { tx.abort(); return; }
          tx.objectStore('vault').put(stored, vaultSpaceId(stored));
        };
        const abort = () => { try { tx.abort(); } catch { /* settled */ } };
        signal.addEventListener('abort', abort, { once: true });
        const release = () => { signal.removeEventListener('abort', abort); database.close(); };
        tx.oncomplete = () => { release(); resolve(); };
        tx.onabort = () => { release(); reject(signal.reason ?? tx.error ?? staleVaultError()); };
        tx.onerror = () => reject(tx.error);
      });
      return { vault, key, stored };
    } finally { masterBytes.fill(0); recoveryBytes.fill(0); }
  });
}

/** Compare authenticated archive records with a consistent local snapshot before planning an import. */
export async function findMissingArchivedMessages(
  session: VaultSession, messages: DecryptedMessage[], scope: 'chat' | 'gallery' | 'all', signal?: AbortSignal,
): Promise<DecryptedMessage[]> {
  signal?.throwIfAborted();
  if (scope !== 'chat' && session.vault.role !== 'creator') throw new Error('此参与方没有保险箱入口');
  const storeName = scope === 'gallery' ? 'restoredGallery' : 'history';
  // One snapshot transaction per archive part rather than reopening IDB twice per record.
  const existingDatabase = await openDatabase();
  const existing = await new Promise<[Map<number, StoredHistory>, Map<number, StoredHistory>, Map<number, StoredHistory>]>
  ((resolve, reject) => {
    const maps: [Map<number, StoredHistory>, Map<number, StoredHistory>, Map<number, StoredHistory>] = [new Map(), new Map(), new Map()];
    const tx = existingDatabase.transaction(['history', 'galleryHistory', 'restoredGallery'], 'readonly');
    for (const [index, name] of (['history', 'galleryHistory', 'restoredGallery'] as const).entries()) for (const message of messages) {
      const request = tx.objectStore(name).get(`${localDataScope(session.vault)}:${message.seq}`);
      request.onsuccess = () => { if (request.result) maps[index]!.set(message.seq, request.result); };
    }
    tx.oncomplete = () => { existingDatabase.close(); resolve(maps); };
    tx.onabort = () => { existingDatabase.close(); reject(tx.error ?? new Error('历史读取失败')); };
    tx.onerror = () => reject(tx.error);
  });
  const missing: DecryptedMessage[] = [];
  for (const message of messages) {
    if (!Number.isSafeInteger(message.seq) || message.seq < 1 || !isMessagePayload(message.payload) ||
        typeof message.clientMsgId !== 'string' || typeof message.senderId !== 'string' || typeof message.acceptedAt !== 'string') throw new Error('历史备份记录不正确');
    const galleryOnly = message.payload.kind === 'gallery-image' || message.payload.kind === 'gallery-file';
    if (scope === 'chat' && galleryOnly) continue;
    const galleryProjectionEvent = message.payload.kind === 'message-delete';
    if (scope === 'gallery' && !isGalleryMediaPayload(message.payload) && !galleryProjectionEvent) continue;
    const [historyRecord, galleryRecord, restoredRecord] = existing.map(records => records.get(message.seq));
    for (const previous of [historyRecord, galleryRecord, restoredRecord]) if (previous) {
      const decrypted = (await decryptHistoryRecords(session, [previous], signal, { strict: true }))[0];
      if (!decrypted || !sameHistoryMessage(decrypted, message)) throw new Error('历史记录与本机数据冲突');
    }
    const previous = storeName === 'history' ? historyRecord : restoredRecord;
    if (previous) {
      continue;
    }
    missing.push(message);
  }
  signal?.throwIfAborted();
  return missing;
}

/** Imported content never advances MLS, network cursors, receipts, or an ordinary linked device's access. */
export async function importArchivedMessages(
  session: VaultSession,
  messages: DecryptedMessage[],
  scope: 'chat' | 'gallery' | 'all',
  signal?: AbortSignal,
  onCommit: (changed: boolean, imported: readonly DecryptedMessage[]) => void = () => undefined,
): Promise<number> {
  return withVaultMutation(session, async () => {
    signal?.throwIfAborted();
    if (scope !== 'chat' && session.vault.role !== 'creator') throw new Error('此参与方没有保险箱入口');
    const storeName = scope === 'gallery' ? 'restoredGallery' : 'history';
    const records: StoredHistory[] = [];
    const missing = await findMissingArchivedMessages(session, messages, scope, signal);
    for (const message of missing) records.push(await encryptHistoryRecord(session, message));
    const mediaRecords = scope === 'gallery' ? [] : records.filter((_, index) => isGalleryMediaPayload(missing[index]!.payload));
    // Gallery recovery counts media, not the internal deletion projections.
    const importedContentCount = missing.filter(message => scope !== 'gallery' || isGalleryMediaPayload(message.payload)).length;
    signal?.throwIfAborted();
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['vault', storeName, ...(mediaRecords.length ? ['galleryHistory'] : [])], 'readwrite');
      const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
      current.onsuccess = () => { if (!sameStoredVault(current.result, session.stored) || signal?.aborted) tx.abort(); };
      for (const record of records) tx.objectStore(storeName).put(record);
      for (const record of mediaRecords) tx.objectStore('galleryHistory').put(record);
      const abort = () => { try { tx.abort(); } catch { /* already complete */ } };
      signal?.addEventListener('abort', abort, { once: true });
      const release = () => { signal?.removeEventListener('abort', abort); database.close(); };
      tx.oncomplete = () => { release(); resolve(); };
      tx.onabort = () => { release(); reject(signal?.reason ?? tx.error ?? staleVaultError()); };
      tx.onerror = () => reject(tx.error);
    });
    onCommit(records.length > 0, missing);
    return importedContentCount;
  });
}

async function unlockRecoveryVaultLocked(recoveryCode: string): Promise<VaultSession> {
  const stored = await readStoredVaultUnlocked();
  if (!stored || stored.unlockMethod !== 'recovery') throw new Error('本机没有等待恢复的保险库');
  await enforceUnlockThrottle();
  try {
    const codeBytes = recoveryCode.trim().startsWith('QR3-') ? parseCloudRecoveryCode(recoveryCode).secret : parseRecoveryCode(recoveryCode);
    const kek = await recoveryKek(codeBytes, fromBase64Url(stored.recovery.salt));
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(stored.recovery.iv),
        additionalData: encoder.encode(`quiet-room-recovery-v${stored.v}:${stored.exportedAt}`),
        tagLength: 128,
      },
      kek,
      fromBase64Url(stored.recovery.ciphertext),
    );
    if (plaintext.byteLength !== 32) throw new Error('INVALID_MASTER_KEY');
    const masterBytes = new Uint8Array(plaintext);
    const key = await importMasterKey(masterBytes);
    masterBytes.fill(0);
    const vault = await decryptPayload(stored.payload, key);
    vault.historyUnavailableBeforeSeq = vault.lastSeq;
    await clearUnlockThrottle();
    return { vault, key, stored };
  } catch {
    await recordUnlockFailure().catch(() => undefined);
    throw new Error('恢复码不正确，或恢复包已经损坏');
  }
}

export async function bindRecoveredVaultToPlatform(
  session: VaultSession,
  _legacySecret = '',
  preparedPlatformCredential?: PlatformCredentialResult,
): Promise<void> {
  return withVaultMutation(session, () => bindRecoveredVaultToPlatformLocked(session, preparedPlatformCredential));
}

async function bindRecoveredVaultToPlatformLocked(
  session: VaultSession,
  preparedPlatformCredential?: PlatformCredentialResult,
): Promise<void> {
  if (session.stored.unlockMethod !== 'recovery') throw new Error('当前保险库不需要重新绑定');
  const platformResult = preparedPlatformCredential ?? await createPlatformCredential();
  if (session.vault.protocol === 'mls-rfc9420') {
    // A checkpoint cannot know all later sends, pending ciphertext, or the
    // private path created by a later self-commit. Never reuse its MLS sender.
    const checkpoint = session.vault;
    const identity = await generateIdentity();
    const accessToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const request = await createRecoveryRequest(checkpoint, identity.publicBundle, accessToken);
    const nextVault: Vault = {
      ...checkpoint,
      identity,
      accessToken,
      pairingState: 'recovering',
      mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' },
      pendingRecovery: {
        request,
        checkpointMembers: structuredClone(checkpoint.members),
        checkpointEventSeq: checkpoint.mls?.lastEventSeq ?? 0,
      },
      pendingDeviceLinks: undefined,
      pendingDeviceLinkId: undefined,
      recoveryExportedAt: undefined,
      lastSeq: 0,
      lastReceiptSeq: 0,
      historyUnavailableBeforeSeq: 0,
    };
    const replacement = await createVaultLocked(nextVault, '', 'platform', platformResult, () => true, session.stored);
    session.vault = replacement.vault;
    session.key = replacement.key;
    session.stored = replacement.stored;
    return;
  }
  const kek = await derivePasskeyKek(platformResult.prfOutput, platformResult.record);
  const masterBytes = new Uint8Array(await crypto.subtle.exportKey('raw', session.key));
  session.vault.v = 3;
  const stored: StoredPlatformVault = {
    v: 3,
    unlockMethod: 'platform',
    platform: platformResult.record,
    wrappedKey: await wrapMasterKey(masterBytes, kek, platformResult.record),
    payload: await encryptPayload(session.vault, session.key),
  };
  masterBytes.fill(0);
  await installStoredVault(stored, session.stored);
  session.stored = stored;
  await clearUnlockThrottle();
}

async function encryptHistoryRecord(session: VaultSession, message: DecryptedMessage): Promise<StoredHistory> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(`quiet-room-history-v1:${localDataScope(session.vault)}:${message.seq}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    session.key,
    encoder.encode(JSON.stringify(message)),
  );
  return {
    id: `${localDataScope(session.vault)}:${message.seq}`,
    roomId: localDataScope(session.vault),
    seq: message.seq,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
  };
}

function sameHistoryMessage(left: DecryptedMessage, right: DecryptedMessage): boolean {
  return left.seq === right.seq
    && left.clientMsgId === right.clientMsgId
    && left.senderId === right.senderId
    && left.acceptedAt === right.acceptedAt
    && canonicalStringify(left.payload) === canonicalStringify(right.payload);
}

async function assertCompatibleHistoryRecord(
  session: VaultSession,
  message: DecryptedMessage,
  storeName: 'history' | 'galleryHistory' | 'restoredGallery',
): Promise<StoredHistory | undefined> {
  const existing = await transaction<StoredHistory | undefined>(storeName, 'readonly', store =>
    store.get(`${localDataScope(session.vault)}:${message.seq}`));
  if (!existing) return undefined;
  const decrypted = (await decryptHistoryRecords(session, [existing], undefined, { strict: true }))[0];
  if (!decrypted || !sameHistoryMessage(decrypted, message)) throw new Error('历史记录与本机数据冲突');
  return existing;
}

export async function saveHistoryMessage(session: VaultSession, message: DecryptedMessage, mutation?: VaultMutation): Promise<void> {
  if (!ownsVaultMutation(session, mutation)) return withVaultMutation(session, (lease) => saveHistoryMessage(session, message, lease));
  await assertCompatibleHistoryRecord(session, message, 'history');
  const isGalleryMedia = isGalleryMediaPayload(message.payload);
  if (isGalleryMedia) await assertCompatibleHistoryRecord(session, message, 'galleryHistory');
  const record = await encryptHistoryRecord(session, message);
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const stores = isGalleryMedia ? ['history', 'galleryHistory', 'vault'] : ['history', 'vault'];
    const tx = database.transaction(stores, 'readwrite');
    const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
    current.onsuccess = () => {
      if (!sameStoredVault(current.result, session.stored)) {
        tx.abort();
        return;
      }
      tx.objectStore('history').put(record);
      if (isGalleryMedia) tx.objectStore('galleryHistory').put(record);
    };
    current.onerror = () => tx.abort();
    tx.oncomplete = () => {
      database.close();
      resolve();
    };
    tx.onabort = () => {
      database.close();
      reject(tx.error ?? staleVaultError());
    };
    tx.onerror = () => reject(tx.error ?? new Error('历史记录写入失败'));
  });
}

export async function loadHistory(session: VaultSession): Promise<DecryptedMessage[]> {
  const records = await transaction<StoredHistory[]>('history', 'readonly', (store) =>
    store.index('roomId').getAll(IDBKeyRange.only(localDataScope(session.vault))),
  );
  return decryptHistoryRecords(session, records.sort((left, right) => left.seq - right.seq));
}

export async function loadHistoryPage(
  session: VaultSession,
  { limit = 200, beforeSeq, signal }: { limit?: number; beforeSeq?: number; signal?: AbortSignal } = {},
): Promise<DecryptedMessage[]> {
  signal?.throwIfAborted();
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 1000);
  const database = await openDatabase();
  const records = await new Promise<StoredHistory[]>((resolve, reject) => {
    const tx = database.transaction('history', 'readonly');
    const index = tx.objectStore('history').index('roomSeq');
    const upper = typeof beforeSeq === 'number' && Number.isSafeInteger(beforeSeq)
      ? beforeSeq - 1
      : Number.MAX_SAFE_INTEGER;
    const request = index.openCursor(
      IDBKeyRange.bound([localDataScope(session.vault), 0], [localDataScope(session.vault), upper]),
      'prev',
    );
    const collected: StoredHistory[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || collected.length >= boundedLimit) return;
      collected.push(cursor.value as StoredHistory);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      database.close();
      resolve(collected.sort((left, right) => left.seq - right.seq));
    };
  });
  return decryptHistoryRecords(session, records, signal);
}

export async function loadHistoryPageAfter(
  session: VaultSession,
  { limit = 200, afterSeq = 0, signal, strict = false }: { limit?: number; afterSeq?: number; signal?: AbortSignal; strict?: boolean } = {},
): Promise<DecryptedMessage[]> {
  return decryptHistoryRecords(session, await loadHistoryRecordsAfter(session, { limit, afterSeq, signal }), signal, { strict });
}

/** New backups include retained Safe rows and deletion projections, even when
 * the ordinary chat cache has already discarded the corresponding row. */
export async function loadChamberHistoryPageAfter(session:VaultSession,afterSeq:number,signal:AbortSignal):Promise<DecryptedMessage[]> {
  const rows=await Promise.all((['history','galleryHistory','restoredGallery'] as const).map(async store=>decryptHistoryRecords(session,
    await loadHistoryRecordsAfter(session,{limit:20,afterSeq,signal},store),signal,{strict:true})));
  const merged=new Map<number,DecryptedMessage>();
  for(const row of rows.flat()) {
    const existing=merged.get(row.seq);if(existing&&!sameHistoryMessage(existing,row))throw new Error('历史备份存在相互冲突的本机记录');merged.set(row.seq,row);
  }
  return [...merged.values()].sort((a,b)=>a.seq-b.seq).slice(0,20);
}

async function loadHistoryRecordsAfter(
  session: VaultSession,
  { limit, afterSeq, signal }: { limit: number; afterSeq: number; signal?: AbortSignal },
  storeName: 'history' | 'galleryHistory' | 'restoredGallery' = 'history',
): Promise<StoredHistory[]> {
  signal?.throwIfAborted();
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 1000);
  if (Number.isSafeInteger(afterSeq) && afterSeq >= Number.MAX_SAFE_INTEGER) return [];
  const lower = Number.isSafeInteger(afterSeq) && afterSeq >= 0
    ? afterSeq + 1
    : 1;
  const database = await openDatabase();
  const records = await new Promise<StoredHistory[]>((resolve, reject) => {
    const tx = database.transaction(storeName, 'readonly');
    const index = tx.objectStore(storeName).index('roomSeq');
    const request = index.openCursor(
      IDBKeyRange.bound(
        [localDataScope(session.vault), lower],
        [localDataScope(session.vault), Number.MAX_SAFE_INTEGER],
      ),
      'next',
    );
    const collected: StoredHistory[] = [];
    const abort = () => { try { tx.abort(); } catch { /* The readonly transaction has already finished. */ } };
    const release = () => {
      signal?.removeEventListener('abort', abort);
      database.close();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || collected.length >= boundedLimit) return;
      collected.push(cursor.value as StoredHistory);
      cursor.continue();
    };
    tx.onabort = () => { release(); reject(signal?.reason ?? tx.error ?? new DOMException('History scan aborted', 'AbortError')); };
    tx.onerror = () => { release(); reject(tx.error); };
    tx.oncomplete = () => {
      release();
      resolve(collected);
    };
  });
  signal?.throwIfAborted();
  return records;
}

export class HistoryIntegrityError extends Error {}

/**
 * Rebuild timeline projection events beyond the visible history page without
 * a plaintext index. All ciphertext is strictly verified, including paged-out ordinary rows;
 * only projection events survive the bounded three-way merge.
 */
export async function loadMessageEventHistory(
  session: VaultSession,
  { signal, mutation }: { signal?: AbortSignal; mutation?: VaultMutation } = {},
): Promise<DecryptedMessage[]> {
  if (mutation && !ownsVaultMutation(session, mutation)) throw new Error('历史快照读取必须使用当前保险库事务');
  if (session.stored && !mutation) {
    // Snapshot acquisition joins the existing lifecycle queue. Capturing a
    // version outside this lock races a normal same-session atomic commit.
    return withVaultMutation(session, held => loadMessageEventHistory(session, { signal, mutation: held }));
  }
  const expectedStored = session.stored;
  const assertCurrent = async () => {
    signal?.throwIfAborted();
    if (expectedStored && !sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(expectedStored)), expectedStored)) throw staleVaultError();
    signal?.throwIfAborted();
  };
  await assertCurrent();
  const boundary = session.vault.historyUnavailableBeforeSeq ?? 0;
  const throughSeq = session.vault.lastSeq;
  const coverage = Number.isSafeInteger(throughSeq) && throughSeq >= boundary;
  let expected = boundary + 1;
  const missing = () => { throw new HistoryIntegrityError(`本机加密历史记录 ${expected} 缺失，已停止显示以避免撤回内容重新出现`); };
  async function* stream(storeName: 'history' | 'galleryHistory' | 'restoredGallery') {
    let afterSeq = 0;
    for (;;) {
      signal?.throwIfAborted();
      const records = await loadHistoryRecordsAfter(session, { limit: 200, afterSeq, signal }, storeName);
      if (!records.length) return;
      const page = await decryptHistoryRecords(session, records, signal, { strict: true });
      for (let index = 0; index < records.length; index++) {
        const record = records[index]!;
        const message = page[index]!;
        if (!Number.isSafeInteger(record.seq) || record.seq <= afterSeq || message.seq !== record.seq) {
          throw new Error('本机加密历史记录序号存在冲突');
        }
        afterSeq = record.seq;
        yield message;
      }
      if (records.length < 200) return;
    }
  }
  const events = await mergeHistoryProjection(
    ['galleryHistory', 'restoredGallery', 'history'].map(name => stream(name as 'history' | 'galleryHistory' | 'restoredGallery')),
    { signal, same: sameHistoryMessage,
      event: message => ['reaction', 'message-delete', 'media-read', 'message-read'].includes(message.payload?.kind) && isMessagePayload(message.payload),
      live: message => {
        if (!coverage || message.seq <= boundary || message.seq > throughSeq) return;
        while (expected < message.seq && expiredMessage(session.vault, expected)) expected++;
        if (message.seq !== expected) missing();
        expected++;
      },
    },
  );
  while (coverage && expected <= throughSeq && expiredMessage(session.vault, expected)) expected++;
  if (coverage && expected <= throughSeq) missing();
  await assertCurrent();
  return events;
}

/** Backward-compatible narrow reader used by reaction-specific diagnostics. */
export async function loadReactionHistory(
  session: VaultSession,
  options: { signal?: AbortSignal } = {},
): Promise<DecryptedMessage[]> {
  return (await loadMessageEventHistory(session, options)).filter((message) => message.payload.kind === 'reaction');
}

/** Read an exact local sequence without confusing a paged-out row with missing history. */
export async function loadHistoryMessage(session: VaultSession, seq: number, signal?: AbortSignal): Promise<DecryptedMessage | null> {
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  signal?.throwIfAborted();
  const record = await transaction<StoredHistory | undefined>('history', 'readonly', (store) =>
    store.get(`${localDataScope(session.vault)}:${seq}`),
  );
  signal?.throwIfAborted();
  if (!record || record.roomId !== localDataScope(session.vault) || record.seq !== seq) return null;
  return (await decryptHistoryRecords(session, [record], signal))[0] ?? null;
}

/** Media type stays encrypted. Scan a bounded page and retain only media payloads. */
export async function loadMediaHistoryPage(
  session: VaultSession,
  { beforeSeq, limit = 200, signal, includeExpressions = false }: { beforeSeq?: number; limit?: number; signal?: AbortSignal; includeExpressions?: boolean } = {},
): Promise<{ messages: DecryptedMessage[]; beforeSeq: number | null; hasMore: boolean }> {
  signal?.throwIfAborted();
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  const upper = beforeSeq === undefined ? Number.MAX_SAFE_INTEGER : beforeSeq - 1;
  if (upper < 1) return { messages: [], beforeSeq: null, hasMore: false };
  const database = await openDatabase();
  type TaggedHistory = { storeName: 'history' | 'galleryHistory' | 'restoredGallery'; record: StoredHistory };
  const scan = await new Promise<{ records: TaggedHistory[]; truncated: boolean }>((resolve, reject) => {
    const tx = database.transaction(['galleryHistory', 'restoredGallery', 'history'], 'readonly');
    const collected: TaggedHistory[] = [];
    let truncated = false;
    const abort = () => { try { tx.abort(); } catch { /* The readonly transaction has already finished. */ } };
    const release = () => {
      signal?.removeEventListener('abort', abort);
      database.close();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const name of ['galleryHistory', 'restoredGallery', 'history'] as const) {
      const request = tx.objectStore(name).index('roomSeq').openCursor(
        IDBKeyRange.bound([localDataScope(session.vault), 1], [localDataScope(session.vault), upper]), 'prev');
      let count = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (count >= boundedLimit + 1) { truncated = true; return; }
        collected.push({ storeName: name, record: cursor.value as StoredHistory });
        count += 1;
        cursor.continue();
      };
    }
    tx.onabort = () => { release(); reject(signal?.reason ?? tx.error ?? new DOMException('History scan aborted', 'AbortError')); };
    tx.onerror = () => { release(); reject(tx.error); };
    tx.oncomplete = () => { release(); resolve({ records: collected, truncated }); };
  });
  signal?.throwIfAborted();
  const decrypted = await decryptHistoryRecords(session, scan.records.map(item => item.record), signal, { strict: true });
  const canonical = new Map<number, { storeName: TaggedHistory['storeName']; message: DecryptedMessage }>();
  for (const [index, message] of decrypted.entries()) {
    const storeName = scan.records[index]!.storeName;
    const existing = canonical.get(message.seq);
    if (existing && !sameHistoryMessage(existing.message, message)) throw new Error('本机加密历史记录存在冲突');
    if (!existing || storeName === 'history') canonical.set(message.seq, { storeName, message });
  }
  const records = [...canonical.values()].sort((left, right) => right.message.seq - left.message.seq);
  const page = records.slice(0, boundedLimit);
  // Older clients stored ordinary attachments only in chat. Materialize their
  // already-authenticated encrypted rows independently before exposing Safe.
  const gallerySequences = new Set(scan.records.filter(item => item.storeName !== 'history').map(item => item.record.seq));
  const legacySequences = new Set(page.filter(item => isGalleryMediaPayload(item.message.payload)
    && !gallerySequences.has(item.message.seq)).map(item => item.message.seq));
  if (legacySequences.size) await withVaultMutation(session, async () => {
    signal?.throwIfAborted();
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['vault', 'galleryHistory'], 'readwrite');
      const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
      current.onsuccess = () => { if (!sameStoredVault(current.result, session.stored) || signal?.aborted) tx.abort(); };
      for (const { storeName, record } of scan.records) if (storeName === 'history' && legacySequences.has(record.seq)) {
        const existing = tx.objectStore('galleryHistory').get(record.id);
        existing.onsuccess = () => { if (!existing.result) tx.objectStore('galleryHistory').put(record); };
      }
      const abort = () => { try { tx.abort(); } catch { /* already completed */ } };
      signal?.addEventListener('abort', abort, { once: true });
      const release = () => { signal?.removeEventListener('abort', abort); database.close(); };
      tx.oncomplete = () => { release(); resolve(); };
      tx.onabort = () => { release(); reject(signal?.reason ?? tx.error ?? staleVaultError()); };
      tx.onerror = () => reject(tx.error);
    });
  });
  return {
    messages: page.map(item => item.message).filter((message) => isGalleryMediaPayload(message.payload) || includeExpressions && message.payload.kind === 'image'),
    beforeSeq: page.at(-1)?.message.seq ?? null,
    hasMore: scan.truncated || records.length > boundedLimit,
  };
}

async function decryptHistoryRecords(
  session: VaultSession,
  records: StoredHistory[],
  signal?: AbortSignal,
  { strict = false }: { strict?: boolean } = {},
): Promise<DecryptedMessage[]> {
  const messages: DecryptedMessage[] = [];
  for (const record of records) {
    signal?.throwIfAborted();
    try {
      const additionalData = encoder.encode(`quiet-room-history-v1:${record.roomId}:${record.seq}`);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(record.iv), additionalData, tagLength: 128 },
        session.key,
        fromBase64Url(record.ciphertext),
      );
      messages.push(JSON.parse(decoder.decode(plaintext)) as DecryptedMessage);
    } catch {
      if (strict) throw new HistoryIntegrityError(`本机加密历史记录 ${record.seq} 已损坏，已停止显示以避免撤回内容重新出现`);
      // Ordinary bounded history pages may omit a damaged cache row. The
      // strict full projection scan above still blocks every chat/Safe first
      // frame because encrypted payload kind cannot reveal whether it was a
      // deletion tombstone.
    }
  }
  signal?.throwIfAborted();
  return messages;
}

async function encryptLocalRecord(
  session: VaultSession,
  storeName: LocalStore,
  id: string,
  value: unknown,
): Promise<StoredLocalRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const recordId = `${localDataScope(session.vault)}:${id}`;
  const additionalData = encoder.encode(`quiet-room-${storeName}-v1:${recordId}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    session.key,
    encoder.encode(JSON.stringify(value)),
  );
  return {
    id: recordId,
    roomId: localDataScope(session.vault),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
  };
}

async function decryptLocalRecord<T>(
  session: VaultSession,
  storeName: LocalStore,
  record: StoredLocalRecord,
): Promise<T> {
  const additionalData = encoder.encode(`quiet-room-${storeName}-v1:${record.id}`);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(record.iv),
      additionalData,
      tagLength: 128,
    },
    session.key,
    fromBase64Url(record.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

async function putLocalRecord(
  session: VaultSession,
  storeName: LocalStore,
  id: string,
  value: unknown,
  mutation?: VaultMutation,
): Promise<void> {
  if (!ownsVaultMutation(session, mutation)) return withVaultMutation(session, (lease) => putLocalRecord(session, storeName, id, value, lease));
  const record = await encryptLocalRecord(session, storeName, id, value);
  await transaction(storeName, 'readwrite', (store) => store.put(record), session.stored);
}

async function loadLocalRecords<T>(session: VaultSession, storeName: LocalStore): Promise<T[]> {
  const records = await transaction<StoredLocalRecord[]>(storeName, 'readonly', (store) =>
    store.index('roomId').getAll(IDBKeyRange.only(localDataScope(session.vault))),
  );
  const values: T[] = [];
  for (const record of records) {
    try {
      values.push(await decryptLocalRecord<T>(session, storeName, record));
    } catch {
      throw new Error(`本机加密队列 ${storeName} 已损坏`);
    }
  }
  return values;
}

async function deleteLocalRecord(session: VaultSession, storeName: LocalStore, id: string, mutation?: VaultMutation): Promise<void> {
  if (!ownsVaultMutation(session, mutation)) return withVaultMutation(session, (lease) => deleteLocalRecord(session, storeName, id, lease));
  await transaction(storeName, 'readwrite', (store) => store.delete(`${localDataScope(session.vault)}:${id}`), session.stored);
}

export async function loadMemeFavorites(session: VaultSession): Promise<MemeFavorite[]> {
  const record = await transaction<StoredLocalRecord | undefined>('memeFavorites', 'readonly', store => store.get(`${localDataScope(session.vault)}:index`));
  return record ? normalizeMemeIndex(await decryptLocalRecord(session, 'memeFavorites', record)) : [];
}

export async function loadStickerPacks(session: VaultSession): Promise<StickerPack[]> {
  const record = await transaction<StoredLocalRecord | undefined>('memeFavorites', 'readonly', store => store.get(`${localDataScope(session.vault)}:packs`));
  if (!record) return [];
  const packs = await decryptLocalRecord<StickerPack[]>(session, 'memeFavorites', record);
  if (!Array.isArray(packs) || packs.length > MAX_STICKER_PACKS) throw new Error('贴纸合集索引已损坏');
  let total = 0;
  const ids = new Set<string>();
  for (const pack of packs) {
    if (!pack || !/^[a-z0-9-]{1,80}$/.test(pack.id) || ids.has(pack.id) || typeof pack.title !== 'string' || pack.title.length > 120
      || (pack.autoHide !== undefined && typeof pack.autoHide !== 'boolean')
      || !Number.isSafeInteger(pack.installedAt) || !Array.isArray(pack.items) || !pack.items.length || pack.items.length > MAX_PACK_ITEMS) throw new Error('贴纸合集索引已损坏');
    ids.add(pack.id);
    // Apply the same authenticated media metadata checks, in bounded pages.
    for (let offset = 0; offset < pack.items.length; offset += MAX_MEME_FAVORITES) normalizeMemeIndex(pack.items.slice(offset, offset + MAX_MEME_FAVORITES));
    const bytes = pack.items.reduce((sum, item) => sum + item.size, 0);
    if (bytes > MAX_PACK_BYTES) throw new Error('贴纸合集超出限制');
    total += bytes;
  }
  if (total > MAX_PACK_LIBRARY_BYTES) throw new Error('贴纸密室超出限制');
  return packs;
}

/** Whole packs become visible only after all verified originals commit together. */
export async function installStickerPack(session: VaultSession, id: string, title: string, files: File[], signal: AbortSignal, autoHide = false): Promise<void> {
  if (!/^[a-z0-9-]{1,80}$/.test(id) || title.length > 120 || !files.length || files.length > MAX_PACK_ITEMS
    || files.some(file => !file.size || file.size > MAX_MEME_BYTES || !MEME_TYPES.includes(file.type))
    || files.reduce((sum, file) => sum + file.size, 0) > MAX_PACK_BYTES) throw new Error('贴纸合集格式或大小不受支持');
  await withVaultMutation(session, async () => {
    signal.throwIfAborted();
    const packs = await loadStickerPacks(session);
    if (packs.some(pack => pack.id === id)) return;
    if (packs.length >= MAX_STICKER_PACKS || packs.flatMap(pack => pack.items).reduce((sum, item) => sum + item.size, 0)
      + files.reduce((sum, file) => sum + file.size, 0) > MAX_PACK_LIBRARY_BYTES) throw new Error('贴纸密室已满，请先移除部分合集');
    const items: MemeFavorite[] = []; const originals: StoredLocalRecord[] = []; const digests = new Set<string>();
    for (const file of files) {
      signal.throwIfAborted();
      const bytes = await file.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (digests.has(digest)) continue;
      digests.add(digest);
      const item: MemeFavorite = { id: crypto.randomUUID(), digest, name: file.name.slice(0, 120), type: file.type, size: file.size, savedAt: Date.now() };
      items.push(item); originals.push(await encryptLocalRecord(session, 'memeFavorites', item.id, toBase64Url(bytes)));
    }
    const index = await encryptLocalRecord(session, 'memeFavorites', 'packs', [...packs, { id, title, items, installedAt: Date.now(), autoHide: Boolean(autoHide) }]);
    await commitStickerRecords(session, [...originals, index], [], signal);
  });
}

/** Persist the user-selected shortcut order without rewriting pack originals. */
export async function reorderStickerPacks(session: VaultSession, ids: string[], signal: AbortSignal): Promise<void> {
  if (!Array.isArray(ids) || ids.length > MAX_STICKER_PACKS || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(id))) throw new Error('贴纸合集顺序不正确');
  await withVaultMutation(session, async () => {
    signal.throwIfAborted();
    const packs = await loadStickerPacks(session);
    const byId = new Map(packs.map(pack => [pack.id, pack]));
    if (ids.length !== packs.length || ids.some(id => !byId.has(id))) throw new Error('贴纸合集顺序不正确');
    const index = await encryptLocalRecord(session, 'memeFavorites', 'packs', ids.map(id => byId.get(id)!));
    await commitStickerRecords(session, [index], [], signal);
  });
}

export async function removeStickerPack(session: VaultSession, id: string, signal: AbortSignal): Promise<void> {
  await withVaultMutation(session, async () => {
    signal.throwIfAborted();
    const packs = await loadStickerPacks(session);
    const removed = packs.find(pack => pack.id === id);
    const index = await encryptLocalRecord(session, 'memeFavorites', 'packs', packs.filter(pack => pack.id !== id));
    await commitStickerRecords(session, [index], removed?.items.map(item => item.id) ?? [], signal);
  });
}

async function commitStickerRecords(session: VaultSession, records: StoredLocalRecord[], deleted: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const database = await openDatabase();
  if (signal.aborted) { database.close(); signal.throwIfAborted(); }
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['vault', 'memeFavorites'], 'readwrite');
    const abort = () => { try { tx.abort(); } catch { /* Transaction already finished. */ } };
    signal.addEventListener('abort', abort, { once: true });
    const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
    current.onsuccess = () => { if (!sameStoredVault(current.result, session.stored)) tx.abort(); };
    const store = tx.objectStore('memeFavorites');
    for (const record of records) store.put(record);
    for (const id of deleted) store.delete(`${localDataScope(session.vault)}:${id}`);
    const cleanup = () => { signal.removeEventListener('abort', abort); database.close(); };
    tx.oncomplete = () => { cleanup(); resolve(); };
    tx.onabort = () => { cleanup(); reject(tx.error ?? staleVaultError()); };
  });
}

export async function loadMemeFavoriteFile(session: VaultSession, item: MemeFavorite, signal: AbortSignal): Promise<File> {
  signal.throwIfAborted();
  const record = await transaction<StoredLocalRecord | undefined>('memeFavorites', 'readonly', store => store.get(`${localDataScope(session.vault)}:${item.id}`));
  if (!record) throw new Error('收藏图片已不存在');
  const data = await decryptLocalRecord<unknown>(session, 'memeFavorites', record);
  signal.throwIfAborted();
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_MEME_BYTES * 4 / 3)) throw new Error('收藏图片已损坏');
  const bytes = fromBase64Url(data);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  signal.throwIfAborted();
  if (bytes.byteLength !== item.size || digest !== item.digest) throw new Error('收藏图片完整性校验失败');
  return new File([bytes], item.name, { type: item.type, lastModified: 0 });
}

/** Index and independent encrypted original commit atomically under the vault lease. */
export async function saveMemeFavorite(session: VaultSession, file: File, signal: AbortSignal): Promise<boolean> {
  if (!file.size || file.size > MAX_MEME_BYTES || !MEME_TYPES.includes(file.type)) throw new Error('梗图格式或大小不受支持');
  const bytes = await file.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return withVaultMutation(session, async () => {
    signal.throwIfAborted();
    const items = await loadMemeFavorites(session);
    if (items.some(item => item.digest === digest)) return false;
    if (items.length >= MAX_MEME_FAVORITES || items.reduce((size, item) => size + item.size, file.size) > MAX_MEME_LIBRARY_BYTES) {
      throw new Error('收藏密室已满，请先取消部分收藏');
    }
    const item: MemeFavorite = { id: crypto.randomUUID(), digest, name: file.name.slice(0, 120), type: file.type, size: file.size, savedAt: Date.now() };
    const original = await encryptLocalRecord(session, 'memeFavorites', item.id, toBase64Url(bytes));
    const index = await encryptLocalRecord(session, 'memeFavorites', 'index', [item, ...items]);
    signal.throwIfAborted();
    const database = await openDatabase();
    if (signal.aborted) { database.close(); signal.throwIfAborted(); }
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['vault', 'memeFavorites'], 'readwrite');
      const abort = () => { try { tx.abort(); } catch { /* Already committed. */ } };
      signal.addEventListener('abort', abort, { once: true });
      const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
      current.onsuccess = () => { if (!sameStoredVault(current.result, session.stored)) tx.abort(); };
      tx.objectStore('memeFavorites').put(original); tx.objectStore('memeFavorites').put(index);
      const cleanup = () => { signal.removeEventListener('abort', abort); database.close(); };
      tx.oncomplete = () => { cleanup(); resolve(); };
      tx.onabort = () => { cleanup(); reject(tx.error ?? staleVaultError()); };
    });
    return true;
  });
}

export async function removeMemeFavorite(session: VaultSession, id: string, signal: AbortSignal): Promise<void> {
  await withVaultMutation(session, async () => {
    signal.throwIfAborted();
    const items = (await loadMemeFavorites(session)).filter(item => item.id !== id);
    const index = await encryptLocalRecord(session, 'memeFavorites', 'index', items);
    signal.throwIfAborted();
    const database = await openDatabase();
    if (signal.aborted) { database.close(); signal.throwIfAborted(); }
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['vault', 'memeFavorites'], 'readwrite');
      const abort = () => { try { tx.abort(); } catch { /* Already committed. */ } };
      signal.addEventListener('abort', abort, { once: true });
      const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
      current.onsuccess = () => { if (!sameStoredVault(current.result, session.stored)) tx.abort(); };
      tx.objectStore('memeFavorites').delete(`${localDataScope(session.vault)}:${id}`);
      tx.objectStore('memeFavorites').put(index);
      const cleanup = () => { signal.removeEventListener('abort', abort); database.close(); };
      tx.oncomplete = () => { cleanup(); resolve(); };
      tx.onabort = () => { cleanup(); reject(tx.error ?? staleVaultError()); };
    });
  });
}

function normalizeUiPreferences(value: unknown, { strict = false }: { strict?: boolean } = {}): UiPreferences {
  if (strict && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('本机加密偏好记录格式不正确');
  }
  const source = value && typeof value === 'object' ? value as Partial<UiPreferences> : {};
  const candidate = source.chatAnchor;
  const chatAnchor = candidate &&
    typeof candidate.clientMsgId === 'string' && candidate.clientMsgId.length > 0 && candidate.clientMsgId.length <= 128 &&
    Number.isSafeInteger(candidate.seq) && candidate.seq >= 0 &&
    Number.isFinite(candidate.offset) && Math.abs(candidate.offset) <= 100_000 &&
    typeof candidate.pinnedToBottom === 'boolean'
    ? {
        clientMsgId: candidate.clientMsgId,
        seq: candidate.seq,
        offset: candidate.offset,
        pinnedToBottom: candidate.pinnedToBottom,
      }
    : undefined;
  const rawHidden = source.hiddenChatMessageIds;
  const validHidden = rawHidden === undefined || (Array.isArray(rawHidden) && rawHidden.length <= 20_000 && rawHidden.every((id) =>
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
  );
  if (strict && !validHidden) throw new Error('本机删除偏好记录格式不正确');
  const hiddenChatMessageIds = Array.isArray(rawHidden) && validHidden
    ? [...new Set(rawHidden.map((id) => id.toLowerCase()))] : [];
  const rawGifs = source.gifChatMessageIds;
  const gifChatMessageIds = Array.isArray(rawGifs)
    ? [...new Set(rawGifs.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)).map(id => id.toLowerCase()))].slice(-400)
    : [];
  let galleryCuration: GalleryCurationRecord[] = [];
  let attachmentFavorites: AttachmentFavorite[] = [];
  try {
    attachmentFavorites = normalizeAttachmentFavorites(source.attachmentFavorites ?? []);
  } catch (cause) {
    if (strict) throw new Error('收藏偏好记录格式不正确', { cause });
  }
  try {
    galleryCuration = normalizeGalleryCurationRecords(source.galleryCuration ?? []);
  } catch (cause) {
    if (strict) throw new Error('保险箱整理偏好记录格式不正确', { cause });
    // A damaged optional projection must not make the encrypted draft or
    // scroll anchor unavailable. Drop only the untrusted curation records.
  }
  return {
    composerDraft: typeof source.composerDraft === 'string' ? source.composerDraft.slice(0, 4000) : '',
    ...(chatAnchor ? { chatAnchor } : {}),
    recoveryReminderDismissed: source.recoveryReminderDismissed === true,
    entranceCardDismissed: source.entranceCardDismissed === true,
    hiddenAlbumHintDismissed: source.hiddenAlbumHintDismissed === true,
    historyImportDismissed: source.historyImportDismissed === true,
    recoveryShieldHintSeen: source.recoveryShieldHintSeen === true,
    ...(hiddenChatMessageIds.length ? { hiddenChatMessageIds } : {}),
    ...(gifChatMessageIds.length ? { gifChatMessageIds } : {}),
    ...(galleryCuration.length ? { galleryCuration } : {}),
    ...(attachmentFavorites.length ? { attachmentFavorites } : {}),
  };
}

function uiPreferenceId(session: VaultSession): string {
  return `ui:${session.vault.localPreferenceDeviceId??session.vault.identity.publicBundle.deviceId}`;
}

function draftCommitId(session: VaultSession): string { return `composer-commit:${session.vault.localPreferenceDeviceId??session.vault.identity.publicBundle.deviceId}`; }

function composerDraftScope(session: VaultSession) {
  return { origin: location.origin, spaceId: vaultSpaceId(session.stored), roomId: session.vault.roomId,
    deviceId: session.vault.localPreferenceDeviceId??session.vault.identity.publicBundle.deviceId };
}

export async function prepareComposerDraft(session: VaultSession, fallback: string, isActive: () => boolean = () => true) {
  // Claiming the writer and reading its committed revision share the existing
  // cross-tab lifecycle lock with send, clearing and vault replacement.
  return withVaultLifecycle(async () => {
    if (!sameStoredVault(await readStoredVaultUnlocked(vaultSpaceId(session.stored)), session.stored)) throw staleVaultError();
    const record = await transaction<StoredLocalRecord | undefined>('preferences', 'readonly', store =>
      store.get(`${localDataScope(session.vault)}:${draftCommitId(session)}`));
    const committed = record ? await decryptLocalRecord<DraftSubmission>(session, 'preferences', record) : undefined;
    if (record && (!committed || typeof committed.revision !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(committed.revision))) throw new Error('本机草稿提交记录已损坏');
    return openDraftCheckpoint(session.key, composerDraftScope(session), fallback, committed, localStorage, false, isActive);
  });
}

export async function loadUiPreferences(session: VaultSession): Promise<UiPreferences> {
  const id = uiPreferenceId(session);
  const record = await transaction<StoredLocalRecord | undefined>('preferences', 'readonly', (store) =>
    store.get(`${localDataScope(session.vault)}:${id}`),
  );
  if (!record) return {};
  try {
    return normalizeUiPreferences(await decryptLocalRecord<unknown>(session, 'preferences', record), { strict: true });
  } catch (cause) {
    throw new Error('本机加密偏好记录已损坏，已停止显示以避免本机删除或置顶内容重新出现', { cause });
  }
}

/** Merge authenticated Safe tombstones before any restored media becomes visible. */
export async function restoreGalleryHidden(session: VaultSession, records: GalleryCurationRecord[], signal: AbortSignal): Promise<boolean> {
  if (session.vault.role !== 'creator' || !records.length) return false;
  const incoming = normalizeGalleryCurationRecords(records);
  if (incoming.some(record => !record.hidden || record.pinnedAt !== null)) throw new Error('保险箱删除记录不正确');
  return withVaultMutation(session, async mutation => {
    signal.throwIfAborted();
    const preferences = await loadUiPreferences(session);
    const merged = new Map((preferences.galleryCuration ?? []).map(record => [galleryCurationKey(record), record]));
    for (const record of incoming) merged.set(galleryCurationKey(record), record);
    if(merged.size>20_000)throw new Error('保险箱删除记录超过上限，已保留本机已有记录');
    const galleryCuration = normalizeGalleryCurationRecords([...merged.values()]);
    if (JSON.stringify(galleryCuration) === JSON.stringify(preferences.galleryCuration ?? [])) return false;
    signal.throwIfAborted();
    await putLocalRecord(session, 'preferences', uiPreferenceId(session), { ...preferences, galleryCuration }, mutation);
    return true;
  });
}

export function saveUiPreferences(session: VaultSession, preferences: UiPreferences): Promise<void> {
  return withVaultMutation(session, async mutation => {
    const next = normalizeUiPreferences(preferences);
    // A delayed draft/anchor save must not erase restored deletion projections.
    const previous = await loadUiPreferences(session);
    // Local history imports must not be undone by an older queued draft/anchor save.
    const hiddenChatMessageIds = [...new Set([...(next.hiddenChatMessageIds ?? []), ...(previous.hiddenChatMessageIds ?? [])])];
    if (hiddenChatMessageIds.length > 20_000) throw new Error('本机删除记录超过上限');
    if (hiddenChatMessageIds.length) next.hiddenChatMessageIds = hiddenChatMessageIds;
    const merged = new Map((next.galleryCuration ?? []).map(record => [galleryCurationKey(record), record]));
    for (const record of previous.galleryCuration ?? []) if (record.hidden) merged.set(galleryCurationKey(record), record);
    if (merged.size) next.galleryCuration = normalizeGalleryCurationRecords([...merged.values()]);
    await putLocalRecord(session, 'preferences', uiPreferenceId(session), next, mutation);
  });
}

export async function saveOutboxItem(session: VaultSession, item: OutboxItem, mutation?: VaultMutation, draft?: DraftSubmission): Promise<void> {
  if (!draft) return putLocalRecord(session, 'outbox', item.clientMsgId, item, mutation);
  if (!ownsVaultMutation(session, mutation)) return withVaultMutation(session, lease => saveOutboxItem(session, item, lease, draft));
  const outbox = await encryptLocalRecord(session, 'outbox', item.clientMsgId, item);
  const committed = await encryptLocalRecord(session, 'preferences', draftCommitId(session), draft);
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['vault', 'outbox', 'preferences'], 'readwrite');
    const current = tx.objectStore('vault').get(vaultSpaceId(session.stored));
    current.onsuccess = () => { if (!sameStoredVault(current.result, session.stored)) tx.abort(); };
    tx.objectStore('outbox').put(outbox); tx.objectStore('preferences').put(committed);
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onabort = () => { database.close(); reject(tx.error ?? staleVaultError()); };
    tx.onerror = () => reject(tx.error);
  });
}

/** Upgrade an older payload-only retry under the same cross-tab vault lease. */
export async function prepareLegacyOutboxItem(session: VaultSession, clientMsgId: string, mutation?: VaultMutation): Promise<OutboxItem | undefined> {
  if (!ownsVaultMutation(session, mutation)) return withVaultMutation(session, lease => prepareLegacyOutboxItem(session, clientMsgId, lease));
  const item = (await loadOutbox(session)).find(candidate => candidate.clientMsgId === clientMsgId);
  if (!item || item.envelope) return item;
  if (session.vault.protocol === 'mls-rfc9420') throw new Error('MLS 待发密文缺失，已停止发送');
  const prepared = { ...item, envelope: await encryptMessage(session.vault, item.payload, clientMsgId) };
  await saveOutboxItem(session, prepared, mutation);
  return prepared;
}

async function commitMlsVaultAndRecords(
  session: VaultSession,
  nextGroupState: string,
  records: { outbox?: OutboxItem; history?: DecryptedMessage; pendingReceipt?: DeliveryReceipt; draft?: DraftSubmission },
  mutation?: VaultMutation,
): Promise<void> {
  if (!ownsVaultMutation(session, mutation)) throw new Error('MLS 状态变更必须在完整保险库事务中执行');
  if ((session.stored.v !== 2 && session.stored.v !== 3) || (session.stored.unlockMethod !== 'platform' && session.stored.unlockMethod !== 'password') || !session.vault.mls) {
    throw new Error('MLS 状态只能写入通行密钥保险库');
  }
  const nextVault = structuredClone(session.vault);
  if (!nextVault.mls) throw new Error('MLS 本机状态不存在');
  nextVault.mls.groupState = nextGroupState;
  if (records.outbox?.intent) nextVault.outboxSequence = Math.max(nextVault.outboxSequence ?? 0, records.outbox.intent.sequence);
  if (records.outbox?.envelope?.v === 2 && records.outbox.envelope.retention) {
    nextVault.mls.sendSequence = Math.max(nextVault.mls.sendSequence ?? 0, records.outbox.envelope.retention.sendSequence);
    if (nextVault.mls.window) nextVault.mls.window.generated += 1;
  }
  if (records.history && nextVault.mls.window && !isWindowMessage(records.history.payload)) {
    nextVault.mls.window.controls.push(records.history.seq);
  }
  const nextStored: StoredPlatformVault | StoredPasswordVault = {
    ...session.stored,
    payload: await encryptPayload(nextVault, session.key),
  };
  if (records.history) {
    await assertCompatibleHistoryRecord(session, records.history, 'history');
    if (isGalleryMediaPayload(records.history.payload)) await assertCompatibleHistoryRecord(session, records.history, 'galleryHistory');
  }
  const outboxRecord = records.outbox
    ? await encryptLocalRecord(session, 'outbox', records.outbox.clientMsgId, records.outbox)
    : null;
  const historyRecord = records.history ? await encryptHistoryRecord(session, records.history) : null;
  const receiptRecord = records.pendingReceipt
    ? await encryptLocalRecord(session, 'receiptOutbox', records.pendingReceipt.clientMsgId, records.pendingReceipt)
    : null;
  const draftRecord = records.draft ? await encryptLocalRecord(session, 'preferences', draftCommitId(session), records.draft) : null;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const stores = [
      'vault',
      ...(outboxRecord ? ['outbox'] : []),
      ...(historyRecord ? ['history'] : []),
      ...(historyRecord && records.history && isGalleryMediaPayload(records.history.payload) ? ['galleryHistory'] : []),
      ...(receiptRecord ? ['receiptOutbox'] : []),
      ...(draftRecord ? ['preferences'] : []),
    ];
    const tx = database.transaction(stores, 'readwrite');
    putCurrentVault(tx, nextStored, session.stored);
    if (outboxRecord) tx.objectStore('outbox').put(outboxRecord);
    if (historyRecord) tx.objectStore('history').put(historyRecord);
    if (historyRecord && records.history && isGalleryMediaPayload(records.history.payload)) tx.objectStore('galleryHistory').put(historyRecord);
    if (receiptRecord) tx.objectStore('receiptOutbox').put(receiptRecord);
    if (draftRecord) tx.objectStore('preferences').put(draftRecord);
    tx.oncomplete = () => {
      database.close();
      session.vault = nextVault;
      session.stored = nextStored;
      resolve();
    };
    tx.onabort = () => {
      database.close();
      reject(tx.error ?? new Error('MLS 原子写入失败'));
    };
    tx.onerror = () => reject(tx.error ?? new Error('MLS 原子写入失败'));
  });
}

export function commitMlsSend(
  session: VaultSession,
  item: OutboxItem,
  nextGroupState: string,
  mutation?: VaultMutation,
  draft?: DraftSubmission,
): Promise<void> {
  return commitMlsVaultAndRecords(session, nextGroupState, { outbox: item, draft }, mutation);
}

export function commitMlsReceive(
  session: VaultSession,
  message: DecryptedMessage,
  nextGroupState: string,
  pendingReceipt?: DeliveryReceipt,
  mutation?: VaultMutation,
): Promise<void> {
  return commitMlsVaultAndRecords(session, nextGroupState, { history: message, pendingReceipt }, mutation);
}

/** Replace the old room cache and install the new identity's authenticated join boundary atomically. */
export async function finishVaultRecovery(session: VaultSession, nextVault: Vault, mutation: VaultMutation): Promise<void> {
  if (!ownsVaultMutation(session, mutation) || (session.stored.unlockMethod !== 'platform' && !(session.stored.v === 3 && session.stored.unlockMethod === 'password')) || !session.vault.pendingRecovery) {
    throw new Error('恢复完成操作没有有效的保险库事务');
  }
  const nextStored: StoredPlatformVault | StoredPasswordVault = { ...session.stored, payload: await encryptPayload(nextVault, session.key) };
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const stores = ['vault', 'history', 'galleryHistory', 'restoredGallery', 'mediaCacheEntries', 'mediaChunks', 'outbox', 'receiptOutbox', 'uploads', 'preferences', 'memeFavorites', 'privateArchive', 'privateMedia', 'privateArchiveStaging'];
    const tx = database.transaction(stores, 'readwrite');
    putCurrentVault(tx, nextStored, session.stored);
    for (const name of stores.slice(1)) {
      const store = tx.objectStore(name);
      const request = store.index('roomId').openKeyCursor(IDBKeyRange.only(localDataScope(nextVault)));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    tx.oncomplete = () => { database.close(); session.vault = nextVault; session.stored = nextStored; resolve(); };
    tx.onabort = () => { database.close(); reject(tx.error ?? new Error('恢复本机事务失败')); };
    tx.onerror = () => reject(tx.error ?? new Error('恢复本机事务失败'));
  });
  clearDraftCheckpoints(vaultSpaceId(session.stored));
}

export async function loadOutbox(session: VaultSession): Promise<OutboxItem[]> {
  return (await loadLocalRecords<OutboxItem>(session, 'outbox')).sort(compareOutboxItems);
}

export function deleteOutboxItem(session: VaultSession, clientMsgId: string, mutation?: VaultMutation): Promise<void> {
  return deleteLocalRecord(session, 'outbox', clientMsgId, mutation);
}

export async function hasOutboxItem(session:VaultSession,clientMsgId:string,mutation?:VaultMutation):Promise<boolean>{
  if(!ownsVaultMutation(session,mutation))return withVaultMutation(session,lease=>hasOutboxItem(session,clientMsgId,lease));
  return Boolean(await transaction('outbox','readonly',store=>store.get(`${localDataScope(session.vault)}:${clientMsgId}`),session.stored));
}

/** Cancel durable work and retain only an encrypted local deletion projection.
 * Never rewind the MLS ratchet: a generated but unsubmitted generation is skipped. */
export async function cancelOutboxItem(session:VaultSession,clientMsgId:string,mutation?:VaultMutation):Promise<void>{
  if(!ownsVaultMutation(session,mutation))return withVaultMutation(session,lease=>cancelOutboxItem(session,clientMsgId,lease));
  const preferences=await loadUiPreferences(session);
  const hidden=new Set(preferences.hiddenChatMessageIds??[]);hidden.add(clientMsgId.toLowerCase());
  if(hidden.size>20_000)throw new Error('本机删除记录超过上限');
  preferences.hiddenChatMessageIds=[...hidden];
  const record=await encryptLocalRecord(session,'preferences',uiPreferenceId(session),preferences);
  const nextStored={...session.stored,payload:await encryptPayload(session.vault,session.key)};
  const database=await openDatabase();
  await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(['vault','outbox','preferences'],'readwrite');
    // Validate the exact vault under the same lifecycle/CAS owner as a send.
    putCurrentVault(tx,nextStored,session.stored);
    tx.objectStore('outbox').delete(`${localDataScope(session.vault)}:${clientMsgId}`);
    tx.objectStore('preferences').put(record);
    tx.oncomplete=()=>{database.close();session.stored=nextStored;resolve();};
    tx.onabort=()=>{database.close();reject(tx.error??new Error('取消发送未能保存'));};
    tx.onerror=()=>reject(tx.error??new Error('取消发送未能保存'));
  });
}

export function savePendingReceipt(session: VaultSession, receipt: DeliveryReceipt, mutation?: VaultMutation): Promise<void> {
  return putLocalRecord(session, 'receiptOutbox', receipt.clientMsgId, receipt, mutation);
}

export function loadPendingReceipts(session: VaultSession): Promise<DeliveryReceipt[]> {
  return loadLocalRecords<DeliveryReceipt>(session, 'receiptOutbox');
}

export function deletePendingReceipt(session: VaultSession, clientMsgId: string): Promise<void> {
  return deleteLocalRecord(session, 'receiptOutbox', clientMsgId);
}

export function saveUploadPlan(session: VaultSession, plan: ImageUploadPlan): Promise<void> {
  return putLocalRecord(session, 'uploads', plan.blobId, plan);
}

export function loadUploadPlans(session: VaultSession): Promise<ImageUploadPlan[]> {
  return loadLocalRecords<ImageUploadPlan>(session, 'uploads');
}

export function deleteUploadPlan(session: VaultSession, blobId: string): Promise<void> {
  return deleteLocalRecord(session, 'uploads', blobId);
}

/** Encrypted collection data shares the same cross-tab lease as room writes. */
export async function readLocalSpaceDirectory(id: string): Promise<unknown> {
  return transaction('spaces', 'readonly', store => store.get(id));
}
/** A separate encrypted browser shell, never interpreted as a room vault. */
export async function readBrowserAccessRecord(): Promise<unknown> {
  return transaction('spaces', 'readonly', store => store.get('browser-access-profile'));
}
export async function writeBrowserAccessRecord(value: unknown, signal: AbortSignal, expected: unknown): Promise<void> {
  await withVaultLifecycle(async () => {
    signal.throwIfAborted();
    const db = await openDatabase();
    await new Promise<void>((resolve,reject) => {
      const tx = db.transaction('spaces','readwrite'), store = tx.objectStore('spaces');
      const abort = () => { try { tx.abort(); } catch { /* Already committed. */ } };
      signal.addEventListener('abort',abort,{once:true});
      const request = store.get('browser-access-profile');
      request.onsuccess = () => {
        if(signal.aborted || JSON.stringify(request.result ?? null) !== JSON.stringify(expected ?? null)) { abort(); return; }
        store.put(value,'browser-access-profile');
      };
      const cleanup = () => { signal.removeEventListener('abort',abort);db.close(); };
      tx.oncomplete = () => { cleanup();resolve(); };
      tx.onabort = () => { cleanup();reject(new Error('接入状态已在其他标签页更新或锁定，请重新验证')); };
    });
  });
}
export async function writeLocalSpaceDirectory(session: VaultSession, id: string, value: unknown, mutation: VaultMutation): Promise<void> {
  if (!ownsVaultMutation(session, mutation)) throw staleVaultError();
  await transaction('spaces', 'readwrite', store => store.put(value, id), session.stored);
}


/** Public label only. Shared by local spaces, never sent to room/catalog APIs. */
export async function readPasskeyName(record: PlatformCredentialRecord): Promise<string | undefined> {
  const saved = await transaction('security', 'readonly', store => store.get(`passkey-name:${record.credentialId}`));
  return typeof saved === 'string' ? saved : record.userName;
}
export async function writePasskeyName(session: VaultSession, record: PlatformCredentialRecord, name: string, signal: AbortSignal): Promise<void> {
  await withVaultLifecycle(async () => {
    signal.throwIfAborted();
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['security', 'vault'], 'readwrite');
      const abort = () => { try { tx.abort(); } catch { /* Already committed. */ } };
      signal.addEventListener('abort', abort, { once: true });
      const request = tx.objectStore('vault').get(vaultSpaceId(session.stored));
      request.onsuccess = () => {
        if (signal.aborted || !sameStoredVault(request.result, session.stored)) { abort(); return; }
        tx.objectStore('security').put(name, `passkey-name:${record.credentialId}`);
      };
      const cleanup = () => { signal.removeEventListener('abort', abort); db.close(); };
      tx.oncomplete = () => { cleanup(); resolve(); };
      tx.onabort = () => { cleanup(); reject(staleVaultError()); };
    });
  });
}

type StagedPrivateRecord = {id:string;roomId:string;record:StoredLocalRecord;previous?:StoredLocalRecord};
export async function stagePrivateArchiveItem(session:VaultSession,runId:string,item:import('./room-archive').PrivateArchiveItem,signal:AbortSignal):Promise<void> {
  await withVaultMutation(session,async()=>{
    signal.throwIfAborted();const scope=localDataScope(session.vault),id=`${item.originRoomId}:${item.message.clientMsgId}`;
    const previous=await transaction<StoredLocalRecord|undefined>('privateArchive','readonly',store=>store.get(`${scope}:${id}`));
    if(previous&&canonicalStringify(await decryptLocalRecord(session,'privateArchive',previous))!==canonicalStringify(item))throw new Error('导入记录与已保存的历史冲突');
    const record=previous??await encryptLocalRecord(session,'privateArchive',id,item);signal.throwIfAborted();
    await transaction('privateArchiveStaging','readwrite',store=>store.put({id:`${scope}:${runId}:${id}`,roomId:scope,record,previous} satisfies StagedPrivateRecord),session.stored);
  });
}
/** Publish every validated message/deletion event together; unfinished imports
 * never participate in rendering, notifications, receipts or automatic backup. */
export async function commitPrivateArchiveImport(session:VaultSession,runId:string,signal:AbortSignal):Promise<void> {
  await withVaultMutation(session,async()=>{
    signal.throwIfAborted();const database=await openDatabase(),prefix=`${localDataScope(session.vault)}:${runId}:`;
    await new Promise<void>((resolve,reject)=>{
      const tx=database.transaction(['vault','privateArchive','privateArchiveStaging'],'readwrite');
      const abort=()=>{try{tx.abort();}catch{/* Already committed. */}};signal.addEventListener('abort',abort,{once:true});
      const vault=tx.objectStore('vault').get(vaultSpaceId(session.stored));vault.onsuccess=()=>{if(!sameStoredVault(vault.result,session.stored))abort();};
      const cursor=tx.objectStore('privateArchiveStaging').openCursor(IDBKeyRange.bound(prefix,`${prefix}\uffff`));
      cursor.onsuccess=()=>{const entry=cursor.result;if(!entry)return;const staged=entry.value as StagedPrivateRecord;
        const current=tx.objectStore('privateArchive').get(staged.record.id);current.onsuccess=()=>{
          if(canonicalStringify(current.result??null)!==canonicalStringify(staged.previous??null)){abort();return;}
          tx.objectStore('privateArchive').put(staged.record);entry.delete();entry.continue();
        };
      };
      const finish=()=>{signal.removeEventListener('abort',abort);database.close();};
      tx.oncomplete=()=>{finish();resolve();};tx.onabort=()=>{finish();reject(tx.error??new Error('恢复提交中断，请重新恢复；原记录仍保留'));};
    });
  });
}
export async function discardPrivateArchiveStaging(session:VaultSession,runId?:string):Promise<void> {
  const database=await openDatabase(),scope=localDataScope(session.vault),prefix=runId?`${scope}:${runId}:`:`${scope}:`;
  await new Promise<void>((resolve,reject)=>{const tx=database.transaction('privateArchiveStaging','readwrite');
    const cursor=tx.objectStore('privateArchiveStaging').openKeyCursor(IDBKeyRange.bound(prefix,`${prefix}\uffff`));
    cursor.onsuccess=()=>{const entry=cursor.result;if(entry){tx.objectStore('privateArchiveStaging').delete(entry.primaryKey);entry.continue();}};
    tx.oncomplete=()=>{database.close();resolve();};tx.onabort=()=>{database.close();reject(tx.error);};
  });
}

/** Private imports never enter the shared history, outbox, receipt or projection stores. */
export async function savePrivateArchiveItem(session: VaultSession, item: import('./room-archive').PrivateArchiveItem): Promise<void> {
  const id = `${item.originRoomId}:${item.message.clientMsgId}`;
  await withVaultMutation(session, async mutation => {
    const record = await transaction<StoredLocalRecord | undefined>('privateArchive', 'readonly', store => store.get(`${localDataScope(session.vault)}:${id}`));
    const existing = record ? await decryptLocalRecord(session, 'privateArchive', record) : undefined;
    if (existing && canonicalStringify(existing) !== canonicalStringify(item)) throw new Error('导入记录与已保存的历史冲突');
    if (!existing) await putLocalRecord(session, 'privateArchive', id, item, mutation);
  });
}
export function loadPrivateArchiveItems(session: VaultSession): Promise<import('./room-archive').PrivateArchiveItem[]> {
  return loadLocalRecords(session, 'privateArchive');
}

export async function withRoomUnlockThrottle<T>(operation: () => Promise<T>): Promise<T> {
  const scope='room-protection-v2-throttle';
  const wait=Math.max(0,(await readUnlockThrottle(scope)).nextAllowedAt-Date.now());
  if(wait) throw new Error(`尝试次数过多，请 ${Math.ceil(wait/1000)} 秒后重试`);
  try { const value=await operation();await clearUnlockThrottle(scope);return value; }
  catch(cause) { await recordUnlockFailure(scope);throw cause; }
}

/** Management read does not navigate or change the browser's selected room. */
export function readStoredRoom(id:string):Promise<StoredVault|null> {
  return withVaultLifecycle(()=>readStoredVaultUnlocked(id));
}
/** One local transaction removes the room and every private-media namespace.
 * It deliberately makes no server request and cannot close the peer's room. */
export async function deleteNewRoomLocal(session:VaultSession, directory?: {owner:VaultSession;mutation:VaultMutation;id:string;value:unknown}):Promise<void> {
  if(!session.vault.roomArchiveV2)throw new Error('此操作仅适用于新密室');
  const remove=async()=>{
    if(directory&&!ownsVaultMutation(directory.owner,directory.mutation))throw staleVaultError();
    const database=await openDatabase(),scope=localDataScope(session.vault);
    await new Promise<void>((resolve,reject)=>{
      const names=['history','galleryHistory','restoredGallery','mediaCacheEntries','mediaChunks','outbox','receiptOutbox','uploads','preferences','memeFavorites','privateArchive','privateMedia','privateArchiveStaging'];
      const tx=database.transaction(['vault','spaces',...names],'readwrite');
      if(directory){const owner=tx.objectStore('vault').get(vaultSpaceId(directory.owner.stored));owner.onsuccess=()=>{if(!sameStoredVault(owner.result,directory.owner.stored))tx.abort();else tx.objectStore('spaces').put(directory.value,directory.id);};}
      const request=tx.objectStore('vault').get(vaultSpaceId(session.stored));
      request.onsuccess=()=>{
        if(!sameStoredVault(request.result,session.stored)){tx.abort();return;}
        tx.objectStore('vault').delete(vaultSpaceId(session.stored));
        for(const name of names){
          const cursor=tx.objectStore(name).index('roomId').openKeyCursor(IDBKeyRange.bound(scope,`${scope}\uffff`));
          cursor.onsuccess=()=>{const item=cursor.result;if(!item)return;if(item.key===scope||String(item.key).startsWith(`${scope}:private:`))tx.objectStore(name).delete(item.primaryKey);item.continue();};
        }
      };
      tx.oncomplete=()=>{database.close();resolve();};tx.onabort=()=>{database.close();reject(tx.error??staleVaultError());};
    });
    clearDraftCheckpoints(vaultSpaceId(session.stored));
  };
  if(directory)await remove();else await withVaultLifecycle(remove);
}

/** Imported originals are durable private data, never an evictable media cache. */
export async function savePrivateMediaChunk(session:VaultSession,blobId:string,index:number,raw:ArrayBuffer,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();await withVaultMutation(session,async mutation=>{
    signal.throwIfAborted();const id=`${blobId}:${index}`,encoded=toBase64Url(raw);
    const record=await transaction<StoredLocalRecord|undefined>('privateMedia','readonly',store=>store.get(`${localDataScope(session.vault)}:${id}`));
    if(record){if(await decryptLocalRecord<string>(session,'privateMedia',record)!==encoded)throw new Error('导入原文件与本机历史冲突');return;}
    signal.throwIfAborted();await putLocalRecord(session,'privateMedia',id,encoded,mutation);
  });signal.throwIfAborted();
}
export async function loadPrivateMediaChunk(session:VaultSession,blobId:string,index:number,size:number):Promise<ArrayBuffer|null>{
  const record=await transaction<StoredLocalRecord|undefined>('privateMedia','readonly',store=>store.get(`${localDataScope(session.vault)}:${blobId}:${index}`));
  if(!record)return null;const encoded=await decryptLocalRecord<string>(session,'privateMedia',record),raw=fromBase64Url(encoded);
  if(raw.length!==size)throw new Error('历史原文件分块不完整');return raw.buffer;
}
