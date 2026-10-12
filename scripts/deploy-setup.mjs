import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertKeyFiles, loadConfig, localConfigPath, saveConfig, validateConfig, userConfigPath, targetArguments } from './deploy-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function usage() {
  return [
    'Usage: npm run deploy:setup -- [--environment <name> --origin <https-origin>] --host <host> --user <user> --server-key <absolute-path> [--github-key <absolute-path>] [--platform linux/amd64|linux/arm64]',
    '',
    'Writes only host, user, and key paths to the per-user config used by every worktree.',
    'Set QUIET_ROOM_DEPLOY_CONFIG to choose a different config path for a controlled environment.',
  ].join('\n');
}

export function parseSetupArgs(args) {
  const target = targetArguments(args);
  args = target.args;
  const values = target.environment ? { environment: target.environment } : {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const key = { '--host': 'serverHost', '--user': 'serverUser', '--server-key': 'serverKey', '--github-key': 'githubKey', '--origin': 'publicOrigin', '--platform': 'imagePlatform' }[flag];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--') || values[key]) throw new Error(`Invalid arguments.\n${usage()}`);
    values[key] = args[++index];
  }
  if (!values.serverHost || !values.serverUser || !values.serverKey) throw new Error(`Missing required arguments.\n${usage()}`);
  return values;
}

export function setupConfig(args, rootDir = root) {
  const updates = parseSetupArgs(args);
  const hasExisting = !updates.environment || existsSync(localConfigPath(rootDir, updates.environment)) || existsSync(userConfigPath(updates.environment));
  const existing = hasExisting ? loadConfig(rootDir, updates.environment).config : {};
  const config = { ...existing, ...updates };
  validateConfig(config);
  assertKeyFiles(config);
  return saveConfig(config, userConfigPath(updates.environment));
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.slice(2).includes('--help')) {
      console.log(usage());
    } else {
      const destination = setupConfig(process.argv.slice(2));
      console.log(`Deployment configuration saved: ${destination}`);
    }
  } catch (error) {
    console.error(`DEPLOY_SETUP_BLOCKED: ${error.message}`);
    process.exitCode = 1;
  }
}
