import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script has no TS declarations.
import { loadConfig, publicOrigin, targetArguments, validateConfig } from '../scripts/deploy-config.mjs';
// @ts-expect-error Operational Node script has no TS declarations.
import { validateServerState } from '../scripts/production-readback.mjs';

describe('independent deployment environments', () => {
  it('selects exactly one profile and never falls back to the legacy target', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-environments-'));
    const old = process.env.QUIET_ROOM_SERVER_HOST;
    try {
      writeFileSync(path.join(directory, '.deploy.local.json'), JSON.stringify({ serverHost: 'legacy.example' }));
      for (const environment of ['blue', 'green']) {
        writeFileSync(path.join(directory, `.deploy.${environment}.local.json`), JSON.stringify({ environment, serverHost: `${environment}.example`, serverUser: 'admin', serverKey: '/tmp/key', publicOrigin: `https://${environment}.example` }));
      }
      process.env.QUIET_ROOM_SERVER_HOST = 'legacy-override.example';
      expect(loadConfig(directory, 'blue').config.serverHost).toBe('blue.example');
      expect(loadConfig(directory, 'green').config.serverHost).toBe('green.example');
      expect(() => loadConfig(directory, 'missing')).toThrow('missing or mismatched');
      writeFileSync(path.join(directory, '.deploy.green.local.json'), JSON.stringify({ environment: 'blue' }));
      expect(() => loadConfig(directory, 'green')).toThrow('missing or mismatched');
    } finally {
      if (old === undefined) delete process.env.QUIET_ROOM_SERVER_HOST; else process.env.QUIET_ROOM_SERVER_HOST = old;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects ambiguous targets, unsafe origins and unsupported platforms', () => {
    expect(targetArguments(['--environment', 'green', '--sha', 'a'.repeat(40)])).toEqual({ environment: 'green', args: ['--sha', 'a'.repeat(40)] });
    for (const args of [['--environment'], ['--environment', '../green'], ['--environment', 'blue', '--environment', 'green']]) expect(() => targetArguments(args)).toThrow();
    for (const value of ['http://green.example', 'https://green.example/path', 'https://user:pass@green.example', 'https://green.example:444']) expect(() => publicOrigin({ publicOrigin: value })).toThrow();
    expect(() => validateConfig({ serverHost: 'green.example', serverUser: 'admin', serverKey: '/tmp/key', environment: 'green' })).toThrow('requires publicOrigin');
    expect(() => validateConfig({ serverHost: 'green.example', serverUser: 'admin', serverKey: '/tmp/key', imagePlatform: 'windows/amd64' })).toThrow('imagePlatform');
  });
  it('rejects another environment before accepting a production readback', () => {
    expect(() => validateServerState({ publicOrigin: 'https://blue.example' }, 'a'.repeat(40), 'https://green.example')).toThrow('differs from the selected environment');
  });
});
