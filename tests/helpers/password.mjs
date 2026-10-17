import assert from 'node:assert/strict';
import { fillFormInput } from './form-input.mjs';

/** Real UI entry: numeric pages click keys; existing text/operation forms retain exact input. */
export async function submitPassword(page, secret, confirmation = secret) {
  const form = page.locator('.password-sheet:not(.is-closing) .password-form').last();
  await form.waitFor();
  if (await form.locator('[data-digit]').count()) {
    assert.match(secret, /^[0-9]{6}$/, 'Numeric fixtures must supply six actual digits');
    const create = await form.evaluate(element => Boolean(element.closest('.password-create')));
    for (const digit of secret) await form.locator(`[data-digit="${digit}"]`).click();
    if (create) {
      await form.getByRole('heading', { name: '确认应用锁', exact: true }).waitFor();
      assert.match(confirmation, /^[0-9]{6}$/);
      for (const digit of confirmation) await form.locator(`[data-digit="${digit}"]`).click();
    }
  } else {
    await fillFormInput(page, form.locator('[name=password]'), secret);
    await form.locator('[type=submit]').click();
  }
}
