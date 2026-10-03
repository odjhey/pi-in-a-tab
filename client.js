import { createStage } from './stage-client.js';
import { renderForms } from './form-client.js';
import { deckPrompt, createDeckPanel, renderDeck, downloadFile, disposeDeck } from './deck-client.js';

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
let changingGodMode = false;
let pageExecution = Promise.resolve();

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
  $('god-mode').disabled = !value || changingGodMode;
  for (const pane of panes.values()) updateControls(pane);
  for (const node of $('fork-form').elements) node.disabled = !value || forking;
}

function updateControls(pane) {
  const live = state?.conversations[pane.id]?.view?.docs?.['pi.live'] || {};
  const running = !!live.run;
  pane.input.disabled = !enabled;
  pane.send.disabled = !enabled || running || pane.submitting;
  pane.deckStarter.disabled = !enabled || running || pane.submitting;
  pane.model.disabled = !enabled || running || pane.changingModel;
  pane.notes.disabled = !enabled || pane.historyEntry !== undefined;
  pane.save.disabled = !enabled || pane.savingNotes || pane.historyEntry !== undefined;
  for (const node of pane.transcript.querySelectorAll('button, select')) node.disabled = !enabled;
  for (const card of pane.cards.values()) {
    const disabled = !enabled || card.status !== 'pending' || card.answering;
    card.approve.disabled = card.reject.disabled = card.reason.disabled = disabled;
  }
  pane.stageReset.disabled = !enabled;
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
  for (const pane of panes.values()) { pane.stage?.dispose(); pane.stage = undefined; disposeDeck(pane); }
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

function ensureStage(pane) {
  if (!pane.stage) pane.stage = createStage(pane.stageContainer);
  return pane.stage;
}

function renderInteractions(pane, conversation) {
  const cards = conversation.interactions?.cards || {};
  for (const [id, card] of pane.cards) {
    if (!Object.hasOwn(cards, id)) { card.root.remove(); pane.cards.delete(id); }
  }
  for (const [id, value] of Object.entries(cards)) {
    let card = pane.cards.get(id);
    if (!card) {
      card = { root: element('article', 'approval-card'), answering: false };
      card.root.dataset.cardId = id;
      card.heading = element('h4');
      card.text = element('p', 'approval-text');
      card.code = element('pre', 'approval-code');
      card.why = element('p', 'approval-why');
      card.state = element('small', 'approval-status');
      card.reason = element('textarea');
      card.reason.rows = 2;
      card.reason.placeholder = 'Optional reason or answer';
      card.reason.setAttribute('aria-label', 'Optional reason or answer');
      card.error = element('p', 'pane-error');
      card.error.setAttribute('role', 'alert');
      const answer = async approved => {
        if (card.answering || card.status !== 'pending') return;
        card.answering = true;
        card.error.textContent = '';
        updateControls(pane);
        try {
          await call('answer', { conversationId: pane.id, cardId: id, approved, reason: card.reason.value });
        } catch (error) { card.error.textContent = safeError(error.message); }
        finally { card.answering = false; updateControls(pane); }
      };
      card.approve = button('Approve', () => void answer(true));
      card.reject = button('Reject', () => void answer(false), 'secondary');
      const actions = element('div', 'approval-actions');
      actions.append(card.approve, card.reject);
      card.root.append(card.heading, card.text, card.why, card.code, card.state, card.reason, actions, card.error);
      pane.cards.set(id, card);
      pane.interactions.append(card.root);
    }
    card.status = value.status;
    card.root.dataset.status = value.status;
    card.heading.textContent = value.kind === 'page_js' ? 'Approve main-page JavaScript' : 'Your answer is needed';
    card.text.textContent = value.text || '';
    card.text.hidden = !value.text;
    card.code.textContent = value.code || '';
    card.code.hidden = value.kind !== 'page_js';
    card.why.textContent = value.reason || '';
    card.why.hidden = !value.reason;
    card.state.textContent = value.status + (value.answerReason ? ' · ' + value.answerReason : '');
    card.reason.hidden = card.approve.hidden = card.reject.hidden = value.status !== 'pending';
  }
}

function chartFigure(chart) {
  const figure = element('figure', 'chart');
  figure.append(element('figcaption', '', chart.title));
  const svgNode = (tag, attributes, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const height = chart.values.length * 40 + 20;
  const svg = svgNode('svg', { viewBox: '0 0 640 ' + height, role: 'img', 'aria-label': chart.title });
  svg.append(svgNode('title', {}, chart.title));
  const min = Math.min(0, ...chart.values);
  const max = Math.max(0, ...chart.values);
  const x = value => 170 + (value - min) / (max - min || 1) * 370;
  const zero = x(0);
  svg.append(svgNode('line', { x1: zero, x2: zero, y1: 5, y2: height - 5, stroke: 'var(--muted)' }));
  chart.values.forEach((value, index) => {
    const y = index * 40 + 10;
    svg.append(svgNode('text', { x: 160, y: y + 19, 'text-anchor': 'end', fill: 'var(--text)' }, chart.labels[index]),
      svgNode('rect', { x: Math.min(zero, x(value)), y, width: Math.abs(x(value) - zero), height: 27, rx: 3, fill: 'var(--accent)' }),
      svgNode('text', { x: 550, y: y + 19, fill: 'var(--text)' }, value));
  });
  figure.append(svg);
  return figure;
}

function renderCharts(pane, conversation) {
  const durable = conversation.interactions?.charts || {};
  for (const id of Object.keys(durable)) pane.optimisticCharts.delete(id);
  const charts = { ...Object.fromEntries(pane.optimisticCharts), ...durable };
  for (const [id, chart] of pane.charts) {
    if (!Object.hasOwn(charts, id)) { chart.root.remove(); pane.charts.delete(id); }
  }
  for (const [id, value] of Object.entries(charts)) {
    const signature = JSON.stringify(value);
    const existing = pane.charts.get(id);
    if (existing?.signature === signature) continue;
    const root = chartFigure(value);
    root.dataset.chartId = id;
    if (existing) existing.root.replaceWith(root);
    else pane.chartPanel.append(root);
    pane.charts.set(id, { root, signature });
  }
}

function actionPane(frame) {
  const id = frame.conversationId || activeId || state?.rootId;
  if (!state?.conversations[id]) throw new Error('Conversation not found');
  if (!panes.has(id)) openConversation(id);
  return panes.get(id);
}

function serializable(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return String(item);
    if (typeof item === 'function' || typeof item === 'symbol') return String(item);
    if (item instanceof Error) return { name: item.name, message: item.message };
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  }) ?? 'null');
}

