import { describe, expect, test } from 'bun:test';
import {
  BUBBLE_PIXELS, BUBBLE_SETTINGS_KEY, DEFAULT_BUBBLE_SETTINGS, PANEL_SIZE, embedUrl, parseBubbleSettings,
  parseEmbedToHostMessage, parseHostToEmbedMessage, readEmbedParams, type BubbleSettings,
} from '../shared/embed';

const custom: BubbleSettings = {
  corner: 'top-left', size: 'large', idleOpacity: 0.5, offsetX: 40, offsetY: 120, showLogBadge: false,
  defaultTab: 'logs', hiddenOrigins: ['http://beelinkk:3000', 'https://docs.example.test'],
};

describe('bubble settings', () => {
  test('fall back to the documented defaults for anything that is not an object', () => {
    expect(DEFAULT_BUBBLE_SETTINGS).toEqual({
      corner: 'bottom-right', size: 'medium', idleOpacity: 0.85, offsetX: 16, offsetY: 16, showLogBadge: true, defaultTab: 'controls', hiddenOrigins: [],
    });
    for (const value of [undefined, null, 'corner', 7, true, [], [custom], () => custom, Symbol('x'), 10n]) {
      expect(parseBubbleSettings(value)).toEqual(DEFAULT_BUBBLE_SETTINGS);
    }
    expect(BUBBLE_SETTINGS_KEY).toBe('project-shelf.bubble');
  });

  test('keeps valid values, drops unknown fields, and is idempotent', () => {
    expect(parseBubbleSettings(custom)).toEqual(custom);
    const parsed = parseBubbleSettings({ ...custom, extra: 'ignored', __proto__: { corner: 'top-right' } });
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_BUBBLE_SETTINGS).sort());
    expect(parseBubbleSettings(parsed)).toEqual(parsed);
  });

  test('replaces wrong types and unknown choices field by field, without discarding the valid fields', () => {
    expect(parseBubbleSettings({ ...custom, corner: 'middle', size: 'huge', defaultTab: 'settings', showLogBadge: 'yes', idleOpacity: '0.5', offsetX: null, offsetY: {} }))
      .toEqual({ ...DEFAULT_BUBBLE_SETTINGS, hiddenOrigins: custom.hiddenOrigins });
    expect(parseBubbleSettings({ corner: ['top-left'], size: 1 }).corner).toBe('bottom-right');
  });

  test('clamps out-of-range numbers and ignores non-finite ones', () => {
    expect(parseBubbleSettings({ idleOpacity: 0.1, offsetX: -20, offsetY: -0.4 })).toMatchObject({ idleOpacity: 0.3, offsetX: 0, offsetY: 0 });
    expect(parseBubbleSettings({ idleOpacity: 7, offsetX: 99999, offsetY: 400.4 })).toMatchObject({ idleOpacity: 1, offsetX: 400, offsetY: 400 });
    expect(parseBubbleSettings({ offsetX: 12.6, offsetY: 0.4 })).toMatchObject({ offsetX: 13, offsetY: 0 });
    expect(parseBubbleSettings({ idleOpacity: 0.3 }).idleOpacity).toBe(0.3);
    expect(parseBubbleSettings({ idleOpacity: 1, offsetX: 400 })).toMatchObject({ idleOpacity: 1, offsetX: 400 });
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(parseBubbleSettings({ idleOpacity: bad, offsetX: bad, offsetY: bad })).toMatchObject({ idleOpacity: 0.85, offsetX: 16, offsetY: 16 });
    }
  });

  test('hidden origins are normalized to http(s) origins, deduplicated, and bounded', () => {
    const parsed = parseBubbleSettings({ hiddenOrigins: [
      'http://beelinkk:3000/some/path?q=1#frag', 'http://beelinkk:3000', 'HTTPS://Docs.Example.test:443/', 'ftp://beelinkk/', 'javascript:alert(1)',
      'beelinkk:3000', 'not a url', '', 42, null, {}, ['http://nested.test'],
    ] });
    expect(parsed.hiddenOrigins).toEqual(['http://beelinkk:3000', 'https://docs.example.test']);
    expect(parseBubbleSettings({ hiddenOrigins: 'http://beelinkk:3000' }).hiddenOrigins).toEqual([]);
    const many = Array.from({ length: 5000 }, (_, index) => `http://host${index}.test`);
    expect(parseBubbleSettings({ hiddenOrigins: many }).hiddenOrigins).toHaveLength(200);
  });

  test('never hands out shared mutable defaults', () => {
    parseBubbleSettings(undefined).hiddenOrigins.push('http://leak.test');
    expect(DEFAULT_BUBBLE_SETTINGS.hiddenOrigins).toEqual([]);
    expect(parseBubbleSettings(undefined).hiddenOrigins).toEqual([]);
  });
});

