import copy
import datetime
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import time
import unittest
from types import SimpleNamespace


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.module = runpy.run_path('deploy/server/quiet-room-storage-maintenance')
        self.g = self.module['move_volumes'].__globals__
        self.engine = self.base / 'docker'
        self.engine.mkdir()
        self.sessions = self.base / 'sessions'
        self.sessions.mkdir()
        self.directory = self.sessions / '20261012T100000Z-aaaaaaaaaaaa'
        self.directory.mkdir(mode=0o700)
        self.g.update(ENGINE=self.engine, SESSIONS=self.sessions, STATE=self.base / 'state', ROOT=self.base / 'application')

    def write(self, name, value):
        self.module['atomic_json'](self.directory / name, value)

    def volume_fixture(self):
        old = self.engine.with_name('docker-retired-' + self.directory.name)
        source = old / 'volumes/data/_data'
        target = self.engine / 'volumes/data/_data'
        source.mkdir(parents=True)
        target.mkdir(parents=True)
        (source / 'latest').write_bytes(b'latest acknowledged ciphertext')
        original = self.module['identity'](source)
        self.write('target.json', {'volumes': [{'name': 'data', 'identity': original}]})
        snapshot = {'volumes': [{'Name': 'data', 'Mountpoint': str(target)}]}
        return old, source, target, original, snapshot

    def test_volume_moves_preserve_the_only_original_and_resume(self):
        old, source, target, original, snapshot = self.volume_fixture()
        self.module['move_volumes'](self.directory, snapshot, True)
        self.assertFalse(source.exists())
        self.assertEqual(self.module['identity'](target), original)
        self.module['move_volumes'](self.directory, snapshot, True)
        self.assertEqual((target / 'latest').read_bytes(), b'latest acknowledged ciphertext')
        self.module['move_volumes'](self.directory, snapshot, False)
        self.assertEqual(self.module['identity'](source), original)
        self.assertFalse(target.exists())

    def test_volume_move_refuses_to_overwrite_foreign_data(self):
        old, source, target, original, snapshot = self.volume_fixture()
        (target / 'foreign').write_text('retain this')
        with self.assertRaisesRegex(self.module['StorageError'], 'nonempty-volume-target'):
            self.module['move_volumes'](self.directory, snapshot, True)
        self.assertEqual(self.module['identity'](source), original)
        self.assertEqual((target / 'foreign').read_text(), 'retain this')

    def test_archive_rejects_escape_links_and_special_files(self):
        for index, (name, kind) in enumerate([('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE),
                                               ('link', tarfile.SYMTYPE), ('hard', tarfile.LNKTYPE), ('device', tarfile.CHRTYPE)]):
            archive = self.base / ('unsafe-' + str(index) + '.tar.gz')
            with tarfile.open(str(archive), 'w:gz') as output:
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    member.linkname = '../outside'
                output.addfile(member)
            with self.assertRaises(self.module['StorageError']):
                self.module['archive_members'](archive)

    def test_volume_manifest_refuses_symlinks(self):
        data = self.base / 'data'
        data.mkdir()
        (data / 'escape').symlink_to(self.base / 'outside')
        with self.assertRaises(self.module['StorageError']):
            self.module['filesystem_manifest'](data)

    def stream_fixture(self, times):
        reader, writer = os.pipe()
        os.write(writer, b'fixture archive payload')
        os.close(writer)
        calls = []
        class Process:
            stdout = os.fdopen(reader, 'rb', buffering=0)
            killed = False
            finished = False
            def wait(self, timeout=None):
                calls.append(timeout)
                if timeout is not None and timeout < 100 and not self.killed:
                    raise subprocess.TimeoutExpired('fixture', timeout)
                self.finished = True
                return 0
            def poll(self):
                return 0 if self.finished else None
            def kill(self):
                self.killed = True
        process = Process()
        self.addCleanup(process.stdout.close)
        self.g['subprocess'] = SimpleNamespace(Popen=lambda *args, **kwargs: process, TimeoutExpired=subprocess.TimeoutExpired,
                                              PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL)
        self.g['time'] = SimpleNamespace(monotonic=lambda: next(times))
        return process, calls

    def test_stream_completion_can_use_the_remaining_total_deadline(self):
        process, calls = self.stream_fixture(iter([0, 0, 0, 1]))
        self.module['stream_process'](['fixture'], self.base / 'image.gz', True, timeout=600)
        self.assertEqual(calls, [599])
        self.assertFalse(process.killed)

    def test_stream_completion_does_not_extend_the_total_deadline(self):
        process, calls = self.stream_fixture(iter([0, 0, 0, 599]))
        with self.assertRaisesRegex(self.module['StorageError'], 'archive-stream-timeout'):
            self.module['stream_process'](['fixture'], self.base / 'image.gz', True, timeout=600)
        self.assertEqual(calls[0], 1)
        self.assertTrue(process.killed)

    def reference_fixture(self):
        image = 'sha256:' + 'a' * 64
        tag = 'fixture:original'
        digest = 'fixture@sha256:' + 'b' * 64
        store = {'Repositories': {'fixture': {tag: image, digest: image}}}
        return {'images': [{'Id': image, 'RepoTags': [tag], 'RepoDigests': [digest]}], 'imageReferenceStore': store}

    def test_reference_seed_preserves_the_exact_verified_mapping_in_an_empty_root(self):
        snapshot = self.reference_fixture()
        self.g['engine_unmounted'] = lambda root: None
        self.g['engine_files_closed'] = lambda root: None
        before = self.module['identity'](self.engine)
        self.module['seed_reference_store'](self.engine, snapshot)
        index = self.engine / 'image/overlay2/repositories.json'
        self.assertEqual(json.loads(index.read_text()), snapshot['imageReferenceStore'])
        self.assertEqual(index.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.module['identity'](self.engine), before)

    def test_reference_seed_never_overwrites_an_existing_engine_root(self):
        sentinel = self.engine / 'existing-engine-data'
        sentinel.write_bytes(b'original engine data')
        with self.assertRaisesRegex(self.module['StorageError'], 'reference-seed-root-not-empty'):
            self.module['seed_reference_store'](self.engine, self.reference_fixture())
        self.assertEqual(sentinel.read_bytes(), b'original engine data')
        self.assertFalse((self.engine / 'image').exists())

    def test_reference_seed_rejects_unknown_schema_wrong_ids_and_wrong_owners(self):
        for code in ('reference-store-schema', 'reference-store-api-mismatch', 'reference-store-owner'):
            with self.subTest(code=code):
                snapshot = self.reference_fixture()
                store = snapshot['imageReferenceStore']
                if code == 'reference-store-schema':
                    store['unknown'] = True
                elif code == 'reference-store-api-mismatch':
                    store['Repositories']['fixture']['fixture:original'] = 'sha256:' + 'c' * 64
                else:
                    store['Repositories']['other'] = store['Repositories'].pop('fixture')
                with self.assertRaisesRegex(self.module['StorageError'], code):
                    self.module['seed_reference_store'](self.engine, snapshot)
                self.assertEqual(list(self.engine.iterdir()), [])

    def test_reference_seed_rejects_symlinks_mounts_and_open_engine_files(self):
        link = self.base / 'linked-engine'
        link.symlink_to(self.engine, target_is_directory=True)
        with self.assertRaisesRegex(self.module['StorageError'], 'reference-seed-path'):
            self.module['seed_reference_store'](link, self.reference_fixture())
        for guard in ('engine_unmounted', 'engine_files_closed'):
            with self.subTest(guard=guard):
                self.g['engine_unmounted'] = lambda root: None
                self.g['engine_files_closed'] = lambda root: None
                def reject(root):
                    raise self.module['StorageError']('fixture-in-use')
                self.g[guard] = reject
                with self.assertRaisesRegex(self.module['StorageError'], 'fixture-in-use'):
                    self.module['seed_reference_store'](self.engine, self.reference_fixture())
                self.assertEqual(list(self.engine.iterdir()), [])

    def test_image_verification_is_offline_and_rejects_a_wrong_digest_mapping(self):
        snapshot = self.reference_fixture()
        image = snapshot['images'][0]
        self.g['docker'] = lambda *args, **kwargs: self.fail('registry command during offline verification')
        def api(method, path, endpoint=None):
            return [{'Id': image['Id']}] if path == '/images/json?all=false' else image
        self.g['api'] = api
        self.module['image_check'](snapshot, self.module['references'](snapshot['images']))
        def wrong_digest(method, path, endpoint=None):
            if '%40sha256' in path:
                return dict(image, Id='sha256:' + 'c' * 64)
            return api(method, path, endpoint)
        self.g['api'] = wrong_digest
        with self.assertRaisesRegex(self.module['StorageError'], 'restored-registry-digest'):
            self.module['image_check'](snapshot, self.module['references'](snapshot['images']))

    def test_database_probe_can_only_mount_disposable_restored_copy(self):
        restored = self.directory / 'restore-test'
        restored.mkdir(mode=0o700)
        calls = []
        self.g['docker'] = lambda args, endpoint=None, timeout=30: calls.append(args)
        self.module['database_check'](restored, 'fixture-image')
        args = calls[0]
        self.assertIn(str(restored) + ':/restore:rw', args)
        self.assertEqual(args[args.index('--cap-add') + 1], 'DAC_OVERRIDE')
        self.assertEqual(args[args.index('--cap-drop') + 1], 'ALL')
        self.assertEqual(args[args.index('--network') + 1], 'none')
        self.assertIn('--read-only', args)
        # Execute the actual embedded checker against a fake filesystem with a
        # real SQLite header and a corrupt quick_check result. A quoting/header
        # regression must not silently skip database validation.
        probe = r'''
const vm=require('node:vm');let opened=0;
const fs={readdirSync:()=>[{name:'fixture.sqlite',isDirectory:()=>false}],openSync:()=>1,
  readSync:(_fd,b)=>Buffer.from('SQLite format 3'+String.fromCharCode(0)).copy(b),closeSync:()=>{}};
class DatabaseSync{constructor(){opened++}prepare(sql){if(sql!=='PRAGMA quick_check')throw new Error('wrong check');return{all:()=>[{quick_check:'fixture-corruption'}]}}close(){}}
let rejected=false;
try{vm.runInNewContext(process.argv[1],{Buffer,require:n=>n==='node:fs'?fs:n==='node:sqlite'?{DatabaseSync}:require(n),process:{exit:c=>{throw new Error('EXIT_'+c)}}})}
catch(e){if(e.message!=='EXIT_2')throw e;rejected=true}
if(!rejected||opened!==1)process.exit(1);
'''
        result = subprocess.run(['node', '-e', probe, args[-1]], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.assertRaisesRegex(self.module['StorageError'], 'database-probe-copy-only'):
            self.module['database_check'](self.engine, 'fixture-image')
        self.assertEqual(len(calls), 1)

    def test_validation_sockets_fit_linux_unix_address_limit(self):
        runtime = self.module['validation_runtime'](Path('/var/lib/quiet-room-deploy/storage-maintenance') / self.directory.name)
        for suffix in ('docker.sock', 'exec/containerd/containerd.sock', 'exec/containerd/containerd.sock.ttrpc'):
            self.assertLess(len(str(runtime / suffix).encode()) + 1, 108)
        self.assertEqual(runtime.parent, Path('/run'))
        with self.assertRaisesRegex(self.module['StorageError'], 'validation-session'):
            self.module['validation_runtime'](Path('/unrelated/session'))

    def test_validation_daemon_uses_its_own_containerd_process_and_socket(self):
        self.write('runtime.json', self.reference_fixture())
        self.g['engine_unmounted'] = lambda root: None
        self.g['engine_files_closed'] = lambda root: None
        runtime = self.base / 'private-runtime'
        self.g['validation_runtime'] = lambda directory: runtime
        calls = []
        self.g['command'] = lambda args, timeout=30: calls.append(args) or ''
        self.g['api'] = lambda method, path, **kwargs: {'DockerRootDir': str(self.directory / 'validation/docker')}
        self.module['validation_daemon'](self.directory, True)
        containerd = next(args for args in calls if '/usr/bin/containerd' in args)
        dockerd = next(args for args in calls if '/usr/bin/dockerd' in args)
        address = containerd[containerd.index('--address') + 1]
        self.assertEqual(dockerd[dockerd.index('--containerd') + 1], address)
        self.assertNotEqual(address, self.g['CONTAINERD_SOCKET'])
        self.assertEqual(containerd[containerd.index('--root') + 1], str(self.directory / 'validation/containerd-root'))
        self.assertEqual(containerd[containerd.index('--state') + 1], str(runtime / 'containerd-state'))

    def test_prestart_oom_default_does_not_weaken_running_resource_checks(self):
        current = {'Config': {}, 'HostConfig': {'OomKillDisable': None, 'Memory': 256}, 'State': {'Running': False}}
        expected = {'OomKillDisable': False, 'Memory': 256}
        compare = self.module['runtime_fields']
        self.assertEqual(compare(current, {}, expected, before_start=True, oom_supported=False), [])
        self.assertEqual(compare(current, {}, expected), ['HostConfig.OomKillDisable'])
        self.assertEqual(compare(current, {}, expected, before_start=True, oom_supported=True), ['HostConfig.OomKillDisable'])
        self.assertEqual(compare(current, {}, dict(expected, OomKillDisable=True), before_start=True, oom_supported=False), ['HostConfig.OomKillDisable'])
        self.assertEqual(compare(current, {}, dict(expected, Memory=512), before_start=True, oom_supported=False), ['HostConfig.Memory'])
        current['State']['Running'] = True
        self.assertEqual(compare(current, {}, expected, before_start=True, oom_supported=False), ['HostConfig.OomKillDisable'])
        reverse = {'Config': {}, 'HostConfig': {'OomKillDisable': False, 'Memory': 256}, 'State': {'Running': False}}
        reverse_expected = dict(expected, OomKillDisable=None)
        self.assertEqual(compare(reverse, {}, reverse_expected, before_start=True, oom_supported=False), [])
        self.assertEqual(compare(reverse, {}, reverse_expected), ['HostConfig.OomKillDisable'])
        self.assertEqual(compare(reverse, {}, reverse_expected, before_start=True, oom_supported=None), ['HostConfig.OomKillDisable'])
        reverse['State']['Running'] = True
        self.assertEqual(compare(reverse, {}, reverse_expected, before_start=True, oom_supported=False), ['HostConfig.OomKillDisable'])

    def successful_readback(self):
        current = 'a' * 40
        image = 'sha256:' + 'b' * 64
        self.write('plan.json', {'currentSha': current, 'release': '/releases/current', 'publicHost': 'example.test',
                                 'containers': [{'imageId': image}, {'imageId': image}]})
        self.write('state.json', {'phase': 'READBACK_REQUIRED', 'openedAt': int(time.time()) - 10})
        return {'mode': 'read-only', 'status': 'success', 'expectedSha': current,
                'origin': 'https://example.test', 'finishedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                'server': {'currentSha': current, 'release': '/releases/current', 'maintenance': 'absent',
                           'appHealth': 'healthy', 'backupHealth': 'healthy', 'turnRunning': 'true',
                           'appImageId': image, 'backupImageId': image}, 'websocket': {'connected': True},
                'phases': [{'name': name, 'result': 'success'} for name in
                           ['server-state', 'validate-state', 'https-health', 'public-artifacts', 'container-artifacts', 'public-websocket']]}

    def test_retirement_needs_fresh_complete_independent_readback(self):
        valid = self.successful_readback()
        self.module['validate_readback'](self.directory, valid)
        invalid = []
        for key, value in [('currentSha', 'c' * 40), ('maintenance', 'present'), ('backupHealth', 'starting'), ('appImageId', 'sha256:' + 'd' * 64)]:
            receipt = copy.deepcopy(valid)
            receipt['server'][key] = value
            invalid.append(receipt)
        receipt = copy.deepcopy(valid)
        receipt['finishedAt'] = '2020-01-01T00:00:00.000Z'
        invalid.append(receipt)
        receipt = copy.deepcopy(valid)
        receipt['phases'].pop()
        invalid.append(receipt)
        receipt = copy.deepcopy(valid)
        receipt['websocket']['connected'] = False
        invalid.append(receipt)
        for receipt in invalid:
            with self.assertRaises(self.module['StorageError']):
                self.module['validate_readback'](self.directory, receipt)

    def test_post_open_rollback_cannot_move_or_restore_data(self):
        self.write('state.json', {'openedAt': int(time.time()), 'phase': 'READBACK_REQUIRED'})
        calls = []
        self.g['engine_control'] = lambda *args: calls.append(args)
        self.g['move_volumes'] = lambda *args: calls.append(args)
        with self.assertRaisesRegex(self.module['StorageError'], 'post-open-data-rollback-forbidden'):
            self.module['rollback_before_open'](self.directory, {}, {})
        self.assertFalse(calls)

    def test_partial_retirement_can_require_a_new_readback_without_replacing_storage(self):
        valid = self.successful_readback()
        self.write('state.json', {'phase': 'RETIRING_VERIFIED_LEGACY_STORAGE', 'openedAt': int(time.time()) - 10, 'entriesRemoved': 1000})
        self.module['validate_readback'](self.directory, valid)

    def test_engine_stop_refuses_remaining_containerd_tasks(self):
        def command(args, timeout=30):
            if args[0] == 'ctr':
                return 'unexpected-running-task'
            return 'inactive' if '--property=ActiveState' in args else ''
        self.g['command'] = command
        with self.assertRaisesRegex(self.module['StorageError'], 'containerd-tasks-still-running'):
            self.module['engine_control'](False)

    def test_cold_volume_reads_require_stopped_containers_and_no_runtime_task(self):
        state = {'Running': False, 'Paused': False, 'Restarting': False}
        listed = [{'Id': str(index), 'Names': ['/' + name]} for index, name in enumerate(self.module['NAMES'])]
        self.g['api'] = lambda method, path, **kwargs: listed if path == '/containers/json?all=true' else {'State': state}
        tasks = ['']
        self.g['command'] = lambda args, timeout=30: tasks[0]
        self.module['require_quiescent']()
        for key in state:
            state[key] = True
            with self.assertRaisesRegex(self.module['StorageError'], 'containers-still-running'):
                self.module['require_quiescent']()
            state[key] = False
        tasks[0] = 'remaining-task'
        with self.assertRaisesRegex(self.module['StorageError'], 'containerd-tasks-still-running'):
            self.module['require_quiescent']()
        tasks[0] = ''
        listed.append({'Id': 'unknown', 'Names': ['/unknown']})
        with self.assertRaisesRegex(self.module['StorageError'], 'quiescent-container-drift'):
            self.module['require_quiescent']()

    def test_inventory_is_stable_when_docker_reorders_identical_objects(self):
        root = self.g['ROOT']
        for path in [root / 'shared', root / 'deploy-state', root / 'git-releases/release']:
            path.mkdir(parents=True)
        (root / 'current').symlink_to(root / 'git-releases/release')
        (root / 'deploy-state/current-sha').write_text('a' * 40)
        (root / 'deploy-state/deployed-at').write_text('fixture')
        volumes = []
        for name in ['data', 'turn']:
            path = self.engine / 'volumes' / name / '_data'
            path.mkdir(parents=True)
            volumes.append({'Name': name, 'Driver': 'local', 'Options': None, 'Mountpoint': str(path), 'Labels': {}})
        images = [{'Id': 'sha256:' + 'b' * 64, 'Size': 100, 'RepoTags': ['quiet-room-app:production', 'quiet-room-app:' + 'a' * 40], 'RepoDigests': []},
                  {'Id': 'sha256:' + 'c' * 64, 'Size': 100, 'RepoTags': ['fixture:retained'], 'RepoDigests': []}]
        index = self.engine / 'image/overlay2/repositories.json'
        index.parent.mkdir(parents=True)
        self.module['atomic_json'](index, {'Repositories': {
            'quiet-room-app': {name: images[0]['Id'] for name in images[0]['RepoTags']},
            'fixture': {'fixture:retained': images[1]['Id']}}})
        networks = [{'Name': name, 'Id': str(index) * 64, 'Driver': 'bridge', 'Scope': 'local',
                     'IPAM': {}, 'Options': {}, 'Labels': {}} for index, name in enumerate(['one', 'two'])]
        containers = []
        for index, name in enumerate(self.module['NAMES']):
            containers.append({'Name': '/' + name, 'Id': str(index + 1) * 64, 'Image': images[0]['Id'],
                               'Config': {'Env': ['ADMIN_ORIGIN=https://admin.independent.test']},
                               'HostConfig': {'ReadonlyRootfs': True}, 'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                               'Mounts': [{'Type': 'volume', 'Name': volume['Name'], 'Source': volume['Mountpoint'],
                                           'Destination': '/' + volume['Name'], 'RW': True} for volume in volumes],
                               'NetworkSettings': {'Networks': {}}})
        alternate = [False]
        def api(method, path, body=None, endpoint=None):
            if path == '/info':
                alternate[0] = not alternate[0]
                return {'DockerRootDir': str(self.engine), 'Driver': 'overlay2', 'Swarm': {'LocalNodeState': 'inactive'}}
            if path == '/containers/json?all=true':
                return [{'Names': [item['Name']]} for item in containers]
            if path.startswith('/containers/'):
                item = copy.deepcopy(next(item for item in containers if item['Name'] + '/json' == path[len('/containers'):]))
                if alternate[0]:
                    item['Mounts'].reverse()
                return item
            if path == '/images/json?all=false':
                return list(reversed(images)) if alternate[0] else images
            if path.startswith('/images/'):
                item = copy.deepcopy(next(item for item in images if '/images/' + item['Id'] + '/json' == path))
                if alternate[0]:
                    item['RepoTags'].reverse()
                return item
            if path == '/volumes':
                return {'Volumes': list(reversed(volumes)) if alternate[0] else volumes}
            if path == '/networks':
                return list(reversed(networks)) if alternate[0] else networks
            if path.startswith('/networks/'):
                return copy.deepcopy(next(item for item in networks if '/networks/' + item['Id'] == path))
            raise AssertionError(path)
        self.g['api'] = api
        machine = self.base / 'machine-id'
        machine.write_text('fixture-machine')
        self.g['MACHINE_ID'] = machine
        first = self.module['inventory']()
        second = self.module['inventory']()
        self.assertEqual(first, second)
        self.assertEqual(first[0]['adminOrigin'], 'https://admin.independent.test')
        containers[2]['Mounts'][0]['RW'] = False
        changed = self.module['inventory']()
        self.assertNotEqual(first[0]['runtimeSnapshotHash'], changed[0]['runtimeSnapshotHash'])

    def runtime(self):
        return {'Config': {'Env': ['PRIVATE_VALUE=fixture'], 'Image': 'app:exact'},
                'HostConfig': {'NetworkMode': 'project', 'PortBindings': {'8080/tcp': [{'HostPort': '8080'}]},
                               'Mounts': [{'Type': 'volume', 'Source': 'original-volume', 'Target': '/data'}]},
                'Mounts': [{'Type': 'volume', 'Name': 'original-volume', 'Destination': '/data'}],
                'NetworkSettings': {'Networks': {'project': {'EndpointID': 'dynamic-id', 'NetworkID': 'dynamic-network',
                                                            'Aliases': ['service'], 'MacAddress': '02:42:00:00:00:02',
                                                            'IPAMConfig': {'IPv4Address': '10.0.0.2'}}}}}

    def test_runtime_copy_preserves_credentials_mounts_and_static_network_settings(self):
        original = self.runtime()
        payload = self.module['create_payload'](original)
        self.assertEqual(payload['Env'], ['PRIVATE_VALUE=fixture'])
        self.assertEqual(payload['HostConfig'], original['HostConfig'])
        endpoint = payload['NetworkingConfig']['EndpointsConfig']['project']
        self.assertNotIn('NetworkID', endpoint)
        self.assertNotIn('EndpointID', endpoint)
        self.assertEqual(endpoint['IPAMConfig'], {'IPv4Address': '10.0.0.2'})
        isolated = self.module['create_payload'](original, True)
        self.assertEqual(isolated['HostConfig']['NetworkMode'], 'none')
        self.assertEqual(original['HostConfig']['NetworkMode'], 'project')
        original['HostConfig']['Mounts'] = []
        with self.assertRaisesRegex(self.module['StorageError'], 'implicit-volume-not-preserved'):
            self.module['create_payload'](original)

    def test_runtime_copy_does_not_turn_an_automatic_mac_into_static_configuration(self):
        original = self.runtime()
        original['Config']['MacAddress'] = ''
        payload = self.module['create_payload'](original)
        self.assertNotIn('MacAddress', payload['NetworkingConfig']['EndpointsConfig']['project'])
        desired = '02:42:00:00:00:03'
        original['Config']['MacAddress'] = desired
        payload = self.module['create_payload'](original)
        self.assertEqual(payload['MacAddress'], desired)
        self.assertEqual(payload['NetworkingConfig']['EndpointsConfig']['project']['MacAddress'], desired)
        original['NetworkSettings']['Networks']['other'] = {}
        with self.assertRaisesRegex(self.module['StorageError'], 'multiple-container-networks-unsupported'):
            self.module['create_payload'](original)

    def test_retirement_keeps_unexpected_old_volume_data(self):
        old, source, target, original, snapshot = self.volume_fixture()
        self.module['move_volumes'](self.directory, snapshot, True)
        source.mkdir()
        (source / 'unexpected').write_text('retain')
        plan = {'engineIdentity': self.module['identity'](old), 'volumes': [{'name': 'data'}],
                'runtimeSnapshotHash': self.module['digest']({}),
                'helperSha256': self.module['file_digest']('deploy/server/quiet-room-storage-maintenance')}
        self.write('state.json', {'newEngineIdentity': self.module['identity'](self.engine)})
        self.g['restored_state'] = lambda *args: None
        with self.assertRaisesRegex(self.module['StorageError'], 'legacy-root-still-has-data'):
            self.module['retirement_checks'](self.directory, plan, {})
        self.assertEqual((source / 'unexpected').read_text(), 'retain')
        self.assertEqual(self.module['identity'](target), original)


if __name__ == '__main__':
    unittest.main()
