// Contract between the panel's /embed.html page and whatever frames it (the extension's
// content script on a dev page, or the toolbar popup). Free of DOM, chrome and Bun imports.

export type BubbleCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type BubbleSize = 'small' | 'medium' | 'large';
export type EmbedTab = 'controls' | 'logs';

export interface BubbleSettings {
  corner: BubbleCorner;
  size: BubbleSize;
  /** Bubble opacity while idle, 0.3 to 1. */
  idleOpacity: number;
  /** Distance in px from the chosen corner's horizontal and vertical edges, 0 to 400. */
  offsetX: number;
  offsetY: number;
  showLogBadge: boolean;
  defaultTab: EmbedTab;
  /** Page origins where the bubble is suppressed. */
  hiddenOrigins: string[];
}

export const BUBBLE_SETTINGS_KEY = 'project-shelf.bubble';

export const DEFAULT_BUBBLE_SETTINGS: BubbleSettings = {
  corner: 'bottom-right', size: 'medium', idleOpacity: 0.85, offsetX: 16, offsetY: 16,
  showLogBadge: true, defaultTab: 'controls', hiddenOrigins: [],
};

const CORNERS: readonly BubbleCorner[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const SIZES: readonly BubbleSize[] = ['small', 'medium', 'large'];
const TABS: readonly EmbedTab[] = ['controls', 'logs'];
const LAYOUTS: readonly EmbedLayout[] = ['hidden', 'bubble', 'panel'];
const MAX_HIDDEN_ORIGINS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find(item => item === value) ?? fallback;

/** Finite numbers are clamped into range; anything that is not a finite number falls back. */
function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function httpOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

/** Tolerant: unknown fields and wrong types fall back to defaults, out-of-range numbers are clamped. Never throws. */
export function parseBubbleSettings(value: unknown): BubbleSettings {
  const input = isRecord(value) ? value : {};
  const defaults = DEFAULT_BUBBLE_SETTINGS;
  const hiddenOrigins = new Set<string>();
  if (Array.isArray(input.hiddenOrigins)) {
    for (const item of input.hiddenOrigins.slice(0, MAX_HIDDEN_ORIGINS * 5)) {
      const origin = httpOrigin(item);
      if (origin) hiddenOrigins.add(origin);
      if (hiddenOrigins.size >= MAX_HIDDEN_ORIGINS) break;
    }
  }
  return {
    corner: pick(input.corner, CORNERS, defaults.corner),
    size: pick(input.size, SIZES, defaults.size),
    idleOpacity: bounded(input.idleOpacity, 0.3, 1, defaults.idleOpacity),
    offsetX: Math.round(bounded(input.offsetX, 0, 400, defaults.offsetX)),
    offsetY: Math.round(bounded(input.offsetY, 0, 400, defaults.offsetY)),
    showLogBadge: typeof input.showLogBadge === 'boolean' ? input.showLogBadge : defaults.showLogBadge,
    defaultTab: pick(input.defaultTab, TABS, defaults.defaultTab),
    hiddenOrigins: [...hiddenOrigins],
  };
}

export type EmbedSurface = 'bubble' | 'popup';
/** What the framed page asks its host to render: nothing, the collapsed bubble, or the expanded panel. */
export type EmbedLayout = 'hidden' | 'bubble' | 'panel';

export type HostToEmbedMessage = { source: 'project-shelf-host'; type: 'settings'; settings: BubbleSettings };
export type EmbedToHostMessage =
  | { source: 'project-shelf-embed'; type: 'ready' }
  | { source: 'project-shelf-embed'; type: 'layout'; layout: EmbedLayout }
  | { source: 'project-shelf-embed'; type: 'settings'; settings: BubbleSettings };

// postMessage payloads are untrusted until parsed here. Hosts and the embed must also check
// event.origin and event.source; these functions only validate the payload shape.
export function parseHostToEmbedMessage(data: unknown): HostToEmbedMessage | null {
  if (!isRecord(data) || data.source !== 'project-shelf-host' || data.type !== 'settings' || !isRecord(data.settings)) return null;
  return { source: 'project-shelf-host', type: 'settings', settings: parseBubbleSettings(data.settings) };
}

export function parseEmbedToHostMessage(data: unknown): EmbedToHostMessage | null {
  if (!isRecord(data) || data.source !== 'project-shelf-embed') return null;
  if (data.type === 'ready') return { source: 'project-shelf-embed', type: 'ready' };
  if (data.type === 'layout') {
    const layout = LAYOUTS.find(item => item === data.layout);
    return layout ? { source: 'project-shelf-embed', type: 'layout', layout } : null;
  }
  if (data.type === 'settings' && isRecord(data.settings)) {
    return { source: 'project-shelf-embed', type: 'settings', settings: parseBubbleSettings(data.settings) };
  }
  return null;
}

/**
 * The panel only resolves runtimes by origin, and a page's path, query and fragment can hold
 * secrets: hosts should pass `location.origin`, not `location.href`.
 */
export function embedUrl(panelBase: string, surface: EmbedSurface, pageUrl: string): string {
  return `${panelBase.replace(/\/+$/, '')}/embed.html?${new URLSearchParams({ surface, url: pageUrl })}`;
}

/** Never throws. A missing or unknown surface is `popup`, the full-size UI; a missing or non-http(s) page is null. */
export function readEmbedParams(search: string): { surface: EmbedSurface; pageUrl: URL | null } {
  const params = new URLSearchParams(search);
  let pageUrl: URL | null = null;
  try {
    const parsed = new URL(params.get('url') ?? '');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') pageUrl = parsed;
  } catch { /* A missing or malformed page URL means there is nothing to resolve. */ }
  return { surface: params.get('surface') === 'bubble' ? 'bubble' : 'popup', pageUrl };
}

export const BUBBLE_PIXELS: Record<BubbleSize, number> = { small: 40, medium: 48, large: 58 };
export const PANEL_SIZE: { width: number; height: number } = { width: 384, height: 560 };
