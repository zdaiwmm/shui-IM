import { argon2id } from 'hash-wasm';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { downloadBlob } from './download';
import { generateIdentity } from './crypto';
import { createRecoveryRequest } from './mls';
import { isMessagePayload } from './message-payload';
import { isGalleryMediaPayload } from './video-media';
import { normalizeGalleryCurationRecords, type GalleryCurationRecord } from './gallery-curation';
import type { CloudRecoveryBundle } from './backup-types';
import { parseCloudRecoveryCode } from './backup-crypto';
import {
  createPlatformCredential,
  isPlatformVaultCancellation,
  unlockPlatformCredential,
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
  StoredRecoveryVault,
  StoredVault,
  Vault,
  VaultKdf,
} from './types';

const DB_NAME = 'quiet-room';
const DB_VERSION = 7;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PLATFORM_PAYLOAD_AAD = encoder.encode('quiet-room-vault-payload-v2');

export type VaultSession = {
  vault: Vault;
  key: CryptoKey;
  stored: StoredVault;
};

/** A lease for one complete read/derive/write operation, never for a DB put alone. */
export type VaultMutation = { readonly session: VaultSession; readonly id: symbol };
let vaultLifecycle: Promise<unknown> = Promise.resolve();
let activeVaultMutation: VaultMutation | undefined;

// All rooms occupy one physical IDB record. Hold this lock across snapshot reads,
// crypto and commits, including unlock and replacement, and share it across tabs.
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
  if (!expected) { store.put(next, 'current'); return; }
  const request = store.get('current');
  request.onsuccess = () => {
    if (!sameStoredVault(request.result, expected)) { tx.abort(); return; }
    store.put(next, 'current');
  };
}

async function installStoredVault(next: StoredVault, expected?: StoredVault): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('vault', 'readwrite');
    putCurrentVault(tx, next, expected);
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onabort = () => { database.close(); reject(tx.error ?? staleVaultError()); };
    tx.onerror = () => reject(tx.error ?? new Error('保险库写入失败'));
  });
}

export async function withVaultMutation<T>(
  session: VaultSession,
  operation: (mutation: VaultMutation) => Promise<T>,
): Promise<T> {
  return withVaultLifecycle(async () => {
    if (!sameStoredVault(await readStoredVaultUnlocked(), session.stored)) throw staleVaultError();
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
};

type LocalStore = 'outbox' | 'receiptOutbox' | 'uploads' | 'preferences';

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
  /** Device-local chat projection; it never mutates encrypted room history. */
  hiddenChatMessageIds?: string[];
  /** Device-local Safe ordering/removal projection. */
  galleryCuration?: GalleryCurationRecord[];
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
      if (!database.objectStoreNames.contains('vault')) database.createObjectStore('vault');
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
      for (const storeName of ['outbox', 'receiptOutbox', 'uploads', 'preferences'] as const) {
        if (!database.objectStoreNames.contains(storeName)) {
          const store = database.createObjectStore(storeName, { keyPath: 'id' });
          store.createIndex('roomId', 'roomId', { unique: false });
        }
      }
      if (!database.objectStoreNames.contains('security')) database.createObjectStore('security');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function transaction<T>(
  storeName: 'vault' | 'history' | 'restoredGallery' | 'mediaChunks' | 'security' | LocalStore,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
  expectedVault?: StoredVault,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(expectedVault ? [storeName, 'vault'] : storeName, mode);
    if (expectedVault) {
      const current = tx.objectStore('vault').get('current');
      current.onsuccess = () => { if (!sameStoredVault(current.result, expectedVault)) tx.abort(); };
    }
    const request = action(tx.objectStore(storeName));
    request.onerror = () => reject(request.error);
    tx.onabort = () => { database.close(); reject(tx.error ?? staleVaultError()); };
    tx.oncomplete = () => {
      resolve(request.result);
      database.close();
    };
  });
}

function mediaBlobKey(roomId: string, blobId: string): string {
  return `${roomId}\u0000${blobId}`;
}

function mediaChunkId(roomId: string, blobId: string, index: number): string {
  return `${mediaBlobKey(roomId, blobId)}\u0000${index}`;
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
    store.get(mediaChunkId(session.vault.roomId, blobId, index)), session.stored);
  if (!record || record.roomId !== session.vault.roomId || record.blobId !== blobId || record.index !== index ||
      !(record.bytes instanceof ArrayBuffer) || record.bytes.byteLength !== expectedBytes) return null;
  return record.bytes.slice(0);
}

