import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { artifactProbe, discoverPublicArtifacts, evidenceDirectory, parseReadbackArgs, ReadbackError, runReadback, saveEvidence, stateProbe, validateServerState } from '../scripts/production-readback.mjs';

const sha = 'a'.repeat(40);
const image = `sha256:${'b'.repeat(64)}`;
const state = {
  currentSha: sha, deployedAt: '20260906T010203Z', release: `/opt/quiet-room/git-releases/20260906T010203Z-${sha.slice(0, 12)}`,
  maintenance: 'absent', adminEnabled: '0', callsEnabled: '0', targetImageId: image,
  appRunning: 'true', appHealth: 'healthy', appImageId: image, appImageRef: `quiet-room-app:${sha}`,
  backupRunning: 'true', backupHealth: 'none', backupImageId: image, backupImageRef: `quiet-room-app:${sha}`,
  turnRunning: 'absent', turnHealth: 'absent',
};

describe('independent production readback', () => {
  it('writes independent receipts in a real linked worktree without treating .git as a directory', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-readback-worktree-'));
    const linked = path.join(directory, 'linked');
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      git('init');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
      git('worktree', 'add', '--detach', linked);
      expect(statSync(path.join(linked, '.git')).isFile()).toBe(true);
      const primaryDirectory = evidenceDirectory(directory);
      const linkedDirectory = evidenceDirectory(linked);
      expect(linkedDirectory).not.toBe(primaryDirectory);
      const receipt = saveEvidence({ startedAt: '2026-09-10T00:00:00Z', expectedSha: sha, status: 'success' }, linkedDirectory);
      expect(JSON.parse(readFileSync(receipt, 'utf8')).expectedSha).toBe(sha);
      expect(statSync(receipt).mode & 0o777).toBe(0o600);
      expect(() => evidenceDirectory(tmpdir())).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('requires one exact expected SHA and never accepts latest or release flags', () => {
    expect(parseReadbackArgs(['--sha', sha])).toBe(sha);
    for (const args of [[], ['--sha', 'main'], ['--yes'], ['--sha', sha, '--retry-deploy']]) expect(() => parseReadbackArgs(args)).toThrow();
  });

  it('is a standalone read-only entry and never invokes the cutover helper', () => {
    const source = readFileSync(new URL('../scripts/production-readback.mjs', import.meta.url), 'utf8');
    expect(source).not.toContain('/usr/local/sbin/quiet-room-deploy');
    expect(source).not.toContain('publish.mjs');
    expect(source).not.toContain('docker compose');
    for (const probe of [stateProbe, artifactProbe]) {
      const syntax = spawnSync('/bin/sh', ['-n'], { encoding: 'utf8', input: probe });
      expect(syntax.stderr).toBe('');
      expect(syntax.status).toBe(0);
    }
  });

  it('keeps running, health and immutable image identity as separate assertions', () => {
    expect(validateServerState(state, sha)).toBe(state);
    for (const change of [
      { maintenance: 'present' }, { currentSha: 'c'.repeat(40) }, { appRunning: 'false' },
      { appHealth: 'none' }, { backupHealth: 'unhealthy' }, { appImageId: `sha256:${'c'.repeat(64)}` },
      { appImageRef: 'quiet-room-app:production' }, { adminEnabled: 'missing' }, { turnRunning: 'true' },
    ]) expect(() => validateServerState({ ...state, ...change }, sha)).toThrow(ReadbackError);
    expect(validateServerState({ ...state, callsEnabled: '1', turnRunning: 'true', turnHealth: 'none' }, sha)).toBeTruthy();
  });

  it('discovers only versioned same-origin build assets and always includes the service worker', () => {
    const html = new TextEncoder().encode('<link href="/assets/app-a.css"><script src="/assets/app-b.js"></script><img src="https://else.invalid/x">');
    expect(discoverPublicArtifacts(html)).toEqual(['/sw.js', '/assets/app-a.css', '/assets/app-b.js']);
    expect(() => discoverPublicArtifacts(new TextEncoder().encode('<h1>no build assets</h1>'))).toThrow('versioned asset');
    expect(() => discoverPublicArtifacts(new TextEncoder().encode('<script src="/assets/../../server/index.mjs"></script>'))).toThrow('versioned asset');
  });

  it('runs every independent stage, records timings, and writes a private structured receipt', async () => {
    const calls: string[] = [];
    const operations = {
      inspectState: () => { calls.push('server'); return state; },
      inspectHealth: () => { calls.push('health'); return { ok: true, database: true, storage: true }; },
      inspectPublicArtifacts: () => { calls.push('public'); return { '/': '1', '/sw.js': '2', '/assets/app.js': '3' }; },
      inspectContainerArtifacts: () => { calls.push('container'); return { matched: true, hashes: { '/': '1', '/sw.js': '2', '/assets/app.js': '3' } }; },
      probeWebSocket: () => { calls.push('websocket'); },
    };
    const logs: string[] = [];
    let ticks = 0n;
    const evidence = await runReadback(sha, operations, line => logs.push(line), () => ticks += 1_000_000n);
    expect(calls).toEqual(['server', 'health', 'public', 'container', 'websocket']);
    expect(evidence.status).toBe('success');
    expect(logs.filter(line => line.includes('phase=') && line.includes('result=success'))).toHaveLength(7);
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-readback-test-'));
    try {
      const receipt = saveEvidence(evidence, directory);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ schemaVersion: 1, mode: 'read-only', expectedSha: sha, status: 'success' });
      expect(statSync(receipt).mode & 0o777).toBe(0o600);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('stops at the failed phase with a stable category and remains safe to rerun', async () => {
    let publicCalls = 0;
    const operations = {
      inspectState: () => state,
      inspectHealth: () => { throw new Error('synthetic outage details'); },
      inspectPublicArtifacts: () => { publicCalls++; return {}; },
      inspectContainerArtifacts: () => ({}), probeWebSocket: () => {},
    };
    const logs: string[] = [];
    const attempt = () => runReadback(sha, operations, line => logs.push(line));
    await expect(attempt()).rejects.toMatchObject({ classification: 'public-health', phase: 'https-health', evidence: { status: 'failure' } });
    await expect(attempt()).rejects.toMatchObject({ classification: 'public-health', phase: 'https-health' });
    expect(publicCalls).toBe(0);
    expect(logs.join('\n')).not.toContain('synthetic outage details');
  });

  function readinessFixture(samples: any[]) {
    let elapsed = 0;
    const waits: number[] = [], calls: string[] = [];
    let index = 0;
    return {
      waits, calls, clock: () => BigInt(elapsed) * 1_000_000n,
      operations: {
        inspectState: () => { calls.push('state'); const sample = samples[Math.min(index++, samples.length - 1)]; if (sample instanceof Error) throw sample; return sample; },
        pause: async (ms: number) => { waits.push(ms); elapsed += ms; },
        inspectHealth: () => { calls.push('health'); return { ok: true, database: true, storage: true }; },
        inspectPublicArtifacts: () => { calls.push('public'); return { '/': '1' }; },
        inspectContainerArtifacts: () => { calls.push('container'); return { matched: true }; },
        probeWebSocket: () => { calls.push('websocket'); },
      },
    };
  }
  it('waits only for a healthy-identity starting backup, then runs every independent check', async () => {
    const f = readinessFixture([{ ...state, backupHealth: 'starting' }, { ...state, backupHealth: 'starting' }, { ...state, backupHealth: 'healthy' }]);
    const result = await runReadback(sha, f.operations, () => {}, f.clock);
    expect(f.waits).toEqual([10_000, 10_000]);
    expect(result.readiness).toEqual({ polls: 2, budgetMs: 360_000 });
    expect(result.server.backupHealth).toBe('healthy');
    expect(result.status).toBe('success');
    expect(f.calls).toEqual(['state', 'state', 'state', 'health', 'public', 'container', 'websocket']);
    expect(result.phases.find((p: any) => p.name === 'backup-readiness').durationMs).toBe(20_000);
  });
  it.each([
    { backupHealth: 'unhealthy' }, { backupHealth: 'none' }, { backupRunning: 'false' },
    { appHealth: 'unhealthy' }, { currentSha: 'c'.repeat(40) }, { maintenance: 'present' },
    { backupImageId: `sha256:${'c'.repeat(64)}` }, { adminEnabled: '1' },
    { callsEnabled: '1', turnRunning: 'true', turnHealth: 'none' },
    { deployedAt: '20260906T020304Z', release: `/opt/quiet-room/git-releases/20260906T020304Z-${sha.slice(0, 12)}` },
  ])('stops immediately when a waiting deployment changes or becomes invalid: %j', async change => {
    const pending = { ...state, backupHealth: 'starting' };
    const f = readinessFixture([pending, { ...pending, ...change }]);
    await expect(runReadback(sha, f.operations, () => {}, f.clock)).rejects.toBeInstanceOf(ReadbackError);
    expect(f.waits).toEqual([10_000]);
    expect(f.calls).toEqual(['state', 'state']);
  });
  it('bounds startup waits, preserves a failure receipt and never runs later checks after timeout', async () => {
    const f = readinessFixture([{ ...state, backupHealth: 'starting' }]);
    await expect(runReadback(sha, f.operations, () => {}, f.clock, { waitReadyMs: 15_000 })).rejects.toMatchObject({
      classification: 'container-startup-timeout', phase: 'backup-readiness', evidence: { status: 'failure', server: { backupHealth: 'starting' }, readiness: { polls: 2 } },
    });
    expect(f.waits).toEqual([10_000, 5_000]);
    expect(f.calls).toEqual(['state', 'state', 'state']);
  });
  it('does not retry a connectivity failure or wait when the first sample is already invalid', async () => {
    const f = readinessFixture([{ ...state, backupHealth: 'starting' }, new ReadbackError('connectivity', 'server-state', 'private diagnostic')]);
    await expect(runReadback(sha, f.operations, () => {}, f.clock)).rejects.toMatchObject({ classification: 'connectivity' });
    expect(f.waits).toEqual([10_000]);
    const invalid = readinessFixture([{ ...state, backupHealth: 'starting', appImageRef: 'unexpected' }]);
    await expect(runReadback(sha, invalid.operations, () => {}, invalid.clock)).rejects.toMatchObject({ classification: 'image-mismatch' });
    expect(invalid.waits).toEqual([]);
  });
  it('does not accept a healthy sample arriving after the wait deadline', async () => {
    const f = readinessFixture([{ ...state, backupHealth: 'starting' }, { ...state, backupHealth: 'healthy' }]);
    const originalPause = f.operations.pause;
    f.operations.pause = (ms: number) => originalPause(ms + 10_000);
    await expect(runReadback(sha, f.operations, () => {}, f.clock, { waitReadyMs: 15_000 }))
      .rejects.toMatchObject({ classification: 'container-startup-timeout', evidence: { status: 'failure' } });
    expect(f.calls).toEqual(['state', 'state']);
  });
});
