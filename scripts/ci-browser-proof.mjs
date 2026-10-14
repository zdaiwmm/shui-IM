import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './release-runtime.mjs';

const repository = 'zdaiwmm/shui-IM';
const shaPattern = /^[a-f0-9]{40}$/;
const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Container checkout ownership differs from the test user. Trust only this
// checkout for this read, without changing global configuration or using '*'.
export function checkoutTree(command = run) {
  return command('git', ['-c', `safe.directory=${process.cwd()}`, 'rev-parse', 'HEAD^{tree}']);
}
export function environmentFingerprint() {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const declaredContainer = /image: (mcr\.microsoft\.com\/playwright:[^\s]+@sha256:[a-f0-9]{64})/.exec(readFileSync('.github/workflows/ci.yml', 'utf8'))?.[1];
  const containerImage = process.env.BROWSER_CONTAINER_IMAGE === declaredContainer ? declaredContainer : '';
  const bases = [...dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)].map(match => match[1]);
  return {
    node: process.version, nodeHash: hash(readFileSync(process.execPath)), npm: run('npm', ['--version']),
    git: run('git', ['--version']), kernel: os.release(), platform: process.platform, arch: process.arch,
    containerImage, cpuModel: os.cpus()[0]?.model ?? '', cpuCount: os.cpus().length,
    hostImage: process.env.ImageVersion ?? '', hostOS: process.env.ImageOS ?? '',
    playwright: JSON.parse(readFileSync('node_modules/playwright/package.json', 'utf8')).version,
    lock: hash(readFileSync('package-lock.json')), bases,
  };
}
export function reusableEnvironment(environment) {
  return Boolean((environment?.hostImage && environment.hostOS || /@sha256:[a-f0-9]{64}$/.test(environment?.containerImage ?? '')) && environment.nodeHash && environment.lock
    && environment.bases?.length && environment.bases.every(base => /@sha256:[a-f0-9]{64}$/.test(base)));
}
export function canReuseBrowserProof(proof, expected, now = Date.now()) {
  const time = Date.parse(proof?.executedAt);
  return Boolean(proof?.version === 1 && proof.executed === true && proof.repository === repository
    && proof.sourceRun === expected.runId && proof.attempt === expected.attempt && proof.headSha === expected.headSha
    && proof.tree === expected.tree && proof.role === expected.role && proof.shard === expected.shard
    && shaPattern.test(proof.tree) && shaPattern.test(proof.headSha)
    && Number.isFinite(time) && time <= now && now - time <= 60 * 60 * 1000
    && reusableEnvironment(proof.environment) && reusableEnvironment(expected.environment)
    && JSON.stringify(proof.environment) === JSON.stringify(expected.environment));
}
function role() {
  const group = process.env.BROWSER_GROUP, shard = process.env.BROWSER_SHARD, index = process.env.BROWSER_INDEX;
  if (!['1', '2'].includes(group) || !/^[1-9]\d*\/[1-9]\d*$/.test(shard ?? '') || !/^\d{1,2}$/.test(index ?? '')) throw new Error('Invalid browser proof role');
  return { role: `${group}-${index}`, shard };
}
export function recordBrowserProof(command = run) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const headSha = process.env.GITHUB_EVENT_NAME === 'pull_request' ? event.pull_request?.head?.sha : process.env.GITHUB_SHA;
  const tree = checkoutTree(command);
  if (!shaPattern.test(headSha ?? '') || !shaPattern.test(tree)) throw new Error('Invalid proof source');
  const proof = { version: 1, repository, sourceRun: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    headSha, tree, ...role(), executed: true, executedAt: new Date().toISOString(), environment: environmentFingerprint() };
  writeFileSync(path.join(process.env.RUNNER_TEMP, 'quiet-room-browser-proof.json'), JSON.stringify(proof) + '\n', { mode: 0o600 });
  return proof;
}
async function githubAPI(suffix) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${suffix}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Browser proof API unavailable');
  return response.json();
}
async function downloadProof(artifactId) {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`, { redirect: 'manual', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` }, signal: AbortSignal.timeout(30000) });
  if (response.status !== 302) throw new Error('Browser proof ticket unavailable');
  const url = new URL(response.headers.get('location'));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com'))) throw new Error('Unexpected proof ticket host');
  const archive = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!archive.ok) throw new Error('Browser proof download unavailable');
  const chunks = []; let size = 0;
  for await (const chunk of archive.body) {
    size += chunk.length;
    if (size > 65536) throw new Error('Browser proof exceeds limit');
    chunks.push(chunk);
  }
  // The pinned browser container has Python, but no GitHub CLI. Do not extract
  // an untrusted ZIP into a filesystem or invoke a shell with its contents.
  return JSON.parse(execFileSync('python3', ['-c', `import io,json,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 entries=z.infolist()
 if len(entries)!=1 or entries[0].filename!='quiet-room-browser-proof.json' or entries[0].file_size>65536: raise ValueError('Invalid proof archive')
 print(json.dumps(json.loads(z.read(entries[0]))))`], { input: Buffer.concat(chunks), timeout: 30000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'] }));
}
export async function tryReuseBrowserProof(command = run, { api = githubAPI, download = downloadProof, fingerprint = environmentFingerprint } = {}) {
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') return false;
  const head = process.env.GITHUB_SHA;
  const tree = checkoutTree(command);
  const environment = fingerprint();
  if (!reusableEnvironment(environment)) return false;
  const prs = await api(`commits/${head}/pulls?per_page=100`);
  const matches = prs.filter(pr => pr.merged_at && pr.merge_commit_sha === head && pr.base?.ref === 'main' && pr.head?.repo?.full_name === repository);
  if (matches.length !== 1) return false;
  const pr = matches[0];
  const list = async () => (await api(`actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=100`)).workflow_runs
    .filter(item => item.path === '.github/workflows/ci.yml' && item.event === 'pull_request' && item.head_sha === pr.head.sha && item.head_branch === pr.head.ref)
    .sort((a, b) => b.id - a.id);
  const candidate = (await list())[0];
  if (!candidate || candidate.status !== 'completed' || candidate.conclusion !== 'success' || !Number.isSafeInteger(candidate.id) || candidate.id < 1 || !Number.isSafeInteger(candidate.run_attempt) || candidate.run_attempt < 1) return false;
  const jobs = (await api(`actions/runs/${candidate.id}/attempts/${candidate.run_attempt}/jobs?per_page=100`)).jobs;
  const gates = jobs.filter(job => job.name === 'verify' && job.head_sha === pr.head.sha && job.run_id === candidate.id);
  if (gates.length !== 1 || gates[0].status !== 'completed' || gates[0].conclusion !== 'success' || gates[0].steps?.filter(step => step.name === 'Full application verification' && step.conclusion === 'success').length !== 1) return false;
  const identity = role();
  const name = `quiet-room-browser-proof-${candidate.id}-${candidate.run_attempt}-${identity.role}`;
  const artifacts = (await api(`actions/runs/${candidate.id}/artifacts?per_page=100`)).artifacts.filter(item => item.name === name);
  if (artifacts.length !== 1 || artifacts[0].expired !== false || artifacts[0].workflow_run?.id !== candidate.id
      || artifacts[0].workflow_run?.head_sha !== pr.head.sha || !Number.isSafeInteger(artifacts[0].size_in_bytes) || artifacts[0].size_in_bytes < 1 || artifacts[0].size_in_bytes > 65536) return false;
  const proof = await download(artifacts[0].id);
  if (!canReuseBrowserProof(proof, { runId: candidate.id, attempt: candidate.run_attempt, headSha: pr.head.sha, tree, ...identity, environment })) return false;
  const latest = (await list())[0];
  if (latest?.id !== candidate.id || latest.run_attempt !== candidate.run_attempt || latest.status !== 'completed' || latest.conclusion !== 'success') return false;
  console.log(`BROWSER_PROOF_REUSED source_run=${candidate.id} attempt=${candidate.run_attempt} tree=${tree} role=${identity.role}`);
  return true;
}
if (isMainModule(import.meta.url)) {
  if (process.argv[2] === 'record') recordBrowserProof();
  else if (process.argv[2] === 'reuse') {
    let reused = false;
    try { reused = await tryReuseBrowserProof(); } catch { console.log('BROWSER_PROOF_UNAVAILABLE: execute the complete shard'); }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
    if (!reused) console.log('BROWSER_PROOF_FALLBACK: execute the complete shard');
  } else { console.error('Use record or reuse'); process.exitCode = 1; }
}
