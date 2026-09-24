import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalStringify, isUuid, validatePublicBundle, verifyEnvelopeSignature } from './protocol.mjs';

const hash = value => createHash('sha256').update(value).digest();
const fail = () => { throw new Error('INVALID_RECOVERY_REQUEST'); };
const roles = ['creator', 'joiner'];
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && Object.keys(value).sort().join(',') === names.split(' ').sort().join(',');

export function createJointRecovery(db, { roomState, getMember, messagesAfter }) {
  db.exec(`CREATE TABLE IF NOT EXISTS joint_recoveries (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, capability_hash BLOB NOT NULL, initiator TEXT NOT NULL,
    expires_at TEXT NOT NULL, base_event_seq INTEGER NOT NULL,
    offers TEXT NOT NULL, proposal TEXT, approvals TEXT NOT NULL DEFAULT '{}',
    result TEXT, PRIMARY KEY(room_id, request_id));
    CREATE TABLE IF NOT EXISTS joint_recovery_replacements (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, source_device_id TEXT NOT NULL, replacement_device_id TEXT NOT NULL,
    PRIMARY KEY(room_id, source_device_id, replacement_device_id));`);
  if (!db.prepare('PRAGMA table_info(rooms)').all().some(column => column.name === 'mls_epoch_offset')) {
    db.exec('ALTER TABLE rooms ADD COLUMN mls_epoch_offset INTEGER NOT NULL DEFAULT 0');
  }
  const row = (roomId, id) => db.prepare('SELECT * FROM joint_recoveries WHERE room_id=? AND request_id=?').get(roomId, id);
  function authorized(roomId, id, capability) {
    const value = row(roomId, id);
    if (!value || !token(capability) || !timingSafeEqual(hash(capability), value.capability_hash)) throw new Error('UNAUTHORIZED');
    if (!value.result && Date.parse(value.expires_at) <= Date.now()) throw new Error('RECOVERY_EXPIRED');
    return value;
  }
  async function verifyOffer(offer, value) {
    if (!fields(offer, 'v roomId requestId capabilityHash expiresAt baseEventSeq sourceDeviceId role target tokenHash recover deviceName capabilities scope signature') ||
        offer.v !== 1 || offer.roomId !== value.room_id || offer.requestId !== value.request_id || offer.expiresAt !== value.expires_at ||
        offer.capabilityHash !== Buffer.from(value.capability_hash).toString('base64url') || offer.baseEventSeq !== value.base_event_seq || !isUuid(offer.sourceDeviceId) || !roles.includes(offer.role) ||
        !validatePublicBundle(offer.target) || !offer.target.mlsKeyPackage || !token(offer.tokenHash) || typeof offer.recover !== 'boolean' ||
        !fields(offer.scope, 'creator joiner') || roles.some(role => typeof offer.scope[role] !== 'boolean') ||
        offer.scope[offer.role] !== offer.recover || !Object.values(offer.scope).some(Boolean) ||
        typeof offer.deviceName !== 'string' || offer.deviceName.length > 80 || !offer.deviceName.trim() ||
        !Array.isArray(offer.capabilities) || offer.capabilities.length > 32 ||
        offer.capabilities.some(item => typeof item !== 'string' || !/^[a-z0-9-]{1,40}$/.test(item)) ||
        !offer.capabilities.includes('joint-recovery-v1') || getMember(value.room_id, offer.target.deviceId)) fail();
    const source = getMember(value.room_id, offer.sourceDeviceId);
    if (source?.status !== 'active' || source.role !== offer.role || !await verifyEnvelopeSignature(offer, source.signingKey)) fail();
    return source;
  }
  function snapshot(value) {
    return { requestId: value.request_id, initiator: value.initiator, expiresAt: value.expires_at,
      baseEventSeq: value.base_event_seq, offers: JSON.parse(value.offers),
      proposal: value.proposal ? JSON.parse(value.proposal) : null, approvals: JSON.parse(value.approvals),
      result: value.result ? JSON.parse(value.result) : null, state: roomState(value.room_id) };
  }
  async function create(offer, capability) {
    if (!offer || !isUuid(offer.roomId) || !isUuid(offer.requestId) || !token(capability) ||
        !Number.isSafeInteger(offer.baseEventSeq) || offer.baseEventSeq < 0 ||
        typeof offer.expiresAt !== 'string' || !Number.isFinite(Date.parse(offer.expiresAt)) || new Date(offer.expiresAt).toISOString() !== offer.expiresAt ||
        Date.parse(offer.expiresAt) <= Date.now() || Date.parse(offer.expiresAt) > Date.now() + 15 * 60_000) fail();
    const previous = row(offer.roomId, offer.requestId);
    if (previous) {
      authorized(offer.roomId, offer.requestId, capability);
      if (canonicalStringify(JSON.parse(previous.offers)[offer.role]) !== canonicalStringify(offer)) fail();
      return snapshot(previous);
    }
    const value = { capability_hash: hash(capability), room_id: offer.roomId, request_id: offer.requestId, expires_at: offer.expiresAt, base_event_seq: offer.baseEventSeq };
    await verifyOffer(offer, value);
    const state = roomState(offer.roomId);
    if (!state?.mlsWelcome || state.nextMlsEventSeq !== offer.baseEventSeq) throw new Error('MLS_EVENT_STALE');
    if (db.prepare('SELECT 1 FROM joint_recoveries WHERE room_id=? AND result IS NULL AND expires_at>?').get(offer.roomId, new Date().toISOString()) ||
        db.prepare("SELECT 1 FROM recovery_requests WHERE room_id=? AND status='pending' AND expires_at>?").get(offer.roomId, new Date().toISOString())) throw new Error('RECOVERY_ALREADY_PENDING');
    if (db.prepare('SELECT COUNT(*) AS count FROM joint_recoveries WHERE room_id=?').get(offer.roomId).count >= 1000) throw new Error('BACKUP_QUOTA');
    db.prepare('INSERT INTO joint_recoveries(room_id,request_id,capability_hash,initiator,expires_at,base_event_seq,offers) VALUES(?,?,?,?,?,?,?)')
      .run(offer.roomId, offer.requestId, hash(capability), offer.role, offer.expiresAt, offer.baseEventSeq, JSON.stringify({ [offer.role]: offer }));
    return snapshot(row(offer.roomId, offer.requestId));
  }
  async function participate(roomId, id, capability, offer) {
    let value = authorized(roomId, id, capability);
    if (value.result) return snapshot(value);
    await verifyOffer(offer, value);
    // Re-read after asynchronous signature verification; no stale overwrite.
    value = authorized(roomId, id, capability);
    const offers = JSON.parse(value.offers);
    if (offers[offer.role]) {
      if (canonicalStringify(offers[offer.role]) !== canonicalStringify(offer)) fail();
    } else {
      if (offer.role === value.initiator || value.proposal) fail();
      offers[offer.role] = offer;
      db.prepare('UPDATE joint_recoveries SET offers=? WHERE room_id=? AND request_id=?').run(JSON.stringify(offers), roomId, id);
    }
    return snapshot(row(roomId, id));
  }
  async function propose(roomId, id, capability, proposal) {
    let value = authorized(roomId, id, capability);
    if (value.result) return snapshot(value);
    const offers = JSON.parse(value.offers);
    if (!roles.every(role => offers[role]) || !roles.some(role => offers[role].recover) || !fields(proposal, 'v roomId requestId expiresAt baseEventSeq offers retireOtherDevices welcome') ||
        proposal.v !== 1 || proposal.roomId !== roomId || proposal.requestId !== id || proposal.expiresAt !== value.expires_at ||
        proposal.baseEventSeq !== value.base_event_seq || proposal.retireOtherDevices !== true ||
        canonicalStringify(proposal.offers) !== canonicalStringify(offers) ||
        proposal.welcome?.roomId !== roomId || proposal.welcome.senderId !== offers.creator.target.deviceId ||
        proposal.welcome.recipientId !== offers.joiner.target.deviceId || typeof proposal.welcome.welcome !== 'string' ||
        proposal.welcome.welcome.length > 400_000 || !await verifyEnvelopeSignature(proposal.welcome, offers.creator.target.signingKey)) fail();
    value = authorized(roomId, id, capability);
    if (value.proposal && canonicalStringify(JSON.parse(value.proposal)) !== canonicalStringify(proposal)) fail();
    if (!value.proposal) db.prepare('UPDATE joint_recoveries SET proposal=? WHERE room_id=? AND request_id=?').run(JSON.stringify(proposal), roomId, id);
    return snapshot(row(roomId, id));
  }
  async function approve(roomId, id, capability, approval) {
    let value = authorized(roomId, id, capability);
    if (value.result) return snapshot(value);
    const offers = JSON.parse(value.offers);
    if (!value.proposal || !fields(approval, 'role signature') || !roles.includes(approval.role)) fail();
    const source = getMember(roomId, offers[approval.role].sourceDeviceId);
    if (source?.status !== 'active' || !await verifyEnvelopeSignature({ ...JSON.parse(value.proposal), signature: approval.signature }, source.signingKey)) fail();
    value = authorized(roomId, id, capability);
    if (value.result) return snapshot(value);
    const approvals = JSON.parse(value.approvals); approvals[approval.role] = approval.signature;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE joint_recoveries SET approvals=? WHERE room_id=? AND request_id=?').run(JSON.stringify(approvals), roomId, id);
      if (roles.every(role => approvals[role])) {
        const state = roomState(roomId);
        if (state.nextMlsEventSeq !== value.base_event_seq || roles.some(role => getMember(roomId, offers[role].sourceDeviceId)?.status !== 'active')) throw new Error('MLS_EVENT_STALE');
        const now = new Date().toISOString();
        db.prepare("UPDATE members SET status='revoked',revoked_at=? WHERE room_id=? AND status IN ('active','pending')").run(now, roomId);
        db.prepare('DELETE FROM push_subscriptions WHERE room_id=?').run(roomId);
        db.prepare('DELETE FROM unread_observers WHERE room_id=?').run(roomId);
        db.prepare('DELETE FROM device_links WHERE room_id=?').run(roomId);
        db.prepare('DELETE FROM repair_links WHERE room_id=?').run(roomId);
        db.prepare("UPDATE recovery_requests SET status='expired' WHERE room_id=? AND status='pending'").run(roomId);
        for (const role of roles) {
          const offer = offers[role], target = offer.target;
          if (getMember(roomId, target.deviceId)) fail();
          db.prepare(`INSERT INTO members(room_id,device_id,role,encryption_jwk,signing_jwk,mls_key_package,join_proof,access_hash,
            device_name,status,added_by,join_seq,join_receipt_seq,capabilities,created_at) VALUES(?,?,?,?,?,?,NULL,?,?,'active',?,?,?,?,?)`)
            .run(roomId, target.deviceId, role, JSON.stringify(target.encryptionKey), JSON.stringify(target.signingKey), target.mlsKeyPackage,
              Buffer.from(offer.tokenHash, 'base64url'), offer.deviceName, offer.sourceDeviceId, state.nextSeq, state.nextReceiptSeq,
              JSON.stringify(offer.capabilities), now);
          db.prepare('INSERT INTO joint_recovery_replacements VALUES(?,?,?,?)').run(roomId, id, offer.sourceDeviceId, target.deviceId);
        }
        const eventSeq = state.nextMlsEventSeq + 1;
        db.prepare('UPDATE rooms SET window_enabled=0,window_from_seq=0,mls_welcome=?,next_mls_event_seq=?,mls_epoch_offset=? WHERE room_id=?')
          .run(JSON.stringify(JSON.parse(value.proposal).welcome), eventSeq, eventSeq, roomId);
        const result = { eventSeq, nextSeq: state.nextSeq, nextReceiptSeq: state.nextReceiptSeq, completedAt: now };
        db.prepare('UPDATE joint_recoveries SET result=? WHERE room_id=? AND request_id=?').run(JSON.stringify(result), roomId, id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return snapshot(row(roomId, id));
  }
  async function cancel(roomId, id, capability, approval) {
    let value = row(roomId, id);
    if (!value || !token(capability) || !timingSafeEqual(hash(capability), value.capability_hash)) throw new Error('UNAUTHORIZED');
    if (value.result) return snapshot(value);
    if (!fields(approval, 'role signature') || !roles.includes(approval.role)) fail();
    const offer = JSON.parse(value.offers)[approval.role];
    const source = offer && getMember(roomId, offer.sourceDeviceId);
    if (!source || !await verifyEnvelopeSignature({ v: 1, roomId, requestId: id, action: 'cancel', role: approval.role, signature: approval.signature }, source.signingKey)) fail();
    value = row(roomId, id);
    if (value.result) return snapshot(value);
    db.prepare('UPDATE joint_recoveries SET expires_at=? WHERE room_id=? AND request_id=?').run(new Date(Date.now() - 1).toISOString(), roomId, id);
    return { cancelled: true };
  }
  function catchUp(roomId, id, deviceId, afterSeq) {
    const value = row(roomId, id);
    if (!value?.result || !Number.isSafeInteger(afterSeq) || afterSeq < 0) fail();
    const offers = JSON.parse(value.offers), result = JSON.parse(value.result);
    const offer = Object.values(offers).find(offer => offer.target.deviceId === deviceId && !offer.recover);
    if (!offer) throw new Error('UNAUTHORIZED');
    return messagesAfter(roomId, afterSeq, 100, offer.sourceDeviceId).filter(message => message.seq <= result.nextSeq);
  }
  return { create, participate, propose, approve, cancel, catchUp, status: (roomId, id, capability) => snapshot(authorized(roomId, id, capability)) };
}
