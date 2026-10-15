import { auditP1Surface } from './helpers/p1-surface-audit.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__voice_gestures', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="app"></div></body></html>');
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' }), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.context().grantPermissions(['microphone']);
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__voice_gestures`);
  await page.evaluate(async () => {
    await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
    const { QuietRoomApp } = await import('/src/app.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    app.updateSafetyCode = async () => {}; app.flushUiPreferencesSave = () => {};
    app.saveUiPreferencesNow = async () => {};
    const tracks = [], sends = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await capture(options); tracks.push(...stream.getTracks()); return stream; };
    const begin = app.beginVoiceRecording.bind(app);
    app.beginVoiceRecording = mode => {
      const recorder = begin(mode);
      if (recorder) recorder.callbacks.send = async (draft, signal) => {
        signal.throwIfAborted(); sends.push({ id: draft.clientMsgId, duration: draft.durationMs }); app.closeVoiceRecorder();
      };
      return recorder;
    };
    const fresh = () => {
      app.lockNow();
      const own = { deviceId: 'voice-own', role: 'creator', status: 'active', capabilities: ['voice-message-v1'] };
      app.session = { vault: { roomId: 'voice-gestures', role: 'creator', protocol: 'legacy-v1', members: [own], identity: { publicBundle: own } } };
      app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
      app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
      app.renderChat();
    };
    window.fixture = { app, fresh, capture, tracks, sends }; fresh();
  });
  const cdp = await page.context().newCDPSession(page);
  let origin;
  const touch = async (type, point = origin) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd','touchCancel'].includes(type) ? [] : [{ ...point, id: 1 }] });
    await page.waitForTimeout(40);
  };
  const reset = async () => { await page.evaluate(() => window.fixture.fresh()); await page.waitForTimeout(200); };
  const hold = async (waitForMedia = true) => {
    const box = await page.locator('#record-voice').boundingBox(); origin = { x: box.x + box.width/2, y: box.y + box.height / 2 };
    await touch('touchStart');
    await page.waitForFunction(() => Boolean(window.fixture.app.voiceRecorder));
    if (waitForMedia) await page.waitForFunction(() => document.querySelector('.voice-recorder').dataset.state === 'recording');
  };
  const count = () => page.evaluate(() => window.fixture.sends.length);
  const stopped = () => page.waitForFunction(() => window.fixture.tracks.every(t => t.readyState === 'ended'));
  const closed = () => page.waitForFunction(() => !window.fixture.app.voiceRecorder);
  const cancelPoint = async () => ({ x: origin.x - 110, y: origin.y });

  await page.locator('#message-input').tap();
  assert.equal(await count(),0); assert.equal(await page.locator('.voice-recorder').isVisible(),false);
  // A slow ordinary desktop click and touch tap must still enter typing.
  await page.locator('#message-input').click({ delay: 300 });
  assert.equal(await page.locator('.voice-recorder').isVisible(), false);
  assert.equal(await page.locator('#message-input').evaluate(e => document.activeElement === e), true);
  const tapBox = await page.locator('#message-input').boundingBox();
  origin = { x: tapBox.x + 30, y: tapBox.y + tapBox.height / 2 };
  await touch('touchStart'); await page.waitForTimeout(280); await touch('touchEnd');
  assert.equal(await page.locator('.voice-recorder').isVisible(), false);
  assert.equal(await page.evaluate(() => window.fixture.tracks.length), 0, 'short input presses must never request capture');
  await page.locator('#message-input').fill('已有草稿');
  const draftBox=await page.locator('#message-input').boundingBox();
  origin={x:draftBox.x+30,y:draftBox.y+20}; await touch('touchStart'); await page.waitForTimeout(450); await touch('touchEnd');
  assert.equal(await page.locator('.voice-recorder').isVisible(),false);
  assert.equal(await page.locator('#message-input').inputValue(),'已有草稿');

  await reset();
  const composerStart = await page.evaluate(() => {
    window.originalComposerInput = document.querySelector('#message-input');
    const input = originalComposerInput, field = input.closest('.composer-input-stack').getBoundingClientRect();
    const plus = document.querySelector('#open-chat-tools').getBoundingClientRect();
    const voice = document.querySelector('#record-voice').getBoundingClientRect();
    const style = getComputedStyle(input), placeholder = getComputedStyle(input, '::placeholder');
    return { left: field.left, right: field.right, plusRight: plus.right, voiceLeft: voice.left,
      balanced: style.paddingTop === style.paddingBottom, font: style.fontSize, placeholderFont: placeholder.fontSize, line: style.lineHeight, placeholderLine: placeholder.lineHeight };
  });
  assert(composerStart.plusRight <= composerStart.left && composerStart.right <= composerStart.voiceLeft);
  assert(composerStart.balanced && composerStart.font === composerStart.placeholderFont && composerStart.line === composerStart.placeholderLine);
  await page.locator('#message-input').fill('输入后显示发送按钮');
  await page.waitForTimeout(260);
  const composerText = await page.evaluate(() => {
    const field = document.querySelector('.composer-input-stack').getBoundingClientRect(), send = document.querySelector('#send-text').getBoundingClientRect();
    return { left: field.left, right: field.right, sendInside: send.left >= field.left && send.right <= field.right,
      sameInput: originalComposerInput === document.querySelector('#message-input'), hiddenVoice: document.querySelector('#record-voice').disabled };
  });
  assert.equal(composerText.left, composerStart.left);
  assert(composerText.right > composerStart.right && composerText.sendInside && composerText.sameInput && composerText.hiddenVoice);
  await page.locator('#message-input').fill(''); await page.waitForTimeout(260);
  assert.equal(await page.locator('.composer-input-stack').evaluate(el => el.getBoundingClientRect().right), composerStart.right);

  await page.locator('#open-chat-tools').click();
  const panelGeometry = await page.evaluate(() => {
    const input = document.querySelector('.composer-input-stack').getBoundingClientRect();
    const voice = document.querySelector('#record-voice').getBoundingClientRect();
    const panel = document.querySelector('#chat-tools').getBoundingClientRect();
    return { aligned: Math.abs(input.bottom - voice.bottom) < 2, abovePanel: voice.bottom < panel.top };
  });
  assert.deepEqual(panelGeometry, { aligned: true, abovePanel: true });
  await reset(); await hold(); await page.waitForTimeout(700);
  assert.equal(await page.locator('.voice-recording-dot').evaluate(el=>getComputedStyle(el).animationName),'voice-recording-pulse');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.voice-recording-dot').evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await touch('touchEnd'); await closed(); await stopped(); assert.equal(await count(),1);
  await reset(); await hold(); await page.waitForTimeout(650);
  const originalOrbWidth = await page.locator('.voice-hold-orb').evaluate(e=>e.getBoundingClientRect().width);
  await touch('touchMove',await cancelPoint());
  assert.ok(await page.locator('.voice-hold-orb').evaluate(e=>e.getBoundingClientRect().width)>originalOrbWidth,'Sliding left grows the recording circle');
  assert.equal(await page.locator('.voice-recorder').getAttribute('data-hold-action'),'cancel');
  assert.equal(await page.locator('.voice-hold-orb').evaluate(async el => {
    await Promise.allSettled(el.getAnimations().map(animation => animation.finished));
    return getComputedStyle(el).backgroundColor;
  }), await page.evaluate(() => {
    const probe = document.createElement('div'); probe.style.background = 'var(--danger-fill)'; document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color;
  }), 'Slide-to-cancel retains the destructive action color');
  await touch('touchEnd'); await closed(); await stopped(); assert.equal(await count(),1);
  await reset(); await hold(); await page.waitForTimeout(650);
  await touch('touchMove',await cancelPoint());
  await touch('touchMove',origin);
  assert.equal(await page.locator('.voice-recorder').getAttribute('data-hold-action'),'send');
  await touch('touchEnd'); await closed(); assert.equal(await count(),2);

  // Vertical travel locks recording. Release cannot send; pause, preview and
  // resume remain deliberate actions, using the real synthetic microphone.
  await reset(); await hold(); await page.waitForTimeout(650);
  await touch('touchMove',{x:origin.x,y:origin.y-85});
  assert.equal(await page.locator('.voice-recorder').getAttribute('data-mode'),'hold','Old 72px travel must not lock early');
  await touch('touchMove',{x:origin.x,y:origin.y-155});
  assert.equal(await page.locator('.voice-recorder').getAttribute('data-mode'),'locked');
  assert.equal(await page.locator('.voice-send').evaluate(e=>e.getBoundingClientRect().width),72,'locked send disc keeps the compact recording scale');
  await touch('touchEnd');
  await auditP1Surface(page,'voice-locked-recording','.voice-recorder');
  assert.equal(await count(),2);
  await page.getByRole('button',{name:'暂停录音',exact:true}).click();
  await page.locator('.voice-recorder[data-state="paused"]').waitFor(); await stopped();
  await auditP1Surface(page,'voice-paused','.voice-recorder');
  await page.waitForFunction(()=>Math.abs(document.querySelector('.voice-send').getBoundingClientRect().width-44)<.1);
  assert.equal(await page.locator('.voice-send').evaluate(e=>getComputedStyle(e).width),'44px','paused send must retain the input-row scale');
  await page.getByRole('button',{name:'试听录音',exact:true}).click();
  await page.getByRole('button',{name:'暂停试听',exact:true}).waitFor();
  await page.evaluate(()=>{
    fixture.resumeQuery=navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query=async options=>options.name==='microphone'?{state:'prompt'}:fixture.resumeQuery(options);
  });
  await page.getByRole('button',{name:'继续录音',exact:true}).click();
  await page.locator('.voice-recorder[data-state="recording"]').waitFor();
  await page.evaluate(()=>{navigator.permissions.query=fixture.resumeQuery;});
  await page.locator('.voice-cancel').click(); await closed(); await stopped();
  assert.equal(await count(),2);
  // Known PCM samples make selection/export correctness inspectable, independently
  // of fake microphone silence and the browser's container encoder.
  await reset(); await hold(); await page.waitForTimeout(650);
  await touch('touchMove',{x:origin.x,y:origin.y-155});await touch('touchEnd');
  await page.getByRole('button',{name:'暂停录音',exact:true}).click();await page.locator('.voice-recorder[data-state="paused"]').waitFor();
  await page.evaluate(()=>{
    const r=fixture.app.voiceRecorder;r.clearPreview();r.samples=Float32Array.from({length:72000},(_,i)=>i/72000);r.trimStart=0;r.trimEnd=72000;r.draft=null;r.waveform=null;r.update();
  });
  for(let i=0;i<5;i++)await page.getByRole('slider',{name:'裁剪起点'}).press('ArrowRight');
  for(let i=0;i<10;i++)await page.getByRole('slider',{name:'裁剪终点'}).press('ArrowLeft');
  const trimmed=await page.evaluate(async()=>{
    const r=fixture.app.voiceRecorder,draft=r.getDraft(),bytes=new DataView(await draft.file.arrayBuffer());
    return {duration:draft.durationMs,size:draft.file.size,start:bytes.getInt16(44,true),end:bytes.getInt16(draft.file.size-2,true),selected:r.selectedDurationMs};
  });
  assert.deepEqual(trimmed,{duration:1500,size:72044,start:5461,end:21844,selected:1500});
  const trimTargets=await page.evaluate(()=>{
    const r=fixture.app.voiceRecorder,end=r.trimEnd;r.trimEnd=r.trimStart+12000;r.update();
    const start=document.querySelector('[data-trim=start]').getBoundingClientRect(),finish=document.querySelector('[data-trim=end]').getBoundingClientRect(),play=document.querySelector('.voice-preview').getBoundingClientRect(),track=document.querySelector('.voice-draft-timeline').getBoundingClientRect();
    r.trimEnd=end;r.update();return {separate:start.right<=finish.left,preview:play.top>=track.top&&play.bottom<=track.bottom&&play.left>=track.left&&play.right<=start.left,start:start.width,end:finish.width};
  });assert.deepEqual(trimTargets,{separate:true,preview:true,start:44,end:44},'Even the minimum selection keeps independent 44px trim targets and a reachable preview');
  const trimGeometry=await page.evaluate(()=>{
    const selected=document.querySelector('.voice-trim-selection').getBoundingClientRect();
    const marker=edge=>{const node=document.querySelector(`[data-trim=${edge}]`),r=node.getBoundingClientRect(),style=getComputedStyle(node,'::after');return r.left+parseFloat(style.left)+parseFloat(style.width)/2;};
    const button=document.querySelector('.voice-send').getBoundingClientRect(),svg=document.querySelector('.voice-send svg'),box=svg.getBBox(),r=svg.getBoundingClientRect();
    return {start:Math.abs(marker('start')-selected.left),end:Math.abs(marker('end')-selected.right),dx:Math.abs(r.left+(box.x+box.width/2)*r.width/24-(button.left+button.width/2)),dy:Math.abs(r.top+(box.y+box.height/2)*r.height/24-(button.top+button.height/2))};
  });
  assert.ok(Object.values(trimGeometry).every(delta=>delta<.6),JSON.stringify(trimGeometry));
  const beforeDrag=await page.evaluate(()=>({start:fixture.app.voiceRecorder.trimStart,end:fixture.app.voiceRecorder.trimEnd,width:document.querySelector('.voice-trim-track').getBoundingClientRect().width}));
  const boundary=await page.getByRole('slider',{name:'裁剪起点'}).boundingBox();
  await page.mouse.move(boundary.x+boundary.width-1,boundary.y+22);await page.mouse.down();
  await page.mouse.move(boundary.x+boundary.width+11,boundary.y+22);await page.mouse.up();
  assert.equal(await page.evaluate(()=>fixture.app.voiceRecorder.trimStart),Math.round(beforeDrag.start+12/beforeDrag.width*72000),'Actual pointer travel and painted selection use the same track');
  await page.evaluate(({start,end})=>{const r=fixture.app.voiceRecorder;r.trimStart=start;r.trimEnd=end;r.draft=null;r.update();},beforeDrag);
  if(process.argv[2]) {await mkdir(process.argv[2],{recursive:true});await page.screenshot({path:path.join(process.argv[2],'voice-trim-inline.png')});}

  await page.getByRole('button',{name:'试听录音',exact:true}).click();
  await page.waitForFunction(()=>fixture.app.voiceRecorder.preview.duration===1.5);
  await page.getByRole('slider',{name:'裁剪起点'}).press('ArrowRight');
  assert.equal(await page.evaluate(()=>fixture.app.voiceRecorder.preview.paused),true,'Changing selection stops old playback immediately');
  await page.evaluate(()=>{window.trimAttempts=[];const r=fixture.app.voiceRecorder;r.callbacks.send=async draft=>{trimAttempts.push(draft);if(trimAttempts.length===1)throw Error('Synthetic upload failure');};});
  await page.locator('.voice-send').click();await page.locator('.voice-recorder[data-state="paused"]').waitFor();
  assert.equal(await page.getByRole('slider',{name:'裁剪起点'}).isDisabled(),true);
  await page.locator('.voice-send').click();
  const frozen=await page.evaluate(()=>({same:trimAttempts[0]===trimAttempts[1],duration:trimAttempts[1].durationMs,id:trimAttempts[0].clientMsgId===trimAttempts[1].clientMsgId}));
  assert.deepEqual(frozen,{same:true,duration:1400,id:true});
  await page.evaluate(()=>fixture.app.lockNow());await stopped();

  await reset(); await hold(); await touch('touchCancel'); await closed(); await stopped();

  // A release before permission settles cannot start capture after a late grant.
  await reset();
  await page.evaluate(()=>{ window.fixture.wrapped=navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.fixture.grant=resolve); });
  await hold(false); await page.waitForFunction(()=>Boolean(fixture.grant));
  assert.equal(await page.locator('.voice-recorder').isVisible(),false,'Pending permission must retain the ordinary input row');
  await touch('touchEnd'); await closed();
  await page.evaluate(async()=>{const stream=await window.fixture.capture({audio:true});window.fixture.tracks.push(...stream.getTracks());window.fixture.grant(stream);navigator.mediaDevices.getUserMedia=window.fixture.wrapped;});
  await stopped(); assert.equal(await count(),2);
  await reset(); await hold(); await page.evaluate(()=>window.fixture.app.lockNow()); await touch('touchEnd'); await stopped();
  assert.equal(await count(),2);

  await reset();
  await page.evaluate(()=>{
    fixture.query=navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query=async options=>options.name==='microphone'?{state:fixture.permissionState??'prompt'}:fixture.query(options);
    fixture.wrapped=navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>fixture.firstGrant=resolve);
  });
  await hold(false);await page.waitForFunction(()=>Boolean(fixture.firstGrant));
  assert.equal(await page.locator('.voice-recorder').isVisible(),false);
  assert.equal(await page.locator('#composer').evaluate(e=>e.classList.contains('has-voice-draft')),false);
  await page.evaluate(async()=>{const stream=await fixture.capture({audio:true});fixture.tracks.push(...stream.getTracks());fixture.firstGrant(stream);navigator.mediaDevices.getUserMedia=fixture.wrapped;});
  await closed();await stopped();await touch('touchEnd');assert.equal(await count(),2,'Authorization never records or sends');
  // A successful preparation must work even when the optional query still says prompt.
  assert.equal(await page.evaluate(()=>fixture.app.voicePermissionPrepared),true);
  await hold();await page.waitForTimeout(650);await touch('touchEnd');await closed();await stopped();assert.equal(await count(),3,'A new hold records after authorization');
  await page.evaluate(()=>{fixture.app.lockNow();if(fixture.app.voicePermissionPrepared)throw Error('Permission preparation crossed runtime teardown');navigator.permissions.query=fixture.query;});

  if(process.argv[2]) await mkdir(process.argv[2],{recursive:true});
  for(const [width,height,colorScheme] of [[320,844,'light'],[390,844,'light'],[390,844,'dark'],[844,390,'light'],[768,844,'light'],[1280,844,'light']]) {
    await page.emulateMedia({colorScheme});
    await page.setViewportSize({width,height}); await reset(); await hold();
    const geometry=await page.evaluate(()=>{
      const orb=document.querySelector('.voice-hold-orb').getBoundingClientRect();
      const bar=document.querySelector('.voice-recording-bar').getBoundingClientRect();
      const guide=document.querySelector('.voice-lock-guide').getBoundingClientRect();
      return {left:orb.left,right:orb.right,bottom:orb.bottom,width:innerWidth,height:innerHeight,guideTop:guide.top,barTop:bar.top};
    });
    assert(geometry.left>=0 && geometry.right<=geometry.width+1 && geometry.bottom<=geometry.height+1 && geometry.guideTop>=0 && geometry.guideTop<geometry.barTop,JSON.stringify(geometry));
    const suffix=colorScheme==='dark'?`${width}-dark`:width;
    if(process.argv[2]) await page.screenshot({path:path.join(process.argv[2],`voice-${suffix}.png`)});
    await touch('touchMove',await cancelPoint());
    if(process.argv[2]) await page.screenshot({path:path.join(process.argv[2],`cancel-${suffix}.png`)});
    await touch('touchEnd'); await closed(); await stopped();
  }
  assert.deepEqual(errors,[]);
  console.log('Voice button gestures passed: input/edit, hold/send, cancel/reentry, slide-lock, pause/preview/resume, interruption, late grant and responsive geometry.');
} finally { await browser?.close(); await server.close(); }
