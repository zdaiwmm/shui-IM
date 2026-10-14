import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
describe('root staged-image protocol', () => {
  it('rejects stale, foreign, writable and symlinked receipts before any activation', () => {
    const result = spawnSync('python3', ['tests/staged-image.test.py'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STAGED_IMAGE_PARSER_TESTS_OK');
  });
  it('staging returns before compose, traffic gates or any data operation, while activation keeps cold-backup boundaries', () => {
    const source = readFileSync('deploy/server/quiet-room-deploy', 'utf8');
    const stage = source.slice(source.indexOf('if [[ "${mode:-deploy}" == stage ]]'), source.indexOf('deploy_phase_start compose-preflight'));
    expect(stage).toContain('STAGE_OK');
    for (const forbidden of ['docker compose', 'close_business_traffic', 'stop_project_containers', 'create_data_archive', 'restore_data_archive']) expect(stage).not.toContain(forbidden);
    expect(source.indexOf('Staged checkout changed')).toBeLessThan(source.indexOf('close_business_traffic()'));
    expect(source.indexOf('mv "$STAGED_DIR/$REQUESTED_SHA.json"')).toBeLessThan(source.indexOf('deploy_phase_start gate-traffic'));
  });
});
