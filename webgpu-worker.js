import { createLocalStream } from './webgpu-engine.js';

const active = new Map();
const stream = createLocalStream(status => self.postMessage({ type: 'status', status }));
self.onmessage = async ({ data: frame }) => {
  if (frame.type === 'local-cancel') { active.get(frame.id)?.abort(); return; }
  const controller = new AbortController();
  active.set(frame.id, controller);
  try {
    for await (const event of stream(frame.model, frame.context, { ...frame.options, signal: controller.signal })) {
      self.postMessage({ type: 'event', id: frame.id, event });
    }
    self.postMessage({ type: 'done', id: frame.id });
  } catch (error) {
    self.postMessage({ type: 'done', id: frame.id, error: error.message });
  } finally { active.delete(frame.id); }
};
