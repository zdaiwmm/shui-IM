import assert from 'node:assert/strict';
import path from 'node:path';

/** Actual product renderers and mount functions, with synthetic local data.
 * This checks presentation contracts, not authorization or real Safari chrome. */
export async function auditUiDetails(page, out) {
  const screens = {
    welcome: '.gateway-intro', create: '.gateway', invite: '#paste-form',
    corrupt: '.corrupt-vault-panel', recoveryUnlock: '#recovery-code-form',
    migration: '.gateway', binding: '.gateway', appearance: '.appearance-page',
    autoLock: '.auto-lock-page', notificationCopy: '.notification-copy-page',
    backupExport: '[data-local-backup-view="export"]', backupImport: '[data-local-backup-view="import"]',
    backupCode: '.backup-code-page', recovery: '.recovery-flow-page',
    joint: '#joint-open-code', jointCode: '.joint-code-sheet', historyCode: '.history-restore-panel',
    help: '.backup-help-page', history: '.release-history-content', practice: '.cover-practice-header',
    entrance: '.recovery-flow-page', tools: '.chat-tools', info: '.message-info-panel',
    menu: '.message-action-list', coverConfirm: '.cover-disable-panel',
    passwordCreate: '.password-create', passwordReturn: '.password-return', passwordOperation: '.password-operation-sheet',
    settings: '.space-drawer', presenceStyle: '.space-style-options', access: '.browser-access-modal',
    backupPrivacy: '.backup-privacy-panel', spaceInvite: '.space-invite-sheet',
    notice: '#notice', errorToast: '#app-toast', textSelection: '.message-text-selection',
  };
  const setup = async name => {
    await page.evaluate(async name => {
      const app = window.app, session = window.session;
      app.lockNow(); app.session = session; app.privacyCovered = false; app.runtimeEpoch++;
      app.runtimeAbort = new AbortController(); app.uiPreferencesHydrated = true;
      app.uiPreferences = {entranceCardDismissed:true, hiddenAlbumHintDismissed:true};
      localStorage.setItem('quiet-room:auto-lock-seconds','0');
      app.unreadCounter.markRead=async()=>{};app.scheduleUiPreferencesSave=()=>{};
      app.messages=new Map([1,2,3,4].map(i=>[i,{seq:i,clientMsgId:'detail-'+i,senderId:i%2?'synthetic-peer':session.vault.identity.publicBundle.deviceId,
        payload:{v:1,kind:'text',text:'合成验收消息 '+i,sentAt:'2026-10-10T02:00:00Z'},status:'delivered'}]));
      document.body.className='app-mode';app.renderChat();
      const root=app.root, signal=app.runtimeAbort.signal;
      const simple={welcome:'renderFirstRun',create:'renderCreate',invite:'renderPasteInvite',corrupt:'renderCorruptVault',recoveryUnlock:'renderRecoveryUnlock',migration:'renderPlatformMigration',binding:'renderRecoveredVaultBinding',appearance:'renderAppearanceSettings',autoLock:'renderAutoLockSettings',notificationCopy:'renderNotificationCopy',recovery:'renderRecoveryCenter',joint:'renderJointRecovery',help:'renderFeatureHelp',history:'renderReleaseHistory',practice:'renderCoverPractice',entrance:'renderEntranceCard'};
      if(simple[name]) { app[simple[name]](); return; }
      if(name==='backupExport'||name==='backupImport'||name==='historyCode') {
        app.renderLocalHistoryBackup(name==='backupExport'?'export':'import');
        if(name==='historyCode')root.querySelector('[data-restore]').click();
      }
      if(name==='backupCode') {
        app.renderLocalHistoryBackup('import');
        const {requestLocalBackupCode}=await import('/src/lib/backup-settings-ui.ts');
        void requestLocalBackupCode({root,session,file:new File(['fixture'],'合成备份.qrlocal'),signal,isActive:()=>true}).catch(()=>{});
      }
      if(name==='jointCode') { app.renderJointRecovery(null);root.querySelector('#joint-open-code').click(); }
      if(name==='tools')app.toggleChatTools();
      if(name==='info')app.showMessageInfo([...app.messages.values()][1]);
      if(name==='menu')app.openMessageActions(root.querySelector('.message'),[...app.messages.values()][0]);
      if(name==='textSelection')app.openMessageTextSelection([...app.messages.values()][0]);
      if(name==='notice')app.showNotice('已复制到剪贴板','info');
      if(name==='backupPrivacy') {
        app.renderLocalHistoryBackup('export');
        session.vault.cloudBackupPreference={enabled:false};
        const {paintCloudBackup}=await import('/src/lib/backup-settings-ui.ts');
        paintCloudBackup(root,session);root.querySelector('[data-cloud-switch]').click();
      }
      if(name==='spaceInvite') {
        const previous = Object.fromEntries(['roomId','accessToken','pairingSecret','creatorFingerprint','createdAt'].map(key=>[key,session.vault[key]]));
        Object.assign(session.vault, {roomId:'00000000-0000-4000-8000-000000000001',accessToken:'A'.repeat(43),pairingSecret:'B'.repeat(43),creatorFingerprint:'C'.repeat(43),createdAt:new Date().toISOString()});
        try { app.renderInviteWait(); } finally { Object.assign(session.vault,previous); }
      }
      if(name==='coverConfirm')app.confirmDisableCover();
      if(name.startsWith('password')) {
        const {requestPassword}=await import('/src/lib/password-dialog.ts');
        void requestPassword(root,{create:name==='passwordCreate',presentation:name==='passwordReturn'?'page':'sheet',title:'验证空间访问',context:'验证后继续本次操作。',spaceName:'两个人的空间',operation:'导出聊天备份',signal,isActive:()=>true,verify:async()=>{throw Error('合成验证失败')}}).catch(()=>{});
      }
      if(name==='settings'||name==='presenceStyle'||name==='errorToast') {
        const {mountSpaceDrawer,spaceIcons}=await import('/src/lib/space-drawer.ts');
        mountSpaceDrawer(root,{spaces:[{roomId:session.vault.roomId,name:'两个人的空间'}],currentRoom:session.vault.roomId,signal,initialSettings:true,actions:[{id:'appearance',label:'主题外观',icon:spaceIcons.appearance,run:()=>{}}],select:async()=>{},create:async()=>{},rename:async()=>{},styleChanged:()=>{},closed:()=>{}});
        if(name==='presenceStyle')root.querySelector('#presence-style-setting').click();
        if(name==='errorToast')app.showNotice('未能保存，请重试','error');
      }
      if(name==='access') {
        const {mountAccessApproval}=await import('/src/lib/browser-access-ui.ts');
        mountAccessApproval(root,{signal,title:'批准浏览器访问',description:'请核对此浏览器申请。',code:'123456',deadline:performance.now()+300000,approve:async()=>{},reject:async()=>{},closed:()=>{}});
      }
    }, name);
    await page.locator(screens[name]).waitFor();
    await page.evaluate(async()=>{
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));
    });
  };
  let checked=0;
  for(const scheme of ['light','dark']) {
    await page.emulateMedia({colorScheme:scheme});
    for(const width of [320,390,1440]) {
      await page.setViewportSize({width,height:700});
      for(const name of Object.keys(screens)) {
        await setup(name);
        const result=await page.evaluate(()=>({
          overflow:document.documentElement.scrollWidth>innerWidth+1,
          glass:[...document.querySelectorAll('.confirm-dialog,.recovery-code-panel,.space-name-dialog,.chat-tools,.message-action-list,.message-reaction-picker')].filter(e=>e.getClientRects().length).map(e=>getComputedStyle(e).backdropFilter),
          headings:[...document.querySelectorAll('.gateway-intro-content>h1,.cover-practice-header>h1,.backup-header>h1')].filter(e=>e.getClientRects().length).map(e=>parseFloat(getComputedStyle(e).fontSize)),
        }));
        assert.equal(result.overflow,false,`${name}/${scheme}/${width}: horizontal overflow`);
        assert.ok(result.glass.every(value=>value==='none'),`${name}: decorative glass`);
        assert.ok(result.headings.every(value=>value<=26),`${name}: legacy heading size`);
        if(name==='backupCode') {
          const input=await page.locator('#local-restore-code').evaluate(e=>({radius:getComputedStyle(e).borderRadius,background:getComputedStyle(e).backgroundColor,font:getComputedStyle(e).fontSize,height:e.clientHeight}));
          assert.equal(input.radius,'12px');assert.equal(input.font,'16px');assert.ok(input.height>=86);assert.notEqual(input.background,'rgb(255, 255, 255)');
        }
        if(name==='settings')assert.ok((await page.locator('.space-setting').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h>=52&&h<=53),'two-line settings rows must keep the 52px scale');
        if(name==='entrance')assert.ok((await page.locator('.recovery-flow-row').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h>=52&&h<=53),'entry settings rows must keep the 52px scale');
        if(name==='tools')assert.ok((await page.locator('.chat-tools>button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h>=44&&h<=65),'tool buttons must not retain 80px rows');
        if(name==='info') {
          assert.ok((await page.locator('.message-info-stages li').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h<=41));
          assert.ok((await page.locator('.message-info-panel').boundingBox()).height<490);
        }
        if(name==='passwordOperation') {
          const rect=await page.locator('.password-form').boundingBox();assert.ok(Math.abs(rect.y+rect.height-700)<1,'half sheet must meet the viewport bottom');
        }
        if(name==='notice'||name==='errorToast') {
          const style=await page.locator(screens[name]).evaluate(e=>({radius:getComputedStyle(e).borderRadius,font:getComputedStyle(e).fontSize,filter:getComputedStyle(e).backdropFilter}));
          assert.deepEqual(style,{radius:'12px',font:'13px',filter:'none'});
        }
        if(out&&width===390)await page.screenshot({path:path.join(out,`detail-${name}-${scheme}.png`)});
        checked++;
      }
    }
  }
  // Theme variants must share the fixed field geometry and semantic surface.
  for(const scheme of ['light','dark'])for(const theme of ['blue','green','purple','apricot']) {
    await page.emulateMedia({colorScheme:scheme});await page.setViewportSize({width:320,height:700});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await setup('backupCode');
    assert.equal(await page.locator('#local-restore-code').evaluate(e=>{const probe=document.createElement('i');probe.style.background='var(--surface)';e.after(probe);const matches=getComputedStyle(e).backgroundColor===getComputedStyle(probe).backgroundColor;probe.remove();return matches;}),true);
  }
  await page.evaluate(()=>document.documentElement.dataset.theme='blue');
  await page.emulateMedia({reducedMotion:'reduce'});await setup('menu');
  const reduced=await page.locator('.message-actions').evaluate(e=>getComputedStyle(e).transitionDuration);
  assert.equal(reduced,'0s');
  await page.emulateMedia({reducedMotion:'no-preference'});await setup('menu');
  await page.evaluate(()=>window.app.closeMessageActions());
  const exits=await page.locator('.message-actions.is-closing,.message-actions-backdrop.is-closing').evaluateAll(es=>es.map(e=>getComputedStyle(e).transitionDuration));
  assert.ok(exits.length===2&&exits.every(value=>value.split(',').every(time=>parseFloat(time)===.14)),`menu exit: ${exits}`);
  await page.locator('.message-actions').waitFor({state:'detached'});
  await setup('tools');await page.locator('#message-input').fill('第一行\n第二行\n第三行');
  const transitions=await page.locator('.composer-input-stack,.composer-field').evaluateAll(es=>es.map(e=>({property:getComputedStyle(e).transitionProperty,duration:getComputedStyle(e).transitionDuration})));
  assert.ok(transitions.every(value=>value.duration==='0s'||!/(margin|padding|width|height|all)/.test(value.property)),`layout animation: ${JSON.stringify(transitions)}`);
  await page.evaluate(()=>window.app.lockNow());
  assert.equal(await page.locator('.chat-shell,.message-actions,.password-sheet,.space-drawer').count(),0,'privacy cleanup stays immediate');
  console.log(`PASS UI detail audit: ${checked} actual page/dialog/menu presentations, four palettes, reduced motion, menu exit and composer geometry.`);
}
