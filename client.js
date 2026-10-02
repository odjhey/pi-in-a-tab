const $ = id => document.getElementById(id);
const pending = new Map();
const evaluators = new Set();
const panes = new Map();
const authChanges = new BroadcastChannel('pi-in-a-tab-auth');
const updateMessage = 'This app was updated. Close other tabs for this site, then reload.';
let state;
let user;
let worker;
let loginRequired;
let catalog = [];
let defaultModel;
let ownerReady = false;
let updateRequired = false;
let enabled = false;
let openIds = [];
let activeId;
let forkTarget;
let forking = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, operation, className = 'secondary') {
  const node = element('button', className, text);
  node.type = 'button';
  node.onclick = operation;
  return node;
}

function controls(value) {
  enabled = value;
  $('erase').disabled = !value;
  for (const pane of panes.values()) updateControls(pane);
  for (const node of $('fork-form').elements) node.disabled = !value || forking;
}

function updateControls(pane) {
  const live = state?.conversations[pane.id]?.view?.docs?.['pi.live'] || {};
  const running = !!live.run;
  pane.input.disabled = !enabled;
  pane.send.disabled = !enabled || running || pane.submitting;
  pane.model.disabled = !enabled || running || pane.changingModel;
  pane.notes.disabled = !enabled;
  pane.save.disabled = !enabled || pane.savingNotes;
  for (const node of pane.transcript.querySelectorAll('button, select')) node.disabled = !enabled;
}

function updated() {
  updateRequired = true;
  detach();
  controls(false);
  $('status').textContent = updateMessage;
  showError(updateMessage);
}

const safeError = value => String(value)
  .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
  .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1[redacted]')
  .replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]');
const content = blocks => (blocks || []).map(block => block.type === 'text' ? block.text
  : block.type === 'thinking' ? '[thinking] ' + block.thinking
  : block.type === 'toolCall' ? `→ ${block.name} ${JSON.stringify(block.arguments)}` : '').join('\n');

function messageText(message) {
  const text = typeof message.content === 'string' ? message.content : content(message.content);
  return message.role === 'assistant' && message.stopReason === 'error'
    ? [text, 'Model error: ' + safeError(message.errorMessage || 'The provider returned an error.')].filter(Boolean).join('\n')
    : text;
}

async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}

function detach() {
  ownerReady = false;
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
  controls(false);
  user = undefined;
  $('app').hidden = true;
  $('login').hidden = false;
  $('setup').hidden = true;
  $('account').hidden = true;
  $('status').textContent = 'Sign in to your browser-local agent';
  $('panes').replaceChildren();
  $('branch-tree').replaceChildren();
  panes.clear();
  openIds = [];
  activeId = undefined;
  forkTarget = undefined;
  $('fork-dialog').close();
  $('error').textContent = '';
}

function call(action, payload = {}) {
  if (updateRequired) return Promise.reject(new Error(updateMessage));
  if (!worker) return Promise.reject(new Error('Sign in first'));
  if (!ownerReady && action !== 'attach') return Promise.reject(new Error('Waiting for browser owner'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    worker.port.postMessage({ id, action, payload });
  });
}

function paneKey() { return 'pi-in-a-tab:panes:' + user.id; }
function persistPanes() { localStorage.setItem(paneKey(), JSON.stringify(openIds)); }

function restorePanes() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(paneKey())); } catch { saved = []; }
  openIds = Array.isArray(saved) ? [...new Set(saved)].filter(id => state.conversations[id]).slice(0, 4) : [];
  if (!openIds.length) openIds = [state.rootId];
  activeId = openIds[0];
}

function openConversation(id) {
  if (!state?.conversations[id]) return;
  if (!openIds.includes(id)) {
    if (openIds.length < 4) openIds.push(id);
    else openIds[openIds.indexOf(activeId)] = id;
  }
  activeId = id;
  persistPanes();
  renderWorkspace();
}

function openBranches(ids) {
  // Replace the active slot, then the following slots: all returned branches stay visible.
  let slot = Math.max(0, openIds.indexOf(activeId));
  for (const id of ids) {
    if (openIds.includes(id)) continue;
    if (openIds.length < 4) openIds.push(id);
    else { openIds[slot] = id; slot = (slot + 1) % 4; }
  }
  activeId = ids[0] || activeId;
  persistPanes();
  renderWorkspace();
}

