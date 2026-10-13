import { readFileSync } from 'node:fs';

const assets = new URL('./', import.meta.url);
export const deviceProfile = JSON.parse(readFileSync(new URL('device-profile.json', assets), 'utf8'));

/** Explicit dev-only plugin. The ordinary dev server and production build never install it. */
export function mobileDebugPlugin() {
  return {
    name: 'quiet-room-local-mobile-debug',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0];
        const routes = {
          '/__mobile-debug': ['text/html; charset=utf-8', 'shell.html'],
          '/__mobile-debug-bridge.js': ['text/javascript; charset=utf-8', 'safari-bridge.js'],
          '/__mobile-debug-profile': ['application/json; charset=utf-8', 'device-profile.json'],
        };
        if (!Object.hasOwn(routes, pathname)) return next();
        if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.host ?? '')) {
          response.statusCode = 403;
          return response.end('Mobile debug requires a loopback origin.');
        }
        const [type, filename] = routes[pathname];
        response.setHeader('Content-Type', type);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(readFileSync(new URL(filename, assets), 'utf8'));
      });
    },
    transformIndexHtml(_html, context) {
      if (!['/', '/index.html'].includes(context.path)) return;
      return [{ tag: 'script', attrs: { src: '/__mobile-debug-bridge.js' }, injectTo: 'head-prepend' }];
    },
  };
}
