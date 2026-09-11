import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

type Release = { id: string; title: string; notes: string[]; createdAt?: string };

const release = JSON.parse(readFileSync(resolve('release.json'), 'utf8')) as Release;
const releaseHistory = JSON.parse(readFileSync(resolve('release-history.json'), 'utf8')) as Release[];
if ([release, ...releaseHistory].some(item => item.createdAt !== undefined
  && (typeof item.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(item.createdAt) || !Number.isFinite(Date.parse(item.createdAt))))) {
  throw new Error('Release record times must be valid ISO timestamps.');
}
if (!Array.isArray(releaseHistory) || new Set([...releaseHistory.map(item => item.id), release.id]).size !== releaseHistory.length + 1
  || releaseHistory.some(item => typeof item.id !== 'string' || typeof item.title !== 'string' || !Array.isArray(item.notes)
    || !item.notes.length || item.notes.some(note => typeof note !== 'string' || !note.trim()))) {
  throw new Error('release-history.json must contain unique historical releases and non-empty notes.');
}
if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(release.id)
  || typeof release.title !== 'string' || release.title.trim().length === 0
  || !Array.isArray(release.notes) || release.notes.length === 0
  || release.notes.some(note => typeof note !== 'string' || note.trim().length === 0)) {
  throw new Error('release.json must contain a safe id, a title, and at least one non-empty note.');
}

const lanHostname = process.env.QUIET_ROOM_LAN_HOSTNAME?.trim();
const lanCertificate = process.env.QUIET_ROOM_LAN_CERT?.trim();
const lanKey = process.env.QUIET_ROOM_LAN_KEY?.trim();
const lanPort = Number(process.env.QUIET_ROOM_LAN_PORT ?? 5173);
const lanMode = Boolean(lanHostname || lanCertificate || lanKey);
if (lanMode && (!lanHostname || !lanCertificate || !lanKey || !Number.isInteger(lanPort) || lanPort < 1 || lanPort > 65535)) {
  throw new Error('LAN HTTPS requires a hostname, certificate, private key, and valid port. Use npm run dev:lan.');
}

export default defineConfig({
  plugins: [{
    name: 'quiet-room-release-worker',
    apply: 'build',
    closeBundle() {
      const workerPath = resolve('dist/sw.js');
      const worker = readFileSync(workerPath, 'utf8');
      const placeholder = '__QUIET_ROOM_RELEASE_ID__';
      if (!worker.includes(placeholder)) throw new Error('Service worker release placeholder is missing.');
      writeFileSync(workerPath, worker.replaceAll(placeholder, release.id));
    },
  }],
  server: {
    host: lanMode ? '0.0.0.0' : '127.0.0.1',
    port: lanMode ? lanPort : 5173,
    strictPort: lanMode,
    allowedHosts: lanMode ? [lanHostname!] : undefined,
    https: lanMode ? {
      cert: readFileSync(resolve(lanCertificate!)),
      key: readFileSync(resolve(lanKey!)),
    } : undefined,
    hmr: lanMode ? { protocol: 'wss', host: lanHostname!, clientPort: lanPort } : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: { input: { app: 'index.html', admin: 'admin.html' } },
    target: 'es2022',
    sourcemap: false,
  },
});
