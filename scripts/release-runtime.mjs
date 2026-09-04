import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// macOS exposes /tmp and /var through aliases. Compare physical files so a
// directly invoked entry cannot silently return without running its checks.
export function isMainModule(url, entry = process.argv[1]) {
  return Boolean(entry) && realpathSync(entry) === realpathSync(fileURLToPath(url));
}

export function createReleaseTimer(scope, emit = console.log, now = () => process.hrtime.bigint()) {
  if (!/^[a-z-]+$/.test(scope)) throw new Error('Invalid timing scope');
  return (phase, operation) => {
    if (!/^[a-z-]+$/.test(phase)) throw new Error('Invalid timing phase');
    const started = now();
    const report = result => emit(`RELEASE_TIMING scope=${scope} phase=${phase} result=${result} duration_ms=${Number((now() - started) / 1_000_000n)}`);
    try {
      const result = operation();
      if (result && typeof result.then === 'function') {
        return result.then(value => { report('success'); return value; }, error => { report('failure'); throw error; });
      }
      report('success');
      return result;
    } catch (error) {
      report('failure');
      throw error;
    }
  };
}
