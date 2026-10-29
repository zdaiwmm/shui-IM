import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { release } from 'node:os';
import { createRequire } from 'node:module';
import { isMainModule } from './release-runtime.mjs';
import { isOperationalDocument } from './ci-scope.mjs';

const allowed = new Set(['build', 'test', 'check', 'check:full', 'test:browser', 'test:calls', 'test:calls:e2e', 'test:weak-network']);
function validRecord(r) {
  return r?.version === 1 && allowed.has(r.command)
    && /^[a-f0-9]{40}$/.test(r.head) && /^[a-f0-9]{40}$/.test(r.tree)
    && typeof r.clean === 'boolean' && Number.isSafeInteger(r.durationMs) && r.durationMs >= 0
    && ['passed', 'failed', 'interrupted'].includes(r.result) && typeof r.startedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(r.startedAt) && Number.isFinite(Date.parse(r.startedAt));
}
function verificationEnvironment(environment = process.env) {
  // This per-tool-call transport ID changes between otherwise identical CLI
  // invocations. Remove it from both the fingerprint and the child test process.
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key !== 'CODEX_TOOL_CALL_ID'));
}
export function executionFingerprint(root, environment = process.env) {
  environment = verificationEnvironment(environment);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const identity = file => {
    // macOS may update browser ctime when launching an unchanged signed app.
    // Bind actual bytes and symlink destination, not mutable filesystem metadata.
    try { return [file, realpathSync(file), digest(readFileSync(file))]; } catch { return [file, 'unavailable']; }
  };
  const npm = execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
  const files = [process.execPath, path.join(root, 'node_modules/.package-lock.json'),
    environment.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (files[2].includes('.app/Contents/MacOS/')) files.push(path.join(path.dirname(path.dirname(files[2])), 'Info.plist'));
  try {
    const { chromium, webkit } = createRequire(path.join(root, 'package.json'))('playwright');
    files.push(chromium.executablePath(), webkit.executablePath());
  } catch { files.push(path.join(root, 'node_modules/playwright-unavailable')); }
  // Only the aggregate digest is saved: no environment values, credentials or
  // local browser/key paths are written into evidence or logs.
  return digest(JSON.stringify({ node: process.version, npm, platform: process.platform,
    arch: process.arch, kernel: release(), files: files.map(identity),
    environment: digest(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))) }));
}
export function verificationContent(root) {
  // Bind every tracked byte/mode/path except the existing operational-document
  // allowlist. Security contracts, tests, tools, dependencies and workflows stay
  // in the identity. Even an allowlisted symlink must invalidate the evidence.
  const entries = execFileSync('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const relevant = entries.filter(entry => {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error('Invalid verification tree');
    return !/^100(?:644|755) blob [a-f0-9]{40}$/.test(entry.slice(0, tab))
      || !isOperationalDocument(entry.slice(tab + 1));
  });
  return createHash('sha256').update('verification-content-v1\0' + relevant.join('\0')).digest('hex');
}
export function reusableRecord(records, command, head, tree, fingerprint, content) {
  // Never fall back past a newer failed, dirty, foreign-environment or legacy
  // result for the same command. CI and production proof are never reused here.
  const latest = records.findLast(record => record?.command === command);
  return allowed.has(command) && /^[a-f0-9]{64}$/.test(fingerprint ?? '')
    && validRecord(latest) && (latest.head === head && latest.tree === tree
      || /^[a-f0-9]{64}$/.test(content ?? '') && latest.verificationContent === content)
    && latest.clean === true && latest.result === 'passed'
    && latest.executionFingerprint === fingerprint ? latest : undefined;
}
export function summarize(records, head, tree, fingerprint, content) {
  return { version: 1, head, tree, checks: records.filter(validRecord)
    .map(r => ({ command: r.command, head: r.head, tree: r.tree, clean: r.clean, startedAt: r.startedAt,
      durationMs: r.durationMs, result: r.result,
      applicable: r.clean && (r.tree === tree || /^[a-f0-9]{64}$/.test(content ?? '') && r.verificationContent === content),
      reusable: Boolean(reusableRecord(records, r.command, head, tree, fingerprint, content) === r) })),
    ci: 'not queried', merged: 'not queried', production: 'not queried', realDevice: 'not verified' };
}
function evidenceFiles(directory) {
  return readdirSync(directory).filter(name => /^[0-9a-f-]+\.json$/.test(name)).sort((a, b) => statSync(path.join(directory, a)).mtimeMs - statSync(path.join(directory, b)).mtimeMs);
}
export function deliveryEvidence(args, root = process.cwd()) {
  if (!((args.length === 1 || args.length === 2 && args[1] === '--remote') && args[0] === 'summary') && !(args.length === 2 && ['run', 'ensure'].includes(args[0]) && allowed.has(args[1]))) throw new Error('Usage: delivery:evidence -- run|ensure <allowed npm script> | summary');
  const git = (...values) => execFileSync('git', values, { cwd: root, encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const clean = !git('status', '--porcelain');
  const directory = path.join(git('rev-parse', '--absolute-git-dir'), 'quiet-room-delivery-evidence');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fingerprint = executionFingerprint(root);
  const content = verificationContent(root);
  const records = evidenceFiles(directory).slice(-200).flatMap(name => {
    try {
      const record = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
      return [validRecord(record) ? record : { command: args[1], result: 'invalid' }];
    } catch { return [{ command: args[1], result: 'invalid' }]; }
  });
  if (args[0] === 'summary') {
    const result = summarize(records, head, tree, fingerprint, content);
    if (!clean) result.checks.forEach(check => { check.applicable = false; check.reusable = false; });
    if (args[1] === '--remote') {
      // Read only GitHub metadata. Select fields explicitly; never persist API payloads or logs.
      const gh = values => JSON.parse(execFileSync('gh', values, { cwd: root, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
      try {
        const runs = gh(['api', `repos/zdaiwmm/shui-IM/actions/workflows/ci.yml/runs?head_sha=${head}&per_page=100`]);
        result.ci = runs.workflow_runs.filter(run => run.head_sha === head).slice(0, 20).map(run => ({
          id: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion, event: run.event,
        }));
        const prs = gh(['api', `repos/zdaiwmm/shui-IM/commits/${head}/pulls`]);
        result.merged = prs.filter(pr => pr.head?.sha === head || pr.merge_commit_sha === head).map(pr => ({ number: pr.number, merged: Boolean(pr.merged_at) }));
      } catch { result.ci = 'query failed'; result.merged = 'query failed'; }
    }
    console.log(JSON.stringify(result, null, 2)); return result;
  }
  const reusable = clean && reusableRecord(records, args[1], head, tree, fingerprint, content);
  if (args[0] === 'ensure' && reusable) {
    console.log(`DELIVERY_EVIDENCE_REUSED command=${args[1]} head=${head} verified_head=${reusable.head} started_at=${reusable.startedAt}`);
    process.exitCode = 0;
    return reusable;
  }
  const startedAt = new Date().toISOString(), started = performance.now();
  const run = spawnSync('npm', ['run', args[1]], { cwd: root, stdio: 'inherit', env: verificationEnvironment() });
  const unchanged = clean && !git('status', '--porcelain') && head === git('rev-parse', 'HEAD')
    && fingerprint === executionFingerprint(root);
  const result = { version: 1, head, tree, clean: unchanged, command: args[1], startedAt,
    executionFingerprint: fingerprint,
    verificationContent: content,
    durationMs: Math.round(performance.now() - started), result: run.signal ? 'interrupted' : run.status === 0 && !run.error ? 'passed' : 'failed' };
  const file = path.join(directory, `${randomUUID()}.json`), temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, file);
  for (const name of evidenceFiles(directory).slice(0, -200)) unlinkSync(path.join(directory, name));
  console.log(`DELIVERY_EVIDENCE ${JSON.stringify(result)}`);
  process.exitCode = run.status ?? 1;
  return result;
}
if (isMainModule(import.meta.url)) {
  try { deliveryEvidence(process.argv.slice(2)); }
  catch { console.error('DELIVERY_EVIDENCE_BLOCKED'); process.exitCode = 1; }
}
