import { createNotoSource } from './noto-source.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseWastickers } from './wastickers.mjs';
import { createStickerSource, decryptPublicSticker, matchStickerPacks, publicStickerAnimated } from './sticker-source.mjs';
import { fetchMemeResource, memeContentType } from './memes.mjs';

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_PACK = 50 * 1024 * 1024;
const MAX_STORAGE = 1024 * 1024 * 1024;
const MAX_RUNNING_JOBS = 10;
const PACK_DOWNLOAD_CONCURRENCY = 4;
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
    CREATE TABLE IF NOT EXISTS expression_initializations (id TEXT PRIMARY KEY, completed INTEGER NOT NULL);
  `);
  for (const row of db.prepare('SELECT * FROM jobs').all()) {
    const job = JSON.parse(row.body);
    if (['running', 'queued'].includes(job.status)) {
      job.status = 'failed'; job.error = '服务重启，任务未完成，可重试'; job.finished = now(); job.phase = 'finished';
      db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job), row.id);
    } else if (job.status === 'exists') {
      job.status = 'completed'; job.error = ''; db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job), row.id);
    } else if (['partial', 'interrupted'].includes(job.status)) {
      job.status = 'failed'; job.error ||= '历史任务未完成，可重试'; db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job), row.id);
    }
  }
  const source = createStickerSource(fetchResource, now);
  const noto = createNotoSource(fetchResource, now);
  const channelSource = channel => channel === 'noto' ? noto : channel === 'signal' || channel === undefined ? source : fail('MEME_INVALID_QUERY');
  const entryId = (row, kind, itemId = 0) => row.id.startsWith('noto-') ? row.id : kind === 'gifs' ? `gif-${row.id}-${itemId}` : row.id;
  const grants = new Map();
  const running = new Set();
  const controllers = new Map();
  let closing = false;
  const queue = [];
  const previews = new Map();
  const previewPending = new Map();
  let previewBytes = 0;
  let activePreviews = 0;
  const previewWaiters = [];
  const get = id => db.prepare('SELECT * FROM entries WHERE id=?').get(id) ?? fail('MEME_NOT_FOUND');
  const items = id => db.prepare('SELECT position,hash,title FROM items WHERE entry=? ORDER BY position').all(id);
  function grant(owner, entry, item) {
    for (const [id, value] of grants) if (value.expires <= now()) grants.delete(id);
    while (grants.size >= 4000) grants.delete(grants.keys().next().value);
    const id = randomUUID(); grants.set(id, { owner, entry, hash: item.hash, expires: now() + 15 * 60_000 });
    return { id, title: item.title };
  }
  function put(entry, files, { transaction = true, status = 'pending' } = {}) {
    if (db.prepare('SELECT 1 FROM entries WHERE id=?').get(entry.id)) return false;
    if (!files.length || files.length > 200 || files.reduce((sum, f) => sum + f.bytes.length, 0) > MAX_PACK) fail('MEME_TOO_LARGE');
    if (transaction) db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?)').run(entry.id, entry.kind, entry.title, entry.tags, entry.author, entry.source, status, now());
      for (const [position, file] of files.entries()) {
        if (!file.bytes.length || file.bytes.length > MAX_IMAGE) fail('MEME_TOO_LARGE');
        const hash = digest(file.bytes); const type = memeContentType(file.bytes);
        db.prepare('INSERT OR IGNORE INTO assets VALUES (?,?,?)').run(hash, type, file.bytes);
        db.prepare('INSERT INTO items VALUES (?,?,?,?)').run(entry.id, position, hash, file.title);
      }
      if (db.prepare('SELECT coalesce(sum(length(bytes)),0) AS size FROM assets').get().size > MAX_STORAGE
        || db.prepare('SELECT count(*) AS count FROM entries').get().count > 10000) fail('MEME_STORAGE_FULL');
      if (transaction) db.exec('COMMIT'); return true;
    } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
  }
  const saveJob = job => db.prepare('INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(job.id, JSON.stringify(job));
  const getJob = id => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('MEME_INVALID_QUERY');
    const row = db.prepare('SELECT body FROM jobs WHERE id=?').get(id) ?? fail('MEME_NOT_FOUND');
    return JSON.parse(row.body);
  };
  async function downloadStickerPack(pack, job, signal) {
    const files = new Array(pack.items.length);
    const packController = new AbortController();
    const packSignal = AbortSignal.any([signal, packController.signal]);
    let cursor = 0; let total = 0;
    const worker = async () => {
      while (cursor < pack.items.length) {
        const index = cursor++; const item = pack.items[index];
        packSignal.throwIfAborted();
        const raw = await fetchResource(item.url, MAX_IMAGE + 64, packSignal);
        const bytes = item.key ? decryptPublicSticker(raw, item.key) : raw;
        memeContentType(bytes);
        if (!bytes.length || bytes.length > MAX_IMAGE || total + bytes.length > MAX_PACK) fail('MEME_TOO_LARGE');
        total += bytes.length; files[index] = { bytes, title: item.title };
        job.downloadedFiles++; job.downloadedBytes += bytes.length; saveJob(job);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PACK_DOWNLOAD_CONCURRENCY, pack.items.length) }, worker));
      return files;
    } catch (error) {
      packController.abort(error);
      throw error;
    }
  }
  async function collect(job, body, signal) {
    try {
      const upstream = channelSource(body.channel);
      const directory = await upstream.list(signal);
      // Resolve the selected source id against the upstream directory.
      // Do not re-run the UI display title through search: titles are truncated
      // for presentation and can change independently of the stable pack id.
      const rows = body.sourceId
        ? directory.filter(row => row.id === body.sourceId && (body.kind !== 'gifs' || row.animated))
        : matchStickerPacks(directory, body.keyword, body.kind === 'gifs');
      const candidates = rows;
      for (const row of candidates) {
        if (job.added >= job.target || job.scanned >= 200) break;
        signal.throwIfAborted(); job.scanned++; job.title = row.title; job.phase = 'manifest'; saveJob(job);
        if (body.kind === 'stickers' && db.prepare('SELECT 1 FROM entries WHERE id=?').get(row.id)) { job.skipped++; job.existing++; saveJob(job); continue; }
        try {
          const pack = await upstream.pack(row.id, signal);
          let files = [];
          job.totalFiles = pack.items.length; job.downloadedFiles = 0; job.packStarted = now(); job.phase = 'downloading'; saveJob(job);
          if (body.kind === 'stickers') {
            files = await downloadStickerPack(pack, job, signal);
          } else for (const item of pack.items) {
            signal.throwIfAborted();
            const id = entryId(row, body.kind, item.id);
            if (body.kind === 'gifs' && db.prepare('SELECT 1 FROM entries WHERE id=?').get(id)) { job.skipped++; job.existing++; continue; }
            const raw = await fetchResource(item.url, MAX_IMAGE + 64, signal);
            const bytes = item.key ? decryptPublicSticker(raw, item.key) : raw;
            memeContentType(bytes);
            job.downloadedFiles++; job.downloadedBytes += bytes.length; saveJob(job);
            if (!bytes.length || bytes.length > MAX_IMAGE) fail('MEME_TOO_LARGE');
            if (!publicStickerAnimated(bytes)) { job.skipped++; continue; }
            if (put({ ...row, id, kind: body.kind, source: body.channel === 'noto' ? row.source : `https://signalstickers.org/pack/${row.id}` }, [{ bytes, title: item.title }], { status: 'published' })) job.added++;
            saveJob(job); if (job.added >= job.target) break;
          }
          signal.throwIfAborted();
          if (body.kind === 'stickers' && put({ ...row, kind: body.kind, source: body.channel === 'noto' ? row.source : `https://signalstickers.org/pack/${row.id}` }, files, { status: 'published' })) job.added++;
        } catch (error) {
          if (signal.aborted || error.message === 'MEME_STORAGE_FULL') throw error;
          job.failed++; job.error = ({ MEME_TOO_LARGE: '资源超过大小限制', MEME_INVALID_IMAGE: '原图校验失败', MEME_UPSTREAM_UNAVAILABLE: '来源服务暂不可用', MEME_DNS_REJECTED: '来源域名解析失败' })[error.message] || '来源下载失败，请重试';
        }
        saveJob(job);
      }
      job.status = job.added >= job.target || (body.sourceId && job.existing > 0 && !job.failed) ? 'completed' : 'failed';
      if (job.status === 'failed' && !job.error) job.error = '没有可入库的资源，请重试或选择其他资源';
    } catch (error) {
      if (signal.aborted && signal.reason === 'cancelled') { job.status = 'cancelled'; job.error = '';
      } else {
        job.status = 'failed';
        job.error = error.message === 'MEME_STORAGE_FULL' ? '资源库容量已满'
          : signal.aborted && signal.reason === 'timeout' ? '采集超时，请重试'
          : signal.aborted && signal.reason === 'shutdown' ? '服务停止，任务未完成，可重试'
          : '采集未完成，请重试';
      }
    }
    finally { job.finished = now(); job.phase = 'finished'; saveJob(job); }
  }
  function runNext() {
    while (running.size < MAX_RUNNING_JOBS && !closing && queue.length) {
      const { job, body } = queue.shift();
      job.status = 'running'; job.started = now(); job.phase = 'directory'; saveJob(job);
      const controller = new AbortController(); controllers.set(job.id, controller);
      const timeout = setTimeout(() => controller.abort('timeout'), 10 * 60_000);
      const promise = collect(job, body, controller.signal).finally(() => {
        clearTimeout(timeout); running.delete(promise); controllers.delete(job.id); runNext();
      });
      running.add(promise);
    }
  }
  const service = {
    async sourceSearch(body, signal) {
      query(body);
      const rows = matchStickerPacks(await channelSource(body.channel).list(signal), body.keyword, body.kind === 'gifs');
      const start = (body.page - 1) * 24;
      return { packs: rows.slice(start, start + 24).map(row => ({ id: row.id, title: row.title, author: row.author,
        collected: !!db.prepare('SELECT 1 FROM entries WHERE id=?').get(entryId(row, body.kind)),
        cover: `/admin-api/expressions/source/${row.id}/media` })), total: rows.length };
    },
    async sourcePreview(id, signal) {
      // Already collected covers never need to revisit the upstream network.
      if (db.prepare('SELECT 1 FROM entries WHERE id=?').get(id)) return service.preview(id, 0);
      const cached = previews.get(id);
      if (cached && now() - cached.time < 15 * 60_000) return cached.result;
      if (previewPending.has(id)) return previewPending.get(id);
      if (previewWaiters.length >= 24) fail('MEME_BUSY');
      const pending = (async () => {
        if (activePreviews >= 3) await new Promise(resolve => previewWaiters.push(resolve));
        else activePreviews++;
        try {
          signal?.throwIfAborted();
          const pack = await channelSource(id.startsWith('noto-') ? 'noto' : 'signal').pack(id, signal);
          const raw = await fetchResource(pack.cover.url, MAX_IMAGE + 64, signal);
          const bytes = pack.cover.key ? decryptPublicSticker(raw, pack.cover.key) : raw;
          if (!bytes.length || bytes.length > MAX_IMAGE) fail('MEME_TOO_LARGE');
          const result = { type: memeContentType(bytes), bytes };
          const previous = previews.get(id);
          if (previous) { previews.delete(id); previewBytes -= previous.result.bytes.length; }
          while (previewBytes + bytes.length > 16 * 1024 * 1024 || previews.size >= 100) {
            const oldest = previews.keys().next().value;
            previewBytes -= previews.get(oldest).result.bytes.length; previews.delete(oldest);
          }
          previews.set(id, { result, time: now() }); previewBytes += bytes.length;
          return result;
        } finally {
          const next = previewWaiters.shift(); if (next) next(); else activePreviews--;
        }
      })().finally(() => previewPending.delete(id));
      previewPending.set(id, pending); return pending;
    },
    // Only the explicit repository initializer uses this entry point. Keeping
    // the marker in the snapshot prevents a later run from undoing moderation.
    initializeShipped(loadEntries, id = 'shipped-library-v1') {
      if (running.size || closing) fail('MEME_BUSY');
      if (!/^[a-z0-9-]{1,64}$/.test(id)) fail('MEME_INVALID_QUERY');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare('SELECT 1 FROM expression_initializations WHERE id=?').get(id)) {
          db.exec('COMMIT'); return { initialized: false, added: 0, skipped: 0 };
        }
        let added = 0; let skipped = 0;
        for (const { entry, files } of loadEntries()) {
          if (put(entry, files, { transaction: false, status: 'published' })) added++;
          else skipped++;
        }
        db.prepare('INSERT INTO expression_initializations VALUES (?,?)').run(id, now());
        db.exec('COMMIT'); return { initialized: true, added, skipped };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
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
      const count = db.prepare('SELECT count(*) AS count FROM items WHERE entry=?');
      const offset = (body.page - 1) * 24;
      let page; let total;
      if (!body.keyword.trim()) {
        const where = body.status === 'all' ? 'kind=?' : 'kind=? AND status=?';
        const params = body.status === 'all' ? [body.kind] : [body.kind, body.status];
        total = db.prepare(`SELECT count(*) AS count FROM entries WHERE ${where}`).get(...params).count;
        page = db.prepare(`SELECT * FROM entries WHERE ${where} ORDER BY created DESC,id LIMIT 24 OFFSET ?`).all(...params, offset);
      } else {
        const rows = matchStickerPacks(db.prepare(`SELECT * FROM entries WHERE kind=? AND (?='all' OR status=?) ORDER BY created DESC,id`).all(body.kind, body.status, body.status), body.keyword);
        total = rows.length; page = rows.slice(offset, offset + 24);
      }
      return { entries: page.map(row => ({ ...row, count: count.get(row.id).count })), total };
    },
    detail(id) { const files = items(id); return { ...get(id), count: files.length, items: files }; },
    async create(body) {
      if (!body || !Array.isArray(body.files) || !body.files.length || body.files.length > 200
        || (body.kind === 'gifs' && body.files.length !== 1)) fail('MEME_INVALID_QUERY');
      const packageUpload = body.files.length === 1 && typeof body.files[0]?.name === 'string' && /\.wastickers$/i.test(body.files[0].name);
      const kind = packageUpload ? 'stickers' : body.kind;
      if (!['gifs', 'stickers'].includes(kind) || (kind === 'gifs' && body.files.length !== 1)) fail('MEME_INVALID_QUERY');
      if (packageUpload) {
        const data = body.files[0].data;
        if (typeof data !== 'string' || data.length > 70 * 1024 * 1024
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('MEME_INVALID_QUERY');
        const packageBytes = Buffer.from(body.files[0].data, 'base64');
        if (packageBytes.toString('base64') !== data) fail('MEME_INVALID_QUERY');
        const parsed = await parseWastickers(packageBytes);
        body = { ...body, title: parsed.title || body.title, files: parsed.files.map(file => ({ data: file.bytes.toString('base64') })) };
      }
      if (closing) fail('MEME_BUSY');
      const status = body.status === 'published' ? 'published' : 'pending';
      metadata({ ...body, status });
      const files = body.files.map(file => {
        if (!file || typeof file.data !== 'string' || file.data.length > 70 * 1024 * 1024
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) fail('MEME_INVALID_QUERY');
        const bytes = Buffer.from(file.data, 'base64');
        if (bytes.toString('base64') !== file.data) fail('MEME_INVALID_QUERY');
        if (kind === 'gifs' && !publicStickerAnimated(bytes)) fail('MEME_INVALID_IMAGE');
        return { bytes, title: body.title.trim() };
      });
      if (files.reduce((sum, file) => sum + file.bytes.length, 0) > (packageUpload ? MAX_PACK : MAX_IMAGE)) fail('MEME_TOO_LARGE');
      const id = randomUUID();
      put({ id, kind, title: body.title.trim(), tags: body.tags, author: '管理员上传', source: '手动上传' }, files, { status });
      return service.detail(id);
    },
    preview(id, position) {
      get(id); const item = db.prepare('SELECT hash FROM items WHERE entry=? AND position=?').get(id, position) ?? fail('MEME_NOT_FOUND');
      const row = db.prepare('SELECT type,bytes FROM assets WHERE hash=?').get(item.hash);
      return { type: row.type, bytes: Buffer.from(row.bytes) };
    },
    update(id, body) { get(id); const values = metadata(body); db.prepare('UPDATE entries SET title=?,tags=?,status=? WHERE id=?').run(...values, id); return service.detail(id); },
    updateStatus(body) {
      if (!body || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 24
        || body.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
        || new Set(body.ids).size !== body.ids.length || !['pending', 'published'].includes(body.status)) fail('MEME_INVALID_QUERY');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of body.ids) get(id);
        const update = db.prepare('UPDATE entries SET status=? WHERE id=?');
        for (const id of body.ids) update.run(body.status, id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { updated: body.ids.length };
    },
    removeItem(id, position) {
      get(id); const selected = items(id).find(item => item.position === position) ?? fail('MEME_NOT_FOUND');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM items WHERE entry=? AND position=?').run(id, position);
        db.prepare('UPDATE items SET position=position-1 WHERE entry=? AND position>?').run(id, position);
        if (!db.prepare('SELECT 1 FROM items WHERE hash=?').get(selected.hash)) db.prepare('DELETE FROM assets WHERE hash=?').run(selected.hash);
        if (!db.prepare('SELECT 1 FROM items WHERE entry=?').get(id)) db.prepare('DELETE FROM entries WHERE id=?').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return db.prepare('SELECT 1 FROM entries WHERE id=?').get(id) ? service.detail(id) : { deleted: true };
    },
    remove(id) {
      get(id); db.exec('BEGIN IMMEDIATE');
      try { db.prepare('DELETE FROM entries WHERE id=?').run(id); db.exec('DELETE FROM assets WHERE NOT EXISTS (SELECT 1 FROM items WHERE items.hash=assets.hash); COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      for (const [key, value] of grants) if (value.entry === id) grants.delete(key);
      return { deleted: true };
    },
    jobs() { return db.prepare('SELECT body FROM jobs ORDER BY rowid DESC LIMIT 100').all().map(row => JSON.parse(row.body)); },
    start(body) {
      body = { ...body, keyword: body?.sourceId ? '' : body?.keyword ?? '' };
      query({ ...body, page: 1 });
      channelSource(body.channel);
      if (body.channel === 'noto' && body.kind !== 'gifs') fail('MEME_INVALID_QUERY');
      if (!Number.isSafeInteger(body.target) || body.target < 1 || body.target > 100
        || (body.sourceId !== undefined && !(body.channel === 'noto' ? /^noto-[a-f0-9]{4,6}(?:_[a-f0-9]{4,6}){0,10}$/ : /^[a-f0-9]{32}$/).test(body.sourceId))) fail('MEME_INVALID_QUERY');
      if (closing) fail('MEME_BUSY');
      const duplicate = service.jobs().find(job => ['running', 'queued'].includes(job.status) && body.sourceId && job.sourceId === body.sourceId && job.kind === body.kind);
      if (duplicate) return duplicate;
      if (queue.length + running.size >= 20) fail('MEME_BUSY');
      const job = { id: randomUUID(), channel: body.channel ?? 'signal', sourceId: body.sourceId, keyword: body.keyword, kind: body.kind, target: body.target, added: 0, scanned: 0, skipped: 0, existing: 0, failed: 0, status: 'queued', phase: 'queued', downloadedFiles: 0, totalFiles: 0, downloadedBytes: 0, created: now() };
      saveJob(job); db.exec("DELETE FROM jobs WHERE json_extract(body,'$.status') NOT IN ('running','queued') AND id NOT IN (SELECT id FROM jobs ORDER BY rowid DESC LIMIT 20)");
      queue.push({ job, body }); runNext();
      return { ...job };
    },
    cancel(id) {
      const job = getJob(id);
      if (!['running', 'queued'].includes(job.status)) return job;
      const queued = queue.findIndex(item => item.job.id === id);
      if (queued >= 0) queue.splice(queued, 1);
      job.status = 'cancelled'; job.error = ''; job.finished = now(); job.phase = 'finished'; saveJob(job);
      controllers.get(id)?.abort('cancelled');
      return { ...job };
    },
    retry(id) {
      const job = getJob(id);
      if (['running', 'queued'].includes(job.status)) fail('MEME_BUSY');
      if (!job.sourceId && typeof job.keyword !== 'string') fail('MEME_INVALID_QUERY');
      return service.start({ channel: job.channel, sourceId: job.sourceId, keyword: job.keyword ?? '', kind: job.kind, target: job.target });
    },
    async close() {
      closing = true;
      for (const { job } of queue.splice(0)) { job.status = 'failed'; job.error = '服务停止，任务未完成，可重试'; job.finished = now(); job.phase = 'finished'; saveJob(job); }
      for (const controller of controllers.values()) controller.abort('shutdown');
      await Promise.all(running); db.close();
    },
  };
  return service;
}
