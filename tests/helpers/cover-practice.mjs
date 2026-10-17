/** Exercise the real one-second practice gesture and its left defer action. */
export async function deferCoverPractice(page) {
  await page.locator('.practice-hotspot').focus();
  await page.keyboard.down('Enter');
  await page.locator('#skip-cover').waitFor();
  await page.keyboard.up('Enter');
  await page.locator('#skip-cover').click();
}
