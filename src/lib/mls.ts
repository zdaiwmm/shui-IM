import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetime,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processPrivateMessage,
  processPublicMessage,
  zeroOutUint8Array,
  type AuthenticationService,
  type ClientConfig,
  type ClientState,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
  type Proposal,
} from 'ts-mls';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { isMessagePayload } from './message-payload';
import type {
  MessagePayload,
  MlsMembershipEnvelope,
  MlsMessageEnvelope,
  MlsVaultState,
  MlsWelcomeEnvelope,
  PrivateIdentity,
  PublicBundle,
  RoomMember,
  RecoveryRequest,
  RoomState,
  Vault,
} from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CIPHERSUITE = getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519');

type CredentialBinding = {
  v: 1;
  deviceId: string;
  mlsSignatureKey: string;
  bindingSignature: string;
};

type ApplicationPlaintext = {
  v: 1;
  roomId: string;
  clientMsgId: string;
  senderId: string;
  payload: MessagePayload;
};

function bindingBody(value: Omit<CredentialBinding, 'bindingSignature'>) {
  return { v: value.v, deviceId: value.deviceId, mlsSignatureKey: value.mlsSignatureKey };
}

async function signEcdsa(privateJwk: JsonWebKey, value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return toBase64Url(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(canonicalStringify(value)),
  ));
}

async function verifyEcdsa(publicJwk: JsonWebKey, signature: string, value: unknown): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      fromBase64Url(signature),
      encoder.encode(canonicalStringify(value)),
    );
  } catch {
    return false;
  }
}

