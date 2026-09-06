// Temporary, local-only Safari bookmarklet. Not imported by the application.
// Run once on the cover, reproduce, then run again to show and discard the log.
(() => {
  const key = '__quietRoomCoverEntryProbe';
  if (window[key]) return window[key]();
  if (location.hostname !== 'ai.shui.click' && location.hostname !== 'localhost') {
    alert('请在 ai.shui.click 的遮蔽页运行');
    return;
  }
  if (!document.querySelector('.cover-trigger')) {
    alert('请先回到遮蔽页');
    return;
  }
  const rows = [];
  const cleanup = [];
  const start = performance.now();
  let previous = '';
  let stopped = false;
  const state = () => [
    document.body.classList.contains('app-mode') ? 'A' : '-',
    document.querySelector('.cover-trigger') ? 'C' : '-',
    document.querySelector('.cover-trigger.is-holding') ? 'H' : '-',
    document.querySelector('.gateway') ? 'G' : '-',
    document.querySelector('#passkey-unlock:disabled') ? 'B' : '-',
    document.documentElement.classList.contains('privacy-obscured') ? 'P' : '-',
    document.hidden ? '-' : 'V',
    document.hasFocus() ? 'F' : '-',
  ].join('');
  const log = (event) => {
    if (stopped) return;
    if (rows.length >= 48) { rows.shift(); }
    rows.push(`${Math.round(performance.now() - start)} ${event} ${state()}`);
  };
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler, { capture: true, passive: true });
    cleanup.push(() => target.removeEventListener(type, handler, true));
  };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchend', 'touchcancel', 'contextmenu']) {
    listen(document, type, event => {
      log(type);
    });
  }
  for (const type of ['blur', 'focus', 'pagehide', 'pageshow', 'error', 'unhandledrejection']) {
    listen(window, type, event => {
      if ((type === 'blur' || type === 'focus') && event.target !== window) return;
      log(type); // Never record exception messages, stacks, URLs or DOM text.
    });
  }
  for (const type of ['visibilitychange', 'freeze']) listen(document, type, () => log(type));
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element && (node.matches('.gateway') || node.querySelector('.gateway'))) log('gateway-added');
    }
    const current = state();
    if (current !== previous) { previous = current; log('state'); }
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'disabled'],
  });
  cleanup.push(() => observer.disconnect());
  const stop = () => {
    if (stopped) return;
    log('stop');
    stopped = true;
    cleanup.forEach(fn => fn());
  };
  const expiry = setTimeout(stop, 120000);
  window[key] = () => {
    stop();
    clearTimeout(expiry);
    delete window[key];
    alert('QR entry probe (ms)\nA应用 C遮蔽 H按住 G验证 B忙碌 P隐私帘 V可见 F焦点\n' +
      (rows.join('\n') || '未捕获入口按下，请在遮蔽页重新运行'));
  };
  alert('已开始临时取证。关闭提示后退后台再返回，长按复现；失败后再次运行本书签，截图结果。两分钟后自动停止，不上传数据。');
})();
