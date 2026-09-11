import './admin.css';
import { createElement, Pencil, Trash2, ArrowLeft, LayoutDashboard, Images, RefreshCw, LogOut, Upload, Save, X, Download } from 'lucide';
import { table, row, badge, iconButton, pageToolbar, loadingState, emptyState, errorState, pagination } from './admin/ui';

type Room = { roomId: string; createdAt: string; lastSeenAt: string | null; devices: number; backups: number; messageCount: number };
type Detail = { roomId: string; devices: { deviceId: string; role: string; name: string; status: string; lastSeenAt: string | null }[];
  backups: { id: string; deviceId: string; revision: number; active: number; updatedAt: string; recoveryBytes: number; historyBytes: number }[] };
const root = document.querySelector<HTMLElement>('#admin')!;
let csrf = '';
let offset = 0;
let view = 0;
let viewRequests = new AbortController();
let previewCleanup: (() => void)[] = [];
let previewQueue: (() => void)[] = [];
let activePreviews = 0;

function clearPreviews() {
  previewQueue = [];
  for (const cleanup of previewCleanup.splice(0)) cleanup();
  activePreviews = 0;
}

function loadPreview(image: HTMLImageElement, url: string) {
  previewQueue.push(() => {
    activePreviews++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; window.clearTimeout(timer);
      image.removeEventListener('load', finish); image.removeEventListener('error', finish);
      activePreviews--; previewQueue.shift()?.();
    };
    const timer = window.setTimeout(() => { image.removeAttribute('src'); image.dispatchEvent(new Event('error')); }, 20_000);
    previewCleanup.push(() => { finished = true; window.clearTimeout(timer); image.removeEventListener('load', finish); image.removeEventListener('error', finish); image.removeAttribute('src'); });
    image.addEventListener('load', finish); image.addEventListener('error', finish);
    image.src = url;
  });
  if (activePreviews < 3) previewQueue.shift()?.();
}

function leaveView() {
  viewRequests.abort(); viewRequests = new AbortController(); clearPreviews();
}
let sessionGeneration = 0;
let sessionTimer: number | undefined;
let sessionActivity = 0;
let lastAdminActivity = 0;
let sessionRenewing = false;
let lastSessionRenewal = 0;
const date = (value: string | null) => value ? new Date(value).toLocaleString() : '暂无记录';
const size = (value: number) => `${(value / 1024).toFixed(1)} KiB`;

async function requestApi<T>(route: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const generation = sessionGeneration;
  const timeout = AbortSignal.timeout(method === 'GET' ? 20_000 : 120_000);
  const signals = [timeout, ...(signal ? [signal] : []), ...(method === 'GET' ? [viewRequests.signal] : [])];
  const response = await fetch(`/admin-api${route}`, { method, cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any(signals),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const fallback = response.status === 413
    ? '上传请求超过服务器大小限制，请联系管理员检查上传配置（HTTP 413）'
    : response.status >= 500
      ? `服务器暂时无法处理请求，请稍后重试（HTTP ${response.status}）`
      : `服务器返回异常响应，请刷新页面后重试（HTTP ${response.status}）`;
  const result = await response.json().catch(error => {
    if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
    throw new Error(fallback);
  });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(fallback);
  if (response.status === 401 && result.code === 'SESSION_EXPIRED' && csrf && generation === sessionGeneration) {
    login(); report(new Error(result.error));
  }
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : fallback);
  return result;
}

async function api<T>(route: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  try { return await requestApi<T>(route, method, body, signal); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(method === 'GET' ? '读取超时，请重试' : '请求超时，请先刷新确认操作结果');
    }
    throw error;
  }
}

function startSessionRenewal() {
  window.clearInterval(sessionTimer);
  sessionActivity = 0; lastAdminActivity = Date.now(); sessionRenewing = false; lastSessionRenewal = Date.now();
  const generation = sessionGeneration;
  sessionTimer = window.setInterval(() => {
    if (!csrf || generation !== sessionGeneration || sessionRenewing || !sessionActivity
      || Date.now() - sessionActivity > 5 * 60_000 || document.visibilityState !== 'visible'
      || !document.hasFocus() || Date.now() - lastSessionRenewal < 5 * 60_000) return;
    const activity = sessionActivity;
    sessionActivity = 0; sessionRenewing = true; lastSessionRenewal = Date.now();
    void api('/session', 'POST', undefined, AbortSignal.timeout(15_000)).catch(() => {
      if (generation === sessionGeneration && !sessionActivity) sessionActivity = activity;
    }).finally(() => { if (generation === sessionGeneration) sessionRenewing = false; });
  }, 60_000);
}
for (const type of ['pointerdown', 'keydown', 'wheel'] as const) {
  document.addEventListener(type, event => {
    if (event.isTrusted && csrf && document.visibilityState === 'visible' && document.hasFocus()) { sessionActivity = Date.now(); lastAdminActivity = sessionActivity; }
  }, { passive: true });
}

