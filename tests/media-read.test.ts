import { describe, expect, it } from 'vitest';
import { mediaReadTimes } from '../src/lib/media-read';
import { isMessagePayload } from '../src/lib/message-payload';
import type { DecryptedMessage, ImageManifest, MediaReadPayload, RoomMember } from '../src/lib/types';

const owner = crypto.randomUUID();
const linked = crypto.randomUUID();
const peer = crypto.randomUUID();
const roles = new Map<string, RoomMember['role']>([[owner, 'creator'], [linked, 'creator'], [peer, 'joiner']]);
const time = '2026-09-10T08:00:00.000Z';
const original: DecryptedMessage = { seq: 1, clientMsgId: crypto.randomUUID(), senderId: owner,
  payload: { v: 1, kind: 'image', image: {} as ImageManifest, sentAt: time }, acceptedAt: time, status: 'delivered' };
const payload: MediaReadPayload = { v: 1, kind: 'media-read', sentAt: time,
  target: { clientMsgId: original.clientMsgId, serverSeq: 1, senderId: owner } };
const read: DecryptedMessage = { seq: 2, clientMsgId: crypto.randomUUID(), senderId: peer, payload, acceptedAt: time, status: 'stored' };

describe('encrypted media read projection', () => {
  it('requires an exact bounded target and rejects extra metadata', () => {
    expect(isMessagePayload(payload)).toBe(true);
    expect(isMessagePayload({ ...payload, visible: true })).toBe(false);
    expect(isMessagePayload({ ...payload, target: { ...payload.target, serverSeq: 0 } })).toBe(false);
    expect(isMessagePayload({ ...payload, target: { ...payload.target, preview: 'secret' } })).toBe(false);
  });
  it('applies to expressions, albums and videos but excludes ordinary files', () => {
    const image = {} as ImageManifest;
    const payloads: DecryptedMessage['payload'][] = [
      { v: 1, kind: 'image', image, presentation: 'expression', sentAt: time },
      { v: 1, kind: 'image-album', images: [image, image], sentAt: time },
      { v: 1, kind: 'file', file: { ...image, mimeType: 'video/mp4', originalName: 'video.mp4' }, sentAt: time },
    ];
    for (const media of payloads) expect(mediaReadTimes([{ ...original, payload: media }, read], roles).size).toBe(1);
    expect(mediaReadTimes([{ ...original, payload: { v: 1, kind: 'file', file: { ...image, mimeType: 'application/pdf', originalName: 'file.pdf' }, sentAt: time } }, read], roles).size).toBe(0);
  });
  it('never treats delivery or an own linked device as peer read', () => {
    expect(mediaReadTimes([original], roles).size).toBe(0);
    expect(mediaReadTimes([original, { ...read, senderId: linked }], roles).size).toBe(0);
    expect(mediaReadTimes([original, { ...read, senderId: crypto.randomUUID() }], roles).size).toBe(0);
  });
  it('keeps earliest confirmed read across replay, devices and timestamp payload skew', () => {
    const later = { ...read, seq: 3, acceptedAt: '2026-09-10T08:01:00.000Z', payload: { ...payload, sentAt: '2099-01-01T00:00:00Z' } };
    expect(mediaReadTimes([later, original, read, read], roles).get(original.clientMsgId)).toBe(Date.parse(time));
  });
  it('rejects mismatched, missing, future and pending targets/events', () => {
    for (const invalid of [
      { ...read, status: 'pending' as const }, { ...read, seq: 1 },
      { ...read, acceptedAt: 'invalid' },
      { ...read, payload: { ...payload, target: { ...payload.target, clientMsgId: crypto.randomUUID() } } },
      { ...read, payload: { ...payload, target: { ...payload.target, senderId: linked } } },
    ]) expect(mediaReadTimes([original, invalid], roles).size).toBe(0);
    expect(mediaReadTimes([read], roles).size).toBe(0);
    expect(mediaReadTimes([{ ...original, payload: { v: 1, kind: 'text', text: 'text', sentAt: time } }, read], roles).size).toBe(0);
  });
});
