import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMainModule } from './release-runtime.mjs';

const allowed = new Set(['build', 'test', 'check', 'check:full', 'test:browser', 'test:calls', 'test:calls:e2e', 'test:weak-network']);
export function summarize(records, head, tree) {
  return { version: 1, head, tree, checks: records.filter(r => r.version === 1 && allowed.has(r.command)
    && /^[a-f0-9]{40}$/.test(r.head) && /^[a-f0-9]{40}$/.test(r.tree)
    && typeof r.clean === 'boolean' && Number.isSafeInteger(r.durationMs) && r.durationMs >= 0
    && ['passed', 'failed', 'interrupted'].includes(r.result) && typeof r.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(r.startedAt))
    .map(r => ({ command: r.command, head: r.head, tree: r.tree, clean: r.clean, startedAt: r.startedAt,
      durationMs: r.durationMs, result: r.result, applicable: r.clean && r.tree === tree })),
    ci: 'not queried', merged: 'not queried', production: 'not queried', realDevice: 'not verified' };
}
function evidenceFiles(directory) {
  return readdirSync(directory).filter(name => /^[0-9a-f-]+\.json$/.test(name)).sort((a, b) => statSync(path.join(directory, a)).mtimeMs - statSync(path.join(directory, b)).mtimeMs);
}
export function deliveryEvidence(args, root = process.cwd()) {
  if (!((args.length === 1 || args.length === 2 && args[1] === '--remote') && args[0] === 'summary') && !(args.length === 2 && args[0] === 'run' && allowed.has(args[1]))) throw new Error('Usage: delivery:evidence -- run <allowed npm script> | summary');
  const git = (...values) => execFileSync('git', values, { cwd: root, encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const clean = !git('status', '--porcelain');
  const directory = path.join(git('rev-parse', '--absolute-git-dir'), 'quiet-room-delivery-evidence');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (args[0] === 'summary') {
    const records = evidenceFiles(directory).slice(-200).flatMap(name => {
      try { return [JSON.parse(readFileSync(path.join(directory, name), 'utf8'))]; } catch { return []; }
    });
    const result = summarize(records, head, tree);
    if (!clean) result.checks.forEach(check => { check.applicable = false; });
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
  const startedAt = new Date().toISOString(), started = performance.now();
  const run = spawnSync('npm', ['run', args[1]], { cwd: root, stdio: 'inherit' });
  const unchanged = clean && !git('status', '--porcelain') && head === git('rev-parse', 'HEAD');
  const result = { version: 1, head, tree, clean: unchanged, command: args[1], startedAt,
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
