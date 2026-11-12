import { describe, expect, test } from 'bun:test';
import { BUBBLE_PIXELS, DEFAULT_BUBBLE_SETTINGS, PANEL_SIZE, type BubbleCorner, type BubbleSettings } from '../shared/embed';
import { bubbleMatches, bubblePatterns, canHostBubble, hostPattern, pageOrigin, parseHostnames, sameMatches } from '../extension/src/bubble-hosts';
import { acceptEmbedMessage, withoutHiddenOrigin } from '../extension/src/embed-host';
import { frameOpacity, frameRect, PANEL_MARGIN } from '../extension/src/frame-rect';
import { FAVICON_PROVIDER_ORIGIN } from '../extension/src/favicon-policy';

const settings = (patch: Partial<BubbleSettings> = {}): BubbleSettings => ({ ...DEFAULT_BUBBLE_SETTINGS, ...patch });
const desktop = { width: 1440, height: 900 };

describe('bubble frame geometry', () => {
  test('stays out of the way until the embed asks to be shown', () => {
    expect(frameRect('hidden', settings(), desktop)).toEqual({ visible: false, width: 0, height: 0 });
  });

  test('anchors the bubble to each corner by its offsets', () => {
    const base = settings({ size: 'medium', offsetX: 20, offsetY: 30 });
    const side = BUBBLE_PIXELS.medium;
    const cases: [BubbleCorner, object][] = [
      ['bottom-right', { bottom: 30, right: 20 }],
      ['bottom-left', { bottom: 30, left: 20 }],
      ['top-right', { top: 30, right: 20 }],
      ['top-left', { top: 30, left: 20 }],
    ];
    for (const [corner, anchors] of cases) {
      expect(frameRect('bubble', { ...base, corner }, desktop)).toEqual({ visible: true, width: side, height: side, ...anchors });
    }
  });

  test('sizes the bubble from the setting', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      expect(frameRect('bubble', settings({ size }), desktop)).toMatchObject({ width: BUBBLE_PIXELS[size], height: BUBBLE_PIXELS[size] });
    }
  });

  test('opens the panel at full size from the same corner and offsets', () => {
    const cases: [BubbleCorner, object][] = [
      ['bottom-right', { bottom: 12, right: 40 }],
      ['bottom-left', { bottom: 12, left: 40 }],
      ['top-right', { top: 12, right: 40 }],
      ['top-left', { top: 12, left: 40 }],
    ];
    for (const [corner, anchors] of cases) {
      expect(frameRect('panel', settings({ corner, offsetX: 40, offsetY: 12 }), desktop))
        .toEqual({ visible: true, width: PANEL_SIZE.width, height: PANEL_SIZE.height, ...anchors });
    }
  });

  test('shrinks the panel to fit a viewport smaller than it, keeping a margin on every side', () => {
    const rect = frameRect('panel', settings({ corner: 'bottom-right', offsetX: 16, offsetY: 16 }), { width: 300, height: 400 });
    expect(rect.width).toBe(300 - 2 * PANEL_MARGIN);
    expect(rect.height).toBe(400 - 2 * PANEL_MARGIN);
    expect(rect.right).toBe(PANEL_MARGIN);
    expect(rect.bottom).toBe(PANEL_MARGIN);
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const placed = frameRect('panel', settings({ corner, offsetX: 400, offsetY: 400 }), { width: 300, height: 400 });
      const horizontal = (placed.left ?? placed.right ?? NaN);
      const vertical = (placed.top ?? placed.bottom ?? NaN);
      expect(horizontal).toBeGreaterThanOrEqual(0);
      expect(vertical).toBeGreaterThanOrEqual(0);
      expect(horizontal + placed.width).toBeLessThanOrEqual(300 - PANEL_MARGIN);
      expect(vertical + placed.height).toBeLessThanOrEqual(400 - PANEL_MARGIN);
    }
  });

  test('keeps the bubble on screen when the offset would push it past the far edge', () => {
    const rect = frameRect('bubble', settings({ corner: 'top-left', size: 'large', offsetX: 400, offsetY: 400 }), { width: 320, height: 240 });
    expect(rect).toEqual({ visible: true, width: 58, height: 58, left: 320 - 58, top: 240 - 58 });
  });

  test('never reports a frame larger than a collapsed window', () => {
    expect(frameRect('bubble', settings({ size: 'large' }), { width: 30, height: 20 })).toMatchObject({ width: 30, height: 20 });
    expect(frameRect('panel', settings(), { width: 10, height: 10 })).toMatchObject({ visible: true, width: 0, height: 0 });
    expect(frameRect('panel', settings(), { width: -5, height: Number.NaN })).toMatchObject({ width: 0, height: 0 });
  });

  test('uses whole pixels for fractional viewports and sets exactly one anchor per axis', () => {
    const rect = frameRect('bubble', settings({ corner: 'top-right' }), { width: 1000.9, height: 700.4 });
    expect(Object.keys(rect).sort()).toEqual(['height', 'right', 'top', 'visible', 'width']);
    expect(Number.isInteger(rect.right) && Number.isInteger(rect.top)).toBe(true);
  });

  test('fades only the idle bubble; the panel and a hovered bubble are fully opaque', () => {
    const faded = settings({ idleOpacity: 0.4 });
    expect(frameOpacity('bubble', faded, false)).toBe(0.4);
    expect(frameOpacity('bubble', faded, true)).toBe(1);
    expect(frameOpacity('panel', faded, false)).toBe(1);
    expect(frameOpacity('hidden', faded, false)).toBe(1);
  });
});

