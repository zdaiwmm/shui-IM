/** Bounded opaque mail between active devices of the same owner. */
export function createOwnSpaceDirectory(db, { getMember, authenticatedDevice }) {
  db.exec(`CREATE TABLE IF NOT EXISTS own_space_directory (
    room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, revision INTEGER NOT NULL,
    envelope TEXT NOT NULL, PRIMARY KEY(room_id,sender_id,recipient_id))`);
  const active = (roomId, token) => {
    const own = authenticatedDevice(roomId, token);
    if (!own || own.status !== 'active') throw new Error('UNAUTHORIZED');
    return own;
  };
  const sameOwner = (roomId, own, id) => {
    const peer = getMember(roomId,id);
    if (!peer || peer.deviceId === own.deviceId || peer.role !== own.role || peer.status !== 'active') throw new Error('UNAUTHORIZED');
    return peer;
  };
  const prune = roomId => db.prepare(`DELETE FROM own_space_directory WHERE room_id=? AND (
    NOT EXISTS(SELECT 1 FROM members WHERE room_id=own_space_directory.room_id AND device_id=own_space_directory.sender_id AND status='active') OR
    NOT EXISTS(SELECT 1 FROM members WHERE room_id=own_space_directory.room_id AND device_id=own_space_directory.recipient_id AND status='active'))`).run(roomId);
  return {
    read(roomId, token) {
      const own = active(roomId,token);
      prune(roomId);
      const rows = db.prepare('SELECT sender_id,recipient_id,revision,envelope FROM own_space_directory WHERE room_id=? AND (recipient_id=? OR sender_id=?)').all(roomId,own.deviceId,own.deviceId);
      const incoming = [], outgoing = [];
      for (const row of rows) {
        try { sameOwner(roomId,own,row.sender_id === own.deviceId ? row.recipient_id : row.sender_id); } catch { continue; }
        if (row.recipient_id === own.deviceId) incoming.push(JSON.parse(row.envelope));
        else outgoing.push({recipientId:row.recipient_id,revision:row.revision});
      }
      return {incoming,outgoing};
    },
    save(roomId, token, envelope) {
      const own = active(roomId,token);
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'ciphertext,iv,purpose,recipientId,revision,roomId,senderId,signature,v' ||
        envelope.v !== 1 || envelope.purpose !== 'quiet-room-own-directory-v1' || envelope.roomId !== roomId || envelope.senderId !== own.deviceId ||
        !Number.isSafeInteger(envelope.revision) || envelope.revision < 1 || envelope.revision >= Number.MAX_SAFE_INTEGER ||
        !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv) || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 2 * 1024 ** 2 || !/^[A-Za-z0-9_-]{22,}$/.test(envelope.ciphertext) ||
        !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) throw new Error('INVALID_DIRECTORY');
      sameOwner(roomId,own,envelope.recipientId);
      prune(roomId);
      const previous = db.prepare('SELECT revision,envelope FROM own_space_directory WHERE room_id=? AND sender_id=? AND recipient_id=?').get(roomId,own.deviceId,envelope.recipientId);
      const raw = JSON.stringify(envelope);
      if (previous && (envelope.revision < previous.revision || envelope.revision === previous.revision && raw !== previous.envelope)) throw new Error('DIRECTORY_CONFLICT');
      db.prepare('INSERT INTO own_space_directory VALUES(?,?,?,?,?) ON CONFLICT(room_id,sender_id,recipient_id) DO UPDATE SET revision=excluded.revision,envelope=excluded.envelope').run(roomId,own.deviceId,envelope.recipientId,envelope.revision,raw);
      return {revision:envelope.revision};
    },
  };
}
