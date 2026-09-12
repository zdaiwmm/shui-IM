import type { MessagePayload } from './types';
import starters from './starter-library.json';

const shippedDigests = new Set(starters.packs.flatMap(pack => pack.items.map(item => item.digest)));

/** Older clients sent bundled expressions as ordinary images without a marker. */
export function isExpressionPayload(payload: MessagePayload): boolean {
  return payload.kind === 'image' && (payload.presentation === 'expression' || payload.presentation === 'expression-hidden' || shippedDigests.has(payload.image.sha256));
}
