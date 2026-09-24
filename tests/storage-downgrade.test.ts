import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
it('blocks legacy release code once a room has committed a window, using only readonly metadata', async () => {
  const source = await readFile(new URL('../deploy/server/quiet-room-deploy', import.meta.url), 'utf8');
  const start = source.indexOf('if ! grep -Fxq'); const end = source.indexOf('deploy_phase_start build-image', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const code = source.slice(start, end).match(/--input-type=module -e '([\s\S]*?)\n  '/)![1];
  const root = await mkdtemp(path.join(tmpdir(), 'qr-downgrade-'));
  try {
    const db = new DatabaseSync(path.join(root, 'quiet-room.sqlite'));
    db.exec('CREATE TABLE rooms(room_id TEXT)');
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DATA_DIR: root } }).status;
    expect(run()).toBe(0);
    db.exec('ALTER TABLE rooms ADD COLUMN window_enabled INTEGER NOT NULL DEFAULT 0; INSERT INTO rooms VALUES (\'fixture\', 0)');
    expect(run()).toBe(0);
    db.exec('UPDATE rooms SET window_enabled=1'); expect(run()).toBe(78);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