export async function saveCachedMediaChunk(
  session: VaultSession,
  blobId: string,
  index: number,
  bytes: ArrayBuffer,
): Promise<void> {
  const roomId = session.vault.roomId;
  const record: StoredMediaChunk = {
    id: mediaChunkId(roomId, blobId, index),
    roomId,
    blobKey: mediaBlobKey(roomId, blobId),
    blobId,
    index,
    bytes: bytes.slice(0),
    cachedAt: Date.now(),
  };
  await transaction('mediaChunks', 'readwrite', store => store.put(record), session.stored);
}

export async function deleteCachedMediaBlob(session: VaultSession, blobId: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['mediaChunks', 'vault'], 'readwrite');
    const current = tx.objectStore('vault').get('current');
    current.onsuccess = () => {
      if (!sameStoredVault(current.result, session.stored)) {
        tx.abort();
        return;
      }
      const request = tx.objectStore('mediaChunks').index('blobKey')
        .openKeyCursor(IDBKeyRange.only(mediaBlobKey(session.vault.roomId, blobId)));
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

function isBoundedBase64(value: unknown, minimum = 16, maximum = 2 * 1024 * 1024): value is string {
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
    isBoundedBase64(stored.payload?.ciphertext)
  );
}

function validateRecoveryStoredVault(value: unknown): value is StoredRecoveryVault {
  if (!value || typeof value !== 'object') return false;
  const stored = value as StoredRecoveryVault;
  return Boolean(
    (stored.v === 2 || stored.v === 3) && stored.unlockMethod === 'recovery' &&
    typeof stored.exportedAt === 'string' && Number.isFinite(Date.parse(stored.exportedAt)) &&
    isBoundedBase64(stored.payload?.iv, 16, 128) &&
    isBoundedBase64(stored.payload?.ciphertext) &&
    isBoundedBase64(stored.recovery?.salt, 20, 128) &&
    isBoundedBase64(stored.recovery?.iv, 16, 128) &&
    isBoundedBase64(stored.recovery?.ciphertext, 48, 256)
  );
}

function validateStoredVault(value: unknown): value is StoredVault {
  return validateLegacyStoredVault(value) || validatePlatformStoredVault(value) || validateRecoveryStoredVault(value);
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

async function encryptPayload(vault: Vault, key: CryptoKey): Promise<StoredPlatformVault['payload']> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: PLATFORM_PAYLOAD_AAD, tagLength: 128 },
    key,
    encoder.encode(JSON.stringify({ ...vault, v: 3 })),
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
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode('quiet-room-vault-v1'), tagLength: 128 },
    key,
    encoder.encode(JSON.stringify(vault)),
  );
  return { v: 1, unlockMethod, kdf, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
}

export async function hasStoredVault(): Promise<boolean> {
  // Presence, not truthiness, matters here: a truncated/invalid record may be
  // a falsy value and must still reach the recovery/diagnostic screen instead
  // of being mistaken for a first-run vault.
  return (await transaction('vault', 'readonly', (store) => store.get('current'))) !== undefined;
}

export async function readStoredVault(): Promise<StoredVault | null> {
  return withVaultLifecycle(readStoredVaultUnlocked);
}

async function readStoredVaultUnlocked(): Promise<StoredVault | null> {
  const value: unknown = await transaction('vault', 'readonly', (store) => store.get('current'));
  return validateStoredVault(value) ? value : null;
}

export async function deleteCurrentVault(): Promise<void> {
  await withVaultLifecycle(() => transaction('vault', 'readwrite', (store) => store.delete('current')));
}

export async function downloadVaultDiagnostic(): Promise<void> {
  const value: unknown = await transaction('vault', 'readonly', (store) => store.get('current'));
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
  preparedPlatformCredential?: PlatformCredentialResult,
  isActive: () => boolean = () => true,
): Promise<VaultSession> {
  return withVaultLifecycle(() => createVaultLocked(vault, legacySecret, unlockMethod, preparedPlatformCredential, isActive));
}

