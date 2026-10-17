import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectAvatar } from '../src/components';
import { serviceIcon } from '../src/service-icons';
import { project } from './helpers';

const services = [
  ['Audiobookshelf', 'audiobookshelf.svg'],
  ['Bazarr', 'bazarr.svg'],
  ['CLIProxy CPAMC', 'cliproxy-cpamc.jpg'],
  ['CLI Proxy API Management Center', 'cliproxy-cpamc.jpg'],
  ['CPAMC', 'cliproxy-cpamc.jpg'],
  ['CLIProxyAPI', 'cliproxy-cpamc.jpg'],
  ['[Beelink-home] Dashboard | Coolify', 'coolify.svg'],
  ['Forgejo', 'forgejo.svg'],
  ['Gitea Mirror', 'gitea.svg'],
  ['Gitea: Git with a cup of tea', 'gitea.svg'],
  ['Photos - Immich', 'immich.svg'],
  ['Jellyfin', 'jellyfin.svg'],
  ['Kapowarr', 'kapowarr.svg'],
  ['Kavita', 'kavita.svg'],
  ['LazyLibrarian - Authors', 'lazylibrarian.png'],
  ['Dashboard - Nextcloud', 'nextcloud.svg'],
  ['ntfy', 'ntfy.svg'],
  ['OpenClaw Control', 'openclaw.svg'],
  ['OpenCode', 'opencode.svg'],
  ['Pi-hole 127eaeff487d', 'pi-hole.svg'],
  ['Plex', 'plex.svg'],
  ['Indexers - Prowlarr', 'prowlarr.svg'],
  ['qBittorrent WebUI', 'qbittorrent.svg'],
  ['Radarr', 'radarr.svg'],
  ['Sonarr', 'sonarr.svg'],
  ['Syncthing', 'syncthing.svg'],
  ['T3 Code (Alpha)', 't3-code.webp'],
  ['t3-nightly.tail750ac6.ts.net', 't3-code-nightly.webp'],
];

test('imported service titles resolve to real, bundled images', async () => {
  for (const [name, file] of services) {
    const icon = serviceIcon({ kind: 'service', name: name.toUpperCase(), url: 'http://localhost:1234/' });
    expect(icon).toBe(`/service-icons/${file}`);
    const asset = Bun.file(new URL(`../public${icon}`, import.meta.url));
    expect(await asset.exists()).toBe(true);
    expect(asset.size).toBeGreaterThan(0);
    if (file.endsWith('.svg')) {
      const svg = await asset.text();
      expect(svg).toMatch(/<svg\b/);
      expect(svg).not.toMatch(/<script|<foreignObject|\bon\w+\s*=|(?:href|url)\s*[=(]\s*["']?(?:https?:|\/\/|data:|javascript:)/i);
    }
  }
});

test('service subdomains work without inspecting URL paths, queries, or unrelated domains', () => {
  expect(serviceIcon({ kind: 'service', name: 'Photos', url: 'https://immich.example.test/photos' })).toBe('/service-icons/immich.svg');
  expect(serviceIcon({ kind: 'service', name: 'T3 Code', url: 'https://t3-nightly.example.test/' })).toBe('/service-icons/t3-code-nightly.webp');
  expect(serviceIcon({ kind: 'service', name: 'Code', url: 'https://t3.example.test/' })).toBe('/service-icons/t3-code.webp');
  expect(serviceIcon({ kind: 'service', name: 'Management', url: 'https://cpamc.example.test/' })).toBe('/service-icons/cliproxy-cpamc.jpg');
  expect(serviceIcon({ kind: 'service', name: 'Sonarr', url: 'https://plex.example.test/' })).toBe('/service-icons/sonarr.svg');
  for (const url of ['http://localhost:8989/', 'https://example.test/sonarr?q=plex', 'https://notplex.example.test/', 'https://example.plex.test/']) {
    expect(serviceIcon({ kind: 'service', name: 'Unknown', url })).toBe('');
  }
  expect(serviceIcon({ kind: 'service', name: '127.0.0.1', url: 'http://localhost:8080/' })).toBe('');
  expect(serviceIcon({ kind: 'service', name: 'Unrelated app', url: 'http://beelinkk:8317/management.html#/quota' })).toBe('');
  expect(serviceIcon({ kind: 'service', name: 'Plex', url: 'not a URL' })).toBe('/service-icons/plex.svg');
});

test('project identities and custom logos are preserved; unknown services retain monograms', () => {
  const entry = project('', { name: 'Jellyfin', kind: 'service', url: 'http://localhost:8096/' });
  expect(renderToStaticMarkup(createElement(ProjectAvatar, { project: entry }))).toContain('src="/service-icons/jellyfin.svg"');
  const custom = renderToStaticMarkup(createElement(ProjectAvatar, { project: { ...entry, logo: 'public/custom.svg' } }));
  expect(custom).toContain(`/api/projects/${entry.id}/logo?path=public%2Fcustom.svg`);
  expect(custom).not.toContain('/service-icons/');
  expect(serviceIcon({ ...entry, kind: 'project' })).toBe('');
  const unknown = renderToStaticMarkup(createElement(ProjectAvatar, { project: { ...entry, name: 'Unknown service' } }));
  expect(unknown).not.toContain('<img');
  expect(unknown).toContain('US');
});

test('remote logos render directly without a referrer and override automatic icons', () => {
  const logo = 'https://tip.cu.edu.tr/storage/settings/April2019/5vMnGIZ4b3XRgvIKKStA.png';
  for (const kind of ['project', 'service'] as const) {
    const entry = project('', { name: 'Jellyfin', kind, logo, url: 'http://localhost:8096/' });
    const markup = renderToStaticMarkup(createElement(ProjectAvatar, { project: entry }));
    expect(markup).toContain(`src="${logo}"`);
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).not.toContain('/api/projects/');
    expect(markup).not.toContain('/service-icons/');
  }
});
