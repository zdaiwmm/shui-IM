import assert from 'node:assert/strict';

export async function verifyComposerRefine(page) {
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(() => {
    fixture.app.closeMemePicker();
    document.querySelector('#message-input').blur();
    setViewport(844);
    fixture.app.listKeyboardLayout.reset();
    fixture.app.syncViewport();
  });
  await page.waitForTimeout(420);
  await page.locator('#message-input').fill('保留中文草稿');
  await page.evaluate(() => {document.querySelector('#message-input').focus();setViewport(473);});
  await page.waitForTimeout(420);
  const keyboardTop=await page.locator('.composer-row').evaluate(e=>e.getBoundingClientRect().top);
  await page.evaluate(() => {document.querySelector('#message-input').blur();setViewport(844);});
  await page.waitForTimeout(420);
  await page.locator('#open-memes').tap();
  await page.waitForTimeout(420);
  const panel=await page.evaluate(() => ({
    top:document.querySelector('.composer-row').getBoundingClientRect().top,
    height:document.querySelector('.meme-panel').getBoundingClientRect().height,
    shortcuts:[...document.querySelectorAll('.meme-pack-shortcuts button')].slice(0,3).map(e=>e.dataset.shortcut),
    corners:getComputedStyle(document.querySelector('.meme-panel')).borderTopLeftRadius,
  }));
  assert.ok(Math.abs(panel.top-keyboardTop)<1,JSON.stringify({keyboardTop,panel}));
  assert.equal(panel.height,371);assert.equal(panel.corners,'0px');
  assert.deepEqual(panel.shortcuts,['add','emoji','favorites']);
  await page.locator('#open-memes').tap();
  await page.waitForTimeout(420);
  await page.evaluate(() => {
    setViewport(844);
    const input=document.querySelector('#message-input');input.focus();
    fixture.app.nativeKeyboardOpening=true;
    fixture.app.nativeKeyboardOpeningAt=performance.now()-1200;
    window.refineFocuses=0;input.addEventListener('focus',()=>refineFocuses++);
  });
  await page.locator('#message-input').tap();
  assert.equal(await page.evaluate(()=>refineFocuses),1,'A focused editor with no keyboard must rearm from the next trusted tap');
  assert.equal(await page.locator('#message-input').inputValue(),'保留中文草稿');
  const glyph=await page.locator('#send-text').evaluate(button=>{
    const b=button.getBoundingClientRect(),svg=button.querySelector('svg'),r=svg.getBoundingClientRect(),path=svg.getBBox();
    return {dx:Math.abs(r.left+(path.x+path.width/2)*r.width/24-b.left-b.width/2),dy:Math.abs(r.top+(path.y+path.height/2)*r.height/24-b.top-b.height/2)};
  });
  assert.ok(glyph.dx<.6&&glyph.dy<.6,JSON.stringify(glyph));
  await page.evaluate(()=>{document.querySelector('#message-input').blur();setViewport(844);});
  await page.waitForTimeout(420);
}
