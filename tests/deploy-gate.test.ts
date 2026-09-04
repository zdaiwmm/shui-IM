import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Exercise the checked-in cutover/rollback control flow with an isolated fake
// database and probe implementations. No privileged commands or live host.
async function simulate(mode: 'validation-fails' | 'post-open-fails' | 'gate-missing') {
  const directory = await mkdtemp(path.join(tmpdir(), 'quiet-room-cutover-'));
  const source = await readFile(new URL('../deploy/server/quiet-room-deploy', import.meta.url), 'utf8');
  const flow = source.slice(source.indexOf('rollback()'));
  try {
    await mkdir(path.join(directory, 'new'));
    await writeFile(path.join(directory, 'previous.yaml'), '');
    await writeFile(path.join(directory, 'database'), 'previously-acknowledged-message\n');
    const harness = `set -Eeuo pipefail
cd "$AUDIT_TEST_DIR"
APP_ROOT="$AUDIT_TEST_DIR"; STATE_DIR="$AUDIT_TEST_DIR"; BACKUP_DIR="$AUDIT_TEST_DIR"
PUBLIC_HEALTH_URL=https://ai.shui.click/api/health
previous_image=old; new_image=new; previous_compose="$AUDIT_TEST_DIR/previous.yaml"
release_dir="$AUDIT_TEST_DIR/new"; PROJECT=quiet-room; SHARED_ENV=unused
CALLS_STATE="$AUDIT_TEST_DIR/calls-enabled"; calls_enabled=0
new_compose_args=(--project-name "$PROJECT" --env-file "$SHARED_ENV" --file "$release_dir/compose.yaml")
previous_compose_args=(--project-name "$PROJECT" --env-file "$SHARED_ENV" --file "$previous_compose")
REQUESTED_SHA=0123456789012345678901234567890123456789; stamp=test; short_sha=012345678901
cutover_started=0; data_restore_required=0; backup_ready=0; backup_name=''; backup_path=''; failed_cutover_backup_path=''
current_image=old
trace() { printf '%s\\n' "$*" >> trace; }
try_write() { if [[ -f maintenance ]]; then trace WRITE_BLOCKED; else printf 'new-client-ack\\n' >> database; trace WRITE_ACK; fi; }
project_container_ids() { printf 'old-container\\n'; }
stop_project_containers() { trace STOP; }
ensure_data_volume_quiescent() { :; }
close_business_traffic() { touch maintenance; trace GATE_CLOSED; }
open_business_traffic() { rm maintenance; trace GATE_OPEN; }
probe_public_maintenance() { [[ "$AUDIT_TEST_MODE" != gate-missing && -f maintenance ]]; }
create_data_archive() { cp database "$2"; trace BACKUP; }
restore_data_archive() { cp "$2" database; trace RESTORE; }
wait_for_health() { trace HEALTH_LOCAL; }
wait_for_public_health() {
  if [[ "$current_image" == new ]]; then
    try_write
    if [[ "$AUDIT_TEST_MODE" == validation-fails ]]; then return 1; fi
  fi
  trace HEALTH_PUBLIC
}
probe_local_websocket() { try_write; trace WS_LOCAL; }
wait_for_public_websocket() { try_write; trace WS_PUBLIC; [[ "$AUDIT_TEST_MODE" != post-open-fails ]]; }
prune_successful_deployments() { :; }
docker() {
  if [[ "$1" == compose ]]; then current_image="$QUIET_ROOM_IMAGE"; trace "START_$current_image"; fi
}
${flow}`;
    const result = spawnSync('bash', [], {
      input: harness,
      encoding: 'utf8',
      env: { ...process.env, AUDIT_TEST_DIR: directory, AUDIT_TEST_MODE: mode },
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      trace: await readFile(path.join(directory, 'trace'), 'utf8'),
      database: await readFile(path.join(directory, 'database'), 'utf8'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('cutover acknowledged-message preservation', () => {
  it('blocks new client ACKs until validation and rolls back only the gated database', async () => {
    const result = await simulate('validation-fails');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('ROLLBACK_OK');
    expect(result.trace).toContain('WRITE_BLOCKED');
    expect(result.trace).not.toContain('WRITE_ACK');
    expect(result.trace).toContain('RESTORE');
    expect(result.database).toBe('previously-acknowledged-message\n');
  });

  it('retains a client ACK when the public check fails after traffic reopened', async () => {
    const result = await simulate('post-open-fails');
    expect(result.status).toBe(70);
    expect(result.output).toContain('POST_OPEN_CHECK_FAILED');
    expect(result.trace).toContain('WRITE_ACK');
    expect(result.trace).not.toContain('RESTORE');
    expect(result.database).toBe('previously-acknowledged-message\nnew-client-ack\n');
  });

  it('refuses to stop the old service when the installed proxy does not enforce the gate', async () => {
    const result = await simulate('gate-missing');
    expect(result.status).toBe(69);
    expect(result.trace).not.toContain('STOP');
    expect(result.trace).not.toContain('BACKUP');
    expect(result.database).toBe('previously-acknowledged-message\n');
  });
});
