import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { isMainModule } from './release-runtime.mjs';
import { validateConfig } from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://ai.shui.click';
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const publicPathPattern = /^\/(?:sw\.js|assets\/[A-Za-z0-9._/-]+)$/;
const dollar = '$';

export const stateProbe = String.raw`set -eu
APP_ROOT=/opt/quiet-room
STATE_DIR="$APP_ROOT/deploy-state"
MAINTENANCE_FILE=/var/lib/quiet-room-deploy/maintenance
expected_sha="$1"
case "$expected_sha" in *[!0-9a-f]*|'') exit 64;; esac
[ "${dollar}{#expected_sha}" -eq 40 ] || exit 64
read_state() { if [ -f "$1" ]; then sed -n '1p' "$1"; else printf 'missing'; fi; }
container_field() { docker inspect "$1" --format "$2"; }
printf 'currentSha\t%s\n' "$(read_state "$STATE_DIR/current-sha")"
printf 'deployedAt\t%s\n' "$(read_state "$STATE_DIR/deployed-at")"
printf 'release\t%s\n' "$(readlink -f "$APP_ROOT/current")"
if [ -e "$MAINTENANCE_FILE" ]; then printf 'maintenance\tpresent\n'; else printf 'maintenance\tabsent\n'; fi
printf 'adminEnabled\t%s\n' "$(read_state "$STATE_DIR/admin-enabled")"
calls_enabled=$(read_state "$STATE_DIR/calls-enabled")
printf 'callsEnabled\t%s\n' "$calls_enabled"
printf 'targetImageId\t%s\n' "$(docker image inspect "quiet-room-app:$expected_sha" --format '{{.Id}}')"
for item in app:quiet-room-quiet-room-1 backup:quiet-room-quiet-room-backup-1; do
  role=${dollar}{item%%:*}; name=${dollar}{item#*:}
  printf '%sRunning\t%s\n' "$role" "$(container_field "$name" '{{.State.Running}}')"
  printf '%sHealth\t%s\n' "$role" "$(container_field "$name" '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
  printf '%sImageId\t%s\n' "$role" "$(container_field "$name" '{{.Image}}')"
  printf '%sImageRef\t%s\n' "$role" "$(container_field "$name" '{{.Config.Image}}')"
done
turn=quiet-room-quiet-room-turn-1
if docker inspect "$turn" >/dev/null 2>&1; then
  printf 'turnRunning\t%s\n' "$(container_field "$turn" '{{.State.Running}}')"
  printf 'turnHealth\t%s\n' "$(container_field "$turn" '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
else
  printf 'turnRunning\tabsent\nturnHealth\tabsent\n'
fi
`;

export const artifactProbe = String.raw`set -eu
container=quiet-room-quiet-room-1
for public_path in "$@"; do
  case "$public_path" in
    /) container_path=/app/dist/index.html;;
    /sw.js|/assets/*) container_path="/app/dist$public_path";;
    *) exit 64;;
  esac
  case "$public_path" in *..*|*//*) exit 64;; esac
  case "$public_path" in *[!A-Za-z0-9_./-]*) exit 64;; esac
  digest=$(docker exec "$container" sha256sum "$container_path")
  digest=${dollar}{digest%% *}
  printf '%s\t%s\n' "$public_path" "$digest"
done
`;

export class ReadbackError extends Error {
  constructor(classification, phase, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ReadbackError';
    this.classification = classification;
    this.phase = phase;
  }
}

export function parseReadbackArgs(args) {
  if (args.length !== 2 || args[0] !== '--sha' || !shaPattern.test(args[1])) {
    throw new ReadbackError('usage', 'arguments', 'Usage: node scripts/production-readback.mjs --sha <exact expected production SHA>');
  }
  return args[1];
}

