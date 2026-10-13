import { fillFormInput } from '../helpers/form-input.mjs';
/** Exercise the real identity step, then start first-device protection if needed. */
export async function completeSpaceProfile(page, name = '测试空间') {
  await fillFormInput(page, page.locator('#new-space-name'), name);
  const needsProtection = (await page.locator('#profile-done').textContent()).includes('下一步');
  await page.locator('#profile-done').click();
  if (needsProtection) {
    try { await page.locator('[data-device-verify]').click(); }
    catch(error) { console.error('PROFILE_FLOW_STATE',await page.evaluate(()=>({hidden:document.hidden,focused:document.hasFocus(),covered:window.app?.privacyCovered,epoch:window.app?.runtimeEpoch,creating:!!window.app?.spaceCreationAbort,aborted:window.app?.spaceCreationAbort?.signal.aborted,surfaces:[...document.querySelector('#app').children].map(n=>n.className),nameLength:document.querySelector('#new-space-name')?.value.length,error:document.querySelector('.space-profile-content .form-error')?.textContent})));throw error; }
  }
}
