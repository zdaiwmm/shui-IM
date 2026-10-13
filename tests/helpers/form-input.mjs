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

/** Wait for the modal's own deferred autofocus before choosing its foreground cancel. */
export async function cancelPasswordForm(page) {
  const sheet = page.locator('.password-sheet:not(.is-closing)').last();
  await sheet.waitFor({ state: 'visible' });
  await sheet.evaluate(async element => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const effects = element.getAnimations({ subtree: true }).filter(animation =>
      Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
    await Promise.allSettled(effects.map(animation => animation.finished));
  });
  if (await page.locator('[data-form-input-cancel]').count()) {
    await page.locator('[data-form-input-cancel]').click();
    await page.locator('.form-input-overlay').waitFor({ state: 'detached' });
  }
  await sheet.locator('[data-password-cancel]').click();
}
