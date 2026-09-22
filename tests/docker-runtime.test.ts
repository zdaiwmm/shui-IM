import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

it('copies every shared source module imported directly by the production server', async () => {
  const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.split(/^FROM .* AS runtime$/m)[1];
  expect(runtime).toBeTruthy();
  const sources = runtime.match(/^COPY (?!.*--from=).+$/gm)?.flatMap(line => line.split(/\s+/).slice(1, -1)) ?? [];
  const files = (await readdir(path.join(root, 'server'))).filter(name => name.endsWith('.mjs'));
  const imports = new Set<string>();
  for (const file of files) {
    const code = await readFile(path.join(root, 'server', file), 'utf8');
    for (const [, relative] of code.matchAll(/from ['"]\.\.\/(src\/[^'"]+)['"]/g)) imports.add(relative);
  }
  expect(imports.size).toBeGreaterThan(0);
  for (const imported of imports) {
    expect(sources.some(source => imported === source || imported.startsWith(`${source.replace(/\/$/, '')}/`)), imported).toBe(true);
  }
});
