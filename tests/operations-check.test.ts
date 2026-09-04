import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve('deploy/server/quiet-room-check-operations');
type Scenario = 'healthy' | 'manual-hook' | 'certificate-expired' | 'manual-no-hook'
  | 'timer-disabled' | 'timer-inactive' | 'receipt-missing' | 'receipt-stale';

async function simulate(scenario: Scenario) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quiet-room-operations-check-'));
  try {
    const bin = path.join(directory, 'bin');
    const state = path.join(directory, 'state');
    const certificate = path.join(directory, 'fixture-certificate.pem');
    const renewal = path.join(directory, 'fixture-renewal.conf');
    const trace = path.join(directory, 'trace');
    await Promise.all([mkdir(bin), mkdir(state)]);
    await writeFile(certificate, 'isolated test fixture; not a certificate\n');
    await writeFile(renewal, scenario.startsWith('manual-')
      ? `authenticator = manual\n${scenario === 'manual-hook' ? 'manual_auth_hook = /fixture/auth-hook\n' : ''}`
      : 'authenticator = webroot\n');
    const maximumAge = 129600;
    if (scenario !== 'receipt-missing') {
      const age = scenario === 'receipt-stale' ? maximumAge + 60 : 60;
      await writeFile(path.join(state, 'offsite-verified-at'), `${Math.floor(Date.now() / 1000) - age}\n`);
    }
    const stubs = {
      openssl: `#!/usr/bin/env bash
set -eu
printf 'openssl %s\\n' "$*" >> "$OPERATIONS_TEST_TRACE"
[[ "$#" -eq 6 && "$1" = x509 && "$2" = -checkend && "$3" = 2592000 && "$4" = -noout && "$5" = -in && "$6" = "$QUIET_ROOM_CERTIFICATE" ]] || exit 64
[[ "$OPERATIONS_TEST_SCENARIO" != certificate-expired ]]
`,
      systemctl: `#!/usr/bin/env bash
set -eu
printf 'systemctl %s\\n' "$*" >> "$OPERATIONS_TEST_TRACE"
[[ "$#" -eq 3 && "$2" = --quiet && "$3" = fixture-certbot.timer ]] || exit 64
case "$1" in
  is-enabled) [[ "$OPERATIONS_TEST_SCENARIO" != timer-disabled ]] ;;
  is-active) [[ "$OPERATIONS_TEST_SCENARIO" != timer-inactive ]] ;;
  *) exit 64 ;;
esac
`,
    };
    for (const [name, body] of Object.entries(stubs)) {
      const executable = path.join(bin, name);
      await writeFile(executable, body);
      await chmod(executable, 0o755);
    }
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        QUIET_ROOM_CERTIFICATE: certificate,
        QUIET_ROOM_RENEWAL_CONFIG: renewal,
        QUIET_ROOM_CERTBOT_TIMER: 'fixture-certbot.timer',
        QUIET_ROOM_OPS_STATE_DIR: state,
        QUIET_ROOM_MAX_OFFSITE_AGE_SECONDS: String(maximumAge),
        OPERATIONS_TEST_TRACE: trace,
        OPERATIONS_TEST_SCENARIO: scenario,
      },
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, trace: await readFile(trace, 'utf8') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('isolated operational readiness check', () => {
  it.each(['healthy', 'manual-hook'] as const)('passes all healthy checks with %s renewal', async (scenario) => {
    const result = await simulate(scenario);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('OPERATIONS_CHECK_OK\n');
    expect(result.stderr).toBe('');
    expect(result.trace).toContain('openssl x509 -checkend 2592000 -noout -in ');
    expect(result.trace).toContain('systemctl is-enabled --quiet fixture-certbot.timer\n');
    expect(result.trace).toContain('systemctl is-active --quiet fixture-certbot.timer\n');
  });

  it.each([
    ['certificate-expired', 'TLS_CERTIFICATE_MISSING_OR_EXPIRES_WITHIN_30_DAYS'],
    ['manual-no-hook', 'TLS_UNATTENDED_RENEWAL_NOT_CONFIGURED'],
    ['timer-disabled', 'TLS_RENEWAL_TIMER_NOT_ENABLED_OR_ACTIVE'],
    ['timer-inactive', 'TLS_RENEWAL_TIMER_NOT_ENABLED_OR_ACTIVE'],
    ['receipt-missing', 'OFFSITE_BACKUP_MISSING_OR_STALE'],
    ['receipt-stale', 'OFFSITE_BACKUP_MISSING_OR_STALE'],
  ] as const)('fails closed for %s', async (scenario, reason) => {
    const result = await simulate(scenario);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${reason}\n`);
  });
});
