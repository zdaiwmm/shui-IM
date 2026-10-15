/* Simulation only. No real credential, storage, crypto, network or application entry. */
const $ = selector => document.querySelector(selector);
const root = document.documentElement;
const surface = $('#passcode');
const title = $('#title'), subtitle = $('#subtitle'), dots = [...$('#dots').children];
const keys = [...document.querySelectorAll('[data-digit]')];
const left = $('#left-action'), right = $('#right-action');
const outcome = $('#outcome'), primary = $('#outcome-primary'), back = $('#outcome-back');
const allowedModes = new Set(['create', 'unlock', 'legacy', 'passkey']);
let mode = 'create', stage = 'create', digits = '', first = '', demoPin = '246810';
let busy = false, epoch = 0, waiting = 0, simulateFailure = false;
let timer, tick, message = '', outcomeAction;
const reduced = () => root.dataset.reducedMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches;
function report(event) {
  // No entered or accepted password is sent to the review shell.
  if (parent !== window) parent.postMessage({ kind: 'pin-prototype-state', mode, stage, event, count: digits.length, busy }, location.origin);
}
function invalidate() {
  epoch++; clearTimeout(timer); clearInterval(tick); busy = false; waiting = 0;
  digits = ''; first = ''; message = ''; $('#error').textContent = '';
}
function paint() {
  title.textContent = stage === 'confirm' ? '再次输入密码' : mode === 'create' ? '设置密码' : '输入密码';
  subtitle.textContent = message || (busy ? mode === 'create' ? '正在设置密码…' : '正在验证…' : stage === 'confirm' ? '再次输入以确认你的密码' : mode === 'create' ? '用于此空间的日常解锁' : '输入私密空间的 6 位数字密码');
  dots.forEach((dot, i) => dot.classList.toggle('filled', i < digits.length));
  $('#progress').textContent = `已输入 ${digits.length} 位，共 6 位${busy ? '，正在验证' : ''}`;
  keys.forEach(key => { key.disabled = busy || waiting > 0; });
  surface.setAttribute('aria-busy', String(busy));
  left.textContent = mode === 'create' ? '取消' : '忘记密码？';
  right.textContent = digits.length ? '删除' : '取消';
  right.hidden = mode === 'create' && digits.length === 0;
  right.disabled = digits.length > 0 && busy;
  report('paint');
}
function setOutcome(heading, copy, button, action, allowBack = true) {
  digits = ''; first = ''; busy = false; clearTimeout(timer); clearInterval(tick);
  surface.setAttribute('aria-busy', 'false');
  $('#progress').textContent = ''; $('#error').textContent = '';
  surface.classList.add('is-outcome'); outcome.hidden = false;
  $('#outcome-title').textContent = heading; $('#outcome-copy').textContent = copy;
  $('#outcome-content').replaceChildren(); primary.textContent = button;
  back.hidden = !allowBack; outcomeAction = action;
  report(heading); primary.focus({ preventScroll: true });
}
function start(next = mode) {
  invalidate(); mode = allowedModes.has(next) ? next : 'create'; stage = mode === 'create' ? 'create' : 'unlock';
  outcome.hidden = true; surface.classList.remove('is-outcome');
  if (mode === 'legacy') return legacy();
  if (mode === 'passkey') return passkey();
  paint();
}
function cancel(reason = '已取消') {
  invalidate(); stage = 'cancelled';
  setOutcome(reason, '本次输入已清除，返回原入口。', '重新进入', () => start(mode), false);
}
function shake(text) {
  message = text; $('#error').textContent = text;
  if (!reduced()) $('#dots').animate([
    { transform: 'translateX(0)' }, { transform: 'translateX(-10px)' },
    { transform: 'translateX(9px)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(0)' }
  ], { duration: 360, easing: 'ease-out' });
  digits = ''; paint();
}
function waitDemo() {
  invalidate(); waiting = 3; stage = 'waiting';
  message = `请 ${waiting} 秒后再试`; paint();
  tick = setInterval(() => {
    waiting--;
    if (waiting <= 0) { clearInterval(tick); stage = 'unlock'; message = ''; }
    else message = `请 ${waiting} 秒后再试`;
    paint();
  }, 1000);
}
function complete() {
  if (mode === 'create' && stage === 'create') {
    first = digits; digits = ''; stage = 'confirm'; message = ''; paint(); report('进入再次确认'); return;
  }
  if (mode === 'create' && first !== digits) {
    first = ''; stage = 'create'; shake('两次输入不一致，请重新设置'); report('确认不一致'); return;
  }
  const attempt = digits, current = epoch;
  busy = true; paint();
  timer = setTimeout(() => {
    if (current !== epoch || document.hidden) return;
    if (simulateFailure) {
      simulateFailure = false; busy = false; first = ''; stage = mode === 'create' ? 'create' : 'unlock';
      shake('暂时无法完成，请重试'); report('模拟操作失败'); return;
    }
    if (mode === 'create') {
      demoPin = attempt; stage = 'success';
      setOutcome('密码已设置', '以后打开此空间时，输入刚才设置的 6 位数字密码。', '锁定并试解锁', () => start('unlock'));
      report('设置成功');
    } else if (attempt === demoPin) {
      stage = 'success'; setOutcome('空间已解锁', '此处为成功状态演示，未打开真实聊天。', '再次锁定', () => start('unlock')); report('解锁成功');
    } else {
      busy = false; shake('密码错误，请重试'); report('密码错误');
    }
  }, 520);
}
function enter(digit, key) {
  if (busy || waiting || !outcome.hidden || digits.length >= 6) return;
  message = ''; $('#error').textContent = '';
  digits += digit;
  if (key && !reduced()) {
    key.classList.add('is-pressed'); setTimeout(() => key.classList.remove('is-pressed'), 100);
  }
  paint();
  if (digits.length === 6) complete();
}
function remove() { if (busy || waiting || !outcome.hidden) return; digits = digits.slice(0, -1); message = ''; paint(); }
function forgot() {
  invalidate(); stage = 'recovery';
  setOutcome('一起找回私密空间', '沿用恢复卡与双方确认流程。日常数字密码不能代替恢复卡。', '模拟双方确认完成', () => {
    stage = 'recovery-done'; setOutcome('恢复流程演示完成', '正式产品仍需验证恢复材料与双方授权。本原型未执行恢复。', '返回解锁', () => start('unlock'), false);
  });
}
function legacy() {
  stage = 'legacy';
  setOutcome('输入原有空间密码', '已有长密码继续使用原输入方式。演示密码：QuietRoomDemo12', '验证原密码', () => {
    const input = $('#legacy-password');
    const correct = input.value === 'QuietRoomDemo12'; input.value = '';
    if (correct) { stage = 'success'; setOutcome('旧空间已解锁', '原密码保护保留，没有自动转换为数字密码。', '返回旧密码演示', () => start('legacy')); }
    else { $('#outcome-copy').textContent = '密码错误，请重试。演示密码：QuietRoomDemo12'; $('#error').textContent = '密码错误，请重试'; input.focus(); }
  });
  const label = document.createElement('label'); label.textContent = '原有空间密码';
  const input = document.createElement('input'); input.type = 'password'; input.id = 'legacy-password'; input.autocomplete = 'off';
  label.append(input); $('#outcome-content').append(label);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') outcomeAction(); });
}
function passkey() {
  stage = 'passkey';
  setOutcome('使用通行密钥', '已有通行密钥空间继续调用原验证方式。此处不调用真实系统认证。', '模拟验证成功', () => {
    stage = 'success'; setOutcome('空间已解锁', '通行密钥保护保留，没有降级为数字密码。', '返回通行密钥演示', () => start('passkey'));
  });
}
keys.forEach(key => key.addEventListener('click', () => enter(key.dataset.digit, key)));
left.addEventListener('click', () => mode === 'create' ? cancel() : forgot());
right.addEventListener('click', () => digits.length ? remove() : cancel());
primary.addEventListener('click', () => outcomeAction?.());
back.addEventListener('click', () => start(mode === 'legacy' || mode === 'passkey' ? 'unlock' : mode));
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
  if (/^[0-9]$/.test(event.key)) { event.preventDefault(); enter(event.key, keys.find(key => key.dataset.digit === event.key)); }
  else if (event.key === 'Backspace' && outcome.hidden) { event.preventDefault(); remove(); }
  else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
});
function privacy() { demoPin = '246810'; simulateFailure = false; cancel('本次输入已清除'); report('隐私清理模拟'); }
document.addEventListener('visibilitychange', () => { if (document.hidden) privacy(); });
window.addEventListener('pagehide', () => { invalidate(); demoPin = '246810'; $('#legacy-password')?.setAttribute('value', ''); const input = $('#legacy-password'); if (input) input.value = ''; });
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.kind !== 'pin-prototype-control') return;
  const { action, value } = event.data;
  if (action === 'mode') start(value);
  else if (action === 'theme' && ['light', 'dark'].includes(value)) root.dataset.theme = value;
  else if (action === 'large-text') root.dataset.largeText = String(Boolean(value));
  else if (action === 'reduced-motion') root.dataset.reducedMotion = String(Boolean(value));
  else if (action === 'privacy') privacy();
  else if (action === 'wait') { start('unlock'); waitDemo(); }
  else if (action === 'failure') { simulateFailure = true; report('下次完整验证模拟操作失败'); }
  else if (action === 'reset') { demoPin = '246810'; simulateFailure = false; start('create'); }
});
const params = new URLSearchParams(location.search);
root.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
start(params.get('mode') || 'create');
