import { verifySuccessfulCI } from './release-ci.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Explicit operational paths only. Unknown, runtime and security-contract changes stay full.
export const lightweightDocs = Object.freeze([
  'RELEASING.md',
  'AGENTS.md',
  'DEPLOYMENT.md',
  'docs/context/workflow.md',
  'docs/workflows/publish-efficiency.md',
  'docs/requirements/2026-10-14-publish-efficiency/README.md',
  'docs/context/status.md',
  'docs/context/overview.md',
  'docs/context/decisions.md',
  'docs/context/maintenance.md',
]);
export const deliveryScripts = Object.freeze([
  'scripts/publish.mjs', 'scripts/cloud-dispatch.mjs', 'scripts/cloud-publish.mjs',
  'scripts/server-image-stream.py', 'scripts/release.mjs', 'scripts/release-ci.mjs',
  'scripts/release-runtime.mjs', 'scripts/ci-image.mjs', 'scripts/ci-image-retention.mjs',
  'scripts/ci-image-cache.mjs', 'scripts/delivery-evidence.mjs',
  'scripts/deploy-config.mjs', 'scripts/deploy-setup.mjs', 'scripts/deploy-production.sh',
  'scripts/production-readback.mjs', 'scripts/prepare-release.mjs',
  'scripts/ci-scope.mjs', 'scripts/check-docs.mjs', 'scripts/check-delivery.mjs',
]);
export const deliveryTests = Object.freeze([
  'tests/publish.test.ts', 'tests/cloud-publish.test.ts', 'tests/publish-efficiency.test.ts',
  'tests/release.test.ts', 'tests/release-entry.test.ts', 'tests/release-timing.test.ts',
  'tests/ci-image.test.ts', 'tests/ci-image-import.test.ts', 'tests/ci-image-retention.test.ts',
  'tests/deploy-config.test.ts', 'tests/deploy-setup.test.ts', 'tests/deploy-environments.test.ts',
  'tests/deploy-script.test.ts', 'tests/deploy-gate.test.ts', 'tests/deploy-stop.test.ts',
  'tests/deploy-admin.test.ts', 'tests/deploy-calls.test.ts', 'tests/production-readback.test.ts',
  'tests/ci-scope.test.ts', 'tests/ci-docs.test.ts', 'tests/delivery-tools.test.ts',
]);
const docPaths = new Set(lightweightDocs);
export function isOperationalDocument(file) {
  return docPaths.has(file) || /^docs\/requirements\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\/README\.md$/.test(file);
}
const deliveryPaths = new Set([...deliveryScripts, ...deliveryTests,
  'tests/server-image-stream.test.py', '.github/workflows/ci.yml', '.github/workflows/publish.yml']);
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

// Each reviewed profile has a corresponding browser job in ci.yml. Release
// metadata can accompany a profile, but never qualifies an application alone.
const profiles = {
  emoji: ['src/lib/emoji-catalog.json', 'src/lib/emoji-catalog.ts', 'tests/emoji-catalog.test.ts'],
  keyboard: ['src/lib/chat-keyboard-layout.ts', 'tests/chat-keyboard-layout.test.ts'],
};
const releaseNotes = new Set(['release.json', 'release-history.json']);

function focusedProfile(changes, head, runGit) {
  const records = changes.filter(file => isOperationalDocument(file) && file.startsWith('docs/requirements/'));
  const app = changes.filter(file => !isOperationalDocument(file) && !releaseNotes.has(file));
  const profile = Object.keys(profiles).find(key => app.length && app.every(file => profiles[key].includes(file)));
  if (!profile || !records.length) return;
  // Opt in on the frozen tree. A missing assessment, conflict or different
  // profile in any changed requirement keeps the full gate.
  if (records.every(file => {
    const lines = runGit(['show', head + ':' + file]).split('\n').filter(line => line.startsWith('回归专项：'));
    return lines.length === 1 && lines[0] === '回归专项：' + profile;
  })) return profile;
}

export function verifiedBaseline(base, runGit, verify = verifySuccessfulCI) {
  // Skip only operational docs on the first-parent main history. Never inherit
  // coverage through an unchecked tool, runtime change or scoped application.
  for (let depth = 0; depth < 8; depth++) {
    const parent = runGit(['rev-parse', base + '^1']).trim();
    if (!validSha(parent)) throw new Error('Missing baseline parent.');
    const diff = runGit(['diff', '--no-ext-diff', '--name-status', '-z', parent, base, '--']);
    if (!diff) break;
    const paths = parseChangedPaths(diff);
    if (!paths.every(isOperationalDocument)) break;
    for (const revision of [parent, base]) {
      if (!regularPaths(runGit, revision, paths)) throw new Error('Non-regular baseline document.');
    }
    base = parent;
  }
  return verify((program, args) => execFileSync(program, args, {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  }), base, { requireFull: true });
}

function regularPaths(runGit, revision, paths) {
  const entries = runGit(['ls-tree', '-z', revision, '--', ...paths]).split('\0').filter(Boolean);
  return entries.every(entry => /^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry));
}

