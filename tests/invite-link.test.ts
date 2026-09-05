import { describe, expect, it } from 'vitest';
import {
  classifyInviteHash,
  makeDeviceInviteUrl,
  makeParticipantInviteUrl,
  parseInviteText,
  type DeviceInvite,
  type ParticipantInvite,
} from '../src/lib/invite-link';

const baseUrl = 'https://ai.shui.click/quiet-room?ignored=query#old=value';
const roomId = '2f1f11e8-b67f-42c6-908a-6d47d504653d';
const creatorFingerprint = 'F'.repeat(43);

function participant(overrides: Partial<ParticipantInvite> = {}): ParticipantInvite {
  return {
    v: 1,
    roomId,
    accessToken: 'A'.repeat(43),
    pairingSecret: 'B'.repeat(43),
    creatorFingerprint,
    ...overrides,
  };
}

function device(overrides: Partial<DeviceInvite> = {}): DeviceInvite {
  return {
    v: 1,
    kind: 'device-link',
    roomId,
    linkId: '97b73cb5-123a-42ef-8dfa-6ffef5cd7911',
    secret: 'C'.repeat(43),
    role: 'creator',
    authorizerId: '57d2967a-c464-4b61-8852-15b096f9a93d',
    authorizerFingerprint: 'D'.repeat(43),
    creatorFingerprint,
    expiresAt: '2026-09-05T12:34:56.000Z',
    ...overrides,
  };
}

describe('invite-link', () => {
  it('keeps consecutive device-link serializations distinct', () => {
    const first = device();
    const second = device({
      linkId: 'c7bf9b9c-92eb-4a87-9b98-e41de18f30a3',
      secret: 'E'.repeat(43),
      expiresAt: '2026-09-05T12:35:56.000Z',
    });
    const firstUrl = makeDeviceInviteUrl(first, baseUrl);
    const secondUrl = makeDeviceInviteUrl(second, baseUrl);

    expect(firstUrl).not.toBe(secondUrl);
    expect(firstUrl).toMatch(/^https:\/\/ai\.shui\.click\/quiet-room#device=/);
    expect(secondUrl).toMatch(/^https:\/\/ai\.shui\.click\/quiet-room#device=/);
    expect(parseInviteText(firstUrl, baseUrl)).toEqual({ kind: 'device', invite: first });
    expect(parseInviteText(secondUrl, baseUrl)).toEqual({ kind: 'device', invite: second });
  });

  it('never classifies a participant invite as a device link', () => {
    const invite = participant();
    const url = makeParticipantInviteUrl(invite, baseUrl);

    expect(url).toMatch(/^https:\/\/ai\.shui\.click\/quiet-room#invite=/);
    expect(parseInviteText(url, baseUrl)).toEqual({ kind: 'participant', invite });
    expect(classifyInviteHash(new URL(url).hash).kind).toBe('participant');
  });

  it('rejects hashes containing both invite kinds, duplicate parameters, or unrelated fields', () => {
    const participantHash = new URL(makeParticipantInviteUrl(participant(), baseUrl)).hash.slice(1);
    const deviceHash = new URL(makeDeviceInviteUrl(device(), baseUrl)).hash.slice(1);

    expect(classifyInviteHash(`#${participantHash}&${deviceHash}`)).toEqual({ kind: 'invalid' });
    expect(classifyInviteHash(`#${deviceHash}&${participantHash}`)).toEqual({ kind: 'invalid' });
    expect(classifyInviteHash(`#${deviceHash}&${deviceHash}`)).toEqual({ kind: 'invalid' });
    expect(classifyInviteHash(`#tracking=x&${deviceHash}`)).toEqual({ kind: 'invalid' });
  });

  it('fails closed for malformed encodings, JSON shapes, and URL schemes', () => {
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(classifyInviteHash('')).toEqual({ kind: 'invalid' });
    expect(classifyInviteHash('#device=%%%')).toEqual({ kind: 'invalid' });
    expect(classifyInviteHash(`#device=${encoded([])}`)).toEqual({ kind: 'invalid' });
    expect(classifyInviteHash(`#invite=${encoded({ ...participant(), debug: true })}`)).toEqual({ kind: 'invalid' });
    expect(classifyInviteHash(`#device=${encoded({ ...device(), debug: true })}`)).toEqual({ kind: 'invalid' });
    expect(parseInviteText(`javascript:#device=${encoded(device())}`, baseUrl)).toEqual({ kind: 'invalid' });
    expect(parseInviteText('not a valid invitation', baseUrl)).toEqual({ kind: 'invalid' });
  });

  it('strictly validates field types, UUIDs, bounded secrets, fingerprints, roles, and timestamps', () => {
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const classifyParticipant = (value: unknown) => classifyInviteHash(`#invite=${encoded(value)}`);
    const classifyDevice = (value: unknown) => classifyInviteHash(`#device=${encoded(value)}`);

    for (const invalid of [
      { ...participant(), v: '1' },
      { ...participant(), roomId: 'not-a-uuid' },
      { ...participant(), roomId: '2f1f11e8-b67f-12c6-908a-6d47d504653d' },
      { ...participant(), accessToken: 'A'.repeat(31) },
      { ...participant(), accessToken: 'A'.repeat(513) },
      { ...participant(), pairingSecret: 'not base64url!' },
      { ...participant(), creatorFingerprint: 'F'.repeat(42) },
    ]) expect(classifyParticipant(invalid)).toEqual({ kind: 'invalid' });

    for (const invalid of [
      { ...device(), kind: 'participant-link' },
      { ...device(), linkId: 'not-a-uuid' },
      { ...device(), authorizerId: '57d2967a-c464-1b61-8852-15b096f9a93d' },
      { ...device(), secret: 123 },
      { ...device(), secret: 'C'.repeat(31) },
      { ...device(), role: 'peer' },
      { ...device(), authorizerFingerprint: 'D'.repeat(44) },
      { ...device(), expiresAt: '2026-09-05 12:34:56Z' },
      { ...device(), expiresAt: 'not-a-date' },
    ]) expect(classifyDevice(invalid)).toEqual({ kind: 'invalid' });
  });

  it('rejects invalid values when making URLs instead of serializing them', () => {
    expect(() => makeParticipantInviteUrl({ ...participant(), accessToken: '' }, baseUrl)).toThrow('Invalid participant invite');
    expect(() => makeDeviceInviteUrl({ ...device(), expiresAt: 'invalid' }, baseUrl)).toThrow('Invalid device invite');
    expect(() => makeDeviceInviteUrl(device(), 'file:///tmp/index.html')).toThrow('Invalid base URL');
  });
});
