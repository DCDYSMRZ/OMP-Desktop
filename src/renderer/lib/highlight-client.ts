import type { ThemedToken } from 'shiki/core';
export interface HighlightClient { request(request: number, code: string, lang: string, theme: string): void; close(): void }
let worker: Worker | undefined;
let sequence = 0;
const listeners = new Map<number, (request: number, tokens: ThemedToken[][] | null) => void>();
export function createHighlightClient(receive: (request: number, tokens: ThemedToken[][] | null) => void): HighlightClient {
  if (!worker) {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => { const { id, request, tokens } = event.data; listeners.get(id)?.(request, tokens); };
  }
  const id = ++sequence;
  listeners.set(id, receive);
  return {
    request(request: number, code: string, lang: string, theme: string) { worker!.postMessage({ id, request, code, lang, theme }); },
    close() { listeners.delete(id); worker!.postMessage({ id, release: true }); },
  };
}
