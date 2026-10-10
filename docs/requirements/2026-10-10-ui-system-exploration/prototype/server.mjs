import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 8846);
const patternIndex = args.indexOf('--pattern');
const patternPath = patternIndex < 0 ? null : args[patternIndex + 1];
const root = path.dirname(fileURLToPath(import.meta.url));
const files = new Map(['index.html','styles.css','app.js','icons.js'].map(name => ['/'+name,path.join(root,name)]));
files.set('/',path.join(root,'index.html'));
files.set('/reference/board.html',path.join(root,'../static-style/board.html'));
if (patternPath && path.isAbsolute(patternPath)) files.set('/pattern.svg',patternPath);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const server = createServer(async (req,res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const url = new URL(req.url,'http://127.0.0.1');
  const file = files.get(url.pathname);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    let body = await readFile(file);
    if (url.pathname === '/reference/board.html') body = Buffer.from(body.toString().replace('</head>','</head>').replace('<style>','<style>:root{--wallpaper-pattern:url(/pattern.svg)}'));
    res.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Local preview asset is missing.'); }
});
server.listen(port,'127.0.0.1',()=>console.log('PROTOTYPE_READY http://127.0.0.1:'+server.address().port));
process.on('SIGINT',()=>server.close(()=>process.exit()));