async function runPageJS(code) {
  if (state?.godMode !== true) throw new Error('God mode is disabled. Main-page JavaScript requires enabling it.');
  const logs = [];
  const errors = [];
  const original = new Map();
  const captureError = event => errors.push(safeError(event.message || event.reason?.message || event.reason || 'Page error'));
  const printable = value => { try { return typeof value === 'string' ? value : JSON.stringify(serializable(value)); } catch { return String(value); } };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const method = console[level];
    original.set(level, method);
    console[level] = (...values) => {
      logs.push({ level, text: safeError(values.map(printable).join(' ')) });
      method.apply(console, values);
    };
  }
  window.addEventListener('error', captureError);
  window.addEventListener('unhandledrejection', captureError);
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = serializable(await new AsyncFunction(code).call(window));
    return { result, console: logs, errors };
  } catch (error) {
    errors.push(safeError(error.message || error));
    const failure = new Error(safeError(error.message || error));
    failure.result = { result: null, console: logs, errors };
    throw failure;
  } finally {
    for (const [level, method] of original) console[level] = method;
    window.removeEventListener('error', captureError);
    window.removeEventListener('unhandledrejection', captureError);
  }
}

const frontendActions = {
  download_file(args, frame) {
    openConversation(frame.conversationId);
    const pane = panes.get(frame.conversationId); downloadFile(pane, args);
    pane.downloadPanel.scrollIntoView({ block: 'nearest' });
    return { path: args.path, downloadLinkReady: true };
  },
  open_pane(args, frame) {
    const id = args.conversation || frame.conversationId;
    if (!state?.conversations[id]) throw new Error('Conversation not found');
    openConversation(id);
    return { conversation: id, opened: true };
  },
  highlight(args, frame) {
    const entryId = String(args.entry);
    let pane = [...panes.values()].find(value => [...value.transcript.querySelectorAll('[data-entry-id]')].some(row => row.dataset.entryId === entryId));
    if (!pane) pane = actionPane(frame);
    const row = [...pane.transcript.querySelectorAll('[data-entry-id]')].find(value => value.dataset.entryId === entryId);
    if (!row) throw new Error('Message entry not found in conversation');
    activatePane(pane.id);
    pane.highlightedEntry = entryId;
    for (const message of pane.transcript.querySelectorAll('.highlighted')) message.classList.remove('highlighted');
    row.classList.add('highlighted');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return { conversation: pane.id, entry: args.entry, highlighted: true };
  },
  toast(args) {
    const toast = element('div', 'toast', args.text);
    $('toasts').append(toast);
    setTimeout(() => toast.remove(), 6000);
    return { shown: true };
  },
  set_theme(args) {
    if (args.mode !== undefined && !['dark', 'light'].includes(args.mode)) throw new Error('Theme mode must be dark or light');
    if (args.accent !== undefined && !CSS.supports('color', args.accent)) throw new Error('Accent must be a CSS color');
    if (args.mode) document.documentElement.dataset.theme = args.mode;
    if (args.accent) document.documentElement.style.setProperty('--accent', args.accent);
    return { mode: document.documentElement.dataset.theme || 'dark', accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() };
  },
  show_chart(args, frame) {
    if (!Array.isArray(args.labels) || !Array.isArray(args.values) || args.labels.length !== args.values.length || !args.values.every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Chart labels and finite numeric values must have matching lengths');
    }
    const pane = actionPane(frame);
    const id = frame.actionId || frame.id;
    pane.optimisticCharts.set(id, { ...args, id });
    renderCharts(pane, state.conversations[pane.id]);
    return { id, shown: true, conversation: pane.id };
  },
  page_js(args) {
    const result = pageExecution.then(() => runPageJS(args.code));
    pageExecution = result.catch(() => {});
    return result;
  },
  async stage_run(args, frame) {
    const pane = actionPane(frame);
    pane.stagePanel.open = true;
    return await ensureStage(pane).run(args.code);
  },
  async stage_reset(_args, frame) {
    const pane = actionPane(frame);
    pane.stagePanel.open = true;
    return await ensureStage(pane).reset();
  }
};