function loadConfig() {
  const configPath = path.join(root, '.deploy.local.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  for (const [key, envName] of Object.entries({
    serverHost: 'QUIET_ROOM_SERVER_HOST', serverUser: 'QUIET_ROOM_SERVER_USER',
    serverKey: 'QUIET_ROOM_SERVER_KEY', githubKey: 'QUIET_ROOM_GITHUB_KEY',
  })) if (process.env[envName]) config[key] = process.env[envName];
  validateConfig(config);
  if (!existsSync(config.serverKey)) throw new Error('Configured server key is unavailable');
  return config;
}

function sshArgs(config, remoteArgs) {
  return [
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-i', config.serverKey, `${config.serverUser}@${config.serverHost}`, ...remoteArgs,
  ];
}

function spawn(program, args, options = {}) {
  return spawnSync(program, args, { encoding: 'utf8', timeout: 30000, ...options });
}

function checked(result, classification, phase, message) {
  if (!result.error && result.status === 0) return result.stdout ?? '';
  const kind = result.status === 255 || result.error?.code === 'ETIMEDOUT' ? 'connectivity' : classification;
  throw new ReadbackError(kind, phase, message, result.error);
}

function parsePairs(output, expectedKeys, phase, classification) {
  const values = {};
  for (const line of output.trim().split('\n')) {
    const separator = line.indexOf('\t');
    if (separator < 1) throw new ReadbackError(classification, phase, 'Production returned malformed readback data');
    const key = line.slice(0, separator);
    if (!expectedKeys.includes(key) || Object.hasOwn(values, key)) {
      throw new ReadbackError(classification, phase, 'Production returned unexpected readback data');
    }
    values[key] = line.slice(separator + 1);
  }
  if (expectedKeys.some(key => !Object.hasOwn(values, key))) {
    throw new ReadbackError(classification, phase, 'Production readback data is incomplete');
  }
  return values;
}

export function validateServerState(state, expectedSha) {
  const expectedRelease = `/opt/quiet-room/git-releases/${state.deployedAt}-${expectedSha.slice(0, 12)}`;
  if (state.currentSha !== expectedSha || !/^\d{8}T\d{6}Z$/.test(state.deployedAt) || state.release !== expectedRelease || state.maintenance !== 'absent') {
    throw new ReadbackError('production-state', 'validate-state', 'Production metadata does not match the expected completed deployment');
  }
  if (![state.adminEnabled, state.callsEnabled].every(value => value === '0' || value === '1')) {
    throw new ReadbackError('production-state', 'validate-state', 'Production feature-state metadata is invalid');
  }
  if (state.appRunning !== 'true' || state.backupRunning !== 'true' || state.appHealth !== 'healthy' || !['healthy', 'none'].includes(state.backupHealth)) {
    throw new ReadbackError('container-state', 'validate-state', 'Required production containers are not running with their declared health guarantees');
  }
  const turnMatchesState = state.callsEnabled === '1'
    ? state.turnRunning === 'true' && ['healthy', 'none'].includes(state.turnHealth)
    : state.turnRunning === 'absent' && state.turnHealth === 'absent';
  if (!turnMatchesState) throw new ReadbackError('container-state', 'validate-state', 'TURN container state does not match the persisted calling feature state');
  const expectedRef = `quiet-room-app:${expectedSha}`;
  if (!digestPattern.test(state.targetImageId) || state.appImageId !== state.targetImageId || state.backupImageId !== state.targetImageId || state.appImageRef !== expectedRef || state.backupImageRef !== expectedRef) {
    throw new ReadbackError('image-mismatch', 'validate-state', 'Running container images do not match the expected immutable image');
  }
  return state;
}

