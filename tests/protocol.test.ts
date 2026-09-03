import { describe, expect, it } from 'vitest';
import { validateEnvelopeShape, validateMlsWelcomeShape } from '../server/protocol.mjs';

describe('opaque production protocol shapes', () => {
  it('accepts bounded MLS ciphertext and rejects plaintext-shaped fields', () => {
    const roomId = crypto.randomUUID();
    const envelope = {
      v: 2,
      protocol: 'mls-rfc9420',
      roomId,
      clientMsgId: crypto.randomUUID(),
      senderId: crypto.randomUUID(),
      ciphertext: 'A'.repeat(64),
      signature: 'B'.repeat(64),
    };
    expect(validateEnvelopeShape(envelope, roomId)).toBe(true);
    expect(validateEnvelopeShape({ ...envelope, text: 'must never be accepted', ciphertext: '' }, roomId)).toBe(false);
  });

  it('binds an MLS welcome to one creator, recipient and room', () => {
    const roomId = crypto.randomUUID();
    const welcome = {
      v: 1,
      protocol: 'mls-rfc9420',
      roomId,
      senderId: crypto.randomUUID(),
      recipientId: crypto.randomUUID(),
      welcome: 'A'.repeat(128),
      signature: 'B'.repeat(64),
    };
    expect(validateMlsWelcomeShape(welcome, roomId)).toBe(true);
    expect(validateMlsWelcomeShape({ ...welcome, recipientId: welcome.senderId }, roomId)).toBe(false);
  });
});
