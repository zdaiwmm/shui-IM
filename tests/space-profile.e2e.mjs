import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { fillFormInput } from './helpers/form-input.mjs';
const evidence=process.argv[2];
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'profile-fixture',configureServer(server){server.middlewares.use('/__profile',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');});}}]});
let browser;
try {
  await vite.listen(); if(evidence)await mkdir(evidence,{recursive:true});
  for(const engine of [chromium,webkit]) {
    browser=await engine.launch(engine===chromium&&!process.env.CI?process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}:{});
    const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',cause=>errors.push(cause.message));
    await page.goto(`http://localhost:${vite.httpServer.address().port}/__profile`);
    await page.evaluate(async()=>{
      await(await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
      window.ui=await import('/src/lib/space-profile-ui.ts');
      (await import('/src/lib/form-input.ts')).mountFormInputs(document.querySelector('#app'));
      window.outstanding=new Set();
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=blob=>{const url=create(blob);outstanding.add(url);return url;};
      URL.revokeObjectURL=url=>{outstanding.delete(url);revoke(url);};
      window.mount=(options={})=>{
        window.abort?.abort();window.abort=new AbortController();window.result=undefined;
        document.querySelector('#app').innerHTML='<main class="chat-shell"><textarea id="original-draft">未发送的草稿</textarea><button id="origin">创建空间</button></main>';
        window.original=document.querySelector('#original-draft');document.querySelector('#origin').focus();
        void ui.createSpaceProfile(document.querySelector('#app'),{signal:abort.signal,active:()=>!abort.signal.aborted,hasCredential:true,picker:operation=>operation(),...options}).then(value=>window.result=value);
      }; mount();
    });
    await page.locator('#profile-done').click();assert.match(await page.locator('.space-profile-content .form-error').innerText(),/1–40/);
    await fillFormInput(page,page.locator('#new-space-name'),'海边小屋');
    assert.ok(await page.locator('#new-space-name').evaluate(input=>document.querySelector('.space-profile-label').getBoundingClientRect().bottom<input.getBoundingClientRect().top));
    assert.equal(await page.locator('#new-space-name').evaluate(input=>getComputedStyle(input).outlineStyle),'none');
    await page.locator('#change-space-avatar').click();await page.locator('.avatar-source-overlay.is-visible').waitFor();
    assert.equal(await page.locator('.avatar-source-sheet h2,.avatar-source-sheet .icon-button').count(),0);
    assert.equal(await page.locator('.avatar-source-sheet .space-avatar').count(),0,'The source sheet has no duplicated avatar');
    assert.match(await page.locator('#choose-art').innerText(),/使用表情/);
    await page.keyboard.press('Escape');await page.locator('.avatar-source-overlay').waitFor({state:'detached'});
    assert.equal(await page.locator('#new-space-name').inputValue(),'海边小屋');
    await page.locator('#change-space-avatar').click();await page.locator('#choose-art').click();
    assert.equal(await page.locator('.space-profile-page:not(.local-page-outgoing)').evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('.space-profile-overlay').evaluate(el=>getComputedStyle(el).backgroundColor),'The entering editor owns an opaque page canvas');
    assert.equal(await page.locator('#profile-back').evaluate(button => document.activeElement === button),true,'Changing pages keeps keyboard focus inside the modal');
    assert.equal(await page.locator('[data-avatar-choice]').count(),64);
    await page.waitForFunction(()=>document.querySelectorAll('.avatar-emoji-grid img[data-playing="true"]').length>=12);
    assert.ok(await page.locator('.avatar-emoji-grid button[aria-pressed=false] img[data-playing=true]').count()>0,'Unselected visible emoji also animate');
    assert.equal(await page.locator('.avatar-emoji-grid svg').count(),0,'No static icon avatar options');
    await page.locator('[data-background="4"]').click();
    const chosen=await page.locator('[data-avatar-choice]').nth(1).getAttribute('data-avatar-choice');
    await page.locator('[data-avatar-choice]').nth(1).click();
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>[...document.querySelectorAll('img[data-avatar-emoji]')].every(image=>image.dataset.playing==='false'&&image.src.includes('-still.webp')));
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.setViewportSize({width:390,height:500});
    await page.locator('[data-avatar-choice]').last().scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('.avatar-emoji-grid button:last-child img').dataset.playing==='true');
    await page.waitForFunction(()=>document.querySelector('.avatar-emoji-grid button:first-child img').dataset.playing==='false');
    if(evidence)await page.screenshot({path:path.join(evidence,`avatar-editor-${engine.name()}.png`)});
    await page.locator('#profile-done').click();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#space-profile-avatar img').getAttribute('data-avatar-emoji'),chosen);
    await page.locator('#change-space-avatar').click();
    const cancelPicker=page.waitForEvent('filechooser');await page.locator('#choose-photo').click();
    assert.equal(await page.locator('.avatar-source-overlay').count(),1,'Source remains mounted while picking');
    await(await cancelPicker).setFiles([]);
    await page.locator('#choose-photo').waitFor({state:'visible'});
    assert.equal(await page.locator('.avatar-source-overlay').count(),1,'Cancelled selection preserves the source sheet');
    const image=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const c=canvas.getContext('2d');c.fillStyle='#e3bb79';c.fillRect(0,0,640,480);c.fillStyle='#508fac';c.fillRect(320,0,320,480);return canvas.toDataURL('image/png').split(',')[1];});
    const picker=page.waitForEvent('filechooser');await page.locator('#choose-photo').click();
    await(await picker).setFiles({name:'synthetic-avatar.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
    await page.locator('#photo-crop-stage').waitFor();
    assert.equal(await page.locator('input[type=range]').count(),0);
    assert.equal(await page.locator('#photo-crop-stage').evaluate(el=>getComputedStyle(el).touchAction),'none');
    await page.locator('#photo-crop-stage').focus();await page.keyboard.press('+');await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#crop-zoom').innerText(),'110%');
    const before=await page.locator('#photo-crop-stage img').getAttribute('style');
    // Coordinate gestures do not get Playwright's locator stability checks.
    // Let the real page transition finish before capturing the drag/pinch origin.
    await page.locator('#photo-crop-stage').evaluate(async stage => {
      const page = stage.closest('.space-profile-page');
      const effects = page.getAnimations().filter(animation =>
        Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
      await Promise.all(effects.map(animation => animation.finished));
    });
    const rect=await page.locator('#photo-crop-stage').boundingBox();
    assert.ok(await page.locator('#photo-crop-stage').evaluate(stage => {
      const box=stage.getBoundingClientRect();
      return stage.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));
    }), 'The settled crop center must receive the pointer gesture');
    await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+30,rect.y+rect.height/2+10,{steps:4});await page.mouse.up();
    assert.notEqual(await page.locator('#photo-crop-stage img').getAttribute('style'),before);
    await page.locator('#crop-reset').click();assert.equal(await page.locator('#crop-zoom').innerText(),'100%');
    if(engine===chromium) {
      const client=await page.context().newCDPSession(page),cx=rect.x+rect.width/2,cy=rect.y+rect.height/2;
      const points=radius=>[{x:cx-radius,y:cy,id:1},{x:cx+radius,y:cy,id:2}];
      await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(35)});
      await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(70)});
      await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert.equal(await page.locator('#crop-zoom').innerText(),'200%','Real two-contact touch pinch changes image scale');
      await client.detach();
    }
    if(evidence)await page.screenshot({path:path.join(evidence,`avatar-crop-${engine.name()}.png`)});
    await page.locator('#profile-done').click();
    assert.equal(await page.locator('#new-space-name').inputValue(),'海边小屋');
    assert.equal(await page.evaluate(()=>outstanding.size),0);
    await page.locator('#profile-done').click();await page.locator('.space-profile-overlay').waitFor({state:'detached'});
    const result=await page.evaluate(()=>window.result);
    assert.equal(result.name,'海边小屋');assert.equal(result.avatar.kind,'image');
    assert.ok(Buffer.from(result.avatar.data.split(',')[1],'base64').length<=2048);
    assert.equal(await page.evaluate(()=>original===document.querySelector('#original-draft')&&!original.closest('[inert]')),true);
    for(const scheme of ['light','dark'])for(const viewport of [{width:320,height:480},{width:390,height:844},{width:1280,height:820}]) {
      await page.setViewportSize(viewport);await page.evaluate(scheme=>{document.documentElement.dataset.colorScheme=scheme;mount();},scheme);
      assert.ok(await page.locator('#profile-done').evaluate(button=>{const r=button.getBoundingClientRect();return r.height===44&&r.bottom<=innerHeight;}));
      await page.locator('.space-profile-overlay.is-visible').waitFor();
      if(evidence&&viewport.width===390)await page.screenshot({path:path.join(evidence,`space-create-${scheme}-${engine.name()}.png`),animations:'disabled'});
      await page.evaluate(()=>abort.abort());assert.equal(await page.locator('.space-profile-overlay,.avatar-source-overlay').count(),0);
      assert.equal(await page.evaluate(()=>window.result),null);
    }
    await page.evaluate(()=>mount());await page.locator('#change-space-avatar').click();await page.evaluate(()=>abort.abort());
    assert.equal(await page.locator('.space-profile-overlay,.avatar-source-overlay').count(),0);
    assert.equal(await page.evaluate(()=>outstanding.size),0);assert.deepEqual(errors,[]);
    // A failed durable avatar save must leave a usable crop for retry.
    await page.evaluate(()=>{window.avatarAttempts=0;mount({avatarOnly:true,saveAvatar:async()=>{if(++avatarAttempts===1)throw Error('合成保存失败');}});});
    const retryPicker=page.waitForEvent('filechooser');await page.locator('#choose-photo').click();
    await(await retryPicker).setFiles({name:'retry-avatar.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
    await page.locator('#photo-crop-stage').waitFor();await page.locator('#profile-done').click();
    await page.getByText('合成保存失败',{exact:true}).waitFor();
    assert.equal(await page.locator('#photo-crop-stage img').evaluate(image=>image.naturalWidth>0),true);
    await page.locator('#profile-done').click();await page.locator('.space-profile-overlay').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.result.avatar.kind),'image');
    assert.equal(await page.evaluate(()=>outstanding.size),0);assert.deepEqual(errors,[]);
    console.log(`PASS space profile ${engine.name()}: separate fields, 64 animated choices, reduced motion, photo pan/pinch, thumbnail bound, cancel and privacy cleanup, responsive P1`);
    await browser.close();browser=null;
  }
}finally{await browser?.close();await vite.close();}
