import { argon2id } from 'hash-wasm';
import { fromBase64Url, toBase64Url } from './base64';
import { createPlatformCredential, unlockPlatformCredential } from './platform-vault';
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
const DB_VERSION = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PLATFORM_PAYLOAD_AAD = encoder.encode('quiet-room-vault-payload-v2');

export type VaultSession = {
  vault: Vault;
  key: CryptoKey;
  stored: StoredVault;
};

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

type LocalStore = 'outbox' | 'receiptOutbox' | 'uploads';

type UnlockThrottle = {
  failures: number;
  nextAllowedAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('vault')) database.createObjectStore('vault');
      if (!database.objectStoreNames.contains('history')) {
        const history = database.createObjectStore('history', { keyPath: 'id' });
        history.createIndex('roomId', 'roomId', { unique: false });
      }
      for (const storeName of ['outbox', 'receiptOutbox', 'uploads'] as const) {
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
  storeName: 'vault' | 'history' | 'security' | LocalStore,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => {
      resolve(request.result);
      database.close();
    };
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
    isBoundedBase64(record.prfSalt, 20, 128) &&
    Array.isArray(record.transports) && record.transports.length <= 8 &&
    record.transports.every((transport) => typeof transport === 'string' && transport.length <= 32) &&
    (record.authenticatorAttachment === null || record.authenticatorAttachment === 'platform' || record.authenticatorAttachment === 'cross-platform') &&
    record.backupEligible === false &&
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
    stored.v === 2 && stored.unlockMethod === 'platform' && validateKdf(stored.kdf) &&
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
    stored.v === 2 && stored.unlockMethod === 'recovery' &&
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

function wrapperAad(platform: PlatformCredentialRecord): Uint8Array<ArrayBuffer> {
  return encoder.encode(`quiet-room-master-key-v2:${platform.credentialId}`);
}

async function encryptPayload(vault: Vault, key: CryptoKey): Promise<StoredPlatformVault['payload']> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: PLATFORM_PAYLOAD_AAD, tagLength: 128 },
    key,
    encoder.encode(JSON.stringify({ ...vault, v: 2 })),
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
  if ((vault.v !== 1 && vault.v !== 2) || !vault.roomId || !vault.identity?.publicBundle?.deviceId) {
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
    { name: 'AES-GCM', iv, additionalData: wrapperAad(platform), tagLength: 128 },
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
      additionalData: wrapperAad(stored.platform),
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
  return Boolean(await transaction('vault', 'readonly', (store) => store.get('current')));
}

export async function readStoredVault(): Promise<StoredVault | null> {
  const value: unknown = await transaction('vault', 'readonly', (store) => store.get('current'));
  return validateStoredVault(value) ? value : null;
}

export async function deleteCurrentVault(): Promise<void> {
  await transaction('vault', 'readwrite', (store) => store.delete('current'));
}

