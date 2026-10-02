import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';

export const Interactions = defineDoc({ kind: 'tab.interactions', version: 1,
  scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ cards: {}, charts: {} }) });
export const UISettings = defineDoc({ kind: 'tab.ui-settings', version: 1,
  scope: 'session', history: 'latest', initial: () => ({ godMode: false }) });
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value ?? null) }] });

async function approval(args, kind, api, ctx) {
  await api.commit(async tx => {
    const doc = await tx.doc(Interactions, api.conversationId);
    if (!doc.cards[api.taskId]) doc.cards[api.taskId] = { id: api.taskId, kind,
      text: args.text || args.reason, ...(args.code ? { code: args.code, reason: args.reason } : {}), status: 'pending' };
  }, ctx);
  // The card, not this promise, is durable. Safe replay reacquires the same task's card and watch.
  const watch = await api.watchDoc(Interactions, api.conversationId, ctx);
  try {
    return await new Promise((resolve, reject) => {
      const receive = value => {
        const card = value?.cards[api.taskId];
        if (card && card.status !== 'pending') resolve(card);
      };
      watch.start(async value => receive(value));
      receive(watch.value);
      watch.closed.then(() => reject(new Error('Approval wait ended before an answer')));
    });
  } finally { await watch.stop(); }
}

export function createFrontendTools({ requestTab, hasTab, readGodMode }) {
  const requireTab = () => { if (!hasTab()) throw new Error('No attached tab available for frontend action'); };
  const run = (action, args, api, ctx) => requestTab('frontend', {
    action, args, conversationId: api.conversationId, actionId: api.taskId
  }, ctx.abortSignal, 15000);
  const renderTool = (name, description, parameters) => defineTool({ name, description,
    replay: 'safe', parameters, execute: async (args, api, ctx) => {
      requireTab();
      if (name === 'show_chart' && (args.labels.length !== args.values.length || !args.values.every(Number.isFinite))) throw new Error('Chart labels and finite values must have equal length');
      if (name === 'show_chart') await api.commit(async tx => {
        (await tx.doc(Interactions, api.conversationId)).charts[api.taskId] = { id: api.taskId, ...args };
      }, ctx);
      return text(await run(name, args, api, ctx));
    } });
  const tools = [
    renderTool('open_pane', 'Open a conversation in the most recently focused tab. Pure UI action; safely repeatable.',
      Type.Object({ conversation: Type.Number() })),
    renderTool('highlight', 'Open this conversation and highlight a transcript entry in the focused tab. Safely repeatable.',
      Type.Object({ entry: Type.Number() })),
    renderTool('toast', 'Show a brief notification in the focused tab. Pure UI rendering; may reappear after recovery.',
      Type.Object({ text: Type.String() })),
    renderTool('set_theme', 'Set the focused tab theme: optional accent CSS color and dark/light mode. Pure UI action.',
      Type.Object({ accent: Type.Optional(Type.String()), mode: Type.Optional(Type.Union([Type.Literal('dark'), Type.Literal('light')])) })),
    renderTool('show_chart', 'Show a durable inline SVG bar chart in this conversation’s pane. Labels and finite values must have equal length.',
      Type.Object({ title: Type.String(), labels: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
        values: Type.Array(Type.Number(), { minItems: 1, maxItems: 20 }) })),
    defineTool({ name: 'ask_user', description: 'Ask for approval and wait for Approve/Reject plus an optional reason. The durable card and answer survive reload.',
      replay: 'safe', parameters: Type.Object({ text: Type.String() }), execute: async (args, api, ctx) => {
        requireTab();
        const card = await approval(args, 'ask_user', api, ctx);
        return text({ approved: card.status === 'approved', reason: card.answerReason || '' });
      } }),
    defineTool({ name: 'stage_run', description: 'Run a JavaScript function body in this pane’s opaque-origin sandbox stage. document and window refer to the stage, not the app. Return a value; console and errors are captured. Network access is blocked. Stage DOM is lost on reload. Not automatically replayed.',
      replay: 'unsafe', parameters: Type.Object({ code: Type.String() }), execute: async (args, api, ctx) => {
        requireTab();
        return text(await run('stage_run', args, api, ctx));
      } }),
    defineTool({ name: 'stage_reset', description: 'Replace this pane’s sandbox with a fresh empty stage. Mutating; not automatically replayed.',
      replay: 'unsafe', parameters: Type.Object({}), execute: async (args, api, ctx) => {
        requireTab(); return text(await run('stage_reset', args, api, ctx));
      } }),
    defineTool({ name: 'page_js', description: 'DANGER: run a JavaScript function body in the main app page, with the app’s privileges. Requires the user’s God mode toggle AND a separate per-call code approval. Return a value. Rejected/disabled requests do not run. Execution that began before a crash is never repeated automatically.',
      replay: 'safe', parameters: Type.Object({ code: Type.String(), reason: Type.String() }), execute: async (args, api, ctx) => {
        requireTab();
        const saved = (await api.snapshot(Interactions, api.conversationId, ctx))?.cards[api.taskId];
        if (saved?.status === 'done') return text(saved.result);
        if (saved?.status === 'executing') {
          const result = { error: 'Page JS execution was interrupted; not automatically replayed' };
          await api.commit(async tx => {
            const card = (await tx.doc(Interactions, api.conversationId)).cards[api.taskId];
            card.status = 'done'; card.result = result;
          }, ctx);
          return text(result);
        }
        if (!(await readGodMode())) return text({ disabled: true, message: 'disabled by user' });
        const card = await approval(args, 'page_js', api, ctx);
        if (card.status === 'rejected') return text({ rejected: true, reason: card.answerReason || 'Rejected by user' });
        if (!(await readGodMode())) return text({ disabled: true, message: 'disabled by user' });
        // Record before dispatch: a crash in the cross-tab round trip cannot execute the code twice.
        await api.commit(async tx => { (await tx.doc(Interactions, api.conversationId)).cards[api.taskId].status = 'executing'; }, ctx);
        let result;
        try { result = await run('page_js', args, api, ctx); }
        catch (error) { result = { error: String(error) }; }
        await api.commit(async tx => {
          const current = (await tx.doc(Interactions, api.conversationId)).cards[api.taskId];
          current.status = 'done'; current.result = result ?? null;
        }, ctx);
        return text(result);
      } })
  ];
  return defineExtension({ name: 'browser-frontend', tools });
}
