import {authorizedFetch} from './api';
import {canonicalStringify} from './canonical';
import {sha256} from '@noble/hashes/sha2.js';
import {toBase64Url} from './base64';
import {verifyPersonalDeviceBinding,type PersonalDeviceBinding} from './personal-device-binding';
import {usePersonalIdentity,type StoredPersonalIdentity} from './personal-identity-vault';
import {signPersonalProof,type PersonalProof} from './personal-identity';
import {personalChallenge} from './personal-directory-sync';
import {saveVault,withVaultMutation,type VaultSession} from './vault';
import type {LocalCredentialResult} from './password-protection';
import type {ChamberHistoryRequest} from './chamber-history-recovery';
export type ChamberMigrationVerification={payload:{v:1;purpose:'chamber-migration-verification-v1';roomId:string;ownerId:string;targetId:string;generation:number;historyRequestId:string;scopeHash:string;upperSeq:number;stagingDigest?:string};proof:PersonalProof;signature:string};
export type ChamberMigrationStatus={bindings:Partial<Record<'creator'|'joiner',PersonalDeviceBinding>>;verified:Partial<Record<'creator'|'joiner',ChamberMigrationVerification>>;activated:boolean};
const hash=(value:unknown)=>toBase64Url(sha256(new TextEncoder().encode(canonicalStringify(value))));
export async function chamberMigrationStatus(session:VaultSession,signal:AbortSignal,body?:unknown):Promise<ChamberMigrationStatus> {
  const response=await authorizedFetch(`/api/rooms/${session.vault.roomId}/chamber-migration`,session.vault.accessToken,{signal,cache:'no-store',
    ...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});return response.json();
}
export async function bindLegacyChamber(session:VaultSession,binding:PersonalDeviceBinding,signal:AbortSignal):Promise<ChamberMigrationStatus> {
  // Own intent is durable before submission. Existing device keys/old restore
  // remain usable until a separate, jointly signed fresh-generation cutover.
  await withVaultMutation(session,async mutation=>{signal.throwIfAborted();session.vault.personalMigration={state:'staged',binding};await saveVault(session,mutation);});
  const status=await chamberMigrationStatus(session,signal,{action:'bind',binding});
  await adoptLegacyBindings(session,status,signal);return status;
}
export async function adoptLegacyBindings(session:VaultSession,status:ChamberMigrationStatus,signal:AbortSignal):Promise<void> {
  if(!status.bindings.creator || !status.bindings.joiner || !session.vault.personalMigration)return;
  const own=status.bindings[session.vault.role];if(own?.identity.id!==session.vault.personalMigration.binding.identity.id)throw new Error('本人迁移身份发生变化');
  for(const role of ['creator','joiner'] as const) {
    const binding=status.bindings[role]!,member=session.vault.members.find(m=>m.role===role&&m.status==='active'&&hash({deviceId:m.deviceId,encryptionKey:m.encryptionKey,signingKey:m.signingKey,mlsKeyPackage:m.mlsKeyPackage})===binding.bundleHash);
    if(!member || !await verifyPersonalDeviceBinding(binding,{deviceId:member.deviceId,encryptionKey:member.encryptionKey,signingKey:member.signingKey,mlsKeyPackage:member.mlsKeyPackage}))throw new Error('迁移身份未绑定到已经验证的聊天设备');
  }
  await withVaultMutation(session,async mutation=>{signal.throwIfAborted();session.vault.personalBinding=session.vault.personalMigration!.binding;session.vault.personalPeers=[status.bindings.creator!,status.bindings.joiner!];await saveVault(session,mutation);});
}
export async function verifyMigratedHistory(session:VaultSession,request:ChamberHistoryRequest,stored:StoredPersonalIdentity,credential:LocalCredentialResult,signal:AbortSignal,stagingDigest?:string):Promise<void> {
  const current=await chamberMigrationStatus(session,signal);
  if(current.activated || !current.bindings.creator || !current.bindings.joiner || session.vault.personalMigration&&!stagingDigest || request.scope.scope!==(session.vault.role==='creator'?'all':'chat'))return;
  const payload={v:1,purpose:'chamber-migration-verification-v1',roomId:session.vault.roomId,ownerId:stored.identity.id,targetId:session.vault.identity.publicBundle.deviceId,
    generation:request.scope.generation,historyRequestId:request.proof.requestId,scopeHash:request.proof.payloadHash,upperSeq:Math.max(...request.scope.heads.map(h=>h.upperSeq)),...(stagingDigest?{stagingDigest}:{})};
  const proof=await personalChallenge(stored.identity.id,{action:'bind-legacy-room',roomId:session.vault.roomId,deviceId:payload.targetId,version:1,payloadHash:hash(payload)},signal);
  const signature=await usePersonalIdentity(stored,credential,entropy=>signPersonalProof(entropy,proof));
  await chamberMigrationStatus(session,signal,{action:'verify',input:{payload,proof,signature}});
}
