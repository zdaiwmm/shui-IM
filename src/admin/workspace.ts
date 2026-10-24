import { createElement, ArrowRight, RefreshCw, CircleAlert, Copy, Check } from 'lucide';
import { badge, table, row, pageToolbar, loadingState, emptyState, errorState, pagination, type Tone } from './ui';
type Api = <T>(route: string, method?: string, body?: unknown) => Promise<T>;
type Context = {
    root: HTMLElement;
    api: Api;
    frame: (title: string) => void;
    epoch: () => number;
    report: (error: unknown, tone?: 'danger' | 'success') => void;
    resources: () => void;
    jobs: () => void;
};
type Archive = {
    id: string;
    roomId: string;
    deviceId: string;
    role: string;
    sourceExists: number;
    writerActive: number;
    objects: number;
    bytes: number;
    createdAt: string | null;
    lastWrittenAt: string | null;
};
type Room = {
    roomId: string;
    createdAt: string;
    lastSeenAt: string | null;
    format: string;
    state: string;
    devices: number;
    backups: number;
    privateArchives: number;
    messageCount: number;
    messageBytes: number;
    attachmentBytes: number;
    archiveBytes: number;
    windowFromSeq: number;
    windowEnabled: number;
    backupChatCount: number;
    backupGalleryCount: number;
};
type Detail = Omit<Room, 'devices' | 'backups'> & {
    archives: Archive[];
    pendingDevices: number;
    pendingDeviceLinks: number;
    pendingRepairLinks: number;
    incompleteAttachments: number;
    devices: {
        deviceId: string;
        role: string;
        name: string;
        status: string;
        lastSeenAt: string | null;
    }[];
    backups: {
        active: number;
        deviceId: string;
        revision: number;
        updatedAt: string;
        recoveryBytes: number;
        historyBytes: number;
        chatCount: number;
        galleryCount: number;
    }[];
};
type Backup = {
    sampledAt?: string;
    available: boolean;
    healthy?: boolean;
    code: string;
    lastVerifiedAt?: string;
    snapshotCreatedAt?: string;
    lastAttemptAt?: string;
    lastAttemptSucceeded?: boolean;
    destination?: string;
};
type Diagnostics = {
    checkedAt: string;
    releaseId: string | null;
    health: {
        ok: boolean;
        database: boolean;
        storage: boolean;
    };
    backup: Backup;
    services: {
        pushEnabled: boolean;
        calls: {
            valid: boolean;
            relayConfigured: boolean;
        };
        webSocketConnections: number;
    };
    policy: {
        incompleteBlobTtlMs: number;
        orphanRoomTtlMs: number;
        maxConnectionsPerRoom: number;
        maxConnectionsTotal: number;
    };
};
type Summary = {
    checkedAt: string;
    rooms: number;
    devices: number;
    archives: number;
    archiveObjects: number;
    archiveBytes: number;
    messageBytes: number;
    attachmentBytes: number;
    cleanupBytes: number;
    cleanupPending: number;
    incompleteAttachments: number;
    legacyBackups: number;
    limits: {
        maxRoomStorageBytes: number;
        maxTotalStorageBytes: number;
        maxMessagesPerRoom: number;
        maxRoomMessageBytes: number;
        maxTotalMessageBytes: number;
    };
    diagnostics: Diagnostics;
    jobs?: {
        running: number;
        queued: number;
        failed: number;
    };
    resources?: {
        stickers: number;
        gifs: number;
    };
};
const date = (v: string | null | undefined) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '未知';
const bytes = (v: number) => v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(2)} GiB` : v >= 1024 ** 2 ? `${(v / 1024 ** 2).toFixed(1)} MiB` : v >= 1024 ? `${(v / 1024).toFixed(1)} KiB` : `${v} B`;
const formats: Record<string, string> = { 'archive-v2': '新版密室', 'chamber-v1': '助记词密室', legacy: '旧版空间' };
const states: Record<string, string> = { active: '已建立', waiting: '待加入', closed: '已关闭' };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function button(text: string, run: () => void, cls = '') { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', run); return node; }
function note(text: string, tone = '') { return el('p', `admin-note ${tone}`, text); }
function key(value: string, action?: () => void) {
    const wrap = el('div', 'admin-key');
    const label = action ? button(value, action, 'room-id text-link') : el('span', 'room-id', value);
    wrap.append(label);
    const copy = button('复制编号', () => { void navigator.clipboard.writeText(value).then(() => { copy.replaceChildren(createElement(Check)); copy.setAttribute('aria-label', '已复制编号'); }).catch(() => { copy.textContent = '复制失败'; }); }, 'icon-button');
    copy.setAttribute('aria-label', `复制编号 ${value}`);
    copy.title = '复制编号';
    copy.replaceChildren(createElement(Copy));
    wrap.append(copy);
    return wrap;
}
function facts(items: [
    string,
    string | number | HTMLElement
][]) {
    const dl = el('dl', 'admin-facts');
    for (const [name, value] of items) {
        const pair = el('div');
        pair.append(el('dt', '', name));
        const dd = el('dd');
        value instanceof HTMLElement ? dd.append(value) : dd.textContent = String(value);
        pair.append(dd);
        dl.append(pair);
    }
    return dl;
}
function tabs(items: {
    label: string;
    run: () => void;
    active: boolean;
}[]) {
    const nav = el('nav', 'admin-tabs');
    nav.setAttribute('aria-label', '页面分栏');
    for (const item of items) {
        const b = button(item.label, item.run);
        if (item.active)
            b.setAttribute('aria-current', 'page');
        nav.append(b);
    }
    return nav;
}
function section(title: string, description = '') { const node = el('section', 'admin-section'); node.append(pageToolbar(title, description)); return node; }
function usage(label: string, value: number, limit: number) {
    const node = el('div', 'admin-usage');
    const top = el('div');
    top.append(el('span', '', label), el('strong', '', `${bytes(value)} / ${bytes(limit)}`));
    const meter = el('meter');
    meter.min = 0;
    meter.max = limit;
    meter.value = value;
    meter.setAttribute('aria-label', label);
    if (value > limit * .85)
        node.dataset.warning = 'true';
    node.append(top, meter);
    return node;
}
export class AdminWorkspace {
    private roomOffset = 0;
    private roomQuery = '';
    private roomFormat = 'all';
    private roomState = 'all';
    private archiveOffset = 0;
    private archiveQuery = '';
    private archiveSource = 'all';
    private archiveTab = 'new';
    private auditOffset = 0;
    private auditQuery = '';
    constructor(private c: Context) { }
    private async load<T>(title: string, route: string, render: (host: HTMLElement, data: T) => void, retry: () => void) {
        this.c.frame(title);
        const epoch = this.c.epoch();
        const host = this.c.root.querySelector<HTMLElement>('#content')!;
        host.append(loadingState('正在读取管理数据…'));
        try {
            const data = await this.c.api<T>(route);
            if (epoch !== this.c.epoch())
                return;
            host.replaceChildren();
            render(host, data);
        }
        catch (error) {
            if (epoch === this.c.epoch())
                host.replaceChildren(errorState(error, retry));
        }
    }
    private stamp(host: HTMLElement, time: string) { host.prepend(el('p', 'admin-stamp', `服务端记录 · 检查于 ${date(time)}`)); }
    overview = () => this.load<Summary>('总览', '/overview', (host, data) => {
        this.stamp(host, data.checkedAt);
        const intro = el('div', 'admin-intro');
        intro.append(el('div', 'admin-intro-copy'));
        intro.firstElementChild!.append(el('p', 'eyebrow', 'WORKSPACE OVERVIEW'), el('h2', '', '应用与数据状态'), note('检查服务、存储和待处理事项。'));
        const check = badge(data.diagnostics.health.ok ? '应用检查通过' : '应用检查异常', data.diagnostics.health.ok ? 'success' : 'danger');
        intro.append(check);
        host.append(intro);
        const counters = el('div', 'admin-counters');
        for (const [label, value, sub, run] of [
            ['密室', data.rooms, '服务端保留', this.rooms], ['已授权设备', data.devices, '授权状态，不代表在线', this.rooms], ['本人归档', data.archives, '独立保留的密文归档', () => void this.archives()], ['公开贴纸合集', data.resources?.stickers ?? 0, '后台资源库', this.c.resources],
        ] as const) {
            const item = button('', run, 'admin-counter');
            item.append(el('span', '', label), el('strong', '', String(value)), el('small', '', sub));
            counters.append(item);
        }
        host.append(counters);
        const layout = el('div', 'admin-overview-grid');
        const attention = section('需要关注');
        let issues = 0;
        const issue = (title: string, description: string, run: () => void) => { issues++; const item = button('', run, 'admin-attention-row'); const text = el('span'); text.append(el('strong', '', title), el('small', '', description)); item.append(createElement(CircleAlert), text, createElement(ArrowRight)); attention.append(item); };
        if (data.cleanupPending)
            issue(`${data.cleanupPending} 项密室附件清理待完成`, '系统持久队列将继续处理，预留空间在完成前保留。', this.diagnostics);
        if (data.jobs?.failed)
            issue(`${data.jobs.failed} 项采集任务异常`, '查看失败任务，确认后再重试。', this.c.jobs);
        if (!data.diagnostics.backup.available)
            issue('灾备状态尚未接入', '本人归档与服务器灾备是两类独立证据。', () => void this.archives('disaster'));
        else if (!data.diagnostics.backup.healthy)
            issue('灾备回执需要检查', '最近尝试失败、回执无效或恢复点已过期。', () => void this.archives('disaster'));
        if (!issues)
            attention.append(note('当前检查未发现上述待处理项。', 'positive'));
        if (data.jobs?.running || data.jobs?.queued)
            attention.append(button(`采集任务：${data.jobs.running} 进行中 · ${data.jobs.queued} 排队`, this.c.jobs, 'text-link'));
        const storage = section('容量与保留', '消息、附件和归档使用各自的存储额度。');
        storage.append(usage('在线消息密文', data.messageBytes, data.limits.maxTotalMessageBytes), usage('附件预留及占用', data.attachmentBytes + data.cleanupBytes, data.limits.maxTotalStorageBytes), usage('本人归档密文', data.archiveBytes, data.limits.maxTotalStorageBytes), button('查看运维诊断', this.diagnostics, 'text-link'));
        layout.append(attention, storage);
        host.append(layout);
        host.append(note('归档对象存在，不代表本机最新聊天已完整备份；灾备成功也不能证明每台设备已上传最新记录。'));
    }, this.overview);
    rooms = () => this.load<{
        rooms: Room[];
        total: number;
    }>('密室管理', `/rooms?offset=${this.roomOffset}&q=${encodeURIComponent(this.roomQuery)}&format=${this.roomFormat}&state=${this.roomState}`, (host, data) => {
        host.append(pageToolbar('服务端密室', `${data.total} 个匹配结果`, { label: '刷新密室列表', icon: RefreshCw, run: this.rooms }));
        const filters = el('form', 'admin-filters');
        const field = el('label', 'admin-search', '密室编号');
        const input = el('input');
        input.name = 'q';
        input.placeholder = '输入完整编号或编号前缀';
        input.value = this.roomQuery;
        input.maxLength = 36;
        input.pattern = '[-0-9a-fA-F]*';
        field.append(input);
        filters.append(field);
        const select = (label: string, current: string, options: [
            string,
            string
        ][], set: (v: string) => void) => {
            const field = el('label', '', label), control = el('select');
            control.setAttribute('aria-label', label);
            for (const [v, t] of options) {
                const option = el('option', '', t);
                option.value = v;
                control.append(option);
            }
            control.value = current;
            field.append(control);
            filters.append(field);
            control.addEventListener('change', () => { set(control.value); this.roomOffset = 0; void this.rooms(); });
        };
        select('密室格式', this.roomFormat, [['all', '全部格式'], ...Object.entries(formats)], v => this.roomFormat = v);
        select('密室状态', this.roomState, [['all', '全部状态'], ...Object.entries(states)], v => this.roomState = v);
        const submit = el('button', 'primary', '查询');
        submit.type = 'submit';
        filters.append(submit);
        filters.addEventListener('submit', e => { e.preventDefault(); this.roomQuery = input.value.trim(); this.roomOffset = 0; void this.rooms(); });
        host.append(filters);
        const list = table(['密室编号 / 格式', '状态', '已授权设备', '最近连接', '本人归档', '旧版有效备份']);
        for (const item of data.rooms) {
            const identity = el('div');
            identity.append(key(item.roomId, () => void this.detail(item.roomId)), el('small', 'cell-meta', formats[item.format] ?? '未知格式'));
            row(list.body, [identity, badge(states[item.state] ?? '未知', item.state === 'active' ? 'success' : 'muted'), item.devices, date(item.lastSeenAt), `${item.privateArchives} 个 · ${bytes(item.archiveBytes)}`, `${item.backups} 个`]);
        }
        host.append(list.wrapper);
        if (!data.rooms.length)
            host.append(emptyState('没有匹配的密室。可调整编号、格式或状态筛选。'));
        host.append(pagination({ page: this.roomOffset / 50 + 1, total: data.total, pageSize: 50, label: '密室分页', change: page => { this.roomOffset = (page - 1) * 50; void this.rooms(); } }));
        host.append(note('密室名称保存在参与者的加密本机目录中；后台通过编号定位。最近连接时间不代表正在阅读。'));
    }, this.rooms);
    detail = (id: string, tab = 'overview') => this.load<Detail>('密室详情', `/rooms/${encodeURIComponent(id)}`, (host, data) => {
        host.append(button('返回密室列表', this.rooms, 'back-link'), key(id));
        host.append(tabs([['overview', '概况'], ['devices', '设备与接入'], ['storage', '存储'], ['archives', '关联归档'], ['danger', '危险操作']].map(([value, label]) => ({ label: label!, active: tab === value, run: () => void this.detail(id, value) }))));
        if (tab === 'overview') {
            host.append(facts([['密室格式', formats[data.format] ?? '未知'], ['密室状态', badge(states[data.state] ?? '未知', data.state === 'active' ? 'success' : 'muted')], ['创建时间', date(data.createdAt)], ['最近连接', date(data.lastSeenAt)], ['已授权设备', data.devices.filter(d => d.status === 'active').length], ['待授权设备', data.pendingDevices], ['本人归档', `${data.privateArchives} 个`], ['自动备份开关', '仅本机可知']]));
            host.append(note('后台不读取聊天正文、私有密室名称、应用锁、恢复凭证或本机分类统计。'));
        }
        else if (tab === 'devices') {
            host.append(pageToolbar('设备与接入', `本人新增链接 ${data.pendingDeviceLinks} 个 · 接替链接 ${data.pendingRepairLinks} 个（有效未使用）`));
            const list = table(['参与方 / 设备', '授权状态', '最近连接']);
            for (const device of data.devices) {
                const identity = el('div');
                identity.append(el('strong', '', `${device.role === 'creator' ? '创建者' : '受邀者'} · ${device.name}`), key(device.deviceId));
                const labels: Record<string, [
                    string,
                    Tone
                ]> = { active: ['已授权', 'success'], pending: ['待授权', 'warning'], revoked: ['已撤销', 'muted'] };
                const state = labels[device.status] ?? ['未知', 'muted'];
                row(list.body, [identity, badge(...state), date(device.lastSeenAt)]);
            }
            host.append(list.wrapper, note('设备添加、接替和撤销由参与者完成。后台不生成邀请、不显示链接秘密、不绕过成员授权。'));
        }
        else if (tab === 'storage') {
            host.append(facts([['在线密文消息', `${data.messageCount} 条 · ${bytes(data.messageBytes)}`], ['消息保留窗口', data.windowEnabled ? `起始序号 ${data.windowFromSeq}` : '旧版保留规则'], ['附件预留及占用', bytes(data.attachmentBytes)], ['未完成附件', `${data.incompleteAttachments} 个`], ['本人归档密文', bytes(data.archiveBytes)]]), note('在线消息窗口、聊天附件和独立归档遵循各自保留规则。零消息或长期未活动不构成归档清理依据。'));
        }
        else if (tab === 'archives') {
            host.append(pageToolbar('新版独立本人归档', `${data.privateArchives} 个归档`));
            this.archiveTable(host, data.archives);
            const legacy = section('旧版恢复备份', '与上方新版归档分别统计。');
            legacy.append(facts([['旧版有效备份', `${data.backups.filter(b => b.active).length} 个`], ['旧版已备份聊天', data.backupChatCount], ['旧版已备份保险箱', data.backupGalleryCount]]));
            const backups = table(['设备编号', '状态 / 版本', '更新时间', '已备份聊天', '已备份保险箱', '恢复包 / 历史密文']);
            for (const backup of data.backups)
                row(backups.body, [key(backup.deviceId), `${backup.active ? '有效' : '已停用'} · v${backup.revision}`, date(backup.updatedAt), backup.chatCount, backup.galleryCount, `${bytes(backup.recoveryBytes)} / ${bytes(backup.historyBytes)}`]);
            legacy.append(backups.wrapper);
            host.append(legacy, button('查看此密室全部归档', () => { this.archiveQuery = id; this.archiveOffset = 0; void this.archives('new'); }, 'text-link'));
        }
        else
            this.cleanup(host, id, data);
    }, () => void this.detail(id, tab));
    private cleanup(host: HTMLElement, id: string, data: Detail) {
        const area = section('清理实时密室', '不可逆操作。先核对影响范围，再重新验证管理员身份。');
        area.classList.add('admin-danger-zone');
        area.append(facts([['将删除', '实时密室、设备授权、在线消息、关联密文附件及旧版恢复备份'], ['将保留', `新版独立本人归档 ${data.privateArchives} 个；独立灾备快照与设备离线副本`]]));
        const formHost = el('div');
        const open = button('准备清理', () => {
            open.hidden = true;
            const form = el('form', 'admin-cleanup-form');
            form.innerHTML = '<label>完整密室编号<input name="confirmRoomId" autocomplete="off" required></label><label>再次输入管理员密码<input name="password" type="password" autocomplete="current-password" required></label><label>新的动态验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><div class="actions"><button class="danger" type="submit">确认清理实时密室</button><button type="button" id="cancel-cleanup">取消</button></div>';
            const identifier = form.elements.namedItem('confirmRoomId') as HTMLInputElement;
            identifier.addEventListener('input', () => identifier.setCustomValidity(identifier.value === id ? '' : '请完整输入当前密室编号'));
            form.querySelector('#cancel-cleanup')!.addEventListener('click', () => { form.remove(); open.hidden = false; open.focus(); });
            form.addEventListener('submit', e => {
                e.preventDefault();
                if (identifier.value !== id)
                    return;
                const controls = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')];
                const values = new FormData(form);
                const body = { confirmRoomId: String(values.get('confirmRoomId')), password: String(values.get('password')), code: String(values.get('code')) };
                form.reset();
                controls.forEach(n => n.disabled = true);
                void this.c.api(`/rooms/${id}`, 'DELETE', body).then(() => {
                    if (form.isConnected) {
                        void this.rooms().then(() => this.c.report('实时密室已清理，新版独立归档继续保留。', 'success'));
                    }
                }).catch(error => {
                    if (form.isConnected) {
                        this.c.report(error);
                        controls.forEach(n => n.disabled = false);
                    }
                }).finally(() => { body.password = ''; body.code = ''; });
            });
            formHost.replaceChildren(form);
            identifier.focus();
        }, 'danger');
        area.append(open, formHost, note('超时或回执不明确时，先刷新查询密室与清理队列，确认结果后再操作。'));
        host.append(area);
    }
    private archiveTable(host: HTMLElement, items: Archive[]) {
        const list = table(['归档编号 / 参与方', '来源密室', '密文对象', '占用', '最近写入', '写入端']);
        for (const item of items) {
            const identity = el('div');
            identity.append(key(item.id, () => void this.archive(item.id)), el('small', 'cell-meta', item.role === 'creator' ? '创建者归档' : '受邀者归档'));
            const source = el('div');
            source.append(key(item.roomId, item.sourceExists ? () => void this.detail(item.roomId) : undefined), el('small', 'cell-meta', item.sourceExists ? '来源密室仍存在' : '来源密室已移除，归档保留'));
            row(list.body, [identity, source, item.objects, bytes(item.bytes), date(item.lastWrittenAt), badge(item.writerActive ? '仍获授权' : '当前不可写', item.writerActive ? 'success' : 'muted')]);
        }
        host.append(list.wrapper);
        if (!items.length)
            host.append(emptyState('暂无匹配的新版归档。此结果不代表本机没有聊天或旧版备份。'));
    }
    archives = (tab = this.archiveTab) => {
        this.archiveTab = tab;
        const route = tab === 'new' ? `/archives?offset=${this.archiveOffset}&roomId=${encodeURIComponent(this.archiveQuery)}&source=${this.archiveSource}` : '/diagnostics';
        return this.load<{
            archives: Archive[];
            total: number;
        } & Summary>('归档与备份', route, (host, data) => {
            host.append(tabs([['new', '本人归档'], ['legacy', '旧版恢复备份'], ['disaster', '服务器灾备']].map(([value, label]) => ({ label: label!, active: tab === value, run: () => void this.archives(value) }))));
            if (tab === 'new') {
                host.append(pageToolbar('独立本人归档', `${data.total} 个匹配结果`, { label: '刷新归档列表', icon: RefreshCw, run: () => void this.archives() }));
                const form = el('form', 'admin-filters');
                const field = el('label', 'admin-search', '来源密室编号');
                const input = el('input');
                input.value = this.archiveQuery;
                input.maxLength = 36;
                input.pattern = '[-0-9a-fA-F]*';
                input.placeholder = '完整编号或编号前缀';
                field.append(input);
                const status = el('label', '', '来源状态');
                const select = el('select');
                for (const [v, t] of [['all', '全部来源'], ['present', '来源密室仍存在'], ['removed', '来源密室已移除']]) {
                    const option = el('option', '', t);
                    option.value = v!;
                    select.append(option);
                }
                select.value = this.archiveSource;
                status.append(select);
                const submit = el('button', 'primary', '查询');
                submit.type = 'submit';
                form.append(field, status, submit);
                form.addEventListener('submit', e => { e.preventDefault(); this.archiveQuery = input.value.trim(); this.archiveSource = select.value; this.archiveOffset = 0; void this.archives(); });
                host.append(form);
                this.archiveTable(host, data.archives);
                host.append(pagination({ page: this.archiveOffset / 50 + 1, total: data.total, pageSize: 50, label: '归档分页', change: page => { this.archiveOffset = (page - 1) * 50; void this.archives(); } }), note('归档独立保留、没有自动到期时间。对象数不是消息数，也不证明备份完整；旧数据未记录的写入时间显示未知。'));
            }
            else if (tab === 'legacy') {
                const area = section('旧版恢复备份', '保留原有格式与恢复边界，不迁移、不转换。');
                area.append(facts([['有效旧版备份', data.legacyBackups], ['适用范围', '原 QR3／QR4 等旧格式'], ['详细记录', '在对应密室的关联归档中查看']]));
                host.append(area, button('按密室查找旧版备份', this.rooms, 'primary'), note('新版密室不使用旧版备份统计。管理员没有恢复码、密钥或代替用户恢复的入口。'));
            }
            else
                this.disaster(host, data.diagnostics.backup, data.diagnostics.checkedAt);
        }, () => void this.archives(tab));
    };
    archive = (id: string) => this.load<Archive>('归档详情', `/archives/${encodeURIComponent(id)}`, (host, data) => {
        host.append(button('返回归档列表', () => void this.archives('new'), 'back-link'), key(id), facts([['来源密室', key(data.roomId, data.sourceExists ? () => void this.detail(data.roomId) : undefined)], ['所属参与方', data.role === 'creator' ? '创建者' : '受邀者'], ['当前写入设备', key(data.deviceId)], ['写入端授权', badge(data.writerActive ? '仍获授权' : '当前不可写', data.writerActive ? 'success' : 'muted')], ['来源状态', data.sourceExists ? '密室仍存在' : '密室已移除，归档独立保留'], ['已保存密文对象', data.objects], ['密文占用', bytes(data.bytes)], ['记录创建时间', date(data.createdAt)], ['最近新增对象', date(data.lastWrittenAt)], ['本机自动备份开关', '后台不可读取'], ['完整恢复可用性', '需由用户在本机完整校验']]));
        host.append(note('后台不显示归档密文、读取令牌、恢复图、密码或解密材料，不提供独立归档删除入口。'));
    }, () => void this.archive(id));
    private disaster(host: HTMLElement, data: Backup, time: string) {
        this.stamp(host, time);
        const area = section('服务器灾备', '与本人历史归档独立，用于服务器数据恢复。');
        const labels: Record<string, string> = { NOT_CONNECTED: '未接入状态源', INVALID_RECEIPT: '回执无效或不可读', STALE_STATUS: '状态摘要已过期或无效', BACKUP_STATE_INVALID_OR_MISSING: '回执缺失或无效', BACKUP_STALE: '恢复点已过期', BACKUP_LAST_ATTEMPT_FAILED: '最近尝试失败', BACKUP_FRESH: '回执检查通过' };
        area.append(badge(labels[data.code] ?? '状态未知', !data.available ? 'muted' : data.healthy ? 'success' : 'warning'));
        if (data.available)
            area.append(facts([['状态采样于', date(data.sampledAt)], ['备份模式', data.destination === 'mac-pull' ? 'Mac 主动拉取' : '服务器本地模式'], ['恢复点创建于', date(data.snapshotCreatedAt)], ['独立验证完成于', date(data.lastVerifiedAt)], ['最近尝试', date(data.lastAttemptAt)], ['最近尝试结果', data.lastAttemptSucceeded ? '成功' : '失败或未知']]));
        else
            area.append(note('当前应用未取得可核验的灾备状态。需由受信任运维接入只读状态回执；页面不会据此判断灾备成功。'));
        area.append(note('回执健康不等于本轮重新扫描全部备份，也不代表完成恢复演练。后台不下载快照、不执行生产恢复。'));
        host.append(area);
    }
    diagnostics = () => this.load<Summary>('运维诊断', '/diagnostics', (host, data) => {
        this.stamp(host, data.diagnostics.checkedAt);
        host.append(pageToolbar('运行与容量', '', { label: '刷新运维诊断', icon: RefreshCw, run: this.diagnostics }));
        const layout = el('div', 'admin-overview-grid');
        const runtime = section('应用检查');
        runtime.append(facts([['数据库写入检查', badge(data.diagnostics.health.database ? '通过' : '失败', data.diagnostics.health.database ? 'success' : 'danger')], ['数据目录访问检查', badge(data.diagnostics.health.storage ? '通过' : '失败', data.diagnostics.health.storage ? 'success' : 'danger')], ['公开构建版本', data.diagnostics.releaseId ?? '未知'], ['当前 WebSocket 连接', data.diagnostics.services.webSocketConnections], ['通知服务', data.diagnostics.services.pushEnabled ? '已启用，送达未验证' : '未启用'], ['通话配置', data.diagnostics.services.calls.valid ? '格式校验通过，连通性未验证' : '配置校验失败'], ['TURN 中继配置', data.diagnostics.services.calls.relayConfigured ? '已配置，探测未接入' : '未配置']]));
        const capacity = section('存储与清理');
        capacity.append(usage('在线消息密文', data.messageBytes, data.limits.maxTotalMessageBytes), usage('附件预留及占用', data.attachmentBytes + data.cleanupBytes, data.limits.maxTotalStorageBytes), usage('本人归档密文', data.archiveBytes, data.limits.maxTotalStorageBytes), facts([['持久清理任务', data.cleanupPending], ['清理完成前预留', bytes(data.cleanupBytes)], ['未完成附件', data.incompleteAttachments], ['单密室消息上限', `${data.limits.maxMessagesPerRoom} 条 / ${bytes(data.limits.maxRoomMessageBytes)}`], ['单归档容量上限', bytes(data.limits.maxRoomStorageBytes)]]));
        layout.append(runtime, capacity);
        host.append(layout, note('容量显示应用额度，不代表主机磁盘剩余空间。该页不执行清理、重启、发布或生产恢复。'));
        this.disaster(host, data.diagnostics.backup, data.diagnostics.checkedAt);
    }, this.diagnostics);
    security = () => this.load<{
        events: {
            id: number;
            action: string;
            targetType: string;
            targetId: string | null;
            result: string;
            createdAt: string;
        }[];
        total: number;
    }>('安全与审计', `/events?offset=${this.auditOffset}&q=${encodeURIComponent(this.auditQuery)}`, (host, data) => {
        const area = section('管理员会话', '密码与动态验证码双重验证，首次登录后最长 7 天。');
        area.append(facts([['认证方式', '管理员密码 + TOTP'], ['会话绝对到期时间', '正在读取…'], ['敏感操作', '完整目标编号 + 再次验证密码和新动态码']]));
        const expiry = area.querySelectorAll('dd')[1]!;
        void this.c.api<{
            expiresAt: string;
        }>('/session').then(s => {
            if (expiry.isConnected)
                expiry.textContent = date(s.expiresAt);
        }).catch(() => {
            if (expiry.isConnected)
                expiry.textContent = '暂不可用';
        });
        host.append(area);
        const audit = section('管理操作记录', `${data.total} 条匹配记录。仅记录动作、目标、时间和结果。`);
        const form = el('form', 'admin-filters');
        const label = el('label', 'admin-search', '目标编号');
        const input = el('input');
        input.value = this.auditQuery;
        input.maxLength = 128;
        input.pattern = '[-A-Za-z0-9_]*';
        input.placeholder = '完整密室或资源编号';
        label.append(input);
        const submit = el('button', '', '查询');
        submit.type = 'submit';
        form.append(label, submit);
        form.addEventListener('submit', e => { e.preventDefault(); this.auditQuery = input.value.trim(); this.auditOffset = 0; void this.security(); });
        audit.append(form);
        const list = table(['时间', '操作', '目标', '结果']);
        const actions: Record<string, string> = { 'delete-room': '清理实时密室', 'expression-create': '新增表情资源', 'expression-update': '修改表情资源', 'expression-status': '调整上架状态', 'expression-delete': '删除表情资源', 'expression-item-delete': '删除合集原图', 'collection-start': '开始采集', 'collection-cancel': '取消采集', 'collection-retry': '重新采集' };
        for (const event of data.events)
            row(list.body, [date(event.createdAt), actions[event.action] ?? event.action, event.targetId ? key(event.targetId) : '未记录', badge(event.result === 'succeeded' ? '操作成功' : '已登记，清理结果另查', event.result === 'succeeded' ? 'success' : 'muted')]);
        audit.append(list.wrapper);
        if (!data.events.length)
            audit.append(emptyState('暂无匹配的管理操作记录。'));
        audit.append(pagination({ page: this.auditOffset / 50 + 1, total: data.total, pageSize: 50, label: '审计分页', change: page => { this.auditOffset = (page - 1) * 50; void this.security(); } }));
        host.append(audit, note('审计不记录密码、动态码、Cookie、请求正文、邀请或恢复材料。密码只保存不可逆哈希，后台不提供明文查看。'));
    }, this.security);
}
