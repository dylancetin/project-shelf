/** Copies text from inside a click handler. Works on plain-HTTP origins (no Clipboard API) too. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Fall back to a selection copy, e.g. when the document lost focus. */ }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  Object.assign(field.style, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  const focused = document.activeElement as HTMLElement | null;
  document.body.append(field);
  field.select();
  try { return document.execCommand('copy'); }
  catch { return false; }
  finally { field.remove(); focused?.focus({ preventScroll: true }); }
}

/**
 * Starts a copy in the click handler for text that is only known later. A pending
 * ClipboardItem keeps the click's clipboard permission (Chromium, Safari), so the
 * copy still works after a slow request. Resolves false if copying was refused.
 */
export function copyWhenReady(text: Promise<string>): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      const item = new ClipboardItem({ 'text/plain': text.then(value => new Blob([value], { type: 'text/plain' })) });
      return navigator.clipboard.write([item]).then(() => true, () => text.then(copyText, () => false));
    } catch { /* Older engines reject promised clipboard data; copy after it resolves. */ }
  }
  return text.then(copyText, () => false);
}
