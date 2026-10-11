/** Exercise the real identity step, then start first-device protection if needed. */
export async function completeSpaceProfile(page, name = '测试空间') {
  await page.locator('#new-space-name').fill(name);
  const needsProtection = (await page.locator('#profile-done').textContent()).includes('下一步');
  await page.locator('#profile-done').click();
  if (needsProtection) await page.locator('[data-device-verify]').click();
}