function closePane(id) {
  if (openIds.length === 1) return;
  openIds = openIds.filter(value => value !== id);
  if (activeId === id) activeId = openIds[0];
  persistPanes();
  renderWorkspace();
}

function activatePane(id) {
  if (activeId === id) return;
  activeId = id;
  for (const pane of panes.values()) pane.root.classList.toggle('active', pane.id === id);
  renderTree();
}

function modelOptions(select, selected) {
  select.replaceChildren();
  for (const model of catalog) {
    const option = element('option', '', model.provider + ' · ' + model.name);
    option.value = model.provider + '/' + model.id;
    select.append(option);
  }
  if (selected && !catalog.some(model => model.provider + '/' + model.id === selected)) {
    const unavailable = element('option', '', selected + ' (unavailable)');
    unavailable.value = selected;
    unavailable.disabled = true;
    select.append(unavailable);
  }
  select.value = selected || defaultModel;
}

const modelValue = model => model ? model.provider + '/' + model.modelId : undefined;
function selectedModel(select) {
  const model = catalog.find(item => item.provider + '/' + item.id === select.value);
  if (!model) throw new Error('Choose an available model');
  return { provider: model.provider, modelId: model.id };
}

async function paneOperation(pane, operation) {
  pane.error.textContent = '';
  try { await operation(); }
  catch (error) { pane.error.textContent = updateRequired ? updateMessage : safeError(error.message); }
}

function createPane(id) {
  const pane = { id, submitting: false, changingModel: false, savingNotes: false, notesDirty: false };
  pane.root = element('section', 'pane');
  pane.root.dataset.conversationId = id;
  pane.root.onpointerdown = () => activatePane(id);
  pane.root.onfocusin = () => activatePane(id);
  const header = element('div', 'pane-header');
  const heading = element('div', 'pane-heading');
  const identity = element('div');
  pane.kind = element('div', 'pane-kind');
  pane.title = element('h3');
  identity.append(pane.kind, pane.title);
  pane.close = button('×', () => closePane(id), 'secondary close');
  pane.close.setAttribute('aria-label', 'Close pane');
  heading.append(identity, pane.close);
  pane.model = element('select');
  pane.model.id = 'model-' + id;
  const modelLabel = element('label', '', 'Model');
  modelLabel.htmlFor = pane.model.id;
  pane.model.onchange = () => paneOperation(pane, async () => {
    pane.changingModel = true;
    updateControls(pane);
    try {
      await call('model', { conversationId: id, ...selectedModel(pane.model) });
    } finally {
      pane.changingModel = false;
      modelOptions(pane.model, modelValue(state?.conversations[id]?.agent?.model));
      updateControls(pane);
    }
  });
  pane.status = element('div', 'pane-status');
  pane.status.setAttribute('role', 'status');
  header.append(heading, modelLabel, pane.model, pane.status);
  pane.transcript = element('div', 'transcript');
  pane.transcript.setAttribute('aria-label', 'Conversation transcript');
  const composer = element('div', 'composer');
  pane.input = element('textarea');
  pane.input.rows = 3;
  pane.input.placeholder = 'Ask this branch to explore a direction…';
  pane.input.setAttribute('aria-label', 'Message to this branch');
  pane.send = button('Send →', () => paneOperation(pane, async () => {
    const input = pane.input.value.trim();
    if (!input || pane.submitting) return;
    pane.submitting = true;
    updateControls(pane);
    try {
      await call('submit', { conversationId: id, content: input, requestId: crypto.randomUUID() });
      if (pane.input.value.trim() === input) pane.input.value = '';
    } finally { pane.submitting = false; updateControls(pane); }
  }), '');
  pane.input.onkeydown = event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !pane.send.disabled) {
      event.preventDefault();
      pane.send.click();
    }
  };
  const footer = element('div', 'composer-footer');
  footer.append(element('small', '', '⌘ / Ctrl + Enter to send'), pane.send);
  pane.error = element('p', 'pane-error');
  pane.error.setAttribute('role', 'alert');
  composer.append(pane.input, footer, pane.error);
  const resources = element('div', 'resources');
  const notes = element('details');
  notes.append(element('summary', '', 'Durable notes'));
  pane.notes = element('textarea');
  pane.notes.rows = 4;
  pane.notes.setAttribute('aria-label', 'Durable notes for this branch');
  pane.notes.oninput = () => { pane.notesDirty = true; };
  pane.save = button('Save notes', () => paneOperation(pane, async () => {
    const text = pane.notes.value;
    pane.savingNotes = true;
    updateControls(pane);
    try {
      await call('notes', { conversationId: id, text });
      if (pane.notes.value === text) pane.notesDirty = false;
    } finally { pane.savingNotes = false; updateControls(pane); }
  }), 'secondary notes-save');
  notes.append(pane.notes, pane.save);
  const files = element('details');
  pane.fileSummary = element('summary', '', 'Branch files');
  pane.files = element('select');
  pane.files.setAttribute('aria-label', 'Choose a branch file');
  pane.fileContent = element('pre', 'file-content');
  pane.files.onchange = () => renderFile(pane);
  files.append(pane.fileSummary, pane.files, pane.fileContent,
    element('p', 'resource-hint', 'Read-only here. Ask the agent to create or edit a file.'));
  resources.append(notes, files);
  pane.root.append(header, pane.transcript, composer, resources);
  panes.set(id, pane);
  return pane;
}

