import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import teardown from './global-teardown';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const helpers = path.join(root, 'server/__tests__/e2e/lark/helpers');
require(`${helpers}/preload.js`);
const { createTempEnvironment } = require(`${helpers}/env.js`);
const { startServer } = require(`${helpers}/server.js`);
const { MockLark } = require(`${helpers}/mockLark.js`);

function newest(file: string): number {
  const stat = fs.statSync(file);
  return stat.isDirectory()
    ? Math.max(stat.mtimeMs, ...fs.readdirSync(file).map(name => newest(path.join(file, name))))
    : stat.mtimeMs;
}

export default async function setup() {
  const node22 = '/opt/homebrew/opt/node@22/bin';
  if (fs.existsSync(node22)) process.env.PATH = `${node22}:${process.env.PATH}`;
  const stamp = path.join(root, 'e2e/.cache/lark-frontend.stamp');
  const publicDir = path.join(root, 'server/public');
  const indices = ['index.html', '_index.html'].map(name => path.join(publicDir, name)).filter(file => fs.existsSync(file));
  const sourceTime = Math.max(...['src', 'package.json', 'vite.config.js', 'index.html', 'scripts/postbuild.js'].map(file => newest(path.join(root, 'frontend', file))));
  if (!indices.length || indices.some(file => fs.statSync(file).mtimeMs < sourceTime) || !fs.existsSync(stamp) || fs.statSync(stamp).mtimeMs < sourceTime) {
    execFileSync('yarn', ['build'], { cwd: path.join(root, 'frontend'), env: { ...process.env, VITE_API_BASE: '/api' }, stdio: 'pipe', timeout: 180_000 });
    fs.cpSync(path.join(root, 'frontend/dist'), publicDir, { recursive: true });
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());
  }
  const runtime: any = (globalThis as any).__larkE2E = { root };
  try {
    runtime.environment = createTempEnvironment();
    runtime.mock = await new MockLark().start();
    const controlKey = randomBytes(24).toString('hex');
    let denyConsent = false;
    const authorize = runtime.mock.authorize.bind(runtime.mock);
    runtime.mock.authorize = (url: URL, response: any) => {
      if (denyConsent) url.searchParams.set('deny', '1');
      return authorize(url, response);
    };
    const handle = runtime.mock.handle.bind(runtime.mock);
    runtime.mock.handle = async (request: any, response: any) => {
      if (request.url !== '/__control') return handle(request, response);
      if (request.headers.authorization !== `Bearer ${controlKey}`) { response.writeHead(403).end(); return; }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (body.reset) { runtime.mock.reset(); denyConsent = false; }
      if (typeof body.deny === 'boolean') denyConsent = body.deny;
      if (body.user) runtime.mock.setUser(body.user);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ issued: runtime.mock.issued }));
    };
    // startServer uses process.execPath; its existing preload covers Node >= 24.
    runtime.server = await startServer(runtime.environment, { LARK_BASE_URL: runtime.mock.baseUrl, LARK_ACCOUNTS_URL: runtime.mock.baseUrl });
    const admin = { username: 'browseradmin', password: 'Passw0rd!2345' };
    const { token } = await runtime.server.enableMultiUser(admin);
    for (const [username, role] of [['browsermanager', 'manager'], ['browseruser', 'default']]) {
      await runtime.server.createUser({ token, username, password: admin.password, role });
    }
    const stateDir = path.join(root, 'e2e/.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'lark.json'), JSON.stringify({ baseURL: runtime.server.origin, mockLarkUrl: runtime.mock.baseUrl, admin, token, controlKey, environment: { env: { E2E_DATABASE_URL: runtime.environment.env.E2E_DATABASE_URL } } }), { mode: 0o600 });
  } catch (error) {
    await teardown();
    throw error;
  }
}