function frame(title: string) {
  leaveView();
  view += 1;
  try { sessionStorage.setItem('quiet-admin-view', title === '采集任务' ? 'collection-jobs' : title === '表情采集' ? 'collection' : 'rooms'); } catch { /* Storage may be unavailable. */ }
  const expressionView = title === '表情管理' || title === '资源详情';
  const collectionView = title === '表情采集' || title === '采集任务';
  root.innerHTML = `<div class="admin-shell tabler-shell"><aside class="admin-sidebar navbar navbar-vertical"><div class="brand"><span class="brand-mark avatar bg-primary text-white">Q</span><div><strong>Quiet Room</strong><small>管理控制台</small></div></div>
    <nav class="sidebar-nav" aria-label="后台导航"><button id="rooms-nav" class="nav-item"><span class="nav-icon" aria-hidden="true"></span><span>会话管理</span></button><button id="expressions-nav" class="nav-item"><span class="nav-icon" aria-hidden="true"></span><span>表情管理</span></button><button id="collection-nav" class="nav-item"><span class="nav-icon" aria-hidden="true"></span><span>表情采集</span></button></nav>
    <div class="sidebar-note">管理员会话</div></aside>
    <main class="admin-main"><header class="topbar navbar navbar-expand-md"><div><p class="eyebrow">QUIET ROOM / ADMIN</p><h1></h1></div><button id="logout" class="logout-button btn btn-outline-secondary" type="button">退出后台</button></header>
    <div class="content-wrap"><div id="content"></div></div><div id="status" role="status" aria-live="polite"></div></main></div>`;
  root.querySelector('h1')!.textContent = title;
  root.querySelector('.nav-icon')!.replaceChildren(createElement(LayoutDashboard));
  root.querySelectorAll('.nav-icon')[1]!.replaceChildren(createElement(Images));
  root.querySelectorAll('.nav-icon')[2]!.replaceChildren(createElement(Download));
  const activeNav = expressionView ? '#expressions-nav' : collectionView ? '#collection-nav' : '#rooms-nav';
  root.querySelector<HTMLButtonElement>(activeNav)!.setAttribute('aria-current', 'page');
  const logout = root.querySelector<HTMLButtonElement>('#logout')!;
  const logoutIcon = createElement(LogOut); logoutIcon.setAttribute('aria-hidden', 'true'); logout.prepend(logoutIcon);
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await api('/logout', 'POST'); login(); }
    catch (error) { report(error); if (logout.isConnected) logout.disabled = false; }
  });
  root.querySelector('#rooms-nav')!.addEventListener('click', () => void rooms());
  root.querySelector('#expressions-nav')!.addEventListener('click', () => void expressions());
  root.querySelector('#collection-nav')!.addEventListener('click', () => void collection());
}

function report(error: unknown, tone: 'danger' | 'success' = 'danger') {
  const target = root.querySelector<HTMLElement>('#status'); if (!target) return;
  target.replaceChildren(); target.dataset.tone = tone;
  const text = document.createElement('span'); text.textContent = error instanceof Error ? error.message : String(error);
  target.append(text);
  target.append(iconButton('关闭提示', X, () => target.replaceChildren()));
}

function login() {
  leaveView();
  sessionGeneration += 1; window.clearInterval(sessionTimer); sessionTimer = undefined; sessionActivity = 0;
  view += 1;
  try { sessionStorage.removeItem('quiet-admin-view'); } catch { /* Storage may be unavailable. */ } csrf = '';
  offset = 0; expressionPage = 1; expressionStatus = 'all';
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
    try { const result = await api<{ csrf: string }>('/login', 'POST', body); if (!form.isConnected) return; csrf = result.csrf; startSessionRenewal(); await rooms(); }
    catch (error) { if (form.isConnected) report(error); }
    finally { body.password = ''; body.code = ''; if (button.isConnected) button.disabled = false; }
  });
}