async function fetchBytes(publicPath) {
  const response = await fetch(`${origin}${publicPath}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (response.status !== 200 || response.url !== `${origin}${publicPath}`) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('Response exceeds readback limit');
  return bytes;
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function discoverPublicArtifacts(indexBytes) {
  const html = new TextDecoder().decode(indexBytes);
  const assets = [...new Set([...html.matchAll(/(?:src|href)=["'](\/assets\/[A-Za-z0-9._/-]+)["']/g)].map(match => match[1]))];
  const paths = ['/sw.js', ...assets];
  if (assets.length === 0 || assets.length > 64 || paths.some(item => !publicPathPattern.test(item) || path.posix.normalize(item) !== item || item.includes('..'))) {
    throw new ReadbackError('public-artifact', 'public-artifacts', 'Public index did not expose a valid versioned asset set');
  }
  return paths;
}

async function probeWebSocket() {
  await new Promise((resolve, reject) => {
    let opened = false;
    const socket = new WebSocket('wss://ai.shui.click/ws', { origin });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('timeout')); }, 10000);
    socket.once('open', () => { opened = true; socket.close(); });
    socket.once('close', () => { clearTimeout(timer); opened ? resolve() : reject(new Error('closed before opening')); });
    socket.once('error', error => { clearTimeout(timer); socket.terminate(); reject(error); });
  });
}

function defaultOperations(config) {
  const common = sshArgs(config, ['sudo', '-n', '/bin/sh', '-s', '--']);
  return {
    inspectState(expectedSha) {
      const result = spawn('ssh', [...common, expectedSha], { input: stateProbe, timeout: 30000 });
      const keys = ['currentSha', 'deployedAt', 'release', 'maintenance', 'adminEnabled', 'callsEnabled', 'targetImageId', 'appRunning', 'appHealth', 'appImageId', 'appImageRef', 'backupRunning', 'backupHealth', 'backupImageId', 'backupImageRef', 'turnRunning', 'turnHealth'];
      return parsePairs(checked(result, 'server-inspection', 'server-state', 'Could not inspect production state'), keys, 'server-state', 'server-inspection');
    },
    async inspectHealth() {
      const health = JSON.parse(new TextDecoder().decode(await fetchBytes('/api/health')));
      if (health?.ok !== true || health?.database !== true || health?.storage !== true) throw new Error('Health fields are not all true');
      return { ok: true, database: true, storage: true };
    },
    async inspectPublicArtifacts() {
      const indexBytes = await fetchBytes('/');
      const paths = discoverPublicArtifacts(indexBytes);
      const hashes = { '/': digest(indexBytes) };
      for (const publicPath of paths) hashes[publicPath] = digest(await fetchBytes(publicPath));
      return hashes;
    },
    inspectContainerArtifacts(publicHashes) {
      const paths = Object.keys(publicHashes);
      const result = spawn('ssh', [...common, ...paths], { input: artifactProbe, timeout: 30000 });
      const output = checked(result, 'server-inspection', 'container-artifacts', 'Could not hash running container artifacts');
      const containerHashes = parsePairs(output, paths, 'container-artifacts', 'public-artifact');
      for (const publicPath of paths) {
        if (!/^[0-9a-f]{64}$/.test(containerHashes[publicPath]) || containerHashes[publicPath] !== publicHashes[publicPath]) {
          throw new ReadbackError('public-artifact', 'container-artifacts', 'Public assets differ from the running container');
        }
      }
      return { matched: true, hashes: publicHashes };
    },
    probeWebSocket,
  };
}

function serializeError(error, fallbackClass, phase) {
  return error instanceof ReadbackError ? error : new ReadbackError(fallbackClass, phase, 'Readback phase failed', error);
}

export async function runReadback(expectedSha, operations, emit = console.log, clock = () => process.hrtime.bigint()) {
  const evidence = { schemaVersion: 1, mode: 'read-only', origin, expectedSha, startedAt: new Date().toISOString(), status: 'running', phases: [] };
  const started = clock();
  const phase = async (name, failureClass, operation) => {
    const phaseStarted = clock();
    try {
      const value = await operation();
      const durationMs = Number((clock() - phaseStarted) / 1_000_000n);
      evidence.phases.push({ name, result: 'success', durationMs });
      emit(`READBACK_TIMING phase=${name} result=success duration_ms=${durationMs}`);
      return value;
    } catch (cause) {
      const error = serializeError(cause, failureClass, name);
      const durationMs = Number((clock() - phaseStarted) / 1_000_000n);
      evidence.phases.push({ name, result: 'failure', classification: error.classification, durationMs });
      emit(`READBACK_TIMING phase=${name} result=failure class=${error.classification} duration_ms=${durationMs}`);
      throw error;
    }
  };
  try {
    evidence.server = await phase('server-state', 'server-inspection', () => operations.inspectState(expectedSha));
    await phase('validate-state', 'production-state', () => validateServerState(evidence.server, expectedSha));
    evidence.health = await phase('https-health', 'public-health', () => operations.inspectHealth());
    const publicHashes = await phase('public-artifacts', 'public-artifact', () => operations.inspectPublicArtifacts());
    evidence.artifacts = await phase('container-artifacts', 'public-artifact', () => operations.inspectContainerArtifacts(publicHashes));
    evidence.websocket = await phase('public-websocket', 'public-websocket', async () => { await operations.probeWebSocket(); return { connected: true }; });
    evidence.status = 'success';
  } catch (error) {
    evidence.status = 'failure';
    evidence.failure = { classification: error.classification, phase: error.phase };
    throw Object.assign(error, { evidence });
  } finally {
    evidence.durationMs = Number((clock() - started) / 1_000_000n);
    evidence.finishedAt = new Date().toISOString();
    const failureClass = evidence.failure ? ` class=${evidence.failure.classification}` : '';
    emit(`READBACK_TIMING phase=total result=${evidence.status}${failureClass} duration_ms=${evidence.durationMs}`);
  }
  return evidence;
}

export function saveEvidence(evidence, directory = path.join(root, '.git', 'quiet-room-readback')) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = evidence.startedAt.replaceAll(/[-:.]/g, '').replace('Z', 'Z');
  const target = path.join(directory, `${stamp}-${evidence.expectedSha.slice(0, 12)}-${evidence.status}.json`);
  const temporary = `${target}.partial-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, target);
  return target;
}

