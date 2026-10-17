import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';

/** Actual product renderers and mount functions, with synthetic local data.
 * This checks presentation contracts, not authorization or real Safari chrome. */
export async function auditUiDetails(page, out) {
  const reference = await page.context().browser().newPage();
  let referenceType;
  try {
    await reference.goto(new URL('/docs/requirements/2026-10-10-ui-system-exploration/prototype/index.html', page.url()).href);
    referenceType = await reference.evaluate(() => {
      const row = getComputedStyle(document.querySelector('.setting-row')), title = getComputedStyle(document.querySelector('.settings-header h2'));
      return { font: row.fontSize, weight: row.fontWeight, family: row.fontFamily, smoothing: row.webkitFontSmoothing, titleWeight: title.fontWeight };
    });
  } finally { await reference.close(); }
  const screens = {
    welcome: '.gateway-intro', create: '.gateway', profile: '.space-profile-page', invite: '#paste-form',
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
    backupPrivacy: '.backup-privacy-panel', spaceInvite: '.entry-chat-guidance',
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
      if(name==='create') { app.renderCreateProtection({name:'合成空间',avatar:{v:1,kind:'emoji',emoji:'1f60a',background:0}}); return; }
      const simple={welcome:'renderFirstRun',profile:'renderCreate',invite:'renderPasteInvite',corrupt:'renderCorruptVault',recoveryUnlock:'renderRecoveryUnlock',migration:'renderPlatformMigration',binding:'renderRecoveredVaultBinding',appearance:'renderAppearanceSettings',autoLock:'renderAutoLockSettings',notificationCopy:'renderNotificationCopy',recovery:'renderRecoveryCenter',joint:'renderJointRecovery',help:'renderFeatureHelp',history:'renderReleaseHistory',practice:'renderCoverPractice',entrance:'renderEntranceCard'};
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
        const previous = Object.fromEntries(['roomId','accessToken','pairingSecret','creatorFingerprint','createdAt','members','role'].map(key=>[key,session.vault[key]]));
        Object.assign(session.vault, {roomId:'00000000-0000-4000-8000-000000000001',accessToken:'A'.repeat(43),pairingSecret:'B'.repeat(43),creatorFingerprint:'C'.repeat(43),createdAt:new Date().toISOString(),role:'creator',members:session.vault.members.filter(member=>member.role==='creator')});
        app.messages.clear();
        try { app.renderChat(); } finally { Object.assign(session.vault,previous); }
      }
      if(name==='coverConfirm')app.confirmDisableCover();
      if(name.startsWith('password')) {
        const {requestPassword}=await import('/src/lib/password-dialog.ts');
        void requestPassword(root,{create:name==='passwordCreate',presentation:name==='passwordReturn'?'page':'sheet',title:'验证空间访问',context:'验证后继续本次操作。',spaceName:'两个人的空间',operation:'导出聊天备份',signal,isActive:()=>true,verify:async()=>{throw Error('合成验证失败')}}).catch(()=>{});
      }
      if(name==='settings'||name==='presenceStyle'||name==='errorToast') {
        const {mountSpaceDrawer,spaceIcons}=await import('/src/lib/space-drawer.ts');
        const actions=[['appearance-settings','主题外观','appearance'],['auto-lock-settings','自动锁定','key'],['notification-settings','通知','bell'],['manage-devices','设备管理','device'],['passkey-management','通行密钥','key'],['backup-settings','备份与恢复','history'],['local-history-backup','导出聊天备份','download'],['local-history-restore','导入聊天备份','upload'],['cover-practice-menu','自动遮蔽','cover'],['release-history','更新记录','history']].map(([id,label,icon])=>({id,label,icon:spaceIcons[icon],run:()=>{}}));
        mountSpaceDrawer(root,{spaces:[{roomId:session.vault.roomId,name:'两个人的空间'}],currentRoom:session.vault.roomId,signal,initialSettings:true,actions,select:async()=>{},create:async()=>{},rename:async()=>{},styleChanged:()=>{},closed:()=>{}});
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
  let checked=0;const presentations=[];
  for(const scheme of ['light','dark']) {
    await page.emulateMedia({colorScheme:scheme});
    for(const width of [320,390,768,1024,1440]) {
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
        const helpers=await page.locator('#app .field-hint,#app .privacy-note,#app .space-style-copy small,#app .space-presence-note,#app .chat-guide > small,#app .device-toolbar span,#app .notification-capability > span')
          .evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length&&!node.closest('[inert],[hidden],.sr-only')&&getComputedStyle(node).visibility==='visible')
            .map(node=>({role:node.className,size:parseFloat(getComputedStyle(node).fontSize)})));
        assert.ok(helpers.every(value=>value.size>=12),`${name}: readable helper roles ${JSON.stringify(helpers)}`);
        if(name==='backupCode') {
          const input=await page.locator('#local-restore-code').evaluate(e=>({radius:getComputedStyle(e).borderRadius,background:getComputedStyle(e).backgroundColor,font:getComputedStyle(e).fontSize,height:e.clientHeight}));
          assert.equal(input.radius,'12px');assert.equal(input.font,'16px');assert.ok(input.height>=86);assert.notEqual(input.background,'rgb(255, 255, 255)');
        }
        if(name==='settings') {
          assert.ok((await page.locator('.space-setting').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h>=44&&h<=45),'P1 single-line settings rows are 44px');
          assert.ok(Math.abs((await page.locator('.space-drawer-header').boundingBox()).height-48)<1,'P1 settings header is 48px');
          assert.equal(await page.locator('.space-setting').first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize)),14,'P1 settings copy is 14px');
          const actualType=await page.evaluate(()=>{
            const row=getComputedStyle(document.querySelector('.space-setting')), title=getComputedStyle(document.querySelector('.space-drawer-header h2'));
            return {font:row.fontSize,weight:row.fontWeight,family:row.fontFamily,smoothing:row.webkitFontSmoothing,titleWeight:title.fontWeight};
          });
          assert.deepEqual(actualType,referenceType,'settings typography follows the confirmed P1 renderer');
          const rect=await page.locator('.space-drawer').boundingBox();assert.ok(rect.x===0&&Math.abs(rect.width-width)<1,'mobile settings presentation fills the page');
        }
        if(name==='create') {
          assert.equal(await page.locator('.entry-protection,.entry-support,.recovery-explanation,#new-device-alias').count(),0,'creation uses the confirmed compact protection layout');
          const fields=await page.locator('#new-passkey-name').evaluateAll(es=>es.map(e=>({height:e.getBoundingClientRect().height,font:parseFloat(getComputedStyle(e).fontSize)})));
          if(fields.length) { assert.equal(fields.length,1);assert.ok(fields.every(e=>e.height>=44&&e.font>=16),'passkey name retains readable size and touch target');assert.equal(await page.locator('[data-device-verify]').textContent(),'设置应用锁并创建密室'); }
          else { assert.equal(await page.locator('[data-device-verify]').textContent(),'设置应用锁并创建密室');assert.match(await page.locator('.gateway-heading').textContent(),/使用密码保护您的空间隐私/); }
        }
        if(name==='spaceInvite') { assert.equal(await page.locator('.space-invite-sheet').count(),0);assert.ok((await page.locator('#invite-url').inputValue()).includes('#'));assert.equal(await page.locator('#copy-invite').count(),1); }
        if(name==='coverConfirm') {
          const box=await page.locator('.simple-confirm').boundingBox();assert.ok(box.width<=281);
          const actions=await page.locator('.simple-confirm-actions button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().toJSON()));assert.ok(Math.abs(actions[0].y-actions[1].y)<1,'simple confirmation actions share a row');
        }
        if(name==='entrance')assert.ok((await page.locator('.recovery-flow-row').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h>=52&&h<=53),'entry settings rows must keep the 52px scale');
        if(name==='tools')assert.ok((await page.locator('.chat-tools>button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h>=44&&h<=65),'tool buttons must not retain 80px rows');
        if(name==='info') {
          assert.ok((await page.locator('.message-info-stages li').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))).every(h=>h<=41));
          assert.ok((await page.locator('.message-info-panel').boundingBox()).height<490);
        }
        if (['passwordOperation','historyCode','backupPrivacy','info'].includes(name)) {
          const sheet = await page.locator('[data-sheet-panel]').evaluate(panel => ({
            inset: getComputedStyle(panel).paddingLeft,
            border: getComputedStyle(panel).borderTopWidth,
            handle: panel.querySelector('.half-sheet-handle')?.getBoundingClientRect().height,
            closeIcons: panel.querySelectorAll('button svg.lucide-x').length,
          }));
          assert.deepEqual(sheet,{inset:'20px',border:'0px',handle:44,closeIcons:0},`${name}: shared sheet frame`);
        }
        if(name==='jointCode') {
          const frame=await page.locator('.recovery-code-panel').boundingBox();
          assert.ok(Math.abs(frame.height-700)<2&&frame.width<=480,'recovery card uses the full-height page');
          const title=await page.locator('.recovery-code-heading h2').boundingBox();
          assert.ok(title.width>250&&title.height<80,'recovery heading stays horizontal at narrow widths');
        }
        if(name==='passwordOperation') {
          const rect=await page.locator('.password-form').boundingBox();assert.ok(Math.abs(rect.y+rect.height-700)<1,'half sheet must meet the viewport bottom');
        }
        if(['historyCode','backupPrivacy'].includes(name)) {
          const panel=await page.locator(`${screens[name]} .recovery-code-panel, ${screens[name]}.recovery-code-panel`).first().boundingBox();
          if(width<1024)assert.ok(Math.abs(panel.y+panel.height-700)<1,`${name}: secondary recovery sheet meets the viewport bottom`);
          assert.equal(await page.locator(`${screens[name]} h2`).first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize)),17,'secondary recovery heading shares the compact scale');
        }
        if(name==='notice'||name==='errorToast') {
          const style=await page.locator(screens[name]).evaluate(e=>({radius:getComputedStyle(e).borderRadius,font:getComputedStyle(e).fontSize,filter:getComputedStyle(e).backdropFilter}));
          assert.deepEqual(style,{radius:'12px',font:'13px',filter:'none'});
        }
        presentations.push({name,scheme,width,...result});
        if(out)await page.screenshot({path:path.join(out,`detail-${name}-${width===390?'':width+'-'}${scheme}.png`)});
        checked++;
      }
    }
  }
  await page.setViewportSize({width:320,height:844});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
  await page.evaluate(()=>document.documentElement.style.fontSize='200%');
  for(const name of Object.keys(screens)) {
    await setup(name);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${name}: 200% text must reflow`);
    if(out)await page.screenshot({path:path.join(out,`detail-${name}-text200.png`)});
  }
  await page.evaluate(()=>document.documentElement.style.fontSize='');await page.emulateMedia({reducedMotion:'no-preference'});
  if(out)await writeFile(path.join(out,'ui-details.json'),JSON.stringify({synthetic:true,realDevice:false,presentations,text200:Object.keys(screens)},null,2));
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
  assert.ok(exits.length===2&&exits.every(value=>value.split(',').every(time=>parseFloat(time)===.24)),`V1.4 menu exit: ${exits}`);
  await page.locator('.message-actions').waitFor({state:'detached'});
  // Sample the real three-part overlay every frame, including a reversed
  // close. Every visual part must inherit the same translation and velocity.
  await setup('menu'); await page.evaluate(()=>window.app.closeMessageActions());
  await page.locator('.message-actions').waitFor({state:'detached'});
  const samples=await page.evaluate(async()=>{
    const app=window.app, row=document.querySelector('.message:last-of-type');
    const message=[...app.messages.values()].at(-1);
    app.openMessageActions(row,message);
    const result=[];
    for(let i=0;i<30;i++) {
      await new Promise(requestAnimationFrame);
      const group=document.querySelector('.message-action-group'); if(!group)break;
      const y=selector=>group.querySelector(selector)?.getBoundingClientRect().top;
      result.push({preview:y('.message-action-preview'),picker:y('.message-reaction-picker'),menu:y('.message-action-list')});
      if(i===7)app.closeMessageActions();
    }
    return result;
  });
  assert.ok(samples.length>10,'preview travels over multiple rendered frames');
  for(const part of ['picker','menu']) {
    const offsets=samples.map(sample=>sample[part]-sample.preview);
    assert.ok(offsets.every(value=>Math.abs(value-offsets[0])<.1),`${part}: whole group moves together`);
  }
  assert.ok(samples.some((sample,i)=>i>0&&Math.abs(sample.preview-samples[i-1].preview)>.1),'bottom message must actually travel');
  assert.ok(samples.every((sample,i)=>i===0||Math.abs(sample.preview-samples[i-1].preview)<100),'no teleport frame during reversal');
  await page.locator('.message-actions').waitFor({state:'detached'});
  await setup('tools');await page.locator('#message-input').fill('第一行\n第二行\n第三行');
  const transitions=await page.locator('.composer-input-stack,.composer-field').evaluateAll(es=>es.map(e=>({property:getComputedStyle(e).transitionProperty,duration:getComputedStyle(e).transitionDuration})));
  assert.ok(transitions.every(value=>value.duration==='0s'||!/(margin|padding|width|height|all)/.test(value.property)),`layout animation: ${JSON.stringify(transitions)}`);
  await page.evaluate(()=>window.app.lockNow());
  assert.equal(await page.locator('.chat-shell,.message-actions,.password-sheet,.space-drawer').count(),0,'privacy cleanup stays immediate');
  console.log(`PASS UI detail audit: ${checked} actual page/dialog/menu presentations, four palettes, reduced motion, menu exit and composer geometry.`);
}
