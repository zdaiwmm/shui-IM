import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from '../server/storage.mjs';
import {generateIdentity} from '../src/lib/crypto';
import {newAccessIdentity,signAccess,accessDigest,verifyAccessProof,validAccessProof} from '../src/lib/browser-access-proof.mjs';
import {prepareMlsWindowUpdate,prepareMlsMembership,createCreatorMlsState,prepareCreatorWelcome,joinMlsGroup,completeBrowserAccessJoin,processMlsMembership,encryptMlsApplication,decryptMlsApplication} from '../src/lib/mls';
import {validateMlsMembershipShape} from '../server/protocol.mjs';
import type {Vault} from '../src/lib/types';
import {discoveredCredentialRecord} from '../src/lib/browser-access';
const dirs:string[]=[];const stores:ReturnType<typeof createStore>[]=[];
afterEach(async()=>{vi.useRealTimers();for(const store of stores.splice(0)) (await store).close();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){
  const identities=await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
  const [source,peer,target]=identities;const root=await newAccessIdentity(),browser=await newAccessIdentity();
  const dataDir=await mkdtemp(path.join(tmpdir(),'qr-browser-access-'));dirs.push(dataDir);const promise=createStore({dataDir});stores.push(promise);const store=await promise;
  const {roomId}=store.createRoom(source!.publicBundle,'a'.repeat(43),'b'.repeat(43),'旧设备',['mls-multidevice-v1']);
  store.joinRoom(roomId,peer!.publicBundle,'proof','c'.repeat(43),'对方设备',['mls-multidevice-v1']);
  const token='d'.repeat(43);
  const certificate=await signAccess(source!.signingPrivateKey,{v:1 as const,purpose:'quiet-room-browser-request-root' as const,roomId,sourceDeviceId:source!.publicBundle.deviceId,rootKey:root.publicKey});
  const grant=await signAccess(root.privateKey,{v:1 as const,purpose:'quiet-room-browser-request-grant' as const,requestId:crypto.randomUUID(),browserId:browser.browserId,browserKey:browser.publicKey});
  const request=await signAccess(browser.privateKey,{v:1 as const,purpose:'quiet-room-space-access-request' as const,roomId,requestId:crypto.randomUUID(),browserId:browser.browserId,target:target!.publicBundle,tokenHash:await accessDigest(token),certificateHash:await accessDigest(certificate),grantHash:await accessDigest(grant)});
  return {store,roomId,source:source!,peer:peer!,target:target!,root,browser,token,proof:{certificate,grant,request}};
}
describe('browser access two-party authorization',()=>{
  it('never persists native PRF material in the public credential descriptor',()=>{
    const credential={credentialId:'AQID',rpId:'localhost',origin:'http://localhost',backupEligible:false,prfOutput:new Uint8Array(32).fill(17),otherSecret:'must-not-persist'};
    const record=discoveredCredentialRecord(credential);
    expect(Object.keys(record).sort()).toEqual(['authenticatorAttachment','backupEligible','createdAt','credentialId','origin','prfSalt','rpId','transports'].sort());
    expect(JSON.stringify(record)).not.toContain('must-not-persist');
  });
  it('binds the complete source/root/browser/room/key/request chain',async()=>{
    const f=await fixture(),member=f.store.getMember(f.roomId,f.source.publicBundle.deviceId);
    expect(await verifyAccessProof(f.proof,f.roomId,member)).toBe(true);
    for(const change of [
      {...f.proof,certificate:{...f.proof.certificate,roomId:crypto.randomUUID()}},
      {...f.proof,grant:{...f.proof.grant,browserKey:f.root.publicKey}},
      {...f.proof,request:{...f.proof.request,requestId:crypto.randomUUID()}},
      {...f.proof,request:{...f.proof.request,target:f.peer.publicBundle}},
      {...f.proof,request:{...f.proof.request,tokenHash:'z'.repeat(43)}},
    ]) expect(await verifyAccessProof(change,f.roomId,member)).toBe(false);
    expect(validAccessProof({...f.proof,privateKey:f.root.privateKey},f.roomId)).toBe(false);
    expect(validAccessProof({...f.proof,certificate:{...f.proof.certificate,rootKey:f.root.privateKey}},f.roomId)).toBe(false);
  });
  it('cannot read chat before approval and only the opposite participant can commit',async()=>{
    const f=await fixture();
    f.store.insertMessage(f.roomId,{clientMsgId:crypto.randomUUID(),senderId:f.source.publicBundle.deviceId,ciphertext:'old'});
    const result=await f.store.browserAccess.create(f.roomId,f.proof,f.token,'新浏览器');
    expect(result.status).toBe('pending');expect(result).not.toHaveProperty('state');
    expect(f.store.authenticatedDevice(f.roomId,f.token)).toBeNull();
    expect(f.store.browserAccess.list(f.roomId,f.source.publicBundle.deviceId).requests).toHaveLength(0);
    const [item]=f.store.browserAccess.list(f.roomId,f.peer.publicBundle.deviceId).requests;
    const event={v:1,protocol:'mls-rfc9420',roomId:f.roomId,eventId:crypto.randomUUID(),previousEventSeq:0,action:'add',senderId:f.source.publicBundle.deviceId,targetId:f.target.publicBundle.deviceId,target:item.target,commit:'C'.repeat(64),welcome:'W'.repeat(96),signature:'S'.repeat(86)};
    expect(()=>f.store.saveMlsEvent(f.roomId,event)).toThrow();
    expect(()=>f.store.saveMlsEvent(f.roomId,{...event,browserAccess:f.proof})).toThrow();
    const approved={...event,senderId:f.peer.publicBundle.deviceId,browserAccess:f.proof};
    expect(validateMlsMembershipShape(approved,f.roomId)).toBe(true);
    f.store.saveMlsEvent(f.roomId,approved);
    expect(f.store.browserAccess.status(f.roomId,f.proof.request.requestId,f.token).status).toBe('approved');
    expect(f.store.getMember(f.roomId,f.target.publicBundle.deviceId)).toMatchObject({status:'active',role:'creator',joinSeq:1});
    expect(f.store.authenticatedDevice(f.roomId,'a'.repeat(43))).not.toBeNull();
    expect(f.store.browserAccess.list(f.roomId,f.peer.publicBundle.deviceId).requests).toHaveLength(0);
  });
  it('expires at the server deadline, rejects a late commit, and never renews a replay',async()=>{
    const f=await fixture();vi.useFakeTimers({toFake:['Date']});
    const first=await f.store.browserAccess.create(f.roomId,f.proof,f.token,'新浏览器');
    const target=f.store.getMember(f.roomId,f.target.publicBundle.deviceId);
    vi.setSystemTime(Date.parse(first.expiresAt));
    expect(()=>f.store.saveMlsEvent(f.roomId,{v:1,protocol:'mls-rfc9420',roomId:f.roomId,eventId:crypto.randomUUID(),previousEventSeq:0,action:'add',senderId:f.peer.publicBundle.deviceId,targetId:target.deviceId,target,browserAccess:f.proof,commit:'C'.repeat(64),welcome:'W'.repeat(96),signature:'S'.repeat(86)})).toThrow();
    expect(f.store.browserAccess.list(f.roomId,f.peer.publicBundle.deviceId).requests).toHaveLength(0);
    const replay=await f.store.browserAccess.create(f.roomId,f.proof,f.token,'新浏览器');
    expect(replay).toMatchObject({status:'expired',expiresAt:first.expiresAt});
    expect(f.store.getMember(f.roomId,target.deviceId).status).toBe('revoked');
  });
  it('binds cancel/reject to the requester or opposite participant and releases the reservation',async()=>{
    const f=await fixture();await f.store.browserAccess.create(f.roomId,f.proof,f.token,'新浏览器');
    expect(()=>f.store.browserAccess.dismiss(f.roomId,f.proof.request.requestId,f.source.publicBundle.deviceId)).toThrow('UNAUTHORIZED');
    expect(()=>f.store.browserAccess.dismiss(f.roomId,f.proof.request.requestId,null,'x'.repeat(43))).toThrow('UNAUTHORIZED');
    f.store.browserAccess.dismiss(f.roomId,f.proof.request.requestId,f.peer.publicBundle.deviceId);
    expect(f.store.browserAccess.status(f.roomId,f.proof.request.requestId,f.token).status).toBe('rejected');
    expect(f.store.getMember(f.roomId,f.target.publicBundle.deviceId).status).toBe('revoked');
  });
  it('enforces three independent device reservations and rejects proof replay with a changed target',async()=>{
    const f=await fixture();await f.store.browserAccess.create(f.roomId,f.proof,f.token,'新浏览器');
    async function nextProof(){
      const target=await generateIdentity();
      const {signature:_signature,...unsigned}=f.proof.request;
      return {...f.proof,request:await signAccess(f.browser.privateKey,{...unsigned,requestId:crypto.randomUUID(),target:target.publicBundle})};
    }
    const second=await nextProof();await f.store.browserAccess.create(f.roomId,second,f.token,'第二浏览器');
    const third=await nextProof();await expect(f.store.browserAccess.create(f.roomId,third,f.token,'超额浏览器')).rejects.toThrow('DEVICE_LIMIT');
    expect(await f.store.browserAccess.capacity(f.roomId,{certificate:f.proof.certificate,grant:f.proof.grant})).toMatchObject({full:true,count:3});
    f.store.browserAccess.dismiss(f.roomId,second.request.requestId,null,f.token);
    await expect(f.store.browserAccess.create(f.roomId,third,f.token,'第三浏览器')).resolves.toMatchObject({status:'pending'});
    const {signature:_signature,...unsigned}=f.proof.request;
    const conflicting={...f.proof,request:await signAccess(f.browser.privateKey,{...unsigned,target:(await generateIdentity()).publicBundle})};
    await expect(f.store.browserAccess.create(f.roomId,conflicting,f.token,'冒用编号')).rejects.toThrow('ACCESS_CONFLICT');
  });
  it('invalidates pending authority when the originating own device is revoked',async()=>{
    const f=await fixture();
    const other=await generateIdentity(),link=crypto.randomUUID();
    f.store.createDeviceLink(f.roomId,f.source.publicBundle.deviceId,link,'s'.repeat(43),new Date(Date.now()+60000).toISOString());
    f.store.claimDeviceLink(link,'s'.repeat(43),other.publicBundle,'o'.repeat(43),'其他旧设备');
    f.store.saveMlsEvent(f.roomId,{v:1,protocol:'mls-rfc9420',roomId:f.roomId,eventId:crypto.randomUUID(),previousEventSeq:0,action:'add',senderId:f.source.publicBundle.deviceId,targetId:other.publicBundle.deviceId,target:f.store.getMember(f.roomId,other.publicBundle.deviceId),commit:'C'.repeat(64),welcome:'W'.repeat(96),signature:'S'.repeat(86)});
    await f.store.browserAccess.create(f.roomId,f.proof,f.token,'新浏览器');
    f.store.saveMlsEvent(f.roomId,{v:1,protocol:'mls-rfc9420',roomId:f.roomId,eventId:crypto.randomUUID(),previousEventSeq:1,action:'remove',senderId:other.publicBundle.deviceId,targetId:f.source.publicBundle.deviceId,commit:'C'.repeat(64),signature:'S'.repeat(86)});
    expect(f.store.browserAccess.list(f.roomId,f.peer.publicBundle.deviceId).requests).toHaveLength(0);
    expect(f.store.browserAccess.status(f.roomId,f.proof.request.requestId,f.token).status).toBe('revoked');
    expect(f.store.authenticatedDevice(f.roomId,f.token)).toBeNull();
  });
  it('stores the requesting browser capabilities before that browser opens chat', async () => {
    const f = await fixture();
    await f.store.browserAccess.create(f.roomId, f.proof, f.token, '新浏览器', ['voice-message-v1', 'reply-v2']);
    expect(f.store.getMember(f.roomId, f.target.publicBundle.deviceId).capabilities).toEqual(['voice-message-v1', 'reply-v2']);
    expect(await f.store.browserAccess.capacity(f.roomId, { certificate: f.proof.certificate, grant: f.proof.grant })).toMatchObject({ full: false, count: 2 });
    await expect(f.store.browserAccess.capacity(f.roomId, { certificate: f.proof.certificate })).rejects.toThrow('UNAUTHORIZED');
  });
  it('keeps browser mailbox approval entirely separate from room access',async()=>{
    const f=await fixture(),id='m'.repeat(43),token='t'.repeat(43),request={requestId:crypto.randomUUID(),browserId:f.browser.browserId,browserKey:f.browser.publicKey};
    const first=f.store.browserAccess.mail(id,token,request.requestId,'create',request);
    expect(first.status).toBe('pending');expect(f.store.browserAccess.mail(id,token,null,'list').requests).toHaveLength(1);
    expect(()=>f.store.browserAccess.mail(id,'x'.repeat(43),request.requestId,'status')).toThrow('UNAUTHORIZED');
    f.store.browserAccess.mail(id,token,request.requestId,'approve',{sealed:{iv:'i'.repeat(16),ciphertext:'c'.repeat(64)}});
    expect(f.store.getMember(f.roomId,f.target.publicBundle.deviceId)).toBeNull();
    expect(f.store.browserAccess.mail(id,token,request.requestId,'status').status).toBe('approved');
    expect(()=>f.store.browserAccess.mail(id,token,request.requestId,'approve',{sealed:{iv:'i'.repeat(16),ciphertext:'c'.repeat(64)}})).toThrow('ACCESS_EXPIRED');
  });
  it('joins via the peer MLS commit, preserves old devices, and cannot decrypt pre-join ciphertext',async()=>{
    const f=await fixture();const members=f.store.roomState(f.roomId).members;
    const common={v:3 as const,roomId:f.roomId,accessToken:'a'.repeat(43),pairingSecret:'',creatorFingerprint:'test',members,lastSeq:0,createdAt:new Date().toISOString(),protocol:'mls-rfc9420' as const};
    const source:Vault={...common,role:'creator',identity:f.source,mls:await createCreatorMlsState(f.roomId,f.source,members)};
    source.mls=await prepareCreatorWelcome(source);
    const peer:Vault={...common,role:'joiner',identity:f.peer,mls:{protocol:'mls-rfc9420',phase:'awaiting-welcome'}};
    peer.mls=await joinMlsGroup(peer,source.mls.pendingWelcome!);source.mls.pendingWelcome=undefined;
    const old=await encryptMlsApplication(source,{v:1,kind:'text',text:'old',sentAt:new Date().toISOString()},crypto.randomUUID());source.mls.groupState=old.nextGroupState;
    const oldOpened=await decryptMlsApplication(peer,old.envelope);peer.mls.groupState=oldOpened.nextGroupState;
    await f.store.browserAccess.create(f.roomId,f.proof,f.token,'新浏览器');
    const target=f.store.getMember(f.roomId,f.target.publicBundle.deviceId);
    const commit=await prepareMlsMembership(peer,'add',target,f.proof);
    f.store.saveMlsEvent(f.roomId,commit.event);peer.mls.groupState=commit.nextGroupState;peer.mls.lastEventSeq=1;
    const state=f.store.roomState(f.roomId);
    const newVault:Vault={...common,role:'creator',identity:f.target,mls:{protocol:'mls-rfc9420',phase:'awaiting-welcome',lastEventSeq:0}};
    const delayedVault = structuredClone(newVault);
    await completeBrowserAccessJoin(newVault,state,f.proof);
    expect(newVault.pairingState).toBe('ready');expect(newVault.identity.mlsPrivatePackage).toBeUndefined();
    await expect(decryptMlsApplication(newVault,old.envelope)).rejects.toThrow();
    source.members=state.members;source.mls.groupState=await processMlsMembership(source,commit.event,1);
    const fresh=await encryptMlsApplication(peer,{v:1,kind:'text',text:'new',sentAt:new Date().toISOString()},crypto.randomUUID());
    expect((await decryptMlsApplication(newVault,fresh.envelope)).payload).toMatchObject({text:'new'});
    expect((await decryptMlsApplication(source,fresh.envelope)).payload).toMatchObject({text:'new'});
    // A delayed first open must persist its own Welcome before processing enough
    // update epochs to discard earlier application keys.
    for (const member of state.members) f.store.updateMemberCapabilities(f.roomId, member.deviceId, ['mls-multidevice-v1', 'message-window-v1']);
    peer.members = f.store.roomState(f.roomId).members;
    const retained = [];
    for (let i = 0; i < 6; i++) {
      const update = await prepareMlsWindowUpdate(peer);
      const accepted = f.store.saveMlsEvent(f.roomId, update.event);
      peer.mls.groupState = update.nextGroupState; peer.mls.lastEventSeq = accepted.eventSeq;
      peer.mls.window = { fromSeq: peer.lastSeq + 1, controls: [], generated: 0 };
      const encrypted = await encryptMlsApplication(peer, { v: 1, kind: 'text', text: `epoch-${i}`, sentAt: new Date().toISOString() }, crypto.randomUUID());
      const message = f.store.insertMessage(f.roomId, encrypted.envelope); retained.push(message);
      peer.lastSeq = message.seq; peer.mls.groupState = encrypted.nextGroupState;
      peer.mls.sendSequence = encrypted.envelope.retention!.sendSequence; peer.mls.window.generated++;
    }
    const delayedState = f.store.roomState(f.roomId);
    await completeBrowserAccessJoin(delayedVault, delayedState, f.proof);
    expect(delayedVault.mls!.lastEventSeq).toBe(1);
    for (const row of delayedState.mlsEvents.filter(row => row.eventSeq > 1)) {
      for (const message of retained.filter(message => message.seq > delayedVault.lastSeq && message.seq <= row.event.retention!.afterSeq)) {
        delayedVault.mls!.groupState = (await decryptMlsApplication(delayedVault, message.envelope)).nextGroupState;
        delayedVault.lastSeq = message.seq;
      }
      delayedVault.mls!.groupState = await processMlsMembership(delayedVault, row.event, row.eventSeq);
      delayedVault.mls!.lastEventSeq = row.eventSeq;
    }
    expect((await decryptMlsApplication(delayedVault, retained.at(-1)!.envelope)).payload).toMatchObject({ text: 'epoch-5' });

  });
});
