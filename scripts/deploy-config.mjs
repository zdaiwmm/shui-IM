import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_KEYS = {
  serverHost: 'QUIET_ROOM_SERVER_HOST',
  serverUser: 'QUIET_ROOM_SERVER_USER',
  serverKey: 'QUIET_ROOM_SERVER_KEY',
  githubKey: 'QUIET_ROOM_GITHUB_KEY',
};

export function deploymentEnvironment(value = process.env.QUIET_ROOM_DEPLOY_ENVIRONMENT) {
  if (value !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error('Invalid deployment environment');
  return value;
}

export function targetArguments(args) {
  const rest = [...args];
  const index = rest.indexOf('--environment');
  if (index < 0) return { args: rest, environment: deploymentEnvironment() };
  const environment = deploymentEnvironment(rest[index + 1]);
  if (!environment) throw new Error('Missing deployment environment');
  rest.splice(index, 2);
  if (rest.includes('--environment')) throw new Error('Duplicate deployment environment');
  return { args: rest, environment };
}

export function publicOrigin(config) {
  const value = config.publicOrigin ?? 'https://ai.shui.click';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.port || url.username || url.password || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(url.hostname)) throw new Error('Invalid publicOrigin');
  return value;
}

export function assertInitializationTarget(environment, config) {
  if (!environment || environment === 'production' || config.environment !== environment ||
      !config.publicOrigin || publicOrigin(config) === 'https://ai.shui.click') {
    throw new Error('Initialization requires an explicit, independent named environment');
  }
}

export function userConfigPath(environment = deploymentEnvironment()) {
  const configured = process.env.QUIET_ROOM_DEPLOY_CONFIG;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('QUIET_ROOM_DEPLOY_CONFIG must be an absolute path');
    return configured;
  }
  return path.join(os.homedir(), '.config', 'quiet-room', ...(environment ? ['environments', `${environment}.json`] : ['deploy.json']));
}

export function localConfigPath(root, environment = deploymentEnvironment()) {
  return path.join(root, environment ? `.deploy.${environment}.local.json` : '.deploy.local.json');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid deployment configuration: ${file}`, { cause: error });
  }
}

export function loadConfig(root, environment = deploymentEnvironment()) {
  const local = localConfigPath(root, environment);
  const shared = userConfigPath(environment);
  let config = {};
  let sourcePath = null;
  if (existsSync(local)) {
    config = readJson(local);
    sourcePath = local;
  } else if (existsSync(shared)) {
    config = readJson(shared);
    sourcePath = shared;
  }
  if (environment && (!sourcePath || config.environment !== environment)) throw new Error('Selected deployment environment is missing or mismatched');
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    // Legacy target overrides must not silently redirect a named environment.
    if (environment && key !== 'githubKey') continue;
    if (process.env[envName]) config[key] = process.env[envName];
  }
  return { config, sourcePath, environment };
}

export function validateConfig(config) {
  publicOrigin(config);
  if (config.environment !== undefined) {
    deploymentEnvironment(config.environment);
    if (!config.publicOrigin) throw new Error('Named environment requires publicOrigin');
  }
  if (config.imagePlatform !== undefined && !['linux/amd64', 'linux/arm64'].includes(config.imagePlatform)) throw new Error('Invalid imagePlatform');
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
    ...(config.environment ? { environment: config.environment } : {}),
    ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
    ...(config.imagePlatform ? { imagePlatform: config.imagePlatform } : {}),
  };
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  return destination;
}
