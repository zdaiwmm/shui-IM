"""Execute the installed-helper receipt parser without a live host or data."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

source = Path('deploy/server/quiet-room-deploy').read_text()
code = source.split("<<'PY_STAGE_READ'\n", 1)[1].split('\nPY_STAGE_READ', 1)[0]
sha, image, digest, previous = 'a'*40, 'sha256:'+'b'*64, 'c'*64, 'd'*40
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary).resolve()
    releases = root/'releases'
    checkout = releases/('staged-20261014T120000Z-'+sha[:12])
    checkout.mkdir(parents=True)
    receipt = root/'receipt.json'
    now = int(time.time())
    good = dict(version=1,sha=sha,imageId=image,archiveSha256=digest,previousSha=previous,releaseDirectory=str(checkout),preparedAt=now-1,expiresAt=now-1+7200)
    def validate(value, uid=0, mode=0o600, symlink=False):
        if receipt.exists() or receipt.is_symlink(): receipt.unlink()
        target = root/'target.json'
        target.write_text(json.dumps(value))
        if symlink: receipt.symlink_to(target)
        else: receipt.write_text(json.dumps(value)); receipt.chmod(mode)
        original = os.lstat
        def stat(path, *args, **kwargs):
            result = original(path,*args,**kwargs)
            if str(path)==str(receipt): return SimpleNamespace(st_uid=uid,st_mode=result.st_mode)
            return result
        with patch('sys.argv',['test',str(receipt),sha,image,digest,previous,str(releases)]), patch('os.lstat',stat), contextlib.redirect_stdout(io.StringIO()):
            exec(compile(code,'helper-stage-parser','exec'),{})
    validate(good)
    cases = [dict(good,sha='f'*40),dict(good,imageId='sha256:'+'f'*64),dict(good,archiveSha256='f'*64),dict(good,previousSha='f'*40),dict(good,expiresAt=now-1),dict(good,preparedAt=now+1,expiresAt=now+7201),dict(good,preparedAt=True),dict(good,releaseDirectory='/etc'),dict(good,releaseDirectory=str(releases/'staged-missing'))]
    for value in cases:
        try: validate(value)
        except (ValueError,FileNotFoundError): pass
        else: raise AssertionError('Unsafe candidate accepted')
    for options in [dict(uid=501),dict(mode=0o622),dict(symlink=True)]:
        try: validate(good,**options)
        except ValueError: pass
        else: raise AssertionError('Unsafe receipt accepted')
print('STAGED_IMAGE_PARSER_TESTS_OK')