function renderFile(pane) {
  const files = state.conversations[pane.id]?.files?.files || {};
  pane.fileContent.textContent = files[pane.files.value] ?? 'No files yet. Ask this branch to create one.';
}

function renderPane(pane, conversation) {
  pane.title.textContent = conversation.title || 'Untitled branch';
  pane.root.setAttribute('aria-label', conversation.title || 'Untitled branch');
  pane.kind.textContent = conversation.kind || 'branch';
  pane.close.disabled = openIds.length === 1;
  pane.root.classList.toggle('active', activeId === pane.id);
  if (!pane.changingModel) modelOptions(pane.model, modelValue(conversation.agent?.model));
  const live = conversation.view?.docs?.['pi.live'] || {};
  pane.status.textContent = live.run ? '● Working in this browser' : '○ Ready for your next direction';
  const atBottom = pane.transcript.scrollHeight - pane.transcript.scrollTop - pane.transcript.clientHeight < 60;
  pane.transcript.replaceChildren();
  const entries = (conversation.view?.entries || []).filter(entry => entry.kind !== 'pi.system');
  for (const entry of entries) {
    const row = element('div', 'message');
    row.dataset.entryId = entry.id;
    row.append(element('small', '', `${entry.kind} · #${entry.id}`),
      element('div', 'message-body', (entry.model || []).map(messageText).join('\n')));
    const actions = element('div', 'fork-actions');
    const count = element('select');
    count.setAttribute('aria-label', 'Number of parallel forks');
    for (const n of [2, 3, 4]) {
      const option = element('option', '', '×' + n);
      option.value = n;
      count.append(option);
    }
    actions.append(button('Fork here', () => showFork(pane.id, entry.id, 1)),
      button('Fork ×N', () => showFork(pane.id, entry.id, Number(count.value))), count);
    row.append(actions);
    pane.transcript.append(row);
  }
  if (!entries.length) pane.transcript.append(element('p', 'empty', 'A new direction starts here. Send a message to begin.'));
  const liveText = content(live.generation?.message?.content);
  if (liveText) pane.transcript.append(element('pre', 'live', liveText));
  const tools = (live.tools || []).map(tool => `${tool.name} · ${tool.status}\n${typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output ?? '')}`).join('\n');
  if (tools) pane.transcript.append(element('pre', 'tools', tools));
  if (atBottom) pane.transcript.scrollTop = pane.transcript.scrollHeight;
  if (!pane.notesDirty && document.activeElement !== pane.notes) pane.notes.value = conversation.notes?.text || '';
  const selectedFile = pane.files.value;
  const paths = Object.keys(conversation.files?.files || {}).sort();
  pane.files.replaceChildren();
  for (const path of paths) {
    const option = element('option', '', path);
    option.value = path;
    pane.files.append(option);
  }
  if (paths.includes(selectedFile)) pane.files.value = selectedFile;
  pane.files.hidden = !paths.length;
  pane.fileSummary.textContent = 'Branch files · ' + paths.length;
  renderFile(pane);
  updateControls(pane);
}

