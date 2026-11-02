import assert from 'node:assert/strict';

/** Synthetic failure injection around real localhost IndexedDB and vault data. */
export async function verifyStorageRecovery(page) {
  const result = await page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    const { app, session, visibility, fresh } = fixture;
    const lost = () => new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
    const originalOpen = indexedDB.open.bind(indexedDB);
    const originalTransaction = IDBDatabase.prototype.transaction;
    const originalPut = IDBObjectStore.prototype.put;
    const check = (value, message) => { if (!value) throw Error(message); };
    const rejected = async operation => { try { await operation(); return false; } catch { return true; } };
    const before = JSON.stringify(await v.readStoredVault());
    try {
      // Re-enter through the actual locked gateway after a foreground return.
      app.lockNow(); visibility(true); visibility(false);
      let opens = 0;
      indexedDB.open = (...args) => { if (++opens === 1) throw lost(); return originalOpen(...args); };
      await app.renderGateway({ trustedCoverActivation: true, autoUnlock: false });
      check(opens > 1 && !document.querySelector('#startup-retry'), 'Transient foreground read must recover without reload');
      check(!app.session, 'Storage recovery cannot authenticate the locked session');
      indexedDB.open = originalOpen;
      let asynchronousOpens = 0;
      indexedDB.open = (...args) => {
        if (++asynchronousOpens !== 1) return originalOpen(...args);
        const request = { error: lost() };
        queueMicrotask(() => request.onerror?.(new Event('error')));
        return request;
      };
      await v.readRoomProtection();
      check(asynchronousOpens === 2, 'Native open error event must recover with a fresh connection');
      indexedDB.open = originalOpen;
      let reads = 0;
      IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
        if (stores === 'security' && mode === 'readonly' && ++reads === 1) throw new DOMException('The database connection is closing.', 'InvalidStateError');
        return originalTransaction.call(this, stores, mode, ...rest);
      };
      await v.readRoomProtection();
      check(reads === 2, 'A pure read can restart after connection closure');
      IDBDatabase.prototype.transaction = originalTransaction;
      let persistent = 0;
      indexedDB.open = () => { persistent++; throw lost(); };
      check(await rejected(() => v.readRoomProtection()) && persistent === 3, 'Persistent failure must stop after three attempts');
      let denied = 0;
      indexedDB.open = () => { denied++; throw new DOMException('Storage denied', 'SecurityError'); };
      check(await rejected(() => v.readRoomProtection()) && denied === 1, 'Permissions must not be retried');
      let unknown = 0;
      indexedDB.open = () => { unknown++; throw new DOMException('Unclassified storage failure', 'UnknownError'); };
      check(await rejected(() => v.readRoomProtection()) && unknown === 1, 'Unknown errors must not be guessed recoverable');
      let hidden = 0;
      indexedDB.open = () => { hidden++; visibility(true); throw lost(); };
      check(await rejected(() => v.readRoomProtection()) && hidden === 1, 'Backgrounding stops recovery');
      visibility(false); indexedDB.open = originalOpen;
      // A real queued write must roll back, never run a second time.
      await v.saveUiPreferences(session, { composerDraft: 'committed synthetic draft' });
      let puts = 0;
      IDBObjectStore.prototype.put = function(...args) {
        const request = originalPut.apply(this, args);
        if (this.name === 'preferences') { puts++; throw lost(); }
        return request;
      };
      check(await rejected(() => v.saveUiPreferences(session, { composerDraft: 'must not commit' })) && puts === 1, 'Dispatched writes cannot replay');
      IDBObjectStore.prototype.put = originalPut;
      check((await v.loadUiPreferences(session)).composerDraft === 'committed synthetic draft', 'Failed queued write preserves durable draft');
      check(JSON.stringify(await v.readStoredVault()) === before, 'Encrypted vault wrapper stays unchanged');
      fresh();
      return { recovered: true, bounded: true, locked: true, writeAttempts: puts };
    } finally {
      indexedDB.open = originalOpen; IDBDatabase.prototype.transaction = originalTransaction;
      IDBObjectStore.prototype.put = originalPut; visibility(false);
    }
  });
  assert.deepEqual(result, { recovered: true, bounded: true, locked: true, writeAttempts: 1 });
  console.log('Storage recovery: foreground open/read retry, bounded/permission/hidden failure, no authentication bypass or write replay passed');
}
