import { gcm } from '@noble/ciphers/aes.js';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const purpose = 'quiet-room-composer-draft-v1';
const prefix = 'quiet-room:composer-draft:v1:';
export type DraftScope = { origin: string; spaceId: string; roomId: string; deviceId: string };
export type DraftSubmission = { revision: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function namespace(scope: DraftScope): string {
  return `${prefix}${encodeURIComponent(scope.spaceId)}:${encodeURIComponent(scope.roomId)}:${encodeURIComponent(scope.deviceId)}:`;
}

/** Ciphertext only. One unlock owns the writer lease; older tabs cannot publish into it. */
export class DraftCheckpoint {
  private readonly writer = crypto.randomUUID();
  private readonly base: string;
  private revision = crypto.randomUUID();
  private value: string;
  private disposed = false;
  constructor(private key: Uint8Array, private scope: DraftScope, private storage: Storage,
    fallback: string, committed?: DraftSubmission, reset = false) {
    this.base = namespace(scope);
    const previous = storage.getItem(`${this.base}owner`);
    this.value = fallback;
    if (previous !== null && !reset) {
      if (!uuid.test(previous)) throw new Error('本机草稿检查点已损坏');
      const raw = storage.getItem(`${this.base}${previous}`);
      if (!raw || raw.length > 32_000) throw new Error('本机草稿检查点已损坏');
      try {
        const sealed = JSON.parse(raw);
        if (sealed.v !== 1 || typeof sealed.iv !== 'string' || fromBase64Url(sealed.iv).length !== 12 || typeof sealed.ciphertext !== 'string') throw new Error();
        const bytes = gcm(key, fromBase64Url(sealed.iv), this.aad(previous)).decrypt(fromBase64Url(sealed.ciphertext));
        try {
          const data = JSON.parse(decoder.decode(bytes));
          if (typeof data.draft !== 'string' || data.draft.length > 4000 || typeof data.revision !== 'string' || !uuid.test(data.revision)) throw new Error();
          this.value = committed?.revision === data.revision ? '' : data.draft;
          this.revision = committed?.revision === data.revision ? crypto.randomUUID() : data.revision;
        } finally { bytes.fill(0); }
      } catch (cause) { throw new Error('本机草稿检查点已损坏，已停止恢复旧草稿', { cause }); }
    }
    // Prepare the replacement before publishing its owner. Failure leaves the
    // previous complete ciphertext readable, never an owner with no record.
    this.persist(this.value, this.revision);
    storage.setItem(`${this.base}owner`, this.writer);
    // Remove only the superseded owner, never a different tab's unpublished
    // replacement. A namespace-wide sweep could delete a concurrent claim.
    if (previous) storage.removeItem(`${this.base}${previous}`);
  }
  private aad(writer: string): Uint8Array {
    return encoder.encode(canonicalStringify({ purpose, ...this.scope, writer }));
  }
  private persist(draft: string, revision: string): void {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = encoder.encode(JSON.stringify({ draft, revision }));
    try {
      const ciphertext = gcm(this.key, iv, this.aad(this.writer)).encrypt(bytes);
      this.storage.setItem(`${this.base}${this.writer}`, JSON.stringify({ v: 1, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) }));
    } finally { bytes.fill(0); }
  }
  get draft(): string { return this.value; }
  write(draft: string): void {
    if (this.disposed || this.storage.getItem(`${this.base}owner`) !== this.writer) throw new Error('草稿已在其他窗口或清理流程中更新，请重新解锁');
    if (draft.length > 4000) throw new Error('草稿超过长度上限');
    if (draft === this.value) return;
    const revision = crypto.randomUUID();
    this.persist(draft, revision);
    this.value = draft; this.revision = revision;
  }
  submission(): DraftSubmission { return { revision: this.revision }; }
  dispose(): void { this.disposed = true; this.key.fill(0); this.value = ''; }
}

export async function openDraftCheckpoint(master: CryptoKey, scope: DraftScope, fallback: string,
  committed?: DraftSubmission, storage: Storage = localStorage, reset = false, isActive: () => boolean = () => true): Promise<DraftCheckpoint> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', master));
  let key: Uint8Array | undefined;
  try {
    const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
    key = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256',
      salt: encoder.encode(canonicalStringify(scope)), info: encoder.encode(purpose) }, material, 256));
    if (!isActive()) throw new DOMException('Draft runtime was replaced', 'AbortError');
    return new DraftCheckpoint(key, scope, storage, fallback, committed, reset);
  } catch (cause) { key?.fill(0); throw cause; }
  finally { raw.fill(0); }
}

/** Called only after the authoritative vault/data deletion has committed. */
export function clearDraftCheckpoints(spaceId: string, storage: Storage = localStorage): void {
  const start = `${prefix}${encodeURIComponent(spaceId)}:`;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) { const id = storage.key(i); if (id?.startsWith(start)) keys.push(id); }
  for (const id of keys) storage.removeItem(id);
}
