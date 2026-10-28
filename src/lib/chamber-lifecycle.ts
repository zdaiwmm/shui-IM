import { uiLiteral } from './language';
import { canonicalStringify } from './canonical';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBase64Url, toBase64Url } from './base64';
import { authorizedFetch, responseError, getRoomState } from './api';
import { signPersonalProof, verifyPersonalProof, type PersonalProof } from './personal-identity';
import { usePersonalIdentity, type StoredPersonalIdentity } from './personal-identity-vault';
import type { LocalCredentialResult } from './password-protection';
import { bindPersonalDevice, verifyPersonalDeviceBinding, type PersonalDeviceBinding } from './personal-device-binding';
import { generateIdentity } from './crypto';
import { personalChallenge } from './personal-directory-sync';
import type { PersonalDirectoryEntry } from './personal-directory';
import { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup, verifyEcdsa } from './mls';
import { saveVault, withVaultMutation, type VaultSession } from './vault';
import type { PublicBundle, RoomMember, MlsWelcomeEnvelope, MlsVaultState } from './types';

const hash=(x:unknown)=>toBase64Url(sha256(new TextEncoder().encode(canonicalStringify(x))));
const same=(a:unknown,b:unknown)=>canonicalStringify(a)===canonicalStringify(b);
type Role='creator'|'joiner'; const roles:Role[]=['creator','joiner'];
type Signed<T>={payload:T;proof:PersonalProof;signature:string};
export type ChamberClosePayload={v:1;purpose:'chamber-close-v1';roomId:string;version:number;generation:number;closed:true};
export type ChamberLifecycle={version:number;generation:number;closed:boolean;receipt:Signed<ChamberClosePayload>|{proposal:ChamberReopenProposal;approvals:Record<Role,{proof:PersonalProof;signature:string}>}|null;
  pending?:{requestId:string;expiresAt:string;purpose?:string}|null};
export type ChamberReopenPayload={v:1;purpose:'chamber-reopen-offer-v1'|'chamber-recovery-offer-v1';roomId:string;requestId:string;role:Role;version:number;generation:number;
  bundle:PublicBundle;binding:PersonalDeviceBinding;tokenHash:string;deviceName:string;capabilities:string[]};
export type ChamberReopenOffer=Signed<ChamberReopenPayload>;
export type ChamberReopenProposal={v:1;purpose:'chamber-reopen-proposal-v1'|'chamber-recovery-proposal-v1';roomId:string;requestId:string;version:number;generation:number;expiresAt:string;
  offers:Record<Role,ChamberReopenOffer>;welcome:MlsWelcomeEnvelope};
export type ChamberReopenSnapshot={requestId:string;version:number;expiresAt:string;offers:Partial<Record<Role,ChamberReopenOffer>>;
  proposal:ChamberReopenProposal|null;approvals:Partial<Record<Role,{proof:PersonalProof;signature:string}>>;
  result:{eventSeq:number;nextSeq:number;nextReceiptSeq:number;completedAt:string;generation:number;version:number}|null};
export type PendingChamberReopen={entry:PersonalDirectoryEntry;offer:ChamberReopenOffer;proposal?:ChamberReopenProposal;mls?:MlsVaultState;approved?:boolean;cancelled?:true};

async function api<T>(roomId:string,token:string|undefined,action:string|undefined,signal:AbortSignal,input?:unknown):Promise<T> {
  const url=`/api/rooms/${roomId}/chamber-lifecycle`,options:RequestInit={signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),cache:'no-store',
    ...(action?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...(input?{input}:{})})}:{})};
  const response=token?await authorizedFetch(url,token,options):await fetch(url,{...options,credentials:'omit'});
  if(!response.ok)throw await responseError(response);return response.json();
}
const rootFor=(entry:PersonalDirectoryEntry,role:Role)=>entry.participants.find(p=>p.role===role)!.binding.identity;
/** Receipts remain verifiable after the one-time authorization deadline. Their
 * signed version is checked against the locally pinned lifecycle before use. */