export function determineScope({ eventName, event, runGit = git, checkBaseline = verifiedBaseline }) {
  if (eventName === 'workflow_dispatch') return complete('Manual verification always runs the complete suite.');
  if (!['pull_request', 'merge_group', 'push'].includes(eventName)) return complete('Unknown event requires the complete suite.');
  let documents;
  try {
    const head = runGit(['rev-parse', '--verify', 'HEAD']).trim();
    if (!validSha(head)) return complete('Checkout identity is unavailable.');
    let range, pushBase;
    if (eventName === 'pull_request') {
      const base = event?.pull_request?.base?.sha;
      const proposed = event?.pull_request?.head?.sha;
      if (!validSha(base) || !validSha(proposed)) return complete('Pull request comparison is unavailable.');
      // The normal PR checkout is GitHub's merge commit. Ensure it contains the
      // event's proposed head before comparing the complete PR against its base.
      runGit(['merge-base', '--is-ancestor', proposed, head]);
      runGit(['merge-base', '--is-ancestor', base, head]);
      range = `${base}...${head}`;
    } else if (eventName === 'merge_group') {
      const group = event?.merge_group;
      if (group?.base_ref !== 'refs/heads/main' || !validSha(group.base_sha) || group.head_sha !== head) {
        return complete('Unverified merge group.');
      }
      runGit(['merge-base', '--is-ancestor', group.base_sha, head]);
      range = group.base_sha + '..' + head;
    } else {
      const base = event?.before;
      pushBase = base;
      if (event?.ref !== 'refs/heads/main' || !validSha(base) || event?.after !== head || event?.forced || event?.deleted) {
        return complete('Push comparison is unavailable or history changed.');
      }
      runGit(['merge-base', '--is-ancestor', base, head]);
      range = `${base}..${head}`;
    }
    const changes = parseChangedPaths(runGit(['diff', '--no-ext-diff', '--name-status', '-z', '--find-renames', range, '--']));
    documents = changes.filter(isOperationalDocument);
    // A renamed/deleted source is included above; only surviving regular files
    // may be read by the lightweight checker. Symlinks and type changes fail full.
    if (!regularPaths(runGit, head, changes)) {
      return { ...complete('Documentation contains a non-regular file.'), documents };
    }
    const profile = focusedProfile(changes, head, runGit);
    if (profile) {
      const baseline = pushBase ? checkBaseline(pushBase, runGit) : undefined;
      if (pushBase && !baseline) return { ...complete('Missing full application baseline.'), documents };
      return { mode: 'focused', profile, documents, reason: 'Reviewed ' + profile + ' profile.' + (baseline ? ' Full baseline: ' + baseline : '') };
    }
    if (!changes.every(changedPath => isOperationalDocument(changedPath) || deliveryPaths.has(changedPath))) {
      return { ...complete('Changes include application, configuration, or unlisted paths.'), documents };
    }
    return changes.some(changedPath => deliveryPaths.has(changedPath))
      ? { mode: 'delivery', documents, reason: `Only allowlisted delivery tools/tests and operational documents changed (${changes.length} paths).` }
      : { mode: 'docs', documents, reason: `Only ${changes.length} allowlisted documentation paths changed.` };
  } catch {
    return { ...complete('Diff, history or full application baseline could not be verified.'), documents };
  }
}

const sharedJobs = ['scope', 'docs', 'secret_scan'];
const applicationJobs = ['build', 'browser', 'calls', 'audit', 'image'];

export function requireVerification(needs, gate = 'verify') {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs) || !['verify', 'full', 'focused'].includes(gate)) {
    throw new Error('Invalid verification summary.');
  }
  const mode = needs.scope?.outputs?.mode;
  if (!['full', 'docs', 'delivery', 'focused'].includes(mode)) throw new Error('CI scope is missing or invalid.');
  if (gate === 'focused' && mode !== 'focused') throw new Error('Missing focused application verification.');
  if (gate === 'full' && mode !== 'full') throw new Error('Scoped CI is not full application verification.');
  if (mode === 'focused' && !Object.hasOwn(profiles, needs.scope.outputs.profile)) throw new Error('Unknown application profile.');
  const required = [...sharedJobs];
  if (mode === 'delivery') required.push('delivery');
  if (mode === 'full') required.push(...applicationJobs);
  if (mode === 'focused') required.push('focused', 'build', 'audit', 'image');
  const optionalJobs = ['delivery', 'focused'].filter(name => needs[name]);
  const skipped = [...applicationJobs, ...optionalJobs].filter(name => !required.includes(name));
  for (const name of required) {
    if (needs[name]?.result !== 'success') throw new Error(`Required job ${name} did not succeed.`);
  }
  for (const name of skipped) {
    if (needs[name]?.result !== 'skipped') throw new Error(`Scoped job ${name} was not skipped as expected.`);
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
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `mode=${scope.mode}\n`);
        if (scope.profile) appendFileSync(process.env.GITHUB_OUTPUT, `profile=${scope.profile}\n`);
        if (scope.documents) appendFileSync(process.env.GITHUB_OUTPUT, `documents=${JSON.stringify(scope.documents)}\n`);
      }
      console.log(`CI scope: ${scope.mode}. ${scope.reason}`);
    } else if (args.length === 2 && args[0] === 'verify' && ['verify', 'full', 'focused'].includes(args[1])) {
      const mode = requireVerification(JSON.parse(process.env.CI_NEEDS ?? ''), args[1]);
      console.log(`${args[1] === 'full' ? 'Full application verification (verify aggregate)' : 'CI verification'} passed (${mode}).`);
    } else {
      throw new Error('Invalid CI scope arguments.');
    }
  } catch (error) {
    console.error(`CI_BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
