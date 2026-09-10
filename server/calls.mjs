import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { isUuid, verifyEnvelopeSignature } from './protocol.mjs';

const CAPABILITY = 'webrtc-call-v1';
const ENVELOPE_KEYS = ['action', 'callId', 'ciphertext', 'createdAt', 'eventId', 'expiresAt', 'iv', 'protocol', 'recipientId', 'roomId', 'senderId', 'signature', 'v'];
const ACTIONS = new Set(['invite', 'accept', 'signal', 'decline', 'end']);
const MAX_TTL_MS = 60_000;
const CLOCK_SKEW_MS = 10_000;
const RING_MS = 45_000;
const TRANSPORT_GRACE_MS = 30_000;
const RETENTION_MS = MAX_TTL_MS + CLOCK_SKEW_MS;
const MAX_REPLAY_ENTRIES = 20_000;

function canonicalBase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length >= minimum && bytes.length <= maximum && bytes.toString('base64url') === value;
}

export function validateCallEnvelope(envelope, roomId, now = Date.now()) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(ENVELOPE_KEYS) ||
      envelope.v !== 1 || envelope.protocol !== 'quiet-room-call-v1' || envelope.roomId !== roomId ||
      !['roomId', 'callId', 'eventId', 'senderId', 'recipientId'].every((key) => isUuid(envelope[key])) ||
      envelope.senderId === envelope.recipientId || !ACTIONS.has(envelope.action) ||
      !Number.isSafeInteger(envelope.createdAt) || !Number.isSafeInteger(envelope.expiresAt) ||
      envelope.createdAt <= 0 || envelope.expiresAt <= envelope.createdAt ||
      envelope.expiresAt - envelope.createdAt > MAX_TTL_MS ||
      !canonicalBase64(envelope.iv, 12, 12) || !canonicalBase64(envelope.ciphertext, 16, 64 * 1024) ||
      !canonicalBase64(envelope.signature, 64, 64)) return 'INVALID_CALL';
  if (envelope.expiresAt <= now || envelope.createdAt > now + CLOCK_SKEW_MS || envelope.createdAt < now - MAX_TTL_MS) return 'CALL_EXPIRED';
  return null;
}

function parseUrls(value, allowedSchemes) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || value.length > 4096) throw new Error('CALL_CONFIG_INVALID');
  const urls = value.split(',').map((url) => url.trim());
  if (urls.length > 8 || urls.some((url) => !url)) throw new Error('CALL_CONFIG_INVALID');
  for (const url of urls) {
    // RTCIceServer URLs have a scheme and host, but no //, userinfo, path or fragment.
    const match = /^(stun|stuns|turn|turns):((?:\[[0-9a-fA-F:]+\])|(?:[a-zA-Z0-9.-]+))(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(url);
    if (!match || !allowedSchemes.includes(match[1])) throw new Error('CALL_CONFIG_INVALID');
    const [, scheme, host, port, transport] = match;
    if ((port && (Number(port) < 1 || Number(port) > 65535)) ||
        ((scheme === 'stun' || scheme === 'stuns') && transport) ||
        (scheme === 'turns' && transport === 'udp')) throw new Error('CALL_CONFIG_INVALID');
    if (host.startsWith('[')) {
      if (isIP(host.slice(1, -1)) !== 6) throw new Error('CALL_CONFIG_INVALID');
    } else if (host.length > 253 || !host.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
      throw new Error('CALL_CONFIG_INVALID');
    }
  }
  return [...new Set(urls)];
}

