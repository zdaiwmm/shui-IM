import { randomBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { generateIdentity } from './crypto';
import { fetchRecoveryBundle } from './cloud-backup';
import { getRoomState } from './api';
import { createCreatorMlsState, decryptMlsApplication, prepareCreatorWelcome, joinMlsGroup, signEcdsa, verifyEcdsa, verifyRecoveryMembershipChain } from './mls';
import { createJointRecoveryVault, discardJointRecovery, commitMlsReceive, finishJointRecovery, loadOutbox, loadUploadPlans, readStoredVault, saveVault, withVaultMutation, type VaultSession } from './vault';
import type { PlatformCredentialResult } from './platform-vault';
import type { Vault, RoomMember, RoomState, PrivateIdentity, PublicBundle, ServerMessage, MlsWelcomeEnvelope, MlsVaultState } from './types';
import type { RecoverySource } from './backup-types';

type Role = Vault['role'];
export type RecoveryScope = Record<Role, boolean>;
export type JointLink = { roomId: string; requestId: string; capability: string };
export type JointOffer = {
  v: 1; roomId: string; requestId: string; capabilityHash: string; expiresAt: string; baseEventSeq: number; sourceDeviceId: string;
  role: Role; target: PublicBundle; tokenHash: string; recover: boolean; deviceName: string; capabilities: string[];
  scope: RecoveryScope; signature: string;
};
export type JointProposal = { v: 1; roomId: string; requestId: string; expiresAt: string; baseEventSeq: number;
  offers: Record<Role, JointOffer>; retireOtherDevices: true; welcome: MlsWelcomeEnvelope };
export type JointSnapshot = { requestId: string; initiator: Role; expiresAt: string; baseEventSeq: number;
  offers: Partial<Record<Role, JointOffer>>; proposal: JointProposal | null; approvals: Partial<Record<Role, string>>;
  result: { eventSeq: number; nextSeq: number; nextReceiptSeq: number; completedAt: string } | null; state: RoomState };
export type PendingJointRecovery = {
  link: JointLink; initiator: Role; ownOffer: JointOffer; source: Vault; trustedMembers: RoomMember[];
  identity: PrivateIdentity; accessToken: string; recoverySource: RecoverySource; preserveHistory: boolean;
  proposal?: JointProposal; mls?: MlsVaultState; approved?: boolean;
};
const roles: Role[] = ['creator', 'joiner'];
const same = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);
const invalid = () => new Error('恢复身份或双方确认内容不一致，已停止恢复');
export function jointRecoveryUrl(link: JointLink): string {
  const url = new URL(location.pathname, location.origin); url.hash = `recover=${encodeURIComponent(JSON.stringify(link))}`; return url.href;
}
export function parseJointRecoveryLink(value: string): JointLink | null {
  try {
    const url = new URL(value, location.origin);
    const data = JSON.parse(new URLSearchParams(url.hash.slice(1)).get('recover') ?? 'null') as JointLink | null;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    return data && uuid.test(data.roomId) && uuid.test(data.requestId) && /^[A-Za-z0-9_-]{43}$/.test(data.capability) ? data : null;
  } catch { return null; }
}
export async function jointRequest(link: JointLink, signal: AbortSignal, action?: string, value?: unknown): Promise<JointSnapshot> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const response = await fetch(`/api/rooms/${link.roomId}/joint-recovery${action === 'create' ? '' : `/${link.requestId}`}`, {
    method: action ? 'POST' : 'GET', headers: { Authorization: `Bearer ${link.capability}`, 'Content-Type': 'application/json' },
    ...(action ? { body: JSON.stringify(action === 'create' ? { offer: value } : { action, [action === 'participate' ? 'offer' : action === 'propose' ? 'proposal' : 'approval']: value }) } : {}), signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.code === 'RECOVERY_EXPIRED' ? '恢复邀请已过期，请重新发起' : error.code === 'MLS_EVENT_STALE' ? '设备列表已变化，请重新发起恢复' : error.error ?? '恢复连接暂时不可用，请重试');
  }
  return response.json();
}

