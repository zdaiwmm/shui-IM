import { describe, expect, it } from 'vitest';
import { createBlobTransferAuthority } from '../server/blob-transfer.mjs';

describe('ciphertext-only transfer grants', () => {
  it('binds one device, blob, direction and expiry without retaining its room credential', () => {
    let now = 1_000, active = true;
    const authority = createBlobTransferAuthority({ now: () => now, authorize: () => { if (!active) throw Error('UNAUTHORIZED'); } });
    const scope = { roomId: 'room', blobId: 'blob', deviceId: 'device', direction: 'download' };
    const grant = authority.issue(scope);
    expect(authority.read(grant.token, 'room', 'blob', 'download')).toEqual(expect.objectContaining(scope));
    for (const [room, blob, direction] of [['other','blob','download'],['room','other','download'],['room','blob','upload']]) {
      expect(() => authority.read(grant.token, room, blob, direction)).toThrow('UNAUTHORIZED');
    }
    active = false;
    expect(() => authority.read(grant.token, 'room', 'blob', 'download')).toThrow('UNAUTHORIZED');
    active = true; now = grant.expiresAt;
    expect(() => authority.read(grant.token, 'room', 'blob', 'download')).toThrow('UNAUTHORIZED');
  });
  it('revokes cancellation permanently and bounds the number of task capabilities', () => {
    const authority = createBlobTransferAuthority({ authorize: () => {}, maximum: 1 });
    const scope = { roomId:'r',blobId:'b',deviceId:'d',direction:'upload' };
    const grant = authority.issue(scope);
    expect(authority.issue(scope).token).toBe(grant.token);
    expect(() => authority.issue({...scope,blobId:'other'})).toThrow('TRANSFER_LIMIT');
    authority.revoke(grant.token);
    expect(() => authority.read(grant.token,'r','b','upload')).toThrow('UNAUTHORIZED');
    expect(authority.issue(scope).token).not.toBe(grant.token);
  });
});
