import { createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { canonicalStringify } from './protocol.mjs';
const hash = value => createHash('sha256').update(value).digest('base64url');
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
export function validArchiveDescriptor(d) {
  return Boolean(d && Object.keys(d).sort().join(',') === 'encryptionKey,id,readHash,signingKey,v' && d.v === 2 &&
    [d.id,d.encryptionKey,d.signingKey,d.readHash].every(x=>typeof x==='string'&&keyPattern.test(x)) &&
    d.id === hash(canonicalStringify({encryptionKey:d.encryptionKey,signingKey:d.signingKey,readHash:d.readHash})));
}
export function validArchiveObject(d, object) {
  try {
    if (!object || Object.keys(object).sort().join(',') !== 'archiveId,ciphertext,enc,id,signature,v' || object.v!==2 || object.archiveId!==d.id ||
      !/^[0-9a-f-]{36}$/.test(object.id) || !keyPattern.test(object.enc) || typeof object.ciphertext!=='string' || object.ciphertext.length>4_300_000 ||
      !/^[A-Za-z0-9_-]{22,}$/.test(object.ciphertext) || !/^[A-Za-z0-9_-]{86}$/.test(object.signature)) return false;
    const {signature,...unsigned}=object;
    const publicKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:d.signingKey},format:'jwk'});
    return verify(null,Buffer.from(canonicalStringify(unsigned)),publicKey,Buffer.from(signature,'base64url'));
  } catch { return false; }
}
/** No foreign key to live rooms: deleting a local room or retiring its membership
 * never removes an already committed archive. Plaintext and recovery secrets are not accepted. */
