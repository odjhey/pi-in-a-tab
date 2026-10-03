import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineTool, defineExtension } from '@earendil-works/pi-durable';
import { checkSchema, validateForm } from './forms.js';
export const CustomTools = defineDoc({ kind: 'tab.custom-tools', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf', initial: () => ({ definitions: {} }) });
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export const customExtensionName = id => 'custom-tools:' + id;
export function createCustomTools({ registry, requestTab, Workspace }) {
  const install = (id, doc) => {
    registry.install(defineExtension({ name: customExtensionName(id), tools: Object.values(doc?.definitions || {}).map(def => defineTool({ name: def.name, description: def.description, parameters: def.parametersSchema, replay: 'unsafe', execute: async (args, api, ctx) => {
      if (api.conversationId !== id) throw new Error('Custom tool belongs to another conversation');
      const current = (await api.snapshot(CustomTools, id, ctx))?.definitions[def.name];
      if (!current) throw new Error('Custom tool no longer exists');
      const errors = validateForm(current.parametersSchema, args); if (errors.length) throw new Error(JSON.stringify(errors));
      const files = (await api.snapshot(Workspace, id, ctx))?.files || {};
      return text(await requestTab('evaluate', { code: current.code, args, files }, ctx.abortSignal));
    } })) }));
  };
  const tools = [defineTool({ name: 'define_tool', description: 'Define a tool for this branch. parametersSchema must be an object JSON Schema (form subset). code is an async JavaScript function body with args and read-only fs; return JSON data. Runs only in an isolated eval worker, never page/owner. Definitions rewind with forks. Generated code is unsafe to replay. The new tool is available next turn/round.', replay: 'unsafe', parameters: Type.Object({ name: Type.String(), description: Type.String(), parametersSchema: Type.Any(), code: Type.String() }), execute: async (args, api, ctx) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(args.name)) throw new Error('Use a lowercase tool name');
    if (args.parametersSchema?.type !== 'object') throw new Error('parametersSchema must have type object');
    checkSchema(args.parametersSchema);
    if (registry.snapshot().tools().some(({extension, tool}) => extension.name !== customExtensionName(api.conversationId) && !extension.name.startsWith('custom-tools:') && tool.name === args.name)) throw new Error('Name conflicts with a built-in tool');
    await api.commit(async tx => { (await tx.doc(CustomTools, api.conversationId)).definitions[args.name] = args; }, ctx);
    install(api.conversationId, await api.snapshot(CustomTools, api.conversationId, ctx));
    return text({ defined: args.name });
  } }), defineTool({ name: 'list_tools', description: 'List custom tools defined in this branch, including schemas and code.', replay: 'safe', parameters: Type.Object({}), execute: async (_, api, ctx) => text((await api.snapshot(CustomTools, api.conversationId, ctx))?.definitions || {}) }), defineTool({ name: 'remove_tool', description: 'Remove a custom tool from this branch; older forks keep their own definition.', replay: 'unsafe', parameters: Type.Object({ name: Type.String() }), execute: async (args, api, ctx) => {
    await api.commit(async tx => { const doc = await tx.doc(CustomTools, api.conversationId); if (!Object.hasOwn(doc.definitions, args.name)) throw new Error('No such custom tool'); delete doc.definitions[args.name]; }, ctx);
    install(api.conversationId, await api.snapshot(CustomTools, api.conversationId, ctx)); return text({ removed: args.name });
  } })];
  return { extension: defineExtension({ name: 'browser-custom-tools', tools }), install };
}
