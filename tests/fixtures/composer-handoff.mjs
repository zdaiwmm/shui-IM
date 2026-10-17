import assert from 'node:assert/strict';

/** Real app and stylesheet cascade; only native viewport reports are synthetic. */
export async function verifyComposerHandoff(page) {
  const results=[];
  for(const kind of ['keyboard-expression','expression-keyboard','tools-keyboard']) {
    await page.evaluate(async kind=>{
      const app=fixture.app;
      app.closeMemePicker();app.closeChatTools();
      document.querySelector('#message-input').blur();setViewport(844);
      app.listKeyboardLayout.reset();app.syncViewport();
      await new Promise(resolve=>setTimeout(resolve,440));
      app.chatPinnedToBottom=true;app.chatScrollIntent=null;app.scrollChatToBottom();
      const input=document.querySelector('#message-input');input.focus();setViewport(473);
      await new Promise(resolve=>setTimeout(resolve,440));
      if(kind!=='keyboard-expression') {
        input.blur();setViewport(844);await new Promise(resolve=>setTimeout(resolve,440));
        if(kind==='expression-keyboard')app.openMemePicker();else app.toggleChatTools();
        await new Promise(resolve=>setTimeout(resolve,440));
      }
    },kind);
    const result=await page.evaluate(async kind=>{
      const app=fixture.app,row=document.querySelector('.composer-row'),input=document.querySelector('#message-input');
      const retired=kind==='expression-keyboard'?document.querySelector('.meme-panel'):kind==='tools-keyboard'?document.querySelector('#chat-tools'):null;
      const before=row.getBoundingClientRect().top,oldPanelTop=retired?.getBoundingClientRect().top;
      input.value='保留中文草稿';input.dispatchEvent(new Event('input',{bubbles:true}));
      const samples=[];
      const sample=()=>{const latest=document.querySelector('#message-list').lastElementChild,b=row.getBoundingClientRect(),h=document.querySelector('.chat-header').getBoundingClientRect(),visible=retired?.isConnected&&!retired.hidden;samples.push({top:b.top,header:h.top,last:latest.getBoundingClientRect().bottom,oldTop:visible?retired.getBoundingClientRect().top:null,oldOpacity:visible?Number(getComputedStyle(retired).opacity):null});};
      if(kind==='keyboard-expression')app.openMemePicker();
      else if(kind==='expression-keyboard')app.closeMemePicker(true,true);
      else input.focus({preventScroll:true});
      sample();
      const timer=setTimeout(()=>setViewport(kind==='keyboard-expression'?844:473),100);
      const started=performance.now();
      await new Promise(resolve=>{const tick=()=>{sample();if(performance.now()-started<1100)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
      clearTimeout(timer);
      return {kind,before,after:row.getBoundingClientRect().top,oldPanelTop,samples,draft:input.value,
        panelHeight:document.querySelector('.meme-panel')?.getBoundingClientRect().height};
    },kind);
    const tops=result.samples.map(s=>s.top),allowedMin=Math.min(result.before,result.after)-2,allowedMax=Math.max(result.before,result.after)+2;
    const summary={kind,before:result.before,after:result.after,min:Math.min(...tops),max:Math.max(...tops),panelHeight:result.panelHeight};
    results.push(summary);
    assert.ok(tops.every(top=>top>=allowedMin&&top<=allowedMax),JSON.stringify(summary));
    assert.equal(result.draft,'保留中文草稿');
    const gap=result.samples.at(-1).top-result.samples.at(-1).last;
    assert.ok(result.samples.every(s=>Math.abs(s.top-s.last-gap)<2),JSON.stringify({summary,gap,samples:result.samples}));
    assert.ok(Math.max(...result.samples.map(s=>s.header))-Math.min(...result.samples.map(s=>s.header))<.5,'Header remains fixed');
    if(kind==='keyboard-expression')assert.equal(result.panelHeight,371);
    else {
      const old=result.samples.filter(s=>s.oldTop!==null&&s.oldOpacity>.05);
      assert.ok(old.every(s=>Math.abs(s.oldTop-result.oldPanelTop)<2),JSON.stringify({summary,retired:old}));
    }
  }
  const history=await page.evaluate(async()=>{
    const app=fixture.app,input=document.querySelector('#message-input');input.blur();setViewport(844);
    await new Promise(resolve=>setTimeout(resolve,440));app.openMemePicker();await new Promise(resolve=>setTimeout(resolve,440));
    app.setChatScrollTop(Math.max(0,app.chatScrollTop-200));app.chatScrollIntent='up';app.chatPinnedToBottom=false;
    const anchor=app.captureChatAnchor(),reference=document.querySelector(`[data-client-msg-id="${anchor.clientMsgId}"]`),before=reference.getBoundingClientRect().top;
    app.closeMemePicker(true,true);setViewport(473);
    const samples=[];const started=performance.now();await new Promise(resolve=>{const tick=()=>{samples.push(reference.getBoundingClientRect().top);if(performance.now()-started<1100)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
    return {before,after:reference.getBoundingClientRect().top,maxShift:Math.max(...samples.map(top=>Math.abs(top-before))),pinned:app.chatPinnedToBottom};
  });
  assert.ok(history.maxShift<2,JSON.stringify(history));assert.equal(history.pinned,false);
  const reverse=await page.evaluate(async()=>{
    const app=fixture.app;app.openMemePicker();await new Promise(resolve=>setTimeout(resolve,80));
    app.closeMemePicker(true,true);await new Promise(resolve=>setTimeout(resolve,80));
    const panel=document.querySelector('.meme-panel'),row=document.querySelector('.composer-row'),picker=app.memePicker;
    const reopen=picker.reopen.bind(picker);
    picker.reopen=()=>{reopen();const start=performance.now();while(performance.now()-start<40){/* Busy native-focus task: geometry may change, paint time must not. */}};
    const before=[panel,row].map(el=>el.getBoundingClientRect().top);app.openMemePicker();picker.reopen=reopen;
    const after=[panel,row].map(el=>el.getBoundingClientRect().top);setViewport(844);
    await new Promise(resolve=>setTimeout(resolve,1100));
    return {before,after,same:app.memePicker===picker,inert:panel.inert,gap:panel.getBoundingClientRect().top-row.getBoundingClientRect().bottom};
  });
  assert.ok(reverse.before.every((top,i)=>Math.abs(top-reverse.after[i])<2),JSON.stringify(reverse));
  assert.equal(reverse.same,true);assert.equal(reverse.inert,false);assert.ok(Math.abs(reverse.gap-8)<1,JSON.stringify(reverse));
  console.log('COMPOSER_HANDOFF_HISTORY_REVERSE_OK',JSON.stringify({history,reverse}));
  console.log('COMPOSER_HANDOFF_OK',JSON.stringify(results));
}

export async function verifyHandoffEntryPages(page) {
  await page.route('**/api/rooms/entry-visual-probe/invitation-progress',route=>route.fulfill({status:200,body:'{}',contentType:'application/json'}));
  await page.evaluate(async()=>{fixture.app.setActiveSurface('away');const {mountGatewayIntros}=await import('/src/lib/gateway-intro.ts');window.stopEntryFit=mountGatewayIntros(document.querySelector('#app'));});
  const rows=[];
  for(const size of [{width:320,height:568},{width:393,height:683},{width:430,height:844}]) {
    await page.setViewportSize(size);
    await page.evaluate(()=>{setViewport(innerHeight);fixture.app.syncViewport();});
    for(const theme of ['blue','green','purple','apricot'])for(const scheme of ['light','dark'])for(const text of [16,32])for(const kind of ['create','join']) {
      const result=await page.evaluate(async({theme,scheme,text,kind})=>{
        const app=fixture.app;document.documentElement.dataset.theme=theme;document.documentElement.dataset.colorScheme=scheme;document.documentElement.style.fontSize=`${text}px`;
        const {platformVaultSetupState}=await import('/src/lib/platform-vault.ts');
        const password=kind==='create'&&platformVaultSetupState()==='unsupported';
        if(kind==='create'){const {defaultSpaceAvatar}=await import('/src/lib/space-avatar.ts');app.renderCreateProtection({name:'合成空间',avatar:defaultSpaceAvatar()});}
        // This fixture measures the protection form only. Invitation preflight
        // and exclusive claims are exercised against a real backend elsewhere.
        else app.renderJoinProtection({roomId:'entry-visual-probe',accessToken:'synthetic-visual-only'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const gateway=document.querySelector('.gateway'),bounds=gateway.getBoundingClientRect(),content=gateway.querySelector('.gateway-intro-content'),actions=gateway.querySelector('.welcome-actions').getBoundingClientRect(),button=gateway.querySelector('[data-device-verify]').getBoundingClientRect();
        return {hero:gateway.dataset.hero,art:gateway.querySelectorAll('.gateway-entry-hero>.entry-art-lock').length,
          actionsVisible:actions.bottom<=innerHeight+1&&actions.top>=0,buttonHeight:button.height,
          horizontal:content.scrollWidth<=content.clientWidth+1,title:getComputedStyle(gateway.querySelector('h1')).textAlign,
          field:!!gateway.querySelector('#new-passkey-name'),expectedField:!password,
          actionLabel:button.width>0&&gateway.querySelector('[data-device-verify]').textContent.includes(password?'设置密码':kind==='create'?'设置密钥':'设置访问密钥'),height:bounds.height};
      },{theme,scheme,text,kind});
      rows.push({size,theme,scheme,text,kind,...result});
    }
  }
  const failures=rows.filter(r=>r.art!==1||!r.actionsVisible||r.buttonHeight<44||!r.horizontal||r.title!=='center'||r.field!==r.expectedField||!r.actionLabel);
  assert.deepEqual(failures,[]);
  await page.evaluate(()=>{stopEntryFit();document.documentElement.style.fontSize='';document.documentElement.dataset.theme='blue';document.documentElement.dataset.colorScheme='light';fixture.app.renderChat();setViewport(844);});
  await page.setViewportSize({width:390,height:844});
  console.log('COMPOSER_ENTRY_LAYOUT_OK',rows.length);
}
