import { Validator } from '@cfworker/json-schema';
import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineTool, defineExtension } from '@earendil-works/pi-durable';

export const Forms = defineDoc({ kind: 'tab.forms', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ cards: {} }) });
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export function checkSchema(schema) {
  // The interpreter annotates schemas with non-enumerable URI fields; never annotate durable data.
  schema = structuredClone(schema);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Schema must be an object');
  const visit = (s, path) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Invalid schema at ' + path);
    if (s.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(s.type)) throw new Error('Unsupported type at ' + path);
    if (s.format === 'url') s.format = 'uri';
    if (s.$ref || s.patternProperties || s.anyOf || s.allOf || s.not) throw new Error('Unsupported schema keyword at ' + path);
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || (key.includes('Length') || key.includes('Items')) && (!Number.isInteger(s[key]) || s[key] < 0))) throw new Error('Invalid ' + key + ' at ' + path);
    if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every(x => typeof x === 'string'))) throw new Error('Invalid required at ' + path);
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) throw new Error('Invalid enum at ' + path);
    if (s.oneOf !== undefined && (!Array.isArray(s.oneOf) || !s.oneOf.length || !s.oneOf.every(x => x && Object.hasOwn(x, 'const')))) throw new Error('oneOf supports const choices only at ' + path);
    if (s.properties !== undefined) {
      if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) throw new Error('Invalid properties at ' + path);
      for (const [key, child] of Object.entries(s.properties)) visit(child, path + '/' + key);
    }
    if (s.type === 'array') { if (!s.items) throw new Error('Array needs items at ' + path); visit(s.items, path + '/*'); }
    if (s.default !== undefined && !new Validator(s, '2019-09', false).validate(s.default).valid) throw new Error('Invalid default at ' + path);
  };
  visit(schema, '');
  return new Validator(schema, '2019-09', false);
}
export function validateForm(schema, data) {
  const result = checkSchema(schema).validate(data);
  return result.errors.map(error => ({ path: error.instanceLocation.replace(/^#/, ''), message: error.error }));
}
export const formTools = defineExtension({ name: 'browser-forms', tools: ['ask_form', 'show_form'].map(name => defineTool({
  name, replay: 'safe', description: name === 'ask_form'
    ? 'Show a durable JSON Schema form and wait for validated submission or cancellation. Supports nested objects, arrays, required, defaults, enum/oneOf const, string email/date/url, number bounds. uiHints maps JSON pointer paths to multiline or slider.'
    : 'Show a persistent non-blocking JSON Schema form. Every validated submission becomes a follow-up user message. Supports the same subset as ask_form.',
  parameters: Type.Object({ title: Type.String(), schema: Type.Any(), uiHints: Type.Optional(Type.Any()) }),
  execute: async (args, api, ctx) => {
    checkSchema(args.schema);
    await api.commit(async tx => {
      const doc = await tx.doc(Forms, api.conversationId);
      if (!doc.cards[api.taskId]) doc.cards[api.taskId] = { id: api.taskId, kind: name, ...args, status: 'pending' };
    }, ctx);
    if (name === 'show_form') return text({ shown: true, id: api.taskId });
    const watch = await api.watchDoc(Forms, api.conversationId, ctx);
    try {
      return text(await new Promise((resolve, reject) => {
        const receive = value => { const card = value?.cards[api.taskId]; if (card?.status === 'submitted') resolve({ data: card.data }); else if (card?.status === 'cancelled') resolve({ cancelled: true }); };
        watch.start(async value => receive(value)); receive(watch.value);
        watch.closed.then(() => reject(new Error('Form wait ended')));
      }));
    } finally { await watch.stop(); }
  }
})) });
