import './room-analytics.css';
import { badge, emptyState, row, table } from './ui';

export type RoomAnalyticsPeriod = 7 | 30 | 90;
export type RoomAnalyticsScope = 'stock' | 'cohort';
type StateCounts = {
  waiting: number;
  none: number;
  creator: number;
  guest: number;
  both: number;
  unknown: number;
};
type DateRange = { start: string; end: string };
type RetentionRate = { eligible: number; returned: number; todayDue: number; todayReturned: number };
export type RoomAnalyticsReport = DateRange & {
  period: RoomAnalyticsPeriod;
  at: string;
  stock: { waiting: number; joined: number; closed: number };
  activity: { created: number; joined: number; active: number; bilateralActive: number; partial: boolean };
  join24: { joined: number; pending: number };
  medianJoinMinutes: number | null;
  funnel: { created: number; joined: number; firstMessage: number; bilateral: number; pending: number; unknown: number };
  states: { stock: StateCounts; cohort: StateCounts };
  retention: Array<DateRange & { activated: number; d1: RetentionRate; d7: RetentionRate; d30: RetentionRate }>;
  trend: Array<DateRange & { created: number; closed: number }>;
  features: { attachments: number; multiDeviceSeats: number; pushSeats: number; backupSeats: number };
};

const periods: readonly RoomAnalyticsPeriod[] = [7, 30, 90];
const stateLabels: ReadonlyArray<[keyof StateCounts, string]> = [
  ['waiting', '等待受邀方加入'],
  ['none', '双方已加入 · 零消息'],
  ['creator', '仅创建方发过'],
  ['guest', '仅受邀方发过'],
  ['both', '双方都发过'],
  ['unknown', '历史未知'],
];
const numberFormat = new Intl.NumberFormat('zh-CN');
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function node<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', text?: string) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function number(value: number) {
  return numberFormat.format(value);
}

function percent(value: number, total: number) {
  return percentFormat.format(value / total);
}

function dateRange({ start, end }: DateRange) {
  return start === end ? start : `${start} 至 ${end}`;
}

function shortRange(range: DateRange) {
  const short = (date: string) => date.slice(5).replace('-', '/');
  if (range.start === range.end) return short(range.start);
  return `${short(range.start)}–${short(range.end)}`;
}

function choices(groupLabel: string) {
  const group = node('div', 'analytics-choices');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', groupLabel);
  return group;
}

function choice(label: string, selected: boolean) {
  const button = node('button', '', label);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(selected));
  return button;
}

function panel(title: string, subtitle: string) {
  const section = node('section', 'analytics-panel');
  const heading = node('header', 'analytics-panel-heading');
  const text = node('div');
  text.append(node('h2', '', title), node('p', 'analytics-note', subtitle));
  heading.append(text);
  section.append(heading);
  return { section, heading };
}

function definitions() {
  const details = node('details', 'analytics-definitions');
  const summary = node('summary', '', '指标口径');
  const terms = node('dl');
  const rows = [
    ['真实加入', '每间密室完成首次受邀加入时计一个席位。多设备接入和恢复另计。'],
    ['新建密室转化', '以所选日期内的全部新建密室为分母，进度截至查询快照。双方在受邀方加入后均成功发过消息，且发生在创建后 7 天内，计为双向。'],
    ['24 小时加入率', '以同批新建密室为分母，在创建后 24 小时内首次加入即计入。观察期内尚未达成的密室单列。'],
    ['活跃和留存', '按北京时间统计。以受邀方加入后的首次成功发送为第 0 天，回访日结束后计入正式留存率。回访日为今天时单独展示进度。'],
    ['历史覆盖', '消息以服务端已接收的聊天记录计数。同一发送的重试只计一次。缺少早期记录时，聊天状态可能显示历史未知。'],
  ];
  for (const [term, detail] of rows) terms.append(node('dt', '', term), node('dd', '', detail));
  details.append(summary, terms);
  details.addEventListener('keydown', event => {
    if (event.key === 'Escape' && details.open) {
      details.open = false;
      summary.focus();
    }
  });
  return details;
}