/** Only an authenticated route may call this. Credentials never contain a device ID. */
export function callIceConfiguration(options = {}, now = Date.now()) {
  const stunUrls = parseUrls(options.callStunUrls ?? process.env.CALL_STUN_URLS ?? '', ['stun', 'stuns']);
  const turnUrls = parseUrls(options.turnUrls ?? process.env.TURN_URLS ?? '', ['turn', 'turns']);
  const secret = options.turnSecret ?? process.env.TURN_SECRET ?? '';
  const relaySetting = options.callRelayOnly ?? process.env.CALL_RELAY_ONLY ?? false;
  if (![true, false, 'true', 'false', '1', '0', ''].includes(relaySetting)) throw new Error('CALL_CONFIG_INVALID');
  const relayOnly = relaySetting === true || relaySetting === 'true' || relaySetting === '1';
  if (typeof secret !== 'string' || (turnUrls.length > 0 && !/^[A-Za-z0-9_-]{32,512}$/.test(secret)) ||
      (secret && turnUrls.length === 0) || (relayOnly && turnUrls.length === 0)) throw new Error('CALL_CONFIG_INVALID');
  const iceServers = stunUrls.length ? [{ urls: stunUrls }] : [];
  if (turnUrls.length) {
    // Two hours covers ordinary long calls without expiring allocation refreshes.
    const username = `${Math.floor(now / 1000) + 2 * 60 * 60}:${randomBytes(16).toString('base64url')}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }
  return { iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all', relayConfigured: turnUrls.length > 0 };
}

/** Ephemeral single-call arbitration. No SDP, candidate or ciphertext is persisted. */
export function createCallService({ store, clientsByRoom, socketSessions, send, isOpen }) {
  const calls = new Map();
  const seen = new Map();
  const ended = new Map();
  const rates = new Map();

  function memberActive(roomId, deviceId) {
    const member = store.getMember(roomId, deviceId);
    return member?.status === 'active' && !store.deviceRecoveryPending(roomId, deviceId) ? member : null;
  }
  function socketActive(socket, roomId, deviceId) {
    const session = socketSessions.get(socket);
    return isOpen(socket) && session?.roomId === roomId && session.deviceId === deviceId && memberActive(roomId, deviceId);
  }
  function deliver(socket, frame) {
    // Do not accumulate encrypted media negotiation behind a stalled connection.
    if ((socket.bufferedAmount ?? 0) > 512 * 1024) {
      socket.close?.(4429, 'Call transport backpressure');
      return false;
    }
    send(socket, frame);
    return true;
  }
  function state(socket, callId, value, code, acceptedBy, recipientId) {
    deliver(socket, { type: 'call-state', callId, state: value, ...(code ? { code } : {}), ...(acceptedBy ? { acceptedBy } : {}), ...(recipientId ? { recipientId } : {}) });
  }
  function broadcast(call, value, code) {
    for (const socket of clientsByRoom.get(call.roomId) ?? []) {
      const session = socketSessions.get(socket);
      if (session && socketActive(socket, call.roomId, session.deviceId)) state(socket, call.callId, value, code, call.acceptedBy);
    }
  }
  function finish(call, code) {
    if (calls.get(call.roomId) !== call) return;
    calls.delete(call.roomId);
    clearTimeout(call.timer);
    ended.set(`${call.roomId}:${call.callId}`, Date.now() + RETENTION_MS);
    broadcast(call, 'ended', code);
  }
  function cleanup() {
    const now = Date.now();
    for (const map of [seen, ended]) for (const [key, expiry] of map) if (expiry <= now) map.delete(key);
    for (const [key, rate] of rates) if (rate.until <= now) rates.delete(key);
    for (const call of calls.values()) {
      const callerDetachedUntil = call.detachedUntil.get(call.callerId) ?? 0;
      const calleeDetachedUntil = call.acceptedBy ? (call.detachedUntil.get(call.acceptedBy) ?? 0) : 0;
      if ((!socketActive(call.callerSocket, call.roomId, call.callerId) && callerDetachedUntil <= now) ||
          (call.acceptedBy && !socketActive(call.calleeSocket, call.roomId, call.acceptedBy) && calleeDetachedUntil <= now)) finish(call, 'CALL_DEVICE_INACTIVE');
      else if (!call.acceptedBy && call.ringUntil <= now) finish(call, 'CALL_TIMEOUT');
    }
  }
  const cleanupTimer = setInterval(cleanup, 5000);
  cleanupTimer.unref?.();

  function availableSocket(roomId, recipientId) {
    const member = memberActive(roomId, recipientId);
    if (!member?.capabilities?.includes(CAPABILITY)) return null;
    // One tab per device receives an invitation; a second tab cannot win its acceptance.
    return [...(clientsByRoom.get(roomId) ?? [])].reverse().find((socket) => socketActive(socket, roomId, recipientId)) ?? null;
  }
  function allow(session) {
    const key = `${session.roomId}:${session.deviceId}`;
    const now = Date.now();
    let rate = rates.get(key);
    if (!rate || rate.until <= now) { rate = { count: 0, until: now + 60_000 }; rates.set(key, rate); }
    return ++rate.count <= 180;
  }

  async function handle(socket, session, frame) {
    const envelope = frame.envelope;
    const callId = isUuid(envelope?.callId) ? envelope.callId : '';
    const failedRecipient = envelope?.action === 'invite' && isUuid(envelope.recipientId) ? envelope.recipientId : undefined;
    const fail = (code) => state(socket, callId, 'error', code, undefined, failedRecipient);
    if (!allow(session)) return fail('CALL_RATE_LIMITED');
    if (Object.keys(frame).length !== 2 || frame.type !== 'call') return fail('INVALID_CALL');
    const invalid = validateCallEnvelope(envelope, session.roomId);
    if (invalid) return fail(invalid);
    const sender = memberActive(session.roomId, session.deviceId);
    if (!sender || envelope.senderId !== session.deviceId || !socketActive(socket, session.roomId, session.deviceId)) return fail('CALL_FORBIDDEN');
    if (!(await verifyEnvelopeSignature(envelope, sender.signingKey))) return fail('INVALID_CALL_SIGNATURE');
    // Signature verification yields. Recheck identity, expiry and membership before arbitration.
    const stale = validateCallEnvelope(envelope, session.roomId);
    if (stale) return fail(stale);
    if (!socketActive(socket, session.roomId, session.deviceId)) return fail('CALL_DEVICE_INACTIVE');
    const recipient = store.getMember(session.roomId, envelope.recipientId);
    if (!recipient || recipient.role === sender.role || !sender.capabilities?.includes(CAPABILITY) ||
        (envelope.action !== 'end' && !memberActive(session.roomId, envelope.recipientId))) return fail('CALL_FORBIDDEN');
    cleanup();
    const eventKey = `${session.roomId}:${envelope.eventId}`;
    if (seen.has(eventKey)) return fail('CALL_REPLAY');
    if (seen.size >= MAX_REPLAY_ENTRIES || ended.size >= MAX_REPLAY_ENTRIES) return fail('CALL_RATE_LIMITED');
    seen.set(eventKey, envelope.expiresAt + CLOCK_SKEW_MS);
    if (ended.has(`${session.roomId}:${callId}`)) return fail('CALL_NOT_FOUND');
    let call = calls.get(session.roomId);

    if (envelope.action === 'invite') {
      // A lifecycle teardown may close the transport before its encrypted end
      // frame arrives. A fresh call from the same authenticated device is an
      // explicit replacement of that detached stale attempt; a matching
      // callId still follows the normal reconnect path below.
      if (call && call.callId !== callId && call.callerId === session.deviceId &&
          !socketActive(call.callerSocket, call.roomId, call.callerId) &&
          (call.detachedUntil.get(session.deviceId) ?? 0) > Date.now()) {
        finish(call, 'CALL_DISCONNECTED');
        call = null;
      }
      if (call && (call.callId !== callId || call.callerId !== session.deviceId || call.callerSocket !== socket)) return fail('CALL_BUSY');
      if (call?.acceptedBy) return fail('CALL_ALREADY_ACCEPTED');
      const recipientSocket = availableSocket(session.roomId, envelope.recipientId);
      if (!recipientSocket) return fail('CALL_UNAVAILABLE');
      if (call?.invited.has(envelope.recipientId)) return fail('CALL_REPLAY');
      if (!call) {
        call = { roomId: session.roomId, callId, callerId: session.deviceId, callerSocket: socket, invited: new Map(), detachedUntil: new Map(), ringUntil: Date.now() + RING_MS };
        call.timer = setTimeout(() => finish(call, 'CALL_TIMEOUT'), RING_MS);
        call.timer.unref?.();
        calls.set(session.roomId, call);
      }
      call.invited.set(envelope.recipientId, recipientSocket);
      deliver(recipientSocket, { type: 'call', envelope });
      state(socket, callId, 'ringing');
      return;
    }
    if (!call || call.callId !== callId) return fail('CALL_NOT_FOUND');
    const fromCaller = session.deviceId === call.callerId && socket === call.callerSocket;
    const invitedSocket = call.invited.get(session.deviceId);
    const invitedCallee = invitedSocket === socket && envelope.recipientId === call.callerId;
    if (envelope.action === 'accept') {
      if (!invitedCallee) return fail('CALL_FORBIDDEN');
      if (call.acceptedBy) return fail('CALL_ALREADY_ACCEPTED');
      call.acceptedBy = session.deviceId;
      call.calleeSocket = socket;
      clearTimeout(call.timer);
      // Set and publish selection synchronously before forwarding the encrypted answer.
      broadcast(call, 'accepted');
      deliver(call.callerSocket, { type: 'call', envelope });
      return;
    }
    if (envelope.action === 'decline') {
      if (!invitedCallee || call.acceptedBy) return fail('CALL_FORBIDDEN');
      deliver(call.callerSocket, { type: 'call', envelope });
      finish(call, 'CALL_DECLINED');
      return;
    }
    if (envelope.action === 'end' && fromCaller) {
      // Cancellation may have been encrypted for another ringing sibling just
      // before the winning acceptance reached the caller. The authenticated
      // caller always owns cancellation; never forward ciphertext to a different
      // recipient, and use the global ended state to stop the selected device.
      const target = call.invited.get(envelope.recipientId);
      if (target) deliver(target, { type: 'call', envelope });
      finish(call, 'CALL_ENDED');
      return;
    }
    const fromCallee = session.deviceId === call.acceptedBy && socket === call.calleeSocket;
    const targetId = fromCaller ? call.acceptedBy : call.callerId;
    if (!call.acceptedBy || (!fromCaller && !fromCallee) || envelope.recipientId !== targetId) return fail('CALL_FORBIDDEN');
    deliver(fromCaller ? call.calleeSocket : call.callerSocket, { type: 'call', envelope });
    if (envelope.action === 'end') finish(call, 'CALL_ENDED');
  }

  return {
    handle,
    sweep: cleanup,
    rebind(socket, session) {
      const call = calls.get(session.roomId);
      if (!call) return;
      if (call.callerId === session.deviceId) {
        call.callerSocket = socket;
        call.detachedUntil.delete(session.deviceId);
      }
      if (call.acceptedBy === session.deviceId) {
        call.calleeSocket = socket;
        call.detachedUntil.delete(session.deviceId);
      }
      if (call.invited.has(session.deviceId)) {
        call.invited.set(session.deviceId, socket);
        call.detachedUntil.delete(session.deviceId);
      }
    },
    disconnect(socket) {
      const session = socketSessions.get(socket);
      const call = session && calls.get(session.roomId);
      if (!call) return;
      const deviceId = session.deviceId;
      if (call.callerSocket === socket || call.calleeSocket === socket || call.invited.get(deviceId) === socket) {
        call.detachedUntil.set(deviceId, Date.now() + TRANSPORT_GRACE_MS);
      }
    },
    close() {
      clearInterval(cleanupTimer);
      for (const call of calls.values()) clearTimeout(call.timer);
      calls.clear(); seen.clear(); ended.clear(); rates.clear();
    },
  };
}
