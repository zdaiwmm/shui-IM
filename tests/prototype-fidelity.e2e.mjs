import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const out = process.argv[2]; if (out) await mkdir(out, {recursive:true});
const metrics = [];
const vite = await createServer({configFile:false,root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false}});
vite.middlewares.use('/__audit',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><div id="app"></div>');});
let browser;
async function shot(page,name){if (!out) return;await page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));});await page.screenshot({path:path.join(out,name+'.png')});}
try {
 await vite.listen();const url=`http://localhost:${vite.httpServer.address().port}`;
 browser=await chromium.launch(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : process.env.CI ? {} : {channel:'chrome'});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.65'});
 await context.addInitScript(()=>{delete window.PublicKeyCredential;});
 const page=await context.newPage();await page.goto(url+'/__audit');
 await page.evaluate(async()=>{
  await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
  const {QuietRoomApp}=await import('/src/app.ts');window.app=new QuietRoomApp(document.querySelector('#app'));await app.start();
 });
 await shot(page,'F15-wechat-welcome');await page.locator('#create-room').click(); await page.locator('.password-create').waitFor(); await shot(page,'F15-wechat-create-click');
 assert.equal(await page.locator('.password-page').count(),1); await page.locator('[data-password-cancel]').click(); await page.locator('.password-sheet').waitFor({state:'detached'});
 await page.evaluate(()=>app.renderJointRecovery(null));await shot(page,'F01-recovery-entry'); assert.equal(await page.locator('.recovery-steps [aria-current=step]').textContent(),'1验证恢复码');await page.locator('#joint-open-code').click();await shot(page,'F01-recovery-code'); await page.locator('#joint-code-close').click(); await page.locator('.joint-code-sheet').waitFor({state:'detached'});
 await page.evaluate(async()=>{
  app.root.replaceChildren();const {createVault}=await import('/src/lib/vault.ts');const {generateIdentity}=await import('/src/lib/crypto.ts');
  const identity=await generateIdentity(),other=await generateIdentity();
  window.session=await createVault({v:1,roomId:'synthetic-audit-room',role:'creator',identity,accessToken:'synthetic-only',pairingSecret:'',creatorFingerprint:'synthetic-only',lastSeq:3,createdAt:'2026-09-30T00:00:00Z',protocol:'legacy-v1',members:[{...identity.publicBundle,role:'creator',status:'active',deviceName:'Mac · Chrome'},{...other.publicBundle,role:'joiner',status:'active',deviceName:'iPhone · Safari'}]},'synthetic audit password','password');
  app.session=session;app.privacyCovered=false;app.runtimeAbort=new AbortController();app.uiPreferences={entranceCardDismissed:false,hiddenAlbumHintDismissed:true};app.uiPreferencesHydrated=true;
  app.updateSafetyCode=async()=>{};app.updateBackgroundNotificationControl=async()=>{};app.connectionState='connected';app.rolePresence={creator:true,joiner:true};app.uiPreferences.hiddenAlbumHintDismissed=false;app.messages=new Map([['one',{seq:1,clientMsgId:'synthetic-one',senderId:other.publicBundle.deviceId,payload:{v:1,kind:'text',text:'周末去海边走走？',sentAt:'2026-09-30T02:21:00Z'},status:'delivered'}],['two',{seq:2,clientMsgId:'synthetic-two',senderId:identity.publicBundle.deviceId,payload:{v:1,kind:'text',text:'好呀，周六上午出发。',sentAt:'2026-09-30T02:22:00Z'},status:'delivered'}],['three',{seq:3,clientMsgId:'synthetic-three',senderId:other.publicBundle.deviceId,payload:{v:1,kind:'text',text:'那我来找路线。',sentAt:'2026-09-30T02:22:00Z'},status:'delivered'}]]);
  app.renderChat();app.availableReleaseId='synthetic-update';app.renderReleaseUpdateBanner();
 });await shot(page,'F03-update-entry');
 await page.evaluate(()=>app.showMessageInfo([...app.messages.values()][1]));await shot(page,'F05-message-information-sample');await page.locator('[data-info-done]').click();await page.locator('.message-info-sheet').waitFor({state:'detached'});
 await page.evaluate(()=>app.confirmDisableCover());await shot(page,'F08-disable-confirm'); await page.locator('.cover-disable-close').click(); await page.locator('#disable-cover-dialog').waitFor({state:'detached'});
 for(const theme of ['light','dark']) {
  await page.emulateMedia({colorScheme:theme});
  for(const width of [320,390,768,1440]) {
   await page.setViewportSize({width,height:844});
   const screens=[['F01-recovery-entry',()=>app.renderJointRecovery(null)],['F07-recovery-guide',()=>{app.session=session;app.renderRecoveryCenter();}],['F13-backup-help',()=>{app.session=session;app.renderFeatureHelp(()=>app.renderLocalHistoryBackup());}],['F10-favorites-empty',()=>{app.session=session;app.galleryMode='favorites';app.renderGallery('images');}],['F09-chat-sample',()=>{app.session=session;app.renderChat();app.renderMessages({scroll:'bottom'});}]];
   for(const [name,render] of screens){
    await page.evaluate(render);if(name==='F10-favorites-empty')await page.locator('.favorites-empty').waitFor();await page.waitForTimeout(60);await shot(page,`${name}-${width}-${theme}`);
    const value=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,controls:[...document.querySelectorAll('button:not([hidden])')].filter(b=>b.getClientRects().length&&!b.closest('[hidden]')).map(b=>({label:b.getAttribute('aria-label')||b.textContent.trim(),width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))}));
    assert.equal(value.overflow,false,`${name} ${width} ${theme} overflows`); metrics.push({name,theme,...value});
   }
  }
 }
 await page.setViewportSize({width:320,height:844});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 await page.evaluate(()=>{document.documentElement.style.fontSize='200%';app.renderFeatureHelp(()=>app.renderChat());});await shot(page,'F13-help-320-text-200');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.evaluate(()=>{document.documentElement.style.fontSize='';app.renderChat();app.renderMessages({scroll:'bottom'});document.querySelector('#message-input').value='周六上午见！';});
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'no-preference'});
 const timeline=[];
 await shot(page,'F14-before');
 await page.evaluate(()=>{window.panelStart=performance.now();document.querySelector('#open-chat-tools').click();});
 for(const target of [0,100,240]){
  await page.evaluate(target=>new Promise(resolve=>setTimeout(resolve,Math.max(0,target-(performance.now()-panelStart)))),target);
  const at=await page.evaluate(()=>performance.now()-panelStart);
  // Sample while the transition is running; the static shot helper waits for
  // animations to finish and would turn every frame into an endpoint image.
  if(out)await page.screenshot({path:path.join(out,`F14-panel-${target}ms.png`)});
  const after=await page.evaluate(()=>performance.now()-panelStart);
  timeline.push({targetMs:target,actualBeforeScreenshotMs:at,actualAfterScreenshotMs:after});
 }
 assert.equal(await page.locator('#message-input').inputValue(),'周六上午见！');
 for(let index=0;index<10;index++){await page.evaluate(()=>{app.closeChatTools();app.toggleChatTools();});await page.waitForTimeout(24);}
 await page.evaluate(()=>app.closeChatTools());await page.waitForTimeout(340);assert.equal(await page.locator('#message-input').inputValue(),'周六上午见！');
 await page.evaluate(()=>app.lockNow());assert.equal(await page.locator('#message-input').count(),0,'Explicit lock must clear private UI immediately');
 if(out)await writeFile(path.join(out,'fidelity-layouts.json'),JSON.stringify({engine:'desktop Chromium',realDevice:false,syntheticPresentationFixture:true,metrics,timeline},null,2));
 const prototype=await browser.newPage({viewport:{width:390,height:844}});
 for(const [name,query] of [['P03','page=password'],['P04','page=unlock&method=password'],['P06','page=reauth&purpose=export'],['R03','page=restore'],['R06','page=recoveryWaiting']]){
  await prototype.goto(url+'/docs/requirements/2026-09-30-experience-optimization/prototype/index.html?'+query+'&v=7');
  await prototype.addStyleTag({content:'.review,.stagebar,.annotation,.auth-tools,#announce{display:none!important}.layout{display:block!important;padding:0!important;margin:0!important}.stage{display:block!important}.phone{width:100vw!important;height:100dvh!important;min-height:0!important;border:0!important;box-shadow:none!important}.change-marker{display:none!important}.annotated{outline:0!important}'});
  await shot(prototype,'prototype-'+name);
 }
 console.log('PASS full product cascade, F01/F03/F05/F07/F08/F09/F10/F13 responsive surfaces, draft-preserving panel reversal and immediate lock. Synthetic presentation fixture; desktop Chromium.');
}finally{await browser?.close();await vite.close();}