async function createVaultLocked(
  vault: Vault,
  legacySecret = '',
  unlockMethod: 'password' | 'platform' = 'platform',
  preparedPlatformCredential?: PlatformCredentialResult,
  isActive: () => boolean = () => true,
  expected?: StoredVault,
): Promise<VaultSession> {
  if (!isActive()) throw new DOMException('保险库创建流程已经结束', 'AbortError');
  if (unlockMethod === 'password') {
    const { bytes, kdf } = await deriveGestureBytes(legacySecret);
    const key = await importMasterKey(bytes);
    bytes.fill(0);
    const stored = await encryptLegacyVault(vault, key, kdf, 'password');
    if (!isActive()) throw new DOMException('保险库创建流程已经结束', 'AbortError');
    await installStoredVault(stored, expected);
    await clearUnlockThrottle();
    return { vault, key, stored };
  }
  const platformResult = preparedPlatformCredential ?? await createPlatformCredential();
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
  await clearUnlockThrottle();
  vault.v = 3;
  return { vault, key, stored };
}

async function readUnlockThrottle(): Promise<UnlockThrottle> {
  const value = await transaction<UnlockThrottle | undefined>('security', 'readonly', (store) => store.get('unlock-throttle'));
  return value && Number.isInteger(value.failures) && Number.isFinite(value.nextAllowedAt)
    ? value
    : { failures: 0, nextAllowedAt: 0 };
}

async function recordUnlockFailure(): Promise<void> {
  const current = await readUnlockThrottle();
  const failures = current.failures + 1;
  const delay = failures <= 3 ? 0 : Math.min(30_000, 1000 * 2 ** (failures - 4));
  await transaction('security', 'readwrite', (store) => store.put({ failures, nextAllowedAt: Date.now() + delay }, 'unlock-throttle'));
}

async function clearUnlockThrottle(): Promise<void> {
  await transaction('security', 'readwrite', (store) => store.delete('unlock-throttle'));
}

