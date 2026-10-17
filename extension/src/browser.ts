import { parseSettings, permissionOrigin, SETTINGS_KEY, type ExtensionSettings } from './core';
import type { BookmarkNode } from '../../shared/browser-bookmarks';

interface ChromeEvent { addListener(listener: () => void): void; removeListener(listener: () => void): void }
interface PermissionSet { origins?: string[]; permissions?: string[] }

// Only the small Chrome API surface used by this extension; no runtime dependencies.
export interface ChromeApi {
  storage: { local: {
    get(key: string): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
  } };
  permissions: {
    contains(permissions: PermissionSet): Promise<boolean>;
    request(permissions: PermissionSet): Promise<boolean>;
    getAll(): Promise<{ origins?: string[] }>;
    remove(permissions: { origins: string[] }): Promise<boolean>;
    onAdded: ChromeEvent;
    onRemoved: ChromeEvent;
  };
  bookmarks: {
    getTree(): Promise<BookmarkNode[]>;
    getChildren(id: string): Promise<BookmarkNode[]>;
    move(id: string, destination: { parentId: string; index: number }): Promise<BookmarkNode>;
    onCreated: ChromeEvent;
    onRemoved: ChromeEvent;
    onChanged: ChromeEvent;
    onMoved: ChromeEvent;
    onChildrenReordered: ChromeEvent;
    onImportEnded: ChromeEvent;
  };
  runtime: { id: string; getURL(path: string): string; openOptionsPage(): Promise<void> };
  scripting: {
    getRegisteredContentScripts(filter?: { ids: string[] }): Promise<ContentScript[]>;
    registerContentScripts(scripts: ContentScript[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
  };
}

export interface ContentScript {
  id: string;
  matches: string[];
  js: string[];
  allFrames: boolean;
  runAt: 'document_end';
  persistAcrossSessions: boolean;
}

export const chrome = (globalThis as unknown as { chrome: ChromeApi }).chrome;

export async function readSettings(): Promise<ExtensionSettings | null> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return parseSettings(stored[SETTINGS_KEY]);
}

export async function hasAccess(settings: ExtensionSettings): Promise<boolean> {
  return chrome.permissions.contains({ origins: [permissionOrigin(settings.url)] });
}

export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing extension element: ${id}`);
  return found as T;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
