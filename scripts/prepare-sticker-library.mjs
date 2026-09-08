import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fetchMemeResource, memeContentType } from '../server/memes.mjs';
import { createStickerSource, decryptPublicSticker, publicStickerAnimated } from '../server/sticker-source.mjs';

const source = createStickerSource(fetchMemeResource);
const chosen = [
  '8771105c23a9dc10df5aafb55105ef02', 'ad7605f942479d1469e2d764031c5238',
  '22cc15c9671421a307aa4da6a76f4249', '7da03a2680939a640126e63a859896b5',
  '33f9b3c1d83a59d5d0b88f710f9627ff', '738635efb4413ec1290ed29a48766313',
  'cdaf6e92b6f1cd4ce756c5cf9ee3c84a', '4aef9146bd5aa276468ed28e1ad995af',
  '2c51c28cf58e89db500d183e9d360f87',
  '704a47f6ebdb39b029aa4fc90336866e', '26512171effd7443510cc909edb5a142',
  'ec0fdd6a37b08a6e6230e08ba59addc3', '7a1a0e746556ff3decadf23a5833d5a6',
  '6877a0b5f59f8afb4b9442040d60464a', '2a4c8da668bb83cdf1ca2c2e6b0e4f60',
  'fa43d4e4dfddd5618c531f6c11e87cb7', '8115614ddec2e08ad7ab9f6f68465bff',
  '425c53078869e803aacc90b52f6bfebe', '803713f88a8146aac849a5619734f095',
  '46dce18d07a24d82a14280356ef27ff3',
  'bf012b718285db8e3e86ceebddde3031', '29a2d659f61e1bc0d877ef715e84e9eb',
  'd0915b31b83c168dda0197884c220cd3', 'bad7105b3b3a2c20e841a9d7275b3aca',
  'd0cf1317f0c92ede42a076c107f15133', '3b3a1eeef29b6f6a58518fc3a6cf4947',
  '5e762702b6470bf7ac664d8fd732f264', '9e5b52f5164c0b647650885972fc267a',
  '607830017211defe7bbb7bc56c27799b', '2c478715ee1512a04fa99773a6407284',
];
const output = new URL('../public/stickers/', import.meta.url); await mkdir(output, { recursive: true });
const previous = JSON.parse(await readFile(new URL('../src/lib/starter-library.json', import.meta.url), 'utf8').catch(() => '{"packs":[]}'));
const packs = []; const gifs = []; const gifDigests = new Set(); const records = []; let total = 0;
for (const id of chosen) {
  try {
    const pack = await source.pack(id);
    if (pack.items.length < 8 || pack.items.length > 200) continue;
    const media = [];
    for (let offset = 0; offset < pack.items.length; offset += 3) {
      const batch = await Promise.all(pack.items.slice(offset, offset + 3).map(async item => {
        const cached = previous.packs.find(pack => pack.id === id)?.items[pack.items.indexOf(item)];
        const bytes = cached ? await readFile(new URL(cached.asset.slice('/stickers/'.length), output))
          : decryptPublicSticker(await fetchMemeResource(item.url, 8 * 1024 * 1024 + 64), item.key);
        const type = memeContentType(bytes); const digest = createHash('sha256').update(bytes).digest('hex');
        return { bytes, type, digest, item, animated: publicStickerAnimated(bytes) };
      })); media.push(...batch);
    }
    const size = media.reduce((sum, item) => sum + item.bytes.length, 0);
    if (size > 8 * 1024 * 1024 || total + size > 100 * 1024 * 1024) continue;
    const entries = []; let gifsFromPack = 0;
    for (const image of media) {
      const name = `${image.digest}.${image.type.split('/')[1]}`;
      const entry = { id: `starter-${image.digest}`, title: image.item.title, asset: `/stickers/${name}`, animated: image.animated, digest: image.digest, size: image.bytes.length };
      {
        await writeFile(new URL(name, output), image.bytes);
        records.push({ file: name, sha256: image.digest, bytes: image.bytes.length, pack: id, author: pack.author, title: pack.title, source: pack.source, directory: `https://signalstickers.org/pack/${id}`, modified: false });
      }
      entries.push(entry);
      if (image.animated && gifs.length < 100 && gifsFromPack < 12 && !gifDigests.has(image.digest)) { gifDigests.add(image.digest); gifs.push(entry); gifsFromPack++; }
    }
    packs.push({ id: pack.id, title: pack.title, items: entries }); total += size;
    console.log(JSON.stringify({ title: pack.title, items: entries.length, bytes: size, packs: packs.length, gifs: gifs.length }));
  } catch (error) { console.log('Skipped pack', id, error.message); }
}
if (packs.length !== 30 || gifs.length !== 100) throw new Error(`Insufficient library: ${packs.length} packs, ${gifs.length} animations`);
await writeFile(new URL('../src/lib/starter-library.json', import.meta.url), JSON.stringify({ packs, gifs }, null, 2) + '\n');
await writeFile(new URL('sources.json', output), JSON.stringify({ source: 'Public Signal Stickers directory', records }, null, 2) + '\n');
const assets = [...new Set([...packs.flatMap(pack => pack.items), ...gifs].map(item => item.asset))];
const keep = new Set(assets.map(asset => asset.slice('/stickers/'.length)));
for (const file of await readdir(output)) {
  if (/^[a-f0-9]{64}\.(png|jpeg|gif|webp)$/.test(file) && !keep.has(file)) await unlink(new URL(file, output));
}
console.log(JSON.stringify({ packs: packs.length, stickers: packs.reduce((sum, pack) => sum + pack.items.length, 0), gifs: gifs.length, uniqueAssets: assets.length, totalBytes: total }));
