"""Real Docker transaction regression, run only on an isolated Linux CI runner.

Uses dedicated sockets, data/exec roots, bridge names and fixture volumes. It
never stops the runner's Docker service or reads any production configuration.
"""
import datetime
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

assert os.geteuid() == 0
assert os.environ.get('GITHUB_ACTIONS') == 'true', 'this fixture is CI-only'
fixture_image = os.environ['QUIET_ROOM_STORAGE_FIXTURE_IMAGE']
repository = Path.cwd()
base = Path(tempfile.mkdtemp(prefix='quiet-room-storage-ci-'))
module = runpy.run_path(str(repository / 'deploy/server/quiet-room-storage-maintenance'))
g = module['api'].__globals__
root = base / 'application'
engine = base / 'docker'
state = base / 'state'
sessions = state / 'storage-maintenance'
endpoint = str(base / 'main.sock')
for directory in (root / 'deploy-state', root / 'shared', root / 'git-releases/release', root / 'backups/predeploy', sessions):
    directory.mkdir(parents=True, mode=0o700)
(root / 'current').symlink_to(root / 'git-releases/release')
(root / 'deploy-state/current-sha').write_text('a' * 40)
(root / 'deploy-state/deployed-at').write_text('fixture-original-batch')
(root / 'deploy-state/admin-enabled').write_text('0')
(root / 'shared/fixture.json').write_text('{}')
g.update(ROOT=root, STATE=state, SESSIONS=sessions, ENGINE=engine, SOCKET=endpoint)
processes = {}


def daemon(label, data_root, socket_path, start):
    if start:
        config = base / (label + '-config.json')
        config.write_text('{}')
        log = (base / (label + '.log')).open('ab')
        process = subprocess.Popen(['/usr/bin/dockerd', '--config-file', str(config), '--host', 'unix://' + socket_path,
                                    '--data-root', str(data_root), '--exec-root', str(base / (label + '-exec')),
                                    '--pidfile', str(base / (label + '.pid')), '--storage-driver', 'overlay2',
                                    '--iptables=false', '--ip-forward=false', '--ip-masq=false', '--bridge=none'],
                                   stdout=log, stderr=log)
        log.close()
        processes[label] = process
        for _ in range(90):
            try:
                info = module['api']('GET', '/info', endpoint=socket_path)
                assert info['DockerRootDir'] == str(data_root)
                return socket_path
            except (OSError, module['http'].client.HTTPException):
                assert process.poll() is None, 'private daemon exited'
                time.sleep(1)
        raise AssertionError('private daemon did not start')
    process = processes.pop(label, None)
    if process:
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=90)
    return socket_path


def engine_control(start):
    daemon('main', engine, endpoint, start)


def validation_daemon(directory, start):
    area = directory / 'validation'
    socket_path = str(area / 'docker.sock')
    label = 'validation-' + directory.name[-12:]
    if start:
        area.mkdir(mode=0o700)
    return daemon(label, area / 'docker', socket_path, start)


g.update(engine_control=engine_control, validation_daemon=validation_daemon)
g['public_health'] = lambda plan: json.loads(module['docker'](['exec', module['NAMES'][0], 'node', '-e',
    "fetch('http://127.0.0.1:8080/api/health').then(r=>r.json()).then(x=>{if(!x.ok||!x.database||!x.storage)process.exit(2);console.log(JSON.stringify(x))}).catch(()=>process.exit(1))"]))
g['traffic_gate'] = lambda plan: module['require']((state / 'maintenance').is_file(), 'fixture-gate')
# Filesystem pacing is covered separately; CI removes only its tiny disposable
# fixture trees without waiting between each file. Production pacing is intact.
sleep = module['time'].sleep
g['time'].sleep = lambda seconds: sleep(seconds) if seconds >= 1 else None


def new_session():
    directory = sessions / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:12])
    directory.mkdir(mode=0o700)
    public, private = module['inventory']()
    module['atomic_json'](directory / 'target.json', public)
    module['atomic_json'](directory / 'runtime.json', private)
    module['checkpoint'](directory, 'PREPARE_AUTHORIZED', initialAvailableBytes=module['available']())
    module['prepare_worker'](directory)
    assert module['read_json'](directory / 'state.json')['phase'] == 'PREPARED'
    module['checkpoint'](directory, 'APPLY_AUTHORIZED', authorizedPlanHash=module['file_digest'](directory / 'plan.json'))
    return directory


