import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createStickerSource, decryptPublicSticker, matchStickerPacks, publicStickerAnimated } from './sticker-source.mjs';
import { fetchMemeResource, memeContentType } from './memes.mjs';

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_PACK = 64 * 1024 * 1024;
const MAX_STORAGE = 1024 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
function query(body) {
  if (!body || !['gifs', 'stickers'].includes(body.kind) || typeof body.keyword !== 'string'
    || body.keyword.length > 80 || /[\u0000-\u001f]/.test(body.keyword)
    || !Number.isSafeInteger(body.page) || body.page < 1 || body.page > 1000) fail('MEME_INVALID_QUERY');
}
function metadata(body) {
  if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120
    || typeof body.tags !== 'string' || body.tags.length > 2048
    || !['pending', 'published'].includes(body.status)) fail('MEME_INVALID_QUERY');
  return [body.title.trim(), body.tags, body.status];
}

export function createExpressionCatalog({ dataDir, fetchResource = fetchMemeResource, now = Date.now }) {
  // The existing online SQLite snapshot includes public catalog originals too.
  const db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'), { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS assets (hash TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
      tags TEXT NOT NULL, author TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS entry_status ON entries(kind,status,created);
    CREATE TABLE IF NOT EXISTS items (entry TEXT REFERENCES entries(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, hash TEXT REFERENCES assets(hash), title TEXT NOT NULL, PRIMARY KEY(entry,position));
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  `);
  for (const row of db.prepare('SELECT * FROM jobs').all()) {
    const job = JSON.parse(row.body);
    if (job.status === 'running') { job.status = 'interrupted'; db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job), row.id); }
  }
  const source = createStickerSource(fetchResource, now);
  const grants = new Map();
  let running;
  let controller;
  let closing = false;
  const get = id => db.prepare('SELECT * FROM entries WHERE id=?').get(id) ?? fail('MEME_NOT_FOUND');
  const items = id => db.prepare('SELECT position,hash,title FROM items WHERE entry=? ORDER BY position').all(id);
  function grant(owner, entry, item) {
    for (const [id, value] of grants) if (value.expires <= now()) grants.delete(id);
    while (grants.size >= 4000) grants.delete(grants.keys().next().value);
    const id = randomUUID(); grants.set(id, { owner, entry, hash: item.hash, expires: now() + 15 * 60_000 });
    return { id, title: item.title };
  }
  function put(entry, files) {
    if (db.prepare('SELECT 1 FROM entries WHERE id=?').get(entry.id)) return false;
    if (!files.length || files.length > 200 || files.reduce((sum, f) => sum + f.bytes.length, 0) > MAX_PACK) fail('MEME_TOO_LARGE');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?)').run(entry.id, entry.kind, entry.title, entry.tags, entry.author, entry.source, 'pending', now());
      for (const [position, file] of files.entries()) {
        if (!file.bytes.length || file.bytes.length > MAX_IMAGE) fail('MEME_TOO_LARGE');
        const hash = digest(file.bytes); const type = memeContentType(file.bytes);
        db.prepare('INSERT OR IGNORE INTO assets VALUES (?,?,?)').run(hash, type, file.bytes);
        db.prepare('INSERT INTO items VALUES (?,?,?,?)').run(entry.id, position, hash, file.title);
      }
      if (db.prepare('SELECT coalesce(sum(length(bytes)),0) AS size FROM assets').get().size > MAX_STORAGE
        || db.prepare('SELECT count(*) AS count FROM entries').get().count > 10000) fail('MEME_STORAGE_FULL');
      db.exec('COMMIT'); return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const saveJob = job => db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)').run(job.id, JSON.stringify(job));
  async function collect(job, body, signal) {
    try {
      const rows = matchStickerPacks(await source.list(signal), body.keyword, body.kind === 'gifs');
      const candidates = body.sourceId ? rows.filter(row => row.id === body.sourceId) : rows;
      for (const row of candidates) {
        if (job.added >= job.target || job.scanned >= 200) break;
        signal.throwIfAborted(); job.scanned++;
        if (body.kind === 'stickers' && db.prepare('SELECT 1 FROM entries WHERE id=?').get(row.id)) { job.skipped++; saveJob(job); continue; }
        try {
          const pack = await source.pack(row.id, signal);
          const files = []; let total = 0;
          for (const item of pack.items) {
            signal.throwIfAborted();
            const id = `gif-${row.id}-${item.id}`;
            if (body.kind === 'gifs' && db.prepare('SELECT 1 FROM entries WHERE id=?').get(id)) { job.skipped++; continue; }
            const bytes = decryptPublicSticker(await fetchResource(item.url, MAX_IMAGE + 64, signal), item.key);
            memeContentType(bytes); total += bytes.length;
            if (!bytes.length || bytes.length > MAX_IMAGE || total > MAX_PACK) fail('MEME_TOO_LARGE');
            if (body.kind === 'gifs') {
              if (!publicStickerAnimated(bytes)) { job.skipped++; continue; }
              if (put({ ...row, id, kind: body.kind, source: `https://signalstickers.org/pack/${row.id}` }, [{ bytes, title: item.title }])) job.added++;
              saveJob(job); if (job.added >= job.target) break;
            } else files.push({ bytes, title: item.title });
          }
          signal.throwIfAborted();
          if (body.kind === 'stickers' && put({ ...row, kind: body.kind, source: `https://signalstickers.org/pack/${row.id}` }, files)) job.added++;
        } catch (error) {
          if (signal.aborted || error.message === 'MEME_STORAGE_FULL') throw error;
          job.failed++;
        }
        saveJob(job);
      }
      job.status = job.added >= job.target ? 'completed' : 'partial';
    } catch (error) { job.status = signal.aborted ? 'interrupted' : 'failed'; job.error = error.message === 'MEME_STORAGE_FULL' ? '资源库容量已满' : '采集未完成，请重试'; }
    finally { job.finished = now(); saveJob(job); }
  }
  const service = {
    async search(owner, body, signal) {
      query(body); signal?.throwIfAborted();
      const rows = matchStickerPacks(db.prepare('SELECT * FROM entries WHERE kind=? AND status=? ORDER BY created DESC,id').all(body.kind, 'published'), body.keyword);
      const start = (body.page - 1) * 24; const page = rows.slice(start, start + 24);
      return { items: body.kind === 'gifs' ? page.map(row => grant(owner, row.id, { ...items(row.id)[0], title: row.title })) : [],
        ...(body.kind === 'stickers' ? { packs: page.map(row => ({ id: row.id, title: row.title, cover: grant(owner, row.id, items(row.id)[0]).id })) } : {}),
        nextPage: start + 24 < rows.length ? body.page + 1 : null, source: '表情资源库' };
    },
    async pack(owner, id, signal) {
      signal?.throwIfAborted(); const row = get(id);
      if (row.status !== 'published' || row.kind !== 'stickers') fail('MEME_NOT_FOUND');
      return { id, title: row.title, items: items(id).map(item => grant(owner, id, item)) };
    },
    async media(owner, id, signal) {
      signal?.throwIfAborted(); const access = grants.get(id);
      if (!access || access.owner !== owner || access.expires <= now() || get(access.entry).status !== 'published') fail('MEME_NOT_FOUND');
      const row = db.prepare('SELECT type,bytes FROM assets WHERE hash=?').get(access.hash);
      if (!row) fail('MEME_NOT_FOUND');
      return { type: row.type, bytes: Buffer.from(row.bytes) };
    },
    list(body) {
      query(body);
      if (!['all', 'pending', 'published'].includes(body.status)) fail('MEME_INVALID_QUERY');
      const rows = matchStickerPacks(db.prepare(`SELECT entries.*, (SELECT count(*) FROM items WHERE entry=entries.id) AS count FROM entries WHERE kind=? ORDER BY created DESC,id`).all(body.kind), body.keyword)
        .filter(row => body.status === 'all' || row.status === body.status);
      return { entries: rows.slice((body.page - 1) * 24, body.page * 24), total: rows.length, jobs: service.jobs() };
    },
    detail(id) { return { ...get(id), items: items(id) }; },
    create(body) {
      metadata({ ...body, status: 'pending' });
      if (!['gifs', 'stickers'].includes(body.kind) || !Array.isArray(body.files) || !body.files.length || body.files.length > 200
        || (body.kind === 'gifs' && body.files.length !== 1)) fail('MEME_INVALID_QUERY');
      const files = body.files.map(file => {
        if (!file || typeof file.data !== 'string' || file.data.length > 12 * 1024 * 1024
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) fail('MEME_INVALID_QUERY');
        const bytes = Buffer.from(file.data, 'base64');
        if (bytes.toString('base64') !== file.data) fail('MEME_INVALID_QUERY');
        if (body.kind === 'gifs' && !publicStickerAnimated(bytes)) fail('MEME_INVALID_IMAGE');
        return { bytes, title: body.title.trim() };
      });
      if (files.reduce((sum, file) => sum + file.bytes.length, 0) > MAX_IMAGE) fail('MEME_TOO_LARGE');
      const id = randomUUID();
      put({ id, kind: body.kind, title: body.title.trim(), tags: body.tags, author: '管理员上传', source: '手动上传' }, files);
      return service.detail(id);
    },
    preview(id, position) {
      get(id); const item = items(id).find(item => item.position === position) ?? fail('MEME_NOT_FOUND');
      const row = db.prepare('SELECT type,bytes FROM assets WHERE hash=?').get(item.hash);
      return { type: row.type, bytes: Buffer.from(row.bytes) };
    },
    update(id, body) { get(id); const values = metadata(body); db.prepare('UPDATE entries SET title=?,tags=?,status=? WHERE id=?').run(...values, id); return service.detail(id); },
    remove(id) {
      get(id); db.exec('BEGIN IMMEDIATE');
      try { db.prepare('DELETE FROM entries WHERE id=?').run(id); db.exec('DELETE FROM assets WHERE NOT EXISTS (SELECT 1 FROM items WHERE items.hash=assets.hash); COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      for (const [key, value] of grants) if (value.entry === id) grants.delete(key);
      return { deleted: true };
    },
    jobs() { return db.prepare('SELECT body FROM jobs ORDER BY rowid DESC LIMIT 20').all().map(row => JSON.parse(row.body)); },
    start(body) {
      query({ ...body, page: 1 });
      if (!Number.isSafeInteger(body.target) || body.target < 1 || body.target > 100
        || (body.sourceId !== undefined && !/^[a-f0-9]{32}$/.test(body.sourceId))) fail('MEME_INVALID_QUERY');
      if (running || closing) fail('MEME_BUSY');
      const job = { id: randomUUID(), kind: body.kind, target: body.target, added: 0, scanned: 0, skipped: 0, failed: 0, status: 'running', created: now() };
      saveJob(job); db.exec('DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY rowid DESC LIMIT 20)');
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
      running = collect(job, body, controller.signal).finally(() => { clearTimeout(timeout); running = undefined; });
      return { ...job };
    },
    async close() { closing = true; controller?.abort(); await running; db.close(); },
  };
  return service;
}
