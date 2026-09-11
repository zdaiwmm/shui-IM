import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import qrcode from 'qrcode';
import { makeAdminConfig, totp } from '../server/admin-auth.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out' || !process.stdin.isTTY) {
  console.error('Usage: node scripts/admin-setup.mjs --out /secure/path/admin.json (interactive terminal required)');
  process.exit(1);
}
const target = path.resolve(args[1]);
let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
const rl = createInterface({ input: process.stdin, output, terminal: true });
const ask = async (label, hidden = false) => {
  process.stdout.write(label); muted = hidden;
  try { return await rl.question(''); } finally { muted = false; if (hidden) process.stdout.write('\n'); }
};
try {
  let password = await ask('管理员密码（至少 16 个字符）：', true);
  let confirmation = await ask('再次输入密码：', true);
  if (password !== confirmation) throw new Error('两次密码不一致');
  const config = await makeAdminConfig(password);
  password = ''; confirmation = '';
  const uri = `otpauth://totp/Quiet%20Room:admin.mijiu.cloud?secret=${config.totpSecret}&issuer=Quiet%20Room&algorithm=SHA1&digits=6&period=30`;
  process.stdout.write('请用 Google Authenticator 扫描下方二维码。二维码和配置文件都应保密。\n');
  process.stdout.write(await qrcode.toString(uri, { type: 'terminal', small: true }));
  const code = await ask('输入验证器显示的 6 位动态码完成绑定：');
  const step = Math.floor(Date.now() / 30_000);
  if (![step - 1, step, step + 1].some(counter => totp(config.totpSecret, counter) === code.trim())) throw new Error('动态码不正确，未创建配置文件');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  process.stdout.write(`已创建管理员配置：${target}\n请离线保管验证器的应急副本；更换配置需要服务器维护权限。\n`);
} finally { rl.close(); }