export function verifyChamberClosure(value:ChamberLifecycle,entry:PersonalDirectoryEntry,minimumVersion=1):boolean {
  try {
    if(!value.closed || value.version<minimumVersion || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.generation) || value.generation<1 ||
      !value.receipt || !('payload' in value.receipt))return false;
    const {payload,proof,signature}=value.receipt,owner=entry.participants.find(p=>p.binding.identity.id===proof.identityId)?.binding.identity;
    return !!owner && Object.keys(payload).sort().join(',')==='closed,generation,purpose,roomId,v,version' && payload.v===1 && payload.purpose==='chamber-close-v1' &&
      payload.roomId===entry.roomId && payload.closed===true && payload.version===value.version-1 && payload.generation===value.generation &&
      proof.action==='close-room' && proof.roomId===entry.roomId && proof.version===payload.version && proof.payloadHash===hash(payload) &&
      verifyPersonalProof(owner,proof,signature,Date.parse(proof.expiresAt)-1);
  } catch{return false;}
}
export async function inspectChamber(entry:PersonalDirectoryEntry,stored:StoredPersonalIdentity,credential:LocalCredentialResult,signal:AbortSignal):Promise<ChamberLifecycle> {
  const proof=await personalChallenge(stored.identity.id,{action:'read-directory',roomId:entry.roomId,deviceId:randomBase64Url(24),version:1,payloadHash:hash({purpose:'chamber-inspect-v1',roomId:entry.roomId})},signal);
  const signature=await usePersonalIdentity(stored,credential,entropy=>signPersonalProof(entropy,proof));
  const result=await api<ChamberLifecycle>(entry.roomId,undefined,'inspect',signal,{proof,signature});
  if(result.version<(entry.lifecycle?.version??1)||result.generation<(entry.lifecycle?.generation??1))throw new Error(uiLiteral('密室生命周期较本人的已确认目录更旧'));
  if(result.closed&&!verifyChamberClosure(result,entry))throw new Error(uiLiteral('关闭密室的原参与者签名无法验证')); return result;
}
export const readChamberLifecycle=(session:VaultSession,signal:AbortSignal)=>api<ChamberLifecycle>(session.vault.roomId,session.vault.accessToken,undefined,signal);
export async function closeChamber(session:VaultSession,stored:StoredPersonalIdentity,entropy:Uint8Array,signal:AbortSignal):Promise<ChamberLifecycle> {
  const before=await readChamberLifecycle(session,signal);
  if(before.closed)return before;
  const payload:ChamberClosePayload={v:1,purpose:'chamber-close-v1',roomId:session.vault.roomId,version:before.version,generation:before.generation,closed:true};
  const proof=await personalChallenge(stored.identity.id,{action:'close-room',roomId:payload.roomId,deviceId:session.vault.identity.publicBundle.deviceId,version:payload.version,payloadHash:hash(payload)},signal);
  const signature=await signPersonalProof(entropy,proof),request={payload,proof,signature};
  // Retain the exact signed intent before any destructive server mutation.
  await withVaultMutation(session,async mutation=>{signal.throwIfAborted();session.vault.pendingChamberClose=request;await saveVault(session,mutation);});
  return api(session.vault.roomId,session.vault.accessToken,'close',signal,request);
}
export async function prepareChamberReopen(entry:PersonalDirectoryEntry,lifecycle:ChamberLifecycle,stored:StoredPersonalIdentity,credential:LocalCredentialResult,
  deviceName:string,capabilities:string[],signal:AbortSignal,joint=false) {
  const recover=!lifecycle.closed&&(joint||lifecycle.pending?.purpose==='chamber-recovery-offer-v1');
  if((!recover&&!verifyChamberClosure(lifecycle,entry)) || !same(rootFor(entry,entry.role),stored.identity))throw new Error(uiLiteral('此密室的状态或本人恢复验证不正确'));
  const identity=await generateIdentity();signal.throwIfAborted();
  const binding=await usePersonalIdentity(stored,credential,entropy=>bindPersonalDevice(entropy,identity)),accessToken=randomBase64Url(32);
  const payload:ChamberReopenPayload={v:1,purpose:recover?'chamber-recovery-offer-v1':'chamber-reopen-offer-v1',roomId:entry.roomId,requestId:lifecycle.pending?.requestId??crypto.randomUUID(),role:entry.role,
    version:lifecycle.version,generation:lifecycle.generation+1,bundle:identity.publicBundle,binding,tokenHash:toBase64Url(sha256(new TextEncoder().encode(accessToken))),deviceName,capabilities};
  const proof=await personalChallenge(stored.identity.id,{action:'restore-room',roomId:entry.roomId,deviceId:identity.publicBundle.deviceId,version:payload.version,payloadHash:hash(payload)},signal);
  const signature=await usePersonalIdentity(stored,credential,entropy=>signPersonalProof(entropy,proof));
  return {identity,binding,accessToken,pending:{entry,offer:{payload,proof,signature}} as PendingChamberReopen};
}
function members(snapshot:ChamberReopenSnapshot):RoomMember[] {
  return roles.map(role=>{const p=snapshot.offers[role]!.payload;return {...p.bundle,role,status:'active',joinProof:null,addedBy:null,
    deviceName:p.deviceName,capabilities:p.capabilities,joinSeq:snapshot.result?.nextSeq??0,joinReceiptSeq:snapshot.result?.nextReceiptSeq??0};});
}
export async function verifyChamberReopen(pending:PendingChamberReopen,snapshot:ChamberReopenSnapshot):Promise<void> {
  const own=pending.offer,entry=pending.entry;
  if(!['chamber-reopen-offer-v1','chamber-recovery-offer-v1'].includes(own.payload.purpose))throw new Error(uiLiteral('此申请类型已停用'));
  if(snapshot.requestId!==own.payload.requestId || snapshot.version!==own.payload.version || !same(snapshot.offers[entry.role],own) ||
    !Number.isFinite(Date.parse(snapshot.expiresAt)) || Date.parse(snapshot.expiresAt)>Date.parse(own.proof.expiresAt))throw new Error(uiLiteral('共同恢复申请发生变化'));
  for(const role of roles) {
    const offer=snapshot.offers[role];if(!offer)continue;const p=offer.payload,root=rootFor(entry,role);
    if(p.purpose!==own.payload.purpose || p.role!==role || p.roomId!==entry.roomId || p.requestId!==snapshot.requestId || p.version!==snapshot.version || p.generation!==own.payload.generation ||
      !same(p.binding.identity,root) || !await verifyPersonalDeviceBinding(p.binding,p.bundle) || offer.proof.action!=='restore-room' ||
      offer.proof.roomId!==entry.roomId || offer.proof.deviceId!==p.bundle.deviceId || offer.proof.version!==snapshot.version || offer.proof.payloadHash!==hash(p) ||
      !verifyPersonalProof(root,offer.proof,offer.signature,snapshot.result?Date.parse(snapshot.result.completedAt):Date.now()))throw new Error(uiLiteral('共同恢复参与者签名无法验证'));
  }
  if(snapshot.proposal) {
    const p=snapshot.proposal;
    if(p.v!==1 || p.purpose!==own.payload.purpose.replace('-offer-','-proposal-') ||
      p.roomId!==entry.roomId || p.requestId!==snapshot.requestId || p.version!==snapshot.version ||
      p.generation!==own.payload.generation || p.expiresAt!==snapshot.expiresAt || !same(p.offers,snapshot.offers) || !roles.every(role=>snapshot.offers[role]) ||
      p.welcome.senderId!==p.offers.creator.payload.bundle.deviceId || p.welcome.recipientId!==p.offers.joiner.payload.bundle.deviceId ||
      pending.proposal&&!same(pending.proposal,p) || !await verifyEcdsa(p.offers.creator.payload.bundle.signingKey,p.welcome.signature,((({signature:_,...unsigned})=>unsigned)(p.welcome))))throw new Error(uiLiteral('共同恢复聊天密钥提案无法验证'));
    for(const role of roles) {
      const approval=snapshot.approvals[role];if(!approval)continue;
      if(approval.proof.action!=='restore-room' || approval.proof.roomId!==entry.roomId || approval.proof.deviceId!==p.offers[role].payload.bundle.deviceId ||
        approval.proof.version!==snapshot.version || approval.proof.payloadHash!==hash(p) || !verifyPersonalProof(rootFor(entry,role),approval.proof,approval.signature,snapshot.result?Date.parse(snapshot.result.completedAt):Date.now()))throw new Error(uiLiteral('双方共同恢复批准无法验证'));
    }
  } else if(snapshot.result || Object.keys(snapshot.approvals).length)throw new Error(uiLiteral('共同恢复提案缺失'));
  if(snapshot.result&&(!roles.every(role=>snapshot.approvals[role]) || snapshot.result.generation!==own.payload.generation || snapshot.result.version!==snapshot.version+1 ||
    !Number.isSafeInteger(snapshot.result.eventSeq) || snapshot.result.eventSeq<1 || !Number.isSafeInteger(snapshot.result.nextSeq) || snapshot.result.nextSeq<0 ||
    !Number.isSafeInteger(snapshot.result.nextReceiptSeq) || snapshot.result.nextReceiptSeq<0))throw new Error(uiLiteral('共同恢复回执不正确'));
}
export async function advanceChamberReopen(session:VaultSession,signal:AbortSignal):Promise<ChamberReopenSnapshot> {
  const pending=session.vault.pendingChamberReopen;if(!pending)throw new Error(uiLiteral('本机共同恢复状态缺失'));
  if(!['chamber-reopen-offer-v1','chamber-recovery-offer-v1'].includes(pending.offer.payload.purpose))throw new Error(uiLiteral('此申请类型已停用'));
  if(pending.cancelled)throw new Error(uiLiteral('本次共同恢复已取消，请重新发起'));
  let snapshot:ChamberReopenSnapshot;
  try {snapshot=await api(session.vault.roomId,session.vault.accessToken,'status',signal);} catch {
    signal.throwIfAborted();snapshot=await api(session.vault.roomId,undefined,'offer',signal,pending.offer);
  }
  await verifyChamberReopen(pending,snapshot);
  if(roles.every(role=>snapshot.offers[role])) {
    if(session.vault.role==='creator'&&!snapshot.proposal&&!snapshot.result) {
      if(!pending.proposal) {
        const fresh={...session.vault,members:members(snapshot),mls:await createCreatorMlsState(session.vault.roomId,session.vault.identity,members(snapshot))};
        const mls=await prepareCreatorWelcome(fresh),proposal:ChamberReopenProposal={v:1,purpose:pending.offer.payload.purpose.replace('-offer-','-proposal-') as ChamberReopenProposal['purpose'],roomId:session.vault.roomId,
          requestId:snapshot.requestId,version:snapshot.version,generation:pending.offer.payload.generation,expiresAt:snapshot.expiresAt,offers:snapshot.offers as Record<Role,ChamberReopenOffer>,welcome:mls.pendingWelcome!};
        await withVaultMutation(session,async mutation=>{signal.throwIfAborted();pending.proposal=proposal;pending.mls=mls;await saveVault(session,mutation);});
      }
      snapshot=await api(session.vault.roomId,session.vault.accessToken,'propose',signal,pending.proposal);await verifyChamberReopen(pending,snapshot);
    }
    if(snapshot.proposal&&!pending.mls) {
      const mls=await joinMlsGroup({...session.vault,members:members(snapshot)},snapshot.proposal.welcome);
      await withVaultMutation(session,async mutation=>{signal.throwIfAborted();pending.proposal=snapshot.proposal!;pending.mls=mls;await saveVault(session,mutation);});
    }
  }
  return snapshot;
}
export async function approveChamberReopen(session:VaultSession,snapshot:ChamberReopenSnapshot,stored:StoredPersonalIdentity,credential:LocalCredentialResult,signal:AbortSignal) {
  const pending=session.vault.pendingChamberReopen;if(!pending?.mls || !snapshot.proposal)throw new Error(uiLiteral('请等待双方准备聊天密钥'));
  await verifyChamberReopen(pending,snapshot);
  const proof=await personalChallenge(stored.identity.id,{action:'restore-room',roomId:session.vault.roomId,deviceId:session.vault.identity.publicBundle.deviceId,
    version:snapshot.version,payloadHash:hash(snapshot.proposal)},signal);
  const signature=await usePersonalIdentity(stored,credential,entropy=>signPersonalProof(entropy,proof));
  await withVaultMutation(session,async mutation=>{signal.throwIfAborted();pending.approved=true;await saveVault(session,mutation);});
  return api<ChamberReopenSnapshot>(session.vault.roomId,session.vault.accessToken,'approve',signal,{proof,signature});
}
export async function completeChamberReopen(session:VaultSession,snapshot:ChamberReopenSnapshot,signal:AbortSignal):Promise<void> {
  const pending=session.vault.pendingChamberReopen;if(!pending?.mls || !pending.approved || !snapshot.result || !snapshot.proposal)throw new Error(uiLiteral('请先双方确认共同恢复'));
  await verifyChamberReopen(pending,snapshot);
  const state=await getRoomState(session.vault.roomId,session.vault.accessToken);signal.throwIfAborted();
  if(state.chamberLifecycle?.closed || state.chamberLifecycle?.generation!==snapshot.result.generation || state.chamberLifecycle?.version!==snapshot.result.version ||
    !same(state.chamberLifecycle.receipt,{proposal:snapshot.proposal,approvals:snapshot.approvals}))throw new Error(uiLiteral('共同恢复的状态回读签名不一致'));
  for(const role of roles) {const target=state.members.find(m=>m.deviceId===snapshot.offers[role]!.payload.bundle.deviceId);if(!target || target.status!=='active'||target.role!==role)throw new Error(uiLiteral('共同恢复设备回读不一致'));}
  await withVaultMutation(session,async mutation=> {
    signal.throwIfAborted();const before=session.vault;
    session.vault={...before,members:state.members,mls:{...pending.mls!,pendingWelcome:undefined,lastEventSeq:snapshot.result!.eventSeq},pairingState:'ready',
      lastSeq:snapshot.result!.nextSeq,lastReceiptSeq:snapshot.result!.nextReceiptSeq,historyUnavailableBeforeSeq:snapshot.result!.nextSeq,
      chamberLifecycle:state.chamberLifecycle??undefined,pendingChamberReopen:undefined,pendingChamberClose:undefined,chamberBackup:undefined,pendingChamberHistoryRecovery:undefined,chamberHistoryRestoreProgress:undefined};
    session.vault.identity.mlsPrivatePackage=undefined;
    try {await saveVault(session,mutation);}catch(cause){session.vault=before;throw cause;}
  });
}
export async function cancelChamberReopen(session:VaultSession,stored:StoredPersonalIdentity,credential:LocalCredentialResult,signal:AbortSignal):Promise<void> {
  const pending=session.vault.pendingChamberReopen;if(!pending)throw new Error(uiLiteral('本次申请状态缺失'));
  const payload={purpose:'chamber-recovery-cancel-v1',roomId:session.vault.roomId,requestId:pending.offer.payload.requestId,version:pending.offer.payload.version};
  const proof=await personalChallenge(stored.identity.id,{action:'restore-room',roomId:payload.roomId,deviceId:session.vault.identity.publicBundle.deviceId,version:payload.version,payloadHash:hash(payload)},signal);
  const signature=await usePersonalIdentity(stored,credential,entropy=>signPersonalProof(entropy,proof));
  await api(session.vault.roomId,session.vault.accessToken,'cancel',signal,{proof,signature});
  await withVaultMutation(session,async mutation=>{signal.throwIfAborted();pending.cancelled=true;await saveVault(session,mutation);});
}
