import { describe, expect, it } from 'vitest';
// @ts-expect-error Operational Node script intentionally has no TS declarations.
import { isCanonicalRemote, parseRemoteHead, validateBranch } from '../scripts/repo.mjs';

describe('fixed GitHub repository workflow', () => {
  it('accepts only the canonical HTTPS or SSH origin', () => {
    expect(isCanonicalRemote('https://github.com/zdaiwmm/shui-IM.git')).toBe(true);
    expect(isCanonicalRemote('git@github.com:zdaiwmm/shui-IM.git')).toBe(true);
    expect(isCanonicalRemote('https://github.com/other/repo.git')).toBe(false);
  });

  it('rejects unsafe branch names and verifies remote heads', () => {
    expect(validateBranch('codex/fix-thing')).toBe('codex/fix-thing');
    for (const branch of ['../main', '-bad', 'bad..name', 'bad@{x}', 'bad/']) expect(() => validateBranch(branch)).toThrow();
    expect(parseRemoteHead(`${'a'.repeat(40)}\trefs/heads/codex/fix-thing\n`, 'codex/fix-thing')).toBe('a'.repeat(40));
    expect(() => parseRemoteHead('not-a-head\trefs/heads/main\n', 'main')).toThrow();
  });
});
