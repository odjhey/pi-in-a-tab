import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

function proxyStream(userId, model, context, options = {}) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    try {
      const response = await fetch('/api/model', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, provider: model.provider, modelId: model.id, context, reasoning: options.reasoning }), signal: options.signal
      });
      if (!response.ok) throw new Error(await response.text());
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          if (line) stream.push(JSON.parse(line));
        }
      }
      stream.end();
    } catch (error) {
      stream.push({ type: 'error', reason: 'error', error: {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: 'error', errorMessage: error.message, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      }});
      stream.end();
    }
  })();
  return stream;
}

export function browserModels(catalog, userId) {
  const models = createModels();
  for (const providerId of new Set(catalog.map(model => model.provider))) {
    models.setProvider(createProvider({
      id: providerId, name: providerId,
      auth: { apiKey: { name: 'Same-origin proxy',
        resolve: async () => ({ auth: {}, source: 'local proxy' }),
        login: async () => { throw new Error('Use npm run login on the server'); }
      } },
      models: catalog.filter(model => model.provider === providerId),
      api: {
        stream: (model, context, options) => proxyStream(userId, model, context, options),
        streamSimple: (model, context, options) => proxyStream(userId, model, context, options)
      }
    }));
  }
  return models;
}
