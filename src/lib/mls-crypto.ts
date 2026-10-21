import { CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { ed25519 } from '@noble/curves/ed25519.js';
import { getCiphersuiteImpl, type Ciphersuite } from 'ts-mls';
import { makeGenericHpke } from 'ts-mls/crypto/implementation/hpke.js';
import { makeAead } from 'ts-mls/crypto/implementation/default/makeAead.js';

// RFC 8410 encoding emitted by the previous native Ed25519 key generator.
const ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** Keep the suite, serialized keys and verifier; avoid failing native key operations. */
export async function compatibleMlsCipherSuite(suite: Ciphersuite) {
  if (suite.name !== 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519') throw new Error('Unsupported MLS compatibility suite');
  const impl = await getCiphersuiteImpl(suite);
  const [aead, aeadInterface] = await makeAead(suite.hpke.aead);
  return { ...impl, signature: { ...impl.signature,
    async sign(signKey: Uint8Array, message: Uint8Array) {
      if (signKey.length === 32) return ed25519.sign(message, signKey);
      if (signKey.length === 48 && ED25519_PKCS8_PREFIX.every((byte, index) => signKey[index] === byte)) {
        return ed25519.sign(message, signKey.subarray(16));
      }
      // Preserve the previous parser for any other legacy encoding; never
      // strip unvalidated ASN.1 or reinterpret malformed data as a seed.
      return impl.signature.sign(signKey, message);
    },
  }, hpke: await makeGenericHpke(suite.hpke, aead, new CipherSuite({
    kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: aeadInterface,
  })) };
}
