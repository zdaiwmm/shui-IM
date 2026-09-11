(() => {
  window.__iphoneDebug?.stop();
  const samples = [];
  const start = performance.now();
  const startedWall = Date.now();
  let frame;
  let stopped = false;
  const events = ['focusin', 'focusout', 'beforeinput', 'input', 'compositionstart', 'compositionend'];
  const rect = selector => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return box ? [box.top, box.bottom, box.height] : [null, null, null];
  };
  function sample(event = 0) {
    if (stopped) return;
    const input = document.querySelector('#composer textarea');
    const vv = visualViewport;
    const row = [performance.now() - start, event, scrollY, vv?.height ?? innerHeight,
      vv?.offsetTop ?? 0, ...rect('.chat-header'), ...rect('#composer'), ...rect('.chat-shell'),
      input?.value.length ?? 0, input?.scrollTop ?? 0, input?.scrollHeight ?? 0, input?.clientHeight ?? 0];
    samples.push(row.map(v => v === null ? null : Math.round(v * 100) / 100));
    if (samples.length >= 10000 || performance.now() - start >= 30000) stop();
  }
  const listeners = events.map((event, index) => {
    const listener = () => sample(index + 1);
    document.addEventListener(event, listener, true);
    return [event, listener];
  });
  function tick() {
    sample();
    if (!stopped) frame = requestAnimationFrame(tick);
  }
  const timer = setTimeout(stop, 30000);
  function stop() {
    stopped = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    for (const [event, listener] of listeners) document.removeEventListener(event, listener, true);
    removeEventListener('pagehide', stop);
  }
  window.__iphoneDebug = { stop, result: { schema: 1, startedWall,
    columns: ['ms', 'event', 'scrollY', 'viewportHeight', 'viewportTop',
      'headerTop', 'headerBottom', 'headerHeight', 'composerTop', 'composerBottom', 'composerHeight',
      'listTop', 'listBottom', 'listHeight', 'inputLength', 'inputScrollTop', 'inputScrollHeight', 'inputClientHeight'],
    events: ['frame', ...events], samples } };
  addEventListener('pagehide', stop, { once: true });
  frame = requestAnimationFrame(tick);
})();
