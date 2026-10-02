import { Type } from '@earendil-works/pi-ai';
import { AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable';

// A fork starts its own call registry; replay of an existing call reuses its children.
const Calls = defineDoc({ kind: 'tab.subagent-calls', version: 1, scope: 'conversation',
  history: 'latest', fork: 'initial', initial: () => ({ calls: {} }) });
const textOf = entry => (entry?.model?.[0]?.content ?? [])
  .filter(part => part.type === 'text').map(part => part.text).join('');
const completed = () => ({ status: 'terminal', outcome: { status: 'completed', result: null } });
const abort = (_task, runtime, ctx) => runtime.commit(
  () => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);

// Background ownership is a boundary for the parent's ordinary abort and idle wait.
const Anchor = defineTask({ name: 'tab.subagent-anchor', version: 1,
  initial: () => ({ phase: 'done' }),
  phases: { done: (_task, runtime, ctx) => runtime.commit(completed, ctx) }, abort });
const Reporter = defineTask({ name: 'tab.subagent-reporter', version: 1,
  initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (task, runtime, ctx) => {
      const { name, conversationId, message } = task.input;
      const child = await runtime.conversation(conversationId, ctx);
      if (!child) throw new Error(`Missing subagent ${conversationId}`);
      const settled = await (await child.submit({ type: 'input', content: message,
        requestId: `delegate:${task.id}` }, ctx)).wait(ctx);
      await runtime.commit(async tx => {
        const report = settled.status === 'done' && settled.type === 'input'
          ? `[subagent ${name} (${conversationId}) completed] ${textOf(await tx.entry(AssistantEntry, settled.answer))}`
          : `[subagent ${name} (${conversationId}) failed: ${settled.reason ?? settled.status}]`;
        return { status: 'running', checkpoint: { phase: 'report', report } };
      }, ctx);
    },
    report: async (task, runtime, ctx) => {
      const parent = await runtime.conversation(runtime.conversationId, ctx);
      if (!parent) throw new Error(`Missing parent ${runtime.conversationId}`);
      await parent.submit({ type: 'input', content: task.state.checkpoint.report,
        whenBusy: 'followUp', requestId: `delegate-report:${task.id}` }, ctx);
      await runtime.commit(completed, ctx);
    }
  }, abort });

/** Native children inherit agent settings/tools; the supplied docs hold their private working state. */
export function createSubagents({ Notes, Workspace, Branches, onConversation }) {
  const parameters = Type.Object({ tasks: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() }))
  }), { minItems: 1, maxItems: 3 }) });

  const makeTool = background => defineTool({
    name: background ? 'delegate_background' : 'delegate',
    description: background
      ? 'Start 1–3 independent background subagents. Return their conversation IDs immediately; each result arrives as a follow-up. Maximum depth 2 and 12 children per parent.'
      : 'Run 1–3 independent subagent tasks concurrently and return their final answers and conversation IDs. Maximum depth 2 and 12 children per parent.',
    parameters, replay: 'safe',
    execute: async ({ tasks }, api, ctx) => {
      const children = await api.commit(async tx => {
        const calls = await tx.doc(Calls, api.conversationId);
        if (Object.hasOwn(calls.calls, api.taskId)) {
          return calls.calls[api.taskId].map(({ name, conversationId }) => ({ name, conversationId }));
        }
        const branches = await tx.doc(Branches);
        let depth = 0;
        for (let node = branches.nodes[api.conversationId]; node; node = branches.nodes[node.parentId]) {
          if (node.kind === 'subagent' || node.kind === 'background') depth++;
        }
        if (depth >= 2) throw new Error('Subagent depth limit reached (2).');
        const count = Object.values(branches.nodes).filter(node => node.parentId === api.conversationId
          && (node.kind === 'subagent' || node.kind === 'background')).length;
        if (count + tasks.length > 12) throw new Error('Subagent child limit exceeded (12 per parent).');
        // tx.doc returns a tracked proxy, so materialize JSON before cloning for each child.
        const notes = JSON.parse(JSON.stringify(await tx.doc(Notes, api.conversationId)));
        const workspace = JSON.parse(JSON.stringify(await tx.doc(Workspace, api.conversationId)));
        const created = [];
        for (const { name, task, model } of tasks) {
          const options = { ownership: { kind: 'conversation' }, background: true };
          const owner = background ? await tx.createTask(Anchor, null, options) : api.taskId;
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } });
          Object.assign(await tx.doc(Notes, child.id), structuredClone(notes));
          Object.assign(await tx.doc(Workspace, child.id), structuredClone(workspace));
          if (model) await configure(tx, child.id, { model });
          branches.nodes[child.id] = { id: child.id, parentId: api.conversationId,
            kind: background ? 'background' : 'subagent', title: name };
          if (background) await tx.createTask(Reporter, { name, conversationId: child.id, message: task }, options);
          created.push({ name, conversationId: child.id });
        }
        calls.calls[api.taskId] = created;
        return created;
      }, ctx);
      const details = { children, conversationIds: children.map(child => child.conversationId), background };
      await api.details(details, ctx);
      await Promise.all(children.map(child => onConversation(child.conversationId)));
      if (background) return { content: [{ type: 'text', text: JSON.stringify(children) }], details };
      const answers = await Promise.all(children.map(async (child, index) => {
        try {
          const handle = await api.conversation(child.conversationId, ctx);
          if (!handle) throw new Error(`Missing subagent ${child.conversationId}`);
          const settled = await (await handle.submit({ type: 'input', content: tasks[index].task,
            requestId: `delegate:${api.taskId}:${index}` }, ctx)).wait(ctx);
          if (settled.status !== 'done' || settled.type !== 'input') {
            return { ...child, error: `Subagent failed: ${settled.reason ?? settled.status}` };
          }
          const text = await api.commit(async tx => textOf(await tx.entry(AssistantEntry, settled.answer)), ctx);
          return { ...child, text };
        } catch (error) {
          // Never convert parent cancellation into a successful tool result.
          if (ctx.abortSignal.aborted) throw error;
          return { ...child, error: String(error) };
        }
      }));
      return { content: [{ type: 'text', text: JSON.stringify(answers) }],
        details: { ...details, children: answers }, isError: answers.every(answer => answer.error !== undefined) };
    }
  });
  return defineExtension({ name: 'browser-subagents', tasks: [Anchor, Reporter],
    tools: [makeTool(false), makeTool(true)] });
}
