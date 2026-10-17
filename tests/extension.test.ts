import { afterEach, describe, expect, test } from 'bun:test';
import { appBaseUrl, bridgeUrl, checkConnection, extensionSnapshotKey, healthUrl, manageUrl, normalizeUrl, parseSettings, permissionOrigin } from '../extension/src/core';
import { BRIDGE_CHANNEL, trustedParent, validApiRequest } from '../extension/src/protocol';
import { configurePlatform } from '../src/platform';
import { readSnapshot, saveSnapshot } from '../src/offline';
import { project } from './helpers';

afterEach(() => configurePlatform({}));

describe('Chrome companion settings', () => {
  test('normalizes HTTP(S) addresses without losing paths, ports, queries, or fragments', () => {
    expect(normalizeUrl('  http://beelinkk:4958  ')).toBe('http://beelinkk:4958/');
    expect(normalizeUrl('https://shelf.example.test/shelf/?q=one%20two#manage/services'))
      .toBe('https://shelf.example.test/shelf/?q=one%20two#manage/services');
    expect(normalizeUrl('http://[::1]:4958/')).toBe('http://[::1]:4958/');
  });

  test('rejects executable, local-file, credential-bearing, and malformed destinations', () => {
    for (const input of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd',
      'chrome://newtab', 'beelinkk:4958', '', 'http://name:password@beelinkk:4958/',
      'https://example.test/a b', 'https://exam\nple.test/', 'http://beelinkk:99999/', 'https://*.example.test/', 'http://*/']) {
      expect(() => normalizeUrl(input)).toThrow();
    }
  });

  test('distinguishes an unconfigured profile from corrupt settings', () => {
    expect(parseSettings(undefined)).toBeNull();
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings({ url: 'http://beelinkk:4958', checkBeforeOpen: false }))
      .toEqual({ url: 'http://beelinkk:4958/' });
    expect(parseSettings({ url: 'https://example.test/' })).toEqual({ url: 'https://example.test/' });
    for (const input of [{}, 'url', { url: false },
      { url: 'javascript:alert(1)', checkBeforeOpen: true }]) {
      expect(() => parseSettings(input)).toThrow();
    }
  });

  test('requests only the configured scheme/hostname, with Chrome’s all-port semantics', () => {
    expect(permissionOrigin('http://beelinkk:4958/shelf/?q=1#home')).toBe('http://beelinkk/*');
    expect(permissionOrigin('https://shelf.example.test/')).toBe('https://shelf.example.test/*');
    expect(permissionOrigin('http://[::1]:4958/')).toBe('http://[::1]/*');
  });

  test('Manage changes only the hash; health uses the app base path without user query data', () => {
    const url = 'https://shelf.example.test:8443/shelf/?q=private#manage/services';
    expect(manageUrl(url)).toBe('https://shelf.example.test:8443/shelf/?q=private#manage');
    expect(healthUrl(url)).toBe('https://shelf.example.test:8443/shelf/api/health');
    expect(healthUrl('http://beelinkk:4958/')).toBe('http://beelinkk:4958/api/health');
    expect(healthUrl('http://beelinkk:4958/shelf')).toBe('http://beelinkk:4958/shelf/api/health');
  });

  test('scopes the bridge and local snapshot to the actual server, not a route fragment', () => {
    const url = 'https://shelf.example.test:8443/shelf/?secret=private#manage/services';
    expect(appBaseUrl(url)).toBe('https://shelf.example.test:8443/shelf/');
    expect(bridgeUrl(url)).toBe('https://shelf.example.test:8443/shelf/api/extension/bridge');
    expect(extensionSnapshotKey(url)).toBe(extensionSnapshotKey('https://shelf.example.test:8443/shelf/'));
    expect(extensionSnapshotKey(url)).not.toBe(extensionSnapshotKey('https://shelf.example.test:8444/shelf/'));
    expect(extensionSnapshotKey(url)).not.toBe(extensionSnapshotKey('https://shelf.example.test:8443/other/'));
  });

  test('switching servers never shows another server’s cached projects', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    configurePlatform({ snapshotKey: extensionSnapshotKey('http://one.test:4958/') });
    saveSnapshot([{ ...project('/tmp/opencode/extension-fixture'), runtime: { status: 'running', mode: 'dev', pid: 123, startedAt: null, exitCode: null } }], null, storage);
    expect(readSnapshot(storage)?.projects).toHaveLength(1);
    expect(readSnapshot(storage)?.projects[0]).not.toHaveProperty('runtime');
    configurePlatform({ snapshotKey: extensionSnapshotKey('http://two.test:4958/') });
    expect(readSnapshot(storage)).toBeNull();
    configurePlatform({ snapshotKey: extensionSnapshotKey('http://one.test:4958/') });
    expect(readSnapshot(storage)?.projects).toHaveLength(1);
  });
});

