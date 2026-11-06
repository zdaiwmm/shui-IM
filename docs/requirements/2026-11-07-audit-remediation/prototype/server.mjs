import {createServer} from 'vite';
import {readFile} from 'node:fs/promises';
const styles=[...(await readFile('src/main.ts','utf8')).matchAll(/import '(\.\/[^']+\.css)'/g)].map(x=>'/src/'+x[1].slice(2));
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'warn',server:{host:'127.0.0.1',port:4187,strictPort:true,hmr:false},plugins:[{name:'prototype-styles',configureServer(vite){vite.middlewares.use('/prototype-style-order.json',(_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(styles))})}}]});
await server.listen();console.log('PROTOTYPE http://127.0.0.1:4187/docs/requirements/2026-11-07-audit-remediation/prototype/');