export async function prepareJointRecovery(code: string, requestedScope: 'me' | 'peer' | 'both', link: JointLink | null,
  helper: VaultSession | null, credential: PlatformCredentialResult | undefined, deviceName: string, capabilities: string[], signal: AbortSignal): Promise<VaultSession> {
  const expected = await readStoredVault();
  const bundle = await fetchRecoveryBundle(code, signal);
  const source = bundle.checkpoint;
  const snapshot = link ? await jointRequest(link, signal) : null;
  if (snapshot?.result || (link && link.roomId !== source.roomId) || snapshot?.offers[source.role]) throw invalid();
  const state = snapshot?.state ?? await getRoomState(source.roomId, source.accessToken);
  signal.throwIfAborted();
  // Authenticate the roster from this participant's own checkpoint; never trust an unsigned server roster.
  await verifyRecoveryMembershipChain({ ...source, pendingRecovery: { request: {} as never, checkpointMembers: source.members,
    checkpointEventSeq: source.mls?.lastEventSeq ?? 0 } }, state);
  if (!state.members.some(member => member.deviceId === source.identity.publicBundle.deviceId && member.role === source.role && member.status === 'active')) throw invalid();
  if (helper && (helper.vault.roomId !== source.roomId || helper.vault.role !== source.role || helper.vault.identity.publicBundle.deviceId !== source.identity.publicBundle.deviceId || helper.vault.pendingJointRecovery)) throw invalid();
  const scope: RecoveryScope = { creator: requestedScope === 'both', joiner: requestedScope === 'both' };
  const peer = source.role === 'creator' ? 'joiner' : 'creator';
  if (requestedScope === 'me') scope[source.role] = true;
  if (requestedScope === 'peer') scope[peer] = true;
  if (snapshot) { scope[peer] = snapshot.offers[peer]!.recover; scope[source.role] = requestedScope !== 'peer'; }
  if (!scope.creator && !scope.joiner) throw new Error('至少一位参与者需要恢复');
  if (!scope[source.role] && !helper) throw new Error('协助恢复需要先解锁自己的现有会话');
  const preserveHistory = Boolean(helper && !scope[source.role]);
  if (preserveHistory && (helper!.vault.mls?.lastEventSeq ?? 0) !== (state.nextMlsEventSeq ?? 0)) throw new Error('设备变更尚未同步，请回到会话完成同步后重试');
  if (preserveHistory && ((await loadOutbox(helper!)).length || (await loadUploadPlans(helper!)).length)) throw new Error('请先完成或取消待发送内容，再协助恢复');
  const identity = await generateIdentity(), accessToken = randomBase64Url(32);
  const actualLink = link ?? { roomId: source.roomId, requestId: crypto.randomUUID(), capability: randomBase64Url(32) };
  const unsigned: Omit<JointOffer, 'signature'> = { v: 1, roomId: source.roomId, requestId: actualLink.requestId,
    capabilityHash: toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(actualLink.capability))),
    expiresAt: snapshot?.expiresAt ?? new Date(Date.now() + 14 * 60_000).toISOString(), baseEventSeq: snapshot?.baseEventSeq ?? state.nextMlsEventSeq ?? 0,
    sourceDeviceId: source.identity.publicBundle.deviceId, role: source.role, target: identity.publicBundle,
    tokenHash: toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))), recover: scope[source.role], scope,
    deviceName, capabilities: [...new Set([...capabilities, 'joint-recovery-v1'])] };
  const ownOffer: JointOffer = { ...unsigned, signature: await signEcdsa(source.identity.signingPrivateKey, unsigned) };
  const pending: PendingJointRecovery = { link: actualLink, initiator: snapshot?.initiator ?? source.role, ownOffer, source,
    trustedMembers: state.members, identity, accessToken, preserveHistory,
    recoverySource: { ...(preserveHistory ? { resumeCursor: Math.max(0, ...bundle.archives.flatMap(archive => archive.parts.map(part => part.lastSeq))) } : {}), backupId: bundle.backupId, archives: bundle.archives, galleryHidden: bundle.galleryHidden } };
  signal.throwIfAborted();
  let session: VaultSession;
  if (preserveHistory) {
    session = helper!;
    await withVaultMutation(session, async mutation => { signal.throwIfAborted(); session.vault.pendingJointRecovery = pending; await saveVault(session, mutation); });
  } else {
    if (!credential) throw new Error('请先为本机创建通行密钥');
    const vault = { ...source, identity, accessToken, pendingJointRecovery: pending, pairingState: 'ready' as const,
      mls: { protocol: 'mls-rfc9420' as const, phase: 'awaiting-welcome' as const }, lastSeq: 0, lastReceiptSeq: 0 };
    delete vault.backup; delete vault.pendingRecovery; delete vault.recoverySource;
    session = await createJointRecoveryVault(vault, credential, expected, signal);
  }
  // Persist target keys before the first server mutation. Lost responses resume with the same offer and identity.
  return session;
}

