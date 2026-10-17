/** Explicit retained QR3/QR4 journey. Chamber's homepage first offers mnemonic
 * protection, with a separate old-card entry; neither flow is mocked. */
export async function openRecoveryCard(page) {
  if (await page.locator('#joint-code-form').count()) return;
  if (await page.locator('#restore-cloud').count()) { await page.locator('#restore-cloud').click();await page.locator('#restore-legacy-card').click(); }
  else if (await page.locator('#joint-open-code').count()) await page.locator('#joint-open-code').click();
  else await page.evaluate(()=>app.renderJointRecovery(null));
}
