import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isMainModule } from './release-runtime.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export function nextRelease(current, history, notes, now = new Date()) {
  const entries = [current, ...history];
  if (!Array.isArray(history) || entries.some(entry => !entry || typeof entry.id !== 'string'
    || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(entry.id) || typeof entry.title !== 'string' || !entry.title.trim()
    || !Array.isArray(entry.notes) || !entry.notes.length || entry.notes.some(note => typeof note !== 'string' || !note.trim()))
    || entries.some(entry => entry.createdAt !== undefined && (typeof entry.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(entry.createdAt) || !Number.isFinite(Date.parse(entry.createdAt))))
    || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Invalid release history.');
  if (!Array.isArray(notes) || !notes.length || notes.length > 50 || notes.some(note => typeof note !== 'string' || !note.trim() || note.length > 500)) throw new Error('Expected 1–50 release notes.');
  const day = now.toISOString().slice(0, 10).replaceAll('-', '.');
  let number = 1;
  for (const entry of entries) if (entry.id.startsWith(`${day}.`)) {
    const suffix = entry.id.slice(day.length + 1);
    if (/^\d+$/.test(suffix)) number = Math.max(number, Number(suffix) + 1);
  }
  if (!Number.isSafeInteger(number)) throw new Error('Invalid release sequence.');
  return { release: { id: `${day}.${number}`, createdAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), title: current.title, notes: [...new Set(notes.map(note => note.trim()))] }, history: [...history, current] };
}

// Explicit expected HEAD and source digest prevent silently replacing another batch.
// A recovery journal makes interrupted two-file writes resumable with the same plan.
export function prepareRelease(args, root = process.cwd()) {
  if (args.length !== 4 || args[0] !== '--base' || !/^[a-f0-9]{40}$/.test(args[1]) || !['--notes', '--apply'].includes(args[2])) throw new Error('Usage: release:prepare -- --base <HEAD> --notes <JSON-array-file> | --apply <printed-plan>');
  const git = (...values) => execFileSync('git', values, { cwd: root, encoding: 'utf8' }).trim();
  if (git('rev-parse', 'HEAD') !== args[1] || ! /^(codex|fix|docs)\//.test(git('branch', '--show-current'))) throw new Error('Use the expected task HEAD, never main.');
  const dir = path.join(git('rev-parse', '--absolute-git-dir'), 'quiet-room-release-plan');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'lock'); mkdirSync(lock);
  try {
    const paths = ['release.json', 'release-history.json'].map(name => path.join(root, name));
    const original = paths.map(file => readFileSync(file, 'utf8'));
    if (args[2] === '--notes') {
      const result = nextRelease(JSON.parse(original[0]), JSON.parse(original[1]), JSON.parse(readFileSync(args[3], 'utf8')));
      const plan = { version: 1, base: args[1], before: original.map(digest), after: [result.release, result.history].map(value => JSON.stringify(value, null, 2) + '\n') };
      const file = path.join(dir, `${digest(JSON.stringify(plan))}.json`);
      writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
      console.log(`RELEASE_PLAN id=${result.release.id} file=${JSON.stringify(file)}`);
      return plan;
    }
    const planFile = realpathSync(args[3]);
    if (path.dirname(planFile) !== dir) throw new Error('Use a plan generated in this worktree.');
    const plan = JSON.parse(readFileSync(planFile, 'utf8'));
    if (plan.version !== 1 || plan.base !== args[1] || !Array.isArray(plan.after) || plan.after.length !== 2
      || !Array.isArray(plan.before) || plan.before.length !== 2 || path.basename(planFile) !== `${digest(JSON.stringify(plan))}.json`) throw new Error('Invalid plan.');
    if (original.some((value, i) => digest(value) !== plan.before[i] && value !== plan.after[i])) throw new Error('Release files changed; review and generate a new plan.');
    for (let i = 0; i < paths.length; i++) {
      const temp = `${paths[i]}.prepare-tmp`;
      writeFileSync(temp, plan.after[i], { flag: 'wx' }); renameSync(temp, paths[i]);
    }
    console.log(`RELEASE_PREPARED id=${JSON.parse(plan.after[0]).id}`);
    return plan;
  } finally { rmSync(lock, { recursive: true }); }
}
if (isMainModule(import.meta.url)) {
  try { prepareRelease(process.argv.slice(2)); }
  catch (error) { console.error(`RELEASE_PREPARE_BLOCKED: ${error.message}`); process.exitCode = 1; }
}