export function jointMembers(offers: Record<Role, JointOffer>, result?: JointSnapshot['result']): RoomMember[] {
  return roles.map(role => ({ ...offers[role].target, role, status: 'active', joinProof: null,
    addedBy: offers[role].sourceDeviceId, deviceName: offers[role].deviceName, capabilities: offers[role].capabilities,
    joinSeq: result?.nextSeq ?? 0, joinReceiptSeq: result?.nextReceiptSeq ?? 0 }));
}
export async function verifyJointSnapshot(pending: PendingJointRecovery, snapshot: JointSnapshot): Promise<void> {
  if (snapshot.requestId !== pending.link.requestId || snapshot.baseEventSeq !== pending.ownOffer.baseEventSeq ||
      snapshot.expiresAt !== pending.ownOffer.expiresAt || snapshot.initiator !== pending.initiator ||
      !same(snapshot.offers[pending.ownOffer.role], pending.ownOffer)) throw invalid();
  for (const role of roles) {
    const offer = snapshot.offers[role]; if (!offer) continue;
    const source = pending.trustedMembers.find(member => member.deviceId === offer.sourceDeviceId && member.role === role && member.status === 'active');
    const { signature, ...unsigned } = offer;
    if (!source || offer.role !== role || offer.roomId !== pending.link.roomId || offer.requestId !== pending.link.requestId ||
        offer.capabilityHash !== pending.ownOffer.capabilityHash || offer.baseEventSeq !== pending.ownOffer.baseEventSeq || offer.expiresAt !== pending.ownOffer.expiresAt ||
        offer.recover !== offer.scope[role] || !await verifyEcdsa(source.signingKey, signature, unsigned)) throw invalid();
  }
  if (snapshot.proposal) {
    const p = snapshot.proposal;
    if (p.v !== 1 || p.roomId !== pending.link.roomId || p.requestId !== pending.link.requestId ||
        p.expiresAt !== snapshot.expiresAt || p.baseEventSeq !== snapshot.baseEventSeq || !p.retireOtherDevices ||
        !same(p.offers, snapshot.offers) || !roles.every(role => p.offers[role]) || !roles.some(role => p.offers[role].recover) ||
        (pending.proposal && !same(pending.proposal, p))) throw invalid();
    for (const role of roles) if (snapshot.approvals[role]) {
      const member = pending.trustedMembers.find(member => member.deviceId === p.offers[role].sourceDeviceId)!;
      if (!await verifyEcdsa(member.signingKey, snapshot.approvals[role]!, p)) throw invalid();
    }
  } else if (snapshot.result || Object.keys(snapshot.approvals).length) throw invalid();
  if (snapshot.result && (!roles.every(role => snapshot.approvals[role]) || snapshot.result.eventSeq !== snapshot.baseEventSeq + 1 ||
      !Number.isSafeInteger(snapshot.result.nextSeq) || snapshot.result.nextSeq < 0 ||
      !Number.isSafeInteger(snapshot.result.nextReceiptSeq) || snapshot.result.nextReceiptSeq < 0)) throw invalid();
}

