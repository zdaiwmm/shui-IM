import { deflateSync } from 'node:zlib';

// Synthetic two-color originals. No user photos or camera/location data.
export const animatedGif = Buffer.from('R0lGODlhCAAIAIAAAExpcfA8KCH/C05FVFNDQVBFMi4wAwEAAAAh+QQFEgAAACwAAAAACAAIAAACB4yPqcvtXQAAIfkEBRIAAAAsAAAAAAgACACATGlxHqrcAgeMj6nL7V0AADs=', 'base64');
export const animatedWebp = Buffer.from('UklGRsAAAABXRUJQVlA4WAoAAAACAAAABwAABwAAQU5JTQYAAAD/////AABBTk1GRgAAAAAAAAAAAAcAAAcAALQAAAJWUDggLgAAANABAJ0BKggACAABQCYloAJ0ugH4AAOwAP7oOL/5glfkG7UP/v2l70A96Af6LABBTk1GRgAAAAAAAAAAAAcAAAcAALQAAABWUDggLgAAAPQBAJ0BKggACAAAACYloAJ0ugH4AAX0AAD9xx/56ZrzB/k5/9uz+yAeyAftLAA=', 'base64');
export const exifPrefix = Buffer.from('/9j/4QFkRXhpZgAASUkqAAgAAAAJAA8BAgAPAAAAqgAAABABAgALAAAAngAAABIBAwABAAAAAQAAABoBBQABAAAAegAAABsBBQABAAAAggAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAJiCAgAUAAAAigAAAGmHBAABAAAAugAAAAAAAAA4YwAA6AMAADhjAADoAwAAPGI+Rml4dHVyZSBvbmx5PC9iPgBUZXN0IE1vZGVsAABGaXh0dXJlIENhbWVyYQAACgCaggUAAQAAADgBAACdggUAAQAAAFQBAAAniAMAAQAAAFAAAAAAkAcABAAAADAyMTADkAIAFAAAAEABAAABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAGgBAAADoAQAAQAAAPAAAAAAAAAAAQAAAOIEAAAyMDI2OjA5OjA2IDE2OjI4OjM1ALIAAABkAAAA', 'base64');

function chunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([prefix, bytes, suffix]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(8, 0); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
const pixels = color => Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => color).flat()])));
const control = sequence => {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence); data.writeUInt32BE(8, 4); data.writeUInt32BE(8, 8);
  data.writeUInt16BE(18, 20); data.writeUInt16BE(100, 22);
  return chunk('fcTL', data);
};
const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
export const animatedPng = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])), control(0),
  chunk('IDAT', deflateSync(pixels([240, 60, 40, 255]))), control(1),
  chunk('fdAT', Buffer.concat([sequence, deflateSync(pixels([30, 170, 220, 255]))])), chunk('IEND', Buffer.alloc(0)),
]);
export const staticPng = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels([80, 145, 115, 255]))), chunk('IEND', Buffer.alloc(0)),
]);
