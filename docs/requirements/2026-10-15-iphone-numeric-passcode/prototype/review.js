const preview = document.querySelector('#preview');
let mode = 'create';
const labels = { create: '设置密码', unlock: '日常解锁', legacy: '旧密码兼容', passkey: '通行密钥兼容' };
function send(action, value) { preview.contentWindow.postMessage({ kind: 'pin-prototype-control', action, value }, location.origin); }
function appearance() {
  const selected = document.querySelector('#theme').value;
  const theme = selected === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : selected;
  send('theme', theme);
  document.querySelector('#pure').href = `screen.html?mode=${mode}&theme=${theme}`;
}
preview.addEventListener('load', appearance);
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  mode = button.dataset.mode; send('mode', mode);
  document.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  appearance();
}));
document.querySelector('#theme').addEventListener('change', appearance);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', appearance);
document.querySelector('#device').addEventListener('change', event => {
  const [width, height] = event.target.value.split(',').map(Number);
  const device = document.querySelector('.device'); device.style.width = `${width}px`; device.style.height = `${height}px`;
});
document.querySelector('#large-text').addEventListener('change', event => send('large-text', event.target.checked));
document.querySelector('#reduced-motion').addEventListener('change', event => send('reduced-motion', event.target.checked));
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => send(button.dataset.action)));
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== preview.contentWindow || event.data?.kind !== 'pin-prototype-state') return;
  const { stage, event: description, count, busy, mode: actualMode } = event.data;
  if (labels[actualMode] && mode !== actualMode) {
    mode = actualMode;
    document.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.mode === mode)));
    appearance();
  }
  const stageNames = { create: '输入新密码', confirm: '再次确认', unlock: '输入解锁密码', waiting: '等待重试', cancelled: '本次已取消', recovery: '双方恢复入口', 'recovery-done': '恢复演示完成', success: '成功', legacy: '原密码输入', passkey: '原通行密钥验证' };
  document.querySelector('#state').textContent = `${stageNames[stage] ?? stage} · ${description === 'paint' ? busy ? '处理中' : `已输入 ${count} 位` : description}`;
});
