// Optional one-time preparation; the browser only reads local files.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const entries = [
  ['demo-photo.jpg','https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=900&q=85'],
  ['demo-video.mp4','https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'],
];
const directory = new URL('./assets/',import.meta.url);
await mkdir(directory,{recursive:true});
for (const [name,url] of entries) {
  const response = await fetch(url,{signal:AbortSignal.timeout(30_000)});
  if (!response.ok) throw Error(`Could not prepare ${name}: HTTP ${response.status}`);
  await writeFile(new URL(name,directory),new Uint8Array(await response.arrayBuffer()));
  console.log(`Prepared ${name}`);
}
console.log(`Local assets: ${fileURLToPath(directory)}`);
