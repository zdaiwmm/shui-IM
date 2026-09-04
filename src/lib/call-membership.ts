import { decodeGroupState } from 'ts-mls';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import type { PublicBundle, RoomMember, Vault } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const verifiedRosters = new WeakMap<Vault, string>();
// Call snapshots retain only authenticated public leaves, never an old copy of
// the MLS private state whose application generations are deleted by chat.
const callSnapshotTrees = new WeakMap<Vault, ReturnType<typeof readPublicTree>>();
export const CALL_IDENTITY_PROTOCOL = 'quiet-room-call-identity-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CallIdentityAttestation = {
  protocol: typeof CALL_IDENTITY_PROTOCOL;
  roomId: string;
  deviceId: string;
  role: Vault['role'];
  publicBundle: PublicBundle;
  signature: string;
};

type CredentialBinding = {
  v: 1;
  deviceId: string;
  mlsSignatureKey: string;
  bindingSignature: string;
};

type PublicLeaf = { leafIndex: number; signatureKey: string; binding: CredentialBinding };

function fail(): never { throw new Error('通话成员未通过本机 MLS 身份验证'); }
function active(member: RoomMember): boolean {
  return (member.status === 'active' || member.status === undefined) && !member.revokedAt;
}

/** Fields pinned by pairing or a signed membership target; presence/capabilities are not identity. */
function identity(member: RoomMember) {
  return {
    deviceId: member.deviceId,
    role: member.role,
    encryptionKey: member.encryptionKey,
    signingKey: member.signingKey,
    ...(member.mlsKeyPackage ? { mlsKeyPackage: member.mlsKeyPackage } : {}),
    addedBy: member.addedBy ?? null,
  };
}

/**
 * The caller must derive expectedMembers only from its previous accepted roster,
 * verified initial pairing, and successfully verified MLS membership envelopes.
 * A server snapshot is never a suitable expected roster.
 */
export function assertAuthenticatedRoomRoster(
  expectedMembers: readonly RoomMember[],
  actualMembers: readonly RoomMember[],
): void {
  const expected = new Map<string, RoomMember>();
  const actual = new Map<string, RoomMember>();
  for (const [source, target] of [[expectedMembers, expected], [actualMembers, actual]] as const) {
    const seen = new Set<string>();
    for (const member of source) {
      if (seen.has(member.deviceId)) fail();
      seen.add(member.deviceId);
      if (active(member)) target.set(member.deviceId, member);
    }
  }
  if (actual.size !== expected.size) fail();
  for (const [deviceId, member] of expected) {
    const candidate = actual.get(deviceId);
    if (!candidate || canonicalStringify(identity(candidate)) !== canonicalStringify(identity(member))) fail();
  }
}

function readPublicTree(vault: Vault): { leaves: PublicLeaf[]; ownLeaf: number; groupId: string } {
  if (vault.protocol !== 'mls-rfc9420' || vault.mls?.phase !== 'active' || !vault.mls.groupState) fail();
  const bytes = fromBase64Url(vault.mls.groupState);
  const decoded = decodeGroupState(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) fail();
  const state = decoded[0];
  const groupId = decoder.decode(state.groupContext.groupId);
  if (groupId !== `quiet-room:${vault.roomId}`) fail();
  const leaves: PublicLeaf[] = [];
  const seen = new Set<string>();
  for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex += 2) {
    const node = state.ratchetTree[nodeIndex];
    if (!node) continue;
    if (node.nodeType !== 'leaf' || node.leaf.credential.credentialType !== 'basic') fail();
    const binding = JSON.parse(decoder.decode(node.leaf.credential.identity)) as CredentialBinding;
    if (!binding || binding.v !== 1 || !/^[0-9a-f-]{36}$/i.test(binding.deviceId) ||
        typeof binding.mlsSignatureKey !== 'string' || typeof binding.bindingSignature !== 'string' ||
        binding.mlsSignatureKey !== toBase64Url(node.leaf.signaturePublicKey) || seen.has(binding.deviceId)) fail();
    seen.add(binding.deviceId);
    leaves.push({ leafIndex: nodeIndex / 2, signatureKey: binding.mlsSignatureKey, binding });
  }
  if (!leaves.length) fail();
  return { leaves, ownLeaf: state.privatePath.leafIndex, groupId };
}

