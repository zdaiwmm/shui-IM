// Opt-in local boundary check. Uses an isolated, regular Chrome profile and temporary disk.
// Run from the repository root after npm ci.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createStore } from '../../../server/storage.mjs';

const directory = await mkdtemp(join(tmpdir(), 'quiet-room-large-video-'));
const store = await createStore({ dataDir: directory });
const deviceId = crypto.randomUUID();
const key = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', ext: true };
const { roomId } = store.createRoom({
  deviceId, encryptionKey: { ...key, key_ops: [] }, signingKey: { ...key, key_ops: ['verify'] },
}, 'a'.repeat(43));
const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false },
});
let context;
try {
  server.middlewares.use('/sample', (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Large video boundary</title>');
  });
  server.middlewares.use('/part', async (request, response) => {
    const [blobId, index] = request.url.slice(1).split('/');
    try {
      if (request.method === 'PUT') {
        const blocks = [];
        for await (const block of request) blocks.push(block);
        await store.putBlobChunk(roomId, blobId, Number(index), Buffer.concat(blocks), deviceId);
        response.end();
      } else {
        response.end(await store.getBlobChunk(roomId, blobId, Number(index)));
      }
    } catch {
      response.statusCode = 500;
      response.end();
    }
  });
  await server.listen();
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await context.newPage();
  await page.exposeFunction('reserve', (id, count, bytes) => { store.createBlob(roomId, id, count, bytes, deviceId); });
  await page.exposeFunction('finish', id => store.completeBlob(roomId, id, deviceId));
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/sample');
  const result = await page.evaluate(async () => {
    const { encryptFileAttachment, decryptFileAttachment } = await import('/src/lib/file-crypto.ts');
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 64;
    const drawing = canvas.getContext('2d');
    const stream = canvas.captureStream(5);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
    const parts = [];
    recorder.ondataavailable = event => parts.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (const color of ['red', 'green', 'blue']) {
      drawing.fillStyle = color;
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      await new Promise(resolve => setTimeout(resolve, 220));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach(track => track.stop());

    // Standard ISO BMFF free-space boxes preserve a genuine, decodable MP4. Small
    // boxes avoid hitting the demuxer's unrelated single-box allocation limit.
    function freeBox(size) {
      const header = new Uint8Array([0, 0, 0, 0, 102, 114, 101, 101]);
      new DataView(header.buffer).setUint32(0, size);
      return new Blob([header, new Uint8Array(size - 8)]);
    }
    const movie = new Blob(parts);
    const padding = 2 * 1024 ** 3 - movie.size;
    const box = freeBox(1024 ** 2);
    const file = new File([movie, ...Array(Math.floor(padding / box.size)).fill(box), freeBox(padding % box.size)],
      'boundary.mp4', { type: 'video/mp4' });
    const manifest = await encryptFileAttachment(file, {
      reserve: window.reserve, complete: window.finish, savePlan: async () => {},
      status: async () => ({ uploadedIndexes: [], completed: false }),
      upload: async (id, index, bytes) => {
        const response = await fetch('/part/' + id + '/' + index, { method: 'PUT', body: bytes });
        if (!response.ok) throw Error('Failed to upload test chunk');
      },
    });
    const original = await decryptFileAttachment(manifest, async (id, index) => {
      const response = await fetch('/part/' + id + '/' + index);
      if (!response.ok) throw Error('Failed to read test chunk');
      return response.arrayBuffer();
    });
    const player = document.createElement('video');
    player.muted = true;
    player.src = URL.createObjectURL(original);
    try {
      await Promise.race([player.play(), new Promise((_, reject) => setTimeout(() => reject(Error('Decoder timeout')), 15000))]);
      return { bytes: original.size, chunks: manifest.chunkCount, width: player.videoWidth, height: player.videoHeight };
    } finally {
      player.pause();
      URL.revokeObjectURL(player.src);
    }
  });
  assert.deepEqual(result, { bytes: 2 * 1024 ** 3, chunks: 1024, width: 96, height: 64 });
  console.log('LARGE_VIDEO_VERIFIED', result);
} finally {
  await context?.close();
  await server.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
