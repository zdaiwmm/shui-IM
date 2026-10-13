import { spawn } from 'node:child_process';
import { createServer as createSocketServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { mobileDebugPlugin } from '../tools/mobile-debug/plugin.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function parseMobileArguments(args, root = projectRoot) {
  const options = { port: 5185, apiPort: 8787, dataDir: path.join(root, 'data', 'mobile-debug'), watch: true };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--no-watch') { options.watch = false; continue; }
    if (!['--port', '--api-port', '--data-dir'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--data-dir') options.dataDir = path.resolve(root, value);
    else options[flag === '--port' ? 'port' : 'apiPort'] = Number(value);
  }
  for (const port of [options.port, options.apiPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ports must be integers from 1 to 65535.');
  }
  if (options.port === options.apiPort) throw new Error('Frontend and API ports must differ.');
  return options;
}

export async function assertPortAvailable(port) {
  const probe = createSocketServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}

export async function startMobileDevelopment(args = [], { root = projectRoot, quiet = false } = {}) {
  const options = parseMobileArguments(args, root);
  if (Object.keys(process.env).some(key => key.startsWith('QUIET_ROOM_LAN_') && process.env[key])) {
    throw new Error('Mobile debug is loopback-only. Start it without QUIET_ROOM_LAN_* overrides.');
  }
  await assertPortAvailable(options.port);
  await assertPortAvailable(options.apiPort);
  let frontend;
  let stopping = false;
  let running = false;
  let closePromise;
  let backendError;
  let backendStarted = false;
  let startupOutput = '';
  const backend = spawn(process.execPath, [...(options.watch ? ['--watch'] : []), 'server/index.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(options.apiPort), DATA_DIR: options.dataDir, NODE_ENV: 'development' },
  });
  backend.stdout.on('data', chunk => {
    if (!quiet) process.stdout.write(chunk);
    if (!backendStarted) {
      startupOutput = (startupOutput + chunk.toString()).slice(-2048);
      backendStarted = startupOutput.includes(`Quiet Room listening on http://127.0.0.1:${options.apiPort}`);
      if (backendStarted) startupOutput = '';
    }
  });
  const close = () => closePromise ??= (async () => {
    stopping = true;
    const exited = new Promise(resolve => {
      if (backend.exitCode !== null || backend.signalCode !== null) resolve();
      else backend.once('close', resolve);
    });
    backend.kill('SIGTERM');
    await frontend?.close();
    await exited;
  })();
  backend.once('error', error => { backendError = error; if (running) void close(); });
  backend.once('exit', code => {
    if (!stopping) { backendError = new Error(`Mobile debug backend exited (${code}).`); if (running) { console.error(backendError.message); void close(); } }
  });
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (backendError) throw backendError;
      try {
        const response = await fetch(`http://127.0.0.1:${options.apiPort}/api/health`, { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        ready = backendStarted && response.ok && health.ok === true && health.database === true && health.storage === true;
      } catch { /* Startup is bounded; never replace an existing listener. */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Mobile debug backend did not become healthy within 15 seconds.');
    frontend = await createServer({
      root, configFile: path.join(root, 'vite.config.ts'), plugins: [mobileDebugPlugin()],
      logLevel: quiet ? 'error' : 'info',
      server: {
        host: '127.0.0.1', port: options.port, strictPort: true,
        proxy: { '/api': `http://127.0.0.1:${options.apiPort}`, '/ws': { target: `ws://127.0.0.1:${options.apiPort}`, ws: true } },
      },
    });
    await frontend.listen();
    if (backendError) throw backendError;
    running = true;
    const url = `http://localhost:${options.port}/__mobile-debug`;
    if (!quiet) {
      console.log(`MOBILE_DEBUG_READY ${url}`);
      console.log(`Data: ${options.dataDir}; API: loopback ${options.apiPort}`);
      console.log('Authorize only this local origin in Codex, apply tools/mobile-debug/device-profile.json, then verify UA/touch/DPR.');
    }
    return { options, url, frontend, backend, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const running = await startMobileDevelopment(process.argv.slice(2));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void running.close(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
