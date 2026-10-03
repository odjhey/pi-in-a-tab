import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineTask, defineTool, defineExtension } from '@earendil-works/pi-durable';
export const Reminders = defineDoc({ kind: 'tab.reminders', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ items: {} }) });
const finish = result => ({ status: 'terminal', outcome: { status: 'completed', result } });
const Reminder = defineTask({ name: 'tab.reminder', version: 1, initial: input => ({ phase: 'wait', dueAt: input.dueAt }), phases: {
  wait: async (task, runtime, ctx) => {
    await runtime.sleep(task.state.checkpoint.dueAt, ctx);
    const row = (await runtime.snapshot(Reminders, runtime.conversationId, ctx))?.items[task.input.key];
    if (row?.status === 'pending') {
      const lateSeconds = Math.max(0, (runtime.now() - row.dueAt) / 1000);
      const conversation = await runtime.conversation(runtime.conversationId, ctx);
      await conversation.submit({ type: 'input', content: `Self-reminder (${lateSeconds.toFixed(1)} seconds late): ${row.message}`, requestId: 'reminder:' + task.input.key, whenBusy: 'followUp' }, ctx);
      await runtime.commit(async tx => { const item = (await tx.doc(Reminders, runtime.conversationId)).items[task.input.key]; if (item.status === 'pending') { item.status = 'fired'; item.firedAt = runtime.now(); item.lateSeconds = lateSeconds; } return finish({ fired: true }); }, ctx);
    } else await runtime.commit(() => finish({ fired: false }), ctx);
  }
}, abort: async (_, runtime, ctx) => { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); } });
export const reminderTools = defineExtension({ name: 'browser-reminders', tasks: [Reminder], tools: [defineTool({ name: 'schedule_reminder', description: 'Schedule a durable self-reminder by delaySeconds OR atISO. When due it becomes a follow-up input for you to act on, including lateness. Closed browsers do not run; overdue reminders fire on reopen.', replay: 'safe', parameters: Type.Object({ delaySeconds: Type.Optional(Type.Number()), atISO: Type.Optional(Type.String()), message: Type.String() }), execute: async (args, api, ctx) => {
  if ((args.delaySeconds !== undefined) === (args.atISO !== undefined)) throw new Error('Supply exactly one of delaySeconds or atISO');
  const candidate = args.atISO !== undefined ? Date.parse(args.atISO) : Date.now() + args.delaySeconds * 1000;
  if (!Number.isFinite(candidate) || args.delaySeconds < 0) throw new Error('Invalid reminder deadline');
  const dueAt = await api.memo('deadline', candidate, ctx);
  await api.commit(async tx => { const doc = await tx.doc(Reminders, api.conversationId); if (!doc.items[api.taskId]) { const taskId = await tx.createTask(Reminder, { key: api.taskId, dueAt }, { ownership: { kind: 'conversation' }, background: true }); doc.items[api.taskId] = { id: api.taskId, taskId, dueAt, message: args.message, status: 'pending' }; } }, ctx);
  return { content: [{ type: 'text', text: JSON.stringify({ scheduled: true, dueAt, id: api.taskId }) }] };
} })] });
