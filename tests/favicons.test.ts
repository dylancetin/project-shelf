import { describe, expect, spyOn, test } from 'bun:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { chromeFavicons, faviconLocation, FAVICON_PROVIDER_ORIGIN, publicFaviconHostname, type FaviconStore } from '../extension/src/favicons';
import { boundedFaviconResponse, checkedFavicon, MAX_FAVICON_BYTES } from '../extension/src/favicon-raster';
import type { ChromeApi } from '../extension/src/browser';

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4); bytes.set(data, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
// Complete, CRC-valid, decodable 16px RGBA PNGs. An eight-byte signature is not
// an image and must never make these tests report a successful acquisition.
function png(red: number, green: number, blue: number): Blob {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(16 * (1 + 16 * 4));
  for (let row = 0; row < 16; row++) for (let column = 0; column < 16; column++) pixels.set([red, green, blue, 255], row * 65 + 1 + column * 4);
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...[chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', new Uint8Array())].map(bytes => new Uint8Array(bytes))], { type: 'image/png' });
}
const RED = png(201, 48, 42), BLUE = png(41, 92, 187), DEFAULT = png(150, 150, 150);

// Bun has no DOM image decoder. Substitute a real PNG decompression/integrity
// check for the browser's decode-and-canvas step, not a signature-only mock.
async function testRasterize(icon: Blob): Promise<Blob> {
  const checked = await checkedFavicon(icon);
  if (checked.type !== 'image/png') throw new Error('Use browser QA for ICO decoding.');
  const bytes = Buffer.from(await checked.arrayBuffer());
  const idat: Buffer[] = [];
  let ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length || bytes.readUInt32BE(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))) throw new Error('PNG data is truncated or corrupt.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, end - 4));
    if (type === 'IEND') ended = true;
    offset = end;
  }
  if (!ended || !idat.length || !inflateSync(Buffer.concat(idat)).length) throw new Error('PNG has no decodable pixels.');
  return checked;
}