function parseCredential(credential: Credential): CredentialBinding | null {
  if (credential.credentialType !== 'basic') return null;
  try {
    const value = JSON.parse(decoder.decode(credential.identity)) as CredentialBinding;
    if (
      value.v !== 1 ||
      !/^[0-9a-f-]{36}$/i.test(value.deviceId) ||
      typeof value.mlsSignatureKey !== 'string' ||
      typeof value.bindingSignature !== 'string'
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function clientConfig(members: RoomMember[]): ClientConfig {
  const authService: AuthenticationService = {
    async validateCredential(credential, signaturePublicKey) {
      const binding = parseCredential(credential);
      if (!binding || binding.mlsSignatureKey !== toBase64Url(signaturePublicKey)) return false;
      const member = members.find((candidate) => candidate.deviceId === binding.deviceId);
      return Boolean(member && await verifyEcdsa(
        member.signingKey,
        binding.bindingSignature,
        bindingBody(binding),
      ));
    },
  };
  return {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService,
  };
}

async function cipherSuite() {
  return getCiphersuiteImpl(CIPHERSUITE);
}

function decodeKeyPackage(encoded: string): KeyPackage {
  const bytes = fromBase64Url(encoded);
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length || decoded[0].wireformat !== 'mls_key_package') {
    throw new Error('MLS 密钥包格式不正确');
  }
  return decoded[0].keyPackage;
}

function privatePackage(identity: PrivateIdentity): PrivateKeyPackage {
  const stored = identity.mlsPrivatePackage;
  if (!stored) throw new Error('本机缺少 MLS 私有密钥包');
  return {
    initPrivateKey: fromBase64Url(stored.initPrivateKey),
    hpkePrivateKey: fromBase64Url(stored.hpkePrivateKey),
    signaturePrivateKey: fromBase64Url(stored.signaturePrivateKey),
  };
}

function decodeState(encoded: string, members: RoomMember[]): ClientState {
  const bytes = fromBase64Url(encoded);
  const decoded = decodeGroupState(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) throw new Error('MLS 本机状态已经损坏');
  return { ...decoded[0], clientConfig: clientConfig(members) };
}

function encodeState(state: ClientState): string {
  return toBase64Url(encodeGroupState(state));
}

function clearConsumed(consumed: Uint8Array[]): void {
  consumed.forEach(zeroOutUint8Array);
}

function deviceIdAtLeaf(state: ClientState, leafIndex: number): string | null {
  const node = state.ratchetTree[leafIndex * 2];
  if (!node || node.nodeType !== 'leaf') return null;
  return parseCredential(node.leaf.credential)?.deviceId ?? null;
}

function leafIndexForDevice(state: ClientState, deviceId: string): number | null {
  for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex += 2) {
    const node = state.ratchetTree[nodeIndex];
    if (node?.nodeType === 'leaf' && parseCredential(node.leaf.credential)?.deviceId === deviceId) {
      return nodeIndex / 2;
    }
  }
  return null;
}

function membershipUnsigned(envelope: MlsMembershipEnvelope): Omit<MlsMembershipEnvelope, 'signature'> {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

async function verifyMembershipEnvelope(vault: Vault, envelope: MlsMembershipEnvelope): Promise<RoomMember> {
  if (
    envelope.v !== 1 ||
    envelope.protocol !== 'mls-rfc9420' ||
    envelope.roomId !== vault.roomId ||
    !Number.isSafeInteger(envelope.previousEventSeq) ||
    envelope.previousEventSeq < 0 ||
    !['add', 'remove', 'replace'].includes(envelope.action)
  ) throw new Error('MLS 设备变更格式不正确');
  const sender = vault.members.find((member) => member.deviceId === envelope.senderId);
  // `vault.members` may already reflect the latest server snapshot while an
  // offline client is replaying older membership commits. A sender that is
  // revoked *now* may still have been an active MLS leaf for an earlier commit;
  // the caller's ordered trusted-leaf set and MLS verification enforce that
  // event-time authorization.
  if (!sender) throw new Error('MLS 设备变更发送者不可信');
  if (!await verifyEcdsa(sender.signingKey, envelope.signature, membershipUnsigned(envelope))) {
    throw new Error('MLS 设备变更签名验证失败');
  }
  return sender;
}

export async function createRecoveryRequest(
  vault: Vault,
  replacement: PublicBundle,
  newAccessToken: string,
): Promise<RecoveryRequest> {
  const unsigned: Omit<RecoveryRequest, 'signature'> = {
    v: 1,
    protocol: 'mls-rfc9420',
    roomId: vault.roomId,
    requestId: crypto.randomUUID(),
    sourceDeviceId: vault.identity.publicBundle.deviceId,
    replacement,
    tokenHash: toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(newAccessToken))),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  return { ...unsigned, signature: await signEcdsa(vault.identity.signingPrivateKey, unsigned) };
}

export async function verifyRecoveryRequest(vault: Pick<Vault, 'roomId' | 'members'>, request: RecoveryRequest): Promise<void> {
  const source = vault.members.find((member) => member.deviceId === request?.sourceDeviceId);
  if (!source || request.v !== 1 || request.protocol !== 'mls-rfc9420' || request.roomId !== vault.roomId ||
    !request.replacement?.mlsKeyPackage || request.sourceDeviceId === request.replacement.deviceId ||
    !Number.isFinite(Date.parse(request.expiresAt))) throw new Error('恢复授权与会话身份不匹配');
  const { signature, ...unsigned } = request;
  if (!await verifyEcdsa(source.signingKey, signature, unsigned)) throw new Error('恢复授权签名验证失败');
}

function verifyReplacementTarget(envelope: MlsMembershipEnvelope, members: RoomMember[]): void {
  const request = envelope.recoveryRequest;
  const source = members.find((member) => member.deviceId === envelope.replacedDeviceId);
  if (!request || !source || !envelope.target || envelope.targetId !== request.replacement.deviceId ||
    source.deviceId !== request.sourceDeviceId || envelope.senderId === source.deviceId ||
    source.role !== envelope.target.role || envelope.target.addedBy !== source.deviceId ||
    canonicalStringify(memberBundleForMls(envelope.target)) !== canonicalStringify(request.replacement)) {
    throw new Error('恢复替换目标与已签名授权不一致');
  }
}

/** Authenticate identity changes from the backup without reusing its old MLS secrets. */
export async function verifyRecoveryMembershipChain(vault: Vault, state: RoomState): Promise<void> {
  const checkpoint = vault.pendingRecovery;
  if (!checkpoint || state.roomId !== vault.roomId) throw new Error('本机恢复检查点不存在');
  const trusted = new Map(checkpoint.checkpointMembers
    .filter((member) => member.status === undefined || member.status === 'active')
    .map((member) => [member.deviceId, member]));
  let sequence = checkpoint.checkpointEventSeq;
  for (const { eventSeq, event } of [...(state.mlsEvents ?? [])].sort((a, b) => a.eventSeq - b.eventSeq)) {
    if (eventSeq <= sequence) continue;
    if (eventSeq !== sequence + 1 || event.previousEventSeq !== sequence || !trusted.has(event.senderId)) {
      throw new Error('恢复成员签名链不连续');
    }
    const members = [...trusted.values()];
    await verifyMembershipEnvelope({ ...vault, members }, event);
    const sender = trusted.get(event.senderId)!;
    if (event.action === 'add') {
      if (!event.target || event.target.deviceId !== event.targetId || event.target.role !== sender.role ||
        event.target.addedBy !== sender.deviceId || trusted.has(event.targetId)) throw new Error('恢复成员加入授权不正确');
      trusted.set(event.targetId, event.target);
    } else if (event.action === 'remove') {
      if (trusted.get(event.targetId)?.role !== sender.role || event.targetId === sender.deviceId) throw new Error('恢复成员移除授权不正确');
      trusted.delete(event.targetId);
    } else {
      verifyReplacementTarget(event, members);
      await verifyRecoveryRequest({ roomId: vault.roomId, members }, event.recoveryRequest!);
      trusted.delete(event.replacedDeviceId!);
      trusted.set(event.targetId, event.target!);
    }
    sequence = eventSeq;
  }
  if (sequence !== (state.nextMlsEventSeq ?? 0)) throw new Error('恢复成员签名链不完整');
  if (state.members.filter((item) => item.status === 'active').length !== trusted.size) {
    throw new Error('服务器恢复成员列表缺少已授权成员');
  }
  for (const member of state.members.filter((item) => item.status === 'active')) {
    const authenticated = trusted.get(member.deviceId);
    if (!authenticated || authenticated.role !== member.role ||
      canonicalStringify(memberBundleForMls(authenticated)) !== canonicalStringify(memberBundleForMls(member))) {
      throw new Error('服务器恢复成员身份未经签名链授权');
    }
  }
}

export async function prepareMlsRecoveryReplacement(
  vault: Vault,
  request: RecoveryRequest,
  target: RoomMember,
): Promise<{ event: MlsMembershipEnvelope; nextGroupState: string }> {
  if (vault.mls?.phase !== 'active' || !vault.mls.groupState) throw new Error('当前设备尚未建立安全会话');
  if (Date.parse(request.expiresAt) <= Date.now()) throw new Error('恢复授权已过期');
  await verifyRecoveryRequest(vault, request);
  const state = decodeState(vault.mls.groupState, vault.members);
  const removed = leafIndexForDevice(state, request.sourceDeviceId);
  if (removed === null || request.sourceDeviceId === vault.identity.publicBundle.deviceId || !target.mlsKeyPackage) {
    throw new Error('需要另一台在线设备完成安全恢复');
  }
  const result = await createCommit({ state, cipherSuite: await cipherSuite() }, {
    extraProposals: [
      { proposalType: 'remove', remove: { removed } },
      { proposalType: 'add', add: { keyPackage: decodeKeyPackage(target.mlsKeyPackage) } },
    ],
    ratchetTreeExtension: true,
    wireAsPublicMessage: true,
  });
  try {
    if (!result.welcome || result.commit.wireformat !== 'mls_public_message') throw new Error('恢复替换未生成有效欢迎消息');
    const unsigned: Omit<MlsMembershipEnvelope, 'signature'> = {
      v: 1, protocol: 'mls-rfc9420', roomId: vault.roomId, eventId: crypto.randomUUID(),
      previousEventSeq: vault.mls.lastEventSeq ?? 0, action: 'replace',
      senderId: vault.identity.publicBundle.deviceId, targetId: target.deviceId, target,
      replacedDeviceId: request.sourceDeviceId, recoveryRequest: request,
      commit: toBase64Url(encodeMlsMessage(result.commit)),
      welcome: toBase64Url(encodeMlsMessage({ welcome: result.welcome, wireformat: 'mls_welcome', version: 'mls10' })),
    };
    const event = { ...unsigned, signature: await signEcdsa(vault.identity.signingPrivateKey, unsigned) };
    verifyReplacementTarget(event, vault.members);
    return { event, nextGroupState: encodeState(result.newState) };
  } finally { clearConsumed(result.consumed); }
}

export async function generateMlsKeyMaterial(
  deviceId: string,
  signingPrivateKey: JsonWebKey,
): Promise<Pick<PrivateIdentity, 'mlsPrivatePackage'> & { mlsKeyPackage: string }> {
  const impl = await cipherSuite();
  const signatureKeyPair = await impl.signature.keygen();
  const unsigned: Omit<CredentialBinding, 'bindingSignature'> = {
    v: 1,
    deviceId,
    mlsSignatureKey: toBase64Url(signatureKeyPair.publicKey),
  };
  const binding: CredentialBinding = {
    ...unsigned,
    bindingSignature: await signEcdsa(signingPrivateKey, bindingBody(unsigned)),
  };
  const credential: Credential = { credentialType: 'basic', identity: encoder.encode(JSON.stringify(binding)) };
  const generated = await generateKeyPackageWithKey(
    credential,
    defaultCapabilities(),
    defaultLifetime,
    [],
    signatureKeyPair,
    impl,
  );
  return {
    mlsKeyPackage: toBase64Url(encodeMlsMessage({
      keyPackage: generated.publicPackage,
      wireformat: 'mls_key_package',
      version: 'mls10',
    })),
    mlsPrivatePackage: {
      initPrivateKey: toBase64Url(generated.privatePackage.initPrivateKey),
      hpkePrivateKey: toBase64Url(generated.privatePackage.hpkePrivateKey),
      signaturePrivateKey: toBase64Url(generated.privatePackage.signaturePrivateKey),
    },
  };
}

export async function createCreatorMlsState(
  roomId: string,
  identity: PrivateIdentity,
  members: RoomMember[],
): Promise<MlsVaultState> {
  if (!identity.publicBundle.mlsKeyPackage) throw new Error('创建者缺少 MLS 公钥包');
  const state = await createGroup(
    encoder.encode(`quiet-room:${roomId}`),
    decodeKeyPackage(identity.publicBundle.mlsKeyPackage),
    privatePackage(identity),
    [],
    await cipherSuite(),
    clientConfig(members),
  );
  return { protocol: 'mls-rfc9420', phase: 'awaiting-peer', groupState: encodeState(state) };
}

export async function prepareCreatorWelcome(vault: Vault): Promise<MlsVaultState> {
  if (vault.role !== 'creator' || !vault.mls?.groupState) throw new Error('创建者 MLS 状态未初始化');
  if (vault.mls.pendingWelcome) return vault.mls;
  const joiner = vault.members.find((member) => member.role === 'joiner');
  if (!joiner?.mlsKeyPackage) throw new Error('加入设备缺少 MLS 密钥包');
  const state = decodeState(vault.mls.groupState, vault.members);
  const proposal: Proposal = { proposalType: 'add', add: { keyPackage: decodeKeyPackage(joiner.mlsKeyPackage) } };
  const result = await createCommit(
    { state, cipherSuite: await cipherSuite() },
    { extraProposals: [proposal], ratchetTreeExtension: true },
  );
  try {
    if (!result.welcome) throw new Error('MLS 没有生成加入欢迎消息');
    const unsigned: Omit<MlsWelcomeEnvelope, 'signature'> = {
      v: 1,
      protocol: 'mls-rfc9420',
      roomId: vault.roomId,
      senderId: vault.identity.publicBundle.deviceId,
      recipientId: joiner.deviceId,
      welcome: toBase64Url(encodeMlsMessage({
        welcome: result.welcome,
        wireformat: 'mls_welcome',
        version: 'mls10',
      })),
    };
    return {
      protocol: 'mls-rfc9420',
      phase: 'active',
      groupState: encodeState(result.newState),
      pendingWelcome: {
        ...unsigned,
        signature: await signEcdsa(vault.identity.signingPrivateKey, unsigned),
      },
    };
  } finally {
    clearConsumed(result.consumed);
  }
}

export async function joinMlsGroup(vault: Vault, envelope: MlsWelcomeEnvelope): Promise<MlsVaultState> {
  const creator = vault.members.find((member) => member.role === 'creator');
  const own = vault.identity.publicBundle;
  if (
    !creator ||
    envelope.v !== 1 ||
    envelope.protocol !== 'mls-rfc9420' ||
    envelope.roomId !== vault.roomId ||
    envelope.senderId !== creator.deviceId ||
    envelope.recipientId !== own.deviceId ||
    !own.mlsKeyPackage
  ) throw new Error('MLS 欢迎消息与会话成员不匹配');
  const { signature, ...unsigned } = envelope;
  if (!await verifyEcdsa(creator.signingKey, signature, unsigned)) throw new Error('MLS 欢迎消息签名验证失败');
  const bytes = fromBase64Url(envelope.welcome);
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length || decoded[0].wireformat !== 'mls_welcome') {
    throw new Error('MLS 欢迎消息格式不正确');
  }
  const state = await joinGroup(
    decoded[0].welcome,
    decodeKeyPackage(own.mlsKeyPackage),
    privatePackage(vault.identity),
    emptyPskIndex,
    await cipherSuite(),
    undefined,
    undefined,
    clientConfig(vault.members),
  );
  return { protocol: 'mls-rfc9420', phase: 'active', groupState: encodeState(state) };
}

