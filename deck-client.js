const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
export const deckPrompt = `Start Deck studio, a generic slide-deck workflow. First use ask_form titled Deck brief with required topic string, audience string, tone enum [clear,bold,playful], and slideCount integer min 3 max 6 default 3, plus optional keyPoints array of strings. Wait for my submission. Then draft deck.slides.json as {title,tone,slides:[{title,body,bullets:[]}]}; the pane automatically renders this file with Prev/Next. Keep it generic, with no client data. Ask ask_user whether I approve publishing this draft. If rejected, honor the reason and do not publish. Only if approved, write deck.html as a self-contained navigable HTML slide deck with Previous/Next buttons, then call download_file with path deck.html to provide a download link. Do not use page_js. For later tone variants, inherit this brief and draft file, rewrite deck.slides.json in the requested tone, show it, and ask approval before each publication.`;
export function createDeckPanel(pane) {
  const panel = el('section'); panel.className = 'deck-panel'; panel.setAttribute('aria-label', 'Slide deck'); panel.hidden = true;
  const title = el('h3'), slide = el('article'), count = el('small'), actions = el('div'); actions.className = 'approval-actions';
  const prev = el('button', 'Previous slide'), next = el('button', 'Next slide');
  pane.deck = { panel, title, slide, count, prev, next, index: 0, source: '' };
  prev.onclick = () => { pane.deck.index--; paint(pane.deck); }; next.onclick = () => { pane.deck.index++; paint(pane.deck); };
  actions.append(prev, count, next); panel.append(title, slide, actions);
  pane.downloadPanel = el('section'); pane.downloadPanel.className = 'downloads'; pane.downloadLinks = new Map();
  return panel;
}
function paint(deck) {
  deck.index = Math.max(0, Math.min(deck.index, deck.data.slides.length - 1));
  const value = deck.data.slides[deck.index]; deck.title.textContent = deck.data.title + (deck.data.tone ? ' · ' + deck.data.tone : '');
  deck.slide.replaceChildren(el('h2', value.title || 'Slide ' + (deck.index + 1)));
  if (value.body) deck.slide.append(el('p', value.body));
  const list = el('ul'); for (const bullet of value.bullets || []) list.append(el('li', String(bullet))); deck.slide.append(list);
  deck.count.textContent = (deck.index + 1) + ' / ' + deck.data.slides.length; deck.prev.disabled = deck.index === 0; deck.next.disabled = deck.index === deck.data.slides.length - 1;
}
export function downloadFile(pane, args) {
  let link = pane.downloadLinks.get(args.path);
  if (link?.content === args.content) return;
  if (link) { URL.revokeObjectURL(link.url); link.anchor.remove(); }
  const url = URL.createObjectURL(new Blob([args.content], { type: args.path.endsWith('.html') ? 'text/html' : 'text/plain' }));
  const anchor = el('a', 'Download ' + args.path); anchor.href = url; anchor.download = args.path.split('/').at(-1); anchor.className = 'download-link';
  pane.downloadLinks.set(args.path, { anchor, url, content: args.content }); pane.downloadPanel.append(anchor);
}
export function renderDeck(pane, conversation) {
  const files = conversation.files?.files || {}, source = files['deck.slides.json'];
  pane.deck.panel.hidden = !source;
  if (source && pane.deck.source !== source) {
    pane.deck.source = source;
    try { const data = JSON.parse(source); if (!Array.isArray(data.slides) || !data.slides.length || !data.slides.every(x => x && typeof x === 'object')) throw new Error('Expected non-empty slides array'); pane.deck.data = data; paint(pane.deck); }
    catch (error) { pane.deck.slide.textContent = 'Deck JSON: ' + error.message; }
  }
  for (const { path } of Object.values(conversation.interactions?.downloads || {})) if (Object.hasOwn(files, path)) downloadFile(pane, { path, content: files[path] });
}
export function disposeDeck(pane) { for (const link of pane.downloadLinks.values()) URL.revokeObjectURL(link.url); }
