import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('server CI image import before cutover', () => {
  it.each(['valid', 'bad-checksum', 'wrong-revision', 'wrong-platform', 'wrong-image'])('verifies the streamed image without constructing it (%s)', mode => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-image-import-'));
    const sha = 'a'.repeat(40); const imageId = `sha256:${'b'.repeat(64)}`;
    const payload = Buffer.from('synthetic image transfer');
    try {
      writeFileSync(path.join(directory, 'docker'), `#!/usr/bin/env python3
import os,sys
a=sys.argv[1:]
if a==['image','load']: sys.stdin.buffer.read(); sys.exit(0)
if a[:2]==['image','inspect']:
 f=a[-1]
 if '.Id' in f: print(os.environ['FIX_IMAGE'])
 elif 'revision' in f: print(os.environ['FIX_REVISION'])
 elif '.Architecture' in f: print(os.environ['FIX_PLATFORM'])
 else: sys.exit(2)
else: sys.exit(3)
`, { mode: 0o755 });
      writeFileSync(path.join(directory, 'uname'), '#!/bin/sh\nprintf x86_64\n', { mode: 0o755 });
      const source = readFileSync(new URL('../deploy/server/quiet-room-deploy', import.meta.url), 'utf8');
      const block = source.slice(source.indexOf('deploy_phase_start import-ci-image'), source.indexOf('deploy_phase_start compose-preflight'));
      expect(block).not.toContain('docker build');
      const result = spawnSync('bash', ['-c', `set -euo pipefail\ndeploy_phase_start() { :; }\nnew_image=quiet-room-app:$REQUESTED_SHA\n${block}`], {
        input: payload, encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
          REQUESTED_SHA: sha, REQUESTED_IMAGE_ID: imageId,
          REQUESTED_ARCHIVE_SHA: mode === 'bad-checksum' ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex'),
          FIX_IMAGE: mode === 'wrong-image' ? `sha256:${'c'.repeat(64)}` : imageId,
          FIX_REVISION: mode === 'wrong-revision' ? 'c'.repeat(40) : sha,
          FIX_PLATFORM: mode === 'wrong-platform' ? 'linux/arm64' : 'linux/amd64',
        },
      });
      if (mode === 'valid') expect(result.status, result.stderr).toBe(0);
      else expect(result.status).not.toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
