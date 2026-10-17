/** Explicit pre-mnemonic fixture for the retained QR3/QR4 regression journey.
 * New creation, exclusive invitations and personal roots are covered by the
 * Chamber browser suites. No test hook is shipped in the production bundle. */
export const legacyCreationPlugin = {
  name:'legacy-creation-observer',enforce:'pre',
  transform(code,id){if(id.endsWith('/src/main.ts'))return code.replace('const app = new QuietRoomApp(root);',"import { installLegacyApp } from '/tests/fixtures/legacy-create.mjs';\nconst app = new QuietRoomApp(root); window.__legacyApp=app; installLegacyApp(app);");},
};
export function installLegacyApp(app) {
    if(!app)throw new Error('Legacy fixture requires its explicit test observer');
    app.handleCreate=async(credential,active,profile)=>{
      const c=await import('/src/lib/crypto.ts'),api=await import('/src/lib/api.ts'),v=await import('/src/lib/vault.ts'),m=await import('/src/lib/mls.ts'),s=await import('/src/lib/spaces.ts'),b=await import('/src/lib/base64.ts');
      const identity=await c.generateIdentity(),accessToken=b.randomBase64Url(32),inviteToken=b.randomBase64Url(32);
      if(!active())return;
      const room=await api.createRoom(identity.publicBundle,accessToken,inviteToken,app.newDeviceName(),[]);
      if(!active()){await api.deleteRoom(room.roomId,accessToken);return;}
      const state=await api.getRoomState(room.roomId,accessToken);
      if(!active()){await api.deleteRoom(room.roomId,accessToken);return;}
      const vault={v:3,roomId:room.roomId,accessToken,inviteToken,role:'creator',pairingSecret:b.randomBase64Url(32),creatorFingerprint:await c.bundleFingerprint(identity.publicBundle),identity,members:state.members,
        lastSeq:0,lastReceiptSeq:0,pairingState:'ready',recoveryExperience:{welcomePending:true,coverEnabled:false},createdAt:room.createdAt,protocol:'mls-rfc9420'};
      vault.mls=await m.createCreatorMlsState(room.roomId,identity,state.members);identity.mlsPrivatePackage=undefined;vault.spaceRecoveryCode=app.newSpaceCollectionCode;
      const session=await v.createVault(vault,'','platform',credential,active);
      if(profile)await s.rememberLocalSpace(session,app.newSpaceCollectionCode,{roomId:room.roomId,...profile});
      app.session=session;app.rememberDeviceCredential(session);await app.openSession();
    };
}
export async function installLegacyCreationFixture(page) {
  await page.evaluate(async()=>{const {installLegacyApp}=await import('/tests/fixtures/legacy-create.mjs');installLegacyApp(window.__legacyApp);});
}
