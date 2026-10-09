'use strict';
// Standalone design prototype. No product runtime, permission API or push access.
const $ = selector => document.querySelector(selector);
const defaults = { title: 'Quiet Room', body: '有一条新消息，解锁后查看。' };
const limits = { title: 24, body: 80 };
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const count = value => [...segmenter.segment(value)].length;
let saved = { ...defaults };
let enabled = true;
let page = 'copy';
let saving = false;
let composing = false;
let failSave = false;
const spacePrefs = [true, false, true];
const rawDraft = () => ({ title: $('#title').value, body: $('#body').value });
const effective = () => Object.fromEntries(Object.entries(rawDraft()).map(([key, value]) => [key, value.trim() || defaults[key]]));
const dirty = () => Object.entries(rawDraft()).some(([key, value]) => value !== saved[key]);
const invalid = (key, value) => count(value) > limits[key] ? `请将${key === 'title' ? '标题' : '正文'}缩短到 ${limits[key]} 个字以内。` : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? '请移除不可显示的控制字符。' : '';
function status(message, kind = '') { $('#save-status').textContent = message; $('#save-status').className = kind; }
function render() {
  const draft = rawDraft();
  const display = effective();
  let hasError = false;
  for (const key of ['title', 'body']) {
    const error = invalid(key, draft[key]);
    hasError ||= Boolean(error);
    $(`#${key}-error`).textContent = error;
    $(`#${key}-error`).hidden = !error;
    $(`#${key}`).setAttribute('aria-invalid', String(Boolean(error)));
    $(`#${key}-count`).textContent = `${count(draft[key])}/${limits[key]}`;
    $(`#${key}-count`).classList.toggle('invalid', Boolean(error));
    $(`#preview-${key}`).textContent = display[key];
  }
  $('#preview-state').textContent = dirty() ? '编辑中 · 尚未保存' : '当前已保存';
  $('#preview-state').className = dirty() ? 'draft' : '';
  $('#save').disabled = !dirty() || hasError || saving || composing;
  $('#save').textContent = saving ? '正在保存…' : '保存文案';
  $('#reset').disabled = saving;
  $('#back').disabled = saving;
  for (const key of ['title', 'body']) $(`#${key}`).disabled = saving;
  $('#enabled-note').textContent = enabled ? '当前本机通知已开启。保存后用于之后收到的新通知。' : '当前本机通知已关闭。可以先保存文案，重新开启通知后生效。';
  $('#master').setAttribute('aria-checked', String(enabled));
  $('#saved-summary').textContent = `${saved.title} · ${saved.body}`;
}
function highlight(target, moveFocus = false) {
  document.querySelectorAll('.preview-line').forEach(line => line.classList.toggle('active', line.dataset.target === target));
  if (moveFocus) {
    const node = target === 'source' ? $('#source-group') : $(`#${target}`);
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
}
function setPage(next) {
  page = next;
  for (const [key, id] of [['copy', 'copy-page'], ['notifications', 'notifications-page'], ['settings', 'settings-page']]) $(`#${id}`).hidden = next !== key;
  $('#header-title').textContent = { copy: '通知文案', notifications: '通知', settings: '设置' }[next];
  $('#back').hidden = next === 'settings';
  $('#back').setAttribute('aria-label', next === 'copy' ? '返回通知管理' : '返回设置');
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (next === 'copy') {
    for (const key of ['title', 'body']) $(`#${key}`).value = saved[key];
    $('#leave-prompt').hidden = true;
    status('当前使用已保存的文案');
  }
  render();
  $('#header-title').setAttribute('tabindex', '-1');
  $('#header-title').focus({ preventScroll: true });
}
for (const key of ['title', 'body']) {
  $(`#${key}`).addEventListener('input', () => { $('#leave-prompt').hidden = true; status('预览已更新，保存后才会用于通知'); render(); });
  $(`#${key}`).addEventListener('focus', () => highlight(key));
  $(`#${key}`).addEventListener('compositionstart', () => { composing = true; render(); });
  $(`#${key}`).addEventListener('compositionend', () => { composing = false; render(); });
}
$('#source').addEventListener('focus', () => highlight('source'));
$('#view-preview').addEventListener('click', () => {
  const target = document.querySelector('.preview-line.active') || document.querySelector('.title-line');
  target.focus({ preventScroll: true });
  $('.preview-section').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
});
document.querySelectorAll('.preview-line').forEach(line => line.addEventListener('click', () => highlight(line.dataset.target, true)));
$('#copy-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#save').disabled) return;
  saving = true;
  status('正在保存原型中的设置…');
  render();
  await new Promise(resolve => setTimeout(resolve, 550));
  saving = false;
  if (failSave) { render(); status('保存失败，已保留本次编辑。请重试。', 'error'); return; }
  saved = effective();
  for (const key of ['title', 'body']) $(`#${key}`).value = saved[key];
  $('#leave-prompt').hidden = true;
  render();
  status(enabled ? '已保存到原型，用于之后的新通知。' : '已保存到原型，开启本机通知后生效。', 'success');
});
$('#reset').addEventListener('click', () => {
  for (const key of ['title', 'body']) $(`#${key}`).value = defaults[key];
  $('#leave-prompt').hidden = true;
  render();
  status(dirty() ? '已恢复默认预览，保存后生效' : '当前已经使用默认文案');
});
$('#back').addEventListener('click', () => {
  if (page === 'copy' && dirty()) { $('#leave-prompt').hidden = false; $('#continue').focus(); return; }
  setPage(page === 'copy' ? 'notifications' : 'settings');
});
$('#continue').addEventListener('click', () => { $('#leave-prompt').hidden = true; $('#title').focus(); });
$('#discard').addEventListener('click', () => setPage('notifications'));
$('#open-copy').addEventListener('click', () => setPage('copy'));
$('#open-notifications').addEventListener('click', () => setPage('notifications'));
$('#master').addEventListener('click', () => { enabled = !enabled; render(); renderSpaces(); });
function renderSpaces() {
  $('#spaces').replaceChildren(...['林间', '海边', '小屋'].map((name, index) => {
    const row = document.createElement('div');
    row.className = 'notification-row';
    row.innerHTML = `<div><strong id="space-${index}">${name}</strong></div><button type="button" class="notification-switch" role="switch" aria-labelledby="space-${index}" aria-checked="${spacePrefs[index]}"><span></span></button>`;
    const control = row.querySelector('button');
    control.disabled = !enabled;
    control.onclick = () => { spacePrefs[index] = !spacePrefs[index]; renderSpaces(); };
    return row;
  }));
}
$('#failure').addEventListener('click', () => { failSave = !failSave; $('#failure').setAttribute('aria-pressed', String(failSave)); $('#failure').textContent = failSave ? '保存失败模拟中' : '模拟保存失败'; });
$('#theme').addEventListener('change', event => { if (event.target.value === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = event.target.value; });
window.addEventListener('beforeunload', event => { if (page === 'copy' && dirty()) { event.preventDefault(); event.returnValue = ''; } });
renderSpaces();
render();
