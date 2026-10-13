import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
// @ts-expect-error Operational module has no declaration file.
import { assertPortAvailable, parseMobileArguments } from '../scripts/dev-mobile.mjs';
// @ts-expect-error Operational module has no declaration file.
import { mobileDebugPlugin } from '../tools/mobile-debug/plugin.mjs';

describe('portable local mobile debugging', () => {
  it('resolves independent data under the actual checkout and explicit paths', () => {
    expect(parseMobileArguments([], '/another/computer/checkout')).toMatchObject({
      port: 5185, apiPort: 8787, dataDir: '/another/computer/checkout/data/mobile-debug', watch: true,
    });
    expect(parseMobileArguments(['--port','5201','--api-port','8801','--data-dir','local-data','--no-watch'], '/tmp/task')).toMatchObject({
      port: 5201, apiPort: 8801, dataDir: '/tmp/task/local-data', watch: false,
    });
  });
  it.each([['--port','0'],['--api-port','65536'],['--port','8787'],['--host','0.0.0.0'],['--data-dir']])('fails closed for invalid options %j', (...args) => {
    expect(() => parseMobileArguments(args)).toThrow();
  });
  it('does not take over an occupied listener', async () => {
    const listener=createServer();
    await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
    try { const address=listener.address(); if(!address||typeof address==='string')throw Error('Missing test address'); await expect(assertPortAvailable(address.port)).rejects.toMatchObject({code:'EADDRINUSE'}); }
    finally { await new Promise<void>(resolve=>listener.close(()=>resolve())); }
  });
  it('does not enable debugging in a production build', () => {
    expect(mobileDebugPlugin().apply).toBe('serve');
  });
});
