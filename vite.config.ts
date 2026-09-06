import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

type Release = { id: string; title: string; notes: string[] };

const release = JSON.parse(readFileSync(resolve('release.json'), 'utf8')) as Release;
if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(release.id)
  || typeof release.title !== 'string' || release.title.trim().length === 0
  || !Array.isArray(release.notes) || release.notes.length === 0
  || release.notes.some(note => typeof note !== 'string' || note.trim().length === 0)) {
  throw new Error('release.json must contain a safe id, a title, and at least one non-empty note.');
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
    host: '127.0.0.1',
    port: 5173,
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
