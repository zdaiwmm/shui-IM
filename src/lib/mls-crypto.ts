import { CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { getCiphersuiteImpl, type Ciphersuite } from 'ts-mls';
import { makeGenericHpke } from 'ts-mls/crypto/implementation/hpke.js';
import { makeAead } from 'ts-mls/crypto/implementation/default/makeAead.js';

/** Keep the RFC 9420 suite and serialized keys; avoid native X25519 generation. */
export async function compatibleMlsCipherSuite(suite: Ciphersuite) {
  if (suite.name !== 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519') throw new Error('Unsupported MLS compatibility suite');
  const impl = await getCiphersuiteImpl(suite);
  const [aead, aeadInterface] = await makeAead(suite.hpke.aead);
  return { ...impl, hpke: await makeGenericHpke(suite.hpke, aead, new CipherSuite({
    kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: aeadInterface,
  })) };
}
