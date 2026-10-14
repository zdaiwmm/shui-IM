import hashlib
import importlib.util
import io
import json
import zipfile

spec = importlib.util.spec_from_file_location('stream', 'scripts/server-image-stream.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
data = b'synthetic image bytes' * 20000
manifest = {'archiveBytes': len(data), 'archiveSha256': hashlib.sha256(data).hexdigest()}

class Response(io.BytesIO):
    status = 206
    def __init__(self, data, start, total, status=206):
        super().__init__(data)
        self.status = status
        self.headers = {'Content-Length': str(len(data)), 'Content-Range': f'bytes {start}-{start+len(data)-1}/{total}'}

class Opener:
    def __init__(self, data, status=206):
        self.data, self.status = data, status
    def open(self, request, timeout):
        start, end = map(int, request.headers['Range'][6:].split('-'))
        return Response(self.data[start:end+1], start, len(self.data), self.status)

def rejected(action):
    try:
        action()
    except (ValueError, zipfile.BadZipFile):
        return
    raise AssertionError('Invalid transfer accepted')

for method in (0, 8):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=method) as archive:
        archive.writestr('image.json', json.dumps(manifest))
        archive.writestr('image.tar.gz', data)
    zipped = buffer.getvalue()
    remote = module.RemoteZip('https://example.blob.core.windows.net/a?signature=private', len(zipped), Opener(zipped))
    factory = module.RemoteZip
    module.RemoteZip = lambda url, size: factory(url, size, Opener(zipped))
    try:
        assert module.read_manifest({'url': remote.url, 'size': len(zipped)}) == manifest
    finally:
        module.RemoteZip = factory
    entry, start = module.inspect_archive(remote, manifest)
    output = io.BytesIO()
    with remote.range(start, entry.compress_size) as response:
        assert module.stream_image(response, entry, manifest, output) == len(data)
    assert output.getvalue() == data
    assert remote.metadata_bytes < 1024 * 1024
    payload = zipped[start:start+entry.compress_size]
    rejected(lambda: module.stream_image(io.BytesIO(payload[:-1]), entry, manifest, io.BytesIO()))
    rejected(lambda: module.stream_image(io.BytesIO(payload), entry, {**manifest, 'archiveSha256': '0'*64}, io.BytesIO()))
    rejected(lambda: module.stream_image(io.BytesIO(payload), entry, {**manifest, 'archiveBytes': 1}, io.BytesIO()))
    bad = module.RemoteZip(remote.url, len(zipped), Opener(zipped, 200))
    rejected(lambda: module.inspect_archive(bad, manifest))
    # A corrupted small manifest cannot supply a sealed transfer identity.
    damaged = bytearray(zipped)
    damaged[zipped.index(b'PK\x01\x02') + 16] ^= 1  # Stored central-directory CRC.
    module.RemoteZip = lambda url, size: factory(url, size, Opener(bytes(damaged)))
    try:
        rejected(lambda: module.read_manifest({'url': remote.url, 'size': len(zipped)}))
    finally:
        module.RemoteZip = factory
for url in ('http://example.blob.core.windows.net/a', 'https://evil.example/a', 'https://a.blob.core.windows.net@evil.example/a', 'https://a.blob.core.windows.net:8443/a'):
    rejected(lambda: module.validate_url(url))
print('SERVER_STREAM_TESTS_OK')
