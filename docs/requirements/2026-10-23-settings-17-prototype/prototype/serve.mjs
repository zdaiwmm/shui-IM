import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, extname} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const prefix = '/docs/requirements/2026-10-23-settings-17-prototype/prototype/';
const arg = process.argv.indexOf('--port');
const port = arg < 0 ? 5399 : Number(process.argv[arg + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须为 1024–65535');
const shared = new Set(['/src/design-tokens.css', '/src/appearance.css', '/src/assets/chat-pattern.svg']);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.md':'text/plain; charset=utf-8'};
const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405).end(); return;}
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') {res.writeHead(302, {Location:prefix + 'index.html'}).end(); return;}
    const path = pathname.startsWith(prefix) ? resolve(here, pathname.slice(prefix.length)) : shared.has(pathname) ? resolve(root, '.' + pathname) : null;
    if (!path || (!path.startsWith(here + '/') && !shared.has(pathname))) {res.writeHead(404).end('Not found'); return;}
    const content = await readFile(path);
    res.writeHead(200, {'Content-Type':mime[extname(path)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'"});
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {res.writeHead(404).end('Not found');}
});
server.on('error', error => {console.error(error.message); process.exitCode=1;});
server.listen(port, '127.0.0.1', () => console.log(`Chamber 原型 V1.1：http://127.0.0.1:${port}${prefix}index.html\n流程图：http://127.0.0.1:${port}${prefix}flow.html\n仅监听本机；不启动应用、API、数据库或 Service Worker。`));