async function rooms() {
  frame('会话管理'); const epoch = view;
  const content = root.querySelector('#content')!; content.append(loadingState('正在读取会话…'));
  try {
    const data = await api<{ rooms: Room[] }>(`/rooms?offset=${offset}`);
    if (epoch !== view) return;
    content.textContent = '';
    if (!data.rooms.length && offset > 0) { offset = Math.max(0, offset - 50); await rooms(); return; }
    content.append(pageToolbar('所有会话', `本页 ${data.rooms.length} 个会话`, { label: '刷新会话列表', icon: RefreshCw, run: () => void rooms() }));
    const list = table(['会话', '最近活动', '活跃设备', '有效备份', '消息记录']);
    for (const room of data.rooms) {
      const button = document.createElement('button'); button.className = 'room-id'; button.textContent = room.roomId;
      button.addEventListener('click', () => void detail(room.roomId));
      row(list.body, [button, date(room.lastSeenAt), room.devices, room.backups, room.messageCount]);
    }
    content.append(list.wrapper);
    if (!data.rooms.length) content.append(emptyState('暂无会话。'));
    content.append(pagination({ page: offset / 50 + 1, pageSize: 50, hasNext: data.rooms.length === 50, label: '会话分页', change: page => { offset = (page - 1) * 50; void rooms(); } }));
  } catch (error) { if (epoch === view) content.replaceChildren(errorState(error, () => void rooms())); }
}

async function detail(id: string) {
  frame('会话详情'); const epoch = view;
  const content = root.querySelector('#content')!;
  const back = iconButton('返回会话列表', ArrowLeft, () => void rooms()); content.append(back);
  const code = document.createElement('p'); code.className = 'room-id'; code.textContent = id; content.append(code);
  try {
    const data = await api<Detail>(`/rooms/${id}`);
    if (epoch !== view) return;
    content.append(pageToolbar('设备与备份', `${data.devices.length} 台设备`));
    const devices = table(['参与方 / 设备', '状态', '最近活动', '恢复备份', '历史备份']);
    for (const device of data.devices) {
      const backup = data.backups.find(b => b.deviceId === device.deviceId && b.active);
      const status = ({ active: ['活跃', 'success'], pending: ['待授权', 'warning'], revoked: ['已撤销', 'danger'] } as Record<string, [string, 'success' | 'warning' | 'danger']>)[device.status] ?? [device.status, 'muted'];
      const identity = document.createElement('div'); const name = document.createElement('strong'); name.textContent = `${device.role === 'creator' ? '创建者' : '受邀者'} · ${device.name}`;
      const deviceId = document.createElement('p'); deviceId.className = 'room-id'; deviceId.textContent = device.deviceId; identity.append(name, deviceId);
      row(devices.body, [identity,
        badge(status[0], status[1]),
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
        try { await api(`/rooms/${id}`, 'DELETE', body); if (epoch === view) { await rooms(); report('会话已清理。', 'success'); } }
        catch (error) { if (epoch === view) report(error); }
        finally { body.password = ''; body.code = ''; if (button.isConnected) button.disabled = false; }
      });
    });
  } catch (error) { if (epoch === view) content.append(errorState(error, () => void detail(id))); }
}

type Expression = { id: string; kind: 'gifs' | 'stickers'; title: string; tags: string; author: string; source: string; status: string; count: number; items?: { position: number; title: string }[] };
let expressionKind: 'gifs' | 'stickers' = 'gifs';
let expressionPage = 1;
let expressionStatus = 'all';

type SourcePack = { id: string; title: string; author: string; cover: string; collected?: boolean };

type CollectionJobStatus = 'running' | 'queued' | 'completed' | 'cancelled' | 'failed';
type CollectionJob = { id: string; sourceId?: string; keyword?: string; channel?: string; kind?: string; title?: string; status: CollectionJobStatus; added: number; target?: number; failed: number; error?: string; created?: number; started?: number; finished?: number; packStarted?: number; totalFiles?: number; downloadedFiles?: number; downloadedBytes?: number; phase?: string };
let collectionChannel = 'signal';
let collectionJobStatus: CollectionJobStatus = 'running';
const collectionJobStates: { status: CollectionJobStatus; label: string }[] = [
  { status: 'running', label: '进行中' }, { status: 'queued', label: '排队中' },
  { status: 'completed', label: '已完成' }, { status: 'cancelled', label: '已取消' },
  { status: 'failed', label: '异常' },
];
const collectionJobLabels = Object.fromEntries(collectionJobStates.map(item => [item.status, item.label])) as Record<CollectionJobStatus, string>;

function collectionJobTitle(job: CollectionJob): string {
  return job.title || job.sourceId || job.keyword || (job.channel === 'noto' ? 'Google Noto 动画' : 'Signal Stickers 采集');
}

function collectionJobDetail(job: CollectionJob): string {
  const total = job.totalFiles || 0; const done = job.downloadedFiles || 0;
  let note = job.error || '';
  if (job.status === 'queued') note = '等待可用任务位';
  else if (job.status === 'running' && done > 0 && total > done && job.started) {
    note = `预计还需 ${Math.max(1, Math.ceil((Date.now() - (job.packStarted || job.started)) / done * (total - done) / 1000))} 秒`;
  } else if (job.status === 'running' && total && done === total) note = '正在校验入库';
  else if (job.status === 'running' && !note) note = '正在读取来源';
  return `${done} / ${total || '待确定'} 张${total ? `（${Math.round(done / total * 100)}%）` : ''} · 已下载 ${size(job.downloadedBytes || 0)} · 已上架 ${job.added} / ${job.target || 1} 项${note ? ` · ${note}` : ''}`;
}

