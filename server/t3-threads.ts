import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentServerThread } from '../shared/agent-servers';

export const DEFAULT_T3_HOME = '/home/taytay/.t3-nightly';
export const T3_THREAD_ID = /^[\w.:%-]{1,500}$/;
// Bounds the parent walk if T3 Code's lineage ever contains a cycle.
const MAX_SUBAGENT_DEPTH = 32;

export type T3Thread = AgentServerThread & { status: Exclude<AgentServerThread['status'], 'unavailable'> };

export interface T3Threads {
  /**
   * Resolve each known thread to the top-level thread it works for. Unknown
   * thread IDs are absent from the result. Throws if T3 Code's state cannot be read.
   */
  lookup(threadIds: readonly string[]): Map<string, T3Thread>;
}

interface ThreadRow { title: string; deleted: number; archived: number; settled: number; parent: string | null }

/**
 * Reads T3 Code's own thread projection, strictly read-only. Settled, archived
 * and deleted follow T3 Code's rule for abandoned subagent work. Only subagent
 * links are climbed: a fork is its own thread even though T3 Code records the
 * original as its lineage root.
 */
export class T3StateThreads implements T3Threads {
  constructor(readonly home = process.env.PANEL_T3_HOME || DEFAULT_T3_HOME) {}

  private environmentId() {
    try {
      const id = readFileSync(path.join(this.home, 'userdata', 'environment-id'), 'utf8').trim();
      return /^[\w-]{1,200}$/.test(id) ? id : null;
    } catch { return null; }
  }

  lookup(threadIds: readonly string[]) {
    const result = new Map<string, T3Thread>();
    const ids = [...new Set(threadIds)];
    if (!ids.length) return result;
    const db = new Database(path.join(this.home, 'userdata', 'statev2.sqlite'), { readonly: true });
    try {
      db.exec('PRAGMA busy_timeout = 2000');
      const query = db.query<ThreadRow, [string]>(`SELECT title,
          deleted_at IS NOT NULL OR json_extract(payload_json, '$.deletedAt') IS NOT NULL AS deleted,
          archived_at IS NOT NULL OR json_extract(payload_json, '$.archivedAt') IS NOT NULL AS archived,
          json_extract(payload_json, '$.settledOverride') IS 'settled' AS settled,
          CASE WHEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
            THEN json_extract(payload_json, '$.lineage.parentThreadId') END AS parent
        FROM orchestration_v2_projection_threads WHERE thread_id = ?`);
      const environmentId = this.environmentId();
      for (const id of ids) {
        let row = query.get(id);
        if (!row) continue;
        let rootId = id;
        for (let depth = 0; row?.parent && depth < MAX_SUBAGENT_DEPTH; depth++) { rootId = row.parent; row = query.get(rootId); }
        if (!row || row.parent) { result.set(id, { id, rootId, title: null, status: 'missing', link: null }); continue; }
        result.set(id, {
          id, rootId, title: row.title,
          status: row.deleted ? 'deleted' : row.archived ? 'archived' : row.settled ? 'settled' : 'active',
          link: environmentId ? `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(rootId)}` : null,
        });
      }
      return result;
    } finally { db.close(); }
  }
}
