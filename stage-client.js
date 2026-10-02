const timeoutMs = 10000;

export function createStage(container) {
  let iframe;
  let ready = false;
  let disposed = false;
  let nextId = 0;
  const pending = new Map();

  function rejectPending(message) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
  }

  function send(request) {
    if (request.code === undefined) {
      finish(request.id, undefined, { reset: true });
    } else if (!request.sent) {
      request.sent = true;
      // The sandbox has an opaque origin, so '*' is required in this direction.
      iframe.contentWindow.postMessage({ type: 'stage-run', id: request.id, code: request.code }, '*');
    }
  }

  function finish(id, error, payload) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(payload);
  }

  function onMessage(event) {
    if (disposed || event.source !== iframe?.contentWindow) return;
    const message = event.data;
    if (message?.type === 'stage-ready') {
      ready = true;
      for (const request of pending.values()) send(request);
    } else if (message?.type === 'stage-result' && typeof message.id === 'string') {
      const payload = message.payload;
      if (!payload || !Object.hasOwn(payload, 'result') || !Array.isArray(payload.console) || !Array.isArray(payload.errors)) {
        finish(message.id, new Error('Invalid stage response'));
      } else {
        finish(message.id, undefined, payload);
      }
    }
  }

  function mount() {
    ready = false;
    iframe = document.createElement('iframe');
    iframe.className = 'stage-frame';
    iframe.title = 'Sandbox stage';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.cssText = 'width:100%;height:320px;border:0;display:block';
    iframe.addEventListener('load', () => {
      if (!disposed) iframe.contentWindow.postMessage({ type: 'stage-ping' }, '*');
    });
    iframe.src = '/stage.html';
    container.append(iframe);
  }

  function request(code) {
    if (disposed) return Promise.reject(new Error('Stage disposed'));
    const id = `stage-${++nextId}`;
    return new Promise((resolve, reject) => {
      const entry = { id, code, resolve, reject, sent: false,
        timer: setTimeout(() => finish(id, new Error('Stage timed out after 10 seconds; reset the stage to stop outstanding code')), timeoutMs) };
      pending.set(id, entry);
      if (ready) send(entry);
    });
  }

  window.addEventListener('message', onMessage);
  mount();
  return {
    run(code) {
      if (typeof code !== 'string') return Promise.reject(new TypeError('Stage code must be a string'));
      return request(code);
    },
    reset() {
      if (disposed) return Promise.reject(new Error('Stage disposed'));
      rejectPending('Stage reset before execution completed');
      iframe.remove();
      mount();
      return request();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rejectPending('Stage disposed');
      window.removeEventListener('message', onMessage);
      iframe.remove();
    }
  };
}
