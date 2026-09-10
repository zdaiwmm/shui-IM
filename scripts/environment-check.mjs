import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// No installs, authentication changes, network probes or production calls.
const cwd = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'docs';
if (!['docs', 'test', 'browser', 'delivery'].includes(mode) || process.argv.length > 3) {
  console.error('Usage: node scripts/environment-check.mjs [docs|test|browser|delivery]');
  process.exit(64);
}
let failed = false;
function report(name, ok, remedy = '') {
  console.log(`${ok ? 'OK' : 'MISSING'} ${name}${!ok && remedy ? `: ${remedy}` : ''}`);
  failed ||= !ok;
}
function command(name, args) {
  const result = spawnSync(name, args, { cwd, encoding: 'utf8', timeout: 30000 });
  return !result.error && result.status === 0;
}
report('Node >=24', Number(process.versions.node.split('.')[0]) >= 24, 'Use the project Node version');
report('Git checkout', command('git', ['rev-parse', '--absolute-git-dir']), 'Check checkout and Git availability');
if (['test', 'browser'].includes(mode)) {
  report('locked dependency tree', command('npm', ['ls', '--depth=0']), 'Run npm ci --prefer-offline in this task tree');
  for (const name of ['tsc', 'vite', 'vitest']) {
    report(`${name} command`, existsSync(`${cwd}node_modules/.bin/${name}`), 'Wait for npm ci to finish successfully');
  }
}
if (mode === 'browser') {
  try {
    const { chromium, webkit } = await import('playwright');
    for (const [name, browser] of Object.entries({ chromium, webkit })) {
      report(`${name} executable`, existsSync(browser.executablePath()), `Install the required Playwright ${name} browser`);
    }
  } catch { report('Playwright module', false, 'Prepare task dependencies'); }
}
if (mode === 'delivery') {
  report('GitHub CLI', command('gh', ['--version']), 'Install GitHub CLI');
  report('SSH', command('ssh', ['-V']), 'Install SSH client');
}
console.log('Scope: local availability only; write permissions, browser launch, authentication, CI and production readiness require stage-specific checks.');
process.exitCode = failed ? 1 : 0;
