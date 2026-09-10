import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Each CI group has its own runner. Keep scripts within a group sequential:
// they share the checkout's Vite dependency cache and may use fixed ports.
// browser.e2e.mjs also executes the voice-flow and call-flow integration tests.
export const browserGroups = Object.freeze({
  '1': Object.freeze(['tests/browser.e2e.mjs']),
  '2': Object.freeze([
    'tests/frontend-lifecycle.e2e.mjs',
    'tests/release-update.e2e.mjs',
    'tests/chat-bottom-control.e2e.mjs',
    'tests/chat-list-viewport.e2e.mjs',
    'tests/message-timeline.e2e.mjs',
    'tests/desktop-privacy.e2e.mjs',
    'tests/desktop-session-flow.e2e.mjs',
    'tests/vault-resume.e2e.mjs',
    'tests/system-surfaces.e2e.mjs',
    'tests/file-flow.e2e.mjs',
    'tests/file-outbox.e2e.mjs',
    'tests/file-interactions.e2e.mjs',
    'tests/document-reader.e2e.mjs',
    'tests/meme-picker.e2e.mjs',
    'tests/unread-counter.e2e.mjs',
    'tests/reaction-history.e2e.mjs',
    'tests/message-deletion.e2e.mjs',
    'tests/vault-lifecycle.e2e.mjs',
    'tests/voice-lifecycle.e2e.mjs',
    'tests/voice-submission.e2e.mjs',
    'tests/cloud-backup-lifecycle.e2e.mjs',
    'tests/backup-admin-ui.e2e.mjs',
    'tests/chat-image-privacy.e2e.mjs',
    'tests/gallery-loading.e2e.mjs',
    'tests/photo-details.e2e.mjs',
    'tests/video-flow.e2e.mjs',
    'tests/voice-gestures.e2e.mjs',
    'tests/chat-tools.e2e.mjs',
    'tests/presence-circuit.e2e.mjs',
  ]),
});

export function selectBrowserScripts(group, shard) {
  if (group !== undefined && !Object.hasOwn(browserGroups, group)) throw new Error('Browser group must be 1 or 2.');
  const scripts = group === undefined ? Object.values(browserGroups).flat() : [...browserGroups[group]];
  if (shard === undefined) return scripts;
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error('Shard must be index/total.');
  const [index, total] = shard.split('/').map(Number);
  if (index > total || total > scripts.length) throw new Error('Shard exceeds selected script count.');
  return scripts.filter((_, offset) => offset % total === index - 1);
}

export function parseBrowserArguments(args) {
  const options = { group: undefined, list: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--list' && !options.list) options.list = true;
    else if (arg === '--shard' && options.shard === undefined) {
      options.shard = args[++index];
      if (!options.shard) throw new Error('Shard must be index/total.');
    }
    else if (arg === '--group' && options.group === undefined) {
      options.group = args[++index];
      if (!['1', '2'].includes(options.group)) throw new Error('Browser group must be 1 or 2.');
    } else throw new Error(`Unknown or duplicate browser argument: ${arg}`);
  }
  selectBrowserScripts(options.group, options.shard);
  return options;
}

function interrupted(signal) {
  return Object.assign(new Error(`Browser tests interrupted (${signal?.reason ?? 'aborted'}).`), {
    exitCode: signal?.reason === 'SIGINT' ? 130 : 143,
  });
}

export function runBrowserScript(script, { signal, cwd = root } = {}) {
  if (signal?.aborted) return Promise.reject(interrupted(signal));
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, [script], { cwd, stdio: 'inherit', detached: grouped });
    let forceTimer;
    let spawnError;
    function stop(killSignal) {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, killSignal);
        else child.kill(killSignal);
      } catch (error) {
        if (error.code !== 'ESRCH') spawnError ??= error;
      }
    }
    function abort() {
      stop('SIGTERM');
      forceTimer = setTimeout(() => stop('SIGKILL'), 5000);
    }
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, childSignal) => {
      signal?.removeEventListener('abort', abort);
      clearTimeout(forceTimer);
      // A crashed test must not leave its browser/server descendants behind.
      if (grouped) stop('SIGKILL');
      if (signal?.aborted) reject(interrupted(signal));
      else if (spawnError) reject(spawnError);
      else if (code !== 0 || childSignal) reject(Object.assign(
        new Error(`${script} exited with ${childSignal ?? `code ${code}`}.`),
        { exitCode: Number.isInteger(code) && code > 0 ? code : 1 },
      ));
      else resolve();
    });
  });
}

export async function runBrowserTests({ group, shard, signal, run = runBrowserScript, log = console.log, now = () => performance.now() } = {}) {
  const scripts = selectBrowserScripts(group, shard);
  const started = now();
  let completed = 0;
  let passed = 0;
  log(`[browser] ${group ? `Group ${group}` : 'All groups'}: ${scripts.length} scripts, running sequentially.`);
  try {
    for (const script of scripts) {
      if (signal?.aborted) throw interrupted(signal);
      const stepStarted = now();
      log(`[browser] START ${completed + 1}/${scripts.length} ${script}`);
      try {
        await run(script, { signal });
        passed++;
        log(`[browser] PASS ${script} ${((now() - stepStarted) / 1000).toFixed(2)}s`);
      } catch (error) {
        log(`[browser] FAIL ${script} ${((now() - stepStarted) / 1000).toFixed(2)}s`);
        throw error;
      } finally {
        completed++;
      }
    }
  } finally {
    log(`[browser] TOTAL ${((now() - started) / 1000).toFixed(2)}s; ${passed} passed, ${completed - passed} failed, ${scripts.length - completed} not run.`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort('SIGINT');
  const onTerminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const options = parseBrowserArguments(process.argv.slice(2));
    if (options.list) console.log(selectBrowserScripts(options.group, options.shard).join('\n'));
    else await runBrowserTests({ group: options.group, shard: options.shard, signal: controller.signal });
  } catch (error) {
    console.error(`BROWSER_TESTS_FAILED: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
