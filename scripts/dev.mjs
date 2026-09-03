import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch', 'server/index.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: '8787', NODE_ENV: 'development' },
  }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], {
    stdio: 'inherit',
    env: process.env,
  }),
];

const stop = () => {
  for (const child of children) child.kill('SIGTERM');
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
}
