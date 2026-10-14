import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deliveryScripts, deliveryTests } from './ci-scope.mjs';
import { isMainModule } from './release-runtime.mjs';

export function checkDelivery(run = spawnSync) {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const checked = (program, args) => {
    const result = run(program, args, { cwd, stdio: 'inherit' });
    if (result.error || result.signal || result.status !== 0) throw new Error('Delivery verification failed');
  };
  for (const script of deliveryScripts) {
    if (script.endsWith('.mjs')) checked(process.execPath, ['--check', script]);
    else if (script.endsWith('.sh')) checked('bash', ['-n', script]);
    else if (script.endsWith('.py')) checked('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', script]);
  }
  // Fixtures exercise import, cutover, rollback, CLI protocol, provenance and
  // independent readback without production credentials, hosts or browser suites.
  checked(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...deliveryTests]);
}

if (isMainModule(import.meta.url)) {
  try { checkDelivery(); }
  catch { console.error('DELIVERY_CHECK_BLOCKED'); process.exitCode = 1; }
}
