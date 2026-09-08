import { parse } from 'exifr';
import { boundedPhotoTags, PHOTO_TAGS, type PhotoMetadata } from './photo-detail-model';

self.onmessage = async (event: MessageEvent<Blob>) => {
  let result: PhotoMetadata;
  try {
    let source = event.data;
    const head = new Uint8Array(await source.slice(0, 12).arrayBuffer());
    const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
    if (ascii(head.subarray(0, 3)) === 'GIF') {
      self.postMessage({ tags: {}, unavailable: false });
      return;
    }
    // WebP carries optional TIFF/EXIF in a RIFF chunk; exifr reads that TIFF.
    if (ascii(head.subarray(0, 4)) === 'RIFF' && ascii(head.subarray(8, 12)) === 'WEBP') {
      let offset = 12;
      let exif: Blob | undefined;
      for (let chunks = 0; offset + 8 <= source.size && chunks < 10_000; chunks++) {
        const header = new Uint8Array(await source.slice(offset, offset + 8).arrayBuffer());
        const size = new DataView(header.buffer).getUint32(4, true);
        if (size > source.size - offset - 8) throw new Error('Truncated WebP metadata');
        if (ascii(header.subarray(0, 4)) === 'EXIF') {
          if (size > 4 * 1024 * 1024) throw new Error('Oversized EXIF');
          exif = source.slice(offset + 8, offset + 8 + size);
          const prefix = new Uint8Array(await exif.slice(0, 6).arrayBuffer());
          if (ascii(prefix) === 'Exif\0\0') exif = exif.slice(6);
          break;
        }
        offset += 8 + size + (size % 2);
      }
      if (!exif) { self.postMessage({ tags: {}, unavailable: false }); return; }
      source = exif;
    }
    const tags = await parse(source, {
      pick: PHOTO_TAGS, reviveValues: false, translateValues: false,
      ifd1: false, makerNote: false, userComment: false, xmp: false, icc: false, iptc: false,
      jfif: true, ihdr: true, chunkLimit: 64, firstChunkSize: 65_536, chunkSize: 65_536,
    });
    result = { tags: boundedPhotoTags(tags), unavailable: Array.isArray(tags?.errors) && tags.errors.length > 0 };
  } catch { result = { tags: {}, unavailable: true }; }
  self.postMessage(result);
};