export async function prepareMlsMembership(
  vault: Vault,
  action: 'add' | 'remove',
  target: RoomMember,
): Promise<{ event: MlsMembershipEnvelope; nextGroupState: string }> {
  if (vault.protocol !== 'mls-rfc9420' || vault.mls?.phase !== 'active' || !vault.mls.groupState) {
    throw new Error('MLS 会话尚未安全建立');
  }
  if (target.deviceId === vault.identity.publicBundle.deviceId) throw new Error('不能通过远程操作变更当前设备');
  const members = action === 'add'
    ? [...vault.members.filter((member) => member.deviceId !== target.deviceId), target]
    : vault.members;
  const state = decodeState(vault.mls.groupState, members);
  let proposal: Proposal;
  if (action === 'add') {
    if (!target.mlsKeyPackage || target.status === 'revoked') throw new Error('新设备缺少有效的 MLS 密钥包');
    if (leafIndexForDevice(state, target.deviceId) !== null) throw new Error('该设备已经属于 MLS 会话');
    proposal = { proposalType: 'add', add: { keyPackage: decodeKeyPackage(target.mlsKeyPackage) } };
  } else {
    const removed = leafIndexForDevice(state, target.deviceId);
    if (removed === null) throw new Error('要移除的设备不在当前 MLS 会话中');
    proposal = { proposalType: 'remove', remove: { removed } };
  }
  const result = await createCommit(
    { state, cipherSuite: await cipherSuite() },
    { extraProposals: [proposal], ratchetTreeExtension: action === 'add', wireAsPublicMessage: true },
  );
  try {
    if (result.commit.wireformat !== 'mls_public_message') throw new Error('MLS 设备变更必须使用公开提交消息');
    if (action === 'add' && !result.welcome) throw new Error('MLS 没有为新设备生成欢迎消息');
    const unsigned: Omit<MlsMembershipEnvelope, 'signature'> = {
      v: 1,
      protocol: 'mls-rfc9420',
      roomId: vault.roomId,
      eventId: crypto.randomUUID(),
      previousEventSeq: vault.mls.lastEventSeq ?? 0,
      action,
      senderId: vault.identity.publicBundle.deviceId,
      targetId: target.deviceId,
      ...(action === 'add' ? { target } : {}),
      commit: toBase64Url(encodeMlsMessage(result.commit)),
      ...(result.welcome ? {
        welcome: toBase64Url(encodeMlsMessage({
          welcome: result.welcome,
          wireformat: 'mls_welcome',
          version: 'mls10',
        })),
      } : {}),
    };
    return {
      event: { ...unsigned, signature: await signEcdsa(vault.identity.signingPrivateKey, unsigned) },
      nextGroupState: encodeState(result.newState),
    };
  } finally {
    clearConsumed(result.consumed);
  }
}

