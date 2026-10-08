import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat as fileStat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Mode = 'disabled' | 'enabled' | 'first-enable' | 'missing-settings' | 'missing-overlay' | 'missing-previous-overlay' | 'unsafe-settings' | 'unsafe-directory' | 'missing-public-config' | 'symlink-public-config';

// Run the real Compose selection/preflight block against isolated files and
// command stand-ins. Never invokes Docker, SSH, root helpers, or production.
async function simulate(mode: Mode) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quiet-call-deployment-'));
  try {
    const source = await readFile(new URL('../deploy/server/quiet-room-deploy', import.meta.url), 'utf8');
    const start = source.indexOf('# Calling is a persistent, administrator-controlled deployment choice');
    const end = source.indexOf('\ncutover_started=0', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const name of ['new', 'old', 'shared', 'state']) await mkdir(path.join(directory, name));
    for (const name of ['new/compose.yaml', 'old/compose.yaml']) await writeFile(path.join(directory, name), 'services: {}\n');
    if (mode !== 'missing-overlay') await writeFile(path.join(directory, 'new/compose.calls.yaml'), 'services: {}\n');
    if (mode !== 'first-enable' && mode !== 'missing-previous-overlay') await writeFile(path.join(directory, 'old/compose.calls.yaml'), 'services: {}\n');
    if (mode !== 'disabled' && mode !== 'missing-settings') await writeFile(path.join(directory, 'shared/calls.env'), 'TURN_SECRET=test-only-never-print-this-value\n', { mode: 0o600 });
    await mkdir(path.join(directory, 'new/deploy'));
    if (mode === 'symlink-public-config') await symlink(path.join(directory, 'shared/calls.env'), path.join(directory, 'new/deploy/turnserver.conf'));
    else if (mode !== 'missing-public-config') await writeFile(path.join(directory, 'new/deploy/turnserver.conf'), 'realm=ai.shui.click\n', { mode: 0o640 });
    if (['enabled', 'missing-settings', 'missing-overlay', 'missing-previous-overlay'].includes(mode)) await writeFile(path.join(directory, 'state/calls-enabled'), '1\n');
    const harness = `set -Eeuo pipefail
cd "$CALL_DEPLOY_TEST_DIR"
APP_ROOT="$CALL_DEPLOY_TEST_DIR"; PROJECT=quiet-room
SHARED_ENV="$APP_ROOT/shared/production.env"; CALLS_ENV="$APP_ROOT/shared/calls.env"; CALLS_STATE="$APP_ROOT/state/calls-enabled"
ADMIN_ENV="$APP_ROOT/shared/admin.env"; ADMIN_STATE="$APP_ROOT/state/admin-enabled"
release_dir="$APP_ROOT/new"; previous_compose="$APP_ROOT/old/compose.yaml"
new_image=new; previous_image=old
stat() {
  case "$2" in
    '%u:%a') if [[ "$CALL_DEPLOY_TEST_MODE" == unsafe-settings ]]; then printf '501:600'; else printf '0:600'; fi;;
    '%u') printf '0';;
    '%a') if [[ "$CALL_DEPLOY_TEST_MODE" == unsafe-directory ]]; then printf '775'; else printf '750'; fi;;
    *) return 1;;
  esac
}
docker() {
  printf '%s\\n' "$*" >> trace
  if [[ "$1" == ps ]]; then
    if [[ "$CALL_DEPLOY_TEST_MODE" == enabled || "$CALL_DEPLOY_TEST_MODE" == missing-settings ]]; then printf 'existing-turn\\n'; fi
  fi
  return 0
}
${source.slice(start, end)}
printf '%s\\n' "$calls_enabled" > enabled
printf '%s\\n' "$previous_calls_enabled" > previous-enabled
printf '%s\\n' "\${new_compose_args[@]}" > new-args
printf '%s\\n' "\${previous_compose_args[@]}" > old-args
`;
    const result = spawnSync('bash', [], { input: harness, encoding: 'utf8', env: { ...process.env, CALL_DEPLOY_TEST_DIR: directory, CALL_DEPLOY_TEST_MODE: mode } });
    const read = async (file: string) => readFile(path.join(directory, file), 'utf8').catch(() => '');
    const modeOf = async (file: string) => fileStat(path.join(directory, file)).then(value => value.mode & 0o777, () => null);
    return { status: result.status, output: result.stdout + result.stderr, trace: await read('trace'), enabled: (await read('enabled')).trim(), previousEnabled: (await read('previous-enabled')).trim(), newArgs: await read('new-args'), oldArgs: await read('old-args'), publicMode: await modeOf('new/deploy/turnserver.conf'), privateMode: await modeOf('shared/calls.env'), publicContent: await read('new/deploy/turnserver.conf') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('persistent optional calling deployment', () => {
  it('keeps a regular chat release free of TURN profiles and credentials', async () => {
    const result = await simulate('disabled');
    expect(result.status).toBe(0);
    expect(result.enabled).toBe('0');
    expect(result.newArgs).not.toContain('calls.env');
    expect(result.newArgs).not.toContain('--profile');
    expect(result.trace.match(/config --quiet/g)).toHaveLength(2);
    expect(result.trace).not.toContain('pull quiet-room-turn');
  });

  it('retains the persistent environment and profile for both new release and rollback', async () => {
    const result = await simulate('enabled');
    expect(result.status).toBe(0);
    expect(result.enabled).toBe('1');
    expect(result.previousEnabled).toBe('1');
    for (const args of [result.newArgs, result.oldArgs]) {
      expect(args).toContain('/shared/production.env');
      expect(args).toContain('/shared/calls.env');
      expect(args.indexOf('/shared/calls.env')).toBeGreaterThan(args.indexOf('/shared/production.env'));
      expect(args).toContain('compose.calls.yaml');
      expect(args).toContain('--profile\ncalls');
    }
    expect(result.trace).toContain('pull quiet-room-turn');
    expect(result.trace).not.toContain('test-only-never-print-this-value');
    expect(result.trace).not.toContain(' up ');
  });

  it('restores a chat-only previous release on a failed first enable', async () => {
    const result = await simulate('first-enable');
    expect(result.status).toBe(0);
    expect(result.newArgs).toContain('compose.calls.yaml');
    expect(result.previousEnabled).toBe('0');
    expect(result.oldArgs).not.toContain('calls.env');
    expect(result.oldArgs).not.toContain('--profile');
  });

  it('makes a restrictive-umask public TURN mount readable without changing its bytes or secret-file permissions', async () => {
    const result = await simulate('enabled');
    expect(result.status).toBe(0);
    expect(result.publicMode).toBe(0o644);
    expect(result.publicContent).toBe('realm=ai.shui.click\n');
    expect(result.privateMode).toBe(0o600);
    expect(result.trace).toContain('config --quiet');
  });

  it.each(['missing-settings', 'missing-overlay', 'missing-previous-overlay', 'unsafe-settings', 'unsafe-directory', 'missing-public-config', 'symlink-public-config'] as const)('refuses %s before starting or removing any container', async (mode) => {
    const result = await simulate(mode);
    expect(result.status).toBe(66);
    expect(result.trace).not.toContain(' up ');
    expect(result.trace).not.toContain(' stop ');
    expect(result.trace).not.toContain('pull quiet-room-turn');
    expect(result.output).not.toContain('test-only-never-print-this-value');
  });
});
