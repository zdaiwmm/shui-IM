import { readdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';

/** Only verified points count toward the daily recovery window. Unknown files stay. */
export async function pruneDailyBackups(root, retainDays, verify) {
  if (!Number.isSafeInteger(retainDays) || retainDays < 2) throw new Error('INVALID_BACKUP_RETENTION');
  const names = (await readdir(root)).filter(name => /^quiet-room-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(name)).sort().reverse();
  const days = new Set();
  const removed = [];
  for (const name of names) {
    const target = path.join(root, name);
    if (!(await lstat(target)).isDirectory()) continue;
    try { await verify(target); } catch { continue; }
    const day = name.slice(11, 21);
    if (!days.has(day) && days.size < retainDays) { days.add(day); continue; }
    await rm(target, { recursive: true }); removed.push(name);
  }
  return removed;
}
