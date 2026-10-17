/** Remote logos are browser-loaded images, never fetched or proxied by the server. */
export function remoteLogoUrl(value: string): string {
  if (!/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}
