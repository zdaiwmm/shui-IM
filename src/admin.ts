import './admin.css';

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
    <p class="intro">管理会话、设备与加密备份。后台不保存恢复码，也不能查看聊天内容。</p><div id="content"></div><p id="status" role="status"></p>`;
  root.querySelector('h1')!.textContent = title;
  root.querySelector('#logout')!.addEventListener('click', () => { void api('/logout', 'POST').finally(login); });
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

login();
