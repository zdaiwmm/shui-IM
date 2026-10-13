import assert from 'node:assert/strict';
/** Exercise the real mobile draft editor; desktop fixtures retain their native fields. */
export async function fillFormInput(page, field, value) {
  if (await page.locator('#form-input-draft').count() && await field.getAttribute('data-form-input-active') !== 'true') {
    await page.locator('[data-form-input-cancel]').click();
  }
  // Native focus is synchronous, including a dialog's deferred initial focus.
  // Pointer activation is independently exercised by mobile-debug.e2e.mjs.
  await field.focus();
  const draft = page.locator('#form-input-draft');
  if (await draft.count()) {
    await draft.fill(value);
    await page.locator('[data-form-input-done]').click();
  } else await field.fill(value);
  assert.equal(await field.inputValue(),value,'Committing a form editor must update its original field');
}
