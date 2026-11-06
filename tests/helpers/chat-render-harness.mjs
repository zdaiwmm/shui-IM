import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

/** Synthetic history, actual renderer/CSS. No transport or authentication claim. */
export async function startChatRenderHarness() {
  const styles = [...(await readFile('src/main.ts', 'utf8')).matchAll(/import '(\.\/[^']+\.css)'/g)].map(x => '/src/' + x[1].slice(2));
  const vite = await createServer({ root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'chat-window-test', configureServer(server) { server.middlewares.use('/__chat_window', (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');
    }); } }] });
  await vite.listen();
  return {
    close: () => vite.close(),
    async setup(page, size = 10000, { listScroll = false } = {}) {
      await page.goto(`http://localhost:${vite.httpServer.address().port}/__chat_window`);
      return page.evaluate(async ({ styles, size, listScroll }) => {
        for (const style of styles.slice(0, 9)) await import(style);
        const { QuietRoomApp } = await import('/src/app.ts'), vault = await import('/src/lib/vault.ts');
        for (const style of styles.slice(9)) await import(style);
        const own = { deviceId: 'window-own', role: 'creator', status: 'active' }, peer = { deviceId: 'window-peer', role: 'joiner', status: 'active' };
        const session = await vault.createVault({ v: 1, roomId: 'synthetic-chat-window', accessToken: 'synthetic', role: 'creator', protocol: 'legacy-v1', lastSeq: size,
          members: [own, peer], identity: { publicBundle: own } }, 'synthetic-window-test', 'password');
        const app = new QuietRoomApp(document.querySelector('#app'));
        app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
        app.updateSafetyCode = async () => {}; app.updateBackgroundNotificationControl = async () => {};
        app.mountChatImageObserver = () => {}; app.mountGalleryThumbnails = () => {};
        app.scheduleUiPreferencesSave = () => {};
        app.uiPreferences = {}; app.uiPreferencesHydrated = true; app.restoreChatAnchorOnNextRender = false;
        if (listScroll) app.usesListScrolling = true;
        app.renderChat(); window.chatTest = app;
        window.chatMessage = seq => ({ seq, clientMsgId: `window-${seq}`, senderId: seq % 3 ? 'window-peer' : 'window-own', status: 'delivered',
          acceptedAt: '2026-11-07T00:00:00Z', payload: { v: 1, kind: 'text', sentAt: '2026-11-07T00:00:00Z', text: `合成历史 ${seq}。` + (seq % 11 ? '' : '不同高度的消息，用于验证滚动锚点。'.repeat(6)) } });
        app.messages = new Map(Array.from({ length: size }, (_, n) => [n + 1, chatMessage(n + 1)]));
        app.historyHasMore = false; app.historyHasNewer = false;
        const start = performance.now(); app.renderMessages({ scroll: 'bottom' });
        return { initialRenderMs: performance.now() - start };
      }, { styles, size, listScroll });
    },
  };
}
