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
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__voice_gestures`);
  await page.evaluate(async () => {
    for (const style of ['styles','chat-layout','gallery','chat-interactions','cover','voice-messages','call','chat-tools']) await import(`/src/${style}.css`);
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
      app.uiPreferences = { recoveryReminderDismissed: true };
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
    const box = await page.locator('#message-input').boundingBox(); origin = { x: box.x + 35, y: box.y + box.height / 2 };
    await touch('touchStart');
    await page.locator('.voice-recorder:not([hidden])').waitFor();
    if (waitForMedia) await page.waitForFunction(() => document.querySelector('.voice-recorder').dataset.state === 'recording');
  };
  const count = () => page.evaluate(() => window.fixture.sends.length);
  const stopped = () => page.waitForFunction(() => window.fixture.tracks.every(t => t.readyState === 'ended'));
  const closed = () => page.waitForFunction(() => !window.fixture.app.voiceRecorder);
  const cancelPoint = () => page.locator('.voice-cancel-zone').evaluate(e => { const r=e.getBoundingClientRect(); return { x:r.x+r.width/2,y:r.y+r.height*.43 }; });

  await page.locator('#message-input').tap();
  assert.equal(await count(),0); assert.equal(await page.locator('.voice-recorder').isVisible(),false);
  await page.locator('#message-input').fill('已有草稿');
  const draftBox=await page.locator('#message-input').boundingBox();
  origin={x:draftBox.x+30,y:draftBox.y+20}; await touch('touchStart'); await page.waitForTimeout(450); await touch('touchEnd');
  assert.equal(await page.locator('.voice-recorder').isVisible(),false);
  assert.equal(await page.locator('#message-input').inputValue(),'已有草稿');

  await reset(); await hold(); await page.waitForTimeout(700);
  await touch('touchEnd'); await closed(); await stopped(); assert.equal(await count(),1);
  await reset(); await hold(); await page.waitForTimeout(650);
  await touch('touchMove',await cancelPoint());
  assert.equal(await page.locator('.voice-recorder').getAttribute('data-hold-action'),'cancel');
  await touch('touchEnd'); await closed(); await stopped(); assert.equal(await count(),1);
  await reset(); await hold(); await page.waitForTimeout(650);
  await touch('touchMove',await cancelPoint());
  await touch('touchMove',origin);
  assert.equal(await page.locator('.voice-recorder').getAttribute('data-hold-action'),'send');
  await touch('touchEnd'); await closed(); assert.equal(await count(),2);

  // The box corners are outside the rounded arc and must not cancel.
  await reset(); await hold();
  const corner=await page.locator('.voice-cancel-zone').evaluate(e=>{ const r=e.getBoundingClientRect(); return {x:r.x+1,y:r.y+1}; });
  await touch('touchMove',corner);
  assert.equal(await page.locator('.voice-recorder').getAttribute('data-hold-action'),'send');
  await touch('touchCancel'); await closed(); await stopped(); assert.equal(await count(),2);

  // A release before permission settles cannot start capture after a late grant.
  await reset();
  await page.evaluate(()=>{ window.fixture.wrapped=navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.fixture.grant=resolve); });
  await hold(false); await touch('touchEnd'); await closed();
  await page.evaluate(async()=>{const stream=await window.fixture.capture({audio:true});window.fixture.tracks.push(...stream.getTracks());window.fixture.grant(stream);navigator.mediaDevices.getUserMedia=window.fixture.wrapped;});
  await stopped(); assert.equal(await count(),2);
  await reset(); await hold(); await page.evaluate(()=>window.fixture.app.lockNow()); await touch('touchEnd'); await stopped();
  assert.equal(await count(),2);

  if(process.argv[2]) await mkdir(process.argv[2],{recursive:true});
  for(const [width,height,colorScheme] of [[320,844,'light'],[390,844,'light'],[390,844,'dark'],[844,390,'light'],[768,844,'light'],[1280,844,'light']]) {
    await page.emulateMedia({colorScheme});
    await page.setViewportSize({width,height}); await reset(); await hold();
    const geometry=await page.evaluate(()=>{
      const zone=document.querySelector('.voice-cancel-zone').getBoundingClientRect();
      const bed=document.querySelector('.voice-hold-bed').getBoundingClientRect();
      const card=document.querySelector('.voice-live-card').getBoundingClientRect();
      return {left:zone.left,right:zone.right,width:innerWidth,bedHeight:bed.height,cardBottom:card.bottom,zoneTop:zone.top};
    });
    assert(geometry.left>0 && geometry.right<geometry.width && geometry.bedHeight>=(height<=600?100:150) && geometry.cardBottom<geometry.zoneTop);
    const suffix=colorScheme==='dark'?`${width}-dark`:width;
    if(process.argv[2]) await page.screenshot({path:path.join(process.argv[2],`voice-${suffix}.png`)});
    await touch('touchMove',await cancelPoint());
    if(process.argv[2]) await page.screenshot({path:path.join(process.argv[2],`cancel-${suffix}.png`)});
    await touch('touchEnd'); await closed(); await stopped();
  }
  assert.deepEqual(errors,[]);
  console.log('Voice input gestures passed: tap/edit, hold/send, curved hit testing, cancel/reentry, interruption, late grant and responsive geometry.');
} finally { await browser?.close(); await server.close(); }
