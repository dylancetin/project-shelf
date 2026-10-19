import type { Project, ProjectKind, RunMode, Settings, ScanResult, LogoFile, LogLine } from '../shared/types';
import { shelfPlatform } from './platform';
import type { AgentServer } from '../shared/agent-servers';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const options: RequestInit = {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(!init.method || init.method === 'GET' ? 8000 : 60000)]),
    headers: { 'Content-Type': 'application/json', ...init.headers },
  };
  const transport = shelfPlatform().request;
  const response = await (transport ? transport(path, options) : fetch(`/api${path}`, options));
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  if (data === null) throw new Error('The server returned an unexpected response. Please try again.');
  return data as T;
}

const body = (data: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(data) });
const idPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

export const api = {
  agentServers: (signal?: AbortSignal) => request<{ servers: AgentServer[] }>('/agent-servers', { signal }),
  stopAgentServer: (id: string) => request<{ ok: boolean }>(`/agent-servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  agentLogs: (id: string, signal?: AbortSignal) => request<{ logs: string }>(`/agent-servers/${encodeURIComponent(id)}/logs`, { signal }),
  projects: (signal?: AbortSignal) => request<{ projects: Project[] }>('/projects', { signal }),
  reorder: (kind: ProjectKind, ids: string[], previousIds: string[]) => request<{ projects: Project[] }>('/projects/reorder', body({ kind, ids, previousIds })),
  settings: (signal?: AbortSignal) => request<{ settings: Settings }>('/settings', { signal }),
  saveSettings: (settings: Partial<Settings>) => request<{ settings: Settings }>('/settings', { ...body(settings), method: 'PATCH' }),
  create: (project: Partial<Project>) => request<{ project: Project }>('/projects', body(project)),
  update: (id: string, project: Partial<Project>) => request<{ project: Project }>(idPath(id), { ...body(project), method: 'PATCH' }),
  remove: (id: string) => request<{ ok: boolean }>(idPath(id), { method: 'DELETE' }),
  start: (id: string, mode: RunMode) => request<{ project: Project }>(`${idPath(id)}/start`, body({ mode })),
  launch: (id: string, signal?: AbortSignal) => request<{ project: Project }>(`${idPath(id)}/launch`, { ...body({}), signal }),
  stop: (id: string) => request<{ project: Project }>(`${idPath(id)}/stop`, body({})),
  duplicate: (id: string, data: { name: string; directory?: string; copyFiles: boolean }) => request<{ project: Project }>(`${idPath(id)}/duplicate`, body(data)),
  logos: (id: string) => request<{ logos: LogoFile[] }>(`${idPath(id)}/logos`),
  logs: (id: string) => request<{ logs: LogLine[] }>(`${idPath(id)}/logs`),
  scan: () => request<ScanResult>('/scan', body({})),
  importBookmarks: (html: string, localOnly: boolean) => request<{ added: number; skipped: number }>('/bookmarks/import', body({ html, localOnly })),
};

export function projectUrl(project: Project): string {
  const original = project.url || (project.port ? `http://localhost:${project.port}` : '');
  if (!original) return '';
  try {
    const url = new URL(original);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (project.hostname) url.hostname = project.hostname;
    return url.toString();
  } catch { return ''; }
}

export function urlLabel(project: Project): string {
  const value = projectUrl(project);
  if (!value) return 'No address configured';
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch { return value; }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function isActive(project: Project) {
  return ['running', 'starting', 'stopping'].includes(project.runtime.status);
}

export function sourceLabel(source: string) {
  if (!source) return 'Manually added';
  if (source === 'manual') return 'Manually added';
  if (/bookmark/i.test(source)) return 'Services';
  if (/nightly/i.test(source)) return 'T3 Nightly';
  if (/\.t3\/|^t3$/i.test(source)) return 'T3 projects';
  if (/workspace/i.test(source)) return 'Workspace';
  if (source === 'scan') return 'Discovered';
  return source.split('/').filter(Boolean).pop() || source;
}
