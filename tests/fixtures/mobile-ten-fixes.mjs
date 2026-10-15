import assert from 'node:assert/strict';

/** Real product DOM and styles, with synthetic viewport geometry only. */
export async function verifyMobileTenFixes(page) {
  const result = await page.evaluate(async () => {
    const app = fixture.app, input = document.querySelector('#message-input');
    const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const finish = async () => { await Promise.allSettled(document.querySelector('#app').getAnimations({subtree:true}).map(a => { a.finish(); return a.finished; })); await paint(); };
    const luma = color => {
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      context.fillStyle = color; context.fillRect(0,0,1,1);
      const rgb = [...context.getImageData(0,0,1,1).data].slice(0,3).map(v => { v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4; });
      return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
    };
    const fills = [];
    for (const theme of ['blue','green','purple','apricot']) {
      document.documentElement.dataset.theme=theme;
      document.documentElement.dataset.colorScheme='dark';
      const composer=getComputedStyle(document.querySelector('#composer')).getPropertyValue('--composer-surface-current');
      const probe=document.createElement('span');probe.style.background=composer;document.body.append(probe);
      const darkDifference=Math.abs(luma(getComputedStyle(document.querySelector('.composer-input-stack')).backgroundColor)-luma(getComputedStyle(probe).backgroundColor));probe.remove();
      document.documentElement.dataset.colorScheme='light';app.toggleChatTools();await finish();
      const panel=document.querySelector('#chat-tools'),tile=panel.querySelector('button > span');
      fills.push({theme,darkDifference,lightDifference:Math.abs(luma(getComputedStyle(tile).backgroundColor)-luma(getComputedStyle(panel).backgroundColor))});
      app.closeChatTools();
    }
    document.documentElement.dataset.theme='blue';document.documentElement.dataset.colorScheme='light';
    const positions = () => [...document.querySelectorAll('#peer-presence,#self-presence,.presence-circuit')].map(el => {const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];});
    document.documentElement.dataset.keyboardOpen='false';const closed=positions();
    document.documentElement.dataset.keyboardOpen='true';const opened=positions();
    const headerJump=Math.max(...opened.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-closed[i][j]))));
    document.documentElement.dataset.keyboardOpen='false';
    await finish();
    const message={...app.messages.values().next().value,clientMsgId:'ten-mask-probe'};
    const article=document.createElement('article');article.className='message incoming';article.dataset.clientMsgId=message.clientMsgId;
    article.style.cssText='position:fixed;left:40px;top:200px;width:160px;height:120px';
    const bubble=document.createElement('div');bubble.className='message-bubble image-bubble';article.append(bubble);document.querySelector('#message-list').append(article);
    bubble.innerHTML='<button class="image-preview" data-image-state="loaded" data-revealed="false" style="width:160px;height:120px;--chat-preview-source:linear-gradient(#778877,#778877)"><img alt="合成遮罩" style="width:160px;height:120px"></button>';
    app.openMessageActions(article,message);
    const actions=document.querySelector('.message-actions'),preview=document.querySelector('.message-action-preview');
    const opacity=el=>{let n=1;for(;el;el=el.parentElement)n*=Number(getComputedStyle(el).opacity);return n;};
    const media={opacity:opacity(preview),original:getComputedStyle(bubble).visibility,
      preview:getComputedStyle(preview).visibility,
      concealed:getComputedStyle(preview.querySelector('img')).opacity,
      placeholder:getComputedStyle(preview.querySelector('.image-preview'),'::before').opacity};
    const reaction=getComputedStyle(actions.querySelector('.message-reaction-picker > button'));
    const reactionBorder=reaction.borderWidth;
    await paint();
    media.readyOriginal=getComputedStyle(bubble).visibility;media.readyPreview=getComputedStyle(preview).visibility;
    app.closeMessageActions(false,false);
    // Focus removal can queue list scroll bookkeeping. A second independent
    // long press begins after that displacement, just as a new user gesture.
    await paint();await paint();
    bubble.querySelector('.image-preview').classList.add('video-preview');
    app.openMessageActions(article,message);
    const videoPreview=document.querySelector('.message-action-preview');
    const video={original:getComputedStyle(bubble).visibility,preview:getComputedStyle(videoPreview).visibility};
    await paint();video.readyOriginal=getComputedStyle(bubble).visibility;video.readyPreview=getComputedStyle(videoPreview).visibility;
    video.concealed=getComputedStyle(videoPreview.querySelector('img')).opacity;
    video.placeholder=getComputedStyle(videoPreview.querySelector('.image-preview'),'::before').opacity;
    app.closeMessageActions(false,false);article.remove();
    await finish();input.focus();setViewport(473);await paint();await finish();
    const composer=document.querySelector('#composer');composer.dataset.viewportMotion='positioning';
    const plus=document.querySelector('#open-chat-tools'),r=plus.getBoundingClientRect();
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('#open-chat-tools')===plus;
    const event=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,isPrimary:true,button:0,pointerType:'touch'});
    plus.dispatchEvent(event);
    plus.click();const toolsOpened=!document.querySelector('#chat-tools').hidden;
    app.closeChatTools();input.blur();setViewport(844);await paint();
    const underlay=document.querySelector('.chat-keyboard-underlay'),underlaySamples=[];
    const motions=app.chatKeyboardSurfaceMotion?.animations??[];
    for(const animation of motions) animation.pause();
    for(const time of [0,90,180]) {
      for(const animation of motions) animation.currentTime=time;
      const edge=underlay.getBoundingClientRect().top;
      underlaySamples.push({gap:Math.abs(edge-composer.getBoundingClientRect().bottom),visible:Math.max(0,844-edge)});
    }
    await finish();
    delete composer.dataset.viewportMotion;
    app.openMemePicker();await finish();
    const expression=document.querySelector('.meme-panel'),before=expression.getBoundingClientRect().top;
    const openingPaint={form:getComputedStyle(composer).backgroundColor,row:getComputedStyle(document.querySelector('.composer-row'),'::before').backgroundColor};
    app.closeMemePicker(true,true);
    const detached=expression.parentElement!==composer;
    await paint();setViewport(473);await paint();
    const departing=expression.getBoundingClientRect();
    const expressionMotion={before,detached,top:departing.top,inert:expression.inert};
    await finish();input.blur();setViewport(844);await paint();await finish();
    return {fills,headerJump,media,video,reactionBorder,plus:{hit,prevented:event.defaultPrevented,toolsOpened},expressionMotion,underlaySamples,openingPaint};
  });
  if (process.env.MOBILE_TEN_PROBE) console.log('MOBILE_TEN_PROBE',JSON.stringify(result));
  assert.ok(result.fills.every(f=>f.darkDifference>=.018&&f.lightDifference>=.035),JSON.stringify(result.fills));
  assert.ok(result.headerJump<.5,JSON.stringify({headerJump:result.headerJump}));
  assert.equal(result.media.opacity,1,JSON.stringify(result.media));
  assert.equal(result.media.original,'visible');assert.equal(result.media.preview,'hidden');
  assert.equal(result.media.readyOriginal,'hidden');assert.equal(result.media.readyPreview,'visible');
  assert.deepEqual(result.video,{original:'visible',preview:'hidden',readyOriginal:'hidden',readyPreview:'visible',concealed:'0',placeholder:'1'});
  assert.equal(result.media.concealed,'0');assert.equal(result.media.placeholder,'1');
  assert.equal(result.reactionBorder,'0px');
  assert.deepEqual(result.plus,{hit:true,prevented:false,toolsOpened:true});
  assert.equal(result.expressionMotion.detached,true,JSON.stringify(result.expressionMotion));
  assert.equal(result.expressionMotion.inert,true);
  assert.ok(result.expressionMotion.top>=result.expressionMotion.before-.5,JSON.stringify(result.expressionMotion));
  assert.equal(result.openingPaint.form,'rgba(0, 0, 0, 0)');assert.notEqual(result.openingPaint.row,'rgba(0, 0, 0, 0)');
  assert.ok(result.underlaySamples.every(s=>s.gap<.5),JSON.stringify(result.underlaySamples));
  assert.ok(result.underlaySamples[0].visible>result.underlaySamples[2].visible,JSON.stringify(result.underlaySamples));
  if(process.env.MOBILE_TEN_CAPTURE) {
    for(const scheme of ['light','dark']) {
      await page.evaluate(scheme=>{document.documentElement.dataset.colorScheme=scheme;fixture.app.toggleChatTools();},scheme);
      await page.locator('#chat-tools').evaluate(async panel=>{await Promise.allSettled(panel.getAnimations().map(a=>a.finished));});
      await page.screenshot({path:`/private/tmp/mobile-ten-${scheme}.png`});
      await page.evaluate(()=>fixture.app.closeChatTools());
    }
  }
}
