import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Operational Node script has no TS declarations.
import { checkDocumentation } from '../scripts/check-docs.mjs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(source: string, target = '# Target\n\n## 中文标题\n\n## Repeat\n\n## Repeat\n') {
  const cwd = mkdtempSync(path.join(tmpdir(), 'quiet-room-ci-docs-'));
  directories.push(cwd);
  mkdirSync(path.join(cwd, 'docs'));
  writeFileSync(path.join(cwd, 'RELEASING.md'), source);
  writeFileSync(path.join(cwd, 'docs/target.md'), target);
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['add', '.'], { cwd });
  return { cwd, files: ['RELEASING.md'] };
}

describe('lightweight documentation checks', () => {
  it('checks relative files, Chinese and duplicate heading anchors without fetching remote pages', () => {
    const options = fixture('# Release\n\n[Target](docs/target.md#中文标题) [Duplicate](docs/target.md#repeat-1)\n[External](https://example.invalid/unreachable)\n\n[ref]: docs/target.md#target\n');
    expect(checkDocumentation(options)).toEqual({ checked: 1, issues: [] });
  });

  it('reports broken links and heading anchors', () => {
    const options = fixture('# Release\n\n[Missing](docs/missing.md) [Anchor](docs/target.md#missing)\n');
    expect(checkDocumentation(options).issues).toHaveLength(2);
  });

  it('continues checking inbound links after an allowlisted document has been deleted', () => {
    const options = fixture('# Release\n\n[Target](docs/target.md)\n');
    execFileSync('git', ['rm', '-f', 'docs/target.md'], { cwd: options.cwd });
    expect(checkDocumentation(options).issues[0]).toContain('target is missing');
  });

  it('rejects links outside the repository and untracked targets', () => {
    const options = fixture('# Release\n\n[Outside](../outside.md) [Absolute](/etc/passwd) [Untracked](docs/untracked.md)\n');
    writeFileSync(path.join(options.cwd, 'docs/untracked.md'), '# Untracked\n');
    expect(checkDocumentation(options).issues).toHaveLength(3);
  });

  it('does not follow documentation symlinks', () => {
    const options = fixture('# Release\n');
    rmSync(path.join(options.cwd, 'RELEASING.md'));
    symlinkSync('docs/target.md', path.join(options.cwd, 'RELEASING.md'));
    execFileSync('git', ['add', 'RELEASING.md'], { cwd: options.cwd });
    expect(checkDocumentation(options).issues[0]).toContain('not a regular');
  });

  it('rejects unfinished fences, merge markers and malformed text', () => {
    for (const source of ['# No final newline', '# CRLF\r\n', '# Bad \u0000 text\n', '# Release\n\n```sh\nunclosed\n', '# Release\n<<<<<<< branch\nconflict\n=======\nother\n>>>>>>> branch\n']) {
      expect(checkDocumentation(fixture(source)).issues.length).toBeGreaterThan(0);
    }
  });

  it('ignores example links in fenced code blocks', () => {
    const options = fixture('# Release\n\n```md\n[Example](does-not-exist.md)\n```\n');
    expect(checkDocumentation(options).issues).toEqual([]);
  });
});


describe('CI helper command entry points', () => {
  it('executes documentation and manual full verification through a directory alias', () => {
    const options = fixture('# Release\n');
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    mkdirSync(path.join(options.cwd, 'scripts'));
    for (const script of ['ci-scope.mjs', 'check-docs.mjs']) {
      copyFileSync(path.join(sourceRoot, 'scripts', script), path.join(options.cwd, 'scripts', script));
    }
    const aliasDirectory = mkdtempSync(path.join(tmpdir(), 'quiet-room-ci-alias-'));
    directories.push(aliasDirectory);
    const alias = path.join(aliasDirectory, 'checkout');
    symlinkSync(options.cwd, alias, 'dir');
    const output = path.join(options.cwd, 'scope-output');
    const env = { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output };
    const docs = execFileSync(process.execPath, [path.join(alias, 'scripts/check-docs.mjs')], { cwd: options.cwd, env, encoding: 'utf8' });
    expect(docs).toContain('Documentation checks passed (1 files;');
    const scope = execFileSync(process.execPath, [path.join(alias, 'scripts/ci-scope.mjs')], { cwd: options.cwd, env, encoding: 'utf8' });
    expect(scope).toContain('CI scope: full. Manual verification always runs the complete suite.');
    expect(readFileSync(output, 'utf8')).toBe('mode=full\n');
  });
});
