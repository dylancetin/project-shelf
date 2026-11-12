import { describe, expect, test } from 'bun:test';
import type { AgentServer } from '../shared/agent-servers';
import type { RuntimeTarget } from '../shared/runtime-targets';
import type { LogLine, Project } from '../shared/types';
import {
  agentEntries, alternateHostLinks, chooseScreen, entriesAfter, filterEntries, layoutFor, lastLogId, markEnd,
  projectEntries, targetKey, unseenStderr, uptimeLabel, type ScreenInput,
} from '../src/embed/model';
import { nextDelay } from '../src/embed/poll';

function project(id: string, status: Project['runtime']['status'], overrides: Partial<Project> = {}): RuntimeTarget {
  return {
    kind: 'project',
    project: {
      id, name: `Project ${id}`, description: '', kind: 'project', directory: '/tmp/opencode/x', source: 'test', url: 'http://beelinkk:5173/app?x=1#top',
      hostname: '', devCommand: 'dev', buildCommand: '', prodCommand: '', port: 5173, logo: '', favorite: false, hidden: false,
      createdAt: '', updatedAt: '', runtime: { status, mode: status === 'stopped' ? null : 'dev', pid: null, startedAt: null, exitCode: null }, ...overrides,
    },
  };
}
function agent(id: string, status: AgentServer['status']): RuntimeTarget {
  return { kind: 'agent', server: { id, name: `Preview ${id}`, status, ready: status === 'running', port: 5100, url: 'http://beelinkk:5100/' } as AgentServer };
}

const base: ScreenInput = { surface: 'popup', hiddenHere: false, pageTargets: null, catalog: null, selectedKey: null, pickedKey: null };

describe('which screen the embed shows', () => {
  test('waits for the first answer, and a hidden site stays hidden on the bubble only', () => {
    expect(chooseScreen(base).kind).toBe('loading');
    expect(chooseScreen({ ...base, surface: 'bubble', hiddenHere: true, pageTargets: [project('a', 'running')] }).kind).toBe('idle');
    expect(chooseScreen({ ...base, hiddenHere: true, pageTargets: [project('a', 'running')] }).kind).toBe('controls');
  });

  test('defaults to the first runtime for the page and keeps a pick that is still there', () => {
    const targets = [project('a', 'running'), project('b', 'stopped')];
    const first = chooseScreen({ ...base, pageTargets: targets });
    expect(first.kind === 'controls' && targetKey(first.selected)).toBe('project:a');
    const picked = chooseScreen({ ...base, pageTargets: targets, selectedKey: 'project:b' });
    expect(picked.kind === 'controls' && targetKey(picked.selected)).toBe('project:b');
    const gone = chooseScreen({ ...base, pageTargets: targets, selectedKey: 'project:zzz' });
    expect(gone.kind === 'controls' && targetKey(gone.selected)).toBe('project:a');
  });

  test('a page nothing serves is an idle bubble but a list in the popup: active projects and agent previews that are not stopped', () => {
    const catalog = [project('a', 'running'), project('b', 'stopped'), project('c', 'starting'), agent('p', 'running'), agent('q', 'stopped'), agent('r', 'failed')];
    expect(chooseScreen({ ...base, surface: 'bubble', pageTargets: [], catalog }).kind).toBe('idle');
    expect(chooseScreen({ ...base, pageTargets: [] }).kind).toBe('loading');
    const list = chooseScreen({ ...base, pageTargets: [], catalog });
    expect(list.kind === 'list' && list.runtimes.map(targetKey)).toEqual(['project:a', 'project:c', 'agent:p', 'agent:r']);
  });

  test('a runtime picked from the list stays open after it stops, until it is deleted', () => {
    const catalog = [project('a', 'stopped'), project('b', 'running')];
    const stopped = chooseScreen({ ...base, pageTargets: [], catalog, pickedKey: 'project:a' });
    expect(stopped.kind === 'controls' && stopped.origin).toBe('list');
    expect(chooseScreen({ ...base, pageTargets: [], catalog: [catalog[1] as RuntimeTarget], pickedKey: 'project:a' }).kind).toBe('list');
  });

  test('only the bubble surface collapses; hidden means nothing to draw', () => {
    const screen = chooseScreen({ ...base, pageTargets: [project('a', 'running')] });
    expect(layoutFor('popup', screen, { kind: 'bubble' })).toBe('panel');
    expect(layoutFor('bubble', screen, { kind: 'bubble' })).toBe('bubble');
    expect(layoutFor('bubble', screen, { kind: 'panel' })).toBe('panel');
    expect(layoutFor('bubble', { kind: 'idle' }, { kind: 'panel' })).toBe('hidden');
    expect(layoutFor('bubble', { kind: 'loading' }, { kind: 'bubble' })).toBe('hidden');
  });
});

