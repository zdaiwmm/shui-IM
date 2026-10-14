"""Bounded GitHub ZIP range reader; no archive is written on the server.

Executed as the existing administrator by the protected cloud workflow. The
installed root helper independently verifies checksum/image and holds the lock.
Never print the signed URL, exception text from HTTP, or the input payload.
"""
import hashlib
import io
import json
import re
import struct
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import zipfile
import zlib

LIMIT = 2 * 1024 ** 3
CHUNK = 128 * 1024


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or parsed.username or parsed.password or
            parsed.port not in (None, 443) or parsed.fragment or
            not (host.endswith('.blob.core.windows.net') or host.endswith('.actions.githubusercontent.com'))):
        raise ValueError('Unexpected artifact location')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Artifact redirect refused')


class RemoteZip(io.RawIOBase):
    def __init__(self, url, size, opener=None):
        validate_url(url)
        if type(size) is not int or not 0 < size <= LIMIT:
            raise ValueError('Artifact size limit')
        self.url, self.size, self.position, self.metadata_bytes = url, size, 0, 0
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        position = offset + (self.position if whence == 1 else self.size if whence == 2 else 0)
        if whence not in (0, 1, 2) or not 0 <= position <= self.size:
            raise ValueError('Invalid ZIP seek')
        self.position = position
        return position

    def tell(self):
        return self.position

    def range(self, start, length):
        if type(start) is not int or type(length) is not int or length <= 0 or start < 0 or start + length > self.size:
            raise ValueError('Invalid artifact range')
        request = urllib.request.Request(self.url, headers={'Range': f'bytes={start}-{start + length - 1}', 'Accept-Encoding': 'identity'})
        response = self.opener.open(request, timeout=45)
        if (response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{start + length - 1}/{self.size}' or
                int(response.headers.get('Content-Length', '-1')) != length or response.headers.get('Content-Encoding') not in (None, 'identity')):
            response.close()
            raise ValueError('Artifact range response mismatch')
        return response

    def read(self, size=-1):
        size = self.size - self.position if size < 0 else min(size, self.size - self.position)
        if size == 0:
            return b''
        self.metadata_bytes += size
        if size > CHUNK or self.metadata_bytes > 1024 * 1024:
            raise ValueError('ZIP metadata budget exceeded')
        with self.range(self.position, size) as response:
            data = response.read(size + 1)
        if len(data) != size:
            raise ValueError('Truncated ZIP metadata')
        self.position += size
        return data


def read_manifest(payload):
    remote = RemoteZip(payload['url'], payload['size'])
    with zipfile.ZipFile(remote) as archive:
        if sorted(archive.namelist()) != ['image.json', 'image.tar.gz']:
            raise ValueError('Unexpected artifact members')
        item = archive.getinfo('image.json')
        if not 0 < item.file_size <= 8192 or not 0 < item.compress_size <= 8192:
            raise ValueError('Manifest size limit')
        return json.loads(archive.read(item))


def inspect_archive(remote, expected):
    with zipfile.ZipFile(remote) as archive:
        entries = archive.infolist()
        if sorted(entry.filename for entry in entries) != ['image.json', 'image.tar.gz']:
            raise ValueError('Unexpected artifact members')
        for entry in entries:
            if entry.flag_bits & 1 or entry.compress_type not in (0, 8) or entry.is_dir():
                raise ValueError('Unsupported ZIP member')
        metadata = archive.getinfo('image.json')
        if not 0 < metadata.file_size <= 8192 or not 0 < metadata.compress_size <= 8192:
            raise ValueError('Manifest size limit')
        if json.loads(archive.read(metadata)) != expected:
            raise ValueError('Manifest differs from verified CI image')
        entry = archive.getinfo('image.tar.gz')
        if entry.file_size != expected['archiveBytes'] or not 0 < entry.file_size <= LIMIT or not 0 < entry.compress_size <= LIMIT:
            raise ValueError('Image size mismatch')
        remote.seek(entry.header_offset)
        header = remote.read(30)
        fields = struct.unpack('<4s5H3I2H', header)
        if fields[0] != b'PK\x03\x04' or fields[2] & 1 or fields[3] != entry.compress_type:
            raise ValueError('ZIP local header mismatch')
        name = remote.read(fields[-2])
        if name != b'image.tar.gz':
            raise ValueError('ZIP local filename mismatch')
        start = entry.header_offset + 30 + fields[-2] + fields[-1]
        if start + entry.compress_size > remote.size:
            raise ValueError('ZIP extent mismatch')
        return entry, start


