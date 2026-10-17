import type { BrowserBookmarks } from '../shared/browser-bookmarks';

export interface ShelfPlatform {
  request?: (path: string, init: RequestInit) => Promise<Response>;
  apiAsset?: (path: string) => string;
  snapshotKey?: string;
  openExtensionSettings?: () => Promise<void>;
  bookmarks?: BrowserBookmarks;
}

let platform: ShelfPlatform = {};

// The normal website keeps its same-origin defaults. The extension supplies a
// narrowly scoped transport before mounting this exact same frontend.
export function configurePlatform(value: ShelfPlatform) { platform = value; }
export function shelfPlatform(): ShelfPlatform { return platform; }
export function apiAsset(path: string): string { return platform.apiAsset?.(path) ?? `/api${path}`; }
