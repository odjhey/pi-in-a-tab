const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const clone = value => value === undefined ? undefined : structuredClone(value);
function initial(schema) {
  if (Object.hasOwn(schema, 'default')) return clone(schema.default);
  if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, child]) => [key, initial(child)]).filter(([, value]) => value !== undefined));
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  return undefined;
}
export function createFormCard(value, send) {
  const root = el('article'); root.className = 'form-card approval-card'; root.dataset.formId = value.id;
  const heading = el('h4', value.title), status = el('small'), fields = el('div'), errors = el('div'), actions = el('div');
  actions.className = 'approval-actions';
  let data = clone(value.draft ?? initial(value.schema)), timer, saving = Promise.resolve();
  const labels = new Map();
  const jsonData = () => JSON.parse(JSON.stringify(data ?? null));
  const save = () => { clearTimeout(timer); timer = setTimeout(() => { const draft = jsonData(); saving = saving.then(() => send('form-draft', { cardId: value.id, data: draft })).catch(error => { errors.textContent = error.message; }); }, 150); };
  const build = (schema, path, get, set, required = false) => {
    const box = el('fieldset'); box.dataset.path = path;
    const label = el('legend', (schema.title || path.split('/').at(-1) || value.title) + (required ? ' *' : ''));
    box.append(label);
    if (schema.description) box.append(el('small', schema.description));
    const error = el('p'); error.className = 'field-error'; error.setAttribute('role', 'alert'); labels.set(path, error);
    const update = v => { set(v); save(); };
    if (schema.type === 'object' || schema.properties) {
      for (const [key, child] of Object.entries(schema.properties || {})) box.append(build(child, path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), () => get()?.[key], v => {
        const next = { ...(get() || {}) }; if (v === undefined) delete next[key]; else next[key] = v; set(next);
      }, schema.required?.includes(key)));
    } else if (schema.type === 'array') {
      const rows = el('div');
      const render = () => {
        rows.replaceChildren();
        (get() || []).forEach((item, index) => {
          const row = el('div'); row.className = 'form-array-row';
          row.append(build(schema.items, path + '/' + index, () => get()?.[index], v => { const next = [...get()]; next[index] = v; set(next); }, true));
          const remove = el('button', 'Remove'); remove.type = 'button'; remove.onclick = () => { update(get().filter((_, i) => i !== index)); render(); }; row.append(remove); rows.append(row);
        });
      };
      const add = el('button', 'Add row'); add.type = 'button'; add.onclick = () => { update([...(get() || []), initial(schema.items) ?? (schema.items.type === 'string' ? '' : null)]); render(); };
      render(); box.append(rows, add);
    } else {
      const choices = schema.enum || schema.oneOf?.map(x => x.const) || (Object.hasOwn(schema, 'const') ? [schema.const] : null);
      let input;
      if (choices) {
        input = el('select'); const empty = el('option', 'Choose…'); empty.value = ''; input.append(empty);
        choices.forEach((choice, i) => { const option = el('option', schema.oneOf?.[i]?.title || String(choice)); option.value = String(i); input.append(option); });
        const index = choices.findIndex(x => JSON.stringify(x) === JSON.stringify(get())); input.value = index < 0 ? '' : String(index);
        input.onchange = () => update(input.value === '' ? undefined : clone(choices[Number(input.value)]));
      } else {
        const hint = value.uiHints?.[path]; input = el(hint === 'multiline' || hint?.widget === 'multiline' || hint?.multiline ? 'textarea' : 'input');
        if (input.tagName === 'INPUT') input.type = schema.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(schema.type) ? (hint === 'slider' || hint?.widget === 'slider' ? 'range' : 'number') : ({ email: 'email', date: 'date', url: 'url', uri: 'url' }[schema.format] || 'text');
        if (schema.type === 'boolean') input.checked = get() === true; else input.value = get() ?? '';
        if (schema.minimum !== undefined) input.min = schema.minimum;
        if (schema.maximum !== undefined) input.max = schema.maximum;
        if (schema.maxLength !== undefined) input.maxLength = schema.maxLength;
        if (['number', 'integer'].includes(schema.type)) input.step = schema.type === 'integer' ? '1' : 'any';
        input.oninput = () => update(schema.type === 'boolean' ? input.checked : input.value === '' ? undefined : ['number', 'integer'].includes(schema.type) ? Number(input.value) : input.value);
      }
      input.dataset.path = path; input.setAttribute('aria-label', schema.title || path); box.append(input);
    }
    box.append(error); return box;
  };
  fields.append(build(value.schema, '', () => data, v => { data = v; }));
  const submit = el('button', 'Submit form'), cancel = el('button', 'Cancel');
  const act = async cancelled => {
    clearTimeout(timer); errors.replaceChildren(); for (const label of labels.values()) label.textContent = '';
    submit.disabled = cancel.disabled = true;
    try {
      await saving;
      if (!cancelled) await send('form-draft', { cardId: value.id, data: jsonData() });
      const result = await send('form-submit', { cardId: value.id, data: jsonData(), cancelled });
      for (const error of result.errors || []) { const target = labels.get(error.path); if (target) target.textContent += error.message + ' '; else errors.append(el('p', (error.path || 'Form') + ': ' + error.message)); }
    } catch (error) { errors.textContent = error.message; }
    finally { submit.disabled = cancel.disabled = false; }
  };
  submit.onclick = () => void act(false); cancel.onclick = () => void act(true);
  actions.append(submit, cancel); root.append(heading, status, fields, errors, actions);
  return { root, update(card) { status.textContent = card.status + (card.submissions ? ' · submissions: ' + card.submissions : ''); const done = card.status !== 'pending'; fields.disabled = done; for (const input of fields.querySelectorAll('input, textarea, select, button')) input.disabled = done; actions.hidden = done; } };
}
export function renderForms(pane, conversation, call) {
  const cards = conversation.forms?.cards || {};
  for (const [id, card] of pane.forms) if (!cards[id]) { card.root.remove(); pane.forms.delete(id); }
  for (const [id, value] of Object.entries(cards)) {
    if (!pane.forms.has(id)) { const card = createFormCard(value, (action, payload) => call(action, { conversationId: pane.id, ...payload })); pane.forms.set(id, card); pane.formPanel.append(card.root); }
    pane.forms.get(id).update(value);
  }
}