export async function processMlsMembership(
  vault: Vault,
  envelope: MlsMembershipEnvelope,
  eventSeq: number,
): Promise<string> {
  await verifyMembershipEnvelope(vault, envelope);
  if (envelope.action === 'replace') {
    verifyReplacementTarget(envelope, vault.members);
    await verifyRecoveryRequest(vault, envelope.recoveryRequest!);
  }
  if (eventSeq !== (vault.mls?.lastEventSeq ?? 0) + 1 || envelope.previousEventSeq !== eventSeq - 1) {
    throw new Error('MLS 设备变更顺序不连续');
  }
  if (!vault.mls?.groupState) throw new Error('本机 MLS 状态缺失');
  const state = decodeState(vault.mls.groupState, vault.members);
  const bytes = fromBase64Url(envelope.commit);
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length || decoded[0].wireformat !== 'mls_public_message') {
    throw new Error('MLS 设备变更提交格式不正确');
  }
  const result = await processPublicMessage(
    state,
    decoded[0].publicMessage,
    emptyPskIndex,
    await cipherSuite(),
    (incoming) => {
      if (incoming.kind !== 'commit' || incoming.proposals.length !== (envelope.action === 'replace' ? 2 : 1)) return 'reject';
      if (incoming.senderLeafIndex === undefined || deviceIdAtLeaf(state, incoming.senderLeafIndex) !== envelope.senderId) {
        return 'reject';
      }
      const proposal = incoming.proposals[0]?.proposal;
      if (envelope.action === 'replace') {
        const add = incoming.proposals[1]?.proposal;
        if (proposal?.proposalType !== 'remove' || add?.proposalType !== 'add' ||
          deviceIdAtLeaf(state, proposal.remove.removed) !== envelope.replacedDeviceId || !envelope.target) return 'reject';
        const encoded = toBase64Url(encodeMlsMessage({ keyPackage: add.add.keyPackage, wireformat: 'mls_key_package', version: 'mls10' }));
        return encoded === envelope.target.mlsKeyPackage ? 'accept' : 'reject';
      }
      if (envelope.action === 'add') {
        if (proposal?.proposalType !== 'add' || !envelope.target || envelope.target.deviceId !== envelope.targetId) return 'reject';
        return parseCredential(proposal.add.keyPackage.leafNode.credential)?.deviceId === envelope.targetId ? 'accept' : 'reject';
      }
      if (proposal?.proposalType !== 'remove') return 'reject';
      return deviceIdAtLeaf(state, proposal.remove.removed) === envelope.targetId ? 'accept' : 'reject';
    },
  );
  try {
    if (result.actionTaken !== 'accept') throw new Error('MLS 设备变更内容与签名声明不一致');
    return encodeState(result.newState);
  } finally {
    clearConsumed(result.consumed);
  }
}

