// Synthetic viewport input for this local debug iframe only. Never loaded in a build.
(() => {
  if (window === top) return;
  let harness;
  try { if (parent.location.origin !== location.origin || parent.location.pathname !== '/__mobile-debug') return; harness = parent.__localSafariDebug; } catch { return; }
  if (!harness || !window.visualViewport) return;
  const viewport = window.visualViewport;
  let geometry = { ...harness.geometry }, installed = false;
  try {
    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => geometry.height },
      offsetTop: { configurable: true, get: () => geometry.offsetTop },
      pageTop: { configurable: true, get: () => scrollY + geometry.offsetTop },
    });
    installed = true;
  } catch {}
  const editable = el => el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled
    || el instanceof HTMLInputElement && !el.readOnly && !el.disabled && ['text','search','email','url','tel','password','number'].includes(el.type)
    || el instanceof HTMLElement && el.isContentEditable;
  const notify = () => harness.focus(editable(document.activeElement));
  document.addEventListener('focusin', notify, true);
  // An accessory click can dismiss the keyboard while the field remains active.
  document.addEventListener('pointerdown', event => { if (editable(event.target)) harness.focus(true); }, true);
  document.addEventListener('focusout', () => queueMicrotask(notify), true);
  window.__localSafariBridge = {
    synthetic: true, installed,
    get focused() { return editable(document.activeElement); },
    accessorySurface(color) { document.documentElement.style.setProperty('--input-accessory-surface', color); },
    update(height, offsetTop) {
      const changed = geometry.height !== height || geometry.offsetTop !== offsetTop;
      geometry = { height, offsetTop };
      if (changed && installed) { viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); }
    },
    type(key) {
      const input = document.activeElement;
      if (!editable(input)) return;
      if (key === 'Enter' && !(input instanceof HTMLTextAreaElement) && !input.isContentEditable) { input.blur(); return 'done'; }
      if (input.isContentEditable) {
        if (key === 'Backspace') document.execCommand('delete');
        else document.execCommand('insertText', false, key === 'Enter' ? '\n' : key);
        return;
      }
      const value = input.value;
      let start = input.selectionStart ?? value.length, end = input.selectionEnd ?? value.length;
      const text = key === 'Backspace' ? '' : key === 'Enter' ? '\n' : key;
      if (key === 'Backspace' && start === end) start -= [...value.slice(0,start)].pop()?.length ?? 0;
      if (input.maxLength >= 0 && value.length - (end - start) + text.length > input.maxLength) return;
      const type = key === 'Backspace' ? 'deleteContentBackward' : key === 'Enter' ? 'insertLineBreak' : 'insertText';
      if (!input.dispatchEvent(new InputEvent('beforeinput', {bubbles:true,cancelable:true,inputType:type,data:text}))) return;
      try { input.setRangeText(text,start,end,'end'); } catch { input.value=value.slice(0,start)+text+value.slice(end); }
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:type,data:text}));
    },
  };
})();
