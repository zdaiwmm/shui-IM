import { authorizedFetch } from './api';
import { canonicalStringify } from './canonical';
import { openJson, sealJson } from './backup-crypto';
import { openOwnDirectory, openOwnEnvelope, sealOwnEnvelope, type OwnEnvelope } from './own-space-directory';
import { spaceCapability, spaceCodeId } from './spaces';
import { readLocalSpaceDirectory, writeLocalSpaceDirectory, withVaultMutation, type VaultSession } from './vault';
import { classifyInviteHash, makeDeviceInviteUrl, type DeviceInvite } from './invite-link';

export type OwnRoomAccess = {
  id:string; roomId:string; carrierRoomId:string; requesterId:string; authorizerId:string;
  deviceName:string; expiresAt:string; status:'requested'|'approved'|'rejected'; invite?:DeviceInvite;
};
const purpose = 'quiet-room-own-admission-v1' as const;
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const keyId = (session:VaultSession) => `own-admission:${spaceCodeId(session.vault.spaceRecoveryCode!)}`;
export function validOwnRoomAccess(value:unknown):value is OwnRoomAccess {
  const m=value as OwnRoomAccess;
  if(!m || Object.keys(m).some(k=>!['id','roomId','carrierRoomId','requesterId','authorizerId','deviceName','expiresAt','status','invite'].includes(k)) ||
    ![m.id,m.roomId,m.carrierRoomId,m.requesterId,m.authorizerId].every(id=>typeof id==='string'&&uuid.test(id)) || m.requesterId===m.authorizerId ||
    typeof m.deviceName!=='string'||!m.deviceName.trim()||m.deviceName.length>120||!Number.isFinite(Date.parse(m.expiresAt))||
    !['requested','approved','rejected'].includes(m.status))return false;
  if(m.status!=='approved')return m.invite===undefined;
  if(!m.invite||m.invite.roomId!==m.roomId||!m.invite.admissionSecret||Date.parse(m.invite.expiresAt)>Date.parse(m.expiresAt))return false;
  try{return classifyInviteHash(new URL(makeDeviceInviteUrl(m.invite)).hash)?.kind==='device';}catch{return false;}
}
export async function ownRoomAccessMessages(session:VaultSession):Promise<OwnRoomAccess[]> {
  const sealed=await readLocalSpaceDirectory(keyId(session));if(!sealed)return [];
  const data=await openJson(sealed as Parameters<typeof openJson>[0],await spaceCapability(session.vault.spaceRecoveryCode!,'encryption'),keyId(session));
  if(!Array.isArray(data)||data.length>64||!data.every(validOwnRoomAccess))throw new Error('设备授权记录校验失败');
  return data.filter(m=>Date.parse(m.expiresAt)>Date.now());
}
export async function saveOwnRoomAccess(session:VaultSession,message:OwnRoomAccess,signal:AbortSignal):Promise<void> {
  if(!validOwnRoomAccess(message))throw new Error('设备授权内容不正确');
  await withVaultMutation(session,async mutation=>{
    signal.throwIfAborted();const messages=await ownRoomAccessMessages(session),previous=messages.find(m=>m.id===message.id);
    if(previous&&canonicalStringify(previous)===canonicalStringify(message))return;
    if(previous){
      const {status:_s,invite:_i,...a}=previous,{status:_t,invite:_j,...b}=message;
      if(canonicalStringify(a)!==canonicalStringify(b)||previous.status!=='requested'&&canonicalStringify(previous)!==canonicalStringify(message))throw new Error('设备授权状态冲突');
    }
    const next=[...messages.filter(m=>m.id!==message.id),message];if(next.length>64)throw new Error('设备申请过多，请稍后重试');
    const sealed=await sealJson(next,await spaceCapability(session.vault.spaceRecoveryCode!,'encryption'),keyId(session));
    signal.throwIfAborted();await writeLocalSpaceDirectory(session,keyId(session),sealed,mutation);
  });
}
export async function requestOwnRoomAccess(session:VaultSession,roomId:string,deviceName:string,signal:AbortSignal):Promise<OwnRoomAccess|null> {
  const url=`/api/rooms/${session.vault.roomId}/own-directory`;
  const data=await(await authorizedFetch(url,session.vault.accessToken,{signal,cache:'no-store'})).json() as {incoming:OwnEnvelope[]};
  for(const envelope of data.incoming){
    const entries=await openOwnDirectory(session.vault,envelope);
    if(!entries.some(e=>e.roomId===roomId&&!e.removed))continue;
    const requesterId=session.vault.identity.publicBundle.deviceId;
    const pending=(await ownRoomAccessMessages(session)).find(m=>m.roomId===roomId&&m.requesterId===requesterId&&m.status!=='rejected');
    if(pending)return pending;
    const message:OwnRoomAccess={id:crypto.randomUUID(),roomId,carrierRoomId:session.vault.roomId,requesterId,authorizerId:envelope.senderId,
      deviceName,expiresAt:new Date(Date.now()+10*60_000).toISOString(),status:'requested'};
    await saveOwnRoomAccess(session,message,signal);await syncOwnRoomAccess(session,signal);return message;
  }
  return null;
}
export async function syncOwnRoomAccess(session:VaultSession,signal:AbortSignal):Promise<void> {
  if(!session.vault.roomArchiveV2||session.vault.pairingState!=='ready')return;
  const own=session.vault.identity.publicBundle.deviceId;
  const peers=session.vault.members.filter(m=>m.role===session.vault.role&&m.status==='active'&&m.deviceId!==own);if(!peers.length)return;
  const url=`/api/rooms/${session.vault.roomId}/own-admission`,options={signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),cache:'no-store' as const};
  const data=await(await authorizedFetch(url,session.vault.accessToken,options)).json() as {incoming:OwnEnvelope[];outgoing:{recipientId:string;revision:number}[]};
  if(!Array.isArray(data.incoming)||data.incoming.length>2||!Array.isArray(data.outgoing)||data.outgoing.length>2)throw new Error('授权来源不正确');
  for(const envelope of data.incoming){
    const messages=await openOwnEnvelope(session.vault,envelope,purpose);
    if(!Array.isArray(messages)||messages.length>64)throw new Error('授权内容不正确');
    for(const message of messages){
      if(!validOwnRoomAccess(message)||message.carrierRoomId!==session.vault.roomId||
        (message.status==='requested'?(message.requesterId!==envelope.senderId||message.authorizerId!==own):(message.authorizerId!==envelope.senderId||message.requesterId!==own)))throw new Error('授权设备不匹配');
      if(Date.parse(message.expiresAt)<=Date.now())continue;
      const previous=(await ownRoomAccessMessages(session)).find(m=>m.id===message.id);
      // An authorization can answer only a request already persisted by this device.
      if(message.status!=='requested'&&!previous)throw new Error('没有对应的设备申请');
      if(previous&&previous.status!=='requested'&&message.status==='requested')continue;
      await saveOwnRoomAccess(session,message,signal);
    }
  }
  const messages=await ownRoomAccessMessages(session);
  for(const peer of peers){
    const outgoing=messages.filter(m=>m.carrierRoomId===session.vault.roomId&&(m.status==='requested'?m.requesterId===own&&m.authorizerId===peer.deviceId:m.authorizerId===own&&m.requesterId===peer.deviceId));
    const previous=data.outgoing.find(m=>m.recipientId===peer.deviceId)?.revision??0;
    if(!outgoing.length&&!previous)continue;
    const envelope=await sealOwnEnvelope(session.vault,peer,outgoing,previous+1,purpose);
    await authorizedFetch(url,session.vault.accessToken,{...options,method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope)});
  }
}
