import assert from 'node:assert/strict';

// Real service, two independent browser profiles, and an intentionally orphaned
// pre-fix local slot. No user data or production endpoints are involved.
export async function repairHistoryScopeJourney({ origin, newPage, send, errors }) {
  let helper = await newPage();
  const helperContext = helper.context(), recipient = await newPage();
  for (const page of [helper, recipient]) page.on('pageerror', cause => errors.push(cause.message));
  const ready = page => page.waitForFunction(() => window.app?.session?.vault.pairingState === 'ready' && app.connectionState === 'connected' && document.querySelector('#message-input')?.disabled === false);
  await helper.goto(origin); await helper.locator('#create-room').click(); await helper.locator('#copy-invite').click();
  await helper.locator('.app-toast').filter({ hasText: '已复制' }).waitFor();
  const initialInvite = await helper.evaluate(() => navigator.clipboard.readText());
  await recipient.goto(initialInvite); await ready(recipient); await ready(helper);
  await recipient.evaluate(async () => {
    const source = app.session;
    await app.leaveSpace();
    delete source.vault.localDataScope; // The old release keyed local records by room ID.
    await (await import('/src/lib/vault.ts')).saveVault(source);
    app.session = source; await app.openSession();
  });
  await ready(recipient);
  await send(recipient, 'original local history'); await helper.getByText('original local history', { exact: true }).waitFor();
  await send(recipient, 'must remain retracted'); await helper.getByText('must remain retracted', { exact: true }).waitFor();
  await recipient.waitForFunction(() => [...app.messages.values()].some(message => message.payload.text === 'must remain retracted'
    && Number.isSafeInteger(message.seq) && message.seq < Number.MAX_SAFE_INTEGER && message.status !== 'pending'));
  await recipient.evaluate(async () => {
    const target = [...app.messages.values()].find(message => message.payload.text === 'must remain retracted');
    await app.sendPayload({ v: 1, kind: 'message-delete', sentAt: new Date().toISOString(),
      target: { clientMsgId: target.clientMsgId, serverSeq: target.seq, senderId: target.senderId } });
  });
  await recipient.getByText('must remain retracted', { exact: true }).waitFor({ state: 'hidden' });
  await helper.getByText('must remain retracted', { exact: true }).waitFor({ state: 'hidden' });
  await recipient.waitForFunction(() => app.outbox.size === 0);
  const [chooser] = await Promise.all([recipient.waitForEvent('filechooser'), recipient.locator('#file-input').evaluate(input => input.click())]);
  await chooser.setFiles({ name: 'retained-original.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('original file bytes') });
  for (const page of [recipient, helper]) await page.locator('.file-attachment').filter({ hasText: 'retained-original.bin' }).waitFor();
  await Promise.all([recipient.waitForEvent('download'), recipient.locator('.file-attachment').filter({ hasText: 'retained-original.bin' }).click()]);
  const sourceId = await recipient.evaluate(() => app.session.vault.identity.publicBundle.deviceId);
  await helper.locator('#chat-settings').click(); await helper.locator('#help-peer-enter').click();
  await helper.locator(`[data-device-id="${sourceId}"]`).click();
  await helper.locator('.peer-device-continue').click();await helper.locator('[data-help-action]').click();await helper.locator('[data-copy-peer-link]').click(); await helper.locator('.app-toast').filter({ hasText: '聊天链接已复制' }).waitFor();
  const link = await helper.evaluate(() => navigator.clipboard.readText());
  await helper.close(); // Completion must wait until this browser returns to foreground chat.
  const original = await recipient.evaluate(async () => {
    const source = app.session;
    await app.leaveSpace();
    window.scopeOriginal = source;
    app.newSpaceCollectionCode = undefined; // Creation from the old inaccessible gateway has no inherited directory.
    await (await import('/src/lib/vault.ts')).selectLocalSpace(crypto.randomUUID());
    app.renderFirstRun(null);
    return { stored: JSON.stringify(source.stored), archiveId: source.vault.roomArchiveV2.key.descriptor.id, roomId: source.vault.roomId };
  });
  await recipient.locator('#create-room').click(); await recipient.locator('#copy-invite').waitFor();
  await recipient.reload(); await recipient.locator('#copy-invite').waitFor();
  assert.equal(await recipient.evaluate(async roomId => (await (await import('/src/lib/spaces.ts')).localSpaces(app.session)).some(space => space.roomId === roomId), original.roomId), false);
  const newRoom = await recipient.evaluate(async () => { const current = app.session; await app.leaveSpace(); return { roomId: current.vault.roomId, stored: JSON.stringify(current.stored) }; });
  await recipient.goto(link); await recipient.locator('[data-joining-card]').waitFor();
  await recipient.waitForFunction(() => app.session?.vault.pendingRepair?.sourceDeviceId);
  assert.equal(await recipient.locator('#message-input:not([disabled])').count(), 0);
  helper = await helperContext.newPage(); helper.on('pageerror', cause => errors.push(cause.message));
  await helper.goto(origin); await ready(helper); await ready(recipient);
  await recipient.getByText('original local history', { exact: true }).waitFor();
  assert.equal(await recipient.getByText('must remain retracted', { exact: true }).count(), 0);
  const recovered = await recipient.evaluate(async ({ original, newRoom, sourceId }) => {
    const current = app.session, v = await import('/src/lib/vault.ts');
    const database = await new Promise(resolve => { const request = indexedDB.open('quiet-room'); request.onsuccess = () => resolve(request.result); });
    const read = id => new Promise(resolve => { const tx = database.transaction('vault', 'readonly'), request = tx.objectStore('vault').get(id); tx.oncomplete = () => resolve(JSON.stringify(request.result)); });
    const old = await read(JSON.parse(original.stored).spaceId), other = await read(JSON.parse(newRoom.stored).spaceId); database.close();
    const file = (await v.loadHistory(current)).find(message => message.payload.kind === 'file' && message.payload.file.originalName === 'retained-original.bin').payload.file;
    const originalBytes = await v.loadCachedMediaChunk(current, file.blobId, 0, file.originalSize + 16);
    const restored = originalBytes && await (await import('/src/lib/file-crypto.ts')).decryptFileAttachment(file, async () => originalBytes);
    return { archive: current.vault.roomArchiveV2.key.descriptor.id === original.archiveId,
      original: old === original.stored, newRoom: other === newRoom.stored,
      slot: current.stored.spaceId !== JSON.parse(original.stored).spaceId, draftOwner: current.vault.localPreferenceDeviceId === current.vault.members.find(member => member.deviceId === sourceId)?.deviceId,
      originalBytes: restored !== null && await restored.text() === 'original file bytes' };
  }, { original, newRoom, sourceId });
  assert.deepEqual(recovered, { archive: true, original: true, newRoom: true, slot: true, draftOwner: true, originalBytes: true });
  const activeDevice = await recipient.evaluate(() => app.session.vault.identity.publicBundle.deviceId);
  // A saved home opened in an old tab retains its own sessionStorage selection,
  // even though this browser's durable selection points at the repaired slot.
  const staleTab = await recipient.context().newPage();
  staleTab.on('pageerror', cause => errors.push(cause.message));
  await staleTab.goto(`${origin}/favicon.svg`);
  await staleTab.evaluate(id => sessionStorage.setItem('quiet-room:space', id), JSON.parse(original.stored).spaceId);
  await recipient.evaluate(() => app.leaveSpace()); await recipient.goto(`${origin}/favicon.svg`);
  await staleTab.goto(origin); await ready(staleTab);
  assert.equal(await staleTab.evaluate(() => app.session.vault.identity.publicBundle.deviceId), activeDevice);
  await staleTab.getByText('original local history', { exact: true }).waitFor();
  assert.equal(await staleTab.getByText('must remain retracted', { exact: true }).count(), 0);
  await staleTab.evaluate(() => app.leaveSpace()); await staleTab.close();
  await recipient.goto(origin); await ready(recipient);
  // Existing clients could durably misclassify an initial auth timeout as denial.
  await recipient.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    await v.withVaultMutation(app.session, async mutation => {
      app.session.vault.localAccessDeniedDeviceId = app.session.vault.identity.publicBundle.deviceId;
      await v.saveVault(app.session, mutation);
    });
  });
  await recipient.goto(`${origin}/favicon.svg`);
  await recipient.goto(`${origin}/?saved-room=1`); await ready(recipient);
  assert.equal(await recipient.evaluate(() => app.session.vault.localAccessDeniedDeviceId), undefined);
  assert.equal(await recipient.evaluate(() => app.session.vault.identity.publicBundle.deviceId), activeDevice);
  // Exercise a real browser WebSocket close before authentication, then reconnect.
  let missedAuthentication = false;
  await recipient.addInitScript(() => {
    window.reentrySocketCloses = [];
  });
  await recipient.routeWebSocket('**/ws', route => {
    const upstream = route.connectToServer();
    if (missedAuthentication) return;
    route.onMessage(() => {
      missedAuthentication = true;
      route.close({ code: 4401, reason: 'Authentication required' }); upstream.close();
    });
  });
  await recipient.reload(); await ready(recipient);
  assert.equal(missedAuthentication, true);
  assert.ok(await recipient.evaluate(() => window.reentrySocketCloses.some(event => event.code === 4401 && event.reason === 'Authentication required')));
  assert.equal(await recipient.evaluate(() => app.session.vault.localAccessDeniedDeviceId), undefined);
  await send(recipient, 'live after restoring owner'); await helper.getByText('live after restoring owner', { exact: true }).waitFor();
  await recipient.reload(); await ready(recipient); await recipient.getByText('original local history', { exact: true }).waitFor();
  assert.equal(await recipient.getByText('must remain retracted', { exact: true }).count(), 0);
  // Recreate the already-installed bad release: same current MLS identity, but
  // a fresh master over the old room namespace. Refresh must recover its owner.
  const brokenSlot = await recipient.evaluate(async () => {
    const current = app.session; await app.leaveSpace();
    const v = await import('/src/lib/vault.ts'), b = await import('/src/lib/browser-room-key.ts');
    const broken = await v.createVault(structuredClone(current.vault), '', 'platform', await b.automaticRoomCredential());
    delete broken.vault.localDataScope; await v.saveVault(broken);
    return JSON.stringify(broken.stored);
  });
  await recipient.reload(); await ready(recipient); await recipient.getByText('original local history', { exact: true }).waitFor();
  assert.equal(await recipient.getByText('must remain retracted', { exact: true }).count(), 0);
  assert.equal(await recipient.evaluate(async stored => {
    const repaired = app.session, id = JSON.parse(stored).spaceId;
    const database = await new Promise(resolve => { const request = indexedDB.open('quiet-room'); request.onsuccess = () => resolve(request.result); });
    const bad = await new Promise(resolve => { const tx = database.transaction('vault', 'readonly'), request = tx.objectStore('vault').get(id); tx.oncomplete = () => resolve(JSON.stringify(request.result)); });
    database.close(); return bad === stored && repaired.stored.spaceId !== id;
  }, brokenSlot), true);
  await send(helper, 'peer after automatic local repair'); await recipient.getByText('peer after automatic local repair', { exact: true }).waitFor();
  await helper.reload(); await ready(helper); await recipient.reload(); await ready(recipient);
  await recipient.getByText('original local history', { exact: true }).waitFor();
  console.log('Repair history owner journey passed: orphaned original, preserved slots, stale home tab, cached false denial, auth timeout reconnect, tombstone and already-installed bad session.');
}
