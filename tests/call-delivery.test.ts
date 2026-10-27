import { describe, expect, it } from 'vitest';
import { createCallService } from '../server/calls.mjs';
import { CallController } from '../src/lib/call-controller';
import { CallSignalQueue } from '../src/lib/call-signal-queue';
import { sealCallSignal } from '../src/lib/call-crypto';
import { authenticatedMlsCallMembers } from '../src/lib/call-membership';
import { generateIdentity } from '../src/lib/crypto';
import { prepareMlsMembership, processMlsMembership } from '../src/lib/mls';
import { CALL_CAPABILITY, type CallEnvelope, type CallKind, type CallServerEvent } from '../src/lib/call-types';
import type { Vault } from '../src/lib/types';
import { pair, SDP } from './helpers/call-harness';

/** Real MLS identities, encrypted signaling, delivery acknowledgements and server arbitration.
 * Socket delivery and browser media use synthetic fixtures; no production network is contacted. */
async function delivery(kind: CallKind, mode: 'offline' | 'accepted' | 'accept-race') {
  const { a, b } = await pair();
  const extraIdentity = await generateIdentity();
  const extra = { ...extraIdentity.publicBundle, role: 'joiner' as const, status: 'active' as const,
    joinProof: null, addedBy: b.identity.publicBundle.deviceId, capabilities: [CALL_CAPABILITY] };
  const added = await prepareMlsMembership(b, 'add', extra);
  const vault: Vault = { ...a, members: [...a.members, extra], mls: { ...a.mls! } };
  vault.mls!.groupState = await processMlsMembership(vault, added.event, 1);
  vault.mls!.lastEventSeq = 1;
  await authenticatedMlsCallMembers(vault);
  type Frame = { type: string; envelope?: CallEnvelope; state?: string; code?: string; callId?: string; eventId?: string };
  const sockets = vault.members.map(() => ({ open: true, frames: [] as Frame[] }));
  const sessions = vault.members.map(member => ({ roomId: vault.roomId, deviceId: member.deviceId, role: member.role }));
  let controller!: CallController;
  let queue!: CallSignalQueue;
  let received: Promise<void> = Promise.resolve();
  const service = createCallService({
    store: { getMember: (room: string, id: string) => room === vault.roomId ? vault.members.find(member => member.deviceId === id) : null,
      deviceRecoveryPending: () => false },
    clientsByRoom: new Map([[vault.roomId, new Set(sockets)]]),
    socketSessions: new WeakMap(sockets.map((socket, index) => [socket, sessions[index]])),
    isOpen: (socket: typeof sockets[number]) => socket.open,
    send: (socket: typeof sockets[number], frame: Frame) => {
      socket.frames.push(frame);
      if (socket !== sockets[0]) return;
      if (frame.type === 'call-ack') queue.acknowledge(frame.callId!, frame.eventId!);
      if (frame.type === 'call-state') {
        if (frame.state === 'error' && frame.eventId) queue.reject(frame.callId!, frame.eventId, frame.code!);
        controller.serverEvent(frame as CallServerEvent);
      }
      if (frame.type === 'call') received = controller.receive(frame.envelope!);
    },
  });
  queue = new CallSignalQueue(envelope => {
    void service.handle(sockets[0], sessions[0], { type: 'call', envelope });
    return true;
  });
  let accepted = false;
  const accept = async (callId: string) => {
    if (accepted) return;
    accepted = true;
    const envelope = await sealCallSignal(b, a.identity.publicBundle.deviceId, callId, 'accept', { kind, description: { type: 'answer', sdp: SDP } });
    await service.handle(sockets[1], sessions[1], { type: 'call', envelope });
  };
  const attempts: CallEnvelope[] = [];
  controller = new CallController({
    getVault: () => vault,
    getIceConfig: async () => {
      // Both proofs were live when configuration was verified; the first endpoint then drops.
      if (mode === 'offline') sockets[1]!.open = false;
      return { iceServers: [], iceTransportPolicy: 'all', relayConfigured: false,
        verifiedPeerIds: [b.identity.publicBundle.deviceId, extra.deviceId] };
    },
    onChange: () => {}, onPermissionChange: () => {}, cancelSignals: callId => queue.cancel(callId),
    send: async envelope => {
      attempts.push(envelope);
      if (mode === 'accept-race' && envelope.action === 'invite' && envelope.recipientId === extra.deviceId) await accept(envelope.callId);
      await queue.send(envelope);
      if (mode === 'accepted' && envelope.action === 'invite') await accept(envelope.callId);
    },
  });
  try {
    await controller.start(kind);
    await received;
    const invitations = attempts.filter(envelope => envelope.action === 'invite');
    expect(controller.active).toBe(true);
    expect(sockets[0]!.frames.some(frame => frame.state === 'ended')).toBe(false);
    if (mode === 'offline') {
      expect(invitations.map(envelope => envelope.recipientId)).toEqual([b.identity.publicBundle.deviceId, extra.deviceId]);
      expect(sockets[2]!.frames.some(frame => frame.envelope?.action === 'invite')).toBe(true);
    } else {
      expect(controller.state.phase).toBe('connecting');
      expect(invitations.filter(envelope => envelope.recipientId === extra.deviceId)).toHaveLength(mode === 'accepted' ? 0 : 1);
    }
  } finally {
    await controller.hangup(); controller.destroy(); queue.close(); service.close();
  }
}

describe('call invitation delivery across controller, acknowledgement queue and server', () => {
  for (const kind of ['audio', 'video'] as const) {
    it(`${kind}: still invites the next device after a verified endpoint disconnects`, () => delivery(kind, 'offline'));
    it(`${kind}: stops inviting siblings once the server selects a device`, () => delivery(kind, 'accepted'));
    it(`${kind}: retains the winner when an in-flight sibling invite is rejected`, () => delivery(kind, 'accept-race'));
  }
});
