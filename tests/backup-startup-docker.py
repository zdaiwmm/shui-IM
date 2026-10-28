"""Exercise the real backup probe and startup cadence in an isolated CI container.

No host mounts, production configuration, business volumes or backup workers.
Only synthetic health receipts are written to the container's private tmpfs.
"""
import json
import os
import re
import subprocess
import time
import uuid

assert os.environ.get('GITHUB_ACTIONS') == 'true', 'CI-only fixture'
image = os.environ['QUIET_ROOM_BACKUP_FIXTURE_IMAGE']


def command(args, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if check and result.returncode:
        raise AssertionError('Backup startup fixture command failed: ' + result.stderr[-2000:])
    return result


def seconds(value):
    if isinstance(value, int):
        return value / 1_000_000_000
    parts = re.findall(r'(\d+(?:\.\d+)?)(ns|us|ms|h|m|s)', value)
    assert ''.join(number + unit for number, unit in parts) == value
    scale = {'ns': 1e-9, 'us': 1e-6, 'ms': 1e-3, 's': 1, 'm': 60, 'h': 3600}
    return sum(float(number) * scale[unit] for number, unit in parts)


config = json.loads(command(['docker', 'compose', '-f', 'compose.yaml', 'config', '--format', 'json']).stdout)
probe = config['services']['quiet-room-backup']['healthcheck']
assert probe['test'] == ['CMD', 'node', 'scripts/backup-health.mjs']
assert {key: seconds(probe[key]) for key in ['interval', 'timeout', 'start_period', 'start_interval']} == {
    'interval': 300, 'timeout': 10, 'start_period': 300, 'start_interval': 10,
}
assert probe['retries'] == 1

container = None
started = time.monotonic()
write_state = """const fs=require('fs');fs.mkdirSync('/tmp/backup',{recursive:true});
const at=new Date(Date.now()+Number(process.argv[1]||0)).toISOString();
fs.writeFileSync('/tmp/backup/.backup-state.json',JSON.stringify({lastVerifiedAt:at,
snapshotCreatedAt:at,lastAttemptSucceeded:process.argv[2]==='true'}));"""


def inspect():
    return json.loads(command(['docker', 'inspect', container]).stdout)[0]


def wait_for(predicate, limit):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        state = inspect()['State']
        assert state['Running'], 'Fixture container stopped'
        if predicate(state['Health']):
            return state['Health']
        time.sleep(0.5)
    raise AssertionError('Timed out waiting for the real Docker health monitor')


try:
    container = command(['docker', 'run', '-d', '--name', 'quiet-backup-startup-' + uuid.uuid4().hex,
                         '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m',
                         '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                         '--memory', '128m', '--pids-limit', '32',
                         '--health-cmd', 'node scripts/backup-health.mjs', '--health-interval', '5m',
                         '--health-timeout', '10s', '--health-retries', '1', '--health-start-period', '5m',
                         '--health-start-interval', '10s', '-e', 'BACKUP_DIR=/tmp/backup', '-e', 'BACKUP_MODE=local',
                         image, 'node', '-e', write_state + '\nsetInterval(()=>{},1000);', '0', 'false']).stdout.strip()
    actual = inspect()['Config']['Healthcheck']
    assert actual['StartInterval'] == 10_000_000_000, 'Engine ignored startup cadence'
    assert actual['Interval'] == actual['StartPeriod'] == 300_000_000_000
    failed = wait_for(lambda health: len(health.get('Log', [])) >= 2, 40)
    assert failed['Status'] == 'starting' and failed['FailingStreak'] == 0
    assert all(item['ExitCode'] == 1 for item in failed['Log'])
    command(['docker', 'exec', container, 'node', '-e', write_state, '--', '0', 'true'])
    ready_at = time.monotonic()
    healthy = wait_for(lambda health: health['Status'] == 'healthy', 25)
    assert healthy['Log'][-1]['ExitCode'] == 0
    ready_ms = round((time.monotonic() - ready_at) * 1000)
    for offset, succeeded in [(-37 * 3600_000, 'true'), (3600_000, 'true'), (0, 'false')]:
        command(['docker', 'exec', container, 'node', '-e', write_state, '--', str(offset), succeeded])
        check = command(['docker', 'exec', container, 'node', 'scripts/backup-health.mjs'], check=False)
        assert check.returncode == 1 and json.loads(check.stdout)['healthy'] is False
    print('BACKUP_STARTUP_OK ' + json.dumps({'readyAfterValidReceiptMs': ready_ms,
          'durationMs': round((time.monotonic() - started) * 1000),
          'startupFailuresRemainStarting': True, 'staleFutureFailedRejected': True}))
finally:
    if container:
        command(['docker', 'rm', '-f', container])