async function enforceUnlockThrottle(): Promise<void> {
  const throttle = await readUnlockThrottle();
  const waitMs = throttle.nextAllowedAt - Date.now();
  if (waitMs > 0) throw new Error(`尝试次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
}

export async function unlockVault(secret = '', preparedPlatformProof?: Promise<Uint8Array<ArrayBuffer>>): Promise<VaultSession> {
  // A UI-provided WebAuthn request starts in the trusted gesture stack, but it
  // must settle before taking the cross-tab lifecycle lock. Otherwise a
  // cancelled/abandoned system sheet can block a fresh verification attempt.
  const platformProof = preparedPlatformProof ? await preparedPlatformProof : undefined;
  return withVaultLifecycle(() => unlockVaultLocked(secret, platformProof));
}

/** Resume an in-memory capability only from its unchanged, authenticated durable snapshot. */
export async function resumeVaultSession(session: VaultSession): Promise<VaultSession> {
  return withVaultLifecycle(async () => {
    const stored = await readStoredVaultUnlocked();
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
    return { vault, key: session.key, stored };
  });
}

async function unlockVaultLocked(secret: string, preparedPlatformProof?: Uint8Array<ArrayBuffer>): Promise<VaultSession> {
  const stored = await readStoredVaultUnlocked();
  if (!stored) throw new Error('本机没有可解锁的会话');
  if (stored.unlockMethod === 'recovery') throw new Error('恢复包需要先输入独立恢复码');
  await enforceUnlockThrottle();
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
    } else {
      // UI callers prepare WebAuthn before lifecycle/IndexedDB work so Safari
      // keeps trusted activation. Non-UI diagnostics retain the direct path.
      const prfOutput = preparedPlatformProof ?? await unlockPlatformCredential(stored.platform);
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
        unlocked = { vault, key, stored: migrated };
      } else {
        unlocked = { vault, key, stored };
      }
      masterBytes.fill(0);
    }
    await clearUnlockThrottle();
    return unlocked;
  } catch (error) {
    if (isPlatformVaultCancellation(error)) throw error;
    await recordUnlockFailure().catch(() => undefined);
    throw new Error(stored.v === 3
      ? '设备安全验证未通过，或本机保险库已经损坏'
      : stored.v === 2
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
  if ((session.stored.v !== 2 && session.stored.v !== 3) || session.stored.unlockMethod !== 'platform') {
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
  if (record.format !== 'quiet-room-recovery') throw new Error('这不是有效的 Quiet Room 恢复包');
  if (record.version === 2 || record.version === 3) {
    const stored: StoredRecoveryVault = {
      v: record.version,
      unlockMethod: 'recovery',
      exportedAt: String(record.exportedAt ?? ''),
      payload: record.payload as StoredRecoveryVault['payload'],
      recovery: record.recovery as StoredRecoveryVault['recovery'],
    };
    if (!validateRecoveryStoredVault(stored)) throw new Error('恢复包格式或安全参数不正确');
    await transaction('vault', 'readwrite', (store) => store.put(stored, 'current'));
    return;
  }
  if (!validateLegacyStoredVault(record.vault)) throw new Error('这不是有效的 Quiet Room 恢复包');
  await transaction('vault', 'readwrite', (store) => store.put(record.vault, 'current'));
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
    vault.recoverySource = { backupId: bundle.backupId, archives: structuredClone(bundle.archives) };
    const masterBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await importMasterKey(masterBytes);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const exportedAt = new Date().toISOString();
    try {
      const kek = await recoveryKek(recoveryBytes, salt);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
        additionalData: encoder.encode(`quiet-room-recovery-v3:${exportedAt}`), tagLength: 128 }, kek, masterBytes);
      const stored: StoredRecoveryVault = { v: 3, unlockMethod: 'recovery', exportedAt,
        payload: await encryptPayload(vault, key), recovery: { salt: toBase64Url(salt), iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) } };
      signal.throwIfAborted();
      const database = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('vault', 'readwrite');
        const current = tx.objectStore('vault').get('current');
        current.onsuccess = () => {
          const actual = validateStoredVault(current.result) ? current.result : null;
          if (signal.aborted || !sameStoredVault(actual, expected)) { tx.abort(); return; }
          tx.objectStore('vault').put(stored, 'current');
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

/** Imported content never advances MLS, network cursors, receipts, or an ordinary linked device's access. */
export async function importArchivedMessages(
  session: VaultSession,
  messages: DecryptedMessage[],
  scope: 'chat' | 'gallery',
  signal?: AbortSignal,
  onCommit: (changed: boolean) => void = () => undefined,
): Promise<number> {
  return withVaultMutation(session, async () => {
    signal?.throwIfAborted();
    const storeName = scope === 'gallery' ? 'restoredGallery' : 'history';
    const records: StoredHistory[] = [];
    let importedContentCount = 0;
    for (const message of messages) {
      if (!Number.isSafeInteger(message.seq) || message.seq < 1 || !isMessagePayload(message.payload) ||
          typeof message.clientMsgId !== 'string' || typeof message.senderId !== 'string' || typeof message.acceptedAt !== 'string') throw new Error('历史备份记录不正确');
      const galleryOnly = message.payload.kind === 'gallery-image' || message.payload.kind === 'gallery-file';
      if (scope === 'chat' && galleryOnly) continue;
      const galleryProjectionEvent = message.payload.kind === 'message-delete';
      if (scope === 'gallery' && !isGalleryMediaPayload(message.payload) && !galleryProjectionEvent) continue;
      const [historyRecord, restoredRecord] = await Promise.all([
        assertCompatibleHistoryRecord(session, message, 'history'),
        assertCompatibleHistoryRecord(session, message, 'restoredGallery'),
      ]);
      const previous = storeName === 'history' ? historyRecord : restoredRecord;
      if (previous) {
        continue;
      }
      records.push(await encryptHistoryRecord(session, message));
      // Gallery recovery reports restored media, not internal projection events
      // needed to keep a later room-wide deletion effective.
      if (scope === 'chat' || isGalleryMediaPayload(message.payload)) importedContentCount++;
    }
    signal?.throwIfAborted();
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['vault', storeName], 'readwrite');
      const current = tx.objectStore('vault').get('current');
      current.onsuccess = () => { if (!sameStoredVault(current.result, session.stored) || signal?.aborted) tx.abort(); };
      for (const record of records) tx.objectStore(storeName).put(record);
      const abort = () => { try { tx.abort(); } catch { /* already complete */ } };
      signal?.addEventListener('abort', abort, { once: true });
      const release = () => { signal?.removeEventListener('abort', abort); database.close(); };
      tx.oncomplete = () => { release(); resolve(); };
      tx.onabort = () => { release(); reject(signal?.reason ?? tx.error ?? staleVaultError()); };
      tx.onerror = () => reject(tx.error);
    });
    onCommit(records.length > 0);
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
  const additionalData = encoder.encode(`quiet-room-history-v1:${session.vault.roomId}:${message.seq}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    session.key,
    encoder.encode(JSON.stringify(message)),
  );
  return {
    id: `${session.vault.roomId}:${message.seq}`,
    roomId: session.vault.roomId,
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
  storeName: 'history' | 'restoredGallery',
): Promise<StoredHistory | undefined> {
  const existing = await transaction<StoredHistory | undefined>(storeName, 'readonly', store =>
    store.get(`${session.vault.roomId}:${message.seq}`));
  if (!existing) return undefined;
  const decrypted = (await decryptHistoryRecords(session, [existing], undefined, { strict: true }))[0];
  if (!decrypted || !sameHistoryMessage(decrypted, message)) throw new Error('历史记录与本机数据冲突');
  return existing;
}

export async function saveHistoryMessage(session: VaultSession, message: DecryptedMessage, mutation?: VaultMutation): Promise<void> {
  if (!ownsVaultMutation(session, mutation)) return withVaultMutation(session, (lease) => saveHistoryMessage(session, message, lease));
  await assertCompatibleHistoryRecord(session, message, 'restoredGallery');
  const record = await encryptHistoryRecord(session, message);
  await transaction('history', 'readwrite', (store) => store.put(record), session.stored);
}

export async function loadHistory(session: VaultSession): Promise<DecryptedMessage[]> {
  const records = await transaction<StoredHistory[]>('history', 'readonly', (store) =>
    store.index('roomId').getAll(IDBKeyRange.only(session.vault.roomId)),
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
      IDBKeyRange.bound([session.vault.roomId, 0], [session.vault.roomId, upper]),
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
  { limit = 200, afterSeq = 0, signal }: { limit?: number; afterSeq?: number; signal?: AbortSignal } = {},
): Promise<DecryptedMessage[]> {
  return decryptHistoryRecords(session, await loadHistoryRecordsAfter(session, { limit, afterSeq, signal }), signal);
}

async function loadHistoryRecordsAfter(
  session: VaultSession,
  { limit, afterSeq, signal }: { limit: number; afterSeq: number; signal?: AbortSignal },
  storeName: 'history' | 'restoredGallery' = 'history',
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
        [session.vault.roomId, lower],
        [session.vault.roomId, Number.MAX_SAFE_INTEGER],
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

/**
 * Rebuild timeline projection events beyond the visible history page without
 * a plaintext index. Raw sequence progress lets a corrupt cache page be
 * skipped without hiding valid events in later pages.
 */
export async function loadMessageEventHistory(
  session: VaultSession,
  { signal }: { signal?: AbortSignal } = {},
): Promise<DecryptedMessage[]> {
  // Restored Safe media remains isolated from chat rows, but its deletion
  // events are part of the same projection. Prefer ordinary history when the
  // same server sequence exists in both stores and collapse a replayed event
  // ID before reducers see it.
  const messagesBySequence = new Map<number, DecryptedMessage>();
  const eventsBySequence = new Map<number, DecryptedMessage>();
  const liveHistorySequences = new Set<number>();
  const limit = 200;
  for (const storeName of ['restoredGallery', 'history'] as const) {
    let afterSeq = 0;
    for (;;) {
      signal?.throwIfAborted();
      const records = await loadHistoryRecordsAfter(session, { limit, afterSeq, signal }, storeName);
      if (!records.length) break;
      const page = await decryptHistoryRecords(session, records, signal, { strict: true });
      for (const message of page) {
        if (storeName === 'history') liveHistorySequences.add(message.seq);
        const existing = messagesBySequence.get(message.seq);
        if (existing && !sameHistoryMessage(existing, message)) throw new Error('本机加密历史记录存在冲突');
        // Ordinary history is scanned second and is the canonical copy when
        // both stores contain the exact same restored record.
        messagesBySequence.set(message.seq, message);
        if ((message?.payload?.kind === 'reaction' || message?.payload?.kind === 'message-delete') && isMessagePayload(message.payload)) {
          eventsBySequence.set(message.seq, message);
        }
      }
      afterSeq = records.at(-1)!.seq;
      if (records.length < limit) break;
    }
  }
  // Every post-join server sequence is persisted locally, including hidden
  // gallery and projection events. Detect a physically removed ciphertext row
  // as well as AEAD corruption; otherwise lastSeq would permanently suppress
  // refetch and a removed delete tombstone could revive its target.
  const boundary = session.vault.historyUnavailableBeforeSeq ?? 0;
  if (Number.isSafeInteger(session.vault.lastSeq) && session.vault.lastSeq >= boundary) {
    const sequences = [...liveHistorySequences]
      .filter(seq => seq > boundary && seq <= session.vault.lastSeq)
      .sort((left, right) => left - right);
    let expected = boundary + 1;
    for (const seq of sequences) {
      if (seq !== expected) throw new Error(`本机加密历史记录 ${expected} 缺失，已停止显示以避免撤回内容重新出现`);
      expected += 1;
    }
    if (expected <= session.vault.lastSeq) throw new Error(`本机加密历史记录 ${expected} 缺失，已停止显示以避免撤回内容重新出现`);
  }
  const ordered = [...eventsBySequence.values()].sort((left, right) => left.seq - right.seq);
  const eventsById = new Map(ordered.map((message) => [message.clientMsgId, message]));
  return [...eventsById.values()].sort((left, right) => left.seq - right.seq);
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
    store.get(`${session.vault.roomId}:${seq}`),
  );
  signal?.throwIfAborted();
  if (!record || record.roomId !== session.vault.roomId || record.seq !== seq) return null;
  return (await decryptHistoryRecords(session, [record], signal))[0] ?? null;
}

/** Media type stays encrypted. Scan a bounded page and retain only media payloads. */
export async function loadMediaHistoryPage(
  session: VaultSession,
  { beforeSeq, limit = 200, signal }: { beforeSeq?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<{ messages: DecryptedMessage[]; beforeSeq: number | null; hasMore: boolean }> {
  signal?.throwIfAborted();
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  const upper = beforeSeq === undefined ? Number.MAX_SAFE_INTEGER : beforeSeq - 1;
  if (upper < 1) return { messages: [], beforeSeq: null, hasMore: false };
  const database = await openDatabase();
  type TaggedHistory = { storeName: 'history' | 'restoredGallery'; record: StoredHistory };
  const scan = await new Promise<{ records: TaggedHistory[]; truncated: boolean }>((resolve, reject) => {
    const tx = database.transaction(['history', 'restoredGallery'], 'readonly');
    const collected: TaggedHistory[] = [];
    let truncated = false;
    const abort = () => { try { tx.abort(); } catch { /* The readonly transaction has already finished. */ } };
    const release = () => {
      signal?.removeEventListener('abort', abort);
      database.close();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const name of ['history', 'restoredGallery'] as const) {
      const request = tx.objectStore(name).index('roomSeq').openCursor(
        IDBKeyRange.bound([session.vault.roomId, 1], [session.vault.roomId, upper]), 'prev');
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
  return {
    messages: page.map(item => item.message).filter((message) => isGalleryMediaPayload(message.payload)),
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
      if (strict) throw new Error(`本机加密历史记录 ${record.seq} 已损坏，已停止显示以避免撤回内容重新出现`);
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
  const recordId = `${session.vault.roomId}:${id}`;
  const additionalData = encoder.encode(`quiet-room-${storeName}-v1:${recordId}`);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    session.key,
    encoder.encode(JSON.stringify(value)),
  );
  return {
    id: recordId,
    roomId: session.vault.roomId,
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
    store.index('roomId').getAll(IDBKeyRange.only(session.vault.roomId)),
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
  await transaction(storeName, 'readwrite', (store) => store.delete(`${session.vault.roomId}:${id}`), session.stored);
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
  let galleryCuration: GalleryCurationRecord[] = [];
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
    ...(hiddenChatMessageIds.length ? { hiddenChatMessageIds } : {}),
    ...(galleryCuration.length ? { galleryCuration } : {}),
  };
}

function uiPreferenceId(session: VaultSession): string {
  return `ui:${session.vault.identity.publicBundle.deviceId}`;
}

export async function loadUiPreferences(session: VaultSession): Promise<UiPreferences> {
  const id = uiPreferenceId(session);
  const record = await transaction<StoredLocalRecord | undefined>('preferences', 'readonly', (store) =>
    store.get(`${session.vault.roomId}:${id}`),
  );
  if (!record) return {};
  try {
    return normalizeUiPreferences(await decryptLocalRecord<unknown>(session, 'preferences', record), { strict: true });
  } catch (cause) {
    throw new Error('本机加密偏好记录已损坏，已停止显示以避免本机删除或置顶内容重新出现', { cause });
  }
}

export function saveUiPreferences(session: VaultSession, preferences: UiPreferences): Promise<void> {
  return putLocalRecord(session, 'preferences', uiPreferenceId(session), normalizeUiPreferences(preferences));
}

export function saveOutboxItem(session: VaultSession, item: OutboxItem, mutation?: VaultMutation): Promise<void> {
  return putLocalRecord(session, 'outbox', item.clientMsgId, item, mutation);
}

async function commitMlsVaultAndRecords(
  session: VaultSession,
  nextGroupState: string,
  records: { outbox?: OutboxItem; history?: DecryptedMessage; pendingReceipt?: DeliveryReceipt },
  mutation?: VaultMutation,
): Promise<void> {
  if (!ownsVaultMutation(session, mutation)) throw new Error('MLS 状态变更必须在完整保险库事务中执行');
  if ((session.stored.v !== 2 && session.stored.v !== 3) || session.stored.unlockMethod !== 'platform' || !session.vault.mls) {
    throw new Error('MLS 状态只能写入通行密钥保险库');
  }
  const nextVault = structuredClone(session.vault);
  if (!nextVault.mls) throw new Error('MLS 本机状态不存在');
  nextVault.mls.groupState = nextGroupState;
  const nextStored: StoredPlatformVault = {
    ...session.stored,
    payload: await encryptPayload(nextVault, session.key),
  };
  if (records.history) await assertCompatibleHistoryRecord(session, records.history, 'restoredGallery');
  const outboxRecord = records.outbox
    ? await encryptLocalRecord(session, 'outbox', records.outbox.clientMsgId, records.outbox)
    : null;
  const historyRecord = records.history ? await encryptHistoryRecord(session, records.history) : null;
  const receiptRecord = records.pendingReceipt
    ? await encryptLocalRecord(session, 'receiptOutbox', records.pendingReceipt.clientMsgId, records.pendingReceipt)
    : null;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const stores = [
      'vault',
      ...(outboxRecord ? ['outbox'] : []),
      ...(historyRecord ? ['history'] : []),
      ...(receiptRecord ? ['receiptOutbox'] : []),
    ];
    const tx = database.transaction(stores, 'readwrite');
    putCurrentVault(tx, nextStored, session.stored);
    if (outboxRecord) tx.objectStore('outbox').put(outboxRecord);
    if (historyRecord) tx.objectStore('history').put(historyRecord);
    if (receiptRecord) tx.objectStore('receiptOutbox').put(receiptRecord);
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
): Promise<void> {
  return commitMlsVaultAndRecords(session, nextGroupState, { outbox: item }, mutation);
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
  if (!ownsVaultMutation(session, mutation) || session.stored.unlockMethod !== 'platform' || !session.vault.pendingRecovery) {
    throw new Error('恢复完成操作没有有效的保险库事务');
  }
  const nextStored: StoredPlatformVault = { ...session.stored, payload: await encryptPayload(nextVault, session.key) };
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const stores = ['vault', 'history', 'restoredGallery', 'mediaChunks', 'outbox', 'receiptOutbox', 'uploads', 'preferences'];
    const tx = database.transaction(stores, 'readwrite');
    putCurrentVault(tx, nextStored, session.stored);
    for (const name of stores.slice(1)) {
      const store = tx.objectStore(name);
      const request = store.index('roomId').openKeyCursor(IDBKeyRange.only(nextVault.roomId));
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
}

export function loadOutbox(session: VaultSession): Promise<OutboxItem[]> {
  return loadLocalRecords<OutboxItem>(session, 'outbox');
}

export function deleteOutboxItem(session: VaultSession, clientMsgId: string, mutation?: VaultMutation): Promise<void> {
  return deleteLocalRecord(session, 'outbox', clientMsgId, mutation);
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