async function main() {
  const sha = parseReadbackArgs(process.argv.slice(2));
  const preflightStarted = process.hrtime.bigint();
  let config;
  try { config = loadConfig(); }
  catch (cause) {
    const durationMs = Number((process.hrtime.bigint() - preflightStarted) / 1_000_000n);
    console.log(`READBACK_TIMING phase=preflight result=failure class=configuration duration_ms=${durationMs}`);
    throw new ReadbackError('configuration', 'preflight', 'Readback configuration is unavailable or invalid', cause);
  }
  console.log(`READBACK_TIMING phase=preflight result=success duration_ms=${Number((process.hrtime.bigint() - preflightStarted) / 1_000_000n)}`);
  let evidence;
  try {
    evidence = await runReadback(sha, defaultOperations(config));
  } catch (error) {
    evidence = error.evidence ?? { schemaVersion: 1, mode: 'read-only', origin, expectedSha: sha, status: 'failure', failure: { classification: error.classification, phase: error.phase } };
    let evidenceFile = 'unavailable';
    try { evidenceFile = saveEvidence(evidence); } catch { /* Preserve the primary production failure. */ }
    console.error(`READBACK_BLOCKED class=${error.classification} phase=${error.phase} sha=${sha} retry=readback-only evidence_file=${JSON.stringify(evidenceFile)}`);
    throw error;
  }
  let evidenceFile;
  try { evidenceFile = saveEvidence(evidence); }
  catch (cause) {
    console.error(`READBACK_BLOCKED class=evidence-write phase=save-evidence sha=${sha} retry=readback-only evidence_file="unavailable"`);
    throw new ReadbackError('evidence-write', 'save-evidence', 'Production passed but the local evidence receipt could not be saved', cause);
  }
  console.log(`READBACK_OK sha=${sha} deployed_at=${evidence.server.deployedAt} evidence_file=${JSON.stringify(evidenceFile)}`);
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    if (!(error instanceof ReadbackError) || !['usage', 'configuration'].includes(error.classification)) process.exitCode = 1;
    else {
      const sha = shaPattern.test(process.argv[3] ?? '') ? ` sha=${process.argv[3]}` : '';
      console.error(`READBACK_BLOCKED class=${error.classification} phase=${error.phase}${sha} retry=fix-preflight`);
      process.exitCode = 64;
    }
  });
}
