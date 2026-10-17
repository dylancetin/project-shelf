export const MAX_FAVICON_BYTES = 128 * 1024;
export type FaviconRasterizer = (icon: Blob) => Promise<Blob>;

export function faviconMime(bytes: Uint8Array): string | null {
  const starts = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (bytes.length >= 33 && starts([137, 80, 78, 71, 13, 10, 26, 10])
    && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') return 'image/png';
  if (bytes.length >= 12 && starts([0, 0, 1, 0])) return 'image/x-icon';
  if (bytes.length >= 12 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 20 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6)))) return 'image/gif';
  if (bytes.length >= 20 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export async function checkedFavicon(icon: Blob): Promise<Blob> {
  if (!icon.size || icon.size > MAX_FAVICON_BYTES) throw new Error('The favicon is empty or too large.');
  const bytes = new Uint8Array(await icon.arrayBuffer());
  const mime = faviconMime(bytes);
  if (!mime) throw new Error('The favicon is not a supported raster image.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = (width: number, height: number) => {
    if (!width || !height || width > 1024 || height > 1024) throw new Error('The favicon dimensions are too large.');
  };
  // Reject image bombs before allocating a decoded pixel buffer.
  if (mime === 'image/png') {
    if (view.getUint32(8) !== 13) throw new Error('The favicon contains an invalid PNG header.');
    dimensions(view.getUint32(16), view.getUint32(20));
  }
  if (mime === 'image/gif') dimensions(view.getUint16(6, true), view.getUint16(8, true));
  if (mime === 'image/jpeg') {
    let found = false;
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
        dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        found = true; break;
      }
      offset += length;
    }
    if (!found) throw new Error('The favicon contains an invalid JPEG header.');
  }
  if (mime === 'image/webp') {
    const format = String.fromCharCode(...bytes.slice(12, 16));
    const uint24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
    if (format === 'VP8X' && bytes.length >= 30) dimensions(uint24(24) + 1, uint24(27) + 1);
    else if (format === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) {
      const packed = view.getUint32(21, true);
      dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
    } else if (format === 'VP8 ' && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      dimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    } else throw new Error('The favicon contains an invalid WebP header.');
  }
  if (mime === 'image/x-icon') {
    const count = view.getUint16(4, true);
    if (!count || count > 32 || 6 + count * 16 > bytes.length) throw new Error('The favicon contains an invalid icon directory.');
    for (let index = 0; index < count; index++) {
      const offset = 6 + index * 16;
      const size = view.getUint32(offset + 8, true), start = view.getUint32(offset + 12, true);
      if (!size || start < 6 + count * 16 || start + size > bytes.length) throw new Error('The favicon contains truncated image data.');
      if (size >= 33 && faviconMime(bytes.subarray(start, start + size)) === 'image/png') {
        dimensions(view.getUint32(start + 16), view.getUint32(start + 20));
      } else if (size >= 40 && view.getUint32(start, true) >= 40) {
        dimensions(Math.abs(view.getInt32(start + 4, true)), Math.abs(view.getInt32(start + 8, true)) / 2);
      }
    }
  }
  // Never trust Content-Type. In particular, SVG/HTML cannot reach a decoder.
  return new Blob([bytes], { type: mime });
}

// ICO is supported by Chrome's image element, including older bitmap ICOs that
// createImageBitmap cannot decode. Re-encoding also strips metadata and ensures
// saved blobs contain inert, actually decodable PNG pixels, not executable SVG.
export async function rasterizeFavicon(icon: Blob): Promise<Blob> {
  const checked = await checkedFavicon(icon);
  const url = URL.createObjectURL(checked);
  const image = new Image();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The favicon could not be decoded in time.')), 5000);
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The favicon could not be decoded.'));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 1024 || image.naturalHeight > 1024) throw new Error('The favicon dimensions are too large.');
    const scale = Math.min(1, 64 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This browser could not prepare the favicon.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) throw new Error('The favicon is completely transparent.');
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
      if (!blob || blob.size > MAX_FAVICON_BYTES) reject(new Error('This browser could not save the favicon.'));
      else resolve(blob);
    }, 'image/png'));
  } finally {
    clearTimeout(timer);
    image.onload = image.onerror = null;
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

export async function boundedFaviconResponse(response: Response): Promise<Blob> {
  if (!response.ok || response.redirected) throw new Error(`The icon provider returned ${response.status || 'an invalid response'}.`);
  const size = Number(response.headers.get('content-length') || 0);
  if (size > MAX_FAVICON_BYTES) throw new Error('The favicon is too large.');
  if (!response.body) throw new Error('The favicon response is empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FAVICON_BYTES) throw new Error('The favicon is too large.');
      chunks.push(new Uint8Array(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return checkedFavicon(new Blob(chunks));
}

export async function faviconDigest(icon: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await icon.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
