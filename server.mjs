import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { credentials, loadEnvironment } from './credentials.mjs';
import { localModel } from './local-model.js';

await loadEnvironment();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4474);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const modelRateLimit = Number(process.env.PI_TAB_RATE_LIMIT || 20);
if (!Number.isInteger(modelRateLimit) || modelRateLimit < 1) throw new Error('PI_TAB_RATE_LIMIT must be a positive integer');
const isLoopback = name => name === 'localhost' || name === '::1' || name === '[::1]' || /^127(?:\.(?:\d{1,3})){3}$/.test(name);
const loopback = isLoopback(host);
if (!loopback && !process.env.PI_TAB_USERS) throw new Error('Non-loopback HOST requires PI_TAB_USERS');
const { authenticate, revokeSession, sessionCookie, sessionUser, loginRequired } = await import('./auth.mjs');
const models = builtinModels({ credentials });
await models.refresh();
const defaultOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
const allowedOrigins = new Set([...defaultOrigins, ...(process.env.PI_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)]);
for (const origin of allowedOrigins) {
  if (new URL(origin).origin !== origin) throw new Error('PI_ALLOWED_ORIGINS must contain exact origins');
}
const allowedHosts = new Set([...allowedOrigins].map(origin => new URL(origin).host));
if (!process.env.PI_TAB_USERS && [...allowedOrigins].some(origin => !isLoopback(new URL(origin).hostname))) {
  throw new Error('Non-loopback PI_ALLOWED_ORIGINS requires PI_TAB_USERS');
}
// Without app accounts, only direct local browsers are trusted; reverse proxies add these headers.
const proxyHeaders = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'tailscale-user-login', 'cf-connecting-ip'];
await mkdir('dist', { recursive: true });
const bundles = await build({
  entryPoints: ['client.js', 'owner.js', 'eval-worker.js', 'stage.js', 'webgpu-worker.js'], outdir: 'dist', write: false,
  bundle: true, platform: 'browser', format: 'esm', minify: true
});
const index = await readFile('index.html');
const stage = await readFile('stage.html');
const hash = createHash('sha256').update(index).update(stage).update(await readFile('server.mjs'));
for (const file of bundles.outputFiles) hash.update(file.contents);
const buildId = hash.digest('hex');
const assets = new Map([['/', index], ['/stage.html', stage]]);
for (const file of bundles.outputFiles) {
  const bytes = Buffer.concat([Buffer.from('const APP_BUILD_ID = ' + JSON.stringify(buildId) + ';\n'), file.contents]);
  await writeFile(file.path, bytes);
  assets.set('/' + file.path.split('/').pop(), bytes);
}
const environmentSecrets = Object.entries(process.env)
  .filter(([name, value]) => /(?:key|token|secret|password)/i.test(name) && value)
  .map(([, value]) => value);
async function modelError(value, model) {
  let message = String(value);
  const auth = await models.getAuth(model);
  for (const secret of [...environmentSecrets, auth?.auth?.apiKey]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message.replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}
const limits = new Map();
function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error('Request too large');
  }
  return JSON.parse(raw || '{}');
}
function admit(key, limit = 20) {
  const now = Date.now();
  const recent = (limits.get(key) || []).filter(at => at > now - 60000);
  if (recent.length >= limit) return false;
  recent.push(now);
  limits.set(key, recent);
  return true;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const evaluator = url.pathname === '/eval-worker.js';
  const stagePage = url.pathname === '/stage.html';
  const pageEval = url.pathname === '/';
  res.setHeader('Content-Security-Policy', stagePage
    ? "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    : `default-src 'self'; script-src 'self'${evaluator || pageEval ? " 'unsafe-eval'" : ''}${url.pathname === '/webgpu-worker.js' ? " 'wasm-unsafe-eval'" : ''}; worker-src ${evaluator ? "'none'" : "'self'"}; style-src 'unsafe-inline'; connect-src ${evaluator ? "'none'" : "'self'"}${url.pathname === '/webgpu-worker.js' ? ' https://huggingface.co https://us.aws.cdn.hf.co https://raw.githubusercontent.com' : ''}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Host not allowed' });
    if (!loginRequired && proxyHeaders.some(name => req.headers[name] !== undefined)) {
      return json(res, 403, { error: 'Proxied access requires PI_TAB_USERS' });
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'POST' && !allowedOrigins.has(origin)) return json(res, 403, { error: 'Same-origin requests only' });
    const user = sessionUser(req);
    const publicApi = ['/api/login', '/api/logout', '/api/me'].includes(url.pathname);
    if (url.pathname.startsWith('/api/') && !publicApi && !user) return json(res, 401, { error: 'Sign in required' });
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!loginRequired) return json(res, 400, { error: 'App login is disabled on localhost' });
      if (!admit('login:' + req.socket.remoteAddress)) return json(res, 429, { error: 'Too many sign-in attempts; wait one minute' });
      const input = await body(req);
      const authenticated = await authenticate(input.user, input.password);
      if (!authenticated) return json(res, 401, { error: 'Invalid user or password' });
      res.setHeader('Set-Cookie', sessionCookie(authenticated, origin));
      return json(res, 200, { user: authenticated });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      if (loginRequired) {
        revokeSession(req);
        res.setHeader('Set-Cookie', sessionCookie(undefined, origin));
      }
      return json(res, 200, { user: null });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user: user || null, loginRequired, buildId });
    if ((req.method === 'GET' || req.method === 'HEAD') && assets.has(url.pathname)) {
      if (url.pathname === '/owner.js' && (!user || url.searchParams.get('user') !== user.id)) {
        return json(res, 401, { error: 'Sign in before opening a browser owner' });
      }
      res.setHeader('Content-Type', url.pathname === '/' || stagePage ? 'text/html' : 'text/javascript');
      return res.end(req.method === 'HEAD' ? undefined : assets.get(url.pathname));
    }
    if (req.method === 'GET' && url.pathname === '/api/models') {
      return json(res, 200, { models: [...await models.getAvailable(), localModel], defaultModel: process.env.PI_MODEL || null });
    }
    if (req.method !== 'POST' || url.pathname !== '/api/model') return json(res, 404, { error: 'Not found' });
    const input = await body(req);
    if (input.userId !== user.id) return json(res, 403, { error: 'Browser owner does not match signed-in user' });
    const available = await models.getAvailable(input.provider);
    const model = available.find(model => model.id === input.modelId && model.provider === input.provider);
    if (!model) return json(res, 400, { error: 'Selected model has no configured credentials' });
    if (loginRequired && !admit('model:' + user.id, modelRateLimit)) {
      res.setHeader('Retry-After', '60');
      return json(res, 429, { error: `${modelRateLimit} model requests per minute per user; wait one minute` });
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    res.setHeader('Content-Type', 'application/x-ndjson');
    const stream = models.streamSimple(model, input.context, { reasoning: input.reasoning || 'low', signal: abort.signal });
    for await (const event of stream) {
      if (res.destroyed) break;
      if (event.type === 'error' && event.error?.errorMessage) {
        event.error.errorMessage = await modelError(event.error.errorMessage, model);
      }
      if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal: abort.signal });
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) return json(res, 400, { error: error.message });
    res.end();
  }
});
server.listen(port, host, () => console.log(`Pi in a tab: http://${host.includes(':') ? '[' + host + ']' : host}:${port}`));
const stop = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
