import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { submitPassword } from '../../tests/helpers/password.mjs';
import { harness, send, protect, durable, outputDirectory, outputReady } from './harness.mjs';

await outputReady();
const h = await harness();
const results = { startedAt: new Date().toISOString(), navigationDiagnosis: 'Enrollment returns through device management and its desktop settings parent before chat; observed active connected session had no composer while on settings.', scope: 'Six isolated browser storage contexts; two participants with three independently enrolled MLS devices each; no physical devices' };
try {
  const [alice, bob] = await h.pair(), pages = [alice, bob];
  for (const owner of [alice, bob]) {
    await protect(owner);
    for (let n = 0; n < 2; n++) {
      await owner.bringToFront();
      await owner.locator('#chat-settings').click();
      await owner.locator('#manage-devices').click();
      await owner.locator('#add-own-device:not([disabled])').click();
      await owner.evaluate(() => { window.auditClipboard = null; });
      await owner.locator('#copy-device-join').click(); await submitPassword(owner, '927451');
      await owner.waitForFunction(() => typeof auditClipboard === 'string');
      const link = await owner.evaluate(() => auditClipboard);
      const page = await h.newPage(); await page.goto(link); await h.ready(page); pages.push(page);
      // Enrollment and the authorizer page refresh are asynchronous. The add
      // page and device list reuse #device-back but return to different places.
      // Read the actual route, then exercise its explicit back action.
      await owner.waitForFunction(() => auditApp.session.vault.members.filter(m => m.status === 'active' && m.role === auditApp.session.vault.role).length >= 2);
      if (await owner.locator('.add-own-device-page').count()) {
        await owner.getByRole('button', { name: '返回设备管理', exact: true }).click();
      }
      await owner.getByRole('button', { name: '返回聊天', exact: true }).click();
      await owner.locator('.desktop-settings-page .page-back-button').click();
      await h.ready(owner);
    }
  }
  for (const page of pages) await page.waitForFunction(() => auditApp.session.vault.members.filter(m => m.status === 'active').length === 6);
  for (let n = 0; n < pages.length; n++) {
    await send(pages[n], `six-device-message-${n}`);
    for (const page of pages) await page.getByText(`six-device-message-${n}`, { exact: true }).waitFor();
  }
  const laggard = pages.at(-1); await laggard.context().setOffline(true);
  for (let n = 0; n < 10; n++) await send(alice, `six-device-offline-${n}`);
  await bob.getByText('six-device-offline-9', { exact: true }).waitFor();
  await laggard.context().setOffline(false); await h.ready(laggard);
  await laggard.getByText('six-device-offline-9', { exact: true }).waitFor();
  results.devices = [];
  let expectedTexts;
  for (const page of pages) {
    await page.waitForFunction(() => !auditApp.outbox.size && !auditApp.serverQueue.size);
    const saved = await durable(page);
    const texts = saved.rows.filter(row => row.kind === 'text');
    const count = texts.length;
    assert.equal(count, 16);
    expectedTexts ??= texts;
    assert.deepEqual(texts, expectedTexts, 'All six devices must persist the same text IDs and sequence numbers');
    results.devices.push({ seq: saved.seq, texts: count, outbox: saved.outbox,
      activeMembers: await page.evaluate(() => auditApp.session.vault.members.filter(m => m.status === 'active').length) });
  }
  console.log('SIX_DEVICES', JSON.stringify(results));
} catch (error) { results.failure = String(error); throw error; }
finally { await writeFile(path.join(outputDirectory, 'six-devices.json'), JSON.stringify(results, null, 2)); await h.close(); }