export async function createVault(
  vault: Vault,
  gestureSecret: string,
  unlockMethod: 'password' | 'gesture' = 'gesture',
): Promise<VaultSession> {
  if (unlockMethod === 'password') {
    const { bytes, kdf } = await deriveGestureBytes(gestureSecret);
    const key = await importMasterKey(bytes);
    bytes.fill(0);
    const stored = await encryptLegacyVault(vault, key, kdf, 'password');
    await transaction('vault', 'readwrite', (store) => store.put(stored, 'current'));
    await clearUnlockThrottle();
    return { vault, key, stored };
  }
  const [{ bytes: gestureBytes, kdf }, platformResult] = await Promise.all([
    deriveGestureBytes(gestureSecret),
    createPlatformCredential(),
  ]);
  const kek = await derivePlatformKek(platformResult.prfOutput, gestureBytes);
  const masterBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await importMasterKey(masterBytes);
  const stored: StoredPlatformVault = {
    v: 2,
    unlockMethod: 'platform',
    kdf,
    platform: platformResult.record,
    wrappedKey: await wrapMasterKey(masterBytes, kek, platformResult.record),
    payload: await encryptPayload(vault, key),
  };
  masterBytes.fill(0);
  await transaction('vault', 'readwrite', (store) => store.put(stored, 'current'));
  await clearUnlockThrottle();
  vault.v = 2;
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

function isUserCancellation(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

async function enforceUnlockThrottle(): Promise<void> {
  const throttle = await readUnlockThrottle();
  const waitMs = throttle.nextAllowedAt - Date.now();
  if (waitMs > 0) throw new Error(`尝试次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
}

export async function unlockVault(secret: string): Promise<VaultSession> {
  const stored = await readStoredVault();
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
      const { bytes: gestureBytes } = await deriveGestureBytes(secret, stored.kdf);
      const prfOutput = await unlockPlatformCredential(stored.platform);
      const kek = await derivePlatformKek(prfOutput, gestureBytes);
      const masterBytes = await unwrapMasterKey(stored, kek);
      const key = await importMasterKey(masterBytes);
      masterBytes.fill(0);
      unlocked = { vault: await decryptPayload(stored.payload, key), key, stored };
    }
    await clearUnlockThrottle();
    return unlocked;
  } catch (error) {
    if (isUserCancellation(error)) throw new Error('未完成设备安全验证');
    await recordUnlockFailure().catch(() => undefined);
    throw new Error(stored.v === 2
      ? '手势、设备安全凭据不正确，或本机保险库已经损坏'
      : stored.unlockMethod === 'gesture'
        ? '手势不正确，或本机保险库已经损坏'
        : '密码不正确，或本机保险库已经损坏');
  }
}

export async function saveVault(session: VaultSession): Promise<void> {
  if (session.stored.unlockMethod === 'recovery') throw new Error('恢复保险库尚未绑定到本设备');
  if (session.stored.v === 1) {
    session.stored = await encryptLegacyVault(
      session.vault,
      session.key,
      session.stored.kdf,
      session.stored.unlockMethod ?? 'password',
    );
  } else {
    session.stored = { ...session.stored, payload: await encryptPayload(session.vault, session.key) };
  }
  await transaction('vault', 'readwrite', (store) => store.put(session.stored, 'current'));
}

async function reencryptAllLocalData(session: VaultSession, migratedSession: VaultSession): Promise<void> {
  const [history, outbox, pendingReceipts, uploadPlans] = await Promise.all([
    loadHistory(session),
    loadOutbox(session),
    loadPendingReceipts(session),
    loadUploadPlans(session),
  ]);
  const [historyRecords, outboxRecords, receiptRecords, uploadRecords] = await Promise.all([
    Promise.all(history.map((message) => encryptHistoryRecord(migratedSession, message))),
    Promise.all(outbox.map((item) => encryptLocalRecord(migratedSession, 'outbox', item.clientMsgId, item))),
    Promise.all(pendingReceipts.map((receipt) =>
      encryptLocalRecord(migratedSession, 'receiptOutbox', receipt.clientMsgId, receipt))),
    Promise.all(uploadPlans.map((plan) => encryptLocalRecord(migratedSession, 'uploads', plan.blobId, plan))),
  ]);

  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['vault', 'history', 'outbox', 'receiptOutbox', 'uploads'], 'readwrite');
    tx.objectStore('vault').put(migratedSession.stored, 'current');
    for (const record of historyRecords) tx.objectStore('history').put(record);
    for (const record of outboxRecords) tx.objectStore('outbox').put(record);
    for (const record of receiptRecords) tx.objectStore('receiptOutbox').put(record);
    for (const record of uploadRecords) tx.objectStore('uploads').put(record);
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

export async function migrateVaultToPlatform(session: VaultSession, gestureSecret: string): Promise<void> {
  if (session.stored.v !== 1) return;
  const [{ bytes: gestureBytes, kdf }, platformResult] = await Promise.all([
    deriveGestureBytes(gestureSecret),
    createPlatformCredential(),
  ]);
  const kek = await derivePlatformKek(platformResult.prfOutput, gestureBytes);
  const masterBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await importMasterKey(masterBytes);
  session.vault.v = 2;
  const stored: StoredPlatformVault = {
    v: 2,
    unlockMethod: 'platform',
    kdf,
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

export const migrateVaultToGesture = migrateVaultToPlatform;

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

export async function downloadRecoveryPackage(session: VaultSession): Promise<RecoveryExport> {
  if (session.stored.v !== 2 || session.stored.unlockMethod !== 'platform') {
    throw new Error('请先完成设备保险库升级');
  }
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
      additionalData: encoder.encode(`quiet-room-recovery-v2:${exportedAt}`),
      tagLength: 128,
    },
    kek,
    masterBytes,
  );
  masterBytes.fill(0);
  const body = JSON.stringify({
    format: 'quiet-room-recovery',
    version: 2,
    exportedAt,
    payload: session.stored.payload,
    recovery: {
      salt: toBase64Url(salt),
      iv: toBase64Url(iv),
      ciphertext: toBase64Url(ciphertext),
    },
  }, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `quiet-room-recovery-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { exportedAt, recoveryCode: displayCode };
}

export async function importRecoveryPackage(file: File): Promise<void> {
  const parsed: unknown = JSON.parse(await file.text());
  if (!parsed || typeof parsed !== 'object') throw new Error('恢复包格式不正确');
  const record = parsed as Record<string, unknown>;
  if (record.format !== 'quiet-room-recovery') throw new Error('这不是有效的 Quiet Room 恢复包');
  if (record.version === 2) {
    const stored: StoredRecoveryVault = {
      v: 2,
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
  const stored = await readStoredVault();
  if (!stored || stored.unlockMethod !== 'recovery') throw new Error('本机没有等待恢复的保险库');
  await enforceUnlockThrottle();
  try {
    const codeBytes = parseRecoveryCode(recoveryCode);
    const kek = await recoveryKek(codeBytes, fromBase64Url(stored.recovery.salt));
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(stored.recovery.iv),
        additionalData: encoder.encode(`quiet-room-recovery-v2:${stored.exportedAt}`),
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

export async function bindRecoveredVaultToPlatform(session: VaultSession, gestureSecret: string): Promise<void> {
  if (session.stored.unlockMethod !== 'recovery') throw new Error('当前保险库不需要重新绑定');
  const [{ bytes: gestureBytes, kdf }, platformResult] = await Promise.all([
    deriveGestureBytes(gestureSecret),
    createPlatformCredential(),
  ]);
  const kek = await derivePlatformKek(platformResult.prfOutput, gestureBytes);
  const masterBytes = new Uint8Array(await crypto.subtle.exportKey('raw', session.key));
  session.vault.v = 2;
  const stored: StoredPlatformVault = {
    v: 2,
    unlockMethod: 'platform',
    kdf,
    platform: platformResult.record,
    wrappedKey: await wrapMasterKey(masterBytes, kek, platformResult.record),
    payload: await encryptPayload(session.vault, session.key),
  };
  masterBytes.fill(0);
  await transaction('vault', 'readwrite', (store) => store.put(stored, 'current'));
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

export async function saveHistoryMessage(session: VaultSession, message: DecryptedMessage): Promise<void> {
  const record = await encryptHistoryRecord(session, message);
  await transaction('history', 'readwrite', (store) => store.put(record));
}

export async function loadHistory(session: VaultSession): Promise<DecryptedMessage[]> {
  const records = await transaction<StoredHistory[]>('history', 'readonly', (store) =>
    store.index('roomId').getAll(IDBKeyRange.only(session.vault.roomId)),
  );
  const messages: DecryptedMessage[] = [];
  for (const record of records.sort((left, right) => left.seq - right.seq)) {
    try {
      const additionalData = encoder.encode(`quiet-room-history-v1:${record.roomId}:${record.seq}`);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(record.iv), additionalData, tagLength: 128 },
        session.key,
        fromBase64Url(record.ciphertext),
      );
      messages.push(JSON.parse(decoder.decode(plaintext)) as DecryptedMessage);
    } catch {
      // A corrupt cache row is ignored; signed ciphertext can be fetched again when the protocol permits it.
    }
  }
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
): Promise<void> {
  const record = await encryptLocalRecord(session, storeName, id, value);
  await transaction(storeName, 'readwrite', (store) => store.put(record));
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

async function deleteLocalRecord(session: VaultSession, storeName: LocalStore, id: string): Promise<void> {
  await transaction(storeName, 'readwrite', (store) => store.delete(`${session.vault.roomId}:${id}`));
}

export function saveOutboxItem(session: VaultSession, item: OutboxItem): Promise<void> {
  return putLocalRecord(session, 'outbox', item.clientMsgId, item);
}

async function commitMlsVaultAndRecords(
  session: VaultSession,
  nextGroupState: string,
  records: { outbox?: OutboxItem; history?: DecryptedMessage; pendingReceipt?: DeliveryReceipt },
): Promise<void> {
  if (session.stored.v !== 2 || session.stored.unlockMethod !== 'platform' || !session.vault.mls) {
    throw new Error('MLS 状态只能写入设备绑定保险库');
  }
  const nextVault = structuredClone(session.vault);
  if (!nextVault.mls) throw new Error('MLS 本机状态不存在');
  nextVault.mls.groupState = nextGroupState;
  const nextStored: StoredPlatformVault = {
    ...session.stored,
    payload: await encryptPayload(nextVault, session.key),
  };
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
    tx.objectStore('vault').put(nextStored, 'current');
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
): Promise<void> {
  return commitMlsVaultAndRecords(session, nextGroupState, { outbox: item });
}

export function commitMlsReceive(
  session: VaultSession,
  message: DecryptedMessage,
  nextGroupState: string,
  pendingReceipt?: DeliveryReceipt,
): Promise<void> {
  return commitMlsVaultAndRecords(session, nextGroupState, { history: message, pendingReceipt });
}

export function loadOutbox(session: VaultSession): Promise<OutboxItem[]> {
  return loadLocalRecords<OutboxItem>(session, 'outbox');
}

export function deleteOutboxItem(session: VaultSession, clientMsgId: string): Promise<void> {
  return deleteLocalRecord(session, 'outbox', clientMsgId);
}

export function savePendingReceipt(session: VaultSession, receipt: DeliveryReceipt): Promise<void> {
  return putLocalRecord(session, 'receiptOutbox', receipt.clientMsgId, receipt);
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
