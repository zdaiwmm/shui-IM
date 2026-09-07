import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { parseSetupArgs, setupConfig } from '../scripts/deploy-setup.mjs';

describe('deploy setup command', () => {
  it('requires host, user, and an absolute server key', () => {
    expect(parseSetupArgs(['--host', 'example.com', '--user', 'admin', '--server-key', '/tmp/key'])).toEqual({ serverHost: 'example.com', serverUser: 'admin', serverKey: '/tmp/key' });
    expect(() => parseSetupArgs(['--host', 'example.com'])).toThrow('Missing required arguments');
    expect(() => parseSetupArgs(['--host', 'example.com', '--user', 'admin', '--server-key'])).toThrow('Invalid arguments');
  });

  it('saves a reusable config at the configured path', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-deploy-setup-'));
    const previous = process.env.QUIET_ROOM_DEPLOY_CONFIG;
    try {
      const key = path.join(directory, 'server.key');
      writeFileSync(key, 'fixture');
      process.env.QUIET_ROOM_DEPLOY_CONFIG = path.join(directory, 'deploy.json');
      expect(setupConfig(['--host', 'example.com', '--user', 'admin', '--server-key', key], directory)).toBe(process.env.QUIET_ROOM_DEPLOY_CONFIG);
    } finally {
      if (previous === undefined) delete process.env.QUIET_ROOM_DEPLOY_CONFIG;
      else process.env.QUIET_ROOM_DEPLOY_CONFIG = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