describe('embed message acceptance', () => {
  const frame = { frame: true };
  const panelOrigin = 'http://beelinkk:4958';
  const ready = { source: 'project-shelf-embed', type: 'ready' } as const;

  test('accepts a contract message from the frame at the panel origin', () => {
    expect(acceptEmbedMessage({ source: frame, origin: panelOrigin, data: ready }, frame, panelOrigin)).toEqual(ready);
    expect(acceptEmbedMessage({ source: frame, origin: panelOrigin, data: { source: 'project-shelf-embed', type: 'layout', layout: 'panel' } }, frame, panelOrigin))
      .toEqual({ source: 'project-shelf-embed', type: 'layout', layout: 'panel' });
  });

  test('normalizes settings from the frame through the contract parser', () => {
    const message = acceptEmbedMessage({ source: frame, origin: panelOrigin, data: { source: 'project-shelf-embed', type: 'settings', settings: { corner: 'top-left', offsetX: 9999, extra: 1 } } }, frame, panelOrigin);
    expect(message).toMatchObject({ type: 'settings', settings: { corner: 'top-left', offsetX: 400 } });
  });

  test('ignores the page itself, other frames, and other origins, even with a perfect payload', () => {
    expect(acceptEmbedMessage({ source: {}, origin: panelOrigin, data: ready }, frame, panelOrigin)).toBeNull();
    expect(acceptEmbedMessage({ source: frame, origin: 'http://evil.test', data: ready }, frame, panelOrigin)).toBeNull();
    expect(acceptEmbedMessage({ source: frame, origin: 'http://beelinkk:4959', data: ready }, frame, panelOrigin)).toBeNull();
    expect(acceptEmbedMessage({ source: frame, origin: `${panelOrigin}/`, data: ready }, frame, panelOrigin)).toBeNull();
  });

  test('a detached frame accepts nothing, including messages whose source is also null', () => {
    expect(acceptEmbedMessage({ source: null, origin: panelOrigin, data: ready }, null, panelOrigin)).toBeNull();
    expect(acceptEmbedMessage({ source: undefined, origin: panelOrigin, data: ready }, undefined, panelOrigin)).toBeNull();
  });

  test('rejects payloads outside the contract', () => {
    for (const data of [null, 'ready', 42, [], {}, { type: 'ready' }, { source: 'project-shelf-host', type: 'settings', settings: {} },
      { source: 'project-shelf-embed', type: 'layout', layout: 'fullscreen' }, { source: 'project-shelf-embed', type: 'settings' }, { source: 'project-shelf-embed', type: 'eval' }]) {
      expect(acceptEmbedMessage({ source: frame, origin: panelOrigin, data }, frame, panelOrigin)).toBeNull();
    }
  });

  test('showing a hidden site removes only that origin', () => {
    const hidden = settings({ hiddenOrigins: ['http://beelinkk:3000', 'http://beelinkk:5173'], corner: 'top-left' });
    expect(withoutHiddenOrigin(hidden, 'http://beelinkk:3000')).toEqual({ ...hidden, hiddenOrigins: ['http://beelinkk:5173'] });
    expect(withoutHiddenOrigin(hidden, 'http://other.test')).toEqual(hidden);
  });
});