async function collectionJobs() {
  frame('采集任务'); const epoch = view;
  const content = root.querySelector<HTMLElement>('#content')!;
  const toolbar = document.createElement('div'); toolbar.className = 'resource-toolbar';
  toolbar.append(iconButton('返回表情采集', ArrowLeft, () => void collection()));
  const note = document.createElement('p'); note.className = 'collection-capacity'; note.textContent = '最多同时进行 10 个任务，超出后自动排队；完成并校验后自动上架。';
  toolbar.append(note); content.append(toolbar);
  const tabs = document.createElement('div'); tabs.className = 'actions expression-tabs collection-job-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '采集任务状态');
  const host = document.createElement('section'); host.id = 'collection-jobs'; host.className = 'collection-tasks'; host.setAttribute('role', 'tabpanel'); host.setAttribute('aria-live', 'polite'); host.append(loadingState('正在读取采集任务…'));
  content.append(tabs, host);
  let jobs: CollectionJob[] = []; let requestId = 0; let signature = '';
  const render = () => {
    tabs.replaceChildren(...collectionJobStates.map(({ status, label }) => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab'); button.dataset.status = status;
      button.setAttribute('aria-controls', host.id); button.setAttribute('aria-selected', String(collectionJobStatus === status));
      button.textContent = `${label} ${jobs.filter(job => job.status === status).length}`;
      button.addEventListener('click', () => { collectionJobStatus = status; render(); });
      return button;
    }));
    host.replaceChildren();
    const selected = jobs.filter(job => job.status === collectionJobStatus);
    if (!selected.length) { host.append(emptyState(`暂无${collectionJobLabels[collectionJobStatus]}任务`)); return; }
    for (const job of selected) {
      const item = document.createElement('article'); item.className = 'collection-task'; item.dataset.jobId = job.id;
      const title = document.createElement('strong'); title.textContent = collectionJobTitle(job);
      const tone = job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : job.status === 'running' ? 'warning' : 'muted';
      const state = badge(collectionJobLabels[job.status], tone);
      const detail = document.createElement('p'); detail.textContent = collectionJobDetail(job);
      item.append(title, state);
      const total = job.totalFiles || 0;
      if (job.status === 'running') {
        const progress = document.createElement('progress'); progress.max = total || 1; if (total) progress.value = job.downloadedFiles || 0;
        progress.setAttribute('aria-label', `${title.textContent} 下载进度`); item.append(progress);
      }
      item.append(detail);
      const actions = document.createElement('div'); actions.className = 'actions collection-task-actions';
      if (['running', 'queued'].includes(job.status)) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'danger'; cancel.textContent = '取消任务'; cancel.prepend(createElement(X));
        cancel.addEventListener('click', async () => { cancel.disabled = true; try { await api(`/expressions/jobs/${job.id}/cancel`, 'POST'); signature = ''; await refresh(); } catch (error) { if (view === epoch) { report(error); cancel.disabled = false; } } });
        actions.append(cancel);
      } else {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新采集'; retry.prepend(createElement(RefreshCw));
        retry.addEventListener('click', async () => { retry.disabled = true; try { const restarted = await api<CollectionJob>(`/expressions/jobs/${job.id}/retry`, 'POST'); collectionJobStatus = restarted.status; signature = ''; await refresh(); } catch (error) { if (view === epoch) { report(error); retry.disabled = false; } } });
        actions.append(retry);
      }
      item.append(actions); host.append(item);
    }
  };
  const refresh = async () => {
    const current = ++requestId;
    try {
      const result = await api<{ jobs: CollectionJob[] }>('/expressions/jobs', 'GET', undefined, AbortSignal.timeout(15000));
      if (view !== epoch || current !== requestId) return;
      const nextSignature = JSON.stringify(result.jobs);
      if (signature === nextSignature) return;
      jobs = result.jobs; signature = nextSignature; render();
    } catch (error) { if (view === epoch && current === requestId) { signature = ''; host.replaceChildren(errorState(error, () => void refresh())); } }
  };
  const poll = async () => {
    if (view !== epoch) return;
    if (document.visibilityState === 'visible' && document.hasFocus() && Date.now() - lastAdminActivity < 5 * 60_000) await refresh();
    if (view === epoch) window.setTimeout(() => void poll(), 1500);
  };
  // Explicit navigation always loads once, even when browser focus is unavailable.
  await refresh();
  if (view === epoch) window.setTimeout(() => void poll(), 1500);
}

