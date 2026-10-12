import copy
import datetime
import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import time
import unittest


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
