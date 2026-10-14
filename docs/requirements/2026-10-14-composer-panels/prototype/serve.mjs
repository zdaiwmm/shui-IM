import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const entry='/docs/requirements/2026-10-14-composer-panels/prototype/';
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.webp':'image/webp','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
  try {
    let path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(path==='/'||path===entry)path=entry+'index.html';
    const allowed=path.startsWith(entry)||path.startsWith('/public/space-avatars/')||['/src/design-tokens.css','/src/appearance.css','/src/assets/chat-pattern.svg'].includes(path);
    const file=resolve(root,'.'+path);
    if(!allowed||!file.startsWith(root)){res.writeHead(404);res.end();return;}
    const body=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]??'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);
  }catch{res.writeHead(404);res.end();}
}).listen(5314,'127.0.0.1',()=>console.log(`Prototype: http://127.0.0.1:5314${entry}`));
