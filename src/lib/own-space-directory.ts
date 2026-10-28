import { uiLiteral } from './language';
import { canonicalStringify } from './canonical';
import { fromBase64Url, toBase64Url } from './base64';
import { openJson, sealJson } from './backup-crypto';
import { authorizedFetch } from './api';
import { localSpaces, spaceCapability, spaceCodeId, type PrivateSpace } from './spaces';
import { validSpaceAvatar } from './space-avatar';
import { readLocalSpaceDirectory, writeLocalSpaceDirectory, withVaultMutation, type VaultSession } from './vault';
import type { RoomMember, Vault } from './types';

export type OwnSpaceRecord = Pick<PrivateSpace, 'roomId' | 'name' | 'avatar' | 'createdAt' | 'waiting'> & {
  revision: number; writer: string; removed: boolean;
};
type Directory = { v: 1; writer: string; clock: number; entries: OwnSpaceRecord[] };
export type OwnEnvelope = { v: 1; purpose: 'quiet-room-own-directory-v1' | 'quiet-room-own-admission-v1'; roomId: string; senderId: string; recipientId: string;
  revision: number; iv: string; ciphertext: string; signature: string };
const purpose = 'quiet-room-own-directory-v1' as const;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
// Only content digests live here; abort removes the transport's memo, including
// auxiliary sessions opened with the same authenticated browser runtime.
const sent = new Map<string, Map<string, string>>();

export function validOwnSpaceRecords(value: unknown): value is OwnSpaceRecord[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  const ids = new Set<string>();
  return value.every(entry => {
    if (!entry || Object.keys(entry).some(key => !['roomId','name','avatar','createdAt','waiting','revision','writer','removed'].includes(key)) ||
      !uuid.test(entry.roomId) || ids.has(entry.roomId) || typeof entry.name !== 'string' || !entry.name.trim() || Array.from(entry.name).length > 40 ||
      !Number.isSafeInteger(entry.revision) || entry.revision < 1 || entry.revision >= Number.MAX_SAFE_INTEGER || !uuid.test(entry.writer) ||
      typeof entry.removed !== 'boolean' || entry.avatar !== undefined && !validSpaceAvatar(entry.avatar) ||
      entry.createdAt !== undefined && (typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) ||
      entry.waiting !== undefined && typeof entry.waiting !== 'boolean') return false;
    ids.add(entry.roomId); return true;
  });
}

/** Logical revisions converge without clock assumptions. Retain removal records
 * so an offline endpoint cannot resurrect an entry with an older snapshot. */
export function mergeOwnSpaceRecords(left: OwnSpaceRecord[], right: OwnSpaceRecord[]): OwnSpaceRecord[] {
  if (!validOwnSpaceRecords(left) || !validOwnSpaceRecords(right)) throw new Error(uiLiteral('本人密室目录不完整'));
  const entries = new Map(left.map(entry => [entry.roomId, entry]));
  for (const entry of right) {
    const previous = entries.get(entry.roomId);
    if (!previous || entry.revision > previous.revision || entry.revision === previous.revision && entry.writer > previous.writer) entries.set(entry.roomId, entry);
    else if (entry.revision === previous.revision && entry.writer === previous.writer && canonicalStringify(entry) !== canonicalStringify(previous)) throw new Error(uiLiteral('本人密室目录版本冲突'));
  }
  if (entries.size > 256) throw new Error(uiLiteral('本人密室目录超过上限'));
  return [...entries.values()].sort((a,b) => a.roomId.localeCompare(b.roomId));
}

