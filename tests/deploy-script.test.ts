import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = path.join(PROJECT_ROOT, 'deploy/server/quiet-room-deploy');

describe('production deployment rollback safety contract', () => {
  it('has valid Bash syntax', () => {
    const result = spawnSync('bash', ['-n', DEPLOY_SCRIPT], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('has valid POSIX shell syntax in both archive containers', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const embeddedScripts = [...source.matchAll(/sh -ceu '\n([\s\S]*?)\n    '/g)].map((match) => match[1]);

    expect(embeddedScripts).toHaveLength(2);
    for (const embedded of embeddedScripts) {
      const result = spawnSync('sh', ['-n'], { encoding: 'utf8', input: embedded });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  });

  it('atomically publishes and verifies cold archives', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const archiveFunction = source.slice(
      source.indexOf('create_data_archive()'),
      source.indexOf('restore_data_archive()'),
    );

    expect(archiveFunction).toContain('.${ARCHIVE_NAME}.partial');
    expect(archiveFunction.indexOf('tar -tzf "$partial"')).toBeLessThan(
      archiveFunction.indexOf('mv -- "$partial" "$final"'),
    );
    expect(archiveFunction.indexOf('mv -- "$partial" "$final"')).toBeLessThan(
      archiveFunction.indexOf('validate_data_archive "$archive_path"'),
    );
  });

  it('stops new containers, preserves failed-cutover writes, restores data, then starts the old image', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const rollback = source.slice(source.indexOf('rollback()'), source.indexOf("trap 'exit_code=$?"));
    const stop = rollback.indexOf('stop_project_containers');
    const quiescent = rollback.indexOf('ensure_data_volume_quiescent');
    const preserve = rollback.indexOf('create_data_archive "$rollback_image" "$failed_cutover_backup_name"');
    const restore = rollback.indexOf('restore_data_archive "$rollback_image" "$backup_path"');
    const startOld = rollback.indexOf('QUIET_ROOM_IMAGE="$previous_image" docker compose');

    expect(stop).toBeGreaterThan(-1);
    expect(quiescent).toBeGreaterThan(stop);
    expect(preserve).toBeGreaterThan(quiescent);
    expect(restore).toBeGreaterThan(preserve);
    expect(startOld).toBeGreaterThan(restore);
    expect(rollback).toContain("rollback_fail_closed 'could-not-preserve-failed-cutover-data'");
    expect(rollback).toContain("rollback_fail_closed 'could-not-restore-predeploy-backup'");
  });

  it('marks the volume for restoration before the new image can start', async () => {
    const source = await readFile(DEPLOY_SCRIPT, 'utf8');
    const cutover = source.slice(source.indexOf('backup_name="data-'));
    const restoreRequired = cutover.indexOf('data_restore_required=1');
    const startNew = cutover.indexOf('QUIET_ROOM_IMAGE="$new_image" docker compose');

    expect(restoreRequired).toBeGreaterThan(-1);
    expect(startNew).toBeGreaterThan(restoreRequired);
    expect(source).toContain('Predeploy backup retained at: %s');
    expect(source).toContain('Failed-cutover data retained at: %s');
  });
});
