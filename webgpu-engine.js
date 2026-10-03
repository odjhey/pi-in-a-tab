import { CreateMLCEngine, prebuiltAppConfig } from '@mlc-ai/web-llm';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { LOCAL_MODEL_ID } from './local-model.js';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (content.some(part => part.type === 'image')) throw new Error('The local model supports text only');
  return content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

function chatMessages(context, availableTools) {
  const tools = availableTools.map(tool => ({ type: 'function', function: {
    name: tool.name, description: tool.description, parameters: tool.parameters
  }}));
  // WebLLM's tools field currently accepts only the much larger Hermes models.
  // Qwen's native chat-template protocol keeps this 1.5B model tool-capable.
  let system = getCurrentSystemPrompt(context.messages) || 'You are a helpful assistant.';
  if (tools.length) system += '\n\n# Tools\nYou may call a function to help with the user request.\n' +
    '<tools>\n' + tools.map(tool => JSON.stringify(tool)).join('\n') + '\n</tools>\n' +
    'For each function call, return a JSON object with function name and arguments within <tool_call></tool_call> XML tags:\n' +
    '<tool_call>\n{"name": "function_name", "arguments": {}}\n</tool_call>\n' +
    'Only call tools when needed. After a tool response, answer the user; never repeat a successful call.';
  const messages = [{ role: 'system', content: system }];
  for (const message of context.messages) {
    if (message.role === 'user') messages.push({ role: 'user', content: contentText(message.content) });
    else if (message.role === 'assistant') {
      const parts = message.content.map(part => part.type === 'toolCall'
        ? '<tool_call>\n' + JSON.stringify({ name: part.name, arguments: part.arguments }) + '\n</tool_call>'
        : part.type === 'text' ? part.text : '').filter(Boolean);
      messages.push({ role: 'assistant', content: parts.join('\n') });
    } else if (message.role === 'toolResult') {
      messages.push({ role: 'user', content: '<tool_response>\n' + JSON.stringify({
        name: message.toolName, error: message.isError, result: contentText(message.content)
      }) + '\n</tool_response>' });
    }
  }
  return messages;
}

export function createLocalStream(onStatus) {
  let loading;
  let queue = Promise.resolve();
  async function engine() {
    if (!loading) loading = (async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) throw new Error('WebGPU is unavailable in this browser. Use current Chrome on HTTPS or localhost with a supported GPU, or choose a server model.');
      if (!adapter.features.has('shader-f16')) throw new Error('This local model requires WebGPU shader-f16; choose a server model on this GPU.');
      const started = performance.now();
      const result = await CreateMLCEngine(LOCAL_MODEL_ID, {
        appConfig: { model_list: prebuiltAppConfig.model_list.filter(model => model.model_id === LOCAL_MODEL_ID), cacheBackend: 'cache' },
        initProgressCallback: report => onStatus({ phase: 'loading', text: report.text, progress: report.progress })
      });
      onStatus({ phase: 'ready', text: 'Local model ready', loadSeconds: (performance.now() - started) / 1000 });
      return result;
    })().catch(error => { loading = undefined; throw error; });
    return loading;
  }

  function stream(model, context, options = {}) {
    const events = createAssistantMessageEventStream();
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    const output = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    };
    void (async () => {
      let local;
      const abort = () => local?.interruptGenerate();
      try {
        onStatus({ phase: 'queued', text: 'Local generation queued (one GPU engine per browser owner)' });
        await previous;
        options.signal?.throwIfAborted();
        events.push({ type: 'start', partial: output });
        local = await engine();
        options.signal?.throwIfAborted();
        options.signal?.addEventListener('abort', abort, { once: true });
        onStatus({ phase: 'generating', text: 'Generating on your GPU · no server model calls' });
        const tools = getCurrentTools(context.messages);
        const chunks = await local.chat.completions.create({
          messages: chatMessages(context, tools), stream: true, stream_options: { include_usage: true },
          temperature: options.temperature ?? 0.2, max_tokens: Math.min(options.maxTokens || 512, 512)
        });
        let pending = '';
        let inTool = false;
        let textIndex = -1;
        let usage;
        let reason = 'stop';
        const emitText = delta => {
          if (!delta) return;
          if (textIndex === -1) {
            textIndex = output.content.push({ type: 'text', text: '' }) - 1;
            events.push({ type: 'text_start', contentIndex: textIndex, partial: output });
          }
          output.content[textIndex].text += delta;
          events.push({ type: 'text_delta', contentIndex: textIndex, delta, partial: output });
        };
        const endText = () => {
          if (textIndex === -1) return;
          events.push({ type: 'text_end', contentIndex: textIndex, content: output.content[textIndex].text, partial: output });
          textIndex = -1;
        };
        for await (const chunk of chunks) {
          options.signal?.throwIfAborted();
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices[0];
          if (choice?.finish_reason === 'length') reason = 'length';
          pending += choice?.delta.content || '';
          while (pending) {
            if (inTool) {
              const end = pending.indexOf('</tool_call>');
              if (end === -1) break;
              const call = JSON.parse(pending.slice(0, end).trim());
              if (!tools.some(tool => tool.name === call.name) || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
                throw new Error('Local model emitted an invalid or unknown tool call');
              }
              const toolCall = { type: 'toolCall', id: crypto.randomUUID(), name: call.name, arguments: call.arguments };
              const index = output.content.push(toolCall) - 1;
              events.push({ type: 'toolcall_start', contentIndex: index, partial: output });
              events.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(call.arguments), partial: output });
              events.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: output });
              pending = pending.slice(end + '</tool_call>'.length);
              inTool = false;
              continue;
            }
            const start = pending.indexOf('<tool_call>');
            if (start !== -1) {
              emitText(pending.slice(0, start));
              endText();
              pending = pending.slice(start + '<tool_call>'.length);
              inTool = true;
              continue;
            }
            // Hold only a potential split opening tag; ordinary text streams immediately.
            let held = 0;
            for (let n = 1; n < '<tool_call>'.length; n++) if (pending.endsWith('<tool_call>'.slice(0, n))) held = n;
            emitText(pending.slice(0, pending.length - held));
            pending = pending.slice(pending.length - held);
            break;
          }
        }
        options.signal?.throwIfAborted();
        if (inTool) throw new Error('Local model emitted an incomplete tool call; try a shorter request');
        emitText(pending);
        endText();
        if (usage) Object.assign(output.usage, { input: usage.prompt_tokens, output: usage.completion_tokens, totalTokens: usage.total_tokens });
        output.stopReason = output.content.some(part => part.type === 'toolCall') ? 'toolUse' : reason;
        onStatus({ phase: 'ready', text: 'Local generation complete', tokensPerSecond: usage?.extra?.decode_tokens_per_s, outputTokens: usage?.completion_tokens });
        events.push({ type: 'done', reason: output.stopReason, message: output });
      } catch (error) {
        output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = error.message;
        onStatus({ phase: 'error', text: error.message });
        events.push({ type: 'error', reason: output.stopReason, error: output });
      } finally {
        options.signal?.removeEventListener('abort', abort);
        release();
        events.end();
      }
    })();
    return events;
  }
  return stream;
}
