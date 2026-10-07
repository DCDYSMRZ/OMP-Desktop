import type { MessageSearchHit } from '../../shared/contracts';
import { plainMarkdownLine } from '../lib/markdown-plain';

export const paletteScopes = ['all', 'sessions', 'messages', 'files', 'commands', 'settings', 'actions'] as const;
export type PaletteScope = typeof paletteScopes[number];
export type PaletteGroup = Exclude<PaletteScope, 'all'>;
export type MatchRange = [number, number];
/** Highlight coordinates always belong to the displayed text, never raw Markdown. */
export function cleanPaletteMessage(markdown: string, query: string): { text: string; ranges: MatchRange[] } {
  const text = markdown.split(/\r?\n/).filter(line => !/^\s*(?:`{3,}|~{3,})/.test(line)).map(plainMarkdownLine).join('\n').trim();
  const ranges: MatchRange[] = [];
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of text.matchAll(new RegExp(escaped, 'giu'))) ranges.push([match.index!, match.index! + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: MatchRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return { text, ranges: merged };
}

export interface PaletteMessageGroup { hit: MessageSearchHit; count: number; text: string; ranges: MatchRange[] }
/** Group only visually identical excerpts in the same journal; opening keeps the first native anchor. */
export function groupPaletteMessages(hits: readonly MessageSearchHit[], query: string): PaletteMessageGroup[] {
  const groups = new Map<string, PaletteMessageGroup>();
  for (const hit of hits) {
    const snippet = cleanPaletteMessage(hit.snippet, query);
    const key = JSON.stringify([hit.path, snippet.text.normalize('NFC').replace(/\s+/g, ' ').trim()]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { hit, count: 1, ...snippet });
  }
  return [...groups.values()];
}

export function paletteMessageTimestamp(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return;
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function parsePaletteQuery(input: string, scope: PaletteScope = 'all'): { query: string; scope: PaletteScope } {
  const value = input.trimStart();
  const prefix: Record<string, PaletteScope> = { '>': 'actions', '/': 'commands', '@': 'files', '#': 'messages' };
  return { query: (prefix[value[0]] ? value.slice(1) : value).trim(), scope: prefix[value[0]] ?? scope };
}
export function fuzzyMatch(text: string, query: string): { score: number; ranges: MatchRange[] } | null {
  const value = text.toLocaleLowerCase(), tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  let score = 0;
  const indices = new Set<number>();
  for (const token of tokens) {
    const exact = value.indexOf(token);
    if (exact >= 0) {
      score += 100 + (exact === 0 ? 40 : /[\s/_.-]/.test(value[exact - 1]) ? 20 : 0) - Math.min(exact, 40);
      for (let i = exact; i < exact + token.length; i++) indices.add(i);
      continue;
    }
    let at = 0, previous = -1;
    for (const char of token) {
      const index = value.indexOf(char, at);
      if (index < 0) return null;
      score += index === previous + 1 ? 8 : 2;
      for (let offset = 0; offset < char.length; offset++) indices.add(index + offset);
      previous = index + char.length - 1; at = index + char.length;
    }
  }
  const ranges: MatchRange[] = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] === index) last[1]++; else ranges.push([index, index + 1]);
  }
  return { score, ranges };
}
export interface RankablePaletteItem { id: string; group: PaletteGroup; title: string; detail: string; keywords?: string; matched?: boolean; currentProject?: boolean; updatedAt?: string }
export function rankPaletteItems<T extends RankablePaletteItem>(items: readonly T[], query: string, scope: PaletteScope): { item: T; titleRanges: MatchRange[]; detailRanges: MatchRange[]; score: number }[] {
  const unique = new Map<string, T>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()].flatMap(item => {
    if (scope !== 'all' && item.group !== scope) return [];
    const title = fuzzyMatch(item.title, query), detail = fuzzyMatch(item.detail, query);
    const combined = fuzzyMatch(`${item.title} ${item.detail} ${item.keywords ?? ''}`, query);
    if (!combined && !item.matched) return [];
    return [{ item, titleRanges: title?.ranges ?? [], detailRanges: detail?.ranges ?? [], score: Math.max(title ? title.score + 50 : 0, detail?.score ?? 0, combined?.score ?? 0) }];
  }).sort((a, b) => paletteScopes.indexOf(a.item.group) - paletteScopes.indexOf(b.item.group) || (!query.trim() && a.item.group === 'sessions' ? Number(!!b.item.currentProject) - Number(!!a.item.currentProject) || (Date.parse(b.item.updatedAt ?? '') || 0) - (Date.parse(a.item.updatedAt ?? '') || 0) : b.score - a.score) || a.item.id.localeCompare(b.item.id));
}