function overview(report: RoomAnalyticsReport) {
  const { stock, activity, join24, funnel, medianJoinMinutes } = report;
  const totals = node('dl', 'analytics-overview');
  totals.setAttribute('aria-label', '关键指标');
  const partial = activity.partial ? '≥ ' : '';
  const lowerBound = funnel.unknown ? '≥ ' : '';
  const bilateral = funnel.created ? `${lowerBound}${percent(funnel.bilateral, funnel.created)}` : '—';
  const bilateralNote = funnel.created ? [
    `已双向 ${lowerBound}${number(funnel.bilateral)} / ${number(funnel.created)} 间`,
    funnel.pending ? `${number(funnel.pending)} 间观察中` : '',
    funnel.unknown ? `${number(funnel.unknown)} 间历史未知` : '',
  ].filter(Boolean).join(' · ') : '所选日期内暂无新建密室';
  const joinDetails = [
    funnel.created ? `24 小时加入率 ${percent(join24.joined, funnel.created)}` : '暂无新建密室可计算 24 小时加入率',
    join24.pending ? `${number(join24.pending)} 间观察中` : '',
    medianJoinMinutes === null ? '' : `期间加入耗时中位数 ${number(medianJoinMinutes)} 分钟`,
  ].filter(Boolean).join(' · ');
  const metrics = [
    ['新建密室 7 天双向率', bilateral, bilateralNote],
    ['密室存量', number(stock.waiting + stock.joined + stock.closed), `等待 ${number(stock.waiting)} · 已加入 ${number(stock.joined)} · 关闭 ${number(stock.closed)}`],
    ['期间受邀方成功加入', number(activity.joined), joinDetails],
    ['消息活跃密室', `${partial}${number(activity.active)}`, `期间有成功发送 · 双方均发过 ${partial}${number(activity.bilateralActive)} 间${activity.partial ? ' · 仅计可核实记录' : ''}`],
  ];
  for (const [title, value, detail] of metrics) {
    const metric = node('div', 'analytics-metric');
    metric.append(node('dt', '', title), node('dd', '', value), node('dd', 'analytics-note', detail));
    totals.append(metric);
  }
  return totals;
}

function funnelPanel(report: RoomAnalyticsReport) {
  const { funnel } = report;
  const { section } = panel('新建密室转化', '所选日期内新建 · 截至快照统计 7 天内达成进度');
  if (!funnel.created) {
    section.append(emptyState('所选日期内暂无新建密室'));
  } else {
    const list = node('ol', 'analytics-funnel');
    const steps = [
      { label: '创建成功', count: funnel.created, partial: false },
      { label: '受邀方加入', count: funnel.joined, partial: false },
      { label: '出现首条消息', count: funnel.firstMessage, partial: funnel.unknown > 0 },
      { label: '双方都发过', count: funnel.bilateral, partial: funnel.unknown > 0 },
    ];
    for (const { label, count, partial } of steps) {
      const item = node('li');
      const track = node('span', 'analytics-track');
      track.setAttribute('aria-hidden', 'true');
      const fill = node('span');
      fill.style.width = `${count / funnel.created * 100}%`;
      track.append(fill);
      const prefix = partial ? '≥ ' : '';
      item.append(node('span', '', label), track,
        node('strong', '', `${prefix}${number(count)}`),
        node('span', 'analytics-note', `${prefix}${percent(count, funnel.created)}`));
      list.append(item);
    }
    section.append(list);
    if (funnel.pending) {
      section.append(node('p', 'analytics-note', `${number(funnel.pending)} 间尚未双向，仍在 7 天观察期内。`));
    }
    if (funnel.unknown) section.append(node('p', 'analytics-note', '消息步骤仅展示可核实的下限。'));
  }
  return section;
}

