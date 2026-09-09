export const repository = 'zdaiwmm/shui-IM';
export const fullVerificationJob = 'verify';

function pageItems(response, key) {
  const pages = Array.isArray(response) ? response : [response];
  if (!pages.length || pages.some(page => !Array.isArray(page?.[key]))) throw new Error(`Invalid CI ${key} response.`);
  return pages.flatMap(page => page[key]);
}

export function selectRun(response, sha) {
  const runs = pageItems(response, 'workflow_runs').filter(run => run.head_sha === sha &&
    run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event) && run.path === '.github/workflows/ci.yml');
  if (runs.some(run => !Number.isSafeInteger(run.id) || run.id <= 0)) throw new Error('Invalid CI run identity.');
  const run = runs.sort((a, b) => b.id - a.id)[0];
  if (!run) throw new Error('No matching main CI run yet. Retry after GitHub creates it.');
  if (run.status === 'completed' && run.conclusion !== 'success') throw new Error('Latest CI failed. Fix it before publishing.');
  return run;
}

export function requireSuccessfulCI(response, sha, jobsResponse) {
  const run = selectRun(response, sha);
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Latest CI run for the exact main commit has not passed.');
  const jobs = pageItems(jobsResponse, 'jobs').filter(job => job.name === fullVerificationJob);
  if (jobs.length !== 1 || jobs[0].run_id !== run.id || jobs[0].head_sha !== sha ||
      jobs[0].status !== 'completed' || jobs[0].conclusion !== 'success') {
    throw new Error('The aggregate verify job has not passed for the latest exact main CI run. Documentation-only CI cannot authorize release. Run gh workflow run ci.yml --repo zdaiwmm/shui-IM --ref main, verify its exact SHA, then retry.');
  }
  return run.html_url;
}

export function readCIRuns(command, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Exact main SHA required for CI verification.');
  return JSON.parse(command('gh', ['api', `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&per_page=100`, '--paginate', '--slurp']));
}

export function verifySuccessfulCI(command, sha) {
  const response = readCIRuns(command, sha);
  const run = selectRun(response, sha);
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Latest CI run for the exact main commit has not passed.');
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) throw new Error('Invalid CI run attempt.');
  // Bind jobs to this attempt; an older green attempt must not satisfy a rerun.
  const jobs = JSON.parse(command('gh', ['api', `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, '--paginate', '--slurp']));
  const latest = readCIRuns(command, sha);
  const current = selectRun(latest, sha);
  if (current.id !== run.id || current.run_attempt !== run.run_attempt) throw new Error('Latest CI run changed during verification. Inspect it before publishing.');
  return requireSuccessfulCI(latest, sha, jobs);
}
