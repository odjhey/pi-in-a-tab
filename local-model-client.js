let engine;
const pending = new Map();

export function handleLocalModel(frame, owner) {
  if (frame.type === 'local-cancel') { engine?.postMessage(frame); return; }
  if (!engine) {
    engine = new Worker('/webgpu-worker.js', { type: 'module' });
    engine.onmessage = ({ data }) => {
      if (data.type === 'status') {
        for (const port of new Set(pending.values())) port.postMessage({ action: 'local-status', payload: data.status });
        return;
      }
      const port = pending.get(data.id);
      if (!port) return;
      if (data.type === 'event') port.postMessage({ action: 'tab-stream', id: data.id, payload: { event: data.event } });
      else if (data.type === 'done') {
        pending.delete(data.id);
        port.postMessage({ action: 'tab-result', id: data.id, payload: { error: data.error, result: null } });
      }
    };
    engine.onerror = event => {
      for (const [id, port] of pending) port.postMessage({ action: 'tab-result', id,
        payload: { error: event.message || 'Local GPU worker failed' } });
      pending.clear();
      engine.terminate();
      engine = undefined;
    };
  }
  pending.set(frame.id, owner.port);
  engine.postMessage(frame);
}

window.addEventListener('pagehide', () => { engine?.terminate(); pending.clear(); });