export async function advanceJointRecovery(session: VaultSession, signal: AbortSignal): Promise<JointSnapshot> {
  const pending = session.vault.pendingJointRecovery; if (!pending) throw invalid();
  let snapshot = await jointRequest(pending.link, signal, pending.initiator === pending.ownOffer.role ? 'create' : 'participate', pending.ownOffer);
  await verifyJointSnapshot(pending, snapshot);
  if (roles.every(role => snapshot.offers[role])) {
    const offers = snapshot.offers as Record<Role, JointOffer>;
    if (pending.ownOffer.role === 'creator' && !snapshot.proposal && !snapshot.result) {
      if (!pending.proposal) {
        const fresh: Vault = { ...pending.source, identity: pending.identity, members: jointMembers(offers),
          mls: await createCreatorMlsState(pending.link.roomId, pending.identity, jointMembers(offers)) };
        const mls = await prepareCreatorWelcome(fresh);
        const proposal: JointProposal = { v: 1, ...pending.link, expiresAt: pending.ownOffer.expiresAt,
          baseEventSeq: pending.ownOffer.baseEventSeq, offers, retireOtherDevices: true, welcome: mls.pendingWelcome! };
        // The link capability is never included in signed proposals or public member records.
        delete (proposal as unknown as Record<string, unknown>).capability;
        await withVaultMutation(session, async mutation => { signal.throwIfAborted(); pending.proposal = proposal; pending.mls = mls; await saveVault(session, mutation); });
      }
      snapshot = await jointRequest(pending.link, signal, 'propose', pending.proposal);
      await verifyJointSnapshot(pending, snapshot);
    }
    if (snapshot.proposal && !pending.mls) {
      const mls = await joinMlsGroup({ ...pending.source, identity: pending.identity, members: jointMembers(offers) }, snapshot.proposal.welcome);
      await withVaultMutation(session, async mutation => { signal.throwIfAborted(); pending.proposal = snapshot.proposal!; pending.mls = mls; await saveVault(session, mutation); });
    }
  }
  return snapshot;
}
export async function approveJointRecovery(session: VaultSession, snapshot: JointSnapshot, signal: AbortSignal): Promise<JointSnapshot> {
  const pending = session.vault.pendingJointRecovery; if (!pending || !pending.mls || !snapshot.proposal) throw invalid();
  await verifyJointSnapshot(pending, snapshot);
  const signature = await signEcdsa(pending.source.identity.signingPrivateKey, snapshot.proposal);
  // The user's explicit scope confirmation is durably recorded before transmission.
  await withVaultMutation(session, async mutation => { signal.throwIfAborted(); pending.approved = true; await saveVault(session, mutation); });
  const next = await jointRequest(pending.link, signal, 'approve', { role: pending.ownOffer.role, signature });
  await verifyJointSnapshot(pending, next); return next;
}
export async function completeJointRecovery(session: VaultSession, snapshot: JointSnapshot, signal: AbortSignal): Promise<void> {
  const pending = session.vault.pendingJointRecovery; if (!pending?.mls || !pending.approved || !snapshot.result || !snapshot.proposal) throw invalid();
  await verifyJointSnapshot(pending, snapshot);
  if (pending.preserveHistory) {
    // Fetch only this helper's pre-reset permission range. Recovered participants cannot use this endpoint.
    while (session.vault.lastSeq < snapshot.result.nextSeq) {
      const response = await fetch(`/api/rooms/${pending.link.roomId}/joint-recovery/${pending.link.requestId}/catch-up?after=${session.vault.lastSeq}`, {
        headers: { Authorization: `Bearer ${pending.accessToken}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      });
      if (!response.ok) throw new Error('协助期间的消息尚未同步，请重试完成恢复');
      const { messages } = await response.json() as { messages: ServerMessage[] };
      if (!Array.isArray(messages) || !messages.length || messages.length > 100) throw new Error('协助期间的消息不完整，已保留本机恢复状态');
      for (const message of messages) await withVaultMutation(session, async mutation => {
        signal.throwIfAborted();
        if (message.seq !== session.vault.lastSeq + 1 || message.seq > snapshot.result!.nextSeq || message.envelope.v !== 2) throw invalid();
        const opened = await decryptMlsApplication(session.vault, message.envelope);
        const sender = session.vault.members.find(member => member.deviceId === message.envelope.senderId);
        if ((opened.payload.kind === 'gallery-image' || opened.payload.kind === 'gallery-file') && sender?.role !== 'creator') throw invalid();
        const previousSeq = session.vault.lastSeq;
        session.vault.lastSeq = message.seq;
        try { await commitMlsReceive(session, { seq: message.seq, clientMsgId: message.envelope.clientMsgId, senderId: message.envelope.senderId,
          payload: opened.payload, acceptedAt: message.acceptedAt, status: sender?.role === session.vault.role ? 'stored' : 'delivered' }, opened.nextGroupState, undefined, mutation); }
        catch (error) { session.vault.lastSeq = previousSeq; throw error; }
      });
    }
  }
  const members: RoomMember[] = [...pending.trustedMembers.map(member => ({ ...member, status: 'revoked' as const })), ...jointMembers(snapshot.proposal.offers, snapshot.result)];
  const next: Vault = { ...session.vault, identity: pending.identity, accessToken: pending.accessToken, members,
    creatorFingerprint: pending.source.creatorFingerprint, pairingSecret: '', pairingState: 'ready',
    mls: { ...pending.mls, pendingWelcome: undefined, lastEventSeq: snapshot.result.eventSeq },
    lastSeq: snapshot.result.nextSeq, lastReceiptSeq: snapshot.result.nextReceiptSeq,
    historyUnavailableBeforeSeq: snapshot.result.nextSeq, recoverySource: pending.recoverySource,
    recoveryExperience: { ...session.vault.recoveryExperience, completed: pending.preserveHistory ? 'helper' : 'recovered', codeSaved: undefined } };
  delete next.pendingJointRecovery; delete next.pendingRecovery; delete next.pendingRepair; delete next.pendingDeviceLinks;
  delete next.pendingDeviceLinkId; delete next.inviteToken; delete next.backup; delete next.historyRestoreTask;
  delete next.identity.mlsPrivatePackage;
  await finishJointRecovery(session, next, signal);
}

export async function cancelJointRecovery(session: VaultSession, signal: AbortSignal): Promise<'helper' | 'discarded' | JointSnapshot> {
  const pending = session.vault.pendingJointRecovery; if (!pending) throw invalid();
  const unsigned = { v: 1, roomId: pending.link.roomId, requestId: pending.link.requestId, action: 'cancel', role: pending.ownOffer.role };
  const result = await jointRequest(pending.link, signal, 'cancel', { role: pending.ownOffer.role, signature: await signEcdsa(pending.source.identity.signingPrivateKey, unsigned) });
  if ((result as unknown as { cancelled?: boolean }).cancelled !== true) { await verifyJointSnapshot(pending, result); return result; }
  return await discardJointRecovery(session, signal) ? 'helper' : 'discarded';
}
