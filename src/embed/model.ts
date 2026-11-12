import type { EmbedLayout, EmbedSurface } from '../../shared/embed';
import { serverAliases } from '../../shared/hostnames';
import type { RuntimeTarget } from '../../shared/runtime-targets';
import { tunnelPort, type TunnelState } from '../../shared/tunnels';
import type { LogLine, Project, RunMode } from '../../shared/types';

export type TargetKey = string;
export type Phase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'unknown';

export const targetKey = (target: RuntimeTarget): TargetKey => target.kind === 'project' ? `project:${target.project.id}` : `agent:${target.server.id}`;

/** What the frame shows. Derived from the polled data and the user's picks, never stored. */
export type EmbedScreen =
  | { kind: 'loading' }
  /** Bubble surface with nothing to show: no runtime serves the page, or the site is hidden. */
  | { kind: 'idle' }
  /** Popup surface whose page matches nothing: every active runtime, to pick from. */
  | { kind: 'list'; runtimes: RuntimeTarget[] }
  | { kind: 'controls'; targets: RuntimeTarget[]; selected: RuntimeTarget; origin: 'page' | 'list' };

/** Collapsed or expanded; only the bubble surface ever collapses. */
export type PanelView = { kind: 'bubble' } | { kind: 'panel' };

export interface ScreenInput {
  surface: EmbedSurface;
  hiddenHere: boolean;
  /** Runtimes serving the page, in the server's order; null until the first answer. */
  pageTargets: RuntimeTarget[] | null;
  /** Every project and agent preview the popup can list; null until the first answer. */
  catalog: RuntimeTarget[] | null;
  /** The user's pick among several runtimes serving the page. */
  selectedKey: TargetKey | null;
  /** The user's pick from the popup list. */
  pickedKey: TargetKey | null;
}

export function chooseScreen(input: ScreenInput): EmbedScreen {
  const { surface, pageTargets, catalog } = input;
  if (surface === 'bubble' && input.hiddenHere) return { kind: 'idle' };
  if (pageTargets === null) return { kind: 'loading' };
  const first = pageTargets[0];
  if (first) return { kind: 'controls', targets: pageTargets, selected: pageTargets.find(target => targetKey(target) === input.selectedKey) ?? first, origin: 'page' };
  if (surface === 'bubble') return { kind: 'idle' };
  if (catalog === null) return { kind: 'loading' };
  const picked = catalog.find(target => targetKey(target) === input.pickedKey);
  if (picked) return { kind: 'controls', targets: [picked], selected: picked, origin: 'list' };
  return { kind: 'list', runtimes: catalog.filter(isListed) };
}

export function layoutFor(surface: EmbedSurface, screen: EmbedScreen, view: PanelView): EmbedLayout {
  if (surface === 'popup') return 'panel';
  return screen.kind === 'controls' ? (view.kind === 'panel' ? 'panel' : 'bubble') : 'hidden';
}

const isActivePhase = (phase: Phase) => phase === 'running' || phase === 'starting' || phase === 'stopping';
/** What the popup lists when nothing serves the tab: running projects, and agent previews that are up or in trouble. */
export const isListed = (target: RuntimeTarget) => target.kind === 'agent' ? target.server.status !== 'stopped' : isActivePhase(target.project.runtime.status);

export interface TargetView {
  key: TargetKey;
  kind: RuntimeTarget['kind'];
  id: string;
  name: string;
  phase: Phase;
  statusLabel: string;
  mode: RunMode | null;
  port: number | null;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  tunnel: TunnelState | null;
  /** The base for links to this runtime under other server hostnames. */
  address: string;
  avatar: Pick<Project, 'id' | 'name' | 'logo' | 'kind' | 'url'>;
}

export const MODE_LABEL: Record<RunMode, string> = { dev: 'Development', prod: 'Production', build: 'Build' };

const PHASE_LABEL: Record<Phase, string> = { stopped: 'Stopped', starting: 'Starting', running: 'Running', stopping: 'Stopping', failed: 'Failed', unknown: 'Status unknown' };

export function describeTarget(target: RuntimeTarget): TargetView {
  if (target.kind === 'project') {
    const { project } = target;
    const { runtime } = project;
    return {
      key: targetKey(target), kind: 'project', id: project.id, name: project.name, phase: runtime.status,
      statusLabel: runtime.status === 'running' && runtime.mode === 'build' ? 'Building' : PHASE_LABEL[runtime.status],
      mode: runtime.mode, port: tunnelPort(project), pid: runtime.pid, startedAt: runtime.startedAt, exitCode: runtime.exitCode,
      tunnel: runtime.tunnel ?? null, address: projectAddress(project), avatar: project,
    };
  }
  const { server } = target;
  // A unit can be running before anything listens on its port.
  const waiting = server.status === 'running' && !server.ready;
  const phase: Phase = waiting ? 'starting' : server.status;
  return {
    key: targetKey(target), kind: 'agent', id: server.id, name: server.name, phase,
    statusLabel: waiting ? 'Not ready' : PHASE_LABEL[server.status],
    mode: null, port: server.port, pid: server.pid, startedAt: null, exitCode: null, tunnel: server.tunnel, address: server.url,
    avatar: { id: server.id, name: server.name, logo: '', kind: 'project', url: server.url },
  };
}