/** Public identity/leaf stamp deliberately excludes application message ratchets. */
function rosterStamp(vault: Vault): string {
  const snapshotTree = callSnapshotTrees.get(vault);
  if (snapshotTree && (vault.protocol !== 'mls-rfc9420' || vault.mls?.protocol !== 'mls-rfc9420' ||
      vault.mls.phase !== 'active' || Object.keys(vault.mls).some(key => key !== 'protocol' && key !== 'phase'))) fail();
  const tree = snapshotTree ?? readPublicTree(vault);
  return canonicalStringify({
    roomId: vault.roomId, role: vault.role, own: vault.identity.publicBundle,
    members: vault.members.map(member => ({ ...identity(member), active: active(member), capabilities: member.capabilities ?? [] })),
    tree,
  });
}

/**
 * Verify the encrypted local MLS tree, not a claimed server member list.
 * This proves leaf membership and the identity signing key. Role/ECDH metadata
 * also require assertAuthenticatedRoomRoster at the room-state acceptance boundary.
 */
export async function authenticatedMlsCallMembers(vault: Vault): Promise<RoomMember[]> {
  verifiedRosters.delete(vault);
  const stamp = rosterStamp(vault);
  const tree = readPublicTree(vault);
  const members = structuredClone(vault.members);
  const byId = new Map<string, RoomMember>();
  const allIds = new Set<string>();
  for (const member of members) {
    if (allIds.has(member.deviceId)) fail();
    allIds.add(member.deviceId);
    if (active(member)) byId.set(member.deviceId, member);
  }
  if (byId.size !== tree.leaves.length) fail();
  const ownId = vault.identity.publicBundle.deviceId;
  const own = byId.get(ownId);
  const ownLeaf = tree.leaves.find(leaf => leaf.leafIndex === tree.ownLeaf);
  if (!own || own.role !== vault.role || ownLeaf?.binding.deviceId !== ownId ||
      canonicalStringify({ deviceId: own.deviceId, encryptionKey: own.encryptionKey, signingKey: own.signingKey, ...(own.mlsKeyPackage ? { mlsKeyPackage: own.mlsKeyPackage } : {}) }) !== canonicalStringify(vault.identity.publicBundle)) fail();
  for (const { binding } of tree.leaves) {
    const member = byId.get(binding.deviceId);
    if (!member) fail();
    const key = await crypto.subtle.importKey('jwk', member.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const body = { v: binding.v, deviceId: binding.deviceId, mlsSignatureKey: binding.mlsSignatureKey };
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(binding.bindingSignature), encoder.encode(canonicalStringify(body)))) fail();
  }
  // Async credential checks must not authorize a roster replaced while they ran.
  if (rosterStamp(vault) !== stamp) fail();
  verifiedRosters.set(vault, stamp);
  return members.filter(active);
}

/**
 * Build the call adapter from the real locally authenticated tree, then discard
 * its private MLS serialization. Calls need static device signaling keys and
 * public membership evidence, not application ratchets or pending epoch keys.
 */
export async function createAuthenticatedCallVault(vault: Vault): Promise<Vault> {
  const snapshot: Vault = {
    v: vault.v,
    roomId: vault.roomId,
    role: vault.role,
    accessToken: '',
    pairingSecret: '',
    creatorFingerprint: vault.creatorFingerprint,
    createdAt: vault.createdAt,
    lastSeq: 0,
    protocol: vault.protocol,
    members: structuredClone(vault.members),
    identity: {
      publicBundle: structuredClone(vault.identity.publicBundle),
      encryptionPrivateKey: structuredClone(vault.identity.encryptionPrivateKey),
      signingPrivateKey: structuredClone(vault.identity.signingPrivateKey),
    },
    mls: vault.mls ? { protocol: vault.mls.protocol, phase: vault.mls.phase, groupState: vault.mls.groupState } : undefined,
  };
  await authenticatedMlsCallMembers(snapshot);
  const tree = readPublicTree(snapshot);
  snapshot.mls = { protocol: 'mls-rfc9420', phase: 'active' };
  callSnapshotTrees.set(snapshot, tree);
  verifiedRosters.set(snapshot, rosterStamp(snapshot));
  return snapshot;
}

