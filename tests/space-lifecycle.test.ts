import { describe, expect, it } from 'vitest';
import { formatPendingCountdown, pendingSpaceExpiry, PENDING_SPACE_TTL_MS } from '../src/lib/spaces';
import { capabilityGateMembers } from '../src/lib/member-capabilities';
import { mergeCatalogSpaces, type AccessSpace } from '../src/lib/browser-access';
import type { RoomMember } from '../src/lib/types';

const member = (patch: Partial<RoomMember>): RoomMember => ({
  deviceId: '11111111-1111-1111-1111-111111111111',
  role: 'creator',
  encryptionKey: { kty: 'EC' },
  signingKey: { kty: 'EC' },
  joinProof: null,
  status: 'active',
  createdAt: '2026-09-23T00:00:00.000Z',
  ...patch,
});

describe('waiting space lifetime', () => {
  it('expires one hour after creation and formats the remaining time', () => {
    const createdAt = '2026-09-23T03:00:00.000Z';
    const expiry = pendingSpaceExpiry({ waiting: true, createdAt });
    expect(expiry).toBe(Date.parse(createdAt) + PENDING_SPACE_TTL_MS);
    expect(pendingSpaceExpiry({ waiting: false, createdAt })).toBeNull();
    expect(formatPendingCountdown(61_000)).toBe('01:01');
    expect(formatPendingCountdown(0)).toBe('00:00');
  });
});

describe('capability gate', () => {
  it('does not let a newly authorized device that has never opened chat block the others', () => {
    const existing = member({ capabilities: ['voice-message-v1'], lastSeenAt: '2026-09-23T03:10:00.000Z' });
    const fresh = member({ deviceId: '22222222-2222-2222-2222-222222222222', capabilities: [] });
    expect(capabilityGateMembers([existing, fresh])).toEqual([existing]);
    expect(capabilityGateMembers([existing, member({ deviceId: '33333333-3333-3333-3333-333333333333', capabilities: ['voice-message-v1'] })])).toHaveLength(2);
    expect(capabilityGateMembers([existing, member({ deviceId: '44444444-4444-4444-4444-444444444444', capabilities: [], lastSeenAt: '2026-09-23T03:20:00.000Z' })])).toHaveLength(2);
  });
});

describe('private space catalog merge', () => {
  const room = (id: string, name: string, extra: Partial<AccessSpace> = {}): AccessSpace => ({
    roomId: id, name, ...extra,
  });
  const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('keeps each participant device’s spaces and drops only explicit removals', () => {
    const remote = [room(a, '甲', { waiting: true, createdAt: '2026-09-23T03:00:00.000Z' })];
    const local = [room(b, '乙', { createdAt: '2026-09-23T04:00:00.000Z' }), room(a, '甲改名')];
    const merged = mergeCatalogSpaces(remote, local, []);
    expect(merged.map(space => space.roomId).sort()).toEqual([a, b]);
    expect(merged.find(space => space.roomId === a)).toMatchObject({ name: '甲改名' });
    expect(merged.find(space => space.roomId === a)?.waiting).toBeUndefined();
    expect(mergeCatalogSpaces(remote, local, [a]).map(space => space.roomId)).toEqual([b]);
  });
});
