import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import path from 'node:path';
import { createExpressionCatalog } from '../server/expression-catalog.mjs';
import { shippedExpressions } from '../server/shipped-expressions.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } }, allowPositionals: false });
if (!values['data-dir'] || !path.isAbsolute(values['data-dir'])) throw new Error('Use --data-dir with the absolute path of the stopped local service data directory.');
const dataDir = values['data-dir'];
if (!statSync(path.join(dataDir, 'quiet-room.sqlite')).isFile()) throw new Error('The target service database must already exist.');
const catalog = createExpressionCatalog({ dataDir });
try {
  const result = catalog.initializeShipped(() => shippedExpressions({
    libraryPath: fileURLToPath(new URL('../src/lib/starter-library.json', import.meta.url)),
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  }));
  const count = kind => catalog.list({ kind, keyword: '', page: 1, status: 'published' }).total;
  console.log(JSON.stringify({ ...result, published: { stickers: count('stickers'), gifs: count('gifs') } }));
} finally { await catalog.close(); }
