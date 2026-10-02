const $ = id => document.getElementById(id);
const pending = new Map();
const evaluators = new Set();
const authChanges = new BroadcastChannel('pi-in-a-tab-auth');
let state;
let user;
let worker;
let loginRequired;
let catalog = [];

async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}

function detach() {
  if (worker) {
    worker.port.postMessage({ action: 'detach' });
    worker.port.close();
    worker = undefined;
  }
  for (const evaluator of evaluators) evaluator.terminate();
  evaluators.clear();
  for (const request of pending.values()) request.reject(new Error('Browser owner detached'));
  pending.clear();
  state = undefined;
}

function showLogin() {
  detach();
  user = undefined;
  $('app').hidden = true;
  $('login').hidden = false;
  $('setup').hidden = true;
  $('account').hidden = true;
  $('status').textContent = 'Sign in to your browser-local agent';
  $('transcript').replaceChildren();
  $('notes').value = '';
  $('error').textContent = '';
}

function call(action, payload = {}) {
  if (!worker) return Promise.reject(new Error('Sign in first'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    worker.port.postMessage({ id, action, payload });
  });
}

const content = blocks => (blocks || []).map(block => block.type === 'text' ? block.text
  : block.type === 'thinking' ? '[thinking] ' + block.thinking
  : block.type === 'toolCall' ? `→ ${block.name} ${JSON.stringify(block.arguments)}` : '').join('\n');

function render(value) {
  state = value;
  $('status').textContent = `${user.name} · attached to browser owner ${state.ownerId}`;
  $('ownership').textContent = JSON.stringify({ userId: state.userId, ownerId: state.ownerId,
    openedAt: state.openedAt, storage: 'IndexedDB / JSONL', serverStorage: 'none' }, null, 2);
  $('recovered').textContent = JSON.stringify(state.recovered, null, 2);
  $('transcript').replaceChildren();
  for (const entry of state.view?.entries || []) {
    if (entry.kind === 'pi.system') continue;
    const row = document.createElement('div');
    row.className = 'message';
    row.dataset.entryId = entry.id;
    const label = document.createElement('small');
    label.textContent = `${entry.kind} · #${entry.id}`;
    row.append(label, document.createTextNode((entry.model || []).map(message =>
      typeof message.content === 'string' ? message.content : content(message.content)).join('\n')));
    $('transcript').append(row);
  }
  const live = state.view?.docs['pi.live'] || {};
  $('live').textContent = content(live.generation?.message?.content) || (live.run ? 'Run active in browser' : 'Idle');
  $('tools').textContent = (live.tools || []).map(tool => `${tool.name} · ${tool.status}\n${tool.output || ''}`).join('\n');
  if (document.activeElement !== $('notes')) $('notes').value = state.notes?.text || '';
}

function evaluate(frame, owner) {
  const evaluator = new Worker('/eval-worker.js', { type: 'module' });
  evaluators.add(evaluator);
  const finish = payload => {
    clearTimeout(timeout);
    evaluator.terminate();
    evaluators.delete(evaluator);
    if (worker === owner) owner.port.postMessage({ action: 'eval-result', id: frame.id, payload });
  };
  const timeout = setTimeout(() => finish({ error: 'Evaluation timed out' }), 5000);
  evaluator.onmessage = event => finish(event.data);
  evaluator.onerror = event => finish({ error: event.message });
  evaluator.postMessage({ code: frame.code, files: frame.files });
}

async function attach(confirmedUser) {
  detach();
  user = confirmedUser;
  $('login').hidden = true;
  $('app').hidden = false;
  $('account').hidden = false;
  $('setup').hidden = true;
  $('logout').hidden = !loginRequired;
  $('user-name').textContent = user.name;
  $('erase').textContent = loginRequired ? `Log out and erase ${user.name}'s device data` : 'Erase this device’s data';
  const available = await api('models');
  catalog = available.models;
  $('model').replaceChildren();
  for (const model of catalog) {
    const option = document.createElement('option');
    option.value = model.provider + '/' + model.id;
    option.textContent = model.provider + ' · ' + model.name;
    $('model').append(option);
  }
  if (!catalog.length) {
    $('app').hidden = true;
    $('setup').hidden = false;
    $('status').textContent = 'Configure your model credentials, then restart the server and reload';
    return;
  }
  const preference = localStorage.getItem('pi-in-a-tab:model:' + user.id) || available.defaultModel;
  if (catalog.some(model => model.provider + '/' + model.id === preference)) $('model').value = preference;
  const owner = new SharedWorker('/owner.js?user=' + encodeURIComponent(user.id), {
    type: 'module', name: 'pi-in-a-tab:' + user.id
  });
  worker = owner;
  owner.port.start();
  owner.port.onmessage = event => {
    if (worker !== owner) return;
    const frame = event.data;
    if (frame.type === 'evaluate') return evaluate(frame, owner);
    if (frame.type === 'reply') {
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      if (!request) return;
      frame.error ? request.reject(new Error(frame.error)) : request.resolve(frame.result);
    } else if (frame.type === 'state') render(frame.state);
    else if (frame.type === 'erased') showLogin();
    else if (frame.type === 'error') showError(frame.error);
  };
  owner.onerror = event => showError(event.message);
  render(await call('attach'));
  await selectModel();
}

async function refreshIdentity() {
  const identity = await api('me');
  const confirmed = identity.user;
  loginRequired = identity.loginRequired;
  if (confirmed) await attach(confirmed);
  else showLogin();
}

function showError(error) {
  (user && !$('setup').hidden ? $('status') : user ? $('error') : $('login-error')).textContent = error;
}
async function guard(operation) {
  try { return await operation(); } catch (error) { showError(error.message); }
}

async function logout(erase) {
  const leavingUser = user;
  if (erase && worker) await call('erase');
  await api('logout', {});
  showLogin();
  authChanges.postMessage({ changed: true });
  if (erase) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('pi-in-a-tab:' + leavingUser.id);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other tabs using this account, then retry erasing'));
    });
    localStorage.removeItem('pi-in-a-tab:model:' + leavingUser.id);
    $('login-message').textContent = `Erased ${leavingUser.name}'s data from this device.`;
  }
  if (!loginRequired) await refreshIdentity();
}

async function selectModel() {
  const selected = catalog.find(model => model.provider + '/' + model.id === $('model').value);
  if (!selected || !worker) return;
  await call('model', { provider: selected.provider, modelId: selected.id });
  localStorage.setItem('pi-in-a-tab:model:' + user.id, $('model').value);
}
$('model').onchange = () => guard(selectModel);

$('login-form').onsubmit = event => {
  event.preventDefault();
  void guard(async () => {
    $('login-error').textContent = '';
    $('login-message').textContent = '';
    const password = $('password').value;
    $('password').value = '';
    const { user: confirmed } = await api('login', { user: $('username').value, password });
    authChanges.postMessage({ changed: true });
    await attach(confirmed);
  });
};
$('logout').onclick = () => guard(() => logout(false));
$('erase').onclick = () => guard(() => logout(true));
$('send').onclick = () => guard(async () => {
  const input = $('input').value.trim();
  if (!input) return;
  await call('submit', { content: input, requestId: crypto.randomUUID() });
  $('input').value = '';
});
$('save').onclick = () => guard(() => call('notes', { text: $('notes').value }));
authChanges.onmessage = () => { showLogin(); void guard(refreshIdentity); };
window.addEventListener('pagehide', detach);
void guard(refreshIdentity);