def stream_image(response, entry, expected, output):
    decompressor = zlib.decompressobj(-15) if entry.compress_type == 8 else None
    digest = hashlib.sha256()
    total, compressed, crc = 0, 0, 0
    deadline = time.monotonic() + 15 * 60
    # Withhold the final chunk until every transfer check passes. On failure,
    # closing the helper's stdin yields a checksum failure before cutover.
    pending = b''
    def emit(data):
        nonlocal total, crc, pending
        if not data:
            return
        total += len(data)
        if total > expected['archiveBytes']:
            raise ValueError('Image expansion limit')
        digest.update(data)
        crc = zlib.crc32(data, crc)
        output.write(pending)
        pending = data
    while compressed < entry.compress_size:
        if time.monotonic() > deadline:
            raise TimeoutError('Image transfer deadline')
        chunk = response.read(min(CHUNK, entry.compress_size - compressed))
        if not chunk:
            raise ValueError('Truncated image payload')
        compressed += len(chunk)
        if decompressor:
            while chunk:
                emit(decompressor.decompress(chunk, CHUNK))
                chunk = decompressor.unconsumed_tail
        else:
            emit(chunk)
    if decompressor and (not decompressor.eof or decompressor.unused_data):
        raise ValueError('Invalid compressed payload')
    if total != expected['archiveBytes'] or digest.hexdigest() != expected['archiveSha256'] or crc != entry.CRC:
        raise ValueError('Image transfer checksum mismatch')
    output.write(pending)
    output.flush()
    return total


def main(payload):
    expected = payload['manifest']
    if (not re.fullmatch('[0-9a-f]{40}', expected['sha']) or
            not re.fullmatch('sha256:[0-9a-f]{64}', expected['imageId']) or
            not re.fullmatch('[0-9a-f]{64}', expected['archiveSha256']) or
            not re.fullmatch('[0-9a-f]{40}', payload['previousSha'])):
        raise ValueError('Invalid image identity')
    remote = RemoteZip(payload['url'], payload['size'])
    entry, start = inspect_archive(remote, expected)
    # Establish the one large HTTP response before starting the helper; no
    # subsequent range request depends on an expired short-lived URL.
    with remote.range(start, entry.compress_size) as response:
        mode = payload.get('mode', 'deploy')
        if mode not in ('deploy', 'stage'):
            raise ValueError('Invalid image operation')
        args = ['sudo', '-n', '/usr/local/sbin/quiet-room-deploy']
        if mode == 'stage':
            args.append('--stage')
        process = subprocess.Popen(args + [expected['sha'], expected['imageId'], expected['archiveSha256'], payload['previousSha']], stdin=subprocess.PIPE)
        try:
            stream_image(response, entry, expected, process.stdin)
        finally:
            try:
                process.stdin.close()
            finally:
                # Never kill or automatically repeat a possibly active cutover.
                status = process.wait()
        if status != 0:
            raise ValueError('Deployment helper failed')
    print('STREAM_VERIFIED sha=' + expected['sha'] + ' image=' + expected['imageId'], flush=True)


if __name__ == '__main__':
    try:
        payload = json.loads(sys.stdin.read(16385))
        if sys.argv[1:] == ['--manifest']:
            print(json.dumps(read_manifest(payload)), flush=True)
        else:
            main(payload)
    except BaseException as error:
        print('SERVER_STREAM_BLOCKED type=' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
