import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repository } from './release-ci.mjs';

export function verifyCloudReceipt(receipt, sha, run, mode = 'deploy') {
  const statuses = mode === 'doctor' ? ['PREFLIGHT_OK'] : mode === 'stage' ? ['STAGE_VERIFIED'] : ['DEPLOY_VERIFIED', 'ALREADY_DEPLOYED_READBACK_REQUIRED'];
  if (receipt.version !== 1 || receipt.sha !== sha || !statuses.includes(receipt.status)
      || receipt.workflowRun !== String(run.databaseId) || receipt.workflowSha !== run.headSha
      || (['DEPLOY_VERIFIED', 'STAGE_VERIFIED'].includes(receipt.status) && receipt.manifest?.sha !== sha)
      || (receipt.status === 'ALREADY_DEPLOYED_READBACK_REQUIRED' && receipt.previousSha !== sha)) {
    throw new Error('Cloud receipt does not match this exact deployment');
  }
  return receipt.status;
}
export function dispatchCloud(sha, run, { mode = 'deploy', resume } = {}) {
  if (!['doctor', 'deploy', 'stage', 'activate'].includes(mode) || resume && !/^[1-9][0-9]*$/.test(resume)) throw new Error('Invalid cloud operation');
  const git = run('git', ['rev-parse', '--absolute-git-dir']);
  const base = path.join(git, 'quiet-room-cloud-publish');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  let workflow;
  if (resume) {
    const existing = JSON.parse(run('gh', ['api', `repos/${repository}/actions/runs/${resume}`]));
    if (String(existing.id) !== resume || existing.path !== '.github/workflows/publish.yml'
        || existing.event !== 'workflow_dispatch' || existing.head_branch !== 'main'
        || !existing.display_title?.startsWith(`Publish ${sha} (`)) throw new Error('Resume workflow identity mismatch');
    workflow = { databaseId: existing.id, headSha: existing.head_sha, url: existing.html_url };
  } else {
    const request = randomUUID();
    const file = path.join(base, `${request}.json`);
    // Save identity before dispatch; a lost response must not create a new request.
    const pending = { version: 1, sha, mode, request, status: 'submitting' };
    writeFileSync(file, JSON.stringify(pending) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Cloud request: ${request} record=${file}`);
    run('gh', ['workflow', 'run', 'publish.yml', '--repo', repository, '--ref', 'main', '-f', `sha=${sha}`, '-f', `mode=${mode}`, '-f', `request_id=${request}`]);
    for (let attempt = 0; attempt < 12; attempt++) {
      const workflows = JSON.parse(run('gh', ['run', 'list', '--repo', repository, '--workflow', 'publish.yml', '--event', 'workflow_dispatch', '--limit', '30', '--json', 'databaseId,displayTitle,headSha,url']));
      workflow = workflows.find(item => item.displayTitle === `Publish ${sha} (${request})`);
      if (workflow) break;
      run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    }
    if (!workflow) throw new Error(`Cloud dispatch outcome unknown; find request ${request} before retrying`);
    writeFileSync(file, JSON.stringify({ ...pending, status: 'dispatched', workflowRun: workflow.databaseId }) + '\n', { mode: 0o600 });
  }
  console.log(`Protected production workflow: ${workflow.url}`);
  run('gh', ['run', 'watch', String(workflow.databaseId), '--repo', repository, '--exit-status', '--interval', '15'], { stdio: 'inherit', timeout: 0 });
  const completed = JSON.parse(run('gh', ['api', `repos/${repository}/actions/runs/${workflow.databaseId}`]));
  if (completed.head_sha !== workflow.headSha || completed.conclusion !== 'success' || completed.run_attempt !== 1) throw new Error('Cloud workflow changed or failed; inspect production before retrying');
  const directory = path.join(base, String(workflow.databaseId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const download = mkdtempSync(path.join(directory, 'receipt-'));
  run('gh', ['run', 'download', String(workflow.databaseId), '--repo', repository, '--name', `quiet-room-cloud-receipt-${workflow.databaseId}-1`, '--dir', download]);
  const downloaded = path.join(download, 'quiet-room-cloud-receipt.json');
  const receipt = JSON.parse(readFileSync(downloaded, 'utf8'));
  const status = verifyCloudReceipt(receipt, sha, workflow, mode);
  renameSync(downloaded, path.join(directory, 'quiet-room-cloud-receipt.json'));
  console.log(`${status} sha=${sha} receipt=${directory}/quiet-room-cloud-receipt.json`);
  return receipt;
}
