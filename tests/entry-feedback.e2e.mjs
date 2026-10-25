import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {privacyFixture} from './helpers/privacy-fixture.mjs';
import {verifyReliabilitySurfaces} from './fixtures/reliability-surfaces.mjs';
const f=await privacyFixture({hasTouch:true});
const {page}=f;
try {
 await page.clock.resume();
 await page.evaluate(()=>fixture.fresh(0));
 const before=await page.locator('.chat-header').evaluate(el=>el.getBoundingClientRect().height);
 await page.evaluate(()=>document.documentElement.dataset.keyboardOpen='true');
 assert.equal(await page.locator('.chat-header').evaluate(el=>el.getBoundingClientRect().height),before);
 assert.equal(await page.locator('#chat-settings').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
 assert.equal(await page.locator('#entrance-card-banner').count(),0);
 await page.evaluate(async()=>{
  delete document.documentElement.dataset.keyboardOpen;
  const meta=document.createElement('meta');meta.id='system-chrome-color';meta.name='theme-color';document.head.append(meta);
  window.disposeChrome=(await import('/src/lib/system-chrome.ts')).mountSystemChrome();
 });
 assert.equal(await page.locator('#system-chrome-color').getAttribute('content'),await page.locator('.chat-header').evaluate(el=>getComputedStyle(el).backgroundColor));
 for (const height of [844,500,400]) {
  await page.setViewportSize({width:390,height});
  await page.evaluate(async()=>{
   const {requestPassword}=await import('/src/lib/password-dialog.ts');
   void requestPassword(document.querySelector('#app'),{title:'输入空间密码',context:'请输入此空间已有的密码，确认后继续本次操作。',spaceName:'海边小屋',operation:'保存恢复卡',isActive:()=>true,verify:async()=>true}).catch(()=>{});
  });
  await page.locator('.password-sheet.is-visible').waitFor();await page.waitForTimeout(300);
  const layout=await page.locator('.password-page-content').evaluate(el=>({client:el.clientHeight,scroll:el.scrollHeight,button:document.querySelector('.password-actions').getBoundingClientRect().bottom,viewport:innerHeight}));
  assert.ok(layout.scroll<=layout.client+1,`Password content fits ${height}px: ${JSON.stringify(layout)}`);
  assert.ok(layout.button<=layout.viewport);
  await page.locator('[data-password-cancel]').click();await page.locator('.password-sheet').waitFor({state:'detached'});
 }
 // Semantic cancellation is immediate; the inert outgoing presentation completes.
 const exit=await page.evaluate(async()=>{
  const {mountDialog}=await import('/src/lib/dialog.ts');const owner=new AbortController();
  const sheet=document.createElement('div');sheet.className='avatar-source-overlay';sheet.innerHTML='<section class="avatar-source-sheet"><button>关闭</button></section>';document.querySelector('#app').append(sheet);
  const dialog=mountDialog(sheet,{signal:owner.signal,isActive:()=>!owner.signal.aborted,onClose:()=>owner.abort()});
  await new Promise(r=>setTimeout(r,280));dialog.close();window.outgoingSheet=sheet;
  return {aborted:owner.signal.aborted,connected:sheet.isConnected,inert:sheet.inert};
 });
 assert.deepEqual(exit,{aborted:true,connected:true,inert:true});await page.waitForFunction(()=>!outgoingSheet.isConnected);
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{
  document.querySelector('#app').innerHTML='<section class="gallery-shell"><header class="subpage-header"><button class="icon-button" aria-label="返回">‹</button><h1>相册</h1><span></span></header><div id="gallery-grid" class="gallery-grid"></div></section>';
  document.querySelector('#gallery-grid').append(fixture.app.galleryEmptyState(false,'照片和视频'));
 });
 assert.equal(await page.locator('.entry-art-gallery').count(),1);
 const dir=process.env.ENTRY_FEEDBACK_EVIDENCE;
 if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:`${dir}/gallery-empty.png`});}
 await verifyReliabilitySurfaces(page);
 assert.deepEqual(f.errors,[]);
 console.log('PASS acceptance refinement: settings hit target, stable header, chrome color, compact password, semantic close + animated exit, gallery empty state.');
}finally{await f.close()}
