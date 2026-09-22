// Shared browser/service verification. These signatures authorize an application
// for membership only; they never authorize an MLS Add without the peer's commit.
const encoder = new TextEncoder();
export const ACCESS_TTL_MS = 10 * 60_000;
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const b64 = (value, min, max = min) => typeof value === 'string' && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key)) && names.every(key => key in value);
export function publicAccessKey(key) {
  return Boolean(key && key.kty === 'EC' && key.crv === 'P-256' && b64(key.x, 43) && b64(key.y, 43) && !key.d &&
    Object.keys(key).every(k => ['kty', 'crv', 'x', 'y', 'key_ops', 'ext', 'alg', 'use'].includes(k)));
}
export function publicAccessBundle(bundle) {
  return Boolean(fields(bundle, ['deviceId', 'encryptionKey', 'signingKey', 'mlsKeyPackage']) && uuid(bundle.deviceId) &&
    publicAccessKey(bundle.encryptionKey) && publicAccessKey(bundle.signingKey) && b64(bundle.mlsKeyPackage, 64, 65536));
}
function encode(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function decode(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)); }
export async function signAccess(privateKey, value) {
  const key = await crypto.subtle.importKey('jwk', privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { ...value, signature: encode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(canonical(value)))) };
}
export async function verifyAccess(publicKey, signed) {
  try {
    if (!publicAccessKey(publicKey) || !b64(signed?.signature, 86)) return false;
    const { signature, ...value } = signed;
    const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(signature), encoder.encode(canonical(value)));
  } catch { return false; }
}
export async function newAccessIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { browserId: crypto.randomUUID(), publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}
export function validAccessProof(proof, roomId) {
  if (!fields(proof, ['certificate', 'grant', 'request'])) return false;
  const { certificate: c, grant: g, request: r } = proof;
  return Boolean(fields(c, ['v', 'purpose', 'roomId', 'sourceDeviceId', 'rootKey', 'signature']) && c.v === 1 &&
    c.purpose === 'quiet-room-browser-request-root' && c.roomId === roomId && uuid(c.roomId) && uuid(c.sourceDeviceId) && publicAccessKey(c.rootKey) && b64(c.signature, 86) &&
    fields(g, ['v', 'purpose', 'requestId', 'browserId', 'browserKey', 'signature']) && g.v === 1 && g.purpose === 'quiet-room-browser-request-grant' &&
    uuid(g.requestId) && uuid(g.browserId) && publicAccessKey(g.browserKey) && b64(g.signature, 86) &&
    fields(r, ['v', 'purpose', 'roomId', 'requestId', 'browserId', 'target', 'tokenHash', 'certificateHash', 'grantHash', 'signature']) &&
    r.v === 1 && r.purpose === 'quiet-room-space-access-request' && r.roomId === roomId && uuid(r.requestId) && r.browserId === g.browserId &&
    publicAccessBundle(r.target) && r.target.deviceId !== c.sourceDeviceId && b64(r.tokenHash, 43) && b64(r.certificateHash, 43) && b64(r.grantHash, 43) && b64(r.signature, 86));
}
export async function accessDigest(value) { return encode(await crypto.subtle.digest('SHA-256', encoder.encode(typeof value === 'string' ? value : canonical(value)))); }
export async function verifyAccessProof(proof, roomId, source) {
  if (!validAccessProof(proof, roomId) || source?.deviceId !== proof.certificate.sourceDeviceId) return false;
  return await verifyAccess(source.signingKey, proof.certificate) && await verifyAccess(proof.certificate.rootKey, proof.grant) &&
    await verifyAccess(proof.grant.browserKey, proof.request) &&
    proof.request.certificateHash === await accessDigest(proof.certificate) && proof.request.grantHash === await accessDigest(proof.grant);
}
export async function accessSafetyCode(value) {
  const bytes = decode(await accessDigest(value));
  return (new DataView(bytes.buffer).getUint32(0) % 1000000).toString().padStart(6, '0');
}
