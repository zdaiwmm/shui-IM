import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Only operational notes and the four existing context pages may take the fast
// path. New paths and product/security contracts require application coverage.
export const lightweightDocs = Object.freeze([
  'RELEASING.md',
  'docs/context/status.md',
  'docs/context/overview.md',
  'docs/context/decisions.md',
  'docs/context/maintenance.md',
]);
const docPaths = new Set(lightweightDocs);
const root = fileURLToPath(new URL('../', import.meta.url));
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);
const complete = reason => ({ mode: 'full', reason });

export function parseChangedPaths(output) {
  if (typeof output !== 'string' || !output.endsWith('\0')) throw new Error('Missing complete diff output.');
  const fields = output.slice(0, -1).split('\0');
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const count = /^(R|C)(100|[1-9]?\d)$/.test(status) ? 2 : /^[AMD]$/.test(status) ? 1 : 0;
    if (!count || index + count > fields.length) throw new Error('Unknown or incomplete diff status.');
    for (let field = 0; field < count; field++) {
      const changedPath = fields[index++];
      if (!changedPath || changedPath.startsWith('/') || changedPath.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('Invalid changed path.');
      }
      paths.push(changedPath);
    }
  }
  return [...new Set(paths)];
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) throw new Error('Git comparison unavailable.');
  return result.stdout;
}

export function determineScope({ eventName, event, runGit = git }) {
  if (eventName === 'workflow_dispatch') return complete('Manual verification always runs the complete suite.');
  if (!['pull_request', 'push'].includes(eventName)) return complete('Unknown event requires the complete suite.');
  try {
    const head = runGit(['rev-parse', '--verify', 'HEAD']).trim();
    if (!validSha(head)) return complete('Checkout identity is unavailable.');
    let range;
    if (eventName === 'pull_request') {
      const base = event?.pull_request?.base?.sha;
      const proposed = event?.pull_request?.head?.sha;
      if (!validSha(base) || !validSha(proposed)) return complete('Pull request comparison is unavailable.');
      // The normal PR checkout is GitHub's merge commit. Ensure it contains the
      // event's proposed head before comparing the complete PR against its base.
      runGit(['merge-base', '--is-ancestor', proposed, head]);
      runGit(['merge-base', base, head]);
      range = `${base}...${head}`;
    } else {
      const base = event?.before;
      if (event?.ref !== 'refs/heads/main' || !validSha(base) || event?.after !== head || event?.forced || event?.deleted) {
        return complete('Push comparison is unavailable or history changed.');
      }
      runGit(['merge-base', '--is-ancestor', base, head]);
      range = `${base}..${head}`;
    }
    const changes = parseChangedPaths(runGit(['diff', '--no-ext-diff', '--name-status', '-z', '--find-renames', range, '--']));
    if (changes.length === 0 || !changes.every(changedPath => docPaths.has(changedPath))) {
      return complete('Changes include application, configuration, or unlisted paths.');
    }
    // A renamed/deleted source is included above; only surviving regular files
    // may be read by the lightweight checker. Symlinks and type changes fail full.
    const tree = runGit(['ls-tree', '-z', head, '--', ...changes]);
    if (tree.split('\0').filter(Boolean).some(entry => !/^100644 blob [a-f0-9]{40}\t/.test(entry))) {
      return complete('Documentation contains a non-regular file.');
    }
    return { mode: 'docs', reason: `Only ${changes.length} allowlisted documentation paths changed.` };
  } catch {
    return complete('Diff or history could not be verified; the complete suite is required.');
  }
}

const sharedJobs = ['scope', 'docs', 'secret_scan'];
const applicationJobs = ['build', 'browser', 'calls', 'audit'];

export function requireVerification(needs, gate = 'verify') {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs) || !['verify', 'full'].includes(gate)) {
    throw new Error('Invalid verification summary.');
  }
  const mode = needs.scope?.outputs?.mode;
  if (!['full', 'docs'].includes(mode)) throw new Error('CI scope is missing or invalid.');
  const required = [...sharedJobs];
  const skipped = [];
  if (mode === 'full') {
    required.push(...applicationJobs);
    if (gate === 'verify') required.push('full_application');
  } else {
    if (gate === 'full') throw new Error('Documentation-only CI is not full application verification.');
    skipped.push(...applicationJobs, 'full_application');
  }
  for (const name of required) {
    if (needs[name]?.result !== 'success') throw new Error(`Required job ${name} did not succeed.`);
  }
  for (const name of skipped) {
    if (needs[name]?.result !== 'skipped') throw new Error(`Documentation-only job ${name} was not skipped as expected.`);
  }
  return mode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      let event;
      try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { event = null; }
      const scope = determineScope({ eventName: process.env.GITHUB_EVENT_NAME, event });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${scope.mode}\n`);
      console.log(`CI scope: ${scope.mode}. ${scope.reason}`);
    } else if (args.length === 2 && args[0] === 'verify' && ['verify', 'full'].includes(args[1])) {
      const mode = requireVerification(JSON.parse(process.env.CI_NEEDS ?? ''), args[1]);
      console.log(`${args[1] === 'full' ? 'Full application verification' : 'CI verification'} passed (${mode}).`);
    } else {
      throw new Error('Invalid CI scope arguments.');
    }
  } catch (error) {
    console.error(`CI_BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
