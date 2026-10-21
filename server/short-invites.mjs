import { ROOM_LINK_TTL_MS } from '../src/lib/room-link-lifetime.mjs';
/** Only an encrypted invitation envelope is stored. Reading/previewing never
 * consumes the underlying single-use membership invitation. */
export function createShortInvites(db){
 db.exec('CREATE TABLE IF NOT EXISTS short_invites_v2(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,device_id TEXT NOT NULL,envelope TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS short_invites_expiry ON short_invites_v2(expires_at)');
 const clean=()=>db.prepare('DELETE FROM short_invites_v2 WHERE expires_at<=?').run(Date.now());
 return {
  put(roomId,deviceId,id,envelope){
   clean();if(!/^[A-Za-z0-9_-]{22}$/.test(id)||!envelope||Object.keys(envelope).sort().join(',')!=='ciphertext,iv,v'||envelope.v!==2||!/^[A-Za-z0-9_-]{16}$/.test(envelope.iv)||typeof envelope.ciphertext!=='string'||!/^[A-Za-z0-9_-]{22,7000}$/.test(envelope.ciphertext))throw new Error('INVALID_JSON');
   const value=JSON.stringify(envelope),old=db.prepare('SELECT * FROM short_invites_v2 WHERE id=?').get(id);
   if(old){if(old.room_id!==roomId||old.device_id!==deviceId||old.envelope!==value)throw new Error('BACKUP_CONFLICT');return;}
   if(db.prepare('SELECT COUNT(*) AS n FROM short_invites_v2 WHERE room_id=?').get(roomId).n>=30||db.prepare('SELECT COUNT(*) AS n FROM short_invites_v2').get().n>=100_000)throw new Error('STORAGE_QUOTA');
    db.prepare('INSERT INTO short_invites_v2 VALUES(?,?,?,?,?)').run(id,roomId,deviceId,value,Date.now()+ROOM_LINK_TTL_MS);
  },
  get(id){const row=db.prepare('SELECT envelope,expires_at FROM short_invites_v2 WHERE id=?').get(id);if(!row||row.expires_at<=Date.now())throw new Error('INVALID_REPAIR_LINK');return JSON.parse(row.envelope);},
 };
}
