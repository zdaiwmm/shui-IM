import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import qrcode from 'qrcode';
import { makeAdminConfig, totp } from '../server/admin-auth.mjs';

const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== '--out' || (args.length === 4 && args[2] !== '--origin') || !process.stdin.isTTY) {
  console.error('Usage: node scripts/admin-setup.mjs --out /secure/path/admin.json [--origin https://admin.example.com] (interactive terminal required)');
  process.exit(1);
}
const target = path.resolve(args[1]);
const origin = new URL(args[3] ?? 'https://admin.mijiu.cloud');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('管理员来源须为独立 HTTPS 来源');
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
try {
  const config = await makeAdminConfig();
  const uri = `otpauth://totp/${encodeURIComponent(`Quiet Room:${origin.host}`)}?secret=${config.totpSecret}&issuer=Quiet%20Room&algorithm=SHA1&digits=6&period=30`;
  process.stdout.write('请用 Google Authenticator 扫描下方二维码。二维码和配置文件都应保密。\n');
  process.stdout.write(await qrcode.toString(uri, { type: 'terminal', small: true }));
  const code = await rl.question('输入验证器显示的 6 位动态码完成绑定：');
  const step = Math.floor(Date.now() / 30_000);
  if (![step - 1, step, step + 1].some(counter => totp(config.totpSecret, counter) === code.trim())) throw new Error('动态码不正确，未创建配置文件');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  process.stdout.write(`已创建管理员配置：${target}\n请离线保管验证器的应急副本；更换配置需要服务器维护权限。\n`);
} finally { rl.close(); }
