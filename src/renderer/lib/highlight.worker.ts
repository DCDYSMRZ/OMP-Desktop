import { loadHighlightLanguage, tokenizeIncremental, type LineCache } from './shiki';
const caches = new Map<number, LineCache>();
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; request: number; code?: string; lang?: string; theme?: string; release?: boolean }>) => {
  const message = event.data;
  queue = queue.then(async () => {
    if (message.release) { caches.delete(message.id); return; }
    try {
      await loadHighlightLanguage(message.lang!);
      const cache = tokenizeIncremental(caches.get(message.id) ?? null, message.code!, message.lang!, message.theme!);
      if (cache) caches.set(message.id, cache);
      self.postMessage({ id: message.id, request: message.request, tokens: cache?.tokens ?? null });
    } catch { self.postMessage({ id: message.id, request: message.request, tokens: null }); }
  });
};
