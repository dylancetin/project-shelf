import type { Settings } from '../shared/types';
import { remoteLogoUrl } from '../shared/logos';
import { isSearchEngine } from '../shared/search';
import { ApiError } from './errors';
import { absolutePath, canonicalDirectory, safeRelative } from './paths';
import type { ProjectData } from './store';
import { serviceHostname } from './hostnames';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string, max: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!allowEmpty && !value.trim())) {
    throw new ApiError(400, `${field} must be ${allowEmpty ? '' : 'a nonempty '}string of at most ${max} characters`);
  }
  return value.trim();
}

export function hostname(value: unknown): string {
  const name = text(value, 'hostname', 253);
  if (!name) return '';
  try {
    if (/[\s/@?#\\%]/.test(name)) throw new Error();
    const parsed = new URL(`http://${name}`);
    if (parsed.port || parsed.pathname !== '/' || parsed.username || parsed.password || !parsed.hostname) throw new Error();
    if (!parsed.hostname.startsWith('[')) {
      const labels = parsed.hostname.replace(/\.$/, '').split('.');
      if (labels.some((label) => !/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label))) throw new Error();
    }
    return parsed.hostname;
  } catch {
    throw new ApiError(400, 'hostname must be a hostname or IP address, without a scheme or port');
  }
}

export function canonicalUrl(value: unknown, allowEmpty = true): string {
  const input = text(value, 'url', 4096, allowEmpty);
  if (!input) return '';
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new ApiError(400, 'url must be an http or https URL without embedded credentials');
  }
}

const PROJECT_FIELDS = new Set([
  'name', 'description', 'kind', 'directory', 'source', 'url', 'hostname', 'devCommand',
  'buildCommand', 'prodCommand', 'port', 'logo', 'favorite', 'hidden',
]);

export async function projectInput(value: unknown, settings: Settings, previous?: ProjectData): Promise<ProjectData> {
  const input = object(value);
  for (const key of Object.keys(input)) {
    if (!PROJECT_FIELDS.has(key)) throw new ApiError(400, `Unknown or read-only project field: ${key}`);
  }
  if (!previous && (input.name === undefined || input.kind === undefined)) throw new ApiError(400, 'name and kind are required');
  const now = new Date().toISOString();
  const result: ProjectData = previous ? { ...previous } : {
    id: crypto.randomUUID(), name: '', description: '', kind: 'project', directory: '', source: 'manual',
    url: '', hostname: settings.defaultHostname, devCommand: '', buildCommand: '', prodCommand: '',
    port: null, logo: '', favorite: false, hidden: false, createdAt: now, updatedAt: now,
  };
  if (input.kind !== undefined) {
    if (input.kind !== 'project' && input.kind !== 'service') throw new ApiError(400, 'kind must be project or service');
    result.kind = input.kind;
  }
  for (const field of ['name', 'description', 'source', 'devCommand', 'buildCommand', 'prodCommand'] as const) {
    if (input[field] !== undefined) result[field] = text(input[field], field, field === 'name' ? 200 : 8192, field !== 'name');
  }
  if (input.hostname !== undefined) result.hostname = hostname(input.hostname);
  if (input.url !== undefined) result.url = canonicalUrl(input.url);
  if (input.directory !== undefined) {
    result.directory = input.directory === '' ? '' : await canonicalDirectory(input.directory);
  }
  if (input.port !== undefined) {
    if (input.port !== null && (typeof input.port !== 'number' || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
      throw new ApiError(400, 'port must be null or an integer from 1 to 65535');
    }
    result.port = input.port as number | null;
  }
  if (input.logo !== undefined) {
    result.logo = text(input.logo, 'logo', 4096);
    const remote = remoteLogoUrl(result.logo);
    if (remote) result.logo = remote;
    else if (/^[a-z][a-z\d+.-]*:/i.test(result.logo)) {
      throw new ApiError(400, 'logo must be an http or https image URL without embedded credentials, or a relative project image path');
    } else if (result.logo) safeRelative(result.logo);
  }
  for (const field of ['favorite', 'hidden'] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'boolean') throw new ApiError(400, `${field} must be a boolean`);
      result[field] = input[field];
    }
  }
  if (result.kind === 'project' && !result.directory) throw new ApiError(400, 'A project requires an existing directory');
  if (result.kind === 'service' && !result.url) throw new ApiError(400, 'A service requires a URL');
  if (!previous && input.hostname === undefined) {
    const preferred = result.kind === 'project'
      ? { ...settings, defaultHostname: settings.defaultHostname || 'beelinkk' }
      : settings;
    result.hostname = result.url ? serviceHostname(result.url, preferred) : preferred.defaultHostname;
  }
  // Keep direct instance links aligned when changing the launch port. Explicitly
  // changed URLs and reverse-proxy URLs with a different port remain independent.
  if (previous && result.port && result.port !== previous.port && result.url === previous.url && result.url) {
    const address = new URL(result.url);
    if (Number(address.port) === previous.port) {
      address.port = String(result.port);
      result.url = address.href;
    }
  }
  if (!result.url && result.port) result.url = `http://localhost:${result.port}/`;
  result.updatedAt = now;
  return result;
}

export function settingsInput(value: unknown, previous: Settings): Settings {
  const input = object(value);
  const result: Settings = { ...previous };
  for (const key of Object.keys(input)) {
    if (!['roots', 'hostnames', 'defaultHostname', 'defaultSearchEngine'].includes(key)) throw new ApiError(400, `Unknown or read-only settings field: ${key}`);
  }
  if (input.roots !== undefined) {
    if (!Array.isArray(input.roots) || input.roots.length > 100) throw new ApiError(400, 'roots must be an array of at most 100 absolute paths');
    result.roots = [...new Set(input.roots.map((root) => absolutePath(root, 'root')))];
  }
  if (input.hostnames !== undefined) {
    if (!Array.isArray(input.hostnames) || input.hostnames.length > 100) throw new ApiError(400, 'hostnames must be an array of at most 100 hostnames');
    result.hostnames = [...new Set(input.hostnames.map(hostname).filter(Boolean))];
  }
  if (input.defaultHostname !== undefined) result.defaultHostname = hostname(input.defaultHostname);
  if (input.defaultSearchEngine !== undefined) {
    if (!isSearchEngine(input.defaultSearchEngine)) throw new ApiError(400, 'defaultSearchEngine must be duckduckgo, google, bing, or brave');
    result.defaultSearchEngine = input.defaultSearchEngine;
  }
  return result;
}
