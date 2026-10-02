(() => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const send = message => parent.postMessage(message, '*');
  let queue = Promise.resolve();

  // Bound output without relying on structured-clone support for arbitrary values.
  function serialize(value) {
    const seen = new WeakSet();
    let nodes = 0;
    let remaining = 64000;
    const text = value => {
      const string = String(value);
      const limit = Math.min(4000, remaining);
      remaining -= Math.min(string.length, limit);
      return string.length > limit ? string.slice(0, limit) + '[truncated]' : string;
    };
    function visit(value, depth) {
      if (++nodes > 1000 || remaining <= 0) return '[truncated]';
      if (value == null) return null;
      if (typeof value === 'string') return text(value);
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
      if (typeof value === 'bigint' || typeof value === 'symbol') return text(value);
      if (typeof value === 'function') return '[Function]';
      if (depth >= 8) return '[depth limit]';
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      let result;
      if (value instanceof Error) {
        result = { name: text(value.name), message: text(value.message), stack: text(value.stack || '') };
      } else if (Array.isArray(value)) {
        result = value.slice(0, 100).map(item => visit(item, depth + 1));
        if (value.length > 100) result.push('[truncated]');
      } else {
        result = Object.create(null);
        for (const key of Object.keys(value).slice(0, 100)) result[text(key)] = visit(value[key], depth + 1);
      }
      seen.delete(value);
      return result;
    }
    return visit(value, 0);
  }

  const errorText = value => {
    try { return String(value?.stack || value?.message || value).slice(0, 4000); }
    catch { return 'Unable to read thrown value'; }
  };

  async function run(code) {
    const logs = [];
    const errors = [];
    const original = window.console;
    const captured = Object.create(original);
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table']) {
      captured[level] = (...args) => {
        if (logs.length >= 50) return;
        try {
          logs.push({ level, text: args.map(value => typeof value === 'string'
            ? value.slice(0, 2000) : JSON.stringify(serialize(value))).join(' ').slice(0, 4000) });
        } catch (error) {
          logs.push({ level, text: errorText(error) });
        }
      };
    }
    const recordError = value => { if (errors.length < 20) errors.push(errorText(value)); };
    const onError = event => recordError(event.error || event.message);
    const onRejection = event => recordError(event.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    window.console = captured;
    let result = null;
    try {
      result = serialize(await new AsyncFunction('document', 'window', 'console', code)
        .call(window, document, window, captured));
    } catch (error) {
      recordError(error);
    } finally {
      window.console = original;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    }
    return { result, console: logs, errors };
  }

  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    const message = event.data;
    if (message?.type === 'stage-ping') {
      send({ type: 'stage-ready' });
    } else if (message?.type === 'stage-run' && typeof message.id === 'string' && typeof message.code === 'string') {
      queue = queue.then(async () => {
        const payload = await run(message.code);
        send({ type: 'stage-result', id: message.id, payload });
      });
    }
  });
  send({ type: 'stage-ready' });
})();
