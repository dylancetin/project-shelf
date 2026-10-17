import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createApp } from '../server/app';
import { startServer } from '../server/index';
import { DEFAULT_HOSTNAMES } from '../server/store';
import { cleanup, fixture, project } from './helpers';

describe('trusted panel mutation origins', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const target = 'http://127.0.0.1:4958';

  beforeEach(async () => {
    root = await fixture();
    app = await createApp({ dbPath: path.join(root, 'panel.sqlite'), bootstrap: false, initialSettings: { roots: [] } });
  });
  afterEach(async () => { await app.close(); await cleanup(root); });

  function mutation(origin?: string, headers: Record<string, string> = {}, value: unknown = {}) {
    return app.fetch(new Request(`${target}/api/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(origin === undefined ? {} : { Origin: origin }), ...headers },
      body: JSON.stringify(value),
    }));
  }

  test('accepts every configured network alias on the panel port and standard HTTPS', async () => {
    for (const hostname of DEFAULT_HOSTNAMES) {
      for (const origin of [`http://${hostname}:4958`, `https://${hostname}:4958`, `https://${hostname}`]) {
        expect((await mutation(origin, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
      }
    }
    expect((await mutation('http://BEELINKK:4958')).status).toBe(200);
    // A trusted origin takes precedence over metadata describing a different
    // backend address, but that metadata alone never grants access.
    for (const fetchSite of ['same-site', 'cross-site']) {
      expect((await mutation('http://beelinkk:4958', { 'Sec-Fetch-Site': fetchSite })).status).toBe(200);
    }
  });

  test('accepts the exact HTTPS panel origin behind an HTTP reverse proxy', async () => {
    expect((await mutation('https://panel.tail750ac6.ts.net', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await mutation('https://panel.tail750ac6.ts.net:443', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(200);
    expect((await mutation('http://panel.tail750ac6.ts.net')).status).toBe(403);
    expect((await mutation('https://panel.tail750ac6.ts.net:4958')).status).toBe(403);
  });

  test('uses the listener port when a reverse proxy preserves a public Host without a port', async () => {
    for (const hostname of DEFAULT_HOSTNAMES) {
      const response = await app.fetch(new Request('http://panel.tail750ac6.ts.net/api/settings', {
        method: 'PATCH', headers: { Origin: `http://${hostname}:4958`, 'Content-Type': 'application/json' }, body: '{}',
      }), { port: 4958 });
      expect(response.status).toBe(200);
    }
    const denied = await app.fetch(new Request('http://panel.tail750ac6.ts.net/api/settings', {
      method: 'PATCH', headers: { Origin: 'http://beelinkk', 'Content-Type': 'application/json' }, body: '{}',
    }), { port: 4958 });
    expect(denied.status).toBe(403);
  });

  test('applies hostname edits immediately, persists them, and revokes removed aliases', async () => {
    expect((await mutation('http://shelf.fixture:4958')).status).toBe(403);
    expect((await mutation(undefined, {}, { hostnames: ['shelf.fixture', '[::1]'] })).status).toBe(200);
    expect((await mutation('http://shelf.fixture:4958')).status).toBe(200);
    expect((await mutation('https://shelf.fixture')).status).toBe(200);
    expect((await mutation('http://[::1]:4958')).status).toBe(200);
    expect((await mutation('http://beelinkk:4958')).status).toBe(403);

    await app.close();
    app = await createApp({ dbPath: path.join(root, 'panel.sqlite'), bootstrap: false });
    expect((await mutation('http://shelf.fixture:4958')).status).toBe(200);
    expect((await mutation('http://beelinkk:4958')).status).toBe(403);
    expect((await mutation('https://panel.tail750ac6.ts.net', {}, { hostnames: [] })).status).toBe(200);
    expect((await mutation('http://shelf.fixture:4958')).status).toBe(403);
  });

  test('rejects unknown hosts, arbitrary service ports, malformed origins, and forwarded-header spoofing', async () => {
    app.store.insert(project('', { kind: 'service', url: 'https://linked.fixture/', hostname: 'override.fixture' }));
    for (const origin of [
      'https://evil.example', 'https://linked.fixture', 'https://override.fixture',
      'http://beelinkk:3000', 'https://beelinkk:8443', 'http://beelinkk',
      'https://beelinkk.evil.example', 'https://panel.tail750ac6.ts.net.evil.example',
      'https://other.tail750ac6.ts.net', 'null', 'not an origin',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'file:///', 'data:text/plain,test',
      'https://user:password@panel.tail750ac6.ts.net', 'https://panel.tail750ac6.ts.net/path',
      'https://panel.tail750ac6.ts.net/?query=1', 'https://panel.tail750ac6.ts.net/#fragment',
      'https://panel.tail750ac6.ts.net https://evil.example',
    ]) {
      const response = await mutation(origin, { 'Sec-Fetch-Site': 'same-origin' });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Mutating requests must come from the same origin or a trusted panel address' });
    }
    expect((await mutation('https://evil.example', {
      'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https',
      Forwarded: 'host=evil.example;proto=https',
    })).status).toBe(403);
  });

  test('retains same-origin and CLI behavior without enabling CORS or bypassing body validation', async () => {
    expect((await mutation(target, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await mutation()).status).toBe(200);
    for (const fetchSite of ['same-site', 'cross-site']) {
      expect((await mutation(undefined, { 'Sec-Fetch-Site': fetchSite })).status).toBe(403);
      expect((await mutation(target, { 'Sec-Fetch-Site': fetchSite })).status).toBe(403);
      expect((await mutation('https://evil.example', { 'Sec-Fetch-Site': fetchSite })).status).toBe(403);
    }
    const trusted = await mutation('https://panel.tail750ac6.ts.net');
    expect(trusted.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await mutation('https://panel.tail750ac6.ts.net', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await app.fetch(new Request(`${target}/api/settings`, { headers: { Origin: 'https://evil.example' } }))).status).toBe(200);
  });

  test('uses the actual listening port for aliases over HTTP', async () => {
    const instance = await startServer({ port: 0, hostname: '127.0.0.1', dbPath: path.join(root, 'http.sqlite'), bootstrap: false, initialSettings: { roots: [] } });
    try {
      for (const host of [new URL(instance.server.url).host, 'panel.tail750ac6.ts.net']) {
        for (const [origin, status] of [
          [`http://beelinkk:${instance.server.port}`, 200],
          ['https://panel.tail750ac6.ts.net', 200],
          ['http://beelinkk:1', 403],
          ['https://evil.example', 403],
        ] as const) {
          const response = await fetch(new URL('/api/settings', instance.server.url), {
            method: 'PATCH', headers: { Host: host, Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}',
          });
          expect(response.status).toBe(status);
          await response.text();
        }
      }
    } finally {
      await instance.stop();
    }
  });
});
