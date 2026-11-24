import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoomAnalytics } from '../server/admin-room-analytics.mjs';
import { createStore } from '../server/storage.mjs';

type Role = 'creator' | 'joiner';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'quiet-room-analytics-'));
  let db: DatabaseSync | undefined;
  cleanup.push(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const store = await createStore({ dataDir: dir });
  store.close();
  const connection = (db = new DatabaseSync(path.join(dir, 'quiet-room.sqlite')));
  connection.exec('PRAGMA foreign_keys = ON');
  const report = createRoomAnalytics(connection);
  const device = (room: string, role: Role, slot = 1) => `${room}/${role}/${slot}`;
  const addDevice = (room: string, role: Role, slot: number, at: string, status = 'active') => {
    connection.prepare(`INSERT INTO members
      (room_id,device_id,role,encryption_jwk,signing_jwk,access_hash,created_at,status)
      VALUES(?,?,?,'synthetic','synthetic',X'00',?,?)`).run(room, device(room, role, slot), role, at, status);
  };
  const addRoom = (room: string, createdAt: string, joinedAt?: string) => {
    connection.prepare("INSERT INTO rooms(room_id,access_hash,created_at,sealed_at) VALUES(?,X'00',?,?)")
      .run(room, createdAt, joinedAt ?? null);
    addDevice(room, 'creator', 1, createdAt);
    if (joinedAt) addDevice(room, 'joiner', 1, joinedAt);
  };
  const send = (room: string, role: Role, at: string, countable = true, slot = 1) => {
    const seq = connection.prepare('UPDATE rooms SET next_seq=next_seq+1,message_count=message_count+1 WHERE room_id=? RETURNING next_seq').get(room)?.next_seq;
    if (typeof seq !== 'number') throw new Error('Expected message sequence');
    connection.prepare(`INSERT INTO messages(room_id,server_seq,client_msg_id,sender_device_id,envelope,accepted_at,count_unread)
      VALUES(?,?,?,?,?,?,?)`).run(room, seq, `message-${seq}`, device(room, role, slot), 'private-synthetic-envelope', at, Number(countable));
  };
  const evict = (room: string, seq: number) => {
    const removed = connection.prepare('DELETE FROM messages WHERE room_id=? AND server_seq=?').run(room, seq).changes;
    connection.prepare('UPDATE rooms SET message_count=message_count-? WHERE room_id=?').run(removed, room);
  };
  const closeRoom = (room: string, at: string) => {
    connection.prepare("UPDATE members SET status='revoked',revoked_at=? WHERE room_id=?").run(at, room);
    connection.prepare('INSERT INTO chamber_lifecycle(room_id,closed) VALUES(?,1)').run(room);
  };
  return { connection, report, device, addDevice, addRoom, send, evict, closeRoom };
}

const now = new Date('2026-11-23T04:00:00.000Z');
const utc = (date: string) => `${date}Z`;

