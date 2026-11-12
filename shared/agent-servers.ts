export interface AgentServerRecord {
  id: string;
  machineId: string;
  name: string;
  cwd: string;
  command: string;
  port: number;
  unit: string;
  createdAt: string;
  requestKey: string;
  /** T3 Code thread that started the preview. Absent on records created before thread ownership. */
  threadId?: string;
  launchError?: string;
}

/** `missing`: the thread row is gone; `unavailable`: T3 Code's state could not be read. Neither removes the preview. */
export type AgentServerThreadStatus = 'active' | 'settled' | 'archived' | 'deleted' | 'missing' | 'unavailable';

export interface AgentServerThread {
  /** Thread that started the preview (its T3CODE_THREAD_ID). */
  id: string;
  /** Top-level thread whose state controls automatic removal: subagent threads resolve to their parent. */
  rootId: string | null;
  title: string | null;
  status: AgentServerThreadStatus;
  /** T3 Code desktop deep link to the top-level thread. */
  link: string | null;
}

export interface AgentServer extends AgentServerRecord {
  machine: string;
  pid: number | null;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'unknown';
  ready: boolean;
  url: string;
  logsUrl: string;
  diagnostic: string;
  thread: AgentServerThread | null;
}

export interface AddAgentServer {
  name: string;
  cwd: string;
  command: string;
  /** The caller's T3CODE_THREAD_ID. */
  threadId: string;
  idempotencyKey?: string;
}
