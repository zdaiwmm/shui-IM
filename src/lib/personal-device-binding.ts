import { uiLiteral } from './language';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalStringify } from './canonical';
import { fromBase64Url, toBase64Url } from './base64';
import { isPersonalPublicIdentity, withPersonalKeys, type PersonalPublicIdentity } from './personal-identity';
import type { PrivateIdentity, PublicBundle } from './types';

const bytes = (x: unknown) => new TextEncoder().encode(canonicalStringify(x));
export function validPersonalPublicBundle(bundle:PublicBundle):boolean {
  const key=(jwk:JsonWebKey,signing:boolean)=>!!jwk&&Object.keys(jwk).every(k=>['kty','crv','x','y','key_ops','ext'].includes(k))&&jwk.kty==='EC'&&jwk.crv==='P-256'&&
    /^[A-Za-z0-9_-]{43}$/.test(jwk.x??'')&&/^[A-Za-z0-9_-]{43}$/.test(jwk.y??'')&&(jwk.ext===undefined||typeof jwk.ext==='boolean')&&
    (jwk.key_ops===undefined||Array.isArray(jwk.key_ops)&&jwk.key_ops.length<2&&jwk.key_ops.every(op=>signing&&op==='verify'));
  return !!bundle&&Object.keys(bundle).sort().join(',')===(bundle.mlsKeyPackage===undefined?'deviceId,encryptionKey,signingKey':'deviceId,encryptionKey,mlsKeyPackage,signingKey')&&
    /^[0-9a-f-]{36}$/i.test(bundle.deviceId)&&key(bundle.encryptionKey,false)&&key(bundle.signingKey,true)&&
    (bundle.mlsKeyPackage===undefined||typeof bundle.mlsKeyPackage==='string'&&/^[A-Za-z0-9_-]{64,65536}$/.test(bundle.mlsKeyPackage));
}
export type PersonalDeviceBinding = {
  v: 1; purpose: 'chamber-personal-device-v1'; identity: PersonalPublicIdentity; bundleHash: string;
  rootSignature: string; deviceSignature: string;
};
export async function bindPersonalDevice(entropy: Uint8Array, device: PrivateIdentity): Promise<PersonalDeviceBinding> {
  if(!validPersonalPublicBundle(device.publicBundle))throw new Error(uiLiteral('身份绑定只能包含设备公钥'));
  return withPersonalKeys(entropy, async keys => {
    const body = { v: 1 as const, purpose: 'chamber-personal-device-v1' as const, identity: keys.publicIdentity,
      bundleHash: toBase64Url(sha256(bytes(device.publicBundle))) };
    const key = await crypto.subtle.importKey('jwk', device.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { ...body, rootSignature: toBase64Url(ed25519.sign(bytes(body), keys.signingSecret)),
      deviceSignature: toBase64Url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(body))) };
  });
}
export async function verifyPersonalDeviceBinding(binding: PersonalDeviceBinding, bundle: PublicBundle): Promise<boolean> {
  try {
    if (!validPersonalPublicBundle(bundle) || !binding || Object.keys(binding).sort().join(',') !== 'bundleHash,deviceSignature,identity,purpose,rootSignature,v' ||
      binding.v !== 1 || binding.purpose !== 'chamber-personal-device-v1' || !isPersonalPublicIdentity(binding.identity) ||
      binding.bundleHash !== toBase64Url(sha256(bytes(bundle))) ||
      ![binding.deviceSignature, binding.rootSignature].every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{86}$/.test(s))) return false;
    const { rootSignature, deviceSignature, ...body } = binding;
    if (!ed25519.verify(fromBase64Url(rootSignature), bytes(body), fromBase64Url(binding.identity.signingKey), { zip215: false })) return false;
    const key = await crypto.subtle.importKey('jwk', bundle.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(deviceSignature), bytes(body));
  } catch { return false; }
}