async function dispatchFrontend(frame, owner) {
  let payload;
  try {
    if (!Object.hasOwn(frontendActions, frame.action)) throw new Error('Unknown frontend action: ' + frame.action);
    payload = { result: serializable(await frontendActions[frame.action](frame.args || {}, frame)) };
  } catch (error) { payload = { result: error.result || null, error: safeError(error.message || error) }; }
  if (worker === owner) owner.port.postMessage({ action: 'tab-result', id: frame.id, payload });
}


function createPane(id) {
  const pane = { id, submitting: false, changingModel: false, savingNotes: false, notesDirty: false,
    cards: new Map(), forms: new Map(), charts: new Map(), optimisticCharts: new Map() };
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
  pane.interactions = element('section', 'interactions');
  pane.interactions.setAttribute('aria-label', 'Approval requests');
  pane.formPanel = element('section', 'forms');
  pane.formPanel.setAttribute('aria-label', 'Schema forms');
  pane.reminderPanel = element('section', 'reminders');
  pane.reminderPanel.setAttribute('aria-label', 'Self-reminders');
  pane.chartPanel = element('section', 'charts');
  pane.chartPanel.setAttribute('aria-label', 'Conversation charts');
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
  pane.deckStarter = button('Deck studio', () => { pane.input.value = deckPrompt; pane.send.click(); }, 'secondary deck-starter');
  footer.append(pane.deckStarter, element('small', '', '⌘ / Ctrl + Enter to send'), pane.send);
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
  pane.stagePanel = element('details', 'stage-panel');
  pane.stagePanel.append(element('summary', '', 'Sandbox stage'));
  pane.stageContainer = element('div', 'stage-container');
  pane.stageReset = button('Reset stage', () => paneOperation(pane, async () => {
    await ensureStage(pane).reset();
  }), 'secondary');
  pane.stagePanel.append(element('p', 'resource-hint', 'Scripts run in an isolated iframe, without access to this page or browser storage.'),
    pane.stageContainer, pane.stageReset);
  pane.stagePanel.ontoggle = () => { if (pane.stagePanel.open) ensureStage(pane); };
  pane.timeline = element('div', 'timeline');
  pane.timelineLabel = element('small', '', 'Live files and notes');
  pane.slider = element('input'); pane.slider.type = 'range'; pane.slider.min = 0; pane.slider.step = 1; pane.slider.setAttribute('aria-label', 'Time travel through transcript');
  pane.slider.oninput = () => paneOperation(pane, async () => {
    const entries = (state.conversations[id].view.entries || []).filter(entry => entry.kind !== 'pi.system');
    const entry = entries[Number(pane.slider.value)];
    const request = pane.historyRequest = (pane.historyRequest || 0) + 1;
    pane.historyEntry = entry?.id;
    pane.history = undefined;
    if (entry) { const history = await call('history', { conversationId: id, entryId: entry.id }); if (request !== pane.historyRequest) return; pane.history = history; }
    renderPane(pane, state.conversations[id]);
    pane.transcript.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
  });
  pane.timelineFork = button('Fork from here', () => showFork(id, pane.historyEntry, 1), 'secondary');
  const liveButton = button('Back to live', () => { pane.historyRequest = (pane.historyRequest || 0) + 1; pane.historyEntry = undefined; pane.history = undefined; pane.notesDirty = false; renderPane(pane, state.conversations[id]); }, 'secondary');
  pane.timeline.append(pane.timelineLabel, pane.slider, pane.timelineFork, liveButton);
  pane.customPanel = element('details', 'custom-tools');
  pane.customSummary = element('summary', '', 'Custom tools');
  pane.customCode = element('pre'); pane.customPanel.append(pane.customSummary, pane.customCode);
  resources.append(notes, files, pane.customPanel, pane.stagePanel);
  const deckPanel = createDeckPanel(pane);
  pane.root.append(header, pane.transcript, pane.timeline, pane.interactions, pane.formPanel, pane.reminderPanel, pane.chartPanel, deckPanel, pane.downloadPanel, composer, resources);
  panes.set(id, pane);
  return pane;
}

