import { BRIDGE_CHANNEL, trustedParent, validApiRequest } from './protocol';

const extensionId = (globalThis as unknown as { chrome: { runtime: { id: string } } }).chrome.runtime.id;
const parentOrigin = `chrome-extension://${extensionId}`;
const pending = new Map<string, AbortController>();
const marker = document.querySelector('meta[name="project-shelf-extension-bridge"]')?.getAttribute('content');

if (window.parent !== window && marker === '1') {
  window.addEventListener('message', event => {
    if (!trustedParent(event.origin, extensionId, event.source, window.parent)) return;
    const input = event.data;
    if (input?.channel === BRIDGE_CHANNEL && input.type === 'cancel' && typeof input.id === 'string') {
      pending.get(input.id)?.abort();
      return;
    }
    if (!validApiRequest(input) || pending.has(input.id) || pending.size >= 32) return;
    const controller = new AbortController();
    pending.set(input.id, controller);
    const timeout = setTimeout(() => controller.abort(), input.method === 'GET' ? 8000 : 60000);
    void (async () => {
      try {
        // The browser executes this isolated content script in the server-origin
        // document: requests keep the server's normal same-origin protections.
        const base = new URL('../../', window.location.href);
        const response = await fetch(new URL(`api${input.path}`, base), {
          method: input.method, ...(input.body === undefined ? {} : { body: input.body }),
          headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          credentials: 'same-origin', redirect: 'error', signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        window.parent.postMessage({ channel: BRIDGE_CHANNEL, type: 'reply', id: input.id, status: response.status, data }, parentOrigin);
      } catch {
        window.parent.postMessage({ channel: BRIDGE_CHANNEL, type: 'reply', id: input.id,
          error: controller.signal.aborted ? 'The server request was cancelled or timed out.' : 'Could not reach your Shelf server.' }, parentOrigin);
      } finally { clearTimeout(timeout); pending.delete(input.id); }
    })();
  });
  window.addEventListener('pagehide', () => { for (const controller of pending.values()) controller.abort(); pending.clear(); });
  window.parent.postMessage({ channel: BRIDGE_CHANNEL, type: 'ready' }, parentOrigin);
}
