import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineDoc, defineTool, defineExtension, section } from '@earendil-works/pi-durable';
import { JsonlStorage } from '@earendil-works/pi-durable/storage/jsonl';
import { IndexedDBFileSystem } from './idb-fs.js';
import { browserModels } from './proxy-model.js';

const userId = new URL(self.location.href).searchParams.get('user');
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(userId || '')) throw new Error('Invalid user namespace');
async function confirmedUser() {
  const response = await fetch('/api/me');
  const { user } = await response.json();
  if (user?.id !== userId) throw new Error('Session changed; sign in again');
  return user;
}
const ownerId = crypto.randomUUID();
const ports = new Set();
const state = { userId, ownerId, buildId: APP_BUILD_ID, view: null, notes: null, openedAt: Date.now(), recovered: null };
const Notes = defineDoc({ kind: 'tab.notes', version: 1, scope: 'conversation',
  history: 'rewindable', fork: 'asOf', initial: () => ({ text: '' }) });
const text = value => ({ content: [{ type: 'text', text: value }] });
let root;
let harness;
let fs;
let resolveInitialization;
let rejectInitialization;
const initialization = new Promise((resolve, reject) => {
  resolveInitialization = resolve;
  rejectInitialization = reject;
});
void initialization.catch(() => {});
let ownsLock = false;
const waiting = setTimeout(() => {
  if (!ownsLock) {
    state.waitingForOwner = true;
    broadcast({ type: 'waiting' });
  }
}, 500);

async function configure(change = {}) {
  const agent = await root.agent(context);
  if (agent.thinkingLevel === 'minimal') change.thinkingLevel = 'low';
  if (change.model?.provider === agent.model?.provider && change.model?.modelId === agent.model?.modelId) delete change.model;
  if (Object.keys(change).length) await root.configure(change, context);
}

function broadcast(frame) {
  for (const port of ports) port.postMessage(frame);
}

const evaluations = new Map();
function evaluate(code, files, signal) {
  return new Promise((resolve, reject) => {
    const port = ports.values().next().value;
    if (!port) return reject(new Error('No tab available for evaluation'));
    const id = crypto.randomUUID();
    const finish = (error, value) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      evaluations.delete(id);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error('Evaluation aborted'));
    const timeout = setTimeout(() => finish(new Error('Evaluation tab unavailable or timed out')), 6000);
    signal?.addEventListener('abort', abort, { once: true });
    evaluations.set(id, finish);
    port.postMessage({ type: 'evaluate', id, code, files });
  });
}

