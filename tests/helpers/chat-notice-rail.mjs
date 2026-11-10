import assert from 'node:assert/strict';

/** Exercise the live Chamber header inside the real creation flow. */
export async function verifyChamberNoticeRail(page) {
  await page.locator('#app-toast').waitFor({state:'hidden'});
  await page.evaluate(() => { app.availableReleaseId = 'synthetic-next'; app.renderReleaseUpdateBanner(); });
  const update = page.locator('.notice-rail [data-release-update]');
  const measure = () => update.evaluate(button => {
    const source = button.parentElement, rail = source.parentElement;
    const box = node => node.getBoundingClientRect();
    const presence = box(rail.parentElement.querySelector('.peer-summary'));
    const settings = box(rail.parentElement.querySelector('#chat-settings'));
    const visible = getComputedStyle(source,'::before');
    return { x:box(rail).x, width:box(rail).width, action:box(button).width, presence:presence.width,
      gear:settings.x, center:box(rail).y+22, gearCenter:settings.y+settings.height/2,
      gap:presence.left-box(rail).right, painted:box(rail).height-parseFloat(visible.top)-parseFloat(visible.bottom) };
  });
  for (const width of [320,390]) {
    await page.setViewportSize({width,height:844});
    const layouts = [];
    for (const style of ['capsule','heart']) {
      await page.evaluate(value => { localStorage.setItem('quiet-room:presence-style',value); app.applyPresenceStyle(); },style);
      layouts.push(await measure());
    }
    const [wide,compact] = layouts;
    assert.ok(compact.width > wide.width,JSON.stringify(layouts));
    assert.ok(Math.abs(compact.width-wide.width-(wide.presence-compact.presence))<1);
    for(const state of layouts) {
      assert.equal(state.painted,34); assert.equal(state.center,state.gearCenter);
      assert.equal(state.x,wide.x); assert.equal(state.gear,wide.gear); assert.equal(state.gap,wide.gap);
      assert.ok(Math.abs(state.action-state.width)<1);
    }
  }
  await page.evaluate(() => app.showNotice('合成错误详情','error'));
  await page.locator('.notice-rail > #app-toast[data-rail-current]').waitFor();
  assert.equal(await update.isVisible(),false);
  await page.locator('#app-toast .toast-content').click();
  await page.getByRole('dialog',{name:'提示详情'}).getByText('合成错误详情').waitFor();
  await page.getByRole('button',{name:'知道了',exact:true}).click();
  await update.waitFor();
  await page.evaluate(() => {
    app.availableReleaseId=null; document.querySelector('.release-update-reminder').remove();
    localStorage.setItem('quiet-room:presence-style','capsule'); app.applyPresenceStyle();
  });
}

/** Sample the production background on both sides of the shared field's ends. */
export async function verifyGradientEndpoints(page) {
  const saved = await page.evaluate(() => {
    const html = document.documentElement;
    const scheme = html.getAttribute('data-color-scheme');
    html.dataset.colorScheme='dark';
    const row=document.createElement('div'); row.className='message outgoing'; row.dataset.gradientEndpoints='';
    row.style.cssText='position:fixed;left:12px;top:150px;z-index:99';
    const bubble=document.createElement('div'); bubble.className='message-bubble text-bubble';
    bubble.style.cssText='width:80px;height:120px;--bubble-gradient-offset:28px;--bubble-gradient-span:60px';
    row.append(bubble); document.querySelector('#app').append(row);
    return scheme;
  });
  try {
    const bytes = await page.locator('[data-gradient-endpoints] .message-bubble').screenshot({scale:'css'});
    const [above,first,middle,last,below] = await page.evaluate(async base64 => {
      const image = new Image(); image.src='data:image/png;base64,'+base64; await image.decode();
      const canvas=document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      return [18,28,55,88,100].map(y=>[...ctx.getImageData(40,y,1,1).data].slice(0,3));
    },bytes.toString('base64'));
    const distance=(a,b)=>Math.max(...a.map((n,i)=>Math.abs(n-b[i])));
    assert.ok(distance(above,first)<=2 && distance(last,below)<=2,JSON.stringify({above,first,last,below}));
    assert.ok(distance(first,middle)>8 && distance(middle,last)>8,'Interior still spans the theme gradient');
  } finally {
    await page.evaluate(scheme => {
      document.querySelector('[data-gradient-endpoints]').remove();
      if(scheme===null) document.documentElement.removeAttribute('data-color-scheme');
      else document.documentElement.dataset.colorScheme=scheme;
    },saved);
  }
}
