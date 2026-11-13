import { randomBytes } from 'node:crypto';

/** Ephemeral, narrow transport authority. A server restart requires fresh unlock. */
export function createBlobTransferAuthority({ authorize, now = Date.now, maximum = 4096, ttl = 24 * 3600 * 1000 }) {
  const grants = new Map();
  function purge() { for (const [token, grant] of grants) if (grant.expiresAt <= now()) grants.delete(token); }
  return {
    issue({ roomId, blobId, deviceId, direction }) {
      purge();
      if (!['upload','download'].includes(direction)) throw Error('UNAUTHORIZED');
      authorize(roomId, blobId, deviceId);
      if (grants.size >= maximum || [...grants.values()].filter(g => g.roomId === roomId && g.deviceId === deviceId).length >= 8) throw Error('TRANSFER_LIMIT');
      const token = randomBytes(32).toString('base64url'), expiresAt = now() + ttl;
      grants.set(token, { roomId, blobId, deviceId, direction, expiresAt });
      return { token, expiresAt };
    },
    read(token, roomId, blobId, direction) {
      const grant = grants.get(token);
      if (!grant || grant.expiresAt <= now() || grant.roomId !== roomId || grant.blobId !== blobId || grant.direction !== direction) {
        if (grant?.expiresAt <= now()) grants.delete(token);
        throw Error('UNAUTHORIZED');
      }
      authorize(roomId, blobId, grant.deviceId);
      return { ...grant };
    },
    revoke(token) { grants.delete(token); },
  };
}
