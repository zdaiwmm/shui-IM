import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit, devices } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { startServer } from '../../server/index.mjs';

// Optional baseline reads tracked source without switching or modifying this tree.
const baseline = process.env.SYNC_BASELINE;
if (baseline) assert.match(baseline, /^[a-f0-9]{40}$/);
const baselineSources = new Map(baseline ? [
  'src/app.ts', 'src/lib/vault.ts', 'src/lib/room-archive.ts', 'src/lib/archive-backup-state.ts',
].map(file => [path.resolve(file), execFileSync('git', ['show', `${baseline}:${file}`], {encoding:'utf8',maxBuffer:16*1024*1024})]) : []);

// Real three-device catch-up with a genuine sealed legacy 2 MiB archive checkpoint.
// Isolates resident checkpoint cost; live upload/restore is covered separately by
// room-archive-lifecycle. Timing is diagnostic; work/bytes and integrity are gated.
for (const {engine,mobile} of [{engine:chromium,mobile:false},{engine:chromium,mobile:true},{engine:webkit,mobile:true}]) {
  if (process.env.SYNC_ENGINE && process.env.SYNC_ENGINE !== engine.name()) continue;
  if (process.env.SYNC_MOBILE && String(Number(mobile)) !== process.env.SYNC_MOBILE) continue;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'qr-old-device-'));
  let backend, vite, browser;
  try {
    backend = await startServer({ dataDir, port: 0, host: '127.0.0.1', quiet: true });
    vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
      plugins: [{name:'sync-baseline', enforce:'pre', load(id) { return baselineSources.get(id.split('?')[0]); }}],
      server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
        '/api': { target: `http://127.0.0.1:${backend.port}`, changeOrigin: true },
        '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true },
      } } });
    vite.middlewares.use('/__catchup', (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');
    });
    await vite.listen();
    browser = await engine.launch(engine === chromium && !process.env.CI ? { channel: 'chrome' } : {});
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext({ locale: 'zh-CN', ...(mobile ? devices['iPhone 13'] : {viewport:{width:1280,height:900}}) });
      const page = await context.newPage(); pages.push(page);
      await page.goto(`http://localhost:${vite.httpServer.address().port}/__catchup`);
      await page.evaluate(async () => {
        window.c = await import('/src/lib/crypto.ts'); window.api = await import('/src/lib/api.ts');
        window.m = await import('/src/lib/mls.ts'); window.v = await import('/src/lib/vault.ts');
        window.identity = await c.generateIdentity();
        window.install = async vault => {
          const { QuietRoomApp } = await import('/src/app.ts');
          window.app = new QuietRoomApp(document.querySelector('#app'));
          app.session = await v.createVault(vault, 'synthetic-catchup-password', 'password');
          app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
          window.failures = [];
          app.operationalError = error => failures.push(String(error));
          app.fatalSecurityError = error => { failures.push(String(error)); app.privacyCovered = true; app.socket?.close(); };
          for (const name of ['renderMessages', 'updateConnectionStatus', 'updatePeerStatus', 'updateCallControls',
            'paintInviteProgress', 'showNotice', 'closeViewerIfProjectionDeleted']) app[name] = () => {};
          app.ensureCallController = () => {}; app.presenceCircuit = null;
        };
      });
    }
    const [old, peer, added] = pages;
    const device = await old.evaluate(() => ({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,touch:navigator.maxTouchPoints,coarse:matchMedia('(pointer: coarse)').matches,ua:navigator.userAgent}));
    assert.equal(device.width, mobile ? 390 : 1280);
    if (mobile) { assert.equal(device.dpr,3); assert.ok(device.coarse); if(engine === chromium) assert.ok(device.touch > 0); assert.match(device.ua,/iPhone/); }
    if (mobile) {
      await old.evaluate(() => { window.touchEvents = 0; document.addEventListener('touchstart', () => window.touchEvents++, {once:true}); });
      await old.touchscreen.tap(20,20);
      assert.equal(await old.evaluate(() => window.touchEvents),1,'Mobile input must dispatch a touch event');
    }
    const room = await old.evaluate(async () => {
      const room = await api.createRoom(identity.publicBundle, 'a'.repeat(43), 'i'.repeat(43), 'old', ['message-window-v1']);
      return { ...room, fingerprint: await c.bundleFingerprint(identity.publicBundle) };
    });
    await peer.evaluate(async room => api.joinRoom(room.roomId, 'i'.repeat(43), identity.publicBundle,
      await c.createJoinProof('p'.repeat(43), identity.publicBundle), 'b'.repeat(43), 'peer', ['message-window-v1']), room);
    for (const [i, page] of [old, peer].entries()) await page.evaluate(async ({ room, i }) => {
      const token = (i ? 'b' : 'a').repeat(43), state = await api.getRoomState(room.roomId, token);
      const vault = { v: 3, roomId: room.roomId, accessToken: token, role: i ? 'joiner' : 'creator',
        pairingSecret: 'p'.repeat(43), creatorFingerprint: room.fingerprint, identity, members: state.members,
        lastSeq: 0, lastReceiptSeq: 0, protocol: 'mls-rfc9420', createdAt: room.createdAt, pairingState: 'ready' };
      if (!i) {
        vault.mls = await m.createCreatorMlsState(room.roomId, identity, state.members);
        vault.mls = await m.prepareCreatorWelcome(vault);
        await api.publishMlsWelcome(room.roomId, token, vault.mls.pendingWelcome); vault.mls.pendingWelcome = undefined;
      } else vault.mls = await m.joinMlsGroup(vault, state.mlsWelcome);
      await install(vault); await app.connectSocket();
    }, { room, i });
    const healthy = async page => assert.deepEqual(await page.evaluate(() => failures), []);
    const caughtUp = async (page, seq) => {
      await page.waitForFunction(seq => app.session.vault.lastSeq >= seq || failures.length, seq, { timeout: 60_000 });
      await healthy(page);
    };
    const send = async (page, text) => {
      await page.evaluate(text => app.enqueuePayload({ v: 1, kind: 'text', text, sentAt: new Date().toISOString() }), text);
      const row = await page.waitForFunction(text => [...app.messages.values()].find(row =>
        row.senderId === identity.publicBundle.deviceId && row.payload.text === text), text);
      const { seq } = await row.jsonValue(); await row.dispose();
      await caughtUp(page, seq); return seq;
    };
    await send(old, 'before admission'); await caughtUp(peer, 1);
    const link = await old.evaluate(async () => {
      const linkId = crypto.randomUUID(), secret = 's'.repeat(43);
      await api.createDeviceLink(app.session.vault.roomId, app.session.vault.accessToken,
        identity.publicBundle.deviceId, linkId, secret, new Date(Date.now() + 600000).toISOString());
      return { linkId, secret };
    });
    const targetId = await added.evaluate(async link => {
      await api.claimDeviceLink(link.linkId, link.secret, identity.publicBundle, 'c'.repeat(43), 'added', ['message-window-v1']);
      return identity.publicBundle.deviceId;
    }, link);
    const admission = await old.evaluate(async targetId => {
      const session = app.session;
      const state = await api.getRoomState(session.vault.roomId, session.vault.accessToken);
      return v.withVaultMutation(session, async mutation => {
        await app.applyRoomState(state, mutation);
        session.vault.mls.pendingMembership = await m.prepareMlsMembership(session.vault, 'add', state.members.find(m => m.deviceId === targetId));
        await v.saveVault(session, mutation);
        const result = await api.publishMlsMembership(session.vault.roomId, session.vault.accessToken, session.vault.mls.pendingMembership.event);
        await app.applyRoomState(result.state, mutation);
        return result.state;
      });
    }, targetId);
    await added.evaluate(async ({ room, admission }) => {
      const own = admission.members.find(member => member.deviceId === identity.publicBundle.deviceId);
      const event = admission.mlsEvents.find(item => item.event.targetId === own.deviceId);
      const vault = { v: 3, roomId: room.roomId, accessToken: 'c'.repeat(43), role: 'creator', pairingSecret: '',
        creatorFingerprint: room.fingerprint, identity, members: admission.members, lastSeq: own.joinSeq,
        lastReceiptSeq: own.joinReceiptSeq, historyUnavailableBeforeSeq: own.joinSeq, protocol: 'mls-rfc9420',
        createdAt: room.createdAt, pairingState: 'ready', mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: event.eventSeq - 1 } };
      vault.mls = await m.joinMlsMembership(vault, event.event, event.eventSeq);
      await install(vault); await app.connectSocket();
    }, { room, admission });
    await old.evaluate(() => app.socket.close());
    const count = Number(process.env.SYNC_COUNT ?? 270);
    for (let i = 0; i < count; i++) await send(added, `backlog ${i}:` + '测'.repeat(120));
    const tail = backend.store.roomState(room.roomId).nextSeq;
    await old.evaluate(async heavy => {
      if (!heavy) return;
      const archive = await import('/src/lib/room-archive-crypto.ts');
      const { toBase64Url } = await import('/src/lib/base64.ts');
      const key = archive.newArchiveKey();
      const next = await archive.sealArchiveObject(key, { v:2,kind:'media',blobId:crypto.randomUUID(),index:0,bytes:toBase64Url(new Uint8Array(2*1024*1024+16)) });
      app.session.vault.archiveState = {cursor:0,revision:0,preparing:{itemId:crypto.randomUUID(),media:[],next}};
      await v.saveVault(app.session);
    }, process.env.SYNC_HEAVY !== '0');
    await old.evaluate(async () => {
      await import('/src/styles.css'); await import('/src/chat-layout.css');
      delete app.renderMessages;
      window.profile = { started:performance.now(),encryptMs:0,encryptBytes:0,encryptCalls:0,renderMs:0,renders:0,frameGaps:[],httpRecords:0,httpPages:0,httpSeqs:[],idbPuts:0 };
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      crypto.subtle.encrypt = async function(...args) {
        const start=performance.now();profile.encryptBytes+=args[2].byteLength;profile.encryptCalls++;
        try { return await encrypt(...args); } finally {profile.encryptMs+=performance.now()-start;}
      };
      const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(...args){profile.idbPuts++;return put.apply(this,args);};
      const fetch=window.fetch.bind(window);
      window.fetch=async function(...args){const response=await fetch(...args);if(String(args[0]).includes('/window-sync?')){const data=await response.clone().json();profile.httpPages++;profile.httpRecords+=data.messages.length;profile.httpSeqs.push(...data.messages.map(x=>x.seq));}return response;};
      const render=app.renderMessages.bind(app);
      app.renderMessages=function(...args){const start=performance.now();try{return render(...args);}finally{profile.renderMs+=performance.now()-start;profile.renders++;}};
      let last=performance.now();window.sampling=true;
      const frame=()=>{const now=performance.now();profile.frameGaps.push(now-last);last=now;if(sampling)requestAnimationFrame(frame);};requestAnimationFrame(frame);
      await app.openSession();
      profile.firstRowMs=performance.now()-profile.started;
    });
    await old.bringToFront();
    await old.locator('#message-input').fill('synthetic typing during catch-up');
    await old.waitForFunction(seq => app.messages.has(seq)||failures.length, tail, {timeout:180000});
    await healthy(old);
    const measured=await old.evaluate(()=>{sampling=false;const p=profile;const gaps=p.frameGaps.sort((a,b)=>a-b);return {...p,elapsedMs:performance.now()-p.started,uniqueHttpRecords:new Set(p.httpSeqs).size,httpSeqs:undefined,frameGaps:undefined,frameP95:gaps[Math.floor(gaps.length*.95)],frameMax:Math.max(...gaps),draft:document.querySelector('#message-input').value,vaultBytes:app.session.stored.payload.ciphertext.length};});
    assert.equal(measured.draft,'synthetic typing during catch-up');
    if (!baseline) {
    assert.ok(measured.vaultBytes < 100_000, 'Backup ciphertext must not remain in the chat vault');
    assert.ok(measured.encryptBytes < 32 * 1024 ** 2, 'Receiving must not re-encrypt a backup chunk per message');
    assert.equal(measured.httpRecords,measured.uniqueHttpRecords,'A continuous retained backlog must reuse already downloaded ciphertext');
    }
    const sequence=await old.evaluate(async tail=>{
      await v.withVaultMutation(app.session,async()=>{});
      const rows=await v.loadHistoryPageAfter(app.session,{afterSeq:0,limit:1000});
      return rows.filter(x=>x.seq<=tail).map(x=>x.seq);
    },tail);
    assert.deepEqual(sequence,Array.from({length:tail},(_,i)=>i+1));
    console.log('SYNC_PROFILE '+JSON.stringify({baseline:baseline ?? null,device,engine:engine.name(),mobile:mobile,heavy:process.env.SYNC_HEAVY !== '0',count,tail,...measured}));
  } finally {
    await browser?.close(); await vite?.close(); await backend?.close(); await rm(dataDir,{recursive:true,force:true});
  }
}
