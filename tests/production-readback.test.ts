import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { artifactProbe, discoverPublicArtifacts, parseReadbackArgs, ReadbackError, runReadback, saveEvidence, stateProbe, validateServerState } from '../scripts/production-readback.mjs';

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
});
