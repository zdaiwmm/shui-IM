import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Operational Node script has no TS declarations.
import { browserGroups, parseBrowserArguments, runBrowserScript, runBrowserTests, selectBrowserScripts } from '../scripts/test-browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('browser regression groups', () => {
  it('partitions group 2 into disjoint concurrent runner shards without omissions', async () => {
    const shards = Array.from({ length: 4 }, (_, i) => selectBrowserScripts('2', `${i + 1}/4`));
    expect(shards.flat().sort()).toEqual(selectBrowserScripts('2').sort());
    expect(new Set(shards.flat()).size).toBe(29);
    expect(shards.map(shard => shard.length)).toEqual([8, 7, 7, 7]);
    for (const shard of ['0/4', '5/4', '1/0', '1/99', 'x', '1/2/3']) {
      expect(() => parseBrowserArguments(['--group', '2', '--shard', shard])).toThrow();
    }
    expect(() => parseBrowserArguments(['--shard'])).toThrow();
    expect(() => parseBrowserArguments(['--shard', '1/4', '--shard', '2/4'])).toThrow();
    const seen: string[] = [];
    await runBrowserTests({ group: '2', shard: '2/4', run: async (script: string) => { seen.push(script); }, log: () => {} });
    expect(seen).toEqual(shards[1]);
  });
  it('partitions every existing browser entry exactly once and preserves full-suite order', async () => {
    const expected = [
      'browser', 'frontend-lifecycle', 'release-update', 'chat-bottom-control', 'chat-list-viewport', 'message-timeline', 'desktop-privacy', 'desktop-session-flow',
      'vault-resume', 'system-surfaces', 'file-flow', 'file-outbox', 'file-interactions', 'document-reader', 'meme-picker',
      'unread-counter', 'reaction-history', 'message-deletion', 'vault-lifecycle', 'voice-lifecycle', 'voice-submission',
      'cloud-backup-lifecycle', 'backup-admin-ui',
      'chat-image-privacy', 'gallery-loading', 'photo-details', 'video-flow', 'voice-gestures', 'chat-tools', 'presence-circuit',
    ].map(name => `tests/${name}.e2e.mjs`);
    const all = selectBrowserScripts();
    expect(all).toEqual(expected);
    expect([...selectBrowserScripts('1'), ...selectBrowserScripts('2')]).toEqual(all);
    expect(new Set(all).size).toBe(30);
    expect(Object.keys(browserGroups)).toEqual(['1', '2']);
    expect(selectBrowserScripts('1')).toEqual(['tests/browser.e2e.mjs']);
    const main = await readFile(path.join(root, 'tests/browser.e2e.mjs'), 'utf8');
    expect(main).toContain("from './voice-flow.e2e.mjs'");
    expect(main).toContain("from './call-flow.e2e.mjs'");
    expect(main).toContain('await verifyVoiceFlow(');
    expect(main).toContain('await verifyCallFlow(');
  });

  it('includes an existing file for every configured browser entry', () => {
    for (const script of selectBrowserScripts()) expect(existsSync(path.join(root, script))).toBe(true);
  });

  it('accepts the documented list and group forms while rejecting empty, unknown and repeated arguments', () => {
    expect(parseBrowserArguments([])).toEqual({ group: undefined, list: false });
    expect(parseBrowserArguments(['--list'])).toEqual({ group: undefined, list: true });
    expect(parseBrowserArguments(['--group', '1', '--list'])).toEqual({ group: '1', list: true });
    expect(parseBrowserArguments(['--list', '--group', '2'])).toEqual({ group: '2', list: true });
    for (const args of [['--group'], ['--group', ''], ['--group', '0'], ['--group', '3'],
      ['--group', '01'], ['--group=1'], ['--groups', '1'], ['--list', '--list'],
      ['--group', '1', '--group', '2'], ['tests/browser.e2e.mjs']]) {
      expect(() => parseBrowserArguments(args)).toThrow();
    }
    for (const group of ['', '0', '3', 'constructor', '__proto__', null]) {
      expect(() => selectBrowserScripts(group)).toThrow();
    }
  });

  it('executes the full local suite sequentially and records every script and the total duration', async () => {
    const seen: string[] = [];
    const log = vi.fn();
    let active = 0;
    let clock = 0;
    await runBrowserTests({ log, now: () => clock, run: async (script: string) => {
      expect(active++).toBe(0);
      await Promise.resolve();
      seen.push(script);
      clock += 100;
      active--;
    } });
    expect(seen).toEqual(selectBrowserScripts());
    expect(log.mock.calls.filter(([line]) => line.startsWith('[browser] PASS'))).toHaveLength(30);
    expect(log).toHaveBeenLastCalledWith('[browser] TOTAL 3.00s; 30 passed, 0 failed, 0 not run.');
  });

  it('stops a failing group, preserves its failure and explicitly reports scripts that did not run', async () => {
    const failure = Object.assign(new Error('Synthetic failure'), { exitCode: 7 });
    const run = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const log = vi.fn();
    await expect(runBrowserTests({ group: '2', run, log, now: () => 0 })).rejects.toBe(failure);
    expect(run.mock.calls.map(([script]) => script)).toEqual(selectBrowserScripts('2').slice(0, 2));
    expect(log).toHaveBeenLastCalledWith('[browser] TOTAL 0.00s; 1 passed, 1 failed, 27 not run.');
  });

  it('does not start another script after cancellation', async () => {
    const controller = new AbortController();
    const run = vi.fn().mockImplementation(async () => { controller.abort('SIGINT'); });
    await expect(runBrowserTests({ signal: controller.signal, run, log: () => {} })).rejects.toMatchObject({ exitCode: 130 });
    expect(run).toHaveBeenCalledOnce();
  });

  it('preserves native/view call checks in the full call entry while allowing CI to avoid duplicate unit tests', async () => {
    const { scripts } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(scripts['test:calls:e2e']).toBe('node tests/call-native.e2e.mjs && node tests/call-view.e2e.mjs');
    for (const name of ['crypto', 'membership', 'controller', 'server']) {
      expect(scripts['test:calls']).toContain(`tests/call-${name}.test.ts`);
    }
    expect(scripts['test:calls']).toContain('&& npm run test:calls:e2e');
    expect(scripts['test:browser']).toBe('node scripts/test-browser.mjs');
  });
});