/** The project's own address: the stored URL on its hostname override, else its port on localhost. */
export function projectAddress(project: Pick<Project, 'url' | 'port' | 'hostname'>): string {
  const original = project.url || (project.port ? `http://localhost:${project.port}` : '');
  try {
    const url = new URL(original);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (project.hostname) url.hostname = project.hostname;
    return url.toString();
  } catch { return ''; }
}

/**
 * The same address under each other server hostname, keeping protocol, port, path, query and fragment.
 * Addresses on a hostname the panel does not recognise (a reverse-proxy subdomain) have no equivalents.
 */
export function alternateHostLinks(address: string, currentHost: string, hostnames: readonly string[]): { host: string; href: string }[] {
  let base: URL;
  try { base = new URL(address); } catch { return []; }
  if (!serverAliases(hostnames).has(base.hostname)) return [];
  const skip = new Set([base.hostname, currentHost.toLowerCase()]);
  const links = new Map<string, string>();
  for (const host of hostnames) {
    const name = host.trim().toLowerCase();
    if (!name || skip.has(name) || links.has(name)) continue;
    const url = new URL(base);
    try { url.hostname = name; } catch { continue; }
    links.set(name, url.toString());
  }
  return [...links].map(([host, href]) => ({ host, href }));
}

export type Stream = LogLine['stream'];
export type StreamFilter = 'all' | 'stdout' | 'stderr';

export interface LogEntry {
  key: string;
  /** The server's line id; agent journal lines have none. */
  id: number | null;
  time: string;
  stream: Stream;
  text: string;
  /** The unmodified source line, used to find where a cleared view ended. */
  raw: string;
}

const clock = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour12: false });
};

export const projectEntries = (lines: readonly LogLine[]): LogEntry[] =>
  lines.map(line => ({ key: `p${line.id}`, id: line.id, time: clock(line.timestamp), stream: line.stream, text: line.text, raw: line.text }));

// Agent previews return one journal string, one `<ISO time> [stdout|stderr] message` line per record.
const JOURNAL_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[(stdout|stderr)\] ?(.*)$/;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function agentEntries(logs: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const raw of logs.split('\n')) {
    if (!raw) continue;
    const match = JOURNAL_LINE.exec(raw);
    const previous = entries.at(-1);
    // Text before the first journal record is a launch error from the panel; a line without a prefix after one continues it.
    const stream: Stream = match ? (match[2] === 'stderr' ? 'stderr' : 'stdout') : previous?.stream ?? 'system';
    entries.push({ key: `a${entries.length}`, id: null, time: match?.[1] ? clock(match[1]) : '', stream, text: (match ? match[3] ?? '' : raw).replace(ANSI, ''), raw });
  }
  return entries;
}

/** Where a cleared view ended: a line id for projects, the last few raw lines for journal text with no ids. */
export type ClearMark = { kind: 'id'; id: number } | { kind: 'tail'; raws: string[] };
const TAIL_LINES = 3;

export function markEnd(entries: readonly LogEntry[]): ClearMark | null {
  const last = entries.at(-1);
  if (!last) return null;
  return last.id !== null ? { kind: 'id', id: Math.max(...entries.map(entry => entry.id ?? 0)) } : { kind: 'tail', raws: entries.slice(-TAIL_LINES).map(entry => entry.raw) };
}

export function entriesAfter(entries: readonly LogEntry[], mark: ClearMark | null): LogEntry[] {
  if (!mark) return [...entries];
  if (mark.kind === 'id') return entries.filter(entry => entry.id === null || entry.id > mark.id);
  const { raws } = mark;
  for (let end = entries.length - 1; end >= raws.length - 1; end--) {
    if (raws.every((raw, offset) => entries[end - raws.length + 1 + offset]?.raw === raw)) return entries.slice(end + 1);
  }
  // The marked lines have left the journal window, so everything left is newer.
  return [...entries];
}

export function filterEntries(entries: readonly LogEntry[], query: string, stream: StreamFilter): LogEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter(entry => (stream === 'all' || entry.stream === stream) && (!needle || entry.text.toLowerCase().includes(needle)));
}

export const lastLogId = (lines: readonly LogLine[]): number => lines.reduce((max, line) => Math.max(max, line.id), 0);

/** Error-stream lines that arrived after `seenId`. */
export const unseenStderr = (lines: readonly LogLine[], seenId: number): number =>
  lines.reduce((count, line) => count + (line.stream === 'stderr' && line.id > seenId ? 1 : 0), 0);

export const countLabel = (count: number): string => count > 99 ? '99+' : String(count);

/** "3m", "2h 05m", "1d 4h": coarse, because it is glanced at. */
export function uptimeLabel(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return '';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
