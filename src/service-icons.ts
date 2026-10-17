import type { Project } from '../shared/types';

// Downloaded, same-origin assets: rendering never contacts a favicon service or
// probes a destination. Keep provenance in public/service-icons/SOURCES.md.
const icons: { file: string; match: RegExp }[] = [
  { file: 't3-code-nightly.webp', match: /\bt3 (?:code )?nightly\b/ },
  { file: 't3-code.webp', match: /\bt3(?: code)?\b/ },
  { file: 'audiobookshelf.svg', match: /\baudiobookshelf\b/ },
  { file: 'bazarr.svg', match: /\bbazarr\b/ },
  { file: 'cliproxy-cpamc.jpg', match: /\b(?:cli ?proxy(?: ?api)?|cpamc)\b/ },
  { file: 'coolify.svg', match: /\bcoolify\b/ },
  { file: 'forgejo.svg', match: /\bforgejo\b/ },
  { file: 'gitea.svg', match: /\bgitea\b/ },
  { file: 'immich.svg', match: /\bimmich\b/ },
  { file: 'jellyfin.svg', match: /\bjellyfin\b/ },
  { file: 'kapowarr.svg', match: /\bkapowarr\b/ },
  { file: 'kavita.svg', match: /\bkavita\b/ },
  { file: 'lazylibrarian.png', match: /\blazy ?librarian\b/ },
  { file: 'nextcloud.svg', match: /\bnextcloud\b/ },
  { file: 'ntfy.svg', match: /\bntfy\b/ },
  { file: 'openclaw.svg', match: /\bopen ?claw\b/ },
  { file: 'opencode.svg', match: /\bopen ?code\b/ },
  { file: 'pi-hole.svg', match: /\bpi ?hole\b/ },
  { file: 'plex.svg', match: /\bplex\b/ },
  { file: 'prowlarr.svg', match: /\bprowlarr\b/ },
  { file: 'qbittorrent.svg', match: /\bqbittorrent\b/ },
  { file: 'radarr.svg', match: /\bradarr\b/ },
  { file: 'sonarr.svg', match: /\bsonarr\b/ },
  { file: 'syncthing.svg', match: /\bsyncthing\b/ },
];

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

export function serviceIcon(project: Pick<Project, 'kind' | 'name' | 'url'>): string {
  if (project.kind !== 'service') return '';
  let host = '';
  try { host = normalize(new URL(project.url).hostname.split('.')[0]!); }
  catch { /* An absent or invalid URL can still have a recognizable name. */ }
  const name = normalize(project.name);
  const named = icons.find(icon => icon.match.test(name));
  const hosted = icons.find(icon => icon.match.test(host));
  // Prefer an explicit title, except when a T3 Code URL identifies Nightly.
  const icon = named?.file === 't3-code.webp' && hosted?.file === 't3-code-nightly.webp'
    ? hosted : named || hosted;
  return icon ? `/service-icons/${icon.file}` : '';
}
