// Dependency-free PNG versions of public/favicon.svg for installable apps.
import { deflateSync } from 'node:zlib';
import path from 'node:path';

function chunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, payload, checksum]);
}

async function icon(size: number, filename: string) {
  const data = Buffer.alloc((size * 3 + 1) * size);
  const rectangles = [[17, 17, 25, 44], [29, 23, 37, 44], [41, 17, 47, 44], [14, 47, 50, 51]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = rectangles.some(([left, top, right, bottom]) => (x + .5) * 64 / size >= left && (x + .5) * 64 / size < right && (y + .5) * 64 / size >= top && (y + .5) * 64 / size < bottom);
      const color = inside ? [241, 244, 248] : [47, 52, 61];
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      data.set(color, offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  await Bun.write(path.join(import.meta.dir, '../public', filename), Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

await Promise.all([icon(180, 'apple-touch-icon.png'), icon(192, 'pwa-192.png'), icon(512, 'pwa-512.png'), icon(512, 'pwa-maskable-512.png')]);