describe('postMessage contract', () => {
  const toEmbed = { source: 'project-shelf-host', type: 'settings', settings: custom };

  test('host to embed accepts exactly the settings message and normalizes its settings', () => {
    expect<unknown>(parseHostToEmbedMessage(toEmbed)).toEqual(toEmbed);
    expect<unknown>(parseHostToEmbedMessage({ ...toEmbed, extra: 1, settings: { ...custom, idleOpacity: 0, offsetX: 1e9, corner: 'x' } }))
      .toEqual({ ...toEmbed, settings: { ...custom, idleOpacity: 0.3, offsetX: 400, corner: 'bottom-right' } });
    for (const bad of [undefined, null, 'settings', 7, [], [toEmbed], {}, { ...toEmbed, source: 'project-shelf-embed' }, { ...toEmbed, source: undefined },
      { ...toEmbed, type: 'layout' }, { ...toEmbed, type: undefined }, { source: toEmbed.source, type: toEmbed.type },
      { ...toEmbed, settings: null }, { ...toEmbed, settings: 'dark' }, { ...toEmbed, settings: [custom] }, { ...toEmbed, settings: 5 }]) {
      expect<unknown>(parseHostToEmbedMessage(bad)).toBeNull();
    }
  });

  test('embed to host accepts ready, layout, and settings only', () => {
    const ready = { source: 'project-shelf-embed', type: 'ready' };
    expect<unknown>(parseEmbedToHostMessage(ready)).toEqual(ready);
    expect<unknown>(parseEmbedToHostMessage({ ...ready, extra: 'x' })).toEqual(ready);
    for (const layout of ['hidden', 'bubble', 'panel']) {
      expect<unknown>(parseEmbedToHostMessage({ source: 'project-shelf-embed', type: 'layout', layout })).toEqual({ source: 'project-shelf-embed', type: 'layout', layout });
    }
    const settings = { source: 'project-shelf-embed', type: 'settings', settings: custom };
    expect<unknown>(parseEmbedToHostMessage(settings)).toEqual(settings);
    expect<unknown>(parseEmbedToHostMessage({ ...settings, settings: { ...custom, offsetY: -50, size: 'colossal' } }))
      .toEqual({ ...settings, settings: { ...custom, offsetY: 0, size: 'medium' } });
    for (const bad of [undefined, null, 'ready', 0, [], [ready], {}, { type: 'ready' }, { source: 'project-shelf-host', type: 'ready' },
      { source: 'project-shelf-embed' }, { source: 'project-shelf-embed', type: 'close' }, { source: 'project-shelf-embed', type: 'READY' },
      { source: 'project-shelf-embed', type: 'layout' }, { source: 'project-shelf-embed', type: 'layout', layout: 'fullscreen' },
      { source: 'project-shelf-embed', type: 'layout', layout: ['panel'] }, { source: 'project-shelf-embed', type: 'layout', layout: 'PANEL' },
      { source: 'project-shelf-embed', type: 'settings' }, { source: 'project-shelf-embed', type: 'settings', settings: null },
      { source: 'project-shelf-embed', type: 'settings', settings: 'x' }, { source: 'project-shelf-embed', type: 'settings', settings: [] }]) {
      expect<unknown>(parseEmbedToHostMessage(bad)).toBeNull();
    }
  });
});

describe('embed address', () => {
  test('builds the page address and reads it back, however the page URL is spelled', () => {
    for (const page of ['http://beelinkk:5173/', 'https://app.example.test/a b?x=1&y=%20#frag', 'http://[::1]:3000/']) {
      for (const surface of ['bubble', 'popup'] as const) {
        const address = embedUrl('http://beelinkk:4958', surface, page);
        expect(address.startsWith('http://beelinkk:4958/embed.html?surface=')).toBe(true);
        expect(address.indexOf('surface=')).toBeLessThan(address.indexOf('&url='));
        const params = readEmbedParams(new URL(address).search);
        expect(params.surface).toBe(surface);
        expect(params.pageUrl?.href).toBe(new URL(page).href);
      }
    }
  });

  test('tolerates a trailing slash and a path prefix on the panel address', () => {
    expect(embedUrl('http://beelinkk:4958/', 'bubble', 'http://x.test/')).toStartWith('http://beelinkk:4958/embed.html?');
    expect(embedUrl('https://shelf.example.test/shelf//', 'popup', 'http://x.test/')).toStartWith('https://shelf.example.test/shelf/embed.html?');
  });

  test('reads parameters defensively', () => {
    expect(readEmbedParams('')).toEqual({ surface: 'popup', pageUrl: null });
    expect(readEmbedParams('?surface=bubble')).toEqual({ surface: 'bubble', pageUrl: null });
    expect(readEmbedParams('surface=popup&url=http%3A%2F%2Fa.test%2F').pageUrl?.href).toBe('http://a.test/');
    expect(readEmbedParams('?surface=sidebar&url=http%3A%2F%2Fa.test%2F').surface).toBe('popup');
    expect(readEmbedParams('?surface=BUBBLE').surface).toBe('popup');
    for (const url of ['', 'not a url', 'a.test:3000', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://a.test/', 'data:text/html,hi', 'chrome://newtab']) {
      expect(readEmbedParams(`?surface=bubble&url=${encodeURIComponent(url)}`)).toEqual({ surface: 'bubble', pageUrl: null });
    }
    expect(readEmbedParams('?url=%E0%A4%A')).toEqual({ surface: 'popup', pageUrl: null });
  });

  test('exposes the fixed geometry', () => {
    expect(BUBBLE_PIXELS).toEqual({ small: 40, medium: 48, large: 58 });
    expect(PANEL_SIZE).toEqual({ width: 384, height: 560 });
  });
});