try:
    engine_control(True)
    source_archive = base / 'fixture-image.tar.gz'
    # Read the image already built by this CI job. The runner's own engine is
    # never stopped, reset, tagged or modified by this regression.
    module['stream_process'](['docker', '--host', 'unix:///var/run/docker.sock', 'image', 'save', fixture_image], source_archive, True)
    module['stream_process'](['docker', '--host', 'unix://' + endpoint, 'image', 'load'], source_archive, False)
    # A small official image exercises restoring registry digest references
    # that docker image save/load does not preserve on its own.
    module['docker'](['pull', 'busybox:1.36'], timeout=180)
    for char in ('a', 'b', 'c'):
        created = module['api']('POST', '/containers/create', {'Image': fixture_image, 'HostConfig': {'ReadonlyRootfs': True}})
        module['api']('POST', '/commit?container=' + created['Id'] + '&repo=quiet-room-app&tag=' + char * 40 + '&pause=false',
                      {'Labels': {'quiet-room.fixture': char}})
        module['api']('DELETE', '/containers/' + created['Id'] + '?v=true')
    module['docker'](['image', 'tag', 'quiet-room-app:' + 'a' * 40, 'quiet-room-app:production'])
    for name in ('quiet-room_quiet-room-data', 'fixture-turn-state', 'fixture-turn-extra'):
        module['api']('POST', '/volumes/create', {'Name': name})
    bridge = 'qrci' + uuid.uuid4().hex[:8]
    module['api']('POST', '/networks/create', {'Name': 'quiet-room_default', 'Driver': 'bridge',
        'Options': {'com.docker.network.bridge.name': bridge},
        'IPAM': {'Config': [{'Subnet': '10.252.231.0/24', 'Gateway': '10.252.231.1'}]}})
    image = 'quiet-room-app:' + 'a' * 40
    for name in module['NAMES']:
        app = name == module['NAMES'][0]
        turn = name == module['NAMES'][2]
        mounts = [{'Type': 'volume', 'Source': 'fixture-turn-extra' if turn else 'quiet-room_quiet-room-data', 'Target': '/app/data'}]
        if turn:
            mounts.append({'Type': 'volume', 'Source': 'fixture-turn-state', 'Target': '/var/lib/coturn'})
        body = {'Image': image, 'Env': ['HOST=0.0.0.0', 'PORT=8080', 'DATA_DIR=/app/data'],
                'HostConfig': {'ReadonlyRootfs': True, 'NetworkMode': 'host' if turn else 'quiet-room_default',
                               'Mounts': mounts, 'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=64m'},
                               'RestartPolicy': {'Name': 'unless-stopped'}}}
        if not app:
            body.update(Entrypoint=['/bin/sh', '-c'], Cmd=['while :; do sleep 60; done'],
                        Healthcheck={'Test': ['CMD', 'true'], 'Interval': 1000000000, 'Timeout': 1000000000, 'Retries': 1})
        module['api']('POST', '/containers/create?name=' + name, body)
        module['api']('POST', '/containers/' + name + '/start')
    plan, snapshot = {}, {}
    for _ in range(90):
        try:
            plan, snapshot = module['inventory']()
            break
        except module['StorageError']:
            sleep(1)
    assert plan
    data = engine / 'volumes/quiet-room_quiet-room-data/_data'
    (data / 'acknowledged-ciphertext.bin').write_bytes(os.urandom(1024 * 1024))
    turn = engine / 'volumes/fixture-turn-state/_data'
    (turn / 'state.bin').write_bytes(os.urandom(4096))
    identities = {volume['Name']: module['identity'](volume['Mountpoint']) for volume in snapshot['volumes']}
    # Seed a verified existing cold backup for the online restore rehearsal.
    module['docker'](['stop'] + list(module['NAMES']), timeout=90)
    cold = root / 'backups/predeploy' / ('data-20261011T000000Z-' + 'a' * 12 + '.tar.gz')
    module['command'](['tar', '-czf', str(cold), '-C', str(data), '.'])
    module['docker'](['start'] + list(module['NAMES']), timeout=90)
    module['wait_application']({'publicHost': 'ai.shui.click'})
    sleep(2)
    before = module['identity'](engine)
    first = new_session()
    original_create = g['create_containers']
    def fail_after_volume_moves(*args, **kwargs):
        raise module['StorageError']('fixture-failure-after-volume-moves')
    g['create_containers'] = fail_after_volume_moves
    try:
        module['apply_worker'](first)
        raise AssertionError('injected failure accepted')
    except module['StorageError'] as error:
        assert str(error) == 'fixture-failure-after-volume-moves'
    g['create_containers'] = original_create
    assert module['identity'](engine) == before
    assert not (state / 'maintenance').exists()
    assert module['read_json'](first / 'state.json')['recoveredOriginal'] is True
    for name, inode in identities.items():
        assert module['identity'](engine / 'volumes' / name / '_data') == inode
    (data / 'accepted-after-recovery.bin').write_bytes(os.urandom(4096))
    second = new_session()
    module['apply_worker'](second)
    assert module['identity'](engine) != before
    assert module['read_json'](second / 'state.json')['phase'] == 'READBACK_REQUIRED'
    assert (data / 'accepted-after-recovery.bin').is_file()
    for name, inode in identities.items():
        assert module['identity'](engine / 'volumes' / name / '_data') == inode
    module['local_websocket']({'publicHost': 'ai.shui.click'})
    # Exercise the retirement transaction only after the independent receipt
    # validator (covered by boundary tests) has authorized this fixture case.
    module['atomic_json'](second / 'readback.json', {'fixture': 'validated-in-boundary-tests'})
    module['checkpoint'](second, 'RETIRE_AUTHORIZED', readbackSha256=module['file_digest'](second / 'readback.json'))
    module['retire_worker'](second)
    assert module['read_json'](second / 'state.json')['phase'] == 'STORAGE_MAINTENANCE_OK'
    assert not engine.with_name('docker-retired-' + second.name).exists()
    assert (data / 'accepted-after-recovery.bin').is_file()
    print('STORAGE_DOCKER_REGRESSION_OK rollback-and-success preserve original volume identities and latest data')
except BaseException:
    for directory in sessions.iterdir():
        if (directory / 'state.json').is_file():
            # Case status contains only phases, identities and field paths.
            # Raw runtime/configuration snapshots are never uploaded.
            print('STORAGE_CI_CASE_STATUS ' + json.dumps(module['read_json'](directory / 'state.json'), sort_keys=True))
    raise
finally:
    for label in list(processes):
        daemon(label, None, '', False)
    # Fixture data and daemon diagnostics are disposable; preserve diagnostics
    # only on failure through the CI artifact step, never production snapshots.
    destination = repository / '.delivery-evidence/storage-ci'
    destination.mkdir(parents=True, exist_ok=True)
    for path in base.glob('*.log'):
        shutil.copyfile(str(path), str(destination / path.name))
    for directory in sessions.iterdir():
        if (directory / 'state.json').is_file():
            shutil.copyfile(str(directory / 'state.json'), str(destination / (directory.name + '-status.json')))
