import {createServer} from 'vite';
const route='/docs/requirements/2026-10-23-media-playback-viewer/prototype/';
const server=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[{name:'prototype-entry',configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url==='/'){res.statusCode=302;res.setHeader('Location',route);res.end();return}next()})}}],server:{host:'127.0.0.1',port:5210,strictPort:true,hmr:false}});
await server.listen();
console.log(`MEDIA_PROTOTYPE_V1 http://127.0.0.1:5210${route} pid=${process.pid}`);