export function createRoomArchives(db,{maxArchiveBytes=1024**3,maxTotalBytes=10*1024**3,assertWriterActive}={}) {
  if (typeof assertWriterActive !== 'function') throw new Error('ARCHIVE_WRITER_AUTHORIZATION_REQUIRED');
  if (![maxArchiveBytes,maxTotalBytes].every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error('INVALID_ARCHIVE_BUDGET');
  db.exec(`CREATE TABLE IF NOT EXISTS private_archives_v2(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,device_id TEXT NOT NULL,descriptor TEXT NOT NULL,owner_role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS private_archive_access_v2(archive_id TEXT PRIMARY KEY REFERENCES private_archives_v2(id),read_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS private_archive_objects_v2(cursor INTEGER PRIMARY KEY AUTOINCREMENT,archive_id TEXT NOT NULL REFERENCES private_archives_v2(id),id TEXT NOT NULL,record TEXT NOT NULL,bytes INTEGER NOT NULL,UNIQUE(archive_id,id));`);
  const descriptor=id=>{const row=db.prepare('SELECT descriptor FROM private_archives_v2 WHERE id=?').get(id);if(!row)throw new Error('BACKUP_NOT_FOUND');return JSON.parse(row.descriptor);};
  const readable=(id,token)=>{
    if(typeof token!=='string'||!keyPattern.test(token))throw new Error('UNAUTHORIZED');
    const d=descriptor(id),actual=Buffer.from(hash(token)),expected=Buffer.from(db.prepare('SELECT read_hash FROM private_archive_access_v2 WHERE archive_id=?').get(id)?.read_hash ?? d.readHash);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error('UNAUTHORIZED');return d;
  };
  return {
    rotateAccess(roomId,deviceId,id,expected,next,proof) {
      db.exec('BEGIN IMMEDIATE');
      try {
      const row=db.prepare('SELECT * FROM private_archives_v2 WHERE id=?').get(id);
      if(!row||row.room_id!==roomId||row.device_id!==deviceId||![expected,next].every(x=>typeof x==='string'&&keyPattern.test(x)))throw new Error('UNAUTHORIZED');
      const d=JSON.parse(row.descriptor),publicKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:d.signingKey},format:'jwk'});
      if(typeof proof!=='string'||!verify(null,Buffer.from(canonicalStringify(['quiet-room-archive-access-v1',id,roomId,deviceId,expected,next])),publicKey,Buffer.from(proof,'base64url')))throw new Error('UNAUTHORIZED');
        assertWriterActive(roomId,deviceId,row.owner_role);
        const current=db.prepare('SELECT read_hash FROM private_archive_access_v2 WHERE archive_id=?').get(id)?.read_hash??d.readHash;
        if(current!==next){if(current!==expected)throw new Error('BACKUP_CONFLICT');db.prepare('INSERT INTO private_archive_access_v2 VALUES(?,?) ON CONFLICT(archive_id) DO UPDATE SET read_hash=excluded.read_hash').run(id,next);}
        db.exec('COMMIT');
      }catch(cause){db.exec('ROLLBACK');throw cause;}
    },
    register(roomId,deviceId,d,role=deviceId,proof) {
      db.exec('BEGIN IMMEDIATE');
      try {
      assertWriterActive(roomId,deviceId,role);
      if(!validArchiveDescriptor(d))throw new Error('INVALID_BACKUP');
      const publicKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:d.signingKey},format:'jwk'});
      if(typeof proof!=='string'||!verify(null,Buffer.from(canonicalStringify(['quiet-room-archive-writer-v2',d.id,roomId,deviceId])),publicKey,Buffer.from(proof,'base64url')))throw new Error('UNAUTHORIZED');
      const before=db.prepare('SELECT * FROM private_archives_v2 WHERE id=?').get(d.id);
      if(before){
        if(before.room_id!==roomId||before.owner_role!==role||before.descriptor!==canonicalStringify(d))throw new Error('BACKUP_CONFLICT');
        if(before.device_id!==deviceId){
          db.prepare('UPDATE private_archives_v2 SET device_id=? WHERE id=?').run(deviceId,d.id);
        }
        db.exec('COMMIT');return;
      }
      if(db.prepare('SELECT COUNT(*) AS n FROM private_archives_v2 WHERE room_id=? AND device_id=?').get(roomId,deviceId).n>=4||db.prepare('SELECT COUNT(*) AS n FROM private_archives_v2').get().n>=100_000)throw new Error('BACKUP_QUOTA');
      db.prepare('INSERT INTO private_archives_v2 VALUES(?,?,?,?,?)').run(d.id,roomId,deviceId,canonicalStringify(d),role);
      db.exec('COMMIT');
      }catch(cause){db.exec('ROLLBACK');throw cause;}
    },
    put(roomId,deviceId,id,object) {
      db.exec('BEGIN IMMEDIATE');
      try{
      const row=db.prepare('SELECT * FROM private_archives_v2 WHERE id=?').get(id);
      if(!row||row.room_id!==roomId||row.device_id!==deviceId)throw new Error('UNAUTHORIZED');
      if(!validArchiveObject(JSON.parse(row.descriptor),object))throw new Error('INVALID_BACKUP');
      const record=canonicalStringify(object),size=Buffer.byteLength(record);
      if(size>4_300_000)throw new Error('BACKUP_QUOTA');
        assertWriterActive(roomId,deviceId,row.owner_role);
        const previous=db.prepare('SELECT record FROM private_archive_objects_v2 WHERE archive_id=? AND id=?').get(id,object.id);
        if(previous){if(previous.record!==record)throw new Error('BACKUP_CONFLICT');db.exec('COMMIT');return;}
        const own=db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM private_archive_objects_v2 WHERE archive_id=?').get(id).n;
        const all=db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM private_archive_objects_v2').get().n;
        if(own+size>maxArchiveBytes||all+size>maxTotalBytes)throw new Error('BACKUP_QUOTA');
        db.prepare('INSERT INTO private_archive_objects_v2(archive_id,id,record,bytes) VALUES(?,?,?,?)').run(id,object.id,record,size);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    snapshot(id,token){const d=readable(id,token);const {end,count}=db.prepare('SELECT COALESCE(MAX(cursor),0) AS end,COUNT(*) AS count FROM private_archive_objects_v2 WHERE archive_id=?').get(id);return {descriptor:d,end,count};},
    list(id,token,after,end){readable(id,token);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(end)||end<after)throw new Error('INVALID_BACKUP');return db.prepare('SELECT cursor,id,bytes FROM private_archive_objects_v2 WHERE archive_id=? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT 100').all(id,after,end);},
    read(id,token,objectId){readable(id,token);const row=db.prepare('SELECT record FROM private_archive_objects_v2 WHERE archive_id=? AND id=?').get(id,objectId);if(!row)throw new Error('BACKUP_NOT_FOUND');return JSON.parse(row.record);},
  };
}