export async function joinMlsMembership(
  vault: Vault,
  envelope: MlsMembershipEnvelope,
  eventSeq: number,
): Promise<MlsVaultState> {
  await verifyMembershipEnvelope(vault, envelope);
  if (envelope.action === 'replace') {
    verifyReplacementTarget(envelope, vault.members);
    await verifyRecoveryRequest(vault, envelope.recoveryRequest!);
  }
  if (eventSeq !== (vault.mls?.lastEventSeq ?? 0) + 1 || envelope.previousEventSeq !== eventSeq - 1) {
    throw new Error('MLS 新设备加入事件顺序不连续');
  }
  const own = vault.identity.publicBundle;
  if (
    (envelope.action !== 'add' && envelope.action !== 'replace') ||
    envelope.targetId !== own.deviceId ||
    !envelope.target ||
    canonicalStringify(memberBundleForMls(envelope.target)) !== canonicalStringify(own) ||
    !envelope.welcome ||
    !own.mlsKeyPackage
  ) throw new Error('MLS 新设备欢迎消息与本机身份不匹配');
  const bytes = fromBase64Url(envelope.welcome);
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length || decoded[0].wireformat !== 'mls_welcome') {
    throw new Error('MLS 新设备欢迎消息格式不正确');
  }
  const state = await joinGroup(
    decoded[0].welcome,
    decodeKeyPackage(own.mlsKeyPackage),
    privatePackage(vault.identity),
    emptyPskIndex,
    await cipherSuite(),
    undefined,
    undefined,
    clientConfig(vault.members),
  );
  return {
    protocol: 'mls-rfc9420',
    phase: 'active',
    groupState: encodeState(state),
    lastEventSeq: eventSeq,
  };
}

