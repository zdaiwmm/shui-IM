import { cp, mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Generates an inspectable plan first. No host credentials are printed or copied.
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = os.homedir();
const destination = path.join(home, 'quiet-room-backups', 'production');
const config = process.env.QUIET_ROOM_DEPLOY_CONFIG;
if (process.platform !== 'darwin' || !config || !path.isAbsolute(config)) throw Error('MAC_AND_EXISTING_DEPLOY_CONFIG_REQUIRED');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()) throw Error('COMMITTED_CLEAN_RUNNER_REQUIRED');
const runner = path.join(home, 'Library', 'Application Support', 'QuietRoomBackup', sourceSha);
const label = 'click.shui.quiet-room-backup';
const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const logs = path.join(destination, 'logs');
const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>${escape(process.execPath)}</string><string>${escape(path.join(runner, 'scripts/mac-backup.mjs'))}</string><string>--scheduled</string></array>
<key>EnvironmentVariables</key><dict><key>QUIET_ROOM_DEPLOY_CONFIG</key><string>${escape(config)}</string><key>QUIET_ROOM_MAC_BACKUP_DIR</key><string>${escape(path.join(destination, 'continuous'))}</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>
<key>WorkingDirectory</key><string>${escape(runner)}</string>
<key>StandardOutPath</key><string>${escape(path.join(logs, 'backup.log'))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(logs, 'backup-error.log'))}</string>
</dict></plist>
`;
const files = ['server/backup-transfer.mjs', 'server/backup.mjs', 'server/backup-lock.mjs', 'server/backup-retention.mjs',
 'scripts/mac-backup.mjs', 'scripts/backup-capacity.mjs', 'scripts/deploy-config.mjs'];
console.log(JSON.stringify({ sourceSha, runner, plist, destination, intervalSeconds: 300, snapshotIntervalHours: 12, files, apply: process.argv.includes('--apply') }));
if (process.argv.includes('--apply')) {
 if (await lstat(plist).catch(() => null)) throw Error('EXISTING_AGENT_REQUIRES_REVIEW');
 for (const directory of [destination, path.join(destination, 'continuous'), logs, runner]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory || (await lstat(directory)).mode & 0o077) throw Error('INSTALL_DIRECTORY_NOT_PRIVATE');
 }
 for (const file of files) {
  const target = path.join(runner, file); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await cp(path.join(source, file), target, { errorOnExist: true, force: false });
 }
 await writeFile(path.join(runner, 'package.json'), '{"type":"module"}\n', { mode: 0o600, flag: 'wx' });
 await mkdir(path.dirname(plist), { recursive: true });
 for (const name of ['backup.log', 'backup-error.log']) {
  await writeFile(path.join(logs, name), '', { mode: 0o600, flag: 'wx' });
 }
 await writeFile(plist, contents, { mode: 0o600, flag: 'wx' });
 execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'inherit' });
 // Explicit bootstrap after production helper/mode setup. Installation alone does not start transfers.
}