describe('links to the same server under other hostnames', () => {
  const hostnames = ['beelinkk', '192.168.1.50', 'beelinkk.tail750ac6.ts.net'];

  test('keeps protocol, port, path, query and fragment, and leaves out the current host', () => {
    const links = alternateHostLinks('https://beelinkk:5173/app?x=1#top', 'beelinkk', hostnames);
    expect(links).toEqual([
      { host: '192.168.1.50', href: 'https://192.168.1.50:5173/app?x=1#top' },
      { host: 'beelinkk.tail750ac6.ts.net', href: 'https://beelinkk.tail750ac6.ts.net:5173/app?x=1#top' },
    ]);
    expect(alternateHostLinks('http://beelinkk:5173/', '192.168.1.50', hostnames).map(link => link.host)).toEqual(['beelinkk.tail750ac6.ts.net']);
  });

  test('a reverse-proxy address has no equivalents on other hostnames', () => {
    expect(alternateHostLinks('https://app.tail750ac6.ts.net/', '', hostnames)).toEqual([]);
    expect(alternateHostLinks('not a url', '', hostnames)).toEqual([]);
  });

  test('ignores blank and repeated hostnames', () => {
    expect(alternateHostLinks('http://beelinkk:3000/', 'beelinkk', ['', 'beelinkk', 'devbox', 'DEVBOX']).map(link => link.host)).toEqual(['devbox']);
  });
});

describe('log lines', () => {
  const lines: LogLine[] = [
    { id: 4, timestamp: '2026-01-01T10:00:00.000Z', stream: 'stdout', text: 'ready' },
    { id: 5, timestamp: '2026-01-01T10:00:01.000Z', stream: 'stderr', text: 'Warning: slow' },
    { id: 9, timestamp: '2026-01-01T10:00:02.000Z', stream: 'stderr', text: 'Error: boom' },
  ];

  test('counts error lines that arrived after the last line the user saw', () => {
    expect(lastLogId(lines)).toBe(9);
    expect(unseenStderr(lines, 0)).toBe(2);
    expect(unseenStderr(lines, 5)).toBe(1);
    expect(unseenStderr(lines, 9)).toBe(0);
    expect(lastLogId([])).toBe(0);
  });

  test('clearing a project view hides what was received and shows what comes next', () => {
    const mark = markEnd(projectEntries(lines));
    const later = [...lines, { id: 12, timestamp: '2026-01-01T10:00:03.000Z', stream: 'stdout' as const, text: 'next' }];
    expect(entriesAfter(projectEntries(later), mark).map(entry => entry.text)).toEqual(['next']);
    expect(entriesAfter(projectEntries(later), null)).toHaveLength(4);
    expect(markEnd([])).toBeNull();
  });

  test('filters by stream and by text, ignoring case', () => {
    const entries = projectEntries(lines);
    expect(filterEntries(entries, '', 'stderr').map(entry => entry.id)).toEqual([5, 9]);
    expect(filterEntries(entries, 'ERROR', 'all').map(entry => entry.id)).toEqual([9]);
    expect(filterEntries(entries, 'ready', 'stderr')).toEqual([]);
  });

  const journal = [
    'Launch failed: unit refused to start',
    '2026-01-01T10:00:00.000Z [stdout] listening',
    '2026-01-01T10:00:01.000Z [stderr] \u001b[31mTypeError\u001b[0m: x is undefined',
    '    at render (app.js:1)',
    '2026-01-01T10:00:02.000Z [stdout] done',
  ].join('\n');

  test('reads the journal text agent previews return, keeping stream, launch errors and continuation lines', () => {
    const entries = agentEntries(journal);
    expect(entries.map(entry => entry.stream)).toEqual(['system', 'stdout', 'stderr', 'stderr', 'stdout']);
    expect(entries[2]?.text).toBe('TypeError: x is undefined');
    expect(entries[3]?.text).toBe('    at render (app.js:1)');
    expect(entries[0]?.text).toBe('Launch failed: unit refused to start');
  });

  test('a cleared journal view resumes after the marked lines even as the window slides, and shows everything once they are gone', () => {
    const entries = agentEntries(journal);
    const mark = markEnd(entries);
    const slid = agentEntries(`${journal.split('\n').slice(2).join('\n')}\n2026-01-01T10:00:03.000Z [stdout] more`);
    expect(entriesAfter(slid, mark).map(entry => entry.text)).toEqual(['more']);
    const gone = agentEntries('2026-01-01T10:05:00.000Z [stdout] fresh\n2026-01-01T10:05:01.000Z [stdout] fresher');
    expect(entriesAfter(gone, mark)).toHaveLength(2);
  });
});

describe('uptime', () => {
  const start = '2026-01-01T10:00:00.000Z';
  const at = (seconds: number) => Date.parse(start) + seconds * 1000;
  test('is coarse and never negative', () => {
    expect(uptimeLabel(start, at(-5))).toBe('0s');
    expect(uptimeLabel(start, at(42))).toBe('42s');
    expect(uptimeLabel(start, at(61))).toBe('1m 01s');
    expect(uptimeLabel(start, at(2 * 3600 + 5 * 60))).toBe('2h 05m');
    expect(uptimeLabel(start, at(26 * 3600))).toBe('1d 2h');
    expect(uptimeLabel('garbage', at(1))).toBe('');
  });
});

describe('polling cadence', () => {
  const unmatched = { idle: (targets: unknown[]) => targets.length === 0, ms: 60_000 };

  test('keeps the interval while something matches, and backs off while nothing does', () => {
    expect(nextDelay(6000, null, unmatched)).toBe(6000);
    expect(nextDelay(6000, [{}], unmatched)).toBe(6000);
    expect(nextDelay(6000, [], unmatched)).toBe(60_000);
    expect(nextDelay(6000, [], undefined)).toBe(6000);
    // Never faster than the interval it was given.
    expect(nextDelay(120_000, [], unmatched)).toBe(120_000);
  });
});
