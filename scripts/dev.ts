const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map((child) => child.exited));
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
children.push(Bun.spawn(['bun', '--watch', 'server/index.ts'], {
  env: { ...process.env, PORT: process.env.API_PORT || '4959', HOST: '127.0.0.1' },
  stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
}));
children.push(Bun.spawn(['bun', 'x', 'vite'], {
  env: process.env, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
}));
for (const child of children) child.exited.then((code) => void stop(code));