const localId = (session: VaultSession) => `own-directory:${spaceCodeId(session.vault.spaceRecoveryCode!)}`;
async function read(session: VaultSession): Promise<Directory> {
  const sealed = await readLocalSpaceDirectory(localId(session));
  if (!sealed) return { v: 1, writer: crypto.randomUUID(), clock: 0, entries: [] };
  const state = await openJson(sealed as Parameters<typeof openJson>[0], await spaceCapability(session.vault.spaceRecoveryCode!, 'encryption'), localId(session)) as Directory;
  if (state?.v !== 1 || !uuid.test(state.writer) || !Number.isSafeInteger(state.clock) || state.clock < 0 ||
    !validOwnSpaceRecords(state.entries) || state.entries.some(entry => entry.revision > state.clock)) throw new Error(uiLiteral('本人密室目录校验失败'));
  return state;
}
async function update(session: VaultSession, apply: (state: Directory) => void, signal?: AbortSignal): Promise<Directory> {
  const spaces = await localSpaces(session);
  return withVaultMutation(session, async mutation => {
    signal?.throwIfAborted();
    const state = await read(session);
    const before = canonicalStringify(state);
    for (const space of spaces.filter(space => space.roomArchiveV2)) {
      if (!state.entries.some(entry => entry.roomId === space.roomId)) state.entries.push(record(space, ++state.clock, state.writer));
    }
    apply(state);
    if (!validOwnSpaceRecords(state.entries)) throw new Error(uiLiteral('本人密室目录超过上限'));
    signal?.throwIfAborted();
    if (canonicalStringify(state) !== before) await writeLocalSpaceDirectory(session, localId(session), await sealJson(state,
      await spaceCapability(session.vault.spaceRecoveryCode!, 'encryption'), localId(session)), mutation);
    return state;
  });
}
function record(space: PrivateSpace, revision: number, writer: string, removed = false): OwnSpaceRecord {
  return { roomId: space.roomId, name: space.name, ...(space.avatar ? { avatar: space.avatar } : {}),
    ...(space.createdAt ? { createdAt: space.createdAt } : {}), ...(space.waiting !== undefined ? { waiting: space.waiting } : {}), revision, writer, removed };
}
export async function changeOwnSpace(session: VaultSession, space: PrivateSpace, removed = false): Promise<void> {
  await update(session, state => {
    state.clock = Math.max(state.clock, ...state.entries.map(entry => entry.revision)) + 1;
    state.entries = state.entries.filter(entry => entry.roomId !== space.roomId);
    state.entries.push(record(space, state.clock, state.writer, removed));
  });
}
export async function ownDirectorySpaces(session: VaultSession, additional: PrivateSpace[] = []): Promise<PrivateSpace[]> {
  const local = await localSpaces(session);
  for (const space of additional) if (!local.some(item => item.roomId === space.roomId)) local.push(space);
  if (!session.vault.roomArchiveV2) return local;
  const state = await update(session, () => {});
  const result = local.filter(space => !state.entries.find(entry => entry.roomId === space.roomId)?.removed);
  for (const entry of state.entries.filter(entry => !entry.removed)) {
    const space = result.find(space => space.roomId === entry.roomId);
    if (space) { space.name = entry.name; space.avatar = entry.avatar; space.roomArchiveV2 = true; }
    else result.push({ roomId: entry.roomId, name: entry.name, avatar: entry.avatar, createdAt: entry.createdAt,
      waiting: entry.waiting, roomArchiveV2: true, chamber: true, catalogOnly: true });
  }
  return result;
}