function fixture({ online = true, native = true, storageFails = false, defaultFails = false } = {}) {
  const saved = new Map<string, Blob>();
  const requests: { url: string; options?: RequestInit }[] = [];
  const permissions: { operation: string; value: unknown }[] = [];
  const store: FaviconStore = {
    get: async key => saved.get(key) ?? null,
    put: async (key, blob) => { if (storageFails) throw new Error('Quota exceeded'); saved.set(key, blob); },
    clear: async () => { saved.clear(); },
  };
  const api = { permissions: {
    contains: async (value: { origins?: string[]; permissions?: string[] }) => { permissions.push({ operation: 'contains', value }); return value.origins ? online : native; },
    request: async (value: unknown) => { permissions.push({ operation: 'request', value }); return online; },
  }, runtime: { getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}` } } as unknown as ChromeApi;
  const fetcher = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input);
    requests.push({ url, options });
    if (url.startsWith('chrome-extension:')) {
      const page = new URL(url).searchParams.get('pageUrl')!;
      if (page.includes('project-shelf-favicon.invalid')) return defaultFails ? new Response('unavailable', { status: 500 }) : new Response(DEFAULT);
      return new Response(page.includes('/two') ? BLUE : RED);
    }
    return new Response(RED);
  }) as typeof fetch;
  return { provider: chromeFavicons(api, store, fetcher, testRasterize), api, store, requests, permissions, saved, fetcher };
}

describe('opt-in, locally cached public website icons', () => {
  test('public provider is never contacted by reads or permission checks, even when granted', async () => {
    const f = fixture({ native: false });
    expect(await f.provider.hasAccess()).toBe(true);
    expect(await f.provider.read('https://github.com/private/repo?q=secret')).toBeNull();
    expect(f.requests).toHaveLength(0);
    expect(await f.provider.refresh(['https://github.com/private/repo?q=secret'], () => {})).toBe(1);
    expect(f.requests.map(request => request.url)).toEqual(['https://icons.duckduckgo.com/ip3/github.com.ico']);
    expect(f.requests[0]?.options).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  });

  test('requests only the exact provider origin and optional local favicon access', async () => {
    const f = fixture({ online: false, native: false });
    expect(await f.provider.requestAccess()).toBe(false);
    expect(f.permissions).toContainEqual({ operation: 'request', value: { origins: [FAVICON_PROVIDER_ORIGIN], permissions: ['favicon'] } });
    await expect(f.provider.refresh(['https://github.com'], () => {})).rejects.toThrow('Enable online icons');
    expect(await f.provider.read('https://github.com')).toBeNull();
    expect(f.requests).toHaveLength(0);
    expect(f.permissions.every(entry => !JSON.stringify(entry).includes('https://*/*'))).toBe(true);
  });

  test('excludes local/private/special names, credentials, IP literals and unsafe addresses', async () => {
    const excluded = [
      'http://localhost', 'http://beelinkk', 'http://nas.lan', 'https://a.local', 'https://a.localhost', 'https://a.internal',
      'https://a.test', 'https://a.example', 'https://a.invalid', 'https://a.home.arpa', 'https://a.corp', 'https://private.company.com',
      'https://nextcloud.tail750ac6.ts.net', 'https://beelinkk.tail750ac6.ts.net', 'https://a.tailscale.net', 'https://192-168-1-50.nip.io', 'https://192.168.1.50.sslip.io',
      'https://localhost.com', 'https://lvh.me', 'https://example.com', 'https://a.example.org',
      'http://192.168.1.50', 'http://127.0.0.1', 'http://8.8.8.8', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
      'http://[::1]', 'http://[fd00::1]', 'http://[2001:4860:4860::8888]', 'https://user:secret@github.com/path',
      'https://github.com:8443', 'javascript:alert(1)', 'file:///secret', 'chrome://settings', 'not a url', 'https://under_score.com',
    ];
    for (const url of excluded) expect(publicFaviconHostname(url), url).toBeNull();
    const f = fixture();
    expect(await f.provider.refresh(excluded, () => {})).toBe(0);
    expect(f.requests).toHaveLength(0);
    expect(publicFaviconHostname('https://WWW.GITHUB.COM./path?secret=yes#fragment')).toBe('www.github.com');
    expect(publicFaviconHostname('https://bun.sh')).toBe('bun.sh');
    expect(faviconLocation('http://user:password@localhost:8000/path')).toBeNull();
  });

  test('Chrome reads are local and page-specific, not one arbitrary icon per origin', async () => {
    const f = fixture({ online: false });
    const [one, same, two] = await Promise.all([f.provider.read('https://site.test/one?q=1'), f.provider.read('https://site.test/one?q=1'), f.provider.read('https://site.test/two')]);
    expect(one).toStartWith('blob:'); expect(same).toBe(one); expect(two).toStartWith('blob:'); expect(two).not.toBe(one);
    expect(f.requests.every(request => request.url.startsWith('chrome-extension:'))).toBe(true);
    expect([...f.saved.keys()].sort()).toEqual(['page:https://site.test/one?q=1', 'page:https://site.test/two']);
    expect(f.requests.filter(request => new URL(request.url).searchParams.get('pageUrl') === 'https://site.test/one?q=1')).toHaveLength(1);
  });

  test('Chrome’s default globe is not saved as a real icon and cannot suppress online refresh', async () => {
    const f = fixture();
    f.saved.set('https://github.com', DEFAULT);
    const fetcher = (async (input: string | URL | Request, options?: RequestInit) => String(input).startsWith('chrome-extension:') ? new Response(DEFAULT) : f.fetcher(input, options)) as typeof fetch;
    const provider = chromeFavicons(f.api, f.store, fetcher, testRasterize);
    expect(await provider.read('https://github.com/one')).toBeNull();
    expect(f.saved.has('page:https://github.com/one')).toBe(false);
    expect(await provider.refresh(['https://github.com/one'], () => {})).toBe(1);
    expect(await provider.read('https://github.com/one')).toStartWith('blob:');
    expect(f.saved.has('online:github.com')).toBe(true);
  });

  test('failure to read Chrome’s placeholder reference does not falsely establish a branded icon', async () => {
    const f = fixture({ defaultFails: true });
    expect(await f.provider.read('https://github.com')).toBeNull();
    expect(f.saved.size).toBe(0);
  });

  test('saved online and legacy origin blobs remain usable offline without any permission', async () => {
    const f = fixture({ native: false, online: false });
    f.saved.set('https://legacy.test', RED);
    f.saved.set('online:github.com', BLUE);
    expect(await f.provider.read('https://legacy.test/specific')).toStartWith('blob:');
    expect(await f.provider.read('https://github.com/specific')).toStartWith('blob:');
    expect(f.requests).toHaveLength(0);
  });

  test('explicit refresh reports unique public hosts and actual successful acquisitions', async () => {
    const f = fixture();
    const provider = chromeFavicons(f.api, f.store, (async (input, options) => String(input).includes('bun.sh') ? new Response('unavailable', { status: 404 }) : f.fetcher(input, options)) as typeof fetch, testRasterize);
    const progress: number[][] = [];
    expect(await provider.refresh(['https://github.com/a?secret=1', 'http://github.com/b', 'https://bun.sh', 'http://nas.local'], (done, total) => progress.push([done, total]))).toBe(1);
    expect(progress[0]).toEqual([0, 2]); expect(progress.at(-1)).toEqual([2, 2]);
    expect([...f.saved.keys()]).toEqual(['online:github.com']);
  });

  test('refresh failures keep stale icons and report actionable errors, rather than returning stale successes', async () => {
    const f = fixture({ native: false });
    f.saved.set('online:github.com', BLUE);
    const provider = chromeFavicons(f.api, f.store, (async () => { throw new Error('offline'); }) as unknown as typeof fetch, testRasterize);
    const before = await provider.read('https://github.com');
    await expect(provider.refresh(['https://github.com'], () => {})).rejects.toThrow('Saved icons were kept');
    expect(await provider.read('https://github.com/another')).toBe(before);
    expect(f.saved.get('online:github.com')).toBe(BLUE);
  });

  test('persistent storage errors do not hide a valid downloaded in-memory icon', async () => {
    const f = fixture({ native: false, storageFails: true });
    await expect(f.provider.refresh(['https://github.com'], () => {})).rejects.toThrow('available in this tab');
    expect(await f.provider.read('https://github.com')).toStartWith('blob:');
    expect(f.saved.size).toBe(0);
    const native = fixture({ storageFails: true });
    expect(await native.provider.read('https://local.test/path')).toStartWith('blob:');
  });

  test('empty, fake PNG, corrupt PNG, executable and oversized responses never become saved icons', async () => {
    const f = fixture({ native: false });
    const invalid = [
      new Blob(), new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]),
      new Blob([await RED.slice(0, 40).arrayBuffer()]), new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/png' }),
      new Blob(['<!doctype html><script>alert(1)</script>'], { type: 'image/png' }), new Blob([new Uint8Array(MAX_FAVICON_BYTES + 1)]),
    ];
    for (const icon of invalid) {
      const provider = chromeFavicons(f.api, f.store, (async () => new Response(icon)) as unknown as typeof fetch, testRasterize);
      await expect(provider.refresh(['https://github.com'], () => {})).rejects.toThrow('No online icons');
    }
    expect(f.saved.size).toBe(0);
    // A genuine image with no HTTP MIME header is still accepted and typed.
    const valid = chromeFavicons(f.api, f.store, (async () => new Response(await RED.arrayBuffer())) as unknown as typeof fetch, testRasterize);
    expect(await valid.refresh(['https://github.com'], () => {})).toBe(1);
    expect(f.saved.get('online:github.com')?.type).toBe('image/png');
  });

  test('streaming bounds apply even without Content-Length; redirects are rejected', async () => {
    let cancelled = false;
    const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_FAVICON_BYTES + 1)); }, cancel() { cancelled = true; } }));
    await expect(boundedFaviconResponse(oversized)).rejects.toThrow('too large');
    expect(cancelled).toBe(true);
    const redirected = new Response(RED);
    Object.defineProperty(redirected, 'redirected', { value: true });
    await expect(boundedFaviconResponse(redirected)).rejects.toThrow('provider returned');
  });

  test('failed native reads have a bounded negative cache; explicit online refresh bypasses it', async () => {
    const f = fixture();
    const provider = chromeFavicons(f.api, f.store, (async (input, options) => String(input).startsWith('chrome-extension:') ? new Response('miss', { status: 404 }) : f.fetcher(input, options)) as typeof fetch, testRasterize);
    expect(await provider.read('https://github.com')).toBeNull();
    expect(await provider.refresh(['https://github.com'], () => {})).toBe(1);
    expect(await provider.read('https://github.com')).toStartWith('blob:');
  });

  test('native misses are retried after a short timeout, not cached forever', async () => {
    const f = fixture();
    let failed = true;
    const provider = chromeFavicons(f.api, f.store, (async (input, options) => failed ? new Response('miss', { status: 404 }) : f.fetcher(input, options)) as typeof fetch, testRasterize);
    const start = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(start);
    try {
      expect(await provider.read('https://local.test')).toBeNull();
      failed = false;
      expect(await provider.read('https://local.test')).toBeNull();
      clock.mockReturnValue(start + 31_000);
      expect(await provider.read('https://local.test')).toStartWith('blob:');
    } finally { clock.mockRestore(); }
  });

  test('simultaneous refresh calls do not start competing acquisitions', async () => {
    const f = fixture();
    const first = f.provider.refresh(['https://github.com'], () => {});
    await expect(f.provider.refresh(['https://bun.sh'], () => {})).rejects.toThrow('already running');
    expect(await first).toBe(1);
    expect(f.requests).toHaveLength(1);
  });

  test('in-memory blob URLs are bounded and evicted object URLs are revoked', async () => {
    const f = fixture({ native: false });
    const revoke = spyOn(URL, 'revokeObjectURL');
    try {
      for (let index = 0; index < 1002; index++) {
        f.saved.set(`online:site${index}.github.com`, RED);
        expect(await f.provider.read(`https://site${index}.github.com`)).toStartWith('blob:');
      }
      expect(revoke.mock.calls.length).toBe(2);
    } finally { revoke.mockRestore(); await f.provider.clear!(); }
  });

  test('clear drains in-flight local reads so they cannot resurrect saved icons', async () => {
    const f = fixture();
    let unblock!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { unblock = resolve; });
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const provider = chromeFavicons(f.api, f.store, (async (input, options) => {
      if (!String(input).includes('project-shelf-favicon.invalid')) { started(); await waiting; }
      return f.fetcher(input, options);
    }) as typeof fetch, testRasterize);
    const reading = provider.read('https://local.test');
    await fetching;
    const clearing = provider.clear!();
    unblock();
    await clearing; await reading;
    expect(f.saved.size).toBe(0);
  });

  test('clear removes old and new cache keys and permits a fresh explicit acquisition', async () => {
    const f = fixture({ native: false });
    f.saved.set('https://legacy.test', RED);
    await f.provider.refresh(['https://github.com'], () => {});
    expect(f.saved.size).toBe(2);
    await f.provider.clear!();
    expect(f.saved.size).toBe(0);
    expect(await f.provider.read('https://github.com')).toBeNull();
    expect(await f.provider.refresh(['https://github.com'], () => {})).toBe(1);
  });

  test.skipIf(process.env.RUN_PUBLIC_FAVICON_TESTS !== '1')('acquires a real public-site PNG through the actual provider and cache pipeline', async () => {
    const f = fixture({ native: false });
    const requests: string[] = [];
    const provider = chromeFavicons(f.api, f.store, (async (input, options) => { requests.push(String(input)); return fetch(input, options); }) as typeof fetch, testRasterize);
    expect(await provider.refresh(['https://bun.sh/docs?this-must-stay-local=yes'], () => {})).toBe(1);
    expect(requests).toEqual(['https://icons.duckduckgo.com/ip3/bun.sh.ico']);
    expect(f.saved.get('online:bun.sh')?.size).toBeGreaterThan(100);
    expect(await provider.read('https://bun.sh/other')).toStartWith('blob:');
  }, 20000);
});
