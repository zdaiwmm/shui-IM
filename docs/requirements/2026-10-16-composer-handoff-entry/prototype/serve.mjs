import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const base='/docs/requirements/2026-10-16-composer-handoff-entry/';
const entry=base+'prototype/index.html';
const materialsRoot=resolve(root,'.'+base)+'/';
const allowedAssets=new Set(['/src/design-tokens.css','/src/appearance.css','/src/entry-experience.css','/src/assets/chat-pattern.svg']);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.md':'text/plain; charset=utf-8'};
const port=Number(process.env.PORT ?? 5316);
http.createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    const filePath=path==='/'?entry:decodeURIComponent(path);
    const full=resolve(root,'.'+filePath);
    if(!(filePath.startsWith(base)&&full.startsWith(materialsRoot))&&!allowedAssets.has(filePath)){res.writeHead(404);res.end();return;}
    const bytes=await readFile(full);
    res.writeHead(200,{'Content-Type':types[extname(full)]??'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(bytes);
  }catch{res.writeHead(404);res.end();}
}).listen(port,'127.0.0.1',()=>console.log(`V1 prototype: http://127.0.0.1:${port}${entry}`));
