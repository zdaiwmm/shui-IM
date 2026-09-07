import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { loadConfig, saveConfig, userConfigPath, validateConfig } from '../scripts/deploy-config.mjs';

const originalConfigPath = process.env.QUIET_ROOM_DEPLOY_CONFIG;

afterEach(() => {
  if (originalConfigPath === undefined) delete process.env.QUIET_ROOM_DEPLOY_CONFIG;
  else process.env.QUIET_ROOM_DEPLOY_CONFIG = originalConfigPath;
});

describe('reusable deployment configuration', () => {
  it('prefers a worktree override, then the per-user config, then environment values', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-deploy-config-'));
    try {
      const key = path.join(directory, 'server.key');
      writeFileSync(key, 'fixture');
      const shared = path.join(directory, 'shared.json');
      process.env.QUIET_ROOM_DEPLOY_CONFIG = shared;
      writeFileSync(shared, JSON.stringify({ serverHost: 'shared.example', serverUser: 'shared', serverKey: key }));
      expect(loadConfig(directory).config.serverHost).toBe('shared.example');
      writeFileSync(path.join(directory, '.deploy.local.json'), JSON.stringify({ serverHost: 'local.example', serverUser: 'local', serverKey: key }));
      expect(loadConfig(directory).config.serverHost).toBe('local.example');
      process.env.QUIET_ROOM_SERVER_HOST = 'env.example';
      expect(loadConfig(directory).config.serverHost).toBe('env.example');
      delete process.env.QUIET_ROOM_SERVER_HOST;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('writes only deploy paths with private permissions and validates key files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-deploy-config-'));
    try {
      const key = path.join(directory, 'server.key');
      writeFileSync(key, 'fixture');
      const destination = path.join(directory, 'nested', 'deploy.json');
      expect(saveConfig({ serverHost: 'example.com', serverUser: 'admin', serverKey: key }, destination)).toBe(destination);
      expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({ serverHost: 'example.com', serverUser: 'admin', serverKey: key });
      expect(statSync(destination).mode & 0o777).toBe(0o600);
      expect(() => validateConfig({ serverHost: 'example.com', serverUser: 'admin', serverKey: 'missing' })).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses a stable home config path unless explicitly overridden', () => {
    delete process.env.QUIET_ROOM_DEPLOY_CONFIG;
    expect(userConfigPath()).toMatch(/\.config[\\/]quiet-room[\\/]deploy\.json$/);
  });
});
