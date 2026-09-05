import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

export default async function teardown() {
  const runtime = (globalThis as any).__larkE2E;
  if (!runtime) return;
  const ports = [runtime.server?.port, runtime.mock?.port].filter(Boolean);
  try {
    await runtime.server?.stop();
  } finally {
    await runtime.mock?.stop();
    runtime.environment?.cleanup();
    fs.rmSync(path.join(runtime.root, 'e2e/.state/lark.json'), { force: true });
  }
  if (runtime.environment) assert.equal(fs.existsSync(runtime.environment.root), false, 'Temporary storage leaked');
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); reject(new Error(`Listener leaked on ${port}`)); });
      socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error); });
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error(`Port check timed out: ${port}`)); });
    });
  }
  delete (globalThis as any).__larkE2E;
}