function header(envelope: Omit<OwnEnvelope, 'iv' | 'ciphertext' | 'signature'>) {
  return { v: envelope.v, purpose: envelope.purpose, roomId: envelope.roomId, senderId: envelope.senderId, recipientId: envelope.recipientId, revision: envelope.revision };
}
async function pairKey(vault: Vault, peer: RoomMember, context: ReturnType<typeof header>): Promise<CryptoKey> {
  const privateKey = await crypto.subtle.importKey('jwk', vault.identity.encryptionPrivateKey, {name:'ECDH',namedCurve:'P-256'}, false, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('jwk', peer.encryptionKey, {name:'ECDH',namedCurve:'P-256'}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},privateKey,256));
  try {
    const material = await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);
    return await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(vault.roomId),info:encoder.encode(canonicalStringify(context))},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  } finally { shared.fill(0); }
}
export async function sealOwnDirectory(vault: Vault, target: RoomMember, entries: OwnSpaceRecord[], revision: number): Promise<OwnEnvelope> {
  if (!validOwnSpaceRecords(entries) || target.role !== vault.role || target.status !== 'active' || target.deviceId === vault.identity.publicBundle.deviceId) throw new Error(uiLiteral('本人目录设备不正确'));
  return sealOwnEnvelope(vault,target,{v:1,entries},revision,purpose);
}
export async function sealOwnEnvelope(vault: Vault,target: RoomMember,data: unknown,revision: number,mailPurpose: OwnEnvelope['purpose']): Promise<OwnEnvelope> {
  if (target.role !== vault.role || target.status !== 'active' || target.deviceId === vault.identity.publicBundle.deviceId) throw new Error(uiLiteral('本人设备不正确'));
  const context = header({v:1,purpose:mailPurpose,roomId:vault.roomId,senderId:vault.identity.publicBundle.deviceId,recipientId:target.deviceId,revision});
  const iv = crypto.getRandomValues(new Uint8Array(12)), raw = encoder.encode(JSON.stringify(data));
  try {
    const unsigned = {...context,iv:toBase64Url(iv),ciphertext:toBase64Url(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(canonicalStringify(context))},await pairKey(vault,target,context),raw))};
    const key = await crypto.subtle.importKey('jwk',vault.identity.signingPrivateKey,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
    return {...unsigned,signature:toBase64Url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(canonicalStringify(unsigned))))};
  } finally { raw.fill(0); }
}
export async function openOwnDirectory(vault: Vault, envelope: OwnEnvelope): Promise<OwnSpaceRecord[]> {
  const data = await openOwnEnvelope(vault,envelope,purpose) as {v:number;entries:OwnSpaceRecord[]};
  if (data?.v !== 1 || Object.keys(data).sort().join(',') !== 'entries,v' || !validOwnSpaceRecords(data.entries)) throw new Error(uiLiteral('本人目录内容不正确'));
  return data.entries;
}
export async function openOwnEnvelope(vault: Vault,envelope: OwnEnvelope,mailPurpose: OwnEnvelope['purpose']): Promise<unknown> {
  const peer = vault.members.find(member => member.deviceId === envelope.senderId);
  if (!peer || peer.role !== vault.role || peer.status !== 'active' || envelope.purpose !== mailPurpose || envelope.v !== 1 ||
    envelope.roomId !== vault.roomId || envelope.recipientId !== vault.identity.publicBundle.deviceId || envelope.senderId === envelope.recipientId ||
    !Number.isSafeInteger(envelope.revision) || envelope.revision < 1 || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 2 * 1024 ** 2 ||
    Object.keys(envelope).sort().join(',') !== 'ciphertext,iv,purpose,recipientId,revision,roomId,senderId,signature,v') throw new Error(uiLiteral('本人目录来源未通过验证'));
  const {signature,...unsigned} = envelope;
  const key = await crypto.subtle.importKey('jwk',peer.signingKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  if (!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,fromBase64Url(signature),encoder.encode(canonicalStringify(unsigned)))) throw new Error(uiLiteral('本人目录签名不正确'));
  const context = header(envelope);
  const raw = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64Url(envelope.iv),additionalData:encoder.encode(canonicalStringify(context))},await pairKey(vault,peer,context),fromBase64Url(envelope.ciphertext)));
  try {
    return JSON.parse(decoder.decode(raw));
  } finally { raw.fill(0); }
}
/** Only metadata crosses these pairwise envelopes. A discovered room still
 * requires its independent device enrollment and original history boundary. */
export async function syncOwnSpaceDirectory(session: VaultSession, signal: AbortSignal): Promise<void> {
  if (!session.vault.roomArchiveV2 || session.vault.pairingState !== 'ready') return;
  const peers = session.vault.members.filter(member => member.deviceId !== session.vault.identity.publicBundle.deviceId && member.role === session.vault.role && member.status === 'active');
  if (!peers.length) return;
  const url = `/api/rooms/${session.vault.roomId}/own-directory`;
  const options = {signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]),cache:'no-store' as const};
  const data = await (await authorizedFetch(url,session.vault.accessToken,options)).json() as {incoming:OwnEnvelope[];outgoing:{recipientId:string;revision:number}[]};
  if (!Array.isArray(data.incoming) || data.incoming.length > 2 || !Array.isArray(data.outgoing) || data.outgoing.length > 2) throw new Error(uiLiteral('本人目录设备数不正确'));
  let incoming:OwnSpaceRecord[] = [];
  for (const envelope of data.incoming) incoming = mergeOwnSpaceRecords(incoming,await openOwnDirectory(session.vault,envelope));
  const state = await update(session,state => {
    state.entries = mergeOwnSpaceRecords(state.entries,incoming);
    state.clock = Math.max(state.clock,...state.entries.map(entry => entry.revision));
  },signal);
  const fingerprint = toBase64Url(await crypto.subtle.digest('SHA-256',encoder.encode(canonicalStringify(state.entries))));
  const transport = `${session.vault.roomId}:${session.vault.identity.publicBundle.deviceId}`;
  let memo = sent.get(transport);
  if (!memo) { memo = new Map<string,string>(); sent.set(transport,memo); signal.addEventListener('abort', () => sent.delete(transport), {once:true}); }
  for (const peer of peers) {
    const previous = data.outgoing.find(item => item.recipientId === peer.deviceId)?.revision ?? 0;
    if (previous > 0 && memo.get(peer.deviceId) === fingerprint) continue;
    signal.throwIfAborted();
    const envelope = await sealOwnDirectory(session.vault,peer,state.entries,Math.max(state.clock,previous + 1));
    await authorizedFetch(url,session.vault.accessToken,{...options,method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope)});
    memo.set(peer.deviceId,fingerprint);
  }
}