describe('bubble host grants', () => {
  test('builds exact-host patterns that cover every port, and rejects anything else', () => {
    expect(hostPattern('http', 'beelinkk')).toBe('http://beelinkk/*');
    expect(hostPattern('https', 'Beelinkk.Tail750ac6.ts.net')).toBe('https://beelinkk.tail750ac6.ts.net/*');
    expect(hostPattern('http', '100.119.176.63')).toBe('http://100.119.176.63/*');
    expect(hostPattern('http', '[::1]')).toBe('http://[::1]/*');
    for (const bad of ['', 'beelinkk:3000', '*.example.test', 'a/b', 'a?b=1', 'user@host', 'a b', '#x']) expect(hostPattern('http', bad)).toBeNull();
  });

  test('an http panel needs only http pages; an https panel also needs http for dev servers on the same host', () => {
    expect(bubblePatterns('beelinkk', 'http:')).toEqual(['http://beelinkk/*']);
    expect(bubblePatterns('beelinkk.tail750ac6.ts.net', 'https:')).toEqual(['http://beelinkk.tail750ac6.ts.net/*', 'https://beelinkk.tail750ac6.ts.net/*']);
    expect(bubblePatterns('*.bad', 'http:')).toEqual([]);
  });

  test('registers the script only for exact granted hosts, never all-sites, wildcard, or favicon grants', () => {
    expect(bubbleMatches([
      'http://beelinkk/*', 'https://beelinkk.tail750ac6.ts.net/*', 'http://*/*', 'https://*/*', '*://*/*', 'https://*.example.test/*',
      FAVICON_PROVIDER_ORIGIN, 'http://beelinkk/*', 'http://192.168.1.50/*', '<all_urls>', 'file:///*',
    ])).toEqual(['http://192.168.1.50/*', 'http://beelinkk/*', 'https://beelinkk.tail750ac6.ts.net/*']);
    expect(bubbleMatches([])).toEqual([]);
  });

  test('compares registrations without regard to order', () => {
    expect(sameMatches(['http://a/*', 'http://b/*'], ['http://b/*', 'http://a/*'])).toBe(true);
    expect(sameMatches(['http://a/*'], ['http://a/*', 'http://b/*'])).toBe(false);
    expect(sameMatches(['http://a/*', 'http://a/*'], ['http://a/*', 'http://b/*'])).toBe(false);
  });

  test('reads hostnames from the settings response and drops anything that is not a bare host', () => {
    expect(parseHostnames({ settings: { hostnames: ['beelinkk', 'BEELINKK', '192.168.1.50', 'host:3000', '*.x', 7, null, ' spaced '] } }))
      .toEqual(['beelinkk', '192.168.1.50', 'spaced']);
    for (const body of [null, 'x', {}, { settings: null }, { settings: { hostnames: 'beelinkk' } }, { hostnames: ['beelinkk'] }]) expect(parseHostnames(body)).toEqual([]);
  });
});

describe('bubble page eligibility', () => {
  const http = { origin: 'http://beelinkk:4958', protocol: 'http:' };
  const https = { origin: 'https://beelinkk.tail750ac6.ts.net', protocol: 'https:' };

  test('frames dev pages on other ports and ignores the panel itself', () => {
    expect(canHostBubble({ origin: 'http://beelinkk:5173', protocol: 'http:' }, http)).toBe(true);
    expect(canHostBubble(http, http)).toBe(false);
    expect(canHostBubble(https, https)).toBe(false);
    expect(canHostBubble({ origin: 'https://beelinkk.tail750ac6.ts.net:8443', protocol: 'https:' }, https)).toBe(true);
  });

  test('skips an https page when the panel is http, since the browser would block the frame', () => {
    expect(canHostBubble({ origin: 'https://beelinkk:5173', protocol: 'https:' }, http)).toBe(false);
    expect(canHostBubble({ origin: 'http://beelinkk.tail750ac6.ts.net:5173', protocol: 'http:' }, https)).toBe(true);
  });

  test('never runs on non-web pages', () => {
    for (const protocol of ['file:', 'chrome:', 'about:', 'chrome-extension:', 'data:']) expect(canHostBubble({ origin: 'null', protocol }, http)).toBe(false);
  });

  test('passes only the origin of a tab to the panel, never its path, query or fragment', () => {
    expect(pageOrigin('http://beelinkk:5173/admin/reset?token=secret#frag')).toBe('http://beelinkk:5173');
    expect(pageOrigin('https://user:pass@beelinkk.test/x')).toBe('https://beelinkk.test');
    for (const url of [undefined, '', 'not a url', 'chrome://extensions', 'chrome-extension://abc/popup.html', 'file:///etc/passwd', 'about:blank']) expect(pageOrigin(url)).toBe('');
  });
});
