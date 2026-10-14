import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repository } from './release-ci.mjs';

export function verifyCloudReceipt(receipt, sha, run) {
  if (receipt.version !== 1 || receipt.sha !== sha || receipt.status !== 'DEPLOY_VERIFIED' || receipt.workflowRun !== String(run.databaseId) || receipt.workflowSha !== run.headSha || receipt.manifest?.sha !== sha) throw new Error('Cloud receipt does not match this exact deployment');
}
export function dispatchCloud(sha, run) {
  const request = randomUUID();
  run('gh', ['workflow', 'run', 'publish.yml', '--repo', repository, '--ref', 'main', '-f', `sha=${sha}`, '-f', 'mode=deploy', '-f', `request_id=${request}`]);
  let workflow;
  for (let attempt = 0; attempt < 12; attempt++) {
    const workflows = JSON.parse(run('gh', ['run', 'list', '--repo', repository, '--workflow', 'publish.yml', '--event', 'workflow_dispatch', '--limit', '30', '--json', 'databaseId,displayTitle,headSha,url']));
    workflow = workflows.find(item => item.displayTitle === `Publish ${sha} (${request})`);
    if (workflow) break;
    run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  }
  if (!workflow) throw new Error('Cloud dispatch outcome unknown; find existing workflow before retrying');
  console.log(`Protected production workflow: ${workflow.url}`);
  run('gh', ['run', 'watch', String(workflow.databaseId), '--repo', repository, '--exit-status', '--interval', '15'], { stdio: 'inherit', timeout: 0 });
  const completed = JSON.parse(run('gh', ['api', `repos/${repository}/actions/runs/${workflow.databaseId}`]));
  if (completed.head_sha !== workflow.headSha || completed.conclusion !== 'success' || completed.run_attempt !== 1) throw new Error('Cloud workflow changed or failed; inspect production before retrying');
  const git = run('git', ['rev-parse', '--absolute-git-dir']);
  const directory = path.join(git, 'quiet-room-cloud-publish', String(workflow.databaseId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  run('gh', ['run', 'download', String(workflow.databaseId), '--repo', repository, '--name', `quiet-room-cloud-receipt-${workflow.databaseId}-1`, '--dir', directory]);
  const receipt = JSON.parse(readFileSync(path.join(directory, 'quiet-room-cloud-receipt.json'), 'utf8'));
  verifyCloudReceipt(receipt, sha, workflow);
  console.log(`DEPLOY_VERIFIED sha=${sha} receipt=${directory}/quiet-room-cloud-receipt.json`);
}