async function collection() {
  frame('表情采集'); const epoch = view;
  const content = root.querySelector<HTMLElement>('#content')!;
  content.innerHTML = `<div class="resource-toolbar"><label>采集渠道<select id="collection-channel"><option value="signal">Signal Stickers · 贴图合集</option><option value="noto">Google Noto · 动画表情</option></select></label><div class="actions"><button id="open-collection-jobs">采集任务</button><button id="review-collected">管理已入库资源</button></div></div>
    <section class="source-panel" aria-labelledby="source-title"><div class="source-heading"><div><h2 id="source-title"></h2><p>选择资源加入后台队列，完整下载并校验后自动上架。</p></div><form id="source-search" class="source-search"><input name="keyword" placeholder="搜索表情" maxlength="80" aria-label="搜索表情"><button class="primary" type="submit">搜索</button></form></div><div id="source-results" class="source-results" aria-live="polite"></div><div id="source-pagination"></div></section>`;
  const channel = content.querySelector<HTMLSelectElement>('#collection-channel')!;
  channel.value = collectionChannel;
  const selectedChannel = collectionChannel;
  content.querySelector('#source-title')!.textContent = selectedChannel === 'noto' ? 'Google Noto 动画表情' : 'Signal Stickers 贴图包';
  channel.addEventListener('change', () => { collectionChannel = channel.value; void collection(); });
  content.querySelector('#open-collection-jobs')!.addEventListener('click', () => { collectionJobStatus = 'running'; void collectionJobs(); });
  content.querySelector('#review-collected')!.addEventListener('click', () => { expressionKind = selectedChannel === 'noto' ? 'gifs' : 'stickers'; expressionStatus = 'all'; expressionPage = 1; void expressions(); });
  let page = 1; let generation = 0;
  let jobs: CollectionJob[] = [];
  const buttons = new Map<string, HTMLButtonElement>();
  const refreshJobs = async () => {
    try {
      const result = await api<{ jobs: CollectionJob[] }>('/expressions/jobs', 'GET', undefined, AbortSignal.timeout(15000));
      if (view !== epoch) return;
      jobs = result.jobs;
    } catch { /* The collection action still performs server-side deduplication. */ }
  };
  void refreshJobs();
  const sourceResults = content.querySelector<HTMLElement>('#source-results')!;
  let searchRequest: AbortController | undefined;
  const search = async () => {
    searchRequest?.abort(); searchRequest = new AbortController();
    clearPreviews();
    const form = content.querySelector<HTMLFormElement>('#source-search')!;
    const keyword = String(new FormData(form).get('keyword') ?? '');
    const request = ++generation;
    buttons.clear(); sourceResults.textContent = '正在搜索…';
    try {
      const data = await api<{ packs: SourcePack[]; total: number }>(`/expressions/source?channel=${selectedChannel}&page=${page}&keyword=${encodeURIComponent(keyword)}`, 'GET', undefined, searchRequest.signal);
      if (view !== epoch || request !== generation) return;
      content.querySelector('#source-pagination')!.replaceChildren(pagination({ page, total: data.total ?? data.packs.length, pageSize: 24, label: '来源分页', change: value => { page = value; void search(); } }));
      sourceResults.replaceChildren(...data.packs.map(pack => {
        const card = document.createElement('article'); card.className = 'source-pack';
        card.innerHTML = `<img class="source-cover" alt=""><div class="source-pack-info"><strong></strong><small></small></div><button class="btn btn-outline-primary" type="button">采集此包</button>`;
        const cover = card.querySelector<HTMLImageElement>('img')!; loadPreview(cover, pack.cover); cover.alt = pack.title;
        cover.addEventListener('error', () => {
          if (card.querySelector('.preview-retry')) return;
          const retry = document.createElement('button'); retry.className = 'preview-retry'; retry.textContent = '重试预览';
          retry.addEventListener('click', () => { retry.remove(); loadPreview(cover, pack.cover); }); card.append(retry);
        });
        card.querySelector('strong')!.textContent = pack.title; card.querySelector('small')!.textContent = pack.author || 'Signal Stickers';
        const button = card.querySelector<HTMLButtonElement>('button')!;
        buttons.set(pack.id, button);
        const active = jobs.find(job => job.sourceId === pack.id && ['running', 'queued'].includes(job.status));
        if (pack.collected) { button.disabled = true; button.textContent = '已入库'; }
        else if (active) { button.dataset.jobId = active.id; button.disabled = true; button.textContent = collectionJobLabels[active.status]; }
        button.addEventListener('click', async () => {
          button.disabled = true; button.textContent = '准备中…';
          try {
            const job = await api<{ id: string }>('/expressions/collect', 'POST', { channel: selectedChannel, kind: selectedChannel === 'noto' ? 'gifs' : 'stickers', keyword: '', sourceId: pack.id, target: 1 });
            if (view !== epoch) return;
            button.dataset.jobId = job.id; button.textContent = '已加入队列'; await refreshJobs();
          } catch (error) { button.disabled = false; button.textContent = '采集此包'; report(error); }
        });
        return card;
      }));
      if (!data.packs.length) sourceResults.textContent = '没有找到匹配的贴图包';
    } catch (error) { if (view === epoch && request === generation) sourceResults.replaceChildren(errorState(error, () => void search())); }
  };
  content.querySelector<HTMLFormElement>('#source-search')!.addEventListener('submit', event => { event.preventDefault(); page = 1; void search(); });
}

