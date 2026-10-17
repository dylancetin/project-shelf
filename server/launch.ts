import type { Project } from '../shared/types';
import { ApiError } from './errors';
import type { ProcessManager } from './processes';

export interface LaunchOptions {
  timeoutMs?: number;
}

// Probe the local development listener, not a preferred LAN/Tailscale hostname
// or an unrelated reverse proxy. Never follow redirects to other services.
function readinessUrl(project: Project): URL {
  const url = new URL(project.url || `http://localhost:${project.port}`);
  const originalPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (project.port && project.port !== originalPort) url.protocol = 'http:';
  url.hostname = '127.0.0.1';
  url.port = String(project.port ?? originalPort);
  url.hash = '';
  return url;
}

export async function waitForDevelopment(project: Project, processes: ProcessManager, signal: AbortSignal,
  closing: () => boolean, options: LaunchOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  const url = readinessUrl(project);

  function checkRuntime() {
    if (closing()) throw new ApiError(503, 'The server is shutting down');
    if (signal.aborted) throw new ApiError(408, 'Opening the project was cancelled');
    const runtime = processes.runtime(project.id);
    if (runtime.startedAt !== project.runtime.startedAt || runtime.mode !== 'dev' || !['starting', 'running'].includes(runtime.status)) {
      throw new ApiError(409, `Development for ${project.name} stopped before it was ready. Check Live logs in project details, then try again.`);
    }
    return runtime;
  }

  while (Date.now() < deadline) {
    if (checkRuntime().status === 'running') {
      let ready = false;
      try {
        const response = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now())))]),
        });
        ready = response.status < 500;
        await response.body?.cancel();
      } catch { /* The process may still be binding or compiling its first page. */ }
      checkRuntime();
      if (ready) return;
    }
    await Bun.sleep(Math.min(200, Math.max(0, deadline - Date.now())));
  }
  checkRuntime();
  throw new ApiError(504, `${project.name} did not respond within ${Math.ceil(timeoutMs / 1000)} seconds. Check its development command, port, and Live logs in project details. The process has not been stopped.`);
}
