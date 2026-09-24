import type { MessagePayload, MlsRetentionBoundary, Vault } from './types';
export const MESSAGE_WINDOW_CAPABILITY = 'message-window-v1';
export const MLS_WINDOW_MESSAGES = 128;
/** All projections (including gallery and read/deletion events) fail closed on loss. */
export function isWindowMessage(payload: MessagePayload): boolean {
  return ['text', 'image', 'image-album', 'file', 'audio'].includes(payload.kind);
}
export function retentionBoundary(vault: Vault): MlsRetentionBoundary {
  const window = vault.mls?.window;
  return { v: 1, fromSeq: window?.fromSeq ?? vault.lastSeq + 1, afterSeq: vault.lastSeq,
    controls: [...(window?.controls ?? [])] };
}
export function validRetentionBoundary(value: unknown): value is MlsRetentionBoundary {
  if (!value || typeof value !== 'object') return false;
  const b = value as MlsRetentionBoundary;
  return b.v === 1 && Number.isSafeInteger(b.fromSeq) && b.fromSeq >= 1 &&
    Number.isSafeInteger(b.afterSeq) && b.afterSeq >= b.fromSeq - 1 && b.afterSeq - b.fromSeq < MLS_WINDOW_MESSAGES &&
    Array.isArray(b.controls) && b.controls.length <= MLS_WINDOW_MESSAGES &&
    b.controls.every((seq, i) => Number.isSafeInteger(seq) && seq >= b.fromSeq && seq <= b.afterSeq && (i === 0 || seq > b.controls[i - 1]!));
}
export function maySkipWindowMessage(boundary: MlsRetentionBoundary, seq: number): boolean {
  return validRetentionBoundary(boundary) && seq >= boundary.fromSeq && seq <= boundary.afterSeq && !boundary.controls.includes(seq);
}

export function expiredMessage(vault: Vault, seq: number): boolean {
  return Boolean(vault.expiredMessageRanges?.some(([from, through]) => seq >= from && seq <= through));
}
export function appendExpiredRange(vault: Vault, from: number, through: number): void {
  const ranges = [...(vault.expiredMessageRanges ?? [])].map(pair => [...pair] as [number, number]);
  const last = ranges.at(-1);
  if (last && last[1] + 1 === from) last[1] = through;
  else ranges.push([from, through]);
  if (ranges.length > 4096) throw new Error('本机历史缺口记录已达到安全上限，需要修复设备');
  vault.expiredMessageRanges = ranges;
}