function statePanel(report: RoomAnalyticsReport, initialScope: RoomAnalyticsScope,
  changeScope: (scope: RoomAnalyticsScope) => void) {
  const { section, heading } = panel('聊天状态', '按密室中实际发过消息的参与方统计');
  const group = choices('聊天状态范围');
  const current = choice('当前存量', true);
  const cohort = choice('满 7 天批次', false);
  group.append(current, cohort);
  heading.append(group);
  const results = node('div');
  results.setAttribute('aria-live', 'polite');
  section.append(results);

  function show(mode: RoomAnalyticsScope) {
    changeScope(mode);
    const values = report.states[mode];
    const total = stateLabels.reduce((sum, [key]) => sum + values[key], 0);
    current.setAttribute('aria-pressed', String(mode === 'stock'));
    cohort.setAttribute('aria-pressed', String(mode === 'cohort'));
    if (!total) {
      results.replaceChildren(emptyState(mode === 'stock' ? '暂无未关闭密室' : '暂无满 7 天的新建批次'));
      return;
    }
    const chart = node('div', 'analytics-stacked');
    chart.setAttribute('aria-hidden', 'true');
    const list = node('ul', 'analytics-states');
    for (const [key, label] of stateLabels) {
      const count = values[key];
      if (count) {
        const segment = node('span', `analytics-swatch-${key}`);
        segment.style.flex = String(count);
        chart.append(segment);
      }
      const item = node('li');
      const swatch = node('span', `analytics-swatch analytics-swatch-${key}`);
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, node('span', '', label), node('strong', '', number(count)),
        node('span', 'analytics-note', percent(count, total)));
      list.append(item);
    }
    const scope = mode === 'stock' ? '当前未关闭密室' : '创建后第 7 天的状态';
    results.replaceChildren(node('p', 'analytics-note', `${scope} · 共 ${number(total)} 间`), chart, list);
  }
  current.addEventListener('click', () => show('stock'));
  cohort.addEventListener('click', () => show('cohort'));
  show(initialScope);
  return section;
}

function retentionPanel(report: RoomAnalyticsReport) {
  const { section } = panel('密室消息留存', '按所选期间内受邀方加入后的首次成功发送日期分组');
  const coverage = node('p', 'analytics-note', '回访日结束后计入正式留存率。今天的回访进度单列。统计限于可核实的消息历史。');
  const cohorts = report.retention.filter(item => item.activated > 0);
  if (!cohorts.length) {
    section.append(emptyState('所选期间暂无可核实的首次发送批次'), coverage);
    return section;
  }
  const { wrapper, body } = table(['首次发送批次', '密室', '第 1 天', '第 7 天', '第 30 天']);
  wrapper.classList.add('analytics-retention');
  for (const item of cohorts) {
    const range = node('span', '', shortRange(item));
    range.title = dateRange(item);
    const metrics = [item.d1, item.d7, item.d30].map(({ eligible, returned, todayDue, todayReturned }) => {
      const result = node('div');
      if (eligible) {
        const rate = node('span', 'analytics-rate', percent(returned, eligible));
        rate.title = `${number(returned)} / ${number(eligible)} 间`;
        rate.setAttribute('aria-label', `${rate.textContent}，${rate.title}`);
        result.append(rate);
      } else if (!todayDue) {
        result.append(node('span', 'analytics-note', '观察中'));
      }
      if (todayDue) {
        result.append(node('p', 'analytics-note', `今日回访 ${number(todayReturned)} / ${number(todayDue)}`));
      }
      return result;
    });
    row(body, [range, number(item.activated), ...metrics]);
  }
  section.append(wrapper, coverage);
  return section;
}

