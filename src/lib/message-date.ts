import { currentLanguage } from './language';
/** Calendar labels follow the viewing device, without changing message order. */
export function messageLocalDay(value: string, currentYear: number): { key: string; label: string; description: string } | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return {
    key: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    label: new Intl.DateTimeFormat(currentLanguage(), { ...(year === currentYear ? {} : { year: 'numeric' as const }), month: 'long', day: 'numeric' }).format(date),
    description: new Intl.DateTimeFormat(currentLanguage(), { year: 'numeric', month: 'long', day: 'numeric' }).format(date),
  };
}
