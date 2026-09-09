import './admin.css';
import { createElement, Pencil, Trash2, ArrowLeft, ArrowRight, Download } from 'lucide';

type Room = { roomId: string; createdAt: string; lastSeenAt: string | null; devices: number; backups: number; messageCount: number };
type Detail = { roomId: string; devices: { deviceId: string; role: string; name: string; status: string; lastSeenAt: string | null }[];
  backups: { id: string; deviceId: string; revision: number; active: number; updatedAt: string; recoveryBytes: number; historyBytes: number }[] };
const root = document.querySelector<HTMLElement>('#admin')!;
let csrf = '';
let offset = 0;
let view = 0;
const date = (value: string | null) => value ? new Date(value).toLocaleString() : '暂无记录';
const size = (value: number) => `${(value / 1024).toFixed(1)} KiB`;

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/admin-api${route}`, { method, cache: 'no-store', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '操作未完成，请重试');
  return result;
}

function frame(title: string) {
  view += 1;
  root.innerHTML = `<header><div><p class="eyebrow">QUIET ROOM</p><h1></h1></div><button id="logout" type="button">退出后台</button></header>
    <nav class="actions admin-nav" aria-label="后台导航"><button id="rooms-nav">会话管理</button><button id="expressions-nav">表情管理</button></nav><div id="content"></div><p id="status" role="status"></p>`;
  root.querySelector('h1')!.textContent = title;
  root.querySelector('#logout')!.addEventListener('click', () => { void api('/logout', 'POST').finally(login); });
  root.querySelector('#rooms-nav')!.addEventListener('click', () => void rooms());
  root.querySelector('#expressions-nav')!.addEventListener('click', () => void expressions());
}

function report(error: unknown) { const target = root.querySelector('#status'); if (target) target.textContent = error instanceof Error ? error.message : '操作失败'; }

function login() {
  view += 1; csrf = '';
  root.innerHTML = `<div class="login"><p class="eyebrow">QUIET ROOM</p><h1>登录会话管理</h1><p>使用管理员密码与 Google Authenticator 动态验证码。</p>
    <form><label>管理员密码<input name="password" type="password" autocomplete="current-password" required /></label>
    <label>动态验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /></label>
    <button class="primary" type="submit">验证并登录</button></form><p id="status" role="alert"></p></div>`;
  const form = root.querySelector('form')!;
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('button')!;
    if (button.disabled) return;
    button.disabled = true;
    const values = new FormData(form);
    const body = { password: String(values.get('password')), code: String(values.get('code')) };
    form.reset();
    try { const result = await api<{ csrf: string }>('/login', 'POST', body); csrf = result.csrf; await rooms(); }
    catch (error) { if (form.isConnected) report(error); }
    finally { body.password = ''; body.code = ''; if (button.isConnected) button.disabled = false; }
  });
}

function table(headers: string[]) {
  const wrapper = document.createElement('div'); wrapper.className = 'table-scroll';
  const element = document.createElement('table');
  const head = element.createTHead().insertRow();
  for (const title of headers) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = title; head.append(th); }
  const body = element.createTBody(); wrapper.append(element);
  return { wrapper, body };
}
function row(body: HTMLTableSectionElement, values: (string | number | HTMLElement)[]) {
  const tr = body.insertRow();
  for (const value of values) { const cell = tr.insertCell(); if (value instanceof HTMLElement) cell.append(value); else cell.textContent = String(value); }
}

async function rooms() {
  frame('会话管理'); const epoch = view;
  const content = root.querySelector('#content')!; content.textContent = '正在读取会话…';
  try {
    const data = await api<{ rooms: Room[] }>(`/rooms?offset=${offset}`);
    if (epoch !== view) return;
    content.textContent = '';
    const list = table(['会话', '最近活动', '活跃设备', '有效备份', '消息记录']);
    for (const room of data.rooms) {
      const button = document.createElement('button'); button.className = 'room-id'; button.textContent = room.roomId;
      button.addEventListener('click', () => void detail(room.roomId));
      row(list.body, [button, date(room.lastSeenAt), room.devices, room.backups, room.messageCount]);
    }
    content.append(list.wrapper);
    if (!data.rooms.length) { const empty = document.createElement('p'); empty.textContent = '暂无会话。'; content.append(empty); }
    const paging = document.createElement('nav'); paging.className = 'actions'; paging.setAttribute('aria-label', '会话分页');
    for (const [label, direction] of [['上一页', -1], ['下一页', 1]] as const) {
      const button = document.createElement('button'); button.textContent = label;
      button.disabled = direction < 0 ? offset === 0 : data.rooms.length < 50;
      button.addEventListener('click', () => { offset = Math.max(0, offset + direction * 50); void rooms(); }); paging.append(button);
    }
    content.append(paging);
  } catch (error) { if (epoch === view) { content.textContent = ''; report(error); } }
}

async function detail(id: string) {
  frame('会话详情'); const epoch = view;
  const content = root.querySelector('#content')!;
  const back = document.createElement('button'); back.textContent = '返回会话列表'; back.addEventListener('click', () => void rooms()); content.append(back);
  const code = document.createElement('p'); code.className = 'room-id'; code.textContent = id; content.append(code);
  try {
    const data = await api<Detail>(`/rooms/${id}`);
    if (epoch !== view) return;
    const devices = table(['参与方 / 设备', '状态', '最近活动', '恢复备份', '历史备份']);
    for (const device of data.devices) {
      const backup = data.backups.find(b => b.deviceId === device.deviceId && b.active);
      row(devices.body, [`${device.role === 'creator' ? '创建者' : '受邀者'} · ${device.name} · ${device.deviceId}`,
        ({ active: '活跃', pending: '待授权', revoked: '已撤销' } as Record<string, string>)[device.status] ?? device.status,
        date(device.lastSeenAt), backup ? `${date(backup.updatedAt)} · 版本 ${backup.revision} · ${size(backup.recoveryBytes)}` : '暂无有效备份',
        backup ? size(backup.historyBytes) : '—']);
    }
    content.append(devices.wrapper);
    const cleanup = document.createElement('section'); cleanup.className = 'cleanup';
    cleanup.innerHTML = `<h2>清理整个会话</h2><p>会话、设备授权、在线加密备份和原始附件将被删除。参与者无法再从服务器恢复。离线保存的副本无法远程删除。</p>
      <button id="open-cleanup" class="danger" type="button">准备清理</button><div id="cleanup-form"></div>`;
    content.append(cleanup);
    cleanup.querySelector('#open-cleanup')!.addEventListener('click', () => {
      const host = cleanup.querySelector('#cleanup-form')!;
      host.innerHTML = `<form><label>完整会话编号<input name="confirmRoomId" autocomplete="off" required /></label>
        <label>再次输入管理员密码<input name="password" type="password" autocomplete="current-password" required /></label>
        <label>新的动态验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /></label>
        <button class="danger" type="submit">确认清理会话</button></form>`;
      const form = host.querySelector('form')!;
      form.addEventListener('submit', async event => {
        event.preventDefault(); const button = form.querySelector('button')!;
        if (button.disabled) return;
        const values = new FormData(form);
        const body = { confirmRoomId: String(values.get('confirmRoomId')), password: String(values.get('password')), code: String(values.get('code')) };
        form.reset(); button.disabled = true;
        try { await api(`/rooms/${id}`, 'DELETE', body); if (epoch === view) { await rooms(); report(new Error('会话已清理。')); } }
        catch (error) { if (epoch === view) report(error); }
        finally { body.password = ''; body.code = ''; if (button.isConnected) button.disabled = false; }
      });
    });
  } catch (error) { if (epoch === view) report(error); }
}

type Expression = { id: string; kind: 'gifs' | 'stickers'; title: string; tags: string; author: string; source: string; status: string; count: number; items?: { position: number; title: string }[] };
type CollectionJob = { id: string; kind: string; target: number; added: number; scanned: number; skipped: number; failed: number; status: string; error?: string };
let expressionKind: 'gifs' | 'stickers' = 'gifs';
let expressionStatus = 'all';
let expressionKeyword = '';
let expressionPage = 1;
const jobLabels: Record<string, string> = { running: '采集中', completed: '已完成', partial: '未达到目标', failed: '失败', interrupted: '已中断' };
function iconButton(label: string, icon: typeof Pencil, action: () => void) {
  const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.className = 'icon-button'; button.append(createElement(icon)); button.addEventListener('click', action); return button;
}
function renderJobs(host: HTMLElement, jobs: CollectionJob[]) {
  host.replaceChildren();
  for (const job of jobs.slice(0, 5)) {
    const line = document.createElement('p');
    line.textContent = `${job.kind === 'gifs' ? 'GIFs' : '贴图合集'} · ${jobLabels[job.status] ?? job.status} · 新增 ${job.added} / ${job.target} · 跳过 ${job.skipped} · 失败 ${job.failed}${job.error ? ` · ${job.error}` : ''}`;
    host.append(line);
  }
}
async function expressions() {
  frame('表情管理'); const epoch = view;
  const content = root.querySelector<HTMLElement>('#content')!;
  content.innerHTML = `<div class="actions expression-tabs" role="tablist" aria-label="资源类型"><button role="tab" data-type="gifs">GIFs</button><button role="tab" data-type="stickers">贴图合集</button></div>
    <form class="expression-filter"><label>搜索资源<input name="keyword" type="search" maxlength="80"></label><label>状态<select name="status"><option value="all">全部状态</option><option value="pending">待上架</option><option value="published">已上架</option></select></label><button type="submit">搜索</button></form>
    <div class="collection-actions"><button id="open-collect" class="primary" type="button" disabled>自动获取</button></div>
    <dialog id="collect-dialog" aria-labelledby="collect-title"><h2 id="collect-title">获取表情资源</h2>
      <form id="collect-form"><label>资源类型<select name="kind"><option value="gifs">动图</option><option value="stickers">贴纸合集</option></select></label>
        <label><span id="collect-quantity">获取数量（张）</span><input name="target" type="number" min="1" max="100" step="1" value="10" required autofocus></label>
        <label>关键词（可选）<input name="keyword" maxlength="80"></label>
        <label>指定来源合集 ID（可选）<input name="sourceId" pattern="[a-f0-9]{32}" maxlength="32"></label>
        <p id="collect-error" role="alert"></p><div class="actions"><button id="cancel-collect" type="button">取消</button><button class="primary" type="submit">确认获取</button></div>
      </form></dialog>
    <details class="collection-tools"><summary>手动上传</summary></details>
    <div id="collection-jobs" aria-live="polite"></div><div id="expression-list">正在读取资源…</div>`;
  const upload = document.createElement('form'); upload.id = 'expression-upload';
  upload.innerHTML = `<label>名称<input name="title" maxlength="120" required></label><label>标签<input name="tags" maxlength="2048"></label><label>图片（合计最多 8 MiB）<input name="files" type="file" accept="image/gif,image/png,image/webp,image/jpeg" required ${expressionKind === 'stickers' ? 'multiple' : ''}></label><button type="submit">添加到待上架</button>`;
  content.querySelector('.collection-tools')!.append(upload);
  upload.addEventListener('submit', async event => {
    event.preventDefault(); const button = upload.querySelector('button')!; if (button.disabled) return; button.disabled = true;
    try {
      const data = new FormData(upload); const files = data.getAll('files').filter((file): file is File => file instanceof File && file.size > 0);
      if (!files.length || files.length > 200 || files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) throw new Error('图片合计不得超过 8 MiB，合集最多 200 张');
      const encoded = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        encoded.push({ data: btoa(binary) });
      }
      if (view !== epoch) return;
      await api('/expressions', 'POST', { kind: expressionKind, title: String(data.get('title')), tags: String(data.get('tags')), files: encoded });
      if (view === epoch) { await expressions(); report(new Error('已添加到待上架')); }
    } catch (error) { if (view === epoch) report(error); } finally { button.disabled = false; }
  });
  content.querySelectorAll<HTMLButtonElement>('[data-type]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.type === expressionKind));
    button.addEventListener('click', () => { expressionKind = button.dataset.type as typeof expressionKind; expressionPage = 1; void expressions(); });
  });
  const filter = content.querySelector<HTMLFormElement>('.expression-filter')!;
  (filter.elements.namedItem('keyword') as HTMLInputElement).value = expressionKeyword;
  (filter.elements.namedItem('status') as HTMLSelectElement).value = expressionStatus;
  filter.addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(filter); expressionKeyword = String(data.get('keyword')); expressionStatus = String(data.get('status')); expressionPage = 1; void expressions();
  });
  const jobs = content.querySelector<HTMLElement>('#collection-jobs')!;
  const collect = content.querySelector<HTMLFormElement>('#collect-form')!;
  const dialog = content.querySelector<HTMLDialogElement>('#collect-dialog')!;
  const openCollect = content.querySelector<HTMLButtonElement>('#open-collect')!;
  const cancelCollect = content.querySelector<HTMLButtonElement>('#cancel-collect')!;
  const collectKind = collect.elements.namedItem('kind') as HTMLSelectElement;
  const collectError = content.querySelector<HTMLElement>('#collect-error')!;
  const updateQuantity = () => { content.querySelector('#collect-quantity')!.textContent = `获取数量（${collectKind.value === 'gifs' ? '张' : '套'}）`; };
  openCollect.prepend(createElement(Download));
  openCollect.addEventListener('click', () => {
    collect.reset(); collectKind.value = expressionKind; updateQuantity(); collectError.textContent = ''; dialog.showModal();
  });
  collectKind.addEventListener('change', updateQuantity);
  cancelCollect.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (cancelCollect.disabled) event.preventDefault(); });
  collect.addEventListener('submit', async event => {
    event.preventDefault(); const button = collect.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    if (button.disabled) return;
    const data = new FormData(collect); const sourceId = String(data.get('sourceId')).trim();
    const controls = collect.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button');
    controls.forEach(control => { control.disabled = true; }); collectError.textContent = ''; button.textContent = '正在提交…';
    try {
      await api('/expressions/collect', 'POST', { kind: String(data.get('kind')), keyword: String(data.get('keyword')), target: Number(data.get('target')), ...(sourceId ? { sourceId } : {}) });
      if (view === epoch) { dialog.close(); expressionKind = String(data.get('kind')) as typeof expressionKind; expressionPage = 1; await expressions(); report(new Error('获取已开始，新资源将进入待上架。')); }
    } catch (error) { if (view === epoch) collectError.textContent = error instanceof Error ? error.message : '获取未开始，请重试'; }
    finally { controls.forEach(control => { control.disabled = false; }); button.textContent = '确认获取'; }
  });
  try {
    const params = new URLSearchParams({ kind: expressionKind, keyword: expressionKeyword, status: expressionStatus, page: String(expressionPage) });
    const data = await api<{ entries: Expression[]; total: number; jobs: CollectionJob[] }>(`/expressions?${params}`);
    if (view !== epoch) return;
    renderJobs(jobs, data.jobs);
    openCollect.disabled = data.jobs.some(job => job.status === 'running');
    const host = content.querySelector('#expression-list')!; host.replaceChildren();
    const list = table(['预览', '名称 / 作者', '状态', '数量', '操作']);
    for (const entry of data.entries) {
      const image = document.createElement('img'); image.className = 'expression-thumbnail'; image.alt = entry.title; image.loading = 'lazy'; image.src = `/admin-api/expressions/${entry.id}/media/0`;
      const name = document.createElement('div'); const title = document.createElement('strong'); title.textContent = entry.title;
      const author = document.createElement('p'); author.textContent = entry.author; name.append(title, author);
      const actions = document.createElement('div'); actions.className = 'actions';
      actions.append(iconButton(`编辑 ${entry.title}`, Pencil, () => void editExpression(entry.id)));
      const toggle = document.createElement('button'); toggle.textContent = entry.status === 'published' ? '下架' : '上架';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try { await api(`/expressions/${entry.id}`, 'PATCH', { title: entry.title, tags: entry.tags, status: entry.status === 'published' ? 'pending' : 'published' }); if (view === epoch) await expressions(); }
        catch (error) { if (view === epoch) report(error); } finally { toggle.disabled = false; }
      });
      actions.append(toggle); row(list.body, [image, name, entry.status === 'published' ? '已上架' : '待上架', `${entry.count} 张`, actions]);
    }
    host.append(list.wrapper);
    if (!data.entries.length) { const empty = document.createElement('p'); empty.textContent = '暂无符合条件的资源'; host.append(empty); }
    const paging = document.createElement('nav'); paging.className = 'actions'; paging.setAttribute('aria-label', '资源分页');
    const previous = iconButton('上一页', ArrowLeft, () => { expressionPage--; void expressions(); }); previous.disabled = expressionPage === 1;
    const next = iconButton('下一页', ArrowRight, () => { expressionPage++; void expressions(); }); next.disabled = expressionPage * 24 >= data.total;
    const count = document.createElement('span'); count.textContent = `第 ${expressionPage} 页 · 共 ${data.total} 项`; paging.append(previous, count, next); host.append(paging);
    if (data.jobs.some(job => job.status === 'running')) {
      const poll = async () => {
        if (view !== epoch) return;
        try { const result = await api<{ jobs: CollectionJob[] }>('/expressions/jobs'); if (view !== epoch) return; renderJobs(jobs, result.jobs);
          if (result.jobs.some(job => job.status === 'running')) window.setTimeout(() => void poll(), 2000); else await expressions();
        } catch (error) { if (view === epoch) report(error); }
      };
      window.setTimeout(() => void poll(), 2000);
    }
  } catch (error) { if (view === epoch) { content.querySelector('#expression-list')!.textContent = ''; report(error); } }
}
async function editExpression(id: string) {
  frame('资源详情'); const epoch = view; const content = root.querySelector<HTMLElement>('#content')!;
  content.append(iconButton('返回资源列表', ArrowLeft, () => void expressions()));
  try {
    const entry = await api<Expression>(`/expressions/${id}`); if (view !== epoch) return;
    const form = document.createElement('form');
    form.innerHTML = `<label>名称<input name="title" maxlength="120" required></label><label>标签<input name="tags" maxlength="2048"></label><label>状态<select name="status"><option value="pending">待上架</option><option value="published">已上架</option></select></label><button class="primary" type="submit">保存</button>`;
    for (const key of ['title', 'tags', 'status'] as const) (form.elements.namedItem(key) as HTMLInputElement).value = entry[key];
    form.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('button')!; if (button.disabled) return; button.disabled = true;
      try { await api(`/expressions/${id}`, 'PATCH', Object.fromEntries(new FormData(form))); if (view === epoch) report(new Error('已保存')); }
      catch (error) { if (view === epoch) report(error); } finally { button.disabled = false; }
    });
    content.append(form);
    const source = document.createElement('p'); source.textContent = `作者：${entry.author} · 来源：${entry.source}`; content.append(source);
    const gallery = document.createElement('div'); gallery.className = 'expression-gallery';
    for (const item of entry.items ?? []) { const image = document.createElement('img'); image.alt = item.title; image.loading = 'lazy'; image.src = `/admin-api/expressions/${id}/media/${item.position}`; gallery.append(image); }
    content.append(gallery);
    const deletion = document.createElement('details'); deletion.className = 'cleanup'; deletion.innerHTML = '<summary>删除资源</summary><p>资源及不再使用的原图将从资源库删除。已发送和本机保存的副本不受影响。</p>';
    const button = iconButton('确认删除资源', Trash2, async () => {
      button.disabled = true;
      try { await api(`/expressions/${id}`, 'DELETE'); if (view === epoch) await expressions(); }
      catch (error) { if (view === epoch) report(error); } finally { button.disabled = false; }
    }); button.classList.add('danger'); deletion.append(button); content.append(deletion);
  } catch (error) { if (view === epoch) report(error); }
}

login();
