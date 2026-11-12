// Managed commands and tunnels each run as the leader of their own process group.
export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function signalGroup(pid: number | null, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      // Fall back to the direct child if a platform cannot signal process groups.
      try { process.kill(pid, signal); } catch { /* Already exited. */ }
    }
  }
}
