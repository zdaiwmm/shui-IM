import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import path from 'node:path';
import { createExpressionCatalog } from '../server/expression-catalog.mjs';
import { shippedExpressions } from '../server/shipped-expressions.mjs';
import { shippedGifAdditions, GIF_ADDITIONS_BATCH } from '../server/shipped-gif-additions.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'media-dir': { type: 'string' }, batch: { type: 'string', default: 'shipped-library-v1' } }, allowPositionals: false });
if (!['shipped-library-v1', GIF_ADDITIONS_BATCH].includes(values.batch)) throw new Error('Unknown shipped expression batch.');
if (!values['data-dir'] || !path.isAbsolute(values['data-dir'])) throw new Error('Use --data-dir with the absolute path of the stopped service data directory.');
if (!values['media-dir'] || !path.isAbsolute(values['media-dir']) || !statSync(values['media-dir']).isDirectory()) {
  throw new Error('Legacy import requires --media-dir pointing to an external archive containing stickers/ or gifs/. Release bundles contain no expression originals.');
}
const dataDir = values['data-dir'];
if (!statSync(path.join(dataDir, 'quiet-room.sqlite')).isFile()) throw new Error('The target service database must already exist.');
const catalog = createExpressionCatalog({ dataDir });
try {
  const additions = values.batch === GIF_ADDITIONS_BATCH;
  const result = catalog.initializeShipped(() => (additions ? shippedGifAdditions : shippedExpressions)({
    libraryPath: fileURLToPath(new URL(`../src/lib/${additions ? 'additional-gifs' : 'starter-library'}.json`, import.meta.url)),
    publicDir: values['media-dir'],
  }), values.batch);
  const count = kind => catalog.list({ kind, keyword: '', page: 1, status: 'published' }).total;
  console.log(JSON.stringify({ batch: values.batch, ...result, published: { stickers: count('stickers'), gifs: count('gifs') } }));
} finally { await catalog.close(); }