function memberBundleForMls(member: RoomMember): PublicBundle {
  return {
    deviceId: member.deviceId,
    encryptionKey: member.encryptionKey,
    signingKey: member.signingKey,
    ...(member.mlsKeyPackage ? { mlsKeyPackage: member.mlsKeyPackage } : {}),
  };
}

export async function encryptMlsApplication(
  vault: Vault,
  payload: MessagePayload,
  clientMsgId: string,
): Promise<{ envelope: MlsMessageEnvelope; nextGroupState: string }> {
  if (vault.mls?.phase !== 'active' || !vault.mls.groupState) throw new Error('MLS 会话尚未安全建立');
  const state = decodeState(vault.mls.groupState, vault.members);
  const senderId = vault.identity.publicBundle.deviceId;
  const plaintext: ApplicationPlaintext = { v: 1, roomId: vault.roomId, clientMsgId, senderId, payload };
  const result = await createApplicationMessage(state, encoder.encode(JSON.stringify(plaintext)), await cipherSuite());
  try {
    const unsigned: Omit<MlsMessageEnvelope, 'signature'> = {
      v: 2,
      protocol: 'mls-rfc9420',
      roomId: vault.roomId,
      clientMsgId,
      senderId,
      ciphertext: toBase64Url(encodeMlsMessage({
        privateMessage: result.privateMessage,
        wireformat: 'mls_private_message',
        version: 'mls10',
      })),
    };
    return {
      envelope: { ...unsigned, signature: await signEcdsa(vault.identity.signingPrivateKey, unsigned) },
      nextGroupState: encodeState(result.newState),
    };
  } finally {
    clearConsumed(result.consumed);
  }
}

