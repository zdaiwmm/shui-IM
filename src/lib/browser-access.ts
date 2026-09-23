import { fromBase64Url, toBase64Url } from './base64';
import { openJson, sealJson, randomBackupSecret } from './backup-crypto';
import type { SealedBackup } from './backup-types';
import { browserAccessPrfSalt, type PlatformCredentialResult } from './platform-vault';
import { accessDigest, newAccessIdentity, signAccess, verifyAccess, publicAccessKey, type AccessIdentity, type AccessCertificate, type AccessGrant, type AccessProof } from './browser-access-proof.mjs';
import { spaceCapability, spaceCodeId, localSpaces, newSpaceRecoveryCode, type PrivateSpace } from './spaces';
import { readLocalSpaceDirectory, writeLocalSpaceDirectory, withVaultMutation, readBrowserAccessRecord, writeBrowserAccessRecord, type VaultSession } from './vault';
import type { PlatformCredentialRecord, PrivateIdentity, RoomMember, RoomState } from './types';
export type AccessSpace = { roomId:string; name:string; certificate?:AccessCertificate; members?:RoomMember[]; eventSeq?:number; creatorFingerprint?:string; role?:'creator'|'joiner'; localId?:string; waiting?:boolean; createdAt?:string; deviceCount?:number };
export type AccessStatus = {status:'pending'|'approved'|'expired'|'canceled'|'rejected'|'revoked';expiresAt:string;serverTime:string;state?:RoomState;sealed?:SealedBackup};
export type PendingSpaceAccess = {identity:PrivateIdentity;token:string;proof:AccessProof;expiresAt?:string;status?:AccessStatus['status']};
export type AccessCatalog = {id:string;token:string;key:string};
export type BrowserProfile = {v:1;catalog:AccessCatalog; identity:AccessIdentity; grant:AccessGrant; spaces:AccessSpace[];currentRoom:string;collectionCode:string;pending:Record<string,PendingSpaceAccess>};
export type AccessMailbox = {id:string;token:string;transferKey:string};
export type BrowserProfileSession = {profile:BrowserProfile;record:PlatformCredentialRecord;secret:string;stored?:unknown};
export type BrowserRequest = {requestId:string;browserId:string;browserKey:JsonWebKey;expiresAt:string};
export type PeerAccessRequest = {proof:AccessProof;target:RoomMember;expiresAt:string};
type Prepared = {v:1;root:AccessIdentity;spaces:AccessSpace[];catalogCode:string;mailboxes?:AccessMailbox[];removed?:string[]};
const catalogSpaceKeys = ['roomId','name','certificate','members','eventSeq','creatorFingerprint','role','waiting','createdAt','deviceCount'];
export function catalogSpaceAllowed(space: AccessSpace): boolean {
  return /^[a-f0-9-]{36}$/i.test(space.roomId) && typeof space.name === 'string' && Boolean(space.name.trim()) && space.name.length <= 40
    && Object.keys(space).every(key => catalogSpaceKeys.includes(key))
    && (space.waiting === undefined || typeof space.waiting === 'boolean')
    && (space.createdAt === undefined || Number.isFinite(Date.parse(space.createdAt)))
    && (space.deviceCount === undefined || Number.isSafeInteger(space.deviceCount) && space.deviceCount >= 0 && space.deviceCount <= 16);
}
/** Own-device catalog merge. Names and waiting state stay inside this participant's encrypted directory. */
export function mergeCatalogSpaces(remote: AccessSpace[], local: AccessSpace[], removed: readonly string[] = []): AccessSpace[] {
  const gone = new Set(removed);
  const byId = new Map<string, AccessSpace>();
  for (const space of remote) if (!gone.has(space.roomId) && catalogSpaceAllowed(space)) byId.set(space.roomId, { ...space });
  for (const space of local) {
    if (gone.has(space.roomId)) { byId.delete(space.roomId); continue; }
    const previous = byId.get(space.roomId);
    const merged: AccessSpace = {
      ...(previous ?? {}),
      roomId: space.roomId,
      name: space.name,
      ...(space.waiting ? { waiting: true } : {}),
      ...(space.createdAt ? { createdAt: space.createdAt } : previous?.createdAt ? { createdAt: previous.createdAt } : {}),
      ...(space.deviceCount !== undefined ? { deviceCount: space.deviceCount } : previous?.deviceCount !== undefined ? { deviceCount: previous.deviceCount } : {}),
      ...(space.certificate ? { certificate: space.certificate, members: space.members, eventSeq: space.eventSeq, creatorFingerprint: space.creatorFingerprint, role: space.role }
        : previous?.certificate ? { certificate: previous.certificate, members: previous.members, eventSeq: previous.eventSeq, creatorFingerprint: previous.creatorFingerprint, role: previous.role } : {}),
    };
    if (!space.waiting) delete merged.waiting;
    byId.set(space.roomId, merged);
  }
  return [...byId.values()].filter(space => !gone.has(space.roomId) && catalogSpaceAllowed(space));
}
const encoder=new TextEncoder();
export async function browserAccessKeys(prf:Uint8Array<ArrayBuffer>):Promise<AccessMailbox & {profileKey:string}> {
  const material=await crypto.subtle.importKey('raw',prf,'HKDF',false,['deriveBits']);
  const derive=async(purpose:string)=>toBase64Url(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:encoder.encode(location.origin),info:encoder.encode(`quiet-room-browser-access-${purpose}-v1`)},material,256));
  const [id,token,transferKey,profileKey]=await Promise.all(['mailbox','capability','transfer','profile'].map(derive));
  return {id:id!,token:token!,transferKey:transferKey!,profileKey:profileKey!};
}
export async function accessApi<T>(path:string,token:string,signal:AbortSignal,method='GET',body?:unknown):Promise<T> {
  const response=await fetch(path,{method,credentials:'omit',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok) { const error=await response.json().catch(()=>null); throw new Error(error?.error ?? '授权服务暂不可用，请稍后重试'); }
  return response.json();
}
export const mailboxPath=(m:AccessMailbox,id?:string)=>`/api/browser-access/${m.id}${id?`/${id}`:''}`;
export const spaceAccessPath=(roomId:string,id?:string)=>`/api/rooms/${roomId}/browser-access${id?`/${id}`:''}`;
const rootId=(code:string)=>`${spaceCodeId(code)}:browser-access`;
function cleanMembers(members:RoomMember[]):RoomMember[] {
  return members.filter(m=>m.status!=='pending').map(m=>({deviceId:m.deviceId,role:m.role,encryptionKey:m.encryptionKey,signingKey:m.signingKey,
    ...(m.mlsKeyPackage?{mlsKeyPackage:m.mlsKeyPackage}:{}),...(m.addedBy?{addedBy:m.addedBy}:{}),joinProof:m.joinProof??null,status:m.status,createdAt:m.createdAt}));
}
/** Called only after this room is unlocked. Other locked vaults are never read. */
export async function prepareBrowserAccess(session:VaultSession):Promise<void> {
  const v=session.vault,code=v.spaceRecoveryCode;
  if(!code || v.protocol!=='mls-rfc9420' || v.mls?.phase!=='active' || v.pairingState && v.pairingState!=='ready') return;
  const own=v.members.find(m=>m.deviceId===v.identity.publicBundle.deviceId);
  if(!own || own.status==='revoked' || own.status==='pending') return;
  const spaces=await localSpaces(session);
  await withVaultMutation(session,async mutation=>{
    const id=rootId(code),key=await spaceCapability(code,'encryption'),sealed=await readLocalSpaceDirectory(id);
    const saved:Prepared=sealed?await openJson(sealed as SealedBackup,key,id) as Prepared:{v:1,root:await newAccessIdentity(),spaces:[],catalogCode:newSpaceRecoveryCode()};
    if(saved.v!==1 || !Array.isArray(saved.spaces) || !publicAccessKey(saved.root?.publicKey)) throw new Error('浏览器接入准备数据不完整');
    const certificate=await signAccess(v.identity.signingPrivateKey,{v:1 as const,purpose:'quiet-room-browser-request-root' as const,roomId:v.roomId,sourceDeviceId:own.deviceId,rootKey:saved.root.publicKey});
    const entry:AccessSpace={roomId:v.roomId,name:spaces.find(s=>s.roomId===v.roomId)?.name??'私密空间',certificate,members:cleanMembers(v.members),eventSeq:v.mls?.lastEventSeq??0,creatorFingerprint:v.creatorFingerprint,role:v.role};
    saved.catalogCode??=newSpaceRecoveryCode();
    if(session.browserAccessPrf) {
      const {profileKey:_discard,...mailbox}=await browserAccessKeys(session.browserAccessPrf);
      saved.mailboxes=[...(saved.mailboxes??[]).filter(m=>m.id!==mailbox.id),mailbox].slice(-256);
    }
    saved.spaces=saved.spaces.filter(s=>s.roomId!==v.roomId);saved.spaces.push(entry);
    await writeLocalSpaceDirectory(session,id,await sealJson(saved,key,id),mutation);
  });
}
export async function approveBrowser(session:VaultSession,mailbox:AccessMailbox,request:BrowserRequest,signal:AbortSignal):Promise<void> {
  const code=session.vault.spaceRecoveryCode!;
  const spaces=await localSpaces(session),id=rootId(code),sealed=await readLocalSpaceDirectory(id);
  if(!sealed) throw new Error('请先在此设备打开并解锁空间');
  const prepared=await openJson(sealed as SealedBackup,await spaceCapability(code,'encryption'),id) as Prepared;
  const grant=await signAccess(prepared.root.privateKey,{v:1 as const,purpose:'quiet-room-browser-request-grant' as const,requestId:request.requestId,browserId:request.browserId,browserKey:request.browserKey});
  const approved=spaces.map(s=>{
    const p=prepared.spaces.find(p=>p.roomId===s.roomId);
    return p?{roomId:s.roomId,name:s.name,certificate:p.certificate,members:p.members,eventSeq:p.eventSeq,creatorFingerprint:p.creatorFingerprint,role:p.role}:{roomId:s.roomId,name:s.name};
  });
  await syncBrowserCatalog(session,prepared,approved,signal);
  const catalog=await catalogCapability(prepared.catalogCode);
  const payload={v:1,grant,spaces:approved.map(s=>({roomId:s.roomId,name:s.name})),catalog,currentRoom:session.vault.roomId};
  const response=await sealJson(payload,mailbox.transferKey,`quiet-room-browser-approval-v1:${request.requestId}:${await accessDigest(request.browserKey)}`);
  signal.throwIfAborted();
  await accessApi(mailboxPath(mailbox,request.requestId),mailbox.token,signal,'PUT',{sealed:response});
}
export async function acceptBrowserApproval(identity:AccessIdentity,requestId:string,mailbox:AccessMailbox,sealed:SealedBackup):Promise<BrowserProfile> {
  const data=await openJson(sealed,mailbox.transferKey,`quiet-room-browser-approval-v1:${requestId}:${await accessDigest(identity.publicKey)}`) as {v:number;catalog:AccessCatalog;grant:AccessGrant;spaces:AccessSpace[];currentRoom:string};
  if(data.v!==1 || data.grant?.requestId!==requestId || data.grant.browserId!==identity.browserId ||
    await accessDigest(data.grant.browserKey)!==await accessDigest(identity.publicKey) || !Array.isArray(data.spaces) || !data.spaces.length || data.spaces.length>256 ||
    new Set(data.spaces.map(s=>s.roomId)).size!==data.spaces.length || !data.spaces.some(s=>s.roomId===data.currentRoom)) throw new Error('浏览器授权与本次请求不一致');
  for(const s of data.spaces) {
    if(!catalogSpaceAllowed(s)) throw new Error('空间目录不完整');
    if(s.certificate) {
      const source=s.members?.find(m=>m.deviceId===s.certificate!.sourceDeviceId);
      if(!source || s.certificate.roomId!==s.roomId || source.role!==s.role || !Number.isSafeInteger(s.eventSeq) || s.eventSeq!<0 ||
        !await verifyAccess(source.signingKey,s.certificate) || !await verifyAccess(s.certificate.rootKey,data.grant)) throw new Error('空间身份准备凭据不正确');
    }
  }
  if(!data.catalog || !/^[A-Za-z0-9_-]{22}$/.test(data.catalog.id) || !/^[A-Za-z0-9_-]{43}$/.test(data.catalog.token) || !/^[A-Za-z0-9_-]{43}$/.test(data.catalog.key)) throw new Error('空间目录授权不完整');
  return {v:1,catalog:data.catalog,identity,grant:data.grant,spaces:data.spaces,currentRoom:data.currentRoom,collectionCode:newSpaceRecoveryCode(),pending:{}};
}
const profileWrites=new WeakMap<BrowserProfileSession,Promise<void>>();
export function saveBrowserProfile(session:BrowserProfileSession,signal:AbortSignal):Promise<void> {
  const next=(profileWrites.get(session)??Promise.resolve()).catch(()=>undefined).then(async()=>{
    signal.throwIfAborted();
    const sealed=await sealJson(session.profile,session.secret,`quiet-room-browser-profile-v1:${session.record.credentialId}`);
    const stored={v:1,record:session.record,sealed};
    signal.throwIfAborted();await writeBrowserAccessRecord(stored,signal,session.stored);session.stored=stored;
  });
  profileWrites.set(session,next);return next;
}
export async function loadBrowserProfile(prf:Uint8Array<ArrayBuffer>,credentialId:string):Promise<BrowserProfileSession|null> {
  const saved=await readBrowserAccessRecord() as {v:number;record:PlatformCredentialRecord;sealed:SealedBackup}|undefined;
  if(!saved || saved.v!==1 || saved.record?.credentialId!==credentialId) return null;
  const keys=await browserAccessKeys(prf);
  const profile=await openJson(saved.sealed,keys.profileKey,`quiet-room-browser-profile-v1:${credentialId}`) as BrowserProfile;
  if(profile?.v!==1 || !profile.identity?.privateKey || !Array.isArray(profile.spaces)) throw new Error('本浏览器接入数据不完整');
  return {profile,record:saved.record,secret:keys.profileKey,stored:saved};
}
export function discoveredCredentialRecord(value:{credentialId:string;rpId:string;origin:string;backupEligible:boolean}):PlatformCredentialRecord {
  // Never spread a credential result here: it also contains the client-only PRF.
  return {credentialId:value.credentialId,rpId:value.rpId,origin:value.origin,backupEligible:value.backupEligible,
    prfSalt:toBase64Url(browserAccessPrfSalt()),transports:[],authenticatorAttachment:null,createdAt:new Date().toISOString()};
}
export async function prepareSpaceAccess(profile:BrowserProfile,space:AccessSpace,identity:PrivateIdentity):Promise<PendingSpaceAccess> {
  if(!space.certificate) throw new Error('请先在原设备打开并解锁此空间');
  const token=randomBackupSecret();
  const request=await signAccess(profile.identity.privateKey,{v:1 as const,purpose:'quiet-room-space-access-request' as const,roomId:space.roomId,requestId:crypto.randomUUID(),browserId:profile.identity.browserId,
    target:identity.publicBundle,tokenHash:await accessDigest(token),certificateHash:await accessDigest(space.certificate),grantHash:await accessDigest(profile.grant)});
  return {identity,token,proof:{certificate:space.certificate,grant:profile.grant,request}};
}
export function accessPrivateSpaces(profile:BrowserProfile):PrivateSpace[] {
  return profile.spaces.map(s => ({
    roomId: s.roomId, name: s.name,
    ...(s.createdAt ? { createdAt: s.createdAt } : {}),
    ...(s.waiting ? { waiting: true } : {}),
    ...(s.localId ? { localId: s.localId } : s.waiting ? {} : { accessState: s.certificate ? 'restricted' as const : 'unprepared' as const }),
  }));
}

async function catalogCapability(code:string):Promise<AccessCatalog> {
  return {id:spaceCodeId(code),token:await spaceCapability(code,'fetch'),key:await spaceCapability(code,'encryption')};
}
async function syncBrowserCatalog(session:VaultSession,prepared:Prepared,local:AccessSpace[],signal:AbortSignal):Promise<void> {
  const catalog=await catalogCapability(prepared.catalogCode),path=`/api/browser-access-catalogs/${catalog.id}`;
  for(let attempt=0;attempt<3;attempt++) {
    signal.throwIfAborted();
    const response=await fetch(path,{headers:{Authorization:`Bearer ${catalog.token}`},credentials:'omit',cache:'no-store',signal});
    if(!response.ok && response.status!==404) throw new Error('接入目录暂不可用');
    const old=response.ok?await response.json():{revision:0};
    let remote: AccessSpace[] = [], remoteRemoved: string[] = [];
    if(old.sealed) {
      const data=await openJson(old.sealed,catalog.key,`quiet-room-browser-catalog-v1:${catalog.id}`) as {v:number;spaces:AccessSpace[];removed?:string[]};
      if(data.v===1 && Array.isArray(data.spaces)) { remote=data.spaces; remoteRemoved=Array.isArray(data.removed)?data.removed:[]; }
    }
    const removed=[...new Set([...remoteRemoved,...(prepared.removed??[])])].slice(-256);
    const spaces=mergeCatalogSpaces(remote,local,removed);
    const sealed=await sealJson({v:1,spaces,removed},catalog.key,`quiet-room-browser-catalog-v1:${catalog.id}`);
    signal.throwIfAborted();
    const write=await fetch(path,{method:'PUT',headers:{Authorization:`Bearer ${session.vault.accessToken}`,'Content-Type':'application/json'},credentials:'omit',signal,
      body:JSON.stringify({roomId:session.vault.roomId,revision:old.revision+1,fetchToken:catalog.token,writeToken:await spaceCapability(prepared.catalogCode,'write'),sealed})});
    if(write.ok) return;
    if(write.status!==409) throw new Error('接入目录未能保存');
  }
  throw new Error('接入目录正在更新，请稍后重试');
}
export async function publishPreparedCatalog(session:VaultSession,signal:AbortSignal,excludeRoomId?:string):Promise<void> {
  const code=session.vault.spaceRecoveryCode;
  if(!code) return;
  const id=rootId(code),sealed=await readLocalSpaceDirectory(id);
  if(!sealed) return;
  const prepared=await openJson(sealed as SealedBackup,await spaceCapability(code,'encryption'),id) as Prepared;
  const local=(await localSpaces(session)).filter(space => space.roomId !== excludeRoomId);
  const deviceCount=session.vault.members.filter(member => member.role===session.vault.role && member.status!=='revoked').length;
  const spaces=local.map(s=>{
    const preparedSpace=prepared.spaces.find(p=>p.roomId===s.roomId);
    const entry:AccessSpace=preparedSpace?{...preparedSpace,name:s.name}:{roomId:s.roomId,name:s.name};
    if(s.waiting) entry.waiting=true;
    if(s.createdAt) entry.createdAt=s.createdAt;
    if(s.roomId===session.vault.roomId) entry.deviceCount=deviceCount;
    delete entry.localId;
    return entry;
  });
  await syncBrowserCatalog(session,prepared,spaces,signal);
}
export async function refreshBrowserCatalog(profile:BrowserProfile,signal:AbortSignal):Promise<void> {
  const c=profile.catalog;
  const result=await accessApi<{sealed:SealedBackup}>(`/api/browser-access-catalogs/${c.id}`,c.token,signal);
  const data=await openJson(result.sealed,c.key,`quiet-room-browser-catalog-v1:${c.id}`) as {v:number;spaces:AccessSpace[];removed?:string[]};
  if(data.v!==1 || !Array.isArray(data.spaces) || data.spaces.length>256 || data.removed!==undefined && (!Array.isArray(data.removed) || data.removed.length>256)) throw new Error('空间目录不完整');
  const removed=new Set(data.removed??[]);
  const next:AccessSpace[]=[];
  for(const previous of profile.spaces) {
    if(removed.has(previous.roomId)) continue;
    const s=data.spaces.find(s=>s.roomId===previous.roomId);
    if(!s) { next.push(previous); continue; }
    if(!catalogSpaceAllowed(s)) throw new Error('空间目录不完整');
    if(s.certificate) {
      const source=s.members?.find(m=>m.deviceId===s.certificate!.sourceDeviceId);
      if(!source || s.certificate.roomId!==s.roomId || source.role!==s.role || !Number.isSafeInteger(s.eventSeq) || s.eventSeq!<0 ||
        !await verifyAccess(source.signingKey,s.certificate) || !await verifyAccess(s.certificate.rootKey,profile.grant)) throw new Error('空间身份准备凭据不正确');
    }
    const merged: AccessSpace = {...previous,name:s.name,deviceCount:s.deviceCount??previous.deviceCount,certificate:s.certificate??previous.certificate,members:s.members??previous.members,eventSeq:s.eventSeq??previous.eventSeq,creatorFingerprint:s.creatorFingerprint??previous.creatorFingerprint,role:s.role??previous.role};
    if(s.createdAt){merged.createdAt=s.createdAt;merged.waiting=s.waiting;}
    else if(s.waiting) merged.waiting=true;
    next.push(merged);
  }
  for(const s of data.spaces) {
    if(removed.has(s.roomId) || next.some(space=>space.roomId===s.roomId)) continue;
    if(!catalogSpaceAllowed(s)) throw new Error('空间目录不完整');
    if(s.certificate) {
      const certificate=s.certificate;
      const source=s.members?.find(m=>m.deviceId===certificate.sourceDeviceId);
      if(!source || certificate.roomId!==s.roomId || source.role!==s.role || !Number.isSafeInteger(s.eventSeq) || s.eventSeq!<0 ||
        !await verifyAccess(source.signingKey,certificate) || !await verifyAccess(certificate.rootKey,profile.grant)) throw new Error('空间身份准备凭据不正确');
    }
    next.push({roomId:s.roomId,name:s.name,waiting:s.waiting,createdAt:s.createdAt,deviceCount:s.deviceCount,certificate:s.certificate,members:s.members,eventSeq:s.eventSeq,creatorFingerprint:s.creatorFingerprint,role:s.role});
  }
  profile.spaces=next;
}

export async function rememberCatalogRemoval(session:VaultSession,roomId:string):Promise<void> {
  const code=session.vault.spaceRecoveryCode;if(!code)return;
  await withVaultMutation(session,async mutation=>{
    const id=rootId(code),sealed=await readLocalSpaceDirectory(id);if(!sealed)return;
    const key=await spaceCapability(code,'encryption');
    const saved=await openJson(sealed as SealedBackup,key,id) as Prepared;
    saved.removed=[...new Set([...(saved.removed??[]),roomId])].slice(-256);
    saved.spaces=(saved.spaces??[]).filter(space=>space.roomId!==roomId);
    await writeLocalSpaceDirectory(session,id,await sealJson(saved,key,id),mutation);
  });
}

export async function preparedMailboxes(session:VaultSession):Promise<AccessMailbox[]> {
  const code=session.vault.spaceRecoveryCode;if(!code)return [];
  const id=rootId(code),sealed=await readLocalSpaceDirectory(id);if(!sealed)return [];
  const prepared=await openJson(sealed as SealedBackup,await spaceCapability(code,'encryption'),id) as Prepared;
  return prepared.mailboxes??[];
}