function renderFile(pane) {
  const files = (pane.historyEntry !== undefined ? pane.history?.files : state.conversations[pane.id]?.files)?.files || {};
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
  pane.slider.max = entries.length; pane.slider.value = pane.historyEntry === undefined ? entries.length : entries.findIndex(entry => entry.id === pane.historyEntry);
  pane.slider.disabled = !entries.length;
  pane.timelineLabel.textContent = pane.historyEntry === undefined ? 'Live files and notes' : 'Read-only as of #' + pane.historyEntry;
  pane.timelineFork.disabled = pane.historyEntry === undefined;
  for (const entry of entries) {
    const row = element('div', 'message');
    row.dataset.entryId = entry.id;
    row.classList.toggle('highlighted', (pane.historyEntry ?? Number(pane.highlightedEntry)) === entry.id);
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
  if (pane.historyEntry !== undefined) pane.notes.value = pane.history?.notes?.text || '';
  else if (!pane.notesDirty && document.activeElement !== pane.notes) pane.notes.value = conversation.notes?.text || '';
  const selectedFile = pane.files.value;
  const paths = Object.keys((pane.historyEntry !== undefined ? pane.history?.files : conversation.files)?.files || {}).sort();
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
  renderInteractions(pane, conversation);
  renderForms(pane, conversation, call);
  pane.customSummary.textContent = 'Custom tools · ' + Object.keys(conversation.customTools?.definitions || {}).length;
  pane.customCode.textContent = Object.values(conversation.customTools?.definitions || {}).map(def => def.name + ': ' + def.description + '\n' + JSON.stringify(def.parametersSchema, null, 2) + '\n' + def.code).join('\n\n');
  pane.reminderPanel.replaceChildren();
  for (const row of Object.values(conversation.reminders?.items || {})) {
    const card = element('article', 'approval-card');
    const clock = element('small', 'reminder-clock');
    clock.dataset.dueAt = row.dueAt; clock.dataset.status = row.status;
    card.append(element('p', '', row.message), clock);
    if (row.status === 'pending') card.append(button('Cancel reminder', () => paneOperation(pane, () => call('cancel-reminder', { conversationId: pane.id, reminderId: row.id })), 'secondary'));
    pane.reminderPanel.append(card);
  }
  renderCharts(pane, conversation);
  renderDeck(pane, conversation);
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
    if (!openIds.includes(id)) { pane.stage?.dispose(); disposeDeck(pane); pane.root.remove(); panes.delete(id); }
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
  $('god-mode').checked = state.godMode === true;
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
  evaluator.postMessage({ code: frame.code, files: frame.files, args: frame.args });
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
    if (frame.type === 'frontend') return void dispatchFrontend(frame, owner);
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
  if (document.hasFocus()) await call('focus');
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
window.addEventListener('focus', () => { if (ownerReady) void guard(() => call('focus')); });
$('god-mode').onchange = () => {
  const requested = $('god-mode').checked;
  void guard(async () => {
    changingGodMode = true;
    controls(enabled);
    try { await call('god-mode', { enabled: requested }); }
    finally {
      changingGodMode = false;
      $('god-mode').checked = state?.godMode === true;
      controls(enabled);
    }
  });
};
void guard(refreshIdentity);
setInterval(() => { for (const clock of document.querySelectorAll('.reminder-clock')) { const seconds = Math.ceil((Number(clock.dataset.dueAt) - Date.now()) / 1000); clock.textContent = clock.dataset.status === 'pending' ? (seconds > 0 ? 'Due in ' + seconds + 's' : 'Due now / overdue') : clock.dataset.status; } }, 1000);
