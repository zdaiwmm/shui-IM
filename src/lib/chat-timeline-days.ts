import { currentLanguage } from './language';

/** Calendar labels follow the viewing device, without changing message order. */
export function messageLocalDay(value: string, currentYear: number, existingDays?: ReadonlySet<string>): { key: string; label: string; description: string } | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (existingDays?.has(key)) return null;
  return {
    key,
    label: new Intl.DateTimeFormat(currentLanguage(), { ...(year === currentYear ? {} : { year: 'numeric' as const }), month: 'long', day: 'numeric' }).format(date),
    description: new Intl.DateTimeFormat(currentLanguage(), { year: 'numeric', month: 'long', day: 'numeric' }).format(date),
  };
}

/** Reuse separator nodes across renders, but emit each local day once in this pass. */
export function createTimelineDateAppender(timeline: HTMLElement[], days: Set<string>, cached: Map<string, HTMLElement>) {
  const currentYear = new Date().getFullYear();
  return (sentAt: string) => {
    const day = messageLocalDay(sentAt, currentYear, days);
    if (!day) return;
    days.add(day.key);
    let separator = cached.get(day.key);
    if (!separator) {
      separator = document.createElement('div');
      separator.className = 'message-date';
      separator.dataset.dateKey = day.key;
      separator.setAttribute('role', 'heading');
      separator.setAttribute('aria-level', '3');
      const time = document.createElement('time');
      time.dateTime = day.key;
      separator.append(time);
      cached.set(day.key, separator);
    }
    separator.setAttribute('aria-label', day.description);
    if (separator.firstChild!.textContent !== day.label) separator.firstChild!.textContent = day.label;
    timeline.push(separator);
  };
}
