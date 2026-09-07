import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, timingSafeEqual, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
  return value;
}

export function parseLanArguments(args) {
  const options = { host: '', cert: '', key: '', port: 5173 };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--host') options.host = valueAfter(args, index++, flag);
    else if (flag === '--cert') options.cert = valueAfter(args, index++, flag);
    else if (flag === '--key') options.key = valueAfter(args, index++, flag);
    else if (flag === '--port') options.port = Number(valueAfter(args, index++, flag));
    else fail(`Unknown option: ${flag}`);
  }

  options.host = options.host.trim().toLowerCase().replace(/\.$/, '');
  if (!options.host) fail('Missing --host (for example: quiet-room-mac.local)');
  if (options.host === 'localhost' || isIP(options.host) || !options.host.includes('.')
    || options.host.length > 253 || !options.host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail('--host must be a valid LAN hostname, not localhost or a bare IP address');
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) fail('--port must be an integer from 1 to 65535');
  options.cert = path.resolve(projectRoot, options.cert || `.keys/lan/${options.host}.pem`);
  options.key = path.resolve(projectRoot, options.key || `.keys/lan/${options.host}-key.pem`);
  return options;
}

export function validateLanCertificate({ host, cert, key }, now = Date.now()) {
  if (!existsSync(cert)) fail(`Certificate not found: ${cert}`);
  if (!existsSync(key)) fail(`Private key not found: ${key}`);
  let certificate;
  let privateKey;
  try {
    certificate = new X509Certificate(readFileSync(cert));
  } catch {
    fail('LAN certificate is not a readable X.509 certificate');
  }
  try {
    privateKey = createPrivateKey(readFileSync(key));
  } catch {
    fail('LAN private key is not readable');
  }
  if (!certificate.checkHost(host)) fail(`LAN certificate does not include ${host} in its subjectAltName`);
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) fail('LAN certificate is not currently valid');
  const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const suppliedKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (certificateKey.length !== suppliedKey.length || !timingSafeEqual(certificateKey, suppliedKey)) {
    fail('LAN certificate and private key do not match');
  }
}

export function lanEnvironment(options, base = process.env) {
  return {
    ...base,
    QUIET_ROOM_LAN_HOSTNAME: options.host,
    QUIET_ROOM_LAN_CERT: options.cert,
    QUIET_ROOM_LAN_KEY: options.key,
    QUIET_ROOM_LAN_PORT: String(options.port),
  };
}

export function startLanDevelopment(args = process.argv.slice(2)) {
  const options = parseLanArguments(args);
  validateLanCertificate(options);
  const environment = lanEnvironment(options);
  const children = [
    // Keep the LAN backend deterministic. Vite still hot-reloads frontend work;
    // restart this command after server-side changes.
    spawn(process.execPath, ['server/index.mjs'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...environment, HOST: '127.0.0.1', PORT: '8787', NODE_ENV: 'development' },
    }),
    spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: environment,
    }),
  ];

  console.log(`LAN HTTPS: https://${options.host}:${options.port}`);
  console.log('Backend remains loopback-only at http://127.0.0.1:8787');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (const child of children) {
    child.on('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
      stop();
    });
    child.on('exit', (code) => {
      if (!stopping) {
        if (code !== 0) process.exitCode = code ?? 1;
        stop();
      }
    });
  }
  return { children, options };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    startLanDevelopment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
