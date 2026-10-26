import type { Vault } from './types';
/** Presentation facts only. This projection never grants MLS, history or archive authority. */
export function roomBusinessState({vault,catalogOnly=false,request,now=Date.now()}:{vault?:Vault;catalogOnly?:boolean;request?:{status:'requested'|'approved'|'rejected';expiresAt:string};now?:number}){
  const liveRequest=request&&Date.parse(request.expiresAt)>now?request:undefined;
  if(catalogOnly||!vault){return {stage:liveRequest?.status==='approved'?'authorized':liveRequest?.status==='requested'?'applying':'discovered',history:'separate' as const,
    label:liveRequest?.status==='approved'?'设备已获授权，正在完成连接':liveRequest?.status==='requested'?'申请已发送，等待你的原设备授权。':liveRequest?.status==='rejected'?'原设备已拒绝本次申请。':'尚未在此浏览器接入'};}
  const ownId=vault.identity.publicBundle.deviceId;
  if(vault.localAccessDeniedDeviceId===ownId||vault.members.some(m=>m.deviceId===ownId&&m.status==='revoked'))return {stage:'denied',history:'separate' as const,label:'此设备无法进入密室'};
  const ready=vault.pairingState==='ready'&&(vault.protocol!=='mls-rfc9420'||vault.mls?.phase==='active'||vault.mls?.phase==='awaiting-peer');
  return {stage:ready?'ready':'authorized',history:'separate' as const,label:ready?'会话已就绪':'设备已获授权，正在完成连接'};
}