function renderTree() {
  const conversations = Object.values(state.conversations);
  const children = new Map();
  for (const conversation of conversations) {
    const parent = conversation.parentId && state.conversations[conversation.parentId] ? conversation.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(conversation);
  }
  function list(parent) {
    const ul = element('ul');
    for (const conversation of children.get(parent) || []) {
      const item = element('li');
      const node = button('', () => openConversation(conversation.id), 'branch');
      node.dataset.conversationId = conversation.id;
      node.classList.toggle('open', openIds.includes(conversation.id));
      node.classList.toggle('active', activeId === conversation.id);
      node.setAttribute('aria-pressed', String(openIds.includes(conversation.id)));
      const running = !!conversation.view?.docs?.['pi.live']?.run;
      const copy = element('span', 'branch-copy');
      copy.append(element('span', 'branch-title', conversation.title || 'Untitled branch'),
        element('span', 'branch-kind', (conversation.kind || 'branch') + (running ? ' · working' : '')));
      node.append(element('span', 'branch-dot' + (running ? ' running' : '')), copy);
      item.append(node);
      if (children.has(conversation.id)) item.append(list(conversation.id));
      ul.append(item);
    }
    return ul;
  }
  $('branch-tree').replaceChildren(list(null));
}

function renderWorkspace() {
  for (const [id, pane] of panes) {
    if (!openIds.includes(id)) { pane.root.remove(); panes.delete(id); }
  }
  let next = $('panes').firstElementChild;
  for (const id of openIds) {
    if (!state.conversations[id]) continue;
    const pane = panes.get(id) || createPane(id);
    // Keep focused controls and local drafts mounted while the owner streams state.
    if (pane.root !== next) $('panes').insertBefore(pane.root, next);
    next = pane.root.nextElementSibling;
    renderPane(pane, state.conversations[id]);
  }
  $('panes').dataset.count = openIds.length;
  $('pane-count').textContent = openIds.length + ' / 4 panes';
  renderTree();
}

function render(value) {
  if (value.buildId !== APP_BUILD_ID) { updated(); return; }
  const initial = !state;
  state = value;
  ownerReady = true;
  if (initial) restorePanes();
  openIds = openIds.filter(id => state.conversations[id]);
  if (!openIds.length) openIds = [state.rootId];
  if (!openIds.includes(activeId)) activeId = openIds[0];
  $('status').textContent = `${user.name} · ${Object.keys(state.conversations).length} conversations · one shared browser owner`;
  $('ownership').textContent = JSON.stringify({ userId: state.userId, ownerId: state.ownerId,
    openedAt: state.openedAt, storage: 'IndexedDB / JSONL', serverStorage: 'none' }, null, 2);
  $('recovered').textContent = JSON.stringify(state.recovered, null, 2);
  renderWorkspace();
}

function showFork(conversationId, entryId, count) {
  if (!enabled) return;
  forkTarget = { conversationId, entryId };
  $('fork-context').textContent = `${state.conversations[conversationId].title || 'Branch'} · from turn #${entryId}. Each fork inherits this history, notes, and files.`;
  $('fork-count').value = count;
  $('fork-error').textContent = '';
  $('fork-branches').replaceChildren();
  renderForkBranches();
  $('fork-dialog').showModal();
}

