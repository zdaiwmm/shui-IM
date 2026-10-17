import { authorizedFetch, responseError } from './api';
import { canonicalStringify } from './canonical';
import { localSpaces } from './spaces';
import { saveVault, withVaultMutation, type VaultSession } from './vault';
import { sealPersonalDirectory, openPersonalDirectory, type PersonalDirectoryEntry, type PersonalDirectoryRecord } from './personal-directory';
import { signPersonalProof, validPersonalProof, type PersonalProof } from './personal-identity';
import { usePersonalIdentity, type StoredPersonalIdentity } from './personal-identity-vault';
import type { LocalCredentialResult } from './password-protection';
import { randomBase64Url } from './base64';
import { sha256 } from '@noble/hashes/sha2.js';
import { toBase64Url } from './base64';
import { verifyChamberHistoryHead, type ChamberHistoryHead } from './chamber-history-record';

const observed = new WeakMap<VaultSession, { fingerprint: string; at: number }>();
const readVersions=new Map<string,number>();
export const observedPersonalDirectoryVersion=(identityId:string,roomId:string)=>readVersions.get(`${identityId}:${roomId}`)??0;
export async function syncPersonalDirectory(session: VaultSession, signal: AbortSignal): Promise<void> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const vault = session.vault, own = vault.personalBinding;
  if (!own || vault.pairingState !== 'ready') return;
  const space = (await localSpaces(session)).find(item => item.roomId === vault.roomId);
  if (!space) throw new Error('本机空间目录尚未保存');
  const participants: PersonalDirectoryEntry['participants'] = [];
  for (const binding of vault.personalPeers ?? [own]) {
    const member = vault.members.find(member => member.deviceId === (binding === own ? vault.identity.publicBundle.deviceId : undefined)) ??
      vault.members.find(member => {
        const bundle = { deviceId: member.deviceId, encryptionKey: member.encryptionKey, signingKey: member.signingKey, ...(member.mlsKeyPackage ? { mlsKeyPackage: member.mlsKeyPackage } : {}) };
        return toBase64Url(sha256(new TextEncoder().encode(canonicalStringify(bundle)))) === binding.bundleHash;
      });
    if (!member) throw new Error('个人身份对应的原始设备绑定缺失');
    participants.push({ role: member.role, binding, bundle: { deviceId: member.deviceId, encryptionKey: member.encryptionKey, signingKey: member.signingKey, ...(member.mlsKeyPackage ? { mlsKeyPackage: member.mlsKeyPackage } : {}) } });
  }
  const heads: PersonalDirectoryEntry['heads'] = [];
  let cursor = 0;
  for (;;) {
    const response = await authorizedFetch(`/api/rooms/${vault.roomId}/chamber-history-heads?after=${cursor}`, vault.accessToken, { signal, cache: 'no-store' });
    const records = await response.json() as { cursor: number; record: ChamberHistoryHead }[];
    if (!Array.isArray(records) || records.length > 100) throw new Error('历史备份索引不正确');
    for (const item of records) {
      if (!Number.isSafeInteger(item.cursor) || item.cursor <= cursor || item.record.roomId !== vault.roomId || !await verifyChamberHistoryHead(item.record, own.identity)) throw new Error('历史备份索引签名不正确');
      cursor = item.cursor; heads.push(item.record.head);
      if (heads.length > 1000) throw new Error('历史备份索引超过安全范围');
    }
    if (records.length < 100) break;
  }
  if (vault.chamberBackup?.head && !heads.some(head => canonicalStringify(head) === canonicalStringify(vault.chamberBackup!.head))) throw new Error('历史备份索引缺失或被回滚，已停止覆盖目录');
  for(const pinned of vault.personalHistoryHeads??[]) {
    const current=heads.find(head=>head.deviceId===pinned.deviceId);
    if(!current || current.revision<pinned.revision || current.revision===pinned.revision && canonicalStringify(current)!==canonicalStringify(pinned))throw new Error('已确认的历史备份索引缺失或回滚，已停止覆盖目录');
  }
  const entry: PersonalDirectoryEntry = { v: 1, roomId: vault.roomId, role: vault.role, name: space.name, heads,
    trustedMembers:vault.members.map(m=>({deviceId:m.deviceId,encryptionKey:m.encryptionKey,signingKey:m.signingKey,mlsKeyPackage:m.mlsKeyPackage,role:m.role,
      status:m.status??'active',addedBy:m.addedBy??null,joinProof:m.joinProof??null,joinSeq:m.joinSeq??0,joinReceiptSeq:m.joinReceiptSeq??0})),
    ...(vault.chamberLifecycle?{lifecycle:vault.chamberLifecycle}:{}),
    ...(space.avatar ? { avatar: space.avatar } : {}), creatorFingerprint: vault.creatorFingerprint, participants };
  const fingerprint = canonicalStringify(entry), previous = observed.get(session);
  if (previous?.fingerprint === fingerprint && Date.now() - previous.at < 5 * 60_000) return;
  const url = `/api/rooms/${vault.roomId}/personal-directory`;
  const response = await authorizedFetch(url, vault.accessToken, { signal, cache: 'no-store' });
  const current = await response.json() as { revision: number };
  if (!Number.isSafeInteger(current.revision) || current.revision < (vault.personalDirectoryRevision ?? 0)) throw new Error('目录版本较本机记录更旧，已停止覆盖');
  const record = await sealPersonalDirectory(entry, current.revision + 1, vault.identity, own);
  await authorizedFetch(url, vault.accessToken, { method: 'PUT', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
  await withVaultMutation(session, async mutation => { signal.throwIfAborted(); vault.personalDirectoryRevision = record.revision; vault.personalHistoryHeads=heads; await saveVault(session, mutation); });
  observed.set(session, { fingerprint, at: Date.now() });
}

export async function personalChallenge(identityId: string, input: Pick<PersonalProof, 'action' | 'roomId' | 'deviceId' | 'version' | 'payloadHash'>, signal: AbortSignal): Promise<PersonalProof> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await fetch(`/api/chamber/identities/${identityId}/challenge`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw await responseError(response);
  const proof = await response.json() as PersonalProof;
  // A compromised challenge service must not turn a directory read into a
  // close/restore signature. Pin every locally chosen purpose and target.
  if(!validPersonalProof(proof,{id:identityId}) || Object.entries(input).some(([key,value])=>proof[key as keyof PersonalProof]!==value))throw new Error('身份验证请求的用途、目标或内容被替换');
  return proof;
}

export async function readOwnPersonalDirectory(stored: StoredPersonalIdentity, credential: LocalCredentialResult, signal: AbortSignal, minimumRevisions: ReadonlyMap<string,number> = new Map()): Promise<PersonalDirectoryEntry[]> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const proof = await personalChallenge(stored.identity.id, { action: 'read-directory', roomId: 'directory', deviceId: randomBase64Url(24), version: 1,
    payloadHash: toBase64Url(sha256(new TextEncoder().encode('chamber-read-own-directory-v1'))) }, signal);
  if (!validPersonalProof(proof, stored.identity) || proof.action !== 'read-directory' || proof.roomId !== 'directory') throw new Error('身份目录验证请求不正确');
  const signature = await usePersonalIdentity(stored, credential, entropy => signPersonalProof(entropy, proof));
  signal.throwIfAborted();
  const response = await fetch(`/api/chamber/identities/${stored.identity.id}/directory`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof, signature }), cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw await responseError(response);
  const records = await response.json() as PersonalDirectoryRecord[];
  if (!Array.isArray(records) || records.length > 256) throw new Error('身份目录超过安全处理范围');
  const entries: PersonalDirectoryEntry[] = [], seen = new Set<string>();
  for (const record of records) {
    signal.throwIfAborted();
    if (seen.has(record.roomId)) throw new Error('身份目录包含重复空间'); seen.add(record.roomId);
    entries.push(await usePersonalIdentity(stored, credential, entropy => openPersonalDirectory(record, stored.identity, entropy, minimumRevisions.get(record.roomId) ?? 0)));
    readVersions.set(`${stored.identity.id}:${record.roomId}`,record.revision);
  }
  return entries;
}
