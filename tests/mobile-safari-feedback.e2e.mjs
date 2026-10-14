import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile:false, appType:'custom', root:process.cwd(), logLevel:'error',
  server:{host:'127.0.0.1',port:0,hmr:false}, plugins:[{name:'mobile-feedback-fixture',configureServer(vite) {
    vite.middlewares.use('/__feedback',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta id="system-chrome-color" name="theme-color"><div id="app"></div>');});
  }}] });
let browser;
try {
  await server.listen();
  for (const engine of [chromium,webkit]) {
    browser = await engine.launch(engine===chromium&&!process.env.CI ? process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'} : {});
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3,
      userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://localhost:${server.httpServer.address().port}/__feedback`);
    await page.evaluate(async()=>{
      await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
      const {mountFormInputs}=await import('/src/lib/form-input.ts');
      const {mountSystemChrome}=await import('/src/lib/system-chrome.ts');
      document.body.className='app-mode';
      const root=document.querySelector('#app');
      root.innerHTML='<section class="gateway"><label for="original">空间名称</label><input id="original" value="原名称" maxlength="40"><button id="business">下一步</button></section>';
      window.stopForms=mountFormInputs(root);window.stopChrome=mountSystemChrome();window.events=[];
      for(const kind of ['input','change'])document.querySelector('#original').addEventListener(kind,()=>events.push(kind));
      window.setViewport=height=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>height});visualViewport.dispatchEvent(new Event('resize'));};
    });
    await page.locator('#original').click();await page.locator('#form-input-draft').fill('中文候选');
    const ime=await page.evaluate(async()=>{
      const editor=document.querySelector('#form-input-draft');
      editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      document.querySelector('[data-form-input-done]').click();
      if(!editor.isConnected)throw Error('Done read the draft before IME finalization');
      editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'最后一个字'}));
      editor.value='完整中文最后一个字';editor.dispatchEvent(new InputEvent('input',{bubbles:true}));
      await Promise.resolve();
      return {value:document.querySelector('#original').value,events:[...events],draft:editor.value,closed:!editor.isConnected};
    });
    assert.deepEqual(ime,{value:'完整中文最后一个字',events:['input','change'],draft:'',closed:true});
    await page.locator('#original').click();await page.locator('#form-input-draft').fill('延迟触摸完成');
    const delayed=await page.evaluate(async()=>{
      const editor=document.querySelector('#form-input-draft'),done=document.querySelector('[data-form-input-done]');
      done.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,isPrimary:true,button:0,pointerType:'touch'}));
      await new Promise(resolve=>setTimeout(resolve,20));
      document.body.tabIndex=-1;document.body.focus();
      await Promise.resolve();
      const retained=editor.isConnected;done.click();
      return {retained,value:document.querySelector('#original').value};
    });
    assert.deepEqual(delayed,{retained:true,value:'延迟触摸完成'});
    await page.locator('#original').click();
    const nativeIme=await page.evaluate(async()=>{
      const editor=document.querySelector('#form-input-draft');
      editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));editor.blur();
      await Promise.resolve();
      editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));editor.value='原生完成的中文';
      await Promise.resolve();return {value:document.querySelector('#original').value,closed:!editor.isConnected};
    });
    assert.deepEqual(nativeIme,{value:'原生完成的中文',closed:true});
    await page.locator('#original').click();
    const paint=await page.evaluate(()=>{
      setViewport(473);
      const overlay=document.querySelector('.form-input-overlay'),bar=document.querySelector('.form-input-panel'),field=document.querySelector('#form-input-draft');
      return {underlay:getComputedStyle(overlay,'::after').backgroundColor,bar:getComputedStyle(bar).backgroundColor,
        field:getComputedStyle(field).backgroundColor,height:parseFloat(getComputedStyle(overlay,'::after').height),bottom:getComputedStyle(document.documentElement).backgroundColor};
    });
    assert.equal(paint.underlay,paint.bar);assert.equal(paint.bottom,paint.bar);assert.ok(paint.height>=370);assert.notEqual(paint.field,paint.bar);
    await page.locator('#form-input-draft').press('Escape');
    await page.evaluate(async()=>{
      stopForms();setViewport(844);
      const {QuietRoomApp}=await import('/src/app.ts');const {createVault}=await import('/src/lib/vault.ts');
      const app=new QuietRoomApp(document.querySelector('#app'));
      const own={deviceId:'feedback-own',role:'creator',status:'active'};
      const session=await createVault({v:1,roomId:crypto.randomUUID(),accessToken:'synthetic-feedback',role:'creator',protocol:'legacy-v1',lastSeq:30,members:[own,{...own,deviceId:'feedback-peer',role:'joiner'}],identity:{publicBundle:own}},'synthetic-feedback-password','password');
      app.session=session;app.privacyCovered=false;app.runtimeEpoch++;app.runtimeAbort=new AbortController();
      app.visualClientCoordinates=true;app.usesListScrolling=true;
      app.updateSafetyCode=async()=>{};app.updateBackgroundNotificationControl=async()=>{};app.mountChatImageObserver=()=>{};
      app.uiPreferences={entranceCardDismissed:true,recoveryReminderDismissed:true};app.uiPreferencesHydrated=true;
      app.messages=new Map(Array.from({length:30},(_,i)=>[i+1,{seq:i+1,clientMsgId:`feedback-${i}`,senderId:'feedback-peer',payload:{v:1,kind:'text',text:`合成消息 ${i}`,sentAt:'2026-10-14T00:00:00Z'},acceptedAt:'2026-10-14T00:00:00Z',status:'delivered'}]));
      app.renderChat();window.fixture={app,session};
    });
    for(const theme of ['blue','green','purple','apricot'])for(const scheme of ['light','dark']) {
      await page.evaluate(({theme,scheme})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.colorScheme=scheme;},{theme,scheme});
      for(const focused of [false,true]) {
        await page.evaluate(focused=>{const input=document.querySelector('#message-input');if(focused)input.focus();else input.blur();},focused);
        const colors=await page.evaluate(()=>{
          const composer=document.querySelector('#composer'),probe=document.createElement('div');
          probe.style.cssText='position:absolute;background:color-mix(in srgb,var(--composer-surface-current) 76%,var(--surface-raised))';composer.append(probe);
          const expected=getComputedStyle(probe).backgroundColor;probe.remove();
          return {header:getComputedStyle(document.querySelector('.chat-header')).backgroundColor,
            composer:getComputedStyle(composer).backgroundColor,input:getComputedStyle(document.querySelector('.composer-input-stack')).backgroundColor,
            expected,hint:document.querySelector('#system-chrome-color').content};
        });
        assert.equal(colors.header,colors.composer,`${theme}/${scheme}/${focused}: chat surfaces`);assert.equal(colors.hint,colors.header);
        assert.equal(colors.input,colors.expected,`${theme}/${scheme}/${focused}: subtle input fill`);
      }
    }
    await page.locator('#message-input').fill('保留输入草稿');await page.locator('#open-memes').click();
    await page.locator('.fluent-emoji-tile img').first().waitFor();
    await page.locator('.meme-panel').evaluate(async panel=>{await Promise.all(panel.getAnimations().map(animation=>animation.finished));});
    const density=await page.locator('.fluent-emoji-tile img').first().evaluate(img=>({natural:img.naturalWidth,painted:img.getBoundingClientRect().width*devicePixelRatio}));
    assert.ok(density.natural>=density.painted,JSON.stringify(density));
    const panels = await page.evaluate(() => {
      const input = document.querySelector('.composer-input-stack'), style = getComputedStyle(input);
      const panel = document.querySelector('.meme-panel'), row = document.querySelector('.composer-row');
      return {radius:style.borderRadius, border:style.borderWidth, outline:style.outlineWidth,
        padding:parseFloat(getComputedStyle(document.querySelector('#composer')).paddingTop),
        paths:panel.querySelector('[data-shortcut="add"] svg').querySelectorAll('path').length,
        targets:[...panel.querySelectorAll('.emoji-tile')].every(el=>el.getBoundingClientRect().width>=43.99),
        gap:panel.getBoundingClientRect().top-row.getBoundingClientRect().bottom};
    });
    assert.deepEqual(panels,{radius:'12px',border:'0px',outline:'0px',padding:8,paths:4,targets:true,gap:8});
    const collapse=await page.evaluate(async()=>{
      const app=fixture.app,row=document.querySelector('.composer-row'),input=document.querySelector('#message-input');
      const top=row.getBoundingClientRect().top;app.closeMemePicker(false,true);
      const panel=document.querySelector('.meme-panel'),animations=[...row.getAnimations(),...panel.getAnimations()];
      // Sample the shared animation clock, rather than assuming Linux WebKit
      // paints an intermediate frame within a fixed amount of wall time.
      if(animations.length!==2)throw Error(`Expected row and panel animations, got ${animations.length}`);
      for(const animation of animations){animation.pause();animation.currentTime=0;}
      await Promise.all(animations.map(animation=>animation.ready));
      const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await paint();const initial=row.getBoundingClientRect().top,panelTop=panel.getBoundingClientRect().top;
      const durations=animations.map(animation=>animation.effect.getTiming().duration);
      for(const animation of animations)animation.currentTime=100;
      await paint();
      const moving=row.getBoundingClientRect().top,panelMoving=panel.getBoundingClientRect().top,panelPresent=panel.isConnected;
      for(const animation of animations)animation.finish();
      await paint();
      const final=row.getBoundingClientRect().top;return {top,initial,moving,final,panelTop,panelMoving,panelPresent,durations,draft:input.value};
    });
    assert.ok(Math.abs(collapse.top-collapse.initial)<2,JSON.stringify(collapse));
    assert.ok(collapse.moving>collapse.top+8&&collapse.moving<collapse.final,JSON.stringify(collapse));assert.equal(collapse.panelPresent,true);assert.equal(collapse.draft,'保留输入草稿');
    assert.deepEqual(collapse.durations,[360,360]);
    assert.ok(collapse.panelMoving>collapse.panelTop+8,JSON.stringify(collapse));
    await page.locator('#open-memes').click();await page.waitForTimeout(450);
    const reverse = await page.evaluate(async () => {
      const app=fixture.app, panel=document.querySelector('.meme-panel'), row=document.querySelector('.composer-row');
      const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      app.closeMemePicker(false,true);
      for(const animation of [...row.getAnimations(),...panel.getAnimations()]){animation.pause();animation.currentTime=120;}
      await paint();const before=[panel,row].map(el=>el.getBoundingClientRect().top);
      app.openMemePicker();
      const animations=[...row.getAnimations(),...panel.getAnimations()];
      for(const animation of animations){animation.pause();animation.currentTime=0;}
      await Promise.all(animations.map(animation=>animation.ready));await paint();
      const after=[panel,row].map(el=>el.getBoundingClientRect().top);
      for(const animation of animations)animation.finish();await paint();
      return {jumps:after.map((value,i)=>Math.abs(value-before[i])),same:panel===document.querySelector('.meme-panel'),
        interactive:!panel.inert&&!panel.hasAttribute('aria-hidden'),left:row.getAnimations().length+panel.getAnimations().length};
    });
    assert.ok(reverse.jumps.every(jump=>jump<.5),JSON.stringify(reverse));
    assert.equal(reverse.same,true);assert.equal(reverse.interactive,true);assert.equal(reverse.left,0);
    const sizeReverse=await page.evaluate(async()=>{
      const panel=document.querySelector('.meme-panel'),expand=panel.querySelector('.meme-expand');
      const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      expand.click();for(const animation of panel.getAnimations()){animation.pause();animation.currentTime=120;}
      await paint();const before=panel.getBoundingClientRect().top;expand.click();
      const animations=panel.getAnimations();for(const animation of animations){animation.pause();animation.currentTime=0;}
      await Promise.all(animations.map(animation=>animation.ready));await paint();
      const jump=Math.abs(before-panel.getBoundingClientRect().top);
      for(const animation of animations)animation.finish();await paint();
      return {jump,local:panel.parentElement.id==='composer',same:panel===document.querySelector('.meme-panel')};
    });
    assert.ok(sizeReverse.jump<.5,JSON.stringify(sizeReverse));assert.equal(sizeReverse.local,true);assert.equal(sizeReverse.same,true);
    await page.locator('.meme-expand').click();
    await page.locator('.meme-panel').evaluate(async panel=>{await Promise.all(panel.getAnimations().map(animation=>animation.finished));});
    assert.equal(await page.locator('.meme-expand').getAttribute('aria-label'),'还原表情');
    assert.equal(await page.locator('.meme-panel').evaluate(panel=>Math.abs(panel.getBoundingClientRect().height-visualViewport.height)<1),true);
    assert.equal(await page.locator('.meme-panel').evaluate(panel=>panel.querySelector('.meme-scroll').getBoundingClientRect().height>panel.getBoundingClientRect().height-80),true,'Expanded content must fill the space below its single rail');
    await page.locator('.meme-expand').click();
    await page.locator('.meme-search-dialog').waitFor({state:'detached'});
    assert.equal(await page.locator('#composer > .meme-panel').count(),1);
    const handoff=await page.evaluate(async()=>{
      const input=document.querySelector('#message-input'),app=fixture.app;let focuses=0,blurs=0;
      input.addEventListener('focus',()=>focuses++);input.addEventListener('blur',()=>blurs++);
      for(let i=0;i<6;i++) {
        input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,isPrimary:true,button:0,pointerType:'touch'}));
        if(i===1)setViewport(560);if(i===3)setViewport(473);
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      // Linux WebKit may deliver the animation finish after a fixed wall-time
      // delay. Await the actual owners without weakening the focus counts.
      await Promise.allSettled([...document.querySelectorAll('.meme-panel,.composer-row')].flatMap(el=>el.getAnimations()).map(animation=>animation.finished));
      return {focuses,blurs,same:input===document.querySelector('#message-input'),draft:input.value,panel:!!app.memePicker,opacity:getComputedStyle(document.querySelector('.composer-row')).opacity};
    });
    assert.deepEqual(handoff,{focuses:1,blurs:0,same:true,draft:'保留输入草稿',panel:false,opacity:'1'});
    await page.evaluate(()=>{document.querySelector('#message-input').blur();setViewport(844);});
    // The preceding synthetic keyboard resize has its own 360ms composer
    // clock. Let that endpoint settle before sampling the tool's 240ms path.
    await page.waitForFunction(()=>document.querySelector('#composer').getAnimations().every(animation=>animation.playState==='finished'));
    const tools = await page.evaluate(async () => {
      const app=fixture.app,panel=document.querySelector('#chat-tools'),row=document.querySelector('.composer-row');
      const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      app.toggleChatTools();
      for(const animation of [...row.getAnimations(),...panel.getAnimations()]){animation.pause();animation.currentTime=90;}
      await paint();const before=[panel,row].map(el=>el.getBoundingClientRect().top),left=panel.getBoundingClientRect().left;
      app.toggleChatTools();
      const closingInert=panel.inert&&panel.getAttribute('aria-hidden')==='true'&&!panel.hidden;
      let animations=[...row.getAnimations(),...panel.getAnimations()];
      for(const animation of animations){animation.pause();animation.currentTime=0;}
      await Promise.all(animations.map(animation=>animation.ready));await paint();
      const jumps=[panel,row].map((el,i)=>Math.abs(el.getBoundingClientRect().top-before[i]));
      const xJump=Math.abs(panel.getBoundingClientRect().left-left);
      for(const animation of animations)animation.currentTime=100;await paint();
      const returning=[panel,row].map(el=>el.getBoundingClientRect().top);app.toggleChatTools();
      animations=[...row.getAnimations(),...panel.getAnimations()];
      for(const animation of animations){animation.pause();animation.currentTime=0;}
      await Promise.all(animations.map(animation=>animation.ready));await paint();
      jumps.push(...[panel,row].map((el,i)=>Math.abs(el.getBoundingClientRect().top-returning[i])));
      const duration=animations.map(animation=>animation.effect.getTiming().duration);
      const transformsOnly=animations.every(animation=>animation.effect.getKeyframes().every(frame=>!('height' in frame)&&!('padding' in frame)));
      for(const animation of animations)animation.finish();await paint();
      const style=getComputedStyle(panel),handle=getComputedStyle(panel,'::before');
      const result={jumps,xJump,closingInert,duration,transformsOnly,radius:style.borderTopLeftRadius,
        noHandle:handle.display==='none',interactive:!panel.inert&&!panel.hidden,draft:document.querySelector('#message-input').value};
      app.closeChatTools();return result;
    });
    assert.ok(tools.jumps.every(jump=>jump<.5)&&tools.xJump<.5,JSON.stringify(tools));
    assert.equal(tools.closingInert,true);assert.deepEqual(tools.duration,[240,240]);assert.equal(tools.transformsOnly,true);
    assert.equal(tools.radius,'0px');assert.equal(tools.noHandle,true);assert.equal(tools.interactive,true);assert.equal(tools.draft,'保留输入草稿');
    await page.locator('#message-input').click();
    assert.equal(await page.locator('.composer-input-stack').evaluate(el=>getComputedStyle(el).outlineWidth),'0px');
    await page.locator('#open-chat-tools').focus();await page.keyboard.press('Tab');
    assert.equal(await page.locator('#message-input').evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('.composer-input-stack').evaluate(el=>getComputedStyle(el).outlineWidth),'2px');
    const swaps=await page.evaluate(async()=>{
      const app=fixture.app;app.openMemePicker();const outgoing=document.querySelector('.meme-panel');
      app.toggleChatTools();const retained=outgoing.isConnected&&outgoing.inert;
      app.openMemePicker();app.toggleChatTools();
      const animations=[...document.querySelector('#composer').getAnimations({subtree:true})];
      for(const animation of animations)animation.finish();
      await Promise.allSettled(animations.map(animation=>animation.finished));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {retained,expressions:document.querySelectorAll('.meme-panel').length,tools:!document.querySelector('#chat-tools').hidden,
        inert:document.querySelector('#chat-tools').inert,animations:[...document.querySelectorAll('.composer-row,.meme-panel,#chat-tools')].reduce((sum,el)=>sum+el.getAnimations().length,0),
        draft:document.querySelector('#message-input').value};
    });
    assert.deepEqual(swaps,{retained:true,expressions:0,tools:true,inert:false,animations:0,draft:'保留输入草稿'});
    await page.evaluate(()=>fixture.app.closeChatTools());
    const capsules=await page.evaluate(async()=>{
      const {MediaUploadView}=await import('/src/lib/media-upload-view.ts');
      const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const blob=await new Promise(resolve=>canvas.toBlob(resolve));
      const view=new MediaUploadView('synthetic-status',[new File([blob],'synthetic.png',{type:'image/png'})],true,false,()=>{},()=>{});
      document.querySelector('#message-list').append(view.element);await view.ready;
      view.update('uploading',.2);
      const host=view.element.querySelector('.media-upload-status'),animation=host.getAnimations()[0];
      animation.pause();animation.currentTime=100;
      for(let i=0;i<10;i++)view.update('uploading',.2+i/100);
      const retained=host.getAnimations()[0]===animation&&animation.currentTime===100;
      for(const state of ['finishing','failed','uploading','finishing'])view.update(state,.9);
      const nested=host.querySelectorAll('.media-capsule-retiring .media-capsule-retiring').length;
      const layers=host.querySelectorAll(':scope > .media-capsule-retiring').length;
      const height=host.getBoundingClientRect().height;view.destroy();
      return {retained,nested,layers,height};
    });
    assert.deepEqual({retained:capsules.retained,nested:capsules.nested,layers:capsules.layers},{retained:true,nested:0,layers:1});
    assert.ok(Math.abs(capsules.height-32)<.01,JSON.stringify(capsules));
    for(const width of [320,390,430]) {
      await page.setViewportSize({width,height:568});await page.evaluate(()=>setViewport(568));
      for(const theme of ['blue','green','purple','apricot'])for(const scheme of ['light','dark']) {
        const result=await page.evaluate(async({theme,scheme})=>{
          const app=fixture.app;document.documentElement.dataset.theme=theme;document.documentElement.dataset.colorScheme=scheme;
          document.documentElement.style.fontSize=innerWidth===320?'200%':'';
          app.mountPrivateSpaceDrawer(fixture.session,[{roomId:fixture.session.vault.roomId,name:'合成空间'}],app.runtimeAbort.signal,'chat',0);
          const sheet=document.querySelector('.is-settings-sheet'),panel=sheet.querySelector('.space-drawer');const start=panel.getBoundingClientRect().top;
          await new Promise(resolve=>{
            if(sheet.classList.contains('is-visible'))return resolve();
            const observer=new MutationObserver(()=>{if(sheet.classList.contains('is-visible')){observer.disconnect();resolve();}});
            observer.observe(sheet,{attributes:true,attributeFilter:['class']});
          });
          await Promise.all(panel.getAnimations().map(animation=>animation.finished));
          const scroll=sheet.querySelector('.space-drawer-scroll');scroll.scrollTop=scroll.scrollHeight;
          const last=scroll.querySelector('.space-settings-list').lastElementChild.querySelector('button');
          const bounds=last.getBoundingClientRect(),viewport=scroll.getBoundingClientRect();
          const result={start,top:panel.getBoundingClientRect().top,bottom:panel.getBoundingClientRect().bottom,handle:!!sheet.querySelector('.half-sheet-handle'),
            reachable:bounds.bottom<=viewport.bottom+1&&document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2)?.closest('button')===last,
            background:getComputedStyle(panel).backgroundColor,canvas:getComputedStyle(document.documentElement).backgroundColor,hint:document.querySelector('#system-chrome-color').content};
          sheet.querySelector('.space-close').click();
          await new Promise(resolve=>{
            if(!sheet.isConnected)return resolve();
            const observer=new MutationObserver(()=>{if(!sheet.isConnected){observer.disconnect();resolve();}});
            observer.observe(document.querySelector('#app'),{childList:true,subtree:true});
          });return result;
        },{theme,scheme});
        assert.ok(result.start>=567,JSON.stringify(result));assert.ok(Math.abs(result.top)<.01,JSON.stringify(result));assert.ok(Math.abs(result.bottom-568)<.01,JSON.stringify(result));assert.equal(result.handle,false);assert.equal(result.reachable,true,JSON.stringify(result));assert.equal(result.background,result.canvas);assert.equal(result.background,result.hint);
      }
    }
    await page.evaluate(()=>document.documentElement.style.fontSize='');
    await page.emulateMedia({reducedMotion:'reduce'});
    const reduced=await page.evaluate(()=>{
      const app=fixture.app;app.openMemePicker();app.closeMemePicker(false,true);
      const expression=!app.memePicker&&!document.querySelector('.meme-panel')&&!document.querySelector('#composer').classList.contains('has-meme-panel');
      app.toggleChatTools();app.closeChatTools(true);
      return expression&&document.querySelector('#chat-tools').hidden;
    });
    assert.equal(reduced,true);
    await page.emulateMedia({reducedMotion:'no-preference'});
    const privacy=await page.evaluate(()=>{
      const app=fixture.app;app.openMemePicker();app.closeMemePicker(false,true);
      const row=document.querySelector('.composer-row');app.lockNow();
      return !document.querySelector('.meme-panel')&&row.getAnimations().length===0;
    });
    assert.equal(privacy,true);
    assert.deepEqual(errors,[]);await page.evaluate(()=>{fixture.app.lockNow();stopChrome();});
    await browser.close();browser=null;
    console.log(`MOBILE_SAFARI_FEEDBACK_OK ${engine.name()}: IME, delayed Done, opaque underlay, full settings, eight themes, continuous panel/key focus, DPR3, bounded status animation. Synthetic viewport, not native iPhone evidence.`);
  }
} finally {await browser?.close();await server.close();}