/** Cheap enough for signaling guards; changes to members/leaves invalidate the proof. */
export function isAuthenticatedCallRoster(vault: Vault): boolean {
  const expected = verifiedRosters.get(vault);
  if (!expected) return false;
  try { return rosterStamp(vault) === expected; } catch { return false; }
}

function publicBundle(member: PublicBundle): PublicBundle {
  return {
    deviceId: member.deviceId,
    encryptionKey: member.encryptionKey,
    signingKey: member.signingKey,
    ...(member.mlsKeyPackage ? { mlsKeyPackage: member.mlsKeyPackage } : {}),
  };
}

/**
 * A device attests its own local role and complete public bundle before socket
 * authentication. No peer metadata or active MLS group is needed for signing.
 * There is no expiry: identity metadata is immutable and verification requires
 * present membership in the receiver's authenticated MLS tree.
 */
export async function signCallIdentityAttestation(
  vault: Pick<Vault, 'roomId' | 'role' | 'identity'>,
): Promise<CallIdentityAttestation> {
  const bundle = structuredClone(publicBundle(vault.identity.publicBundle));
  if (!UUID.test(vault.roomId) || !UUID.test(bundle.deviceId) ||
      !['creator', 'joiner'].includes(vault.role) || bundle.encryptionKey.d || bundle.signingKey.d) fail();
  const unsigned: Omit<CallIdentityAttestation, 'signature'> = {
    protocol: CALL_IDENTITY_PROTOCOL,
    roomId: vault.roomId,
    deviceId: bundle.deviceId,
    role: vault.role,
    publicBundle: bundle,
  };
  const key = await crypto.subtle.importKey('jwk', vault.identity.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(canonicalStringify(unsigned)));
  return { ...unsigned, signature: toBase64Url(signature) };
}

/**
 * Bind bootstrap role/ECDH metadata to each online device's leaf-bound signing
 * identity before a local SDP is emitted. Missing devices are not candidates;
 * invalid supplied attestations fail the complete request rather than downgrade.
 */
export async function verifyCallIdentityAttestations(vault: Vault, values: unknown): Promise<string[]> {
  if (!isAuthenticatedCallRoster(vault) || !Array.isArray(values) || values.length > 6) fail();
  const initialStamp = verifiedRosters.get(vault);
  const peers: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        canonicalStringify(Object.keys(value).sort()) !== canonicalStringify(['deviceId', 'protocol', 'publicBundle', 'role', 'roomId', 'signature']) ||
        JSON.stringify(value).length > 96 * 1024) fail();
    const proof = value as CallIdentityAttestation;
    if (proof.protocol !== CALL_IDENTITY_PROTOCOL || proof.roomId !== vault.roomId ||
        typeof proof.deviceId !== 'string' || !UUID.test(proof.deviceId) || seen.has(proof.deviceId) ||
        !['creator', 'joiner'].includes(proof.role) || typeof proof.signature !== 'string' ||
        !/^[A-Za-z0-9_-]{86}$/.test(proof.signature) || fromBase64Url(proof.signature).length !== 64) fail();
    const member = vault.members.find(candidate => candidate.deviceId === proof.deviceId);
    if (!member || !active(member) || member.role !== proof.role ||
        canonicalStringify(proof.publicBundle) !== canonicalStringify(publicBundle(member))) fail();
    const { signature, ...unsigned } = proof;
    const key = await crypto.subtle.importKey('jwk', member.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(signature), encoder.encode(canonicalStringify(unsigned)))) fail();
    seen.add(proof.deviceId);
    if (proof.role !== vault.role) peers.push(proof.deviceId);
  }
  if (!isAuthenticatedCallRoster(vault) || verifiedRosters.get(vault) !== initialStamp) fail();
  return peers;
}
