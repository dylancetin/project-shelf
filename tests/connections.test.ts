import { expect, test } from 'bun:test';
import { projectInput } from '../server/validation';
import { project } from './helpers';
import type { Settings } from '../shared/types';

const settings: Settings = { roots: [], hostnames: ['192.168.1.50'], defaultHostname: '', defaultSearchEngine: 'duckduckgo', lastScanAt: null };

test('changing a direct launch port keeps its navigation URL in sync', async () => {
  const previous = project('/tmp/opencode', { port: 5173, url: 'http://localhost:5173/demo?q=1#section' });
  const changed = await projectInput({ port: 4871, url: previous.url }, settings, previous);
  expect(changed.url).toBe('http://localhost:4871/demo?q=1#section');
  const proxied = await projectInput({ port: 4871 }, settings, { ...previous, url: 'https://app.example.test/demo' });
  expect(proxied.url).toBe('https://app.example.test/demo');
  const explicit = await projectInput({ port: 4871, url: 'http://beelinkk:9000/' }, settings, previous);
  expect(explicit.url).toBe('http://beelinkk:9000/');
});

test('new project links default to the server while explicit original-host choice is preserved', async () => {
  const input = { name: 'Connection fixture', kind: 'project', directory: '/tmp/opencode', port: 4871 };
  expect((await projectInput(input, settings)).hostname).toBe('beelinkk');
  expect((await projectInput({ ...input, hostname: '' }, settings)).hostname).toBe('');
  expect((await projectInput({ name: 'Service fixture', kind: 'service', url: 'https://immich.tail750ac6.ts.net/' }, settings)).hostname).toBe('');
});

test('preferred hostname applies to direct services, not reverse proxies or other machines', async () => {
  const preferred = { ...settings, defaultHostname: 'beelinkk' };
  for (const url of ['http://192.168.1.50:8080/a?q=1#b', 'http://100.119.176.63:8080/a?q=1#b', 'http://localhost:3000/']) {
    const entry = await projectInput({ name: 'Direct service', kind: 'service', url }, preferred);
    expect(entry.hostname).toBe('beelinkk');
    expect(entry.url).toBe(url);
  }
  for (const url of ['https://immich.tail750ac6.ts.net/photos', 'http://192.168.1.60:3000/']) {
    expect((await projectInput({ name: 'Other host', kind: 'service', url }, preferred)).hostname).toBe('');
  }
  expect((await projectInput({ name: 'Proxied project', kind: 'project', directory: '/tmp/opencode', url: 'https://project.tail750ac6.ts.net/' }, preferred)).hostname).toBe('');
});