describe('browser child process lifecycle', () => {
  async function fixture(source: string) {
    const directory = await mkdtemp(path.join(tmpdir(), 'quiet-browser-runner-'));
    directories.push(directory);
    await writeFile(path.join(directory, 'fixture.mjs'), source);
    return directory;
  }

  it('executes the CLI through an aliased checkout path instead of silently succeeding', async () => {
    const directory = await fixture('');
    const alias = path.join(directory, 'checkout');
    await symlink(root, alias, 'dir');
    const result = spawnSync(process.execPath, [path.join(alias, 'scripts/test-browser.mjs'), '--group', '1', '--list'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('tests/browser.e2e.mjs');
    const invalid = spawnSync(process.execPath, [path.join(alias, 'scripts/test-browser.mjs'), '--group', 'invalid'], { encoding: 'utf8' });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('Browser group must be 1 or 2.');
  });

  it('returns a failed process exit code and rejects startup failures', async () => {
    const cwd = await fixture('process.exitCode = 7;');
    await expect(runBrowserScript('fixture.mjs', { cwd })).rejects.toMatchObject({ exitCode: 7 });
    await expect(runBrowserScript('fixture.mjs', { cwd: path.join(cwd, 'missing') })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('terminates the active script on cancellation and rejects with a nonzero interruption status', async () => {
    const cwd = await fixture("import { writeFileSync } from 'node:fs'; writeFileSync('ready', String(process.pid)); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const result = runBrowserScript('fixture.mjs', { cwd, signal: controller.signal }).then(
      () => ({ exitCode: 0 }), (error: Error & { exitCode: number }) => error,
    );
    try {
      await vi.waitFor(() => expect(existsSync(path.join(cwd, 'ready'))).toBe(true));
      const pid = Number(await readFile(path.join(cwd, 'ready'), 'utf8'));
      controller.abort('SIGTERM');
      expect(await result).toMatchObject({ exitCode: 143 });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort('SIGTERM');
      await result;
    }
  });
});
