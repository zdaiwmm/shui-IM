import { isMainModule } from './release-runtime.mjs';
import { repository } from './release-ci.mjs';

export function imageRetentionPlan(artifacts, runs, currentRunId, currentSha, now = Date.now()) {
  const candidates = [];
  for (const artifact of artifacts) {
    const match = /^quiet-room-image-([a-f0-9]{40})-([1-9][0-9]*)-(amd64|arm64)$/.exec(artifact.name ?? '');
    const run = runs[artifact.workflow_run?.id];
    if (!match || !Number.isSafeInteger(artifact.id) || artifact.expired !== false || !run ||
        run.path !== '.github/workflows/ci.yml' || run.head_branch !== 'main' || !['push', 'workflow_dispatch'].includes(run.event) ||
        run.head_sha !== match[1] || artifact.workflow_run?.head_sha !== match[1] || !Number.isSafeInteger(run.id)) continue;
    candidates.push({ artifact, run, sha: match[1], attempt: Number(match[2]) });
  }
  const keepShas = new Set([currentSha]);
  const successful = candidates.filter(item => item.run.status === 'completed' && item.run.conclusion === 'success').sort((a, b) => b.run.id - a.run.id);
  for (const item of successful) { if (keepShas.size >= 3) break; keepShas.add(item.sha); }
  const latestAttempts = new Map();
  for (const item of successful) latestAttempts.set(item.sha, Math.max(latestAttempts.get(item.sha) ?? 0, item.attempt));
  return candidates.filter(item => {
    if (item.run.id === currentRunId || item.run.status !== 'completed') return false;
    if (item.run.conclusion === 'success') return !keepShas.has(item.sha) || item.attempt !== latestAttempts.get(item.sha);
    // Failed attempts remain inspectable for a day; unknown timestamps fail closed.
    const created = Date.parse(item.artifact.created_at);
    return Number.isFinite(created) && now - created > 86400000;
  }).map(item => item.artifact.id);
}

async function api(resource, method = 'GET') {
  const response = await fetch(`https://api.github.com/repos/${repository}/${resource}`, {
    method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`CI artifact retention API failed (${response.status})`);
  return method === 'DELETE' ? null : response.json();
}

if (isMainModule(import.meta.url)) {
  if (process.env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) || !process.env.GITHUB_TOKEN) throw new Error('Retention only runs on trusted main CI');
  const artifacts = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('Artifact listing exceeded bound');
    const batch = await api(`actions/artifacts?per_page=100&page=${page}`);
    artifacts.push(...batch.artifacts);
    if (batch.artifacts.length < 100) break;
  }
  const runs = {};
  for (const artifact of artifacts.filter(item => /^quiet-room-image-/.test(item.name))) {
    const id = artifact.workflow_run?.id;
    if (Number.isSafeInteger(id) && !runs[id]) runs[id] = await api(`actions/runs/${id}`);
  }
  const ids = imageRetentionPlan(artifacts, runs, Number(process.env.GITHUB_RUN_ID), process.env.GITHUB_SHA);
  for (const id of ids) await api(`actions/artifacts/${id}`, 'DELETE');
  console.log(`CI image retention: removed=${ids.length}; keep=current-and-two-previous; expiry=7-days`);
}
