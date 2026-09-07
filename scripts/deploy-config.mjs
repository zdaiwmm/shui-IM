import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_KEYS = {
  serverHost: 'QUIET_ROOM_SERVER_HOST',
  serverUser: 'QUIET_ROOM_SERVER_USER',
  serverKey: 'QUIET_ROOM_SERVER_KEY',
  githubKey: 'QUIET_ROOM_GITHUB_KEY',
};

export function userConfigPath() {
  const configured = process.env.QUIET_ROOM_DEPLOY_CONFIG;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('QUIET_ROOM_DEPLOY_CONFIG must be an absolute path');
    return configured;
  }
  return path.join(os.homedir(), '.config', 'quiet-room', 'deploy.json');
}

export function localConfigPath(root) {
  return path.join(root, '.deploy.local.json');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid deployment configuration: ${file}`, { cause: error });
  }
}

export function loadConfig(root) {
  const local = localConfigPath(root);
  const shared = userConfigPath();
  let config = {};
  let sourcePath = null;
  if (existsSync(local)) {
    config = readJson(local);
    sourcePath = local;
  } else if (existsSync(shared)) {
    config = readJson(shared);
    sourcePath = shared;
  }
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    if (process.env[envName]) config[key] = process.env[envName];
  }
  return { config, sourcePath };
}

export function validateConfig(config) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(config.serverHost ?? '')) throw new Error('Missing or invalid serverHost');
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(config.serverUser ?? '')) throw new Error('Missing or invalid serverUser');
  for (const key of ['serverKey', 'githubKey']) {
    if ((key === 'serverKey' || config[key]) && (typeof config[key] !== 'string' || !path.isAbsolute(config[key]))) {
      throw new Error(`${key} must be an absolute path`);
    }
  }
  return config;
}

export function assertKeyFiles(config) {
  for (const key of ['serverKey', 'githubKey']) {
    if (config[key] && !existsSync(config[key])) throw new Error(`Key file unavailable: ${key}`);
  }
  return config;
}

export function saveConfig(config, destination = userConfigPath()) {
  validateConfig(config);
  assertKeyFiles(config);
  const directory = path.dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const persisted = {
    serverHost: config.serverHost,
    serverUser: config.serverUser,
    serverKey: config.serverKey,
    ...(config.githubKey ? { githubKey: config.githubKey } : {}),
  };
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  return destination;
}
