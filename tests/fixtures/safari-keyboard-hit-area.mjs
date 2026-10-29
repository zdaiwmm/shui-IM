import assert from 'node:assert/strict';

// Real application handlers, synthetic keyboard geometry. Native Safari's
// toolbar is outside this page and is deliberately not modelled as a DOM target.
export async function verifySafariKeyboardHitArea(page) {
  const failures = [];
  const check = (actual, expected, message) => {
    try { assert.deepEqual(actual, expected, message); }
    catch (error) { failures.push(error.message); }
  };
  await page.locator('#message-input').fill('键盘重开草稿');
  const rearm = async ({ cancelable, scale = 1, composing = false, opening = false }) => page.evaluate(async options => {
    const input = document.querySelector('#message-input'), app = fixture.app;
    input.focus(); setViewport(473);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    Object.defineProperty(visualViewport, 'scale', { configurable: true, get: () => options.scale });
    setViewport(844 / options.scale);
    if (options.opening) { app.nativeKeyboardOpening = true; app.nativeKeyboardOpeningAt = performance.now(); }
    input.setSelectionRange(1, 4);
    if (options.composing) input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    let focuses = 0, blurs = 0;
    const focus = () => focuses++, blur = () => blurs++;
    input.addEventListener('focus', focus); input.addEventListener('blur', blur);
    for (const type of ['touchstart', 'touchend']) {
      const event = new Event(type, { bubbles: true, cancelable: options.cancelable });
      Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [{ clientX: 120, clientY: 400 }] : [] });
      input.dispatchEvent(event);
    }
    const result = { focuses, blurs, focused: document.activeElement === input, same: input === document.querySelector('#message-input'),
      draft: input.value, selection: [input.selectionStart, input.selectionEnd], keyboardClosed: document.documentElement.dataset.keyboardOpen === 'false' };
    input.removeEventListener('focus', focus); input.removeEventListener('blur', blur);
    if (options.composing) input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    Object.defineProperty(visualViewport, 'scale', { configurable: true, get: () => 1 }); setViewport(844);
    // A synthetic rearm has no native keyboard to complete its requested target.
    app.nativeKeyboardOpening = false;
    return result;
  }, { cancelable, scale, composing, opening });
  const rearmed = { focuses: 1, blurs: 1, focused: true, same: true, draft: '键盘重开草稿', selection: [1, 4], keyboardClosed: true };
  check(await rearm({ cancelable: false }), rearmed, 'A non-cancelable touch release still rearms a retained editor');
  check(await rearm({ cancelable: true, scale: 2 }), rearmed, 'Rearm uses the same scaled viewport geometry as keyboard state');
  check(await rearm({ cancelable: true, opening: true }), rearmed, 'A stale opening request cannot consume a retained-editor tap after native dismissal');
  check(await rearm({ cancelable: true, composing: true }), { ...rearmed, focuses: 0, blurs: 0 }, 'An active IME composition is never blurred to rearm');

  const firstFocus = await page.evaluate(() => {
    const input=document.querySelector('#message-input'); input.blur();setViewport(844);
    let focuses=0,blurs=0;const onFocus=()=>focuses++,onBlur=()=>blurs++;
    input.addEventListener('focus',onFocus);input.addEventListener('blur',onBlur);
    for(const type of ['touchstart','touchend']) {
      const event=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperty(event,'touches',{value:type==='touchstart'?[{clientX:120,clientY:400}]:[]});
      input.dispatchEvent(event);
      if(type==='touchstart')input.focus(); // Safari's default focus within this tap.
    }
    input.removeEventListener('focus',onFocus);input.removeEventListener('blur',onBlur);
    fixture.app.nativeKeyboardOpening=false;
    return {focuses,blurs,focused:document.activeElement===input};
  });
  check(firstFocus,{focuses:1,blurs:0,focused:true},'First focus within a tap is never blurred and reopened');

  const nativeReturn = await page.evaluate(async () => {
    const input = document.querySelector('#message-input'), app = fixture.app;
    input.focus(); setViewport(473); input.setSelectionRange(1, 4);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const originalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    // Safari's address bar takes native focus while activeElement retains the
    // editor. Returning focus() calls can then be ignored by UIKit indefinitely.
    window.dispatchEvent(new FocusEvent('blur'));
    setViewport(844);
    const released = document.activeElement !== input;
    let prevented = false, programmaticFocuses = 0;
    const originalFocus = input.focus;
    input.focus = () => { programmaticFocuses++; };
    for (const type of ['touchstart', 'touchend']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [{ clientX: 120, clientY: 400 }] : [] });
      input.dispatchEvent(event); prevented ||= event.defaultPrevented;
    }
    input.focus = originalFocus;
    if (originalHasFocus) Object.defineProperty(document, 'hasFocus', originalHasFocus);
    else delete document.hasFocus;
    // Browser default focus runs after touchend. It must remain available even
    // when programmatic focus in the returning gesture would have been ignored.
    if (!prevented) input.focus();
    app.nativeKeyboardOpening = false;
    return { released, prevented, programmaticFocuses, focused: document.activeElement === input,
      same: input === document.querySelector('#message-input'), draft: input.value,
      selection: [input.selectionStart, input.selectionEnd] };
  });
  check(nativeReturn, { released: true, prevented: false, programmaticFocuses: 0, focused: true,
    same: true, draft: '键盘重开草稿', selection: [1, 4] }, 'Native browser focus loss releases the editor and preserves the next native tap default');

  const blurScopes = await page.evaluate(() => {
    const input = document.querySelector('#message-input'), app = fixture.app;
    const originalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    app.visualClientCoordinates = false;
    window.dispatchEvent(new FocusEvent('blur'));
    const desktopRetained = document.activeElement === input;
    app.visualClientCoordinates = true;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    window.dispatchEvent(new FocusEvent('blur'));
    const composingRetained = document.activeElement === input;
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    const compositionReleased = document.activeElement !== input;
    if (originalHasFocus) Object.defineProperty(document, 'hasFocus', originalHasFocus);
    else delete document.hasFocus;
    return { desktopRetained, composingRetained, compositionReleased, draft: input.value, selection: [input.selectionStart, input.selectionEnd] };
  });
  check(blurScopes, { desktopRetained: true, composingRetained: true, compositionReleased: true,
    draft: '键盘重开草稿', selection: [1, 4] }, 'Native focus cleanup leaves desktop focus alone and waits for IME composition to finish');

  await page.evaluate(() => { document.querySelector('#message-input').focus(); setViewport(473); });
  await page.waitForFunction(() => !fixture.app.listKeyboardLayout.moving && !fixture.app.chatViewportMotion?.moving);
  const target = await page.evaluate(() => {
    const input = document.querySelector('#message-input'), underlay = document.querySelector('.chat-keyboard-underlay');
    input.setSelectionRange(1, 4);
    const rect = underlay.getBoundingClientRect();
    const x = 20, y = rect.top + 12;
    return { x, y, withinPage: y > 0 && y < innerHeight,
      hit: document.elementFromPoint(x, y) === underlay, pointer: getComputedStyle(underlay).pointerEvents,
      height: rect.height, held: fixture.app.chatKeyboardGesture.held };
  });
  assert.equal(target.withinPage, true, JSON.stringify(target));
  check({ hit: target.hit, pointer: target.pointer }, { hit: true, pointer: 'auto' }, 'Only the existing webpage underlay owns this exposed blank area');
  await page.touchscreen.tap(target.x, target.y);
  check(await page.evaluate(() => {
    const input = document.querySelector('#message-input');
    return { focused: document.activeElement === input, draft: input.value, selection: [input.selectionStart, input.selectionEnd],
      held: fixture.app.chatKeyboardGesture.held, open: document.documentElement.dataset.keyboardOpen };
  }), { focused: true, draft: '键盘重开草稿', selection: [1, 4], held: false, open: 'true' }, 'A trusted blank-underlay tap keeps focus without starting a content dismissal');

  const scopes = await page.evaluate(async () => {
    const input = document.querySelector('#message-input'), underlay = document.querySelector('.chat-keyboard-underlay'), app = fixture.app;
    const pointer = () => getComputedStyle(underlay).pointerEvents;
    input.blur(); const unfocused = pointer(); input.focus(); setViewport(844); const closed = pointer();
    // Browser mode is fixed in production. This fixture changes it before a
    // fresh geometry sample; unchanged samples intentionally skip non-native
    // chrome writes, so merely waiting more frames cannot apply a mode flip.
    app.visualClientCoordinates = false; setViewport(474);
    const otherBrowser = pointer();
    app.visualClientCoordinates = true; setViewport(473);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { unfocused, closed, otherBrowser };
  });
  check(scopes, { unfocused: 'none', closed: 'none', otherBrowser: 'none' }, 'Underlay hit testing stays disabled outside focused native-keyboard mode');
  await page.evaluate(() => { document.querySelector('#message-input').blur(); setViewport(844); });
  assert.deepEqual(failures, [], 'Safari keyboard hit-area regressions');
}