describe('extension bridge boundaries', () => {
  const request = { channel: BRIDGE_CHANNEL, type: 'request', id: '12345678-1234-1234-1234-123456789abc', path: '/projects', method: 'GET' };

  test('only accepts bounded API requests, never arbitrary URLs, traversal, headers, or methods', () => {
    expect(validApiRequest(request)).toBe(true);
    expect(validApiRequest({ ...request, path: '/projects/project-id/start', method: 'POST', body: '{"mode":"dev"}' })).toBe(true);
    expect(validApiRequest({ ...request, path: '/projects/reorder', method: 'POST', body: '{"kind":"service","ids":[],"previousIds":[]}' })).toBe(true);
    for (const path of ['https://evil.test/', '//evil.test/', '/../../scan', '/projects/%2e%2e', '/projects/id/../../settings', '/projects?q=private', '/extension/bridge', '/projects/id/logo']) {
      expect(validApiRequest({ ...request, path })).toBe(false);
    }
    expect(validApiRequest({ ...request, method: 'PUT' })).toBe(false);
    expect(validApiRequest({ ...request, body: {} })).toBe(false);
    expect(validApiRequest({ ...request, body: 'x'.repeat(5 * 1024 * 1024 + 1) })).toBe(false);
    expect(validApiRequest({ ...request, id: 'invalid' })).toBe(false);
  });

  test('requires both the exact extension origin and the actual parent window', () => {
    const parent = {} as Window;
    const other = {} as Window;
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    expect(trustedParent(`chrome-extension://${id}`, id, parent, parent)).toBe(true);
    expect(trustedParent('https://evil.test', id, parent, parent)).toBe(false);
    expect(trustedParent('chrome-extension://pppppppppppppppppppppppppppppppp', id, parent, parent)).toBe(false);
    expect(trustedParent(`chrome-extension://${id}`, id, other, parent)).toBe(false);
  });
});

describe('Chrome companion connection check', () => {
  const respond = (response: Response) => (async () => response) as unknown as typeof fetch;

  test('validates the real health response and never caches, follows redirects, or sends cookies', async () => {
    let requested = '';
    let options: RequestInit | undefined;
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
      requested = String(url);
      options = init;
      return Response.json({ ok: true });
    }) as typeof fetch;
    await checkConnection('http://beelinkk:4958/?secret=private#manage', request);
    expect(requested).toBe('http://beelinkk:4958/api/health');
    expect(options).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  test('does not mistake an error, login HTML, or another server for a healthy shelf', async () => {
    await expect(checkConnection('http://beelinkk:4958/', respond(new Response('Unavailable', { status: 503 }))))
      .rejects.toThrow('HTTP 503');
    for (const response of [new Response('<html>Login</html>'), Response.json({ ok: false }), Response.json({}), Response.json(null)]) {
      await expect(checkConnection('http://beelinkk:4958/', respond(response)))
        .rejects.toThrow('did not return a Project Shelf health response');
    }
  });

  test('turns network errors into an actionable retry message', async () => {
    const request = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(checkConnection('http://beelinkk:4958/', request)).rejects.toThrow('Check the server, network, or Tailscale');
  });

  test('bounds slow requests and aborts them', async () => {
    let aborted = false;
    const request = ((_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    })) as unknown as typeof fetch;
    await expect(checkConnection('http://beelinkk:4958/', request, 15)).rejects.toThrow('took too long');
    expect(aborted).toBe(true);
  });
});
