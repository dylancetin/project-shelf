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
  launchError?: string;
}

export interface AgentServer extends AgentServerRecord {
  machine: string;
  pid: number | null;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'unknown';
  ready: boolean;
  url: string;
  logsUrl: string;
  diagnostic: string;
}

export interface AddAgentServer {
  name: string;
  cwd: string;
  command: string;
  idempotencyKey?: string;
}
