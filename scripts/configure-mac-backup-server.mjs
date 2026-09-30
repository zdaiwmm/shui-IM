import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, assertKeyFiles } from './deploy-config.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = assertKeyFiles(validateConfig(loadConfig(root).config));
const helper = readFileSync(path.join(root, 'deploy/server/quiet-room-mac-backup')).toString('base64');
const script = `import os, stat, base64, hashlib, tempfile, subprocess, fcntl
helper = base64.b64decode('${helper}')
user = '${config.serverUser}'
assert os.geteuid() == 0
lock = None
if '${process.argv.includes('--apply')}' == 'true':
 lock = open('/run/lock/quiet-room-deploy.lock', 'a')
 fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
parent = '/opt/quiet-room/shared'
env = parent + '/production.env'
assert not os.path.islink(parent) and not os.path.islink(env)
info = os.stat(env)
assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
original = open(env, 'rb').read()
assert b'\\x00' not in original
lines = original.decode('utf8').splitlines()
updated = '\\n'.join([line for line in lines if not line.startswith(('BACKUP_MODE=', 'BACKUP_TMPFS_SIZE='))] + ['BACKUP_MODE=mac-pull', 'BACKUP_TMPFS_SIZE=384m']) + '\\n'
target = '/usr/local/sbin/quiet-room-mac-backup'
if os.path.lexists(target):
 assert not os.path.islink(target) and open(target,'rb').read() == helper, 'EXISTING_HELPER_REQUIRES_REVIEW'
if '${process.argv.includes('--apply')}' == 'true':
 def atomic(destination, content, mode):
  fd, temporary = tempfile.mkstemp(prefix='.mac-backup-', dir=os.path.dirname(destination))
  try:
   os.fchmod(fd, mode)
   with os.fdopen(fd, 'wb') as out:
    out.write(content); out.flush(); os.fsync(out.fileno())
   os.replace(temporary, destination)
  finally:
   if os.path.exists(temporary): os.unlink(temporary)
 if user != 'root':
  sudo_path='/etc/sudoers.d/quiet-room-mac-backup'
  sudo_text=(user + ' ALL=(root) NOPASSWD: /usr/local/sbin/quiet-room-mac-backup ""\\n').encode()
  if os.path.lexists(sudo_path):
   assert not os.path.islink(sudo_path) and open(sudo_path,'rb').read()==sudo_text, 'EXISTING_SUDO_RULE_REQUIRES_REVIEW'
  fd, temporary=tempfile.mkstemp(prefix='.mac-sudo-',dir='/etc/sudoers.d')
  try:
   os.fchmod(fd,0o440)
   with os.fdopen(fd,'wb') as out: out.write(sudo_text)
   subprocess.check_call(['visudo','-cf',temporary],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   os.replace(temporary,sudo_path)
  finally:
   if os.path.exists(temporary): os.unlink(temporary)
 atomic(target,helper,0o755)
 saved = parent + '/.production.env.before-mac-' + hashlib.sha256(original).hexdigest()[:12]
 if not os.path.exists(saved):
  fd=os.open(saved,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as out: out.write(original); out.flush(); os.fsync(out.fileno())
 atomic(env, updated.encode(),0o600)
 print('MAC_BACKUP_SERVER_CONFIGURED_NO_CONTAINER_RESTART')
else:
 print('MAC_BACKUP_SERVER_PLAN_OK: root-owned fixed helper; argument-free sudo; mode mac-pull; tmpfs384m; no container restart')
`;
execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
 '-i', config.serverKey, `${config.serverUser}@${config.serverHost}`, 'sudo', '-n', 'python3', '-'], { input: script, stdio: ['pipe', 'inherit', 'inherit'], timeout: 30_000 });
