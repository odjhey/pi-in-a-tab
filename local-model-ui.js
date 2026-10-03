export function showLocalModelStatus(status) {
  if (!status) return;
  let panel = document.getElementById('local-model-status');
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'local-model-status';
    panel.setAttribute('role', 'status');
    panel.style.cssText = 'padding:8px 14px;border-bottom:1px solid var(--line);font-size:12px;overflow-wrap:anywhere';
    document.getElementById('panes').before(panel);
  }
  panel.replaceChildren();
  const label = document.createElement('span');
  label.textContent = 'WebGPU · ' + status.text;
  if (status.phase === 'ready' && status.loadSeconds) label.textContent += ` · loaded in ${status.loadSeconds.toFixed(1)}s`;
  if (status.phase === 'ready' && status.tokensPerSecond) label.textContent += ` · ${status.tokensPerSecond.toFixed(1)} tokens/s`;
  panel.append(label);
  if (status.phase === 'loading') {
    const progress = document.createElement('progress');
    progress.max = 1;
    progress.value = status.progress || 0;
    progress.style.cssText = 'width:100%;display:block;margin-top:5px';
    progress.setAttribute('aria-label', 'Local model download and compilation');
    panel.append(progress);
  }
}
