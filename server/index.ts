import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AppOptions } from './app';

export { createApp } from './app';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function startServer(overrides: Partial<AppOptions> & { port?: number; hostname?: string } = {}) {
  const port = overrides.port ?? Number(process.env.PORT || 4958);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const app = await createApp({
    dbPath: process.env.PANEL_DB_PATH || path.join(projectRoot, 'data/panel.sqlite'),
    staticDir: path.join(projectRoot, 'dist'),
    bookmarksPath: path.join(projectRoot, 'data/bookmarks.html'),
    ...overrides,
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port, hostname: overrides.hostname ?? process.env.HOST ?? '0.0.0.0',
      maxRequestBodySize: 6 * 1024 * 1024,
      idleTimeout: 60,
      fetch: app.fetch,
      error: () => Response.json({ error: 'Internal server error' }, { status: 500 }),
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  let stopping: Promise<void> | null = null;
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        await server.stop(false);
        await app.close();
      })();
    }
    return stopping;
  };
  return { server, app, stop };
}

if (import.meta.main) {
  const instance = await startServer();
  console.log(`Project Shelf listening on ${instance.server.url}`);
  let signalled = false;
  const shutdown = async () => {
    if (signalled) return;
    signalled = true;
    try { await instance.stop(); }
    catch (error) { console.error('Shutdown failed:', error); process.exitCode = 1; }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