const ready = navigator.locks.request(`pi-in-a-tab-owner:${userId}`, async () => {
  ownsLock = true;
  clearTimeout(waiting);
  state.waitingForOwner = false;
  await confirmedUser();
  fs = await IndexedDBFileSystem.open(`pi-in-a-tab:${userId}`);
  await fs.createDir('/workspace', { recursive: true });
  if (!(await fs.exists('/workspace/example.json')).value) {
    await fs.writeFile('/workspace/example.json', '{"values":[3,5,8],"label":"browser-only"}');
  }
  const tools = [
    defineTool({ name: 'read_file', description: 'Read a browser virtual file, relative to /workspace.',
      replay: 'safe', parameters: Type.Object({ path: Type.String() }), execute: async args => {
        const path = fs.path('/workspace/' + args.path);
        if (!path.startsWith('/workspace/')) throw new Error('Outside workspace');
        const result = await fs.readTextFile(path);
        if (!result.ok) throw result.error;
        return text(result.value);
      } }),
    defineTool({ name: 'write_file', description: 'Write a browser virtual file. Mutating: never automatically replayed.',
      replay: 'unsafe', parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async args => {
        const path = fs.path('/workspace/' + args.path);
        if (!path.startsWith('/workspace/')) throw new Error('Outside workspace');
        const result = await fs.writeFile(path, args.content);
        if (!result.ok) throw result.error;
        return text('Saved ' + path);
      } }),
    defineTool({ name: 'js_eval', description: 'Run JavaScript in a fresh Web Worker. Supply a function body with return. fs.list() and fs.read(path) read a frozen virtual-file snapshot. Arbitrary JS is NOT replay-safe.',
      replay: 'unsafe', parameters: Type.Object({ code: Type.String() }), execute: async (args, api, ctx) => {
        const files = {};
        for (const file of (await fs.listDir('/workspace')).value) {
          if (file.kind === 'file') files[file.name] = (await fs.readTextFile(file.path)).value;
        }
        return text(await evaluate(args.code, files, ctx.abortSignal));
      } }),
    defineTool({ name: 'set_notes', description: 'Replace the durable notes document. Mutating: never automatically replayed.',
      replay: 'unsafe', parameters: Type.Object({ text: Type.String() }), execute: async (args, api, ctx) => {
        await api.commit(async tx => { (await tx.doc(Notes, api.conversationId)).text = args.text; }, ctx);
        return text('Notes saved');
      } })
  ];
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'browser-local', tools, sections: [section('preamble', () =>
    'You live entirely inside a browser SharedWorker. Conversation state, notes and virtual files are in browser IndexedDB. Be concise. Never repeat successful tools.', { tag: false })] }));
  const { models: catalog, defaultModel } = await (await fetch('/api/models')).json();
  if (!catalog.length) throw new Error('No model credentials; configure a key or run npm run login');
  const initial = catalog.find(model => model.provider + '/' + model.id === defaultModel) || catalog[0];
  const storage = await JsonlStorage.open('/session', fs, context, { fsync: true });
  harness = await Harness.open(storage, { models: browserModels(catalog, userId), registry,
    settings: { retry: { enabled: false }, stream: { timeoutMs: 120000 } },
    onReport: error => broadcast({ type: 'error', error: String(error) }) }, context);
  root = await harness.root(context, {
    agent: { model: { provider: initial.provider, modelId: initial.id }, thinkingLevel: 'low' },
    init: async (tx, id) => { await tx.doc(Notes, id); }
  });
  await configure();
  state.recovered = await harness.inspect(context);
  for (const [channel, watch] of [['view', await root.watch(context)], ['notes', await harness.watchDoc(Notes, root.id, context)]]) {
    state[channel] = watch.value;
    watch.start(async value => {
      state[channel] = value;
      broadcast({ type: 'state', state });
    });
  }
  resolveInitialization();
  broadcast({ type: 'state', state });
  harness.resume();
  return new Promise(() => {}); // Own the lock for this worker's lifetime.
});

self.onconnect = event => {
  const port = event.ports[0];
  ports.add(port);
  port.start();
  port.postMessage({ type: 'hello', buildId: APP_BUILD_ID });
  if (state.waitingForOwner) port.postMessage({ type: 'waiting' });
  port.onmessage = async event => {
    const { id, action, payload } = event.data;
    try {
      if (action === 'eval-result') {
        evaluations.get(id)?.(payload.error ? new Error(payload.error) : null, payload.result);
        return;
      }
      if (action === 'detach') { ports.delete(port); port.close(); return; }
      await initialization;
      await confirmedUser();
      if (action === 'erase') {
        await harness.close(context);
        await fs.cleanup();
        port.postMessage({ type: 'reply', id, result: { closed: true } });
        broadcast({ type: 'erased', userId });
        self.close();
        return;
      }
      let result;
      if (action === 'attach') result = state;
      else if (action === 'model') {
        await configure({ model: { provider: payload.provider, modelId: payload.modelId } });
        result = { saved: true };
      } else if (action === 'submit') {
        const submission = await root.submit({ type: 'input', content: payload.content,
          requestId: payload.requestId, whenBusy: 'followUp' }, context);
        result = { id: submission.id };
      } else if (action === 'notes') {
        await root.commit(async tx => { (await tx.doc(Notes, root.id)).text = payload.text; }, context);
        result = { saved: true };
      }
      else throw new Error('Unknown action: ' + action);
      port.postMessage({ type: 'reply', id, result });
    } catch (error) { port.postMessage({ type: 'reply', id, error: error.message }); }
  };
};
ready.catch(error => {
  rejectInitialization(error);
  broadcast({ type: 'error', error: error.message });
});