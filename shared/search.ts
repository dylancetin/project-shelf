// Fixed HTTPS destinations: settings choose a provider, never an arbitrary URL.
export const SEARCH_ENGINES = {
  duckduckgo: ['ddg', 'DuckDuckGo', 'duckduckgo.com', 'https://duckduckgo.com/?q={{{s}}}'],
  google: ['g', 'Google', 'www.google.com', 'https://www.google.com/search?q={{{s}}}'],
  bing: ['b', 'Bing', 'www.bing.com', 'https://www.bing.com/search?q={{{s}}}'],
  brave: ['brave', 'Brave Search', 'search.brave.com', 'https://search.brave.com/search?q={{{s}}}'],
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES;
export const DEFAULT_SEARCH_ENGINE: SearchEngine = 'duckduckgo';
export function isSearchEngine(value: unknown): value is SearchEngine {
  return typeof value === 'string' && Object.hasOwn(SEARCH_ENGINES, value);
}
