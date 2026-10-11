import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { avatarCatalog } from './avatar-catalog.mjs';

// Only the prototype and its existing public design assets can be served.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const prefix = '/docs/requirements/2026-10-11-space-list-navigation/prototype/';
const allowed = new Set([
  ...['index.html', 'prototype.css', 'prototype.js', 'avatar-catalog.mjs'].map(file => prefix + file),
  '/src/design-tokens.css', '/src/appearance.css', '/src/motion.css', '/src/assets/chat-pattern.svg',
]);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const avatarFiles = new Map(avatarCatalog.map(item => [prefix + `avatars/${item.codepoint}.webp`, path.join(tmpdir(), 'quiet-room-space-navigation-avatars', `${item.codepoint}.webp`)]));
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.writeHead(302, { Location: prefix + 'index.html' + url.search }).end(); return; }
  const file = url.pathname;
  if (!['GET', 'HEAD'].includes(request.method) || !allowed.has(file) && !avatarFiles.has(file)) { response.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(avatarFiles.get(file) || path.join(root, file));
    response.writeHead(200, {
      'Content-Type': `${types[path.extname(file)]}${path.extname(file) === '.webp' ? '' : '; charset=utf-8'}`, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(500).end('Prototype asset unavailable'); }
});
const port = Number(process.env.QR_PROTOTYPE_PORT || 4187);
server.listen(port, '127.0.0.1', () => console.log(`Prototype: http://127.0.0.1:${port}/`));
