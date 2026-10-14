import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational script.
import { verifyCloudReceipt } from '../scripts/cloud-dispatch.mjs';
// @ts-expect-error Operational script.
import { cloudAPI, cloudErrorCode, invocationResult, parsePreflight, production, requireAncestor } from '../scripts/cloud-publish.mjs';
const sha = 'a'.repeat(40);
describe('protected cloud delivery boundaries', () => {
  it('disables cloud SDK retries and never repeats a failed submission', () => {
    let calls = 0;
    expect(() => cloudAPI('RunCommand', { CommandContent: 'synthetic' }, (_program: string, args: string[]) => {
      calls++;
      expect(args[args.indexOf('--retry-count') + 1]).toBe('0');
      expect(args).toContain('--secure');
      expect(args[args.indexOf('--region') + 1]).toBe(production.region);
      expect(args).not.toContain('--api-version');
      expect(args).not.toContain('--version');
      throw new Error('connection lost after submit');
    })).toThrow('connection lost');
    expect(calls).toBe(1);
  });
  it('reports only allowlisted CLI diagnostics or bounded service codes', () => {
    expect(cloudErrorCode("ERROR: region can't be empty")).toBe('CLI_REGION_MISSING');
    expect(cloudErrorCode('ERROR: unchecked version 2020-06-01')).toBe('CLI_API_VERSION_UNAVAILABLE');
    expect(cloudErrorCode('{"Code": "Forbidden.RAM", "Message": "private command"}')).toBe('Forbidden.RAM');
    expect(cloudErrorCode('private signed URL and command payload')).toBe('unavailable');
  });
  it('accepts only a verified forward ancestor', () => {
    expect(() => requireAncestor({ status: 'ahead', merge_base_commit: { sha } }, sha)).not.toThrow();
    for (const status of ['behind', 'diverged', 'unknown']) expect(() => requireAncestor({ status, merge_base_commit: { sha } }, sha)).toThrow();
    expect(() => requireAncestor({ status: 'ahead', merge_base_commit: { sha: 'b'.repeat(40) } }, sha)).toThrow();
  });
  it('binds cloud completion to invocation, machine, user, exit and complete output', () => {
    const result = { InvokeId: 't-one', InstanceId: production.instance, InvokeUser: 'admin', InvocationStatus: 'Success', ExitCode: 0, Output: Buffer.from('ok').toString('base64') };
    expect(invocationResult({ InvocationResult: result }, 't-one')).toBe('ok');
    expect(invocationResult({ InvocationResult: { ...result, InvocationStatus: 'Running' } }, 't-one')).toBeNull();
    for (const change of [{ InvokeId: 't-other' }, { InstanceId: 'other' }, { InvokeUser: 'root' }, { ExitCode: 1 }, { InvocationStatus: 'Timeout' }, { Output: 'x'.repeat(24000) }]) {
      expect(() => invocationResult({ InvocationResult: { ...result, ...change } }, 't-one')).toThrow();
    }
  });
  it('decodes API Base64 before parsing preflight and exact deployment markers', () => {
    const output = JSON.stringify({ imageProtocol: 1, expectedPreviousProtocol: 1, publicOrigin: production.origin }) + '\nLIVE_SHA=' + sha + '\n';
    const result = { InvokeId: 't-one', InstanceId: production.instance, InvokeUser: 'admin', InvocationStatus: 'Success', ExitCode: 0, Output: Buffer.from(output).toString('base64') };
    expect(parsePreflight(invocationResult({ InvocationResult: result }, 't-one'))).toBe(sha);
    const receipt = `DEPLOY_OK sha=${sha} result=success\nSTREAM_VERIFIED sha=${sha} image=sha256:synthetic\n`;
    expect(invocationResult({ InvocationResult: { ...result, Output: Buffer.from(receipt).toString('base64') } }, 't-one')).toBe(receipt);
    for (const Output of ['ok', 'b2s', 'b2s=\n', 'b2s=!', 'b2t=', '/w==', Buffer.alloc(18000).toString('base64')]) {
      expect(() => invocationResult({ InvocationResult: { ...result, Output } }, 't-one')).toThrow();
    }
  });
  it('requires origin and installed compare-and-set protocol before upload', () => {
    const descriptor = { imageProtocol: 1, expectedPreviousProtocol: 1, publicOrigin: production.origin };
    const output = (value: unknown, live = sha) => JSON.stringify(value) + '\nLIVE_SHA=' + live;
    expect(parsePreflight(output(descriptor))).toBe(sha);
    for (const value of [{ ...descriptor, expectedPreviousProtocol: undefined }, { ...descriptor, publicOrigin: 'https://other.example' }]) expect(() => parsePreflight(output(value))).toThrow();
    expect(() => parsePreflight(output(descriptor, 'bad'))).toThrow();
  });
  it('rejects stale, unverified and other-workflow receipts', () => {
    const workflow = { databaseId: 42, headSha: 'b'.repeat(40) };
    const receipt = { version: 1, sha, status: 'DEPLOY_VERIFIED', workflowRun: '42', workflowSha: workflow.headSha, manifest: { sha } };
    expect(() => verifyCloudReceipt(receipt, sha, workflow)).not.toThrow();
    for (const change of [{ sha: 'c'.repeat(40) }, { workflowRun: '41' }, { status: 'ALREADY_DEPLOYED_READBACK_REQUIRED', previousSha: 'b'.repeat(40) }, { manifest: {} }]) expect(() => verifyCloudReceipt({ ...receipt, ...change }, sha, workflow)).toThrow();
  });
  it.each(['same', 'changed', 'missing'])('runs the installed helper state guard before import (%s)', mode => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quiet-cloud-cas-'));
    try {
      const previous = 'b'.repeat(40);
      if (mode !== 'missing') writeFileSync(path.join(directory, 'current-sha'), mode === 'same' ? previous : 'c'.repeat(40));
      const source = readFileSync('deploy/server/quiet-room-deploy', 'utf8');
      const guard = source.slice(source.indexOf('if [[ -n "$EXPECTED_PREVIOUS_SHA" ]]'), source.indexOf('for required in docker'));
      const result = spawnSync('bash', ['-c', `set -eu\nSTATE_DIR="$1"; EXPECTED_PREVIOUS_SHA="$2"; REQUESTED_SHA="$3"\n${guard}\nprintf IMPORT_REACHED`, 'test', directory, previous, sha], { encoding: 'utf8' });
      expect(result.status).toBe(mode === 'same' ? 0 : 75);
      expect(result.stdout.includes('IMPORT_REACHED')).toBe(mode === 'same');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('streams stored/deflated ZIPs and rejects corrupted/truncated/oversized transfers without writing archives', () => {
    const result = spawnSync('python3', ['tests/server-image-stream.test.py'], { encoding: 'utf8', timeout: 30000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SERVER_STREAM_TESTS_OK');
  });
});