describe('room operations projections', () => {
  it('separates current stock, period activity, conversion progress and completed creation cohorts', async () => {
    const f = await fixture();
    const created = utc('2026-11-01T05:00:00.000');
    const joined = utc('2026-11-01T06:00:00.000');
    const sent = utc('2026-11-01T07:00:00.000');
    f.addRoom('waiting-room', created);
    f.addRoom('control-only-room', created, joined);
    f.send('control-only-room', 'creator', sent, false);
    f.addRoom('only-creator-room', created, joined);
    f.send('only-creator-room', 'creator', sent);
    f.addRoom('only-guest-room', created, joined);
    f.send('only-guest-room', 'joiner', sent);
    f.addRoom('both-room', created, joined);
    f.addDevice('both-room', 'creator', 2, created);
    f.send('both-room', 'creator', sent, true, 2);
    f.send('both-room', 'joiner', sent);
    f.addRoom('incomplete-room', created, joined);
    f.send('incomplete-room', 'creator', sent);
    f.evict('incomplete-room', 1);
    f.addRoom('known-incomplete-room', created, joined);
    f.send('known-incomplete-room', 'creator', sent);
    f.send('known-incomplete-room', 'creator', sent);
    f.send('known-incomplete-room', 'joiner', sent);
    f.evict('known-incomplete-room', 1);
    f.addRoom('late-send-room', created, joined);
    f.send('late-send-room', 'creator', utc('2026-11-01T05:30:00.000'));
    f.send('late-send-room', 'joiner', utc('2026-11-08T06:00:00.000'));
    f.addRoom('late-join-room', created, utc('2026-11-09T05:00:00.000'));
    f.addRoom('closed-room', created, joined);
    f.closeRoom('closed-room', utc('2026-11-20T16:00:00.000'));
    f.addRoom('too-recent-room', utc('2026-11-22T15:59:00.000'));
    f.addRoom('after-cutoff-room', utc('2026-11-22T16:00:00.000'));

    const data = f.report(30, now);
    expect(data).toMatchObject({
      period: 30, start: '2026-10-24', end: '2026-11-22', at: now.toISOString(),
      stock: { waiting: 3, joined: 8, closed: 1 },
      activity: { created: 11, joined: 9, active: 5, bilateralActive: 3, partial: true },
      join24: { joined: 8, pending: 1 }, medianJoinMinutes: 60,
      funnel: { created: 11, joined: 8, firstMessage: 4, bilateral: 2, pending: 1, unknown: 1 },
      states: {
        stock: { waiting: 3, none: 2, creator: 1, guest: 1, both: 3, unknown: 1 },
        cohort: { waiting: 2, none: 3, creator: 1, guest: 1, both: 2, unknown: 1 },
      },
    });
    expect(data.trend.find(bucket => bucket.start === '2026-11-16')?.closed).toBe(1);
    expect(f.report(7, now).funnel).toEqual({ created: 1, joined: 0, firstMessage: 0, bilateral: 0, pending: 1, unknown: 0 });
    expect(JSON.stringify(data)).not.toMatch(/both-room|only-guest-room|private-synthetic-envelope|device_id|room_id/);
    expect(() => f.report(8, now)).toThrow('INVALID_ADMIN_FILTER');
  });

  it('counts known conversions as of the snapshot within their deadlines, even on a seven-day report', async () => {
    const f = await fixture();
    f.addRoom('day-two', utc('2026-11-22T08:00:00.000'), utc('2026-11-23T02:00:00.000'));
    f.send('day-two', 'creator', utc('2026-11-22T08:30:00.000'));
    f.send('day-two', 'joiner', utc('2026-11-23T02:01:00.000'));
    f.send('day-two', 'creator', utc('2026-11-23T03:00:00.000'));
    f.addRoom('still-pending', utc('2026-11-22T09:00:00.000'));
    f.addRoom('deadline', utc('2026-11-16T03:00:00.000'), utc('2026-11-17T03:00:00.000'));
    f.send('deadline', 'creator', utc('2026-11-23T02:59:59.999'));
    f.send('deadline', 'joiner', utc('2026-11-23T03:00:00.000'));
    f.addRoom('created-today', utc('2026-11-22T16:00:00.000'));

    const beforeJoining = f.report(7, new Date('2026-11-23T01:59:59.999Z'));
    expect(beforeJoining.funnel).toEqual({ created: 3, joined: 1, firstMessage: 0, bilateral: 0, pending: 3, unknown: 0 });
    expect(beforeJoining.join24).toEqual({ joined: 0, pending: 2 });

    const atJoining = f.report(7, new Date('2026-11-23T02:00:00.000Z'));
    expect(atJoining.funnel.joined).toBe(2);
    expect(atJoining.join24).toEqual({ joined: 1, pending: 1 });

    const atDeadline = f.report(7, new Date('2026-11-23T03:00:00.000Z'));
    expect(atDeadline.funnel).toEqual({ created: 3, joined: 2, firstMessage: 2, bilateral: 1, pending: 1, unknown: 0 });
    expect(atDeadline.states.cohort).toEqual({ waiting: 0, none: 0, creator: 1, guest: 0, both: 0, unknown: 0 });
    expect(atDeadline.activity).toMatchObject({ created: 3, joined: 1, bilateralActive: 0 });
    expect(f.report(7, new Date('2026-11-23T09:00:00.000Z')).join24).toEqual({ joined: 1, pending: 0 });
  });

  it('deduplicates follow-ups within exact Beijing calendar days and uses maturity-specific denominators', async () => {
    const f = await fixture();
    const created = utc('2026-09-05T12:00:00.000');
    const joined = utc('2026-09-05T13:00:00.000');
    f.addRoom('retained-room', created, joined);
    f.send('retained-room', 'creator', utc('2026-09-05T12:30:00.000'));
    f.send('retained-room', 'creator', utc('2026-09-05T15:55:00.000'));
    f.send('retained-room', 'creator', utc('2026-09-05T16:05:00.000'));
    f.send('retained-room', 'joiner', utc('2026-09-05T16:06:00.000'));
    f.send('retained-room', 'joiner', utc('2026-09-11T16:00:00.000'));
    f.send('retained-room', 'creator', utc('2026-10-05T15:59:59.000'));
    f.addRoom('control-follow-up-room', created, joined);
    f.send('control-follow-up-room', 'joiner', utc('2026-09-05T13:00:00.000'));
    f.send('control-follow-up-room', 'creator', utc('2026-09-05T16:00:00.000'), false);
    f.addRoom('missing-activation-room', created, joined);
    f.send('missing-activation-room', 'creator', utc('2026-09-05T14:00:00.000'));
    f.send('missing-activation-room', 'joiner', utc('2026-09-05T16:05:00.000'));
    f.evict('missing-activation-room', 1);
    f.addRoom('recent-activation-room', utc('2026-11-22T08:00:00.000'), utc('2026-11-22T09:00:00.000'));
    f.send('recent-activation-room', 'creator', utc('2026-11-22T15:59:59.999'));
    f.send('recent-activation-room', 'joiner', utc('2026-11-22T16:00:00.000'));

    const data = f.report(90, now);
    expect(data.retention.find(bucket => bucket.start === '2026-09-01')).toEqual({
      start: '2026-09-01', end: '2026-09-30', activated: 2,
      d1: { eligible: 2, returned: 1, todayDue: 0, todayReturned: 0 },
      d7: { eligible: 2, returned: 1, todayDue: 0, todayReturned: 0 },
      d30: { eligible: 2, returned: 1, todayDue: 0, todayReturned: 0 },
    });
    expect(data.retention.find(bucket => bucket.start === '2026-11-01')).toMatchObject({
      activated: 1,
      d1: { eligible: 0, returned: 0, todayDue: 1, todayReturned: 1 },
      d7: { eligible: 0, returned: 0, todayDue: 0, todayReturned: 0 },
      d30: { eligible: 0, returned: 0, todayDue: 0, todayReturned: 0 },
    });
    const nextDay = f.report(90, new Date('2026-11-23T16:00:00.000Z'));
    expect(nextDay.retention.find(bucket => bucket.start === '2026-11-01')?.d1)
      .toEqual({ eligible: 1, returned: 1, todayDue: 0, todayReturned: 0 });
    expect(data.activity).toMatchObject({ active: 4, bilateralActive: 1, partial: true });
  });

  it('counts completed uploads in the selected period and deduplicates current devices, subscriptions, and stored backups by seat', async () => {
    const f = await fixture();
    const created = utc('2026-10-01T00:00:00.000');
    const inPeriod = utc('2026-11-15T04:00:00.000');
    f.addRoom('feature-room', created, created);
    f.addDevice('feature-room', 'creator', 2, created);
    f.addDevice('feature-room', 'joiner', 2, created, 'revoked');
    f.addDevice('feature-room', 'joiner', 3, created, 'pending');
    f.addRoom('unfinished-upload-room', created);
    const attachment = f.connection.prepare('INSERT INTO blobs(room_id,blob_id,chunk_count,completed,created_at,updated_at) VALUES(?,?,1,?,?,?)');
    attachment.run('feature-room', 'first-blob', 1, created, inPeriod);
    attachment.run('feature-room', 'second-blob', 1, created, inPeriod);
    attachment.run('unfinished-upload-room', 'unfinished-blob', 0, created, inPeriod);
    const push = f.connection.prepare("INSERT INTO push_subscriptions(room_id,device_id,endpoint,p256dh,auth,created_at,updated_at) VALUES('feature-room',?,?,'key','token',?,?)");
    push.run(f.device('feature-room', 'creator'), 'https://example.test/first', created, created);
    push.run(f.device('feature-room', 'creator', 2), 'https://example.test/second', created, created);
    push.run(f.device('feature-room', 'joiner', 2), 'https://example.test/revoked', created, created);
    const legacy = f.connection.prepare(`INSERT INTO recovery_backups
      (backup_id,room_id,device_id,revision,fetch_hash,sealed,request_hash,active,created_at,updated_at)
      VALUES(?,'feature-room',?,1,X'00','secret-ciphertext',X'00',?,?,?)`);
    legacy.run('legacy-backup', f.device('feature-room', 'creator', 2), 1, created, created);
    legacy.run('inactive-backup', f.device('feature-room', 'joiner'), 0, created, created);
    const archive = f.connection.prepare("INSERT INTO private_archives_v2 VALUES(?,?,?,'secret-descriptor',?)");
    archive.run('full-archive', 'feature-room', f.device('feature-room', 'creator'), 'creator');
    archive.run('empty-archive', 'feature-room', f.device('feature-room', 'joiner'), 'joiner');
    archive.run('deleted-room-archive', 'deleted-room', 'deleted-device', 'creator');
    const archiveObject = f.connection.prepare("INSERT INTO private_archive_objects_v2(archive_id,id,record,bytes) VALUES(?,'object','ciphertext',10)");
    archiveObject.run('full-archive');
    archiveObject.run('deleted-room-archive');

    expect(f.report(30, now).features).toEqual({ attachments: 1, multiDeviceSeats: 1, pushSeats: 1, backupSeats: 1 });
    expect(f.report(7, now).features).toEqual({ attachments: 0, multiDeviceSeats: 1, pushSeats: 1, backupSeats: 1 });
  });
});
