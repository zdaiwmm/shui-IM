import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { command, invoke, production } from './cloud-publish.mjs';
import { readbackOperations, runReadback, saveEvidence } from './production-readback.mjs';
import { repository } from './release-ci.mjs';

const sha = process.env.APPROVED_SHA;
if (!/^[0-9a-f]{40}$/.test(sha ?? '') || process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.SAS_REGION_ID !== production.region || process.env.SAS_INSTANCE_ID !== production.instance) {
  throw new Error('Expected protected production workflow and exact SHA');
}
const receipt = { sha, workflowRun: process.env.GITHUB_RUN_ID, invocations: [] };
const persist = value => writeFileSync(path.join(process.env.RUNNER_TEMP, 'readback-invocations.json'), JSON.stringify(value), { mode: 0o600 });
const operations = readbackOperations(production.origin, (probe, args, phase) => {
  if (args.some(value => !/^[a-zA-Z0-9._/-]+$/.test(value))) throw new Error('Invalid probe arguments');
  const script = `sudo -n /bin/sh -s -- ${args.join(' ')} <<'QUIET_ROOM_PROBE'\n${probe}\nQUIET_ROOM_PROBE`;
  return invoke(script, phase, receipt, command, persist);
});
try {
  const evidence = await runReadback(sha, operations, console.log, undefined, { environment: 'production', origin: production.origin });
  saveEvidence(evidence);
  console.log(`READBACK_OK sha=${sha}`);
} catch (error) {
  if (error.evidence) saveEvidence(error.evidence);
  throw error;
}