function featurePanel({ features }: RoomAnalyticsReport) {
  const { section } = panel('功能使用', '按密室、参与方席位或操作结果统计');
  const { wrapper, body } = table(['功能', '指标', '数据状态']);
  const featureRows = [
    ['附件与媒体', `${number(features.attachments)} 间密室有可核实的附件上传完成记录`, badge('可汇总', 'success')],
    ['多设备', `当前 ${number(features.multiDeviceSeats)} 个席位有至少两台授权设备`, badge('可汇总', 'success')],
    ['推送', `当前 ${number(features.pushSeats)} 个席位有有效订阅`, badge('可汇总', 'success')],
    ['备份与恢复', `当前 ${number(features.backupSeats)} 个席位已有备份 · 备份与恢复成功率待采集`, badge('部分可汇总', 'success')],
    ['语音与视频通话', '发起数、接通率 · 有通话但零消息的密室', badge('待采集', 'warning')],
    ['保险箱与隐私', '保险箱、收藏、遮蔽及应用锁使用', badge('待确认')],
  ] as const;
  for (const [name, metric, status] of featureRows) row(body, [name, metric, status]);
  section.append(wrapper);
  return section;
}

function trendPanel({ trend }: RoomAnalyticsReport) {
  const { section, heading } = panel('新建与关闭趋势', '关闭仅统计有可核实时间、目前仍关闭的密室');
  const legend = node('div', 'analytics-legend');
  const legendLabels = [['created', '新建'], ['closed', '关闭']] as const;
  for (const [key, label] of legendLabels) {
    const swatch = node('span', `analytics-swatch analytics-swatch-${key}`);
    swatch.setAttribute('aria-hidden', 'true');
    const item = node('span');
    item.append(swatch, document.createTextNode(label));
    legend.append(item);
  }
  heading.append(legend);
  if (!trend.length) {
    section.append(emptyState('所选期间暂无密室趋势'));
    return section;
  }
  const list = node('ul', 'analytics-trend');
  const max = Math.max(1, ...trend.map(item => Math.max(item.created, item.closed)));
  for (const item of trend) {
    const segment = node('li');
    const columns = node('div', 'analytics-columns');
    columns.setAttribute('aria-hidden', 'true');
    for (const [count, mode] of [[item.created, 'created'], [item.closed, 'closed']] as const) {
      const bar = node('span', `analytics-swatch-${mode}`);
      bar.style.height = `${count / max * 100}%`;
      columns.append(bar);
    }
    const values = node('strong', '', `${number(item.created)} / ${number(item.closed)}`);
    values.setAttribute('aria-label', `新建 ${number(item.created)} 间，关闭 ${number(item.closed)} 间`);
    const range = node('span', 'analytics-note', shortRange(item));
    range.title = dateRange(item);
    segment.append(columns, values, range);
    list.append(segment);
  }
  section.append(list);
  return section;
}

export function renderRoomAnalytics(host: HTMLElement, report: RoomAnalyticsReport,
  changePeriod: (period: RoomAnalyticsPeriod, scope: RoomAnalyticsScope) => void,
  initialScope: RoomAnalyticsScope = 'stock') {
  let scope = initialScope;
  const dashboard = node('div', 'room-analytics');
  const toolbar = node('header', 'analytics-toolbar');
  const label = node('p', 'analytics-note', `mijiu.cloud · ${dateRange(report)} · 北京时间`);
  const controls = node('div', 'analytics-controls');
  const periodChoices = choices('统计日期');
  for (const period of periods) {
    const button = choice(`近 ${period} 天`, report.period === period);
    button.addEventListener('click', () => {
      if (period !== report.period) changePeriod(period, scope);
    });
    periodChoices.append(button);
  }
  controls.append(periodChoices, definitions());
  toolbar.append(label, controls);
  const main = node('div', 'analytics-grid');
  main.append(funnelPanel(report), statePanel(report, scope, next => { scope = next; }));
  const secondary = node('div', 'analytics-grid analytics-grid-secondary');
  secondary.append(retentionPanel(report), featurePanel(report));
  const checkedAt = timeFormat.format(new Date(report.at));
  const footer = node('footer', 'analytics-footer analytics-note', `密室业务服务汇总 · 快照 ${checkedAt} · Lead 访客流量独立查看`);
  dashboard.append(toolbar, overview(report), main, secondary, trendPanel(report), footer);
  host.append(dashboard);
}
