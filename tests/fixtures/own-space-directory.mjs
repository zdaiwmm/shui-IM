import assert from 'node:assert/strict';

/** Real HTTP, IndexedDB and pairwise device crypto in independent browsers.
 * The trusted membership roster is installed through the storage fixture. */
export async function verifyOwnSpaceDirectory(browser, service, url) {
  const contexts = [await browser.newContext({locale: 'zh-CN'}),await browser.newContext({locale: 'zh-CN'})];
  try {
    const pages = await Promise.all(contexts.map(context=>context.newPage()));
    const publicKeys = [];
    for (const page of pages) {
      await page.goto(url);
      publicKeys.push(await page.evaluate(async()=>{
        window.directoryIdentity=await (await import('/src/lib/crypto.ts')).generateIdentity();
        return directoryIdentity.publicBundle;
      }));
    }
    const sourceToken='q'.repeat(43),targetToken='r'.repeat(43),caps=['mls-multidevice-v1'];
    const {roomId}=service.store.createRoom(publicKeys[0],sourceToken,'s'.repeat(43),'目录原设备',caps);
    const linkId=crypto.randomUUID(),secret='t'.repeat(43);
    service.store.createDeviceLink(roomId,publicKeys[0].deviceId,linkId,secret,new Date(Date.now()+600000).toISOString());
    service.store.claimDeviceLink(linkId,secret,publicKeys[1],targetToken,'目录另一设备',caps);
    const target=service.store.getMember(roomId,publicKeys[1].deviceId);
    service.store.saveMlsEvent(roomId,{v:1,protocol:'mls-rfc9420',roomId,eventId:crypto.randomUUID(),previousEventSeq:0,action:'add',
      senderId:publicKeys[0].deviceId,targetId:publicKeys[1].deviceId,target,commit:'C'.repeat(64),welcome:'W'.repeat(96),signature:'S'.repeat(86)});
    const members=publicKeys.map(key=>service.store.getMember(roomId,key.deviceId));
    for (let index=0;index<pages.length;index++) await pages[index].evaluate(async data=>{
      const vault=await import('/src/lib/vault.ts'), spaces=await import('/src/lib/spaces.ts');
      const own=await import('/src/lib/own-space-directory.ts');
      const keys=await import('/src/lib/browser-room-key.ts');
      const session=await vault.createVault({v:3,roomId:data.roomId,accessToken:data.token,role:'creator',identity:directoryIdentity,
        members:data.members,createdAt:new Date().toISOString(),lastSeq:0,protocol:'mls-rfc9420',pairingState:'ready',
        roomArchiveV2:{key:(await import('/src/lib/room-archive-crypto.ts')).newArchiveKey()}},'','platform',await keys.automaticRoomCredential());
      await spaces.rememberLocalSpace(session);
      window.ownDirectoryFixture={vault,spaces,own,session,signal:new AbortController().signal};
    },{roomId,members,token:index?targetToken:sourceToken});
    const [a,b]=pages;
    const additional=await a.evaluate(async()=>{
      const {vault,spaces,own,session}=ownDirectoryFixture;
      await vault.selectLocalSpace(crypto.randomUUID());
      const second=await vault.createVault({...session.vault,roomId:crypto.randomUUID(),spaceRecoveryCode:session.vault.spaceRecoveryCode,
        identity:await (await import('/src/lib/crypto.ts')).generateIdentity()},'','platform',await (await import('/src/lib/browser-room-key.ts')).automaticRoomCredential());
      await spaces.rememberLocalSpace(second);
      const space=(await spaces.localSpaces(session)).find(item=>item.roomId===second.vault.roomId);
      await own.changeOwnSpace(session,{...space,name:'仅本人设备的目录名称'});
      const selected = vault.vaultSpaceId(await vault.readStoredVault());
      const auxiliary = await vault.unlockDirectorySyncRoom(await (await import('/src/lib/browser-room-key.ts')).browserRoomKey(),session.stored);
      await own.syncOwnSpaceDirectory(auxiliary,ownDirectoryFixture.signal);
      if (vault.vaultSpaceId(await vault.readStoredVault()) !== selected) throw new Error('Background directory synchronization changed the selected room');
      return {roomId:space.roomId,localId:space.localId};
    });
    await b.evaluate(()=>ownDirectoryFixture.own.syncOwnSpaceDirectory(ownDirectoryFixture.session,ownDirectoryFixture.signal));
    const remote=await b.evaluate(async roomId=>{
      const {own,vault,session}=ownDirectoryFixture;
      const found=(await own.ownDirectorySpaces(session)).find(item=>item.roomId===roomId);
      return {name:found?.name,catalogOnly:found?.catalogOnly,local:found?.localId,history:(await vault.loadHistory(session)).length};
    },additional.roomId);
    assert.deepEqual(remote,{name:'仅本人设备的目录名称',catalogOnly:true,local:undefined,history:0});
    await b.evaluate(async roomId=>{
      const {own,session,signal}=ownDirectoryFixture;
      const space=(await own.ownDirectorySpaces(session)).find(item=>item.roomId===roomId);
      await own.changeOwnSpace(session,{...space,name:'另一设备改名'});await own.syncOwnSpaceDirectory(session,signal);
    },additional.roomId);
    await a.evaluate(()=>ownDirectoryFixture.own.syncOwnSpaceDirectory(ownDirectoryFixture.session,ownDirectoryFixture.signal));
    assert.equal(await a.evaluate(async roomId=>(await ownDirectoryFixture.own.ownDirectorySpaces(ownDirectoryFixture.session)).find(item=>item.roomId===roomId)?.name,additional.roomId),'另一设备改名');
    assert.equal(await a.evaluate(async roomId => (await ownDirectoryFixture.own.ownDirectorySpaces(ownDirectoryFixture.session,
      [{roomId,name:'旧目录中的名称'}])).find(item => item.roomId === roomId)?.name, additional.roomId), '另一设备改名', 'Legacy catalog metadata cannot override a synchronized room');
    await contexts[1].setOffline(true);
    await b.evaluate(async roomId=>{
      const {own,session,signal}=ownDirectoryFixture;
      const space=(await own.ownDirectorySpaces(session)).find(item=>item.roomId===roomId);
      await own.changeOwnSpace(session,space,true);
      await own.syncOwnSpaceDirectory(session,signal).catch(()=>{});
    },additional.roomId);
    await contexts[1].setOffline(false);
    await b.evaluate(()=>ownDirectoryFixture.own.syncOwnSpaceDirectory(ownDirectoryFixture.session,ownDirectoryFixture.signal));
    await a.evaluate(()=>ownDirectoryFixture.own.syncOwnSpaceDirectory(ownDirectoryFixture.session,ownDirectoryFixture.signal));
    assert.deepEqual(await a.evaluate(async info=>({listed:(await ownDirectoryFixture.own.ownDirectorySpaces(ownDirectoryFixture.session)).some(item=>item.roomId===info.roomId),retained:!!await ownDirectoryFixture.vault.readStoredRoom(info.localId)}),additional),{listed:false,retained:true});
    assert.equal(await a.evaluate(async roomId => (await ownDirectoryFixture.own.ownDirectorySpaces(ownDirectoryFixture.session,
      [{roomId,name:'旧目录中的名称'}])).some(item => item.roomId === roomId), additional.roomId), false, 'A stale access catalog cannot resurrect a synchronized removal');
    await b.reload();
    assert.equal(await b.evaluate(async roomId=>{
      const vault=await import('/src/lib/vault.ts'),own=await import('/src/lib/own-space-directory.ts');
      const session=await vault.unlockVault(await (await import('/src/lib/browser-room-key.ts')).browserRoomKey());
      return (await own.ownDirectorySpaces(session)).some(item=>item.roomId===roomId);
    },additional.roomId),false,'A cold browser must retain the authenticated removal without restoring a local default');
    console.log('PASS own-device directory: real encrypted HTTP, independent browsers, discovery without access/history, bidirectional rename, offline removal and cold re-entry');
  } finally { await Promise.all(contexts.map(context=>context.close())); }
}
