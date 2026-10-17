import { describe, expect, test } from 'bun:test';
import { importBookmarks, isLocalUrl, parseBookmarks } from '../server/bookmarks';
import { Store } from '../server/store';

const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
  <DT><A HREF="http://192.168.1.50:9000/">Portainer &amp; containers</A>
  <DT><a href='https://beelinkk.tail750ac6.ts.net:8443/path?a=1&amp;b=2#status'>Local dashboard</a>
  <DT><A HREF=http://beelinkk:3000/>Grafana &#x26; metrics</A>
  <DT><A HREF="http://192.168.1.50:9000">Duplicate</A>
  <DT><A HREF="https://example.com/">Public bookmark</A>
  <DT><A HREF="javascript:alert(1)">Unsafe</A>
</DL>`;

describe('local bookmark import', () => {
  test('deduplicates server aliases while preserving reverse-proxy hostnames and distinct destinations', () => {
    const store = new Store(':memory:', { defaultHostname: 'beelinkk' });
    try {
      const exportHtml = '<a href="http://192.168.1.50:8081/">Downloads</a><a href="http://beelinkk:8081/">Same downloads</a><a href="http://100.119.176.63:8081/">Same downloads via Tailscale IP</a><a href="https://immich.tail750ac6.ts.net/photos">Photos</a><a href="http://beelinkk:8081/settings">Download settings</a>';
      expect(importBookmarks(store, exportHtml)).toEqual({ added: 3, skipped: 2 });
      expect(importBookmarks(store, exportHtml)).toEqual({ added: 0, skipped: 5 });
      expect(store.list().filter(item => item.name !== 'Photos').every(item => item.hostname === 'beelinkk')).toBe(true);
      expect(store.list().find(item => item.name === 'Photos')?.hostname).toBe('');
      expect(store.list().find(item => item.name === 'Photos')?.url).toBe('https://immich.tail750ac6.ts.net/photos');
    } finally { store.close(); }
  });
  test('parses Netscape exports, entities and mixed attribute syntax; filters remote/unsafe URLs', () => {
    const parsed = parseBookmarks(html);
    expect(parsed.bookmarks).toEqual([
      { name: 'Portainer & containers', url: 'http://192.168.1.50:9000/' },
      { name: 'Local dashboard', url: 'https://beelinkk.tail750ac6.ts.net:8443/path?a=1&b=2#status' },
      { name: 'Grafana & metrics', url: 'http://beelinkk:3000/' },
    ]);
    expect(parsed.skipped).toBe(3);
    expect(parseBookmarks(html, false).bookmarks).toHaveLength(4);
  });

  test('classifies RFC1918, loopback, tailscale and local IPv6 without accepting arbitrary public hosts', () => {
    for (const host of ['localhost', 'foo.localhost', 'nas.local', '10.0.0.1', '172.31.1.1', '192.168.0.1', '100.100.0.1', '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:192.168.1.1]']) {
      expect(isLocalUrl(`http://${host}/`)).toBe(true);
    }
    for (const host of ['8.8.8.8', '172.32.0.1', '100.128.0.1', 'example.org', 'evil-localhost.com', '[2001:4860:4860::8888]']) {
      expect(isLocalUrl(`https://${host}/`)).toBe(false);
    }
  });

  test('imports only service registrations and deduplicates normalized URLs across repeated imports', () => {
    const store = new Store(':memory:');
    try {
      expect(importBookmarks(store, html)).toEqual({ added: 3, skipped: 3 });
      expect(importBookmarks(store, html)).toEqual({ added: 0, skipped: 6 });
      expect(store.list().every((item) => item.kind === 'service' && !item.directory && !item.devCommand)).toBe(true);
      expect(store.list().find((item) => item.name.includes('Portainer'))?.port).toBe(9000);
    } finally { store.close(); }
  });
});
