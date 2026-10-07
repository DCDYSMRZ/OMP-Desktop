import type { RuntimeInfo } from '../../shared/contracts';
import type { ChatState } from './model';
import { plainMarkdownLine } from '../lib/markdown-plain';

/** A short prose preview, never a flattened code sample, fence language label or table row. */
export function sessionProseExcerpt(markdown: string): string {
  const paragraphs: string[] = [];
  const listLines: string[] = [];
  let paragraph: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const source of markdown.split(/\r?\n/)) {
    const line = source.replace(/^\s*(?:>\s*)+/, '');
    const marker = line.trimStart().match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    const boundary = !line.trim() || !!marker || /^\s{0,3}#{1,6}\s|^\s*(?:[-*_]\s*){3,}$|^\s*\|.*\|\s*$/.test(line);
    const list = /^\s*(?:[-*+] |\d+[.)] )/.test(line);
    if (boundary || list) {
      if (paragraph.length) { paragraphs.push(paragraph.join(' ')); paragraph = []; }
      if (marker) fence = { marker: marker[1][0], length: marker[1].length };
      if (!list) continue;
    }
    if (/^(?: {4}|\t)/.test(line)) continue;
    const text = plainMarkdownLine(line).replace(/\s+/g, ' ').trim();
    if (text) (list ? listLines : paragraph).push(text);
  }
  if (paragraph.length) paragraphs.push(paragraph.join(' '));
  const prose = paragraphs[0] || listLines[0] || '';
  const endings = [...prose.matchAll(/[。！？]|[.!?](?=\s|$)/g)];
  const excerpt = endings.length > 1 ? prose.slice(0, endings[1].index + 1) : prose;
  return excerpt.length > 240 ? `${excerpt.slice(0, 239).trimEnd()}…` : excerpt;
}

export type HomeSetupStep = 'installed' | 'workspace' | 'model';
export interface HomeReadiness { installed: boolean; model: boolean; workspace: boolean; missing: HomeSetupStep[]; complete: boolean }
export function deriveHomeReadiness(runtime: RuntimeInfo | undefined, cwd: string, chats: readonly ChatState[], startupError = ''): HomeReadiness {
  const installed = runtime?.available === true;
  const workspace = !!cwd.trim();
  const relevant = chats.filter(chat => chat.models.length > 0 || !!chat.state.model);
  const model = relevant.length > 0;
  // Unknown while connecting is not a missing prerequisite. No first-turn milestone.
  const missing: HomeSetupStep[] = [];
  if (runtime?.available === false) missing.push('installed');
  if (!workspace) missing.push('workspace');
  if (installed && workspace && (chats.length > 0 && !model || /no models? available|no usable models?|no api.?key|missing.*credentials|api.?key.*not found/i.test(startupError))) missing.push('model');
  return { installed, workspace, model, missing, complete: missing.length === 0 };
}

