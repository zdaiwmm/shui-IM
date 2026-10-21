const PREFIX = '__QR_EXIT_WITNESS__';
const READ_PATH = /^\/api\/(?:browser-access-catalogs\/[^/?]+|rooms\/[^/?]+\/browser-access)$/;

export class ExitRequestEvidence {
  sequence = 0;
  requests = new Map();
  documents = new Map();
  record(event) {
    const at = ++this.sequence;
    const document = this.documents.get(event.document) ?? { failed: false, hidden: false };
    this.documents.set(event.document, document);
    if (event.event === 'pagehide') document.hidden = true;
    if (event.event === 'window-error' || event.event === 'unhandledrejection') document.failed = true;
    const key = `${event.document}:${event.request}`;
    if (event.event === 'start') this.requests.set(key, { ...event, at });
    else if (this.requests.has(key)) this.requests.get(key)[event.event] = { ...event, at };
  }
  capture(error) { return { name: error.name, message: error.message, stack: error.stack, at: ++this.sequence }; }
  confirmsNativeExit(error) {
    if (error.name !== 'Fetch API cannot load http' || !/due to access control checks/.test(error.message)
      || !/accessApi|syncBrowserCatalog/.test(error.stack ?? '')) return false;
    // A previous closing document must never excuse a later active request
    // to the same catalog URL after reload.
    const request = [...this.requests.values()].filter(request => request.at <= error.at && (error.stack ?? '').includes(request.url))
      .sort((a, b) => b.at - a.at)[0];
    if (!request) return false;
    const document = this.documents.get(request.document), rejection = request.reject;
    const url = new URL(request.url);
    return request.method === 'GET' && url.origin === request.origin && READ_PATH.test(url.pathname)
      && document !== undefined && !document.failed && !request.response
      && (rejection?.name === 'AbortError' && rejection.aborted
        || document.hidden && rejection?.leaving && rejection.name === 'TypeError' && rejection.message === 'Load failed');
  }
}

/** Test-only observation. Re-throw on the returned promise so unhandled errors stay visible. */
export async function observeExitRequests(page) {
  const evidence = new ExitRequestEvidence();
  page.on('console', message => {
    if (message.text().startsWith(PREFIX)) evidence.record(JSON.parse(message.text().slice(PREFIX.length)));
  });
  await page.addInitScript(({ prefix }) => {
    const documentId = crypto.randomUUID();
    let requestId = 0, leaving = false;
    const emit = event => console.debug(prefix + JSON.stringify({ document: documentId, ...event }));
    addEventListener('beforeunload', () => { leaving = true; });
    addEventListener('pagehide', () => emit({ event: 'pagehide' }));
    addEventListener('error', () => emit({ event: 'window-error' }));
    addEventListener('unhandledrejection', () => emit({ event: 'unhandledrejection' }));
    const original = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET' || url.origin !== location.origin || !/^\/api\/(?:browser-access-catalogs\/[^/?]+|rooms\/[^/?]+\/browser-access)$/.test(url.pathname)) {
        return Reflect.apply(original, this, [input, init]);
      }
      const request = ++requestId;
      emit({ event: 'start', request, url: url.href, origin: location.origin, method });
      return Reflect.apply(original, this, [input, init]).then(response => {
        emit({ event: 'response', request, status: response.status }); return response;
      }, error => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        emit({ event: 'reject', request, name: error.name, message: error.message, leaving, aborted: signal?.aborted }); throw error;
      });
    };
  }, { prefix: PREFIX });
  return evidence;
}
