import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
// @ts-expect-error Operational Node script has no TS declarations.
import { assertInitializationTarget } from '../scripts/deploy-config.mjs';
// @ts-expect-error Operational Node script has no TS declarations.
import { publish } from '../scripts/publish.mjs';

const source = await readFile(new URL('../deploy/server/quiet-room-deploy', import.meta.url), 'utf8');

describe('independent first deployment', () => {
  it('passes initialization through the fixed publisher and still requires exact CI and a release receipt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'quiet-room-initial-publish-'));
    const previous = process.env.QUIET_ROOM_DEPLOY_CONFIG;
    let releaseDirectory = '';
    try {
      const config = path.join(directory, 'target.json');
      await writeFile(config, JSON.stringify({ environment: 'tokyo-public', publicOrigin: 'https://chamber.shui.click' }));
      process.env.QUIET_ROOM_DEPLOY_CONFIG = config;
      const sha = 'a'.repeat(40);
      const calls: string[][] = [];
      publish(['--environment', 'tokyo-public', '--initialize', '--sha', sha], (_program: string, args: string[], options: Record<string, any> = {}) => {
        calls.push(args);
        if (args.includes('--jq')) return sha;
        if (args[1]?.includes('/compare/')) return JSON.stringify({ status: 'identical', merge_base_commit: { sha } });
        if (args[1]?.includes('runs?')) return JSON.stringify([{ workflow_runs: [{ id: 42, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' }] }]);
        if (args[1]?.includes('/jobs?')) return JSON.stringify([{ jobs: [{ run_id: 42, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success' }] }]);
        if (args[0] === 'clone') { releaseDirectory = args.at(-1)!; mkdirSync(path.join(releaseDirectory, '.git')); }
        if (args[0] === 'rev-parse') return sha;
        if (args.includes('--sha')) writeFileSync(options.env.QUIET_ROOM_PUBLISH_RECEIPT, `${sha}\n`);
        return '';
      });
      expect(calls[0]).toEqual(expect.arrayContaining(['--doctor', '--environment', 'tokyo-public', '--initialize']));
      expect(calls.at(-1)).toEqual(expect.arrayContaining(['--sha', sha, '--environment', 'tokyo-public', '--initialize']));
      for (const flags of [['--cloud'], ['--readback-only'], ['--initialize']]) {
        expect(() => publish(['--environment', 'tokyo-public', '--initialize', '--sha', sha, ...flags], () => { throw Error('Unexpected command'); })).toThrow();
      }
    } finally {
      if (previous === undefined) delete process.env.QUIET_ROOM_DEPLOY_CONFIG;
      else process.env.QUIET_ROOM_DEPLOY_CONFIG = previous;
      await rm(directory, { recursive: true, force: true });
      if (releaseDirectory) await rm(releaseDirectory, { recursive: true, force: true });
    }
  });
  it('requires an explicit independent target and rejects the personal production origin', () => {
    expect(() => assertInitializationTarget('tokyo-public', { environment: 'tokyo-public', publicOrigin: 'https://chamber.shui.click' })).not.toThrow();
    for (const [environment, config] of [
      [undefined, {}], ['production', { environment: 'production', publicOrigin: 'https://example.com' }],
      ['tokyo-public', { environment: 'tokyo-public', publicOrigin: 'https://ai.shui.click' }],
      ['tokyo-public', { environment: 'other', publicOrigin: 'https://example.com' }],
      ['tokyo-public', { environment: 'tokyo-public' }],
    ]) expect(() => assertInitializationTarget(environment, config)).toThrow();
  });

  it.each(['empty', 'not-allowed', 'state', 'attempted', 'symlink', 'release', 'registry', 'stopped-container', 'unlabelled-container', 'volume', 'docker-error'])('checks empty-host evidence without writing (%s)', async mode => {
    const directory = await mkdtemp(path.join(tmpdir(), 'quiet-room-initial-check-'));
    try {
      await mkdir(path.join(directory, 'state'));
      await mkdir(path.join(directory, 'releases'));
      if (mode === 'state') await writeFile(path.join(directory, 'state/current-sha'), '');
      if (mode === 'attempted') await writeFile(path.join(directory, 'state/initialization-attempted'), '');
      if (mode === 'symlink') {
        const { symlink } = await import('node:fs/promises');
        await symlink('/nonexistent', path.join(directory, 'current'));
      }
      if (mode === 'release') await mkdir(path.join(directory, 'releases/prior'));
      if (mode === 'registry') await writeFile(path.join(directory, 'successful-releases'), 'known-release\n');
      const before = await readdir(directory, { recursive: true });
      const guard = source.slice(source.indexOf('check_initialization()'), source.indexOf('if [[ $# -eq 1 && "$1" == --describe'));
      const result = spawnSync('bash', [], { encoding: 'utf8', env: { ...process.env, TEST_DIR: directory, TEST_MODE: mode }, input: `set -Eeuo pipefail
APP_ROOT="$TEST_DIR"; STATE_DIR="$TEST_DIR/state"; RELEASES="$TEST_DIR/releases"
MAINTENANCE_DIR="$TEST_DIR"; MAINTENANCE_FILE="$TEST_DIR/maintenance"; PROJECT=quiet-room
PUBLIC_ORIGIN=https://chamber.shui.click
initialization_is_allowed() { [[ "$TEST_MODE" != not-allowed ]]; }
docker() {
  [[ "$TEST_MODE" != docker-error ]] || return 1
  if [[ "$1" == volume && "$TEST_MODE" == volume ]]; then printf 'quiet-room_quiet-room-data\n'; fi
  if [[ "$1" == ps && "$TEST_MODE" == stopped-container ]]; then printf 'quiet-room-quiet-room-1\n'; fi
  if [[ "$1" == ps && "$#" == 4 && "$TEST_MODE" == unlabelled-container ]]; then printf 'quiet-room-quiet-room-1\n'; fi
  return 0
}
${guard}
check_initialization
` });
      expect(result.status).toBe(mode === 'empty' ? 0 : mode === 'docker-error' ? 1 : mode === 'not-allowed' ? 66 : 75);
      expect(result.stdout.includes('INITIALIZATION_READY')).toBe(mode === 'empty');
      expect(await readdir(directory, { recursive: true })).toEqual(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['success', 'gate-missing', 'start-fails', 'health-fails', 'post-open-fails'])('preserves first-deployment data and gate semantics (%s)', async mode => {
    const directory = await mkdtemp(path.join(tmpdir(), 'quiet-room-initial-cutover-'));
    try {
      await mkdir(path.join(directory, 'new'));
      const flow = source.slice(source.indexOf('initialization_failed()')).replaceAll('/usr/local/sbin/quiet-room-capacity preflight', 'capacity_preflight');
      const timing = source.slice(source.indexOf('deploy_timing_started='), source.indexOf('# End of timing setup'));
      const result = spawnSync('bash', [], { encoding: 'utf8', env: { ...process.env, TEST_DIR: directory, TEST_MODE: mode }, input: `set -Eeuo pipefail
cd "$TEST_DIR"
APP_ROOT="$TEST_DIR"; STATE_DIR="$TEST_DIR"; BACKUP_DIR="$TEST_DIR"; MAINTENANCE_DIR="$TEST_DIR"
CALLS_STATE="$TEST_DIR/calls-enabled"; ADMIN_STATE="$TEST_DIR/admin-enabled"; calls_enabled=0; admin_enabled=0
INITIALIZE=1; previous_image=''; previous_compose="$TEST_DIR/missing.yaml"; new_image=new
release_dir="$TEST_DIR/new"; new_compose_args=(--project-name quiet-room); previous_compose_args=(--project-name quiet-room)
REQUESTED_SHA=0123456789012345678901234567890123456789; stamp=test; short_sha=012345678901
PUBLIC_HEALTH_URL=https://chamber.shui.click/api/health
cutover_started=0; data_restore_required=0; backup_ready=0; backup_name=''; backup_path=''; failed_cutover_backup_path=''
${timing}
trace() { printf '%s\\n' "$*" >> trace; }
capacity_preflight() { :; }
project_container_ids() { :; }
stop_project_containers() { trace STOP; }
ensure_data_volume_quiescent() { :; }
close_business_traffic() { touch maintenance; trace GATE_CLOSED; }
open_business_traffic() { rm maintenance; trace GATE_OPEN; }
probe_public_maintenance() { [[ "$TEST_MODE" != gate-missing && -f maintenance ]]; }
create_data_archive() { trace UNEXPECTED_BACKUP; return 99; }
restore_data_archive() { trace UNEXPECTED_RESTORE; return 99; }
wait_for_health() { trace HEALTH_LOCAL; [[ "$TEST_MODE" != health-fails ]]; }
wait_for_public_health() { trace HEALTH_PUBLIC; }
probe_local_websocket() { trace WS_LOCAL; }
wait_for_public_websocket() { printf 'accepted-message\\n' >> database; trace WS_PUBLIC; [[ "$TEST_MODE" != post-open-fails ]]; }
prune_successful_deployments() { :; }
docker() { if [[ "$1" == compose ]]; then printf 'initial-data\\n' > database; trace START; [[ "$TEST_MODE" != start-fails ]]; fi; }
${flow}` });
      const trace = await readFile(path.join(directory, 'trace'), 'utf8');
      const files = await readdir(directory);
      expect(trace).not.toContain('UNEXPECTED_');
      expect(result.stdout + result.stderr).not.toContain('ROLLBACK_OK');
      expect(files).toContain('initialization-attempted');
      if (mode === 'success' || mode === 'post-open-fails') {
        expect(result.status).toBe(mode === 'success' ? 0 : 70);
        expect(files).not.toContain('maintenance');
        expect(await readFile(path.join(directory, 'current-sha'), 'utf8')).toBe('0123456789012345678901234567890123456789\n');
        expect(await readFile(path.join(directory, 'database'), 'utf8')).toContain('accepted-message');
        expect(trace.indexOf('HEALTH_PUBLIC')).toBeLessThan(trace.indexOf('GATE_OPEN'));
        expect(trace.indexOf('WS_LOCAL')).toBeLessThan(trace.indexOf('GATE_OPEN'));
        expect(trace.lastIndexOf('STOP')).toBeLessThan(trace.indexOf('START'));
        expect(files.includes('successful-releases')).toBe(mode === 'success');
      } else {
        expect(result.status).not.toBe(0);
        expect(files).toContain('maintenance');
        expect(files).not.toContain('current-sha');
        expect(trace).not.toContain('GATE_OPEN');
        if (mode === 'gate-missing') expect(trace).not.toContain('START');
        else {
          expect(trace.lastIndexOf('STOP')).toBeGreaterThan(trace.indexOf('START'));
          expect(await readFile(path.join(directory, 'database'), 'utf8')).toBe('initial-data\n');
          expect(result.stderr).toContain('INITIALIZATION_FAILED');
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
