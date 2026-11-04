import { currentLanguage } from './language';
export function messageTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(currentLanguage(), { hour: '2-digit', minute: '2-digit' }).format(date);
}

export { messageLocalDay } from './chat-timeline-days';
