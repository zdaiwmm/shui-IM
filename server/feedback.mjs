import { createHash } from 'node:crypto';

export const FEEDBACK_LIMITS = Object.freeze({ message: 5000, email: 254, rows: 10000, page: 25 });
export function validateFeedback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['id', 'email', 'message'].includes(k))) throw new Error('INVALID_FEEDBACK');
  const { id } = value;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('INVALID_FEEDBACK');
  if (typeof value.email !== 'string' || typeof value.message !== 'string') throw new Error('INVALID_FEEDBACK');
  const email = value.email.trim(), message = value.message.trim();
  if (email.length > FEEDBACK_LIMITS.email || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) throw new Error('INVALID_FEEDBACK_EMAIL');
  if (!message || [...message].length > FEEDBACK_LIMITS.message || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) throw new Error('INVALID_FEEDBACK_MESSAGE');
  return { id: id.toLowerCase(), email, message };
}

/** Feedback is deliberately separate from rooms, devices and encrypted message data. */
export function createFeedbackStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_feedback (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, message TEXT NOT NULL,
    digest TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
  ); CREATE INDEX IF NOT EXISTS user_feedback_created ON user_feedback(created_at DESC, id DESC);`);
  const fields = 'id,email,message,created_at AS createdAt,read_at AS readAt';
  return {
    submit(input) {
      const value = validateFeedback(input);
      const digest = createHash('sha256').update(JSON.stringify([value.email,value.message])).digest('hex');
      const existing = db.prepare('SELECT digest FROM user_feedback WHERE id=?').get(value.id);
      if (existing) { if (existing.digest !== digest) throw new Error('FEEDBACK_CONFLICT'); return; }
      if (db.prepare('SELECT COUNT(*) AS count FROM user_feedback').get().count >= FEEDBACK_LIMITS.rows) throw new Error('FEEDBACK_CAPACITY');
      db.prepare('INSERT INTO user_feedback (id,email,message,digest,created_at) VALUES (?,?,?,?,?)').run(value.id,value.email,value.message,digest,new Date().toISOString());
    },
    list({ offset = 0, status = 'all' } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > FEEDBACK_LIMITS.rows || !['all','unread','read'].includes(status)) throw new Error('INVALID_FEEDBACK_FILTER');
      const where = status === 'all' ? '' : ` WHERE read_at IS ${status === 'unread' ? '' : 'NOT '}NULL`;
      const counts = db.prepare('SELECT COUNT(*) AS total, COUNT(read_at) AS read FROM user_feedback').get();
      const total = status === 'all' ? counts.total : status === 'read' ? counts.read : counts.total - counts.read;
      return { total, offset, limit: FEEDBACK_LIMITS.page, counts: { all: counts.total, read: counts.read, unread: counts.total-counts.read },
        items: db.prepare(`SELECT id,email,substr(message,1,100) AS preview,created_at AS createdAt,read_at AS readAt FROM user_feedback${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(FEEDBACK_LIMITS.page,offset) };
    },
    get(id) { return db.prepare(`SELECT ${fields} FROM user_feedback WHERE id=?`).get(id) ?? null; },
    markRead(id) { return db.prepare('UPDATE user_feedback SET read_at=COALESCE(read_at,?) WHERE id=?').run(new Date().toISOString(),id).changes > 0; },
  };
}
