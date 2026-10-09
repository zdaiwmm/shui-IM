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
let previewMode = 'preview';
let lastField = 'title';
let referenceLoaded = $('#reference-image').complete && $('#reference-image').naturalWidth > 0;
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
  $('#save').textContent = saving ? '保存中' : '保存';
  $('#reset').disabled = saving;
  $('#back').disabled = saving;
  for (const key of ['title', 'body']) $(`#${key}`).disabled = saving;
  $('#enabled-note').textContent = enabled ? '当前本机通知已开启。保存后用于之后收到的新通知。' : '当前本机通知已关闭。可以先保存文案，重新开启通知后生效。';
  $('#master').setAttribute('aria-checked', String(enabled));
  $('#saved-summary').textContent = `${saved.title} · ${saved.body}`;
  renderPreview();
}
function renderPreview() {
  const display = effective();
  const useOriginal = referenceLoaded && (previewMode === 'reference' || (display.title === defaults.title && display.body === defaults.body));
  $('#reference-image').hidden = !useOriginal;
  $('#dynamic-preview').hidden = useOriginal;
  $('#show-reference').disabled = !referenceLoaded;
  $('#show-reference').setAttribute('aria-pressed', String(previewMode === 'reference'));
  $('#show-preview').setAttribute('aria-pressed', String(previewMode === 'preview'));
  $('#calibration-note').textContent = previewMode === 'reference' && referenceLoaded
    ? '用户提供的原截图，仅含通知文字区域。'
    : referenceLoaded
      ? '文字区域按原图校准，完整卡片与自填文字排版待真机核对。'
      : '当前无法读取原截图，文字区域为模拟效果，待真机核对。';
}
function setPage(next) {
  const previous = page;
  page = next;
  for (const [key, id] of [['copy', 'copy-page'], ['notifications', 'notifications-page'], ['settings', 'settings-page']]) $(`#${id}`).hidden = next !== key;
  $('#header-title').textContent = { copy: '通知文案', notifications: '通知', settings: '设置' }[next];
  $('#back').hidden = next === 'settings';
  $('#save').hidden = next !== 'copy';
  $('#preview-dock').hidden = next !== 'copy';
  $('#back').setAttribute('aria-label', next === 'copy' ? '返回通知管理' : '返回设置');
  $('#page-scroll').scrollTop = 0;
  const levels = { settings: 0, notifications: 1, copy: 2 };
  $('#page-scroll').classList.remove('enter-forward', 'enter-back');
  requestAnimationFrame(() => $('#page-scroll').classList.add(levels[next] > levels[previous] ? 'enter-forward' : 'enter-back'));
  if (next === 'copy') {
    for (const key of ['title', 'body']) $(`#${key}`).value = saved[key];
    previewMode = 'preview';
    status('修改后，点右上角保存。');
  }
  render();
  $('#header-title').setAttribute('tabindex', '-1');
  $('#header-title').focus({ preventScroll: true });
}
function requestBack() {
  if (saving || page === 'settings') return;
  document.activeElement?.blur();
  if (page === 'copy' && dirty()) { $('#leave-dialog').showModal(); $('#continue').focus(); return; }
  setPage(page === 'copy' ? 'notifications' : 'settings');
}
for (const key of ['title', 'body']) {
  $(`#${key}`).addEventListener('input', () => { previewMode = 'preview'; status('预览已更新，保存后才会用于通知'); render(); });
  $(`#${key}`).addEventListener('focus', () => {
    lastField = key;
    requestAnimationFrame(() => $(`#${key}`).scrollIntoView({ block: 'nearest' }));
  });
  $(`#${key}`).addEventListener('compositionstart', () => { composing = true; render(); });
  $(`#${key}`).addEventListener('compositionend', () => { composing = false; render(); });
}
$('#title').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing && !composing) { event.preventDefault(); $('#body').focus(); }
});
$('#show-preview').addEventListener('click', () => { previewMode = 'preview'; renderPreview(); });
$('#show-reference').addEventListener('click', () => { previewMode = 'reference'; renderPreview(); });
$('#reference-image').addEventListener('load', () => { referenceLoaded = true; renderPreview(); });
$('#reference-image').addEventListener('error', () => { referenceLoaded = false; previewMode = 'preview'; renderPreview(); });
$('#copy-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#save').disabled) return;
  document.activeElement?.blur();
  saving = true;
  status('正在保存原型中的设置…');
  render();
  await new Promise(resolve => setTimeout(resolve, 550));
  saving = false;
  if (failSave) { render(); status('保存失败，已保留本次编辑。请重试。', 'error'); return; }
  saved = effective();
  for (const key of ['title', 'body']) $(`#${key}`).value = saved[key];
  previewMode = 'preview';
  render();
  status(enabled ? '已保存到原型，用于之后的新通知。' : '已保存到原型，开启本机通知后生效。', 'success');
});
$('#reset').addEventListener('click', () => {
  for (const key of ['title', 'body']) $(`#${key}`).value = defaults[key];
  previewMode = 'preview';
  render();
  status(dirty() ? '已恢复默认预览，保存后生效' : '当前已经使用默认文案');
});
$('#back').addEventListener('click', requestBack);
$('#continue').addEventListener('click', () => { $('#leave-dialog').close(); $(`#${lastField}`).focus(); });
$('#discard').addEventListener('click', () => { $('#leave-dialog').close(); setPage('notifications'); });
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
function updateViewport() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty('--viewport-height', `${viewport?.height ?? window.innerHeight}px`);
  document.documentElement.style.setProperty('--viewport-top', `${viewport?.offsetTop ?? 0}px`);
}
window.visualViewport?.addEventListener('resize', updateViewport);
window.visualViewport?.addEventListener('scroll', updateViewport);
window.addEventListener('resize', updateViewport);
updateViewport();
renderSpaces();
render();
