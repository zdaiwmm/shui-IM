import { accessDigest, publicAccessKey, verifyAccess } from './browser-access-proof.mjs';

const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export async function verifyPendingDeletion(roomId, proof, catalog, source, now = Date.now()) {
  const certificate = proof?.certificate, request = proof?.request;
  if (!fields(proof, ['certificate', 'request'])
    || !fields(certificate, ['v', 'purpose', 'roomId', 'sourceDeviceId', 'catalogId', 'rootKey', 'signature'])
    || certificate.v !== 1 || certificate.purpose !== 'quiet-room-pending-management'
    || certificate.roomId !== roomId || certificate.catalogId !== catalog?.id
    || source?.deviceId !== certificate.sourceDeviceId || source.role !== 'creator' || source.status !== 'active'
    || !publicAccessKey(certificate.rootKey)
    || !fields(request, ['v', 'purpose', 'roomId', 'catalogHash', 'expiresAt', 'signature'])
    || request.v !== 1 || request.purpose !== 'quiet-room-pending-delete' || request.roomId !== roomId
    || !Number.isSafeInteger(request.expiresAt) || request.expiresAt < now || request.expiresAt > now + 60_000
    || request.catalogHash !== await accessDigest(catalog)) return false;
  return await verifyAccess(source.signingKey, certificate) && await verifyAccess(certificate.rootKey, request);
}