function renderForkBranches() {
  const previous = [...$('fork-branches').children].map(row => ({
    instruction: row.querySelector('textarea').value, model: row.querySelector('select').value
  }));
  $('fork-branches').replaceChildren();
  const base = modelValue(state.conversations[forkTarget.conversationId].agent?.model) || defaultModel;
  for (let index = 0; index < Number($('fork-count').value); index++) {
    const row = element('fieldset', 'fork-branch');
    row.append(element('legend', '', 'Direction ' + (index + 1)));
    const input = element('textarea');
    input.id = 'fork-instruction-' + index;
    input.rows = 2;
    input.placeholder = 'Optional — e.g. take a different approach, challenge assumptions…';
    input.value = previous[index]?.instruction || '';
    const inputLabel = element('label', '', 'Instruction (optional)');
    inputLabel.htmlFor = input.id;
    const select = element('select');
    select.id = 'fork-model-' + index;
    modelOptions(select, previous[index]?.model || base);
    const modelLabel = element('label', '', 'Model');
    modelLabel.htmlFor = select.id;
    row.append(inputLabel, input, modelLabel, select);
    $('fork-branches').append(row);
  }
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
  panes.clear();
  $('panes').replaceChildren();
  updateRequired = false;
  controls(false);
  $('status').textContent = 'Connecting to browser owner…';
  const identity = await api('me');
  if (identity.buildId !== APP_BUILD_ID) { updated(); return; }
  if (identity.user?.id !== confirmedUser.id) throw new Error('Session changed; sign in again');
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
  if (!catalog.length) {
    $('app').hidden = true;
    $('setup').hidden = false;
    $('erase').disabled = false;
    $('status').textContent = 'Configure your model credentials, then restart the server and reload';
    return;
  }
  const preference = available.defaultModel;
  defaultModel = catalog.some(model => model.provider + '/' + model.id === preference)
    ? preference : catalog[0].provider + '/' + catalog[0].id;
  const owner = new SharedWorker('/owner.js?user=' + encodeURIComponent(user.id) + '&build=' + APP_BUILD_ID, {
    type: 'module', name: 'pi-in-a-tab:' + user.id + ':' + APP_BUILD_ID
  });
  worker = owner;
  owner.port.start();
  owner.port.onmessage = event => {
    if (worker !== owner) return;
    const frame = event.data;
    if (frame.type === 'hello') {
      if (frame.buildId !== APP_BUILD_ID) updated();
      return;
    }
    if (frame.type === 'waiting') {
      $('status').textContent = 'Waiting for an older tab to close. ' + updateMessage;
      showError(updateMessage);
      return;
    }
    if (frame.error?.startsWith('Unknown action:')) { updated(); return; }
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
  if (!ownerReady) return;
  // Existing branch model choices belong to the durable agent, not this tab.
  if (!state.conversations[state.rootId].agent?.model) {
    const model = catalog.find(item => item.provider + '/' + item.id === defaultModel);
    await call('model', { conversationId: state.rootId, provider: model.provider, modelId: model.id });
  }
  controls(true);
}

async function refreshIdentity() {
  const identity = await api('me');
  loginRequired = identity.loginRequired;
  if (identity.user) await attach(identity.user);
  else showLogin();
}

function showError(error) {
  (user && !$('setup').hidden ? $('status') : user ? $('error') : $('login-error')).textContent = updateRequired ? updateMessage : safeError(error);
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
    localStorage.removeItem('pi-in-a-tab:panes:' + leavingUser.id);
    $('login-message').textContent = `Erased ${leavingUser.name}'s data from this device.`;
  }
  if (!loginRequired) await refreshIdentity();
}

$('fork-count').onchange = renderForkBranches;
$('fork-close').onclick = $('fork-cancel').onclick = () => $('fork-dialog').close();
$('fork-dialog').addEventListener('cancel', event => { if (forking) event.preventDefault(); });
$('fork-form').onsubmit = async event => {
  event.preventDefault();
  if (forking || !forkTarget) return;
  $('fork-error').textContent = '';
  const target = { ...forkTarget };
  try {
    const branches = [...$('fork-branches').children].map(row => ({
      instruction: row.querySelector('textarea').value.trim(), model: selectedModel(row.querySelector('select'))
    }));
    forking = true;
    controls(enabled);
    const result = await call('fork', { ...target, branches });
    $('fork-dialog').close();
    openBranches(result.conversationIds);
  } catch (error) { $('fork-error').textContent = safeError(error.message); }
  finally { forking = false; controls(enabled); }
};
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
authChanges.onmessage = () => { showLogin(); void guard(refreshIdentity); };
window.addEventListener('pagehide', detach);
void guard(refreshIdentity);
