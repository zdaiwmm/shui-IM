import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve('deploy/server/quiet-room-backup-export');
async function simulate(failure: '' | 'docker' | 'check') {
  const root = await mkdtemp(path.join(tmpdir(), 'quiet-room-export-'));
  try {
    const bin = path.join(root, 'bin');
    const backup = path.join(root, 'backups', 'quiet-room-2026-09-04T00-00-00-000Z');
    await mkdir(bin);
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(backup, 'manifest.json'), '{}');
    for (const command of ['docker', 'rclone']) {
      const executable = path.join(bin, command);
      await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${command}'\" $*\" >> \"$EXPORT_TEST_TRACE\"\nif [ \"$EXPORT_TEST_FAILURE\" = '${command}' ] || [ \"$EXPORT_TEST_FAILURE\" = \"$1\" ]; then exit 1; fi\n`);
      await chmod(executable, 0o755);
    }
    const state = path.join(root, 'state');
    const tracePath = path.join(root, 'trace');
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QUIET_ROOM_BACKUP_DIR: path.dirname(backup), QUIET_ROOM_BACKUP_REMOTE: 'offsite:private-bucket/quiet-room', QUIET_ROOM_OPS_STATE_DIR: state, EXPORT_TEST_FAILURE: failure, EXPORT_TEST_TRACE: tracePath },
    });
    return { status: result.status, trace: await readFile(tracePath, 'utf8'), receipt: await access(path.join(state, 'offsite-verified-at')).then(() => true, () => false) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('verified offsite export', () => {
  it('does not upload a failed local verification', async () => {
    const result = await simulate('docker');
    expect(result.status).not.toBe(0);
    expect(result.trace).not.toContain('rclone');
    expect(result.receipt).toBe(false);
  });
  it('does not report success when downloaded remote bytes fail comparison', async () => {
    const result = await simulate('check');
    expect(result.status).not.toBe(0);
    expect(result.trace).toContain('--immutable --checksum');
    expect(result.trace).toContain('--download --one-way');
    expect(result.receipt).toBe(false);
  });
  it('records freshness only after local verification, upload and remote comparison', async () => {
    const result = await simulate('');
    expect(result.status).toBe(0);
    expect(result.trace.indexOf('docker')).toBeLessThan(result.trace.indexOf('rclone copy'));
    expect(result.trace.indexOf('rclone copy')).toBeLessThan(result.trace.indexOf('rclone check'));
    expect(result.receipt).toBe(true);
  });
});
