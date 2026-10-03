import { createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { localModel } from './local-model.js';

export function createLocalProvider(requestTab) {
  function stream(model, context, options = {}) {
    const events = createAssistantMessageEventStream();
    void requestTab('local-generate', {
      model, context, options: { temperature: options.temperature, maxTokens: options.maxTokens }
    }, options.signal, 600000, event => events.push(event)).catch(error => {
      const reason = options.signal?.aborted ? 'aborted' : 'error';
      events.push({ type: 'error', reason, error: {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: reason, errorMessage: error.message, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      } });
    }).finally(() => events.end());
    return events;
  }
  return createProvider({
    id: localModel.provider, name: 'On-device WebGPU', models: [localModel],
    auth: { apiKey: { name: 'No credentials (on-device)', resolve: async () => ({ auth: {}, source: 'browser GPU' }),
      login: async () => { throw new Error('Local inference needs no model login'); } } },
    api: { stream, streamSimple: stream }
  });
}
