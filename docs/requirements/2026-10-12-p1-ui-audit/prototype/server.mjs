import http from 'node:http';
import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../../../..');
const evidence=process.env.P1_AUDIT_EVIDENCE||path.resolve(root,'../p1-ui-audit-evidence-20261012');
const groups=['current','renderers','calls','readers','photos','uploads','admin'];
const port=Number(process.env.PORT||4178);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.woff2':'font/woff2'};
const safe=(base,relative)=>{const p=path.resolve(base,relative);if(!p.startsWith(base+path.sep))throw Error('Forbidden');return p;};
const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://127.0.0.1');const p=decodeURIComponent(u.pathname);
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'");
  if(p==='/evidence.json'){
   const items=[];for(const group of groups)for(const name of await readdir(path.join(evidence,group)).catch(()=>[]))if(name.endsWith('.png'))items.push({group,name,url:`/evidence/${group}/${encodeURIComponent(name)}`});
   res.setHeader('Content-Type',mime['.json']);res.end(JSON.stringify(items));return;
  }
  if(p==='/standard.md'){res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(await readFile(path.join(root,'docs/design/mobile-visual-standard.md')));return;}
  let file;
  if(p.startsWith('/evidence/')){
   const [, ,group,name,...rest]=p.split('/');if(!groups.includes(group)||rest.length||!name?.endsWith('.png'))throw Error('Forbidden');file=safe(path.join(evidence,group),name);
  }else if(p.startsWith('/product-css/')){
   const relative=p.slice(13);if(!relative.startsWith('src/')||!['.css','.svg','.png','.webp','.woff2'].includes(path.extname(relative)))throw Error('Forbidden');file=safe(root,relative);
  }else if(p.startsWith('/avatar-emoji/')||p.startsWith('/emoji/')){file=safe(path.join(root,'public'),p.slice(1));if(!['.svg','.png','.webp','.gif'].includes(path.extname(file)))throw Error('Forbidden');
  }else if(['/','/index.html','/review.js','/surface.js','/review.css','/specimens.json','/css-order.json'].includes(p)){file=path.join(directory,p==='/'?'index.html':p.slice(1));}
  else{res.writeHead(404);res.end('Not found');return;}
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
 }catch(error){res.writeHead(error.message==='Forbidden'?403:404);res.end('Not available');}
});
server.listen(port,'127.0.0.1',()=>console.log(`P1 review http://127.0.0.1:${port} · synthetic prototype; no product API`));
