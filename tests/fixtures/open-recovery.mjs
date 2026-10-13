/** Recovery now opens directly into the card reader, without a second input sheet. */
export async function openRecoveryCard(page) {
  if (await page.locator('#joint-code-form').count()) return;
  if (await page.locator('#restore-cloud').count()) await page.locator('#restore-cloud').click();
  else if (await page.locator('#joint-open-code').count()) await page.locator('#joint-open-code').click();
  else await page.evaluate(()=>app.renderJointRecovery(null));
}
