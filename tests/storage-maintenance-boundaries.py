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