async function expressions() {
  frame('表情管理'); const epoch = view;
  const content = root.querySelector<HTMLElement>('#content')!;
  content.innerHTML = `<div class="resource-toolbar"><div class="actions expression-tabs" role="tablist" aria-label="资源类型"><button role="tab" data-type="gifs" aria-controls="expression-list">GIFs</button><button role="tab" data-type="stickers" aria-controls="expression-list">贴图</button></div>
    <div class="actions"><label class="filter-field"><span>上架状态</span><select id="status-filter"><option value="all">全部状态</option><option value="published">已上架</option><option value="pending">待上架</option></select></label><button id="open-upload" class="primary" type="button">上传资源</button></div></div><div id="expression-list" role="tabpanel"></div>`;
  content.querySelector('#expression-list')!.append(loadingState('正在读取资源…'));
  const statusFilter = content.querySelector<HTMLSelectElement>('#status-filter')!; statusFilter.value = expressionStatus;
  statusFilter.addEventListener('change', () => { expressionStatus = statusFilter.value; expressionPage = 1; void expressions(); });
  const openUpload = content.querySelector<HTMLButtonElement>('#open-upload')!;
  const uploadIcon = createElement(Upload); uploadIcon.setAttribute('aria-hidden', 'true'); openUpload.prepend(uploadIcon);
  const upload = document.createElement('form'); upload.id = 'expression-upload';
  upload.innerHTML = `<input name="files" type="file" accept=".wastickers,image/gif" required hidden><button type="submit" hidden>上传</button>`;
  const fileInput = upload.elements.namedItem('files') as HTMLInputElement;
  content.querySelector('#open-upload')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files?.length) upload.requestSubmit(); });
  content.append(upload);
  upload.addEventListener('submit', async event => {
    event.preventDefault(); const button = upload.querySelector('button')!; if (button.disabled) return; button.disabled = true;
    openUpload.disabled = true; openUpload.setAttribute('aria-busy', 'true'); openUpload.textContent = '正在上传…';
    try {
      const data = new FormData(upload); const files = data.getAll('files').filter((file): file is File => file instanceof File && file.size > 0);
      const packageUpload = files.length === 1 && /\.wastickers$/i.test(files[0]!.name);
      const maxUploadBytes = (packageUpload ? 50 : 8) * 1024 * 1024;
      if (!files.length || files.length > 200 || files.reduce((sum, file) => sum + file.size, 0) > maxUploadBytes) {
        throw new Error(packageUpload ? 'wastickers 文件不得超过 50 MiB' : '图片合计不得超过 8 MiB，合集最多 200 张');
      }
      const encoded = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        encoded.push({ name: file.name, data: btoa(binary) });
      }
      if (view !== epoch) return;
      const file = files[0]!; const kind = packageUpload ? 'stickers' : 'gifs';
      await api('/expressions', 'POST', { kind, title: file.name.replace(/\.[^.]+$/, ''), tags: '', status: 'published', files: encoded });
      if (view === epoch) { expressionKind = kind; expressionStatus = 'all'; expressionPage = 1; await expressions(); report('已上传并上架', 'success'); }
    } catch (error) { if (view === epoch) report(error); } finally {
      upload.reset(); button.disabled = false; openUpload.disabled = false; openUpload.removeAttribute('aria-busy'); openUpload.textContent = '上传资源'; openUpload.prepend(uploadIcon);
    }
  });
  content.querySelectorAll<HTMLButtonElement>('[data-type]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.type === expressionKind));
    button.tabIndex = button.dataset.type === expressionKind ? 0 : -1;
    button.id = `tab-${button.dataset.type}`;
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      expressionKind = event.key === 'Home' ? 'gifs' : event.key === 'End' ? 'stickers' : expressionKind === 'gifs' ? 'stickers' : 'gifs';
      expressionPage = 1; void expressions(); root.querySelector<HTMLButtonElement>(`[data-type="${expressionKind}"]`)?.focus();
    });
    button.addEventListener('click', () => { expressionKind = button.dataset.type as typeof expressionKind; expressionPage = 1; void expressions(); });
  });
  try {
    const params = new URLSearchParams({ kind: expressionKind, keyword: '', status: expressionStatus, page: String(expressionPage) });
    const data = await api<{ entries: Expression[]; total: number }>(`/expressions?${params}`);
    if (view !== epoch) return;
    const totalPages = Math.max(1, Math.ceil(data.total / 24));
    if (expressionPage > totalPages) { expressionPage = totalPages; await expressions(); return; }
    const host = content.querySelector('#expression-list')!; host.replaceChildren();
    host.setAttribute('aria-labelledby', `tab-${expressionKind}`);
    const selection = new Set<string>();
    const bulk = document.createElement('div'); bulk.className = 'actions expression-bulk';
    const selectLabel = document.createElement('label'); selectLabel.className = 'expression-select';
    const selectAll = document.createElement('input'); selectAll.type = 'checkbox';
    selectAll.disabled = !data.entries.length; selectLabel.append(selectAll, '全选本页');
    const selectedCount = document.createElement('span'); selectedCount.setAttribute('role', 'status');
    const publish = document.createElement('button'); publish.textContent = '批量上架'; publish.className = 'publish';
    const unpublish = document.createElement('button'); unpublish.textContent = '批量下架'; unpublish.className = 'unpublish';
    const checkboxes: HTMLInputElement[] = [];
    let busy = false;
    const updateSelection = () => {
      selectedCount.textContent = `已选 ${selection.size} 项`;
      selectAll.checked = data.entries.length > 0 && selection.size === data.entries.length;
      selectAll.indeterminate = selection.size > 0 && selection.size < data.entries.length;
      publish.disabled = busy || !data.entries.some(entry => selection.has(entry.id) && entry.status !== 'published');
      unpublish.disabled = busy || !data.entries.some(entry => selection.has(entry.id) && entry.status !== 'pending');
    };
    selectAll.addEventListener('change', () => {
      selection.clear();
      for (const checkbox of checkboxes) { checkbox.checked = selectAll.checked; if (checkbox.checked) selection.add(checkbox.value); }
      updateSelection();
    });
    const changeStatus = async (ids: string[], status: 'pending' | 'published') => {
      if (busy || !ids.length) return;
      busy = true;
      const controls = [...content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')];
      const disabled = controls.map(control => control.disabled);
      controls.forEach(control => { control.disabled = true; });
      try {
        const result = await api<{ updated: number }>('/expressions/status', 'PATCH', { ids, status });
        if (view === epoch) { await expressions(); report(`已${status === 'published' ? '上架' : '下架'} ${result.updated} 项`, 'success'); }
      } catch (error) { if (view === epoch) report(error); }
      finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]!; }); updateSelection(); }
    };
    publish.addEventListener('click', () => void changeStatus(data.entries.filter(entry => selection.has(entry.id) && entry.status !== 'published').map(entry => entry.id), 'published'));
    unpublish.addEventListener('click', () => void changeStatus(data.entries.filter(entry => selection.has(entry.id) && entry.status !== 'pending').map(entry => entry.id), 'pending'));
    bulk.append(selectLabel, selectedCount, publish, unpublish); host.append(bulk);
    const list = table(['预览', '名称 / 作者', '状态', '数量', '操作']);
    for (const entry of data.entries) {
      const image = document.createElement('img'); image.className = 'expression-thumbnail'; image.alt = entry.title; loadPreview(image, `/admin-api/expressions/${entry.id}/media/0`);
      const preview = document.createElement('label'); preview.className = 'expression-select expression-preview';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = entry.id; checkbox.setAttribute('aria-label', `选择 ${entry.title}`);
      checkbox.addEventListener('change', () => { if (checkbox.checked) selection.add(entry.id); else selection.delete(entry.id); updateSelection(); });
      checkboxes.push(checkbox); preview.append(checkbox, image);
      const name = document.createElement('div'); const title = document.createElement('strong'); title.textContent = entry.title;
      const author = document.createElement('p'); author.textContent = entry.author; name.append(title, author);
      const actions = document.createElement('div'); actions.className = 'actions';
      actions.append(iconButton(`编辑 ${entry.title}`, Pencil, () => void editExpression(entry.id)));
      const toggle = document.createElement('button'); toggle.textContent = entry.status === 'published' ? '下架' : '上架';
      toggle.className = entry.status === 'published' ? 'unpublish' : 'publish';
      toggle.addEventListener('click', () => void changeStatus([entry.id], entry.status === 'published' ? 'pending' : 'published'));
      actions.append(toggle); row(list.body, [preview, name, badge(entry.status === 'published' ? '已上架' : '待上架', entry.status === 'published' ? 'success' : 'warning'), `${entry.count} 张`, actions]);
    }
    updateSelection();
    host.append(list.wrapper);
    if (!data.entries.length) host.append(emptyState('暂无符合条件的资源'));
    host.append(pagination({ page: expressionPage, total: data.total, pageSize: 24, label: '资源分页', change: page => { expressionPage = page; void expressions(); } }));
  } catch (error) { if (view === epoch) content.querySelector('#expression-list')!.replaceChildren(errorState(error, () => void expressions())); }
}
async function editExpression(id: string) {
  frame('资源详情'); const epoch = view; const content = root.querySelector<HTMLElement>('#content')!;
  content.append(iconButton('返回资源列表', ArrowLeft, () => void expressions()));
  const loading = loadingState('正在读取资源…'); content.append(loading);
  try {
    const entry = await api<Expression>(`/expressions/${id}`); if (view !== epoch) return;
    loading.remove();
    const layout = document.createElement('div'); layout.className = 'resource-detail';
    const editor = document.createElement('section'); editor.className = 'resource-editor'; editor.append(pageToolbar('资源信息'));
    const preview = document.createElement('section'); preview.className = 'resource-media'; preview.append(pageToolbar('原图预览', `${entry.count} 张`));
    layout.append(editor, preview); content.append(layout);
    const form = document.createElement('form');
    form.innerHTML = `<label>名称<input name="title" maxlength="120" required></label><label>标签<input name="tags" maxlength="2048"></label><label>状态<select name="status"><option value="pending">待上架</option><option value="published">已上架</option></select></label><button class="primary" type="submit">保存</button>`;
    for (const key of ['title', 'tags', 'status'] as const) (form.elements.namedItem(key) as HTMLInputElement).value = entry[key];
    form.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('button')!; if (button.disabled) return;
      const values = Object.fromEntries(new FormData(form));
      const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')]; controls.forEach(control => { control.disabled = true; });
      try { await api(`/expressions/${id}`, 'PATCH', values); if (view === epoch) report('已保存', 'success'); }
      catch (error) { if (view === epoch) report(error); } finally { controls.forEach(control => { control.disabled = false; }); }
    });
    const saveIcon = createElement(Save); saveIcon.setAttribute('aria-hidden', 'true'); form.querySelector('button')!.prepend(saveIcon);
    editor.append(form);
    const source = document.createElement('p'); source.className = 'resource-attribution'; source.textContent = `作者：${entry.author || '未记录'} · 来源：${entry.source || '未记录'}`; editor.append(source);
    const gallery = document.createElement('div'); gallery.className = 'expression-gallery';
    for (const item of entry.items ?? []) { const tile = document.createElement('label'); tile.className = 'expression-item'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `选择 ${item.title}`); const image = document.createElement('img'); image.alt = item.title; image.dataset.position = String(item.position); loadPreview(image, `/admin-api/expressions/${id}/media/${item.position}`); tile.append(checkbox, image); gallery.append(tile); }
    const removeSelected = document.createElement('button'); removeSelected.type = 'button'; removeSelected.textContent = '删除选中资源'; removeSelected.className = 'danger'; removeSelected.disabled = true; preview.append(removeSelected);
    gallery.addEventListener('change', () => { removeSelected.disabled = !gallery.querySelector('input:checked'); });
    removeSelected.addEventListener('click', async () => { const selected = [...gallery.querySelectorAll<HTMLInputElement>('input:checked')].map(input => Number(input.closest('label')?.querySelector('img')?.dataset.position)); removeSelected.disabled = true; try { for (const position of selected.sort((a, b) => b - a)) await api(`/expressions/${id}?position=${position}`, 'DELETE'); if (view === epoch) selected.length >= entry.count ? await expressions() : await editExpression(id); } catch (error) { report(error); } });
    preview.append(gallery);
    const deletion = document.createElement('details'); deletion.className = 'cleanup'; deletion.innerHTML = '<summary>删除资源</summary><p>资源及不再使用的原图将从资源库删除。已发送和本机保存的副本不受影响。</p>';
    const button = iconButton('确认删除资源', Trash2, async () => {
      button.disabled = true;
      try { await api(`/expressions/${id}`, 'DELETE'); if (view === epoch) await expressions(); }
      catch (error) { if (view === epoch) report(error); } finally { button.disabled = false; }
    }); button.classList.add('danger'); deletion.append(button); content.append(deletion);
  } catch (error) { if (view === epoch) loading.replaceWith(errorState(error, () => void editExpression(id))); }
}

root.textContent = '正在验证后台会话…';
void api<{ csrf: string }>('/session').then(result => {
  csrf = result.csrf; startSessionRenewal();
  let previous = ''; try { previous = sessionStorage.getItem('quiet-admin-view') || ''; } catch { /* Use the default view. */ }
  return previous === 'collection-jobs' ? collectionJobs() : previous === 'collection' ? collection() : rooms();
}).catch(login);
