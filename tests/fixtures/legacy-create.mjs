/** Explicit pre-mnemonic fixture for the retained QR3/QR4 regression journey.
 * New creation, exclusive invitations and personal roots are covered by the
 * Chamber browser suites. No test hook is shipped in the production bundle. */
export const legacyCreationPlugin = {
  name:'legacy-creation-observer',enforce:'pre',
  transform(code,id){if(id.endsWith('/src/main.ts'))return "import { installLegacyApp } from '/tests/fixtures/legacy-create.mjs';\n"+code.replace('const app = new QuietRoomApp(root);',"const app = new QuietRoomApp(root); window.__legacyApp=app; installLegacyApp(app);");},
};
export function installLegacyApp(app) {
    if(!app)throw new Error('Legacy fixture requires its explicit test observer');
    // Frozen pre-Chamber enrollment fixture. These suites exercise retained QR3/QR4
    // protocol journeys and the still-used profile editor; new production creation
    // (without a profile step) is covered by both Chamber browser suites.
    app.preparePasswordProtection=async(active,firstCreate=false)=>{
      const v=await import('/src/lib/vault.ts'),p=await import('/src/lib/password-protection.ts'),ui=await import('/src/lib/password-dialog.ts');
      await v.assertPasswordProtectionEnvironment();if(!active())throw new DOMException('设置已结束','AbortError');
      // The old enrollment waits on a cancellable remote create before it has a
      // vault. It must release numeric verification after obtaining the proof.
      // Chamber instead durably stages its intent and retains that canvas.
      return ui.requestPassword(app.root,{create:true,title:'设置应用锁',showBrowserHint:firstCreate,
        context:'应用锁用于这台浏览器的日常解锁，与手机锁屏密码不同。',isActive:active,
        signal:app.runtimeAbort?.signal,verify:p.deriveNumericPasswordCredential});
    };
    app.renderCreate=(initialProfile)=>{
      if(app.spaceCreationAbort||app.privacyCovered)return;
      const lifetime=new AbortController();app.spaceCreationAbort=lifetime;
      const epoch=app.runtimeEpoch,session=app.session,previous=app.activeSurface,fromList=app.spaceDrawerOpen;
      const scroll=app.root.querySelector('.space-drawer-scroll')?.scrollTop??0;
      const active=()=>!lifetime.signal.aborted&&!app.privacyCovered&&app.runtimeEpoch===epoch&&app.session===session;
      app.closeChatTools();app.setActiveSurface('away',true);
      void import('/src/lib/space-profile-ui.ts').then(({createSpaceProfile})=>createSpaceProfile(app.root,{
        signal:lifetime.signal,active,initialProfile,hasCredential:Boolean(session||app.deviceCredential),
        picker:operation=>operation(),
      })).then(async profile=>{
        if(!active())return;app.spaceCreationAbort=null;
        if(!profile){if(session&&fromList){if(!app.root.querySelector('.is-space-list-page.space-drawer-overlay:not(.is-closing)'))await app.openPrivateSpaces(()=>true,scroll);else app.setActiveSurface('away',true);}
          else{app.setActiveSurface(app.root.querySelector('.chat-shell')?'chat':previous);app.updatePeerStatus();}return;}
        app.newDeviceAlias='';if(session||app.browserProfile)await app.createPrivateSpace(profile);else app.renderCreateProtection(profile);
      }).catch(cause=>{if(active())app.showNotice(cause.message,'error');}).finally(()=>{if(app.spaceCreationAbort===lifetime)app.spaceCreationAbort=null;lifetime.abort();});
    };
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
