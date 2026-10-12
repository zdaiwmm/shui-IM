import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function simulate(mode: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quiet-room-stop-'));
  const source = await readFile(new URL('../deploy/server/quiet-room-deploy', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('project_container_ids()'), source.indexOf('validate_data_archive()'));
  try {
    const result = spawnSync('bash', [], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, STOP_TEST_DIR: directory, STOP_TEST_MODE: mode },
      input: `set -Eeuo pipefail
cd "$STOP_TEST_DIR"
PROJECT=quiet-room; DATA_VOLUME=quiet-room-data
trace() { printf '%s\\n' "$*" >> trace; }
sleep() { trace WAIT; }
docker() {
  if [[ "$1" == stop ]]; then
    trace "STOP $*"
    [[ "$STOP_TEST_MODE" != stop-error ]] || return 1
    return 0
  fi
  if [[ "$2" == --all ]]; then printf 'app\\nbackup\\nturn\\n'; return 0; fi
  if [[ "$*" == *volume=* ]]; then trace VOLUME_CHECK; return 0; fi
  trace QUERY
  [[ "$STOP_TEST_MODE" != query-error ]] || return 1
  local count=0
  if [[ -f count ]]; then read -r count < count; fi
  count=$((count + 1)); printf '%s\\n' "$count" > count
  if [[ "$STOP_TEST_MODE" == stuck || ( "$STOP_TEST_MODE" == lag && "$count" -le 2 ) ]]; then printf 'turn\\n'; fi
  return 0
}
${functions}
if stop_project_containers && ensure_data_volume_quiescent; then trace BACKUP_ALLOWED; else trace BLOCKED; exit 1; fi
`,
    });
    return { status: result.status, output: result.stdout + result.stderr, trace: await readFile(path.join(directory, 'trace'), 'utf8') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('bounded deployment stop convergence', () => {
  it('waits for delayed list updates before permitting the cold backup', async () => {
    const r = await simulate('lag');
    expect(r.status).toBe(0);
    expect(r.trace.match(/WAIT/g)).toHaveLength(2);
    expect(r.trace.indexOf('VOLUME_CHECK')).toBeGreaterThan(r.trace.lastIndexOf('QUERY'));
    expect(r.trace).toContain('BACKUP_ALLOWED');
    expect(r.trace).toContain('STOP stop app backup turn');
  });
  it('fails closed after the bounded wait when a container remains active', async () => {
    const r = await simulate('stuck');
    expect(r.status).toBe(1);
    expect(r.trace.match(/QUERY/g)).toHaveLength(10);
    expect(r.trace.match(/WAIT/g)).toHaveLength(9);
    expect(r.trace).not.toContain('VOLUME_CHECK');
    expect(r.trace).not.toContain('BACKUP_ALLOWED');
    expect(r.output).toContain('still running after stop');
  });
  it('does not treat a failed state query as an empty running list', async () => {
    const r = await simulate('query-error');
    expect(r.status).toBe(1);
    expect(r.trace).not.toContain('WAIT');
    expect(r.trace).not.toContain('BACKUP_ALLOWED');
  });
  it('accepts independently confirmed quiescence after a stop-command error', async () => {
    const r = await simulate('stop-error');
    expect(r.status).toBe(0);
    expect(r.output).toContain('verifying container state');
    expect(r.trace).toContain('VOLUME_CHECK');
    expect(r.trace).toContain('BACKUP_ALLOWED');
  });
  it('does not delay containers whose stopped state is already visible', async () => {
    const r = await simulate('ready');
    expect(r.status).toBe(0);
    expect(r.trace).not.toContain('WAIT');
    expect(r.trace).toContain('BACKUP_ALLOWED');
  });
});
