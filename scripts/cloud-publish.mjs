import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { downloadCIImage, artifactName } from './ci-image.mjs';
import { repository, verifySuccessfulCI } from './release-ci.mjs';
import { isMainModule } from './release-runtime.mjs';

export const production = Object.freeze({ region: 'cn-wuhan-lr', instance: 'f2bf8acfb4754bf08e5f6d8534c3ce83', origin: 'https://ai.shui.click' });
const shaPattern = /^[a-f0-9]{40}$/;
export function cloudErrorCode(stderr = '') {
  if (/region can't be empty/.test(stderr)) return 'CLI_REGION_MISSING';
  if (/unchecked version \d{4}-\d{2}-\d{2}/.test(stderr)) return 'CLI_API_VERSION_UNAVAILABLE';
  return stderr.match(/(?:ErrorCode|Code)["']?[:=]\s*["']?([A-Za-z][A-Za-z0-9_.-]{0,79})/)?.[1] ?? 'unavailable';
}
export function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 ** 2, ...options });
  // Cloud errors may echo command payloads or a signed URL. Never print raw
  // subprocess output in an exception or persist the private request.
  if (result.error || result.status !== 0) {
    const code = cloudErrorCode(result.stderr);
    throw new Error(`CLOUD_COMMAND_FAILED program=${program} code=${result.status ?? 'unavailable'} serviceCode=${code}; inspect original invocation before retrying`);
  }
  return result.stdout.trim();
}
export function requireAncestor(comparison, ancestor) {
  if (!['ahead', 'identical'].includes(comparison.status) || comparison.merge_base_commit?.sha !== ancestor) throw new Error('Not an approved forward main release');
}
export function invocationResult(payload, invokeId, instance = production.instance) {
  const result = payload.InvocationResult;
  if (!result || result.InvokeId !== invokeId || result.InstanceId !== instance || result.InvokeUser !== 'admin') throw new Error('Cloud invocation identity mismatch');
  if (['Pending', 'Running'].includes(result.InvocationStatus)) return null;
  if (result.InvocationStatus !== 'Success' || result.ExitCode !== 0) throw new Error(`PRODUCTION_STATE_UNRESOLVED status=${result.InvocationStatus}; inspect before retrying`);
  if (typeof result.Output !== 'string' || Buffer.byteLength(result.Output) >= 24000) throw new Error('Missing or possibly truncated cloud output');
  // SWAS returns command output as Base64, including successful preflight and
  // deployment receipts. Buffer's decoder is permissive; require canonical
  // encoding and valid UTF-8 before interpreting any production markers.
  const decoded = Buffer.from(result.Output, 'base64');
  if (decoded.toString('base64') !== result.Output) throw new Error('Invalid cloud output encoding');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw new Error('Invalid cloud output text');
  }
}
export function cloudAPI(action, parameters, run = command) {
  const args = Object.entries({ RegionId: production.region, ...parameters }).flatMap(([key, value]) => [`--${key}`, String(value)]);
  // CLI 3.4.11 embeds SWAS-OPEN 2020-06-01. Its explicit --version lookup
  // rejects this built-in version; --api-version would become an API parameter.
  // Pass the CLI region explicitly: RegionId alone does not initialize credentials.
  return JSON.parse(run('aliyun', ['swas-open', action, '--region', production.region, '--endpoint', `swas.${production.region}.aliyuncs.com`, '--method', 'POST', '--secure', '--retry-count', '0', '--connect-timeout', '10', '--read-timeout', '30', '--force', ...args]));
}
async function invoke(script, label, receipt, run = command) {
  receipt.status = `submitting-${label}`;
  saveReceipt(receipt);
  const result = cloudAPI('RunCommand', { InstanceId: production.instance, Name: `quiet-room-${label}`, Type: 'RunShellScript', WorkingUser: 'admin', WorkingDir: '/tmp', Timeout: 3600, EnableParameter: false, CommandContent: script }, run);
  if (!/^t-[a-zA-Z0-9-]+$/.test(result.InvokeId ?? '')) throw new Error('PRODUCTION_STATE_UNRESOLVED missing invocation ID');
  receipt.invocations.push({ label, id: result.InvokeId, status: 'submitted' });
  saveReceipt(receipt);
  for (let count = 0; count < 240; count++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const output = invocationResult(cloudAPI('DescribeInvocationResult', { InstanceId: production.instance, InvokeId: result.InvokeId }, run), result.InvokeId);
    if (output !== null) {
      receipt.invocations.at(-1).status = 'success';
      saveReceipt(receipt);
      return output;
    }
  }
  throw new Error('PRODUCTION_STATE_UNRESOLVED polling deadline; do not dispatch again');
}
function saveReceipt(receipt) {
  writeFileSync(path.join(process.env.RUNNER_TEMP, 'quiet-room-cloud-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
}
const preflight = `set -eu
sudo -n /usr/local/sbin/quiet-room-capacity preflight
sudo -n /usr/local/sbin/quiet-room-deploy --describe
printf 'LIVE_SHA='
sudo -n /bin/cat /opt/quiet-room/deploy-state/current-sha
`;
export function parsePreflight(output) {
  const lines = output.trim().split('\n');
  const descriptor = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.imageProtocol);
  const live = lines.find(line => line.startsWith('LIVE_SHA='))?.slice(9);
  if (descriptor?.imageProtocol !== 1 || descriptor?.expectedPreviousProtocol !== 1 || descriptor?.publicOrigin !== production.origin || !shaPattern.test(live ?? '')) throw new Error('Production helper/origin/state preflight mismatch');
  return live;
}
async function signedLocation(artifactId) {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`, { redirect: 'manual', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30000) });
  if (response.status !== 302) throw new Error('Artifact ticket unavailable');
  const location = response.headers.get('location');
  const url = new URL(location);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com'))) throw new Error('Unexpected artifact ticket host');
  console.log(`::add-mask::${location}`);
  return location;
}
export async function cloudPublish(sha, { doctor = false } = {}) {
  if (!shaPattern.test(sha ?? '') || process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('Protected main manual workflow required');
  if (process.env.SAS_REGION_ID !== production.region || process.env.SAS_INSTANCE_ID !== production.instance) throw new Error('Production target mismatch');
  if (!['doctor', 'deploy'].includes(process.env.PUBLISH_MODE)) throw new Error('Explicit publish mode required');
  const receipt = { version: 1, sha, workflowSha: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID, startedAt: new Date().toISOString(), status: 'preflight', invocations: [] };
  saveReceipt(receipt);
  const api = suffix => JSON.parse(command('gh', ['api', `repos/${repository}/${suffix}`]));
  requireAncestor(api(`compare/${sha}...main`), sha);
  const ci = verifySuccessfulCI(command, sha, { details: true });
  const previousSha = parsePreflight(await invoke(preflight, 'preflight', receipt));
  receipt.previousSha = previousSha;
  if (doctor || previousSha === sha) {
    receipt.status = doctor ? 'PREFLIGHT_OK' : 'ALREADY_DEPLOYED_READBACK_REQUIRED';
    saveReceipt(receipt);
    console.log(receipt.status);
    return;
  }
  requireAncestor(api(`compare/${previousSha}...${sha}`), previousSha);
  const directory = path.join(process.env.RUNNER_TEMP, `quiet-room-verified-image-${process.env.GITHUB_RUN_ID}`);
  // The ephemeral CI runner performs the existing full archive/hash/tag
  // verification. The operator's computer never downloads this payload.
  const image = downloadCIImage(command, sha, directory);
  const { archive: _archive, ...manifest } = image;
  const listing = api(`actions/runs/${ci.id}/artifacts?per_page=100`);
  const artifacts = listing.artifacts.filter(item => item.name === artifactName(sha, ci.run_attempt, 'linux/amd64'));
  if (artifacts.length !== 1 || artifacts[0].expired !== false || artifacts[0].workflow_run?.id !== ci.id || artifacts[0].workflow_run?.head_sha !== sha || !Number.isSafeInteger(artifacts[0].size_in_bytes) || artifacts[0].size_in_bytes > 2 * 1024 ** 3) throw new Error('CI artifact binding changed');
  const latest = verifySuccessfulCI(command, sha, { details: true });
  if (latest.id !== ci.id || latest.run_attempt !== ci.run_attempt || manifest.runId !== ci.id || manifest.attempt !== ci.run_attempt) throw new Error('CI changed before dispatch');
  receipt.manifest = manifest;
  receipt.status = 'dispatching';
  saveReceipt(receipt);
  // Fresh ticket is obtained only after all slow CI validation is complete.
  const payload = { manifest, previousSha, size: artifacts[0].size_in_bytes, url: await signedLocation(artifacts[0].id) };
  const source = readFileSync(new URL('./server-image-stream.py', import.meta.url)).toString('base64');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  console.log(`::add-mask::${data}`);
  const script = `set -eu\npython3 -c 'import base64,io,sys; sys.stdin=io.StringIO(base64.b64decode("${data}").decode()); exec(compile(base64.b64decode("${source}"),"server-image-stream.py","exec"))'`;
  if (Buffer.byteLength(script) > 16 * 1024) throw new Error('Cloud command exceeds bounded payload');
  const output = await invoke(script, `deploy-${sha.slice(0, 12)}`, receipt);
  if (!output.split('\n').some(line => line.startsWith(`DEPLOY_OK sha=${sha} `)) || !output.split('\n').includes(`STREAM_VERIFIED sha=${sha} image=${image.imageId}`)) throw new Error('PRODUCTION_STATE_UNRESOLVED missing exact helper receipt');
  const live = parsePreflight(await invoke(preflight, 'postflight', receipt));
  if (live !== sha) throw new Error('PRODUCTION_STATE_UNRESOLVED live SHA mismatch');
  receipt.status = 'DEPLOY_VERIFIED';
  receipt.finishedAt = new Date().toISOString();
  saveReceipt(receipt);
  console.log(`DEPLOY_VERIFIED sha=${sha}; independent production readback required`);
}
if (isMainModule(import.meta.url)) {
  cloudPublish(process.env.APPROVED_SHA, { doctor: process.env.PUBLISH_MODE === 'doctor' }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
