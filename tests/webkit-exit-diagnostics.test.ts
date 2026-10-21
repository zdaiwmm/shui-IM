import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExitRequestEvidence, observeExitRequests } from './helpers/webkit-exit-diagnostics.mjs';

const url = 'http://127.0.0.1:5173/api/browser-access-catalogs/synthetic';
const nativeError = { name: 'Fetch API cannot load http', message: `${url} due to access control checks.`, stack: `Fetch API cannot load ${url}\n at syncBrowserCatalog` };
function fixture({ leaving = true, method = 'GET', origin = 'http://127.0.0.1:5173', response }: { leaving?: boolean; method?: string; origin?: string; response?: number } = {}) {
  const evidence = new ExitRequestEvidence();
  evidence.record({ document: 'old', request: 1, event: 'start', url, origin, method });
  if (response) evidence.record({ document: 'old', request: 1, event: 'response', status: response });
  const error = evidence.capture(nativeError);
  evidence.record({ document: 'old', request: 1, event: 'reject', leaving, name: 'TypeError', message: 'Load failed' });
  return { evidence, error };
}
it('requires the observed request failure and completed document exit', () => {
  const { evidence, error } = fixture();
  expect(evidence.confirmsNativeExit(error)).toBe(false);
  evidence.record({ document: 'old', event: 'pagehide' });
  expect(evidence.confirmsNativeExit(error)).toBe(true);
});
it('keeps active network failures, responses, writes and external origins fatal', () => {
  for (const options of [{ leaving: false }, { method: 'PUT' }, { origin: 'https://example.invalid' }, { response: 403 }, { response: 200 }]) {
    const { evidence, error } = fixture(options); evidence.record({ document: 'old', event: 'pagehide' });
    expect(evidence.confirmsNativeExit(error)).toBe(false);
  }
});
it('never hides an unhandled rejection or a JavaScript error during exit', () => {
  for (const event of ['window-error', 'unhandledrejection']) {
    const { evidence, error } = fixture(); evidence.record({ document: 'old', event }); evidence.record({ document: 'old', event: 'pagehide' });
    expect(evidence.confirmsNativeExit(error)).toBe(false);
  }
});
it('does not reuse old exit evidence for a new document request to the same URL', () => {
  const { evidence } = fixture(); evidence.record({ document: 'old', event: 'pagehide' });
  evidence.record({ document: 'new', request: 1, event: 'start', url, origin: 'http://127.0.0.1:5173', method: 'GET' });
  const error = evidence.capture(nativeError);
  evidence.record({ document: 'new', request: 1, event: 'reject', leaving: false, name: 'TypeError', message: 'Load failed' });
  expect(evidence.confirmsNativeExit(error)).toBe(false);
});
it('retains ordinary JavaScript failures even with matching native error text', () => {
  const { evidence } = fixture(); evidence.record({ document: 'old', event: 'pagehide' });
  expect(evidence.confirmsNativeExit(evidence.capture({ ...nativeError, name: 'TypeError' }))).toBe(false);
});

it('accepts an observed explicit read cancellation without treating later aborts as proof', () => {
  const { evidence, error } = fixture({ leaving: false });
  expect(evidence.confirmsNativeExit(error)).toBe(false);
  evidence.record({ document: 'old', request: 1, event: 'reject', leaving: false, name: 'AbortError', aborted: true });
  expect(evidence.confirmsNativeExit(error)).toBe(true);
  evidence.record({ document: 'old', event: 'unhandledrejection' });
  expect(evidence.confirmsNativeExit(error)).toBe(false);
});

it('preserves the returned fetch rejection instead of consuming application errors', async () => {
  let install: Function, args: unknown, report: Function;
  await observeExitRequests({
    on: (_: string, callback: Function) => { report = callback; },
    addInitScript: (callback: Function, value: unknown) => { install = callback; args = value; },
  });
  const failure = new TypeError('Load failed');
  const sandbox = {
    crypto: { randomUUID: () => 'synthetic' }, location: { origin: 'http://127.0.0.1:5173', href: 'http://127.0.0.1:5173/' },
    console: { debug: (text: string) => report({ text: () => text }) },
    addEventListener: () => {}, URL, Request, args,
    window: { fetch: (_input: unknown) => Promise.reject(failure) },
  };
  runInNewContext(`(${install!.toString()})(args)`, sandbox);
  await expect(sandbox.window.fetch('/api/browser-access-catalogs/synthetic')).rejects.toBe(failure);
});
