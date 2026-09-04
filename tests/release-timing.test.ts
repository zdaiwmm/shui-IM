import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { createReleaseTimer } from '../scripts/release-runtime.mjs';

describe('release phase timing', () => {
  it('preserves operation results and errors without printing their contents', async () => {
    const logs: string[] = [];
    let ticks = 0n;
    const timed = createReleaseTimer('test', (line: string) => logs.push(line), () => ticks += 2_000_000n);
    const secret = new Error('test-only-sensitive-command-output');
    expect(timed('sync', () => 42)).toBe(42);
    expect(() => timed('failed-sync', () => { throw secret; })).toThrow(secret);
    await expect(timed('async', async () => 'value')).resolves.toBe('value');
    await expect(timed('failed-async', async () => { throw secret; })).rejects.toBe(secret);
    expect(logs).toHaveLength(4);
    expect(logs.filter(line => line.includes('result=failure'))).toHaveLength(2);
    expect(logs.every(line => line.endsWith('duration_ms=2'))).toBe(true);
    expect(logs.join('\n')).not.toContain(secret.message);
  });
  it.each([0, 23])('server EXIT timing retains status %s without changing error handling', (status) => {
    const source = readFileSync(new URL('../deploy/server/quiet-room-deploy', import.meta.url), 'utf8');
    const timing = source.slice(source.indexOf('deploy_timing_started='), source.indexOf('# End of timing setup'));
    const result = spawnSync('bash', [], { encoding: 'utf8', input: `set -Eeuo pipefail\n${timing}\ndeploy_phase_start cold-backup\nexit ${status}\n` });
    expect(result.status).toBe(status);
    expect(result.stderr).toContain('DEPLOY_TIMING phase=preflight result=success');
    const expected = status ? 'failure' : 'success';
    expect(result.stderr).toContain(`DEPLOY_TIMING phase=cold-backup result=${expected}`);
    expect(result.stderr).toContain(`DEPLOY_TIMING phase=total result=${expected}`);
  });
});
