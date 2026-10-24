/** Administrator projections contain metadata only. Never return envelopes,
 * descriptors, capability hashes, invitation secrets or recovery material. */
export function createAdminData(db, limits) {
    db.exec(`CREATE TABLE IF NOT EXISTS private_archive_admin_meta_v1 (
    archive_id TEXT PRIMARY KEY REFERENCES private_archives_v2(id),
    created_at TEXT, last_written_at TEXT);
    CREATE INDEX IF NOT EXISTS private_archives_admin_room ON private_archives_v2(room_id);
    CREATE INDEX IF NOT EXISTS admin_events_created ON admin_events(created_at,id);`);
    for (const [name, definition] of [['target_type', "TEXT NOT NULL DEFAULT 'room'"], ['target_id', 'TEXT'], ['result', "TEXT NOT NULL DEFAULT 'recorded'"]]) {
        if (!db.prepare('PRAGMA table_info(admin_events)').all().some(column => column.name === name))
            db.exec(`ALTER TABLE admin_events ADD COLUMN ${name} ${definition}`);
    }
    const count = (sql, ...args) => db.prepare(sql).get(...args).n;
    const format = `CASE WHEN r.new_invite_expiry IS NOT NULL OR EXISTS(SELECT 1 FROM private_archives_v2 a WHERE a.room_id=r.room_id)
    OR EXISTS(SELECT 1 FROM members m,json_each(m.capabilities) c WHERE m.room_id=r.room_id AND c.value='room-archive-v2') THEN 'archive-v2'
    WHEN EXISTS(SELECT 1 FROM chamber_rooms c WHERE c.room_id=r.room_id) THEN 'chamber-v1' ELSE 'legacy' END`;
    const state = `CASE WHEN EXISTS(SELECT 1 FROM chamber_lifecycle c WHERE c.room_id=r.room_id AND c.closed=1) THEN 'closed' WHEN r.sealed_at IS NULL THEN 'waiting' ELSE 'active' END`;
    const roomFields = `r.room_id AS roomId,r.created_at AS createdAt,r.sealed_at AS sealedAt,${format} AS format,${state} AS state,
    r.message_count AS messageCount,r.message_bytes AS messageBytes,r.window_from_seq AS windowFromSeq,r.window_enabled AS windowEnabled,
    (SELECT COUNT(*) FROM members m WHERE m.room_id=r.room_id AND m.status='active') AS devices,
    (SELECT MAX(last_seen_at) FROM members m WHERE m.room_id=r.room_id) AS lastSeenAt,
    (SELECT COUNT(*) FROM recovery_backups b WHERE b.room_id=r.room_id AND b.active=1) AS backups,
    (SELECT COUNT(*) FROM private_archives_v2 a WHERE a.room_id=r.room_id) AS privateArchives,
    (SELECT COALESCE(SUM(o.bytes),0) FROM private_archive_objects_v2 o JOIN private_archives_v2 a ON a.id=o.archive_id WHERE a.room_id=r.room_id) AS archiveBytes,
    (SELECT COALESCE(SUM(expected_bytes),0) FROM blobs WHERE room_id=r.room_id) AS attachmentBytes,
    (SELECT COALESCE(SUM(a.chat_count),0) FROM history_archives a JOIN recovery_backups b ON b.backup_id=a.backup_id WHERE b.room_id=r.room_id AND b.active=1) AS backupChatCount,
    (SELECT COALESCE(SUM(a.gallery_count),0) FROM history_archives a JOIN recovery_backups b ON b.backup_id=a.backup_id WHERE b.room_id=r.room_id AND b.active=1) AS backupGalleryCount`;
    function roomList({ offset = 0, q = '', format: selectedFormat = 'all', state: selectedState = 'all' } = {}) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !/^[-0-9a-f]{0,36}$/i.test(q) ||
            !['all', 'archive-v2', 'chamber-v1', 'legacy'].includes(selectedFormat) || !['all', 'active', 'waiting', 'closed'].includes(selectedState))
            throw new Error('INVALID_ADMIN_FILTER');
        const where = `r.room_id LIKE ? AND (?='all' OR ${format}=?) AND (?='all' OR ${state}=?)`;
        const args = [`${q}%`, selectedFormat, selectedFormat, selectedState, selectedState];
        return { rooms: db.prepare(`SELECT ${roomFields} FROM rooms r WHERE ${where} ORDER BY r.created_at DESC,r.room_id LIMIT 50 OFFSET ?`).all(...args, offset),
            total: count(`SELECT COUNT(*) AS n FROM rooms r WHERE ${where}`, ...args), offset };
    }
    const archiveFields = `a.id,a.room_id AS roomId,a.device_id AS deviceId,a.owner_role AS role,
    m.created_at AS createdAt,m.last_written_at AS lastWrittenAt,
    EXISTS(SELECT 1 FROM rooms r WHERE r.room_id=a.room_id) AS sourceExists,
    EXISTS(SELECT 1 FROM members d WHERE d.room_id=a.room_id AND d.device_id=a.device_id AND d.role=a.owner_role AND d.status='active') AS writerActive,
    (SELECT COUNT(*) FROM private_archive_objects_v2 o WHERE o.archive_id=a.id) AS objects,
    (SELECT COALESCE(SUM(bytes),0) FROM private_archive_objects_v2 o WHERE o.archive_id=a.id) AS bytes`;
    function archives({ offset = 0, roomId = '', source = 'all' } = {}) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !/^[-0-9a-f]{0,36}$/i.test(roomId) || !['all', 'present', 'removed'].includes(source))
            throw new Error('INVALID_ADMIN_FILTER');
        const where = `a.room_id LIKE ? AND (?='all' OR (?='present')=EXISTS(SELECT 1 FROM rooms r WHERE r.room_id=a.room_id))`;
        const args = [`${roomId}%`, source, source];
        return { archives: db.prepare(`SELECT ${archiveFields} FROM private_archives_v2 a LEFT JOIN private_archive_admin_meta_v1 m ON m.archive_id=a.id WHERE ${where} ORDER BY a.rowid DESC LIMIT 50 OFFSET ?`).all(...args, offset),
            total: count(`SELECT COUNT(*) AS n FROM private_archives_v2 a WHERE ${where}`, ...args), offset };
    }
    function archive(id) { return db.prepare(`SELECT ${archiveFields} FROM private_archives_v2 a LEFT JOIN private_archive_admin_meta_v1 m ON m.archive_id=a.id WHERE a.id=?`).get(id) ?? null; }
    function room(id) {
        const value = db.prepare(`SELECT ${roomFields} FROM rooms r WHERE r.room_id=?`).get(id);
        if (!value)
            throw new Error('BACKUP_UNAVAILABLE');
        return { ...value, archives: archives({ roomId: id }).archives,
            pendingDevices: count("SELECT COUNT(*) AS n FROM members WHERE room_id=? AND status='pending'", id),
            pendingDeviceLinks: count('SELECT COUNT(*) AS n FROM device_links WHERE room_id=? AND used_at IS NULL AND expires_at>?', id, new Date().toISOString()),
            pendingRepairLinks: count('SELECT COUNT(*) AS n FROM repair_links WHERE room_id=? AND used_at IS NULL AND expires_at>?', id, new Date().toISOString()),
            incompleteAttachments: count('SELECT COUNT(*) AS n FROM blobs WHERE room_id=? AND completed=0', id) };
    }
    function summary() {
        return { checkedAt: new Date().toISOString(), rooms: count('SELECT COUNT(*) AS n FROM rooms'),
            devices: count("SELECT COUNT(*) AS n FROM members WHERE status='active'"),
            archives: count('SELECT COUNT(*) AS n FROM private_archives_v2'), archiveObjects: count('SELECT COUNT(*) AS n FROM private_archive_objects_v2'),
            archiveBytes: count('SELECT COALESCE(SUM(bytes),0) AS n FROM private_archive_objects_v2'),
            messageBytes: count('SELECT COALESCE(SUM(message_bytes),0) AS n FROM rooms'),
            attachmentBytes: count('SELECT COALESCE(SUM(expected_bytes),0) AS n FROM blobs'),
            cleanupBytes: count('SELECT COALESCE(SUM(blob_bytes),0) AS n FROM pending_room_cleanup'),
            cleanupPending: count('SELECT COUNT(*) AS n FROM pending_room_cleanup'),
            incompleteAttachments: count('SELECT COUNT(*) AS n FROM blobs WHERE completed=0'),
            legacyBackups: count('SELECT COUNT(*) AS n FROM recovery_backups WHERE active=1'), limits };
    }
    function events({ offset = 0, q = '' } = {}) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !/^[-A-Za-z0-9_]{0,128}$/.test(q))
            throw new Error('INVALID_ADMIN_FILTER');
        const where = `(?='' OR COALESCE(target_id,room_id,'')=?)`;
        return { events: db.prepare(`SELECT id,action,room_id AS roomId,target_type AS targetType,COALESCE(target_id,room_id) AS targetId,result,created_at AS createdAt FROM admin_events WHERE ${where} ORDER BY id DESC LIMIT 50 OFFSET ?`).all(q, q, offset),
            total: count(`SELECT COUNT(*) AS n FROM admin_events WHERE ${where}`, q, q) };
    }
    return { roomList, room, archives, archive, summary, events,
        recordEvent(action, targetType, targetId, result = 'succeeded') {
            db.prepare('INSERT INTO admin_events(action,room_id,target_type,target_id,result,created_at) VALUES(?,NULL,?,?,?,?)')
                .run(action, targetType, targetId, result, new Date().toISOString());
        } };
}