export async function decryptMlsApplication(
  vault: Vault,
  envelope: MlsMessageEnvelope,
): Promise<{ payload: MessagePayload; nextGroupState: string }> {
  if (vault.mls?.phase !== 'active' || !vault.mls.groupState) throw new Error('MLS 会话尚未安全建立');
  const sender = vault.members.find((member) => member.deviceId === envelope.senderId);
  if (!sender || envelope.roomId !== vault.roomId || envelope.senderId === vault.identity.publicBundle.deviceId) {
    throw new Error('MLS 消息发送设备不正确');
  }
  const { signature, ...unsigned } = envelope;
  if (!await verifyEcdsa(sender.signingKey, signature, unsigned)) throw new Error('MLS 消息外层签名验证失败');
  const bytes = fromBase64Url(envelope.ciphertext);
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length || decoded[0].wireformat !== 'mls_private_message') {
    throw new Error('MLS 密文格式不正确');
  }
  const result = await processPrivateMessage(
    decodeState(vault.mls.groupState, vault.members),
    decoded[0].privateMessage,
    emptyPskIndex,
    await cipherSuite(),
  );
  try {
    if (result.kind !== 'applicationMessage') throw new Error('收到的 MLS 消息不是应用消息');
    const plaintext = JSON.parse(decoder.decode(result.message)) as ApplicationPlaintext;
    if (
      plaintext.v !== 1 ||
      plaintext.roomId !== envelope.roomId ||
      plaintext.clientMsgId !== envelope.clientMsgId ||
      plaintext.senderId !== envelope.senderId ||
      !isMessagePayload(plaintext.payload)
    ) throw new Error('MLS 明文与外层消息绑定不一致');
    return { payload: plaintext.payload, nextGroupState: encodeState(result.newState) };
  } finally {
    clearConsumed(result.consumed);
  }
}
