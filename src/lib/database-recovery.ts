/** Retry only connection acquisition or an explicitly read-only operation.
 * Never wrap a dispatched write, crypto operation or authentication ceremony. */
export async function recoverDatabaseRead<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (cause) {
      if (attempt >= 2 || !isLostDatabaseConnection(cause) || document.hidden) throw cause;
      await new Promise(resolve => window.setTimeout(resolve, attempt === 0 ? 100 : 250));
      // A backgrounded page cannot keep a recovery loop alive.
      if (document.hidden) throw cause;
    }
  }
}

function isLostDatabaseConnection(cause: unknown): boolean {
  if (!(cause instanceof DOMException)) return false;
  return (cause.name === 'UnknownError' && /connection to indexed database server lost|internal error.*indexed database server/i.test(cause.message))
    || (cause.name === 'InvalidStateError' && /(?:database )?connection (?:is )?(?:closing|closed)/i.test(cause.message));
}
