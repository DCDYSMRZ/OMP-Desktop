import type { NativeCommand, NativeModel } from '../../../shared/contracts';

export function commandSource(command: NativeCommand): string {
  const source = command.source?.toLowerCase() ?? 'builtin';
  return source === 'built-in' ? 'builtin' : source.startsWith('mcp') ? 'mcp' : source.startsWith('skill') ? 'skill' : source.startsWith('extension') ? 'extension' : source;
}

/** Prefixes outrank substring matches, which outrank ordered fuzzy matches. */
export function fuzzyRank(value: string, query: string): number {
  const text = value.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  if (text === needle) return 10000;
  if (text.startsWith(needle)) return 8000 - text.length;
  const substring = text.indexOf(needle);
  if (substring >= 0) return 6000 - substring - text.length;
  let cursor = 0; let gaps = 0;
  for (const char of needle) {
    const index = text.indexOf(char, cursor);
    if (index < 0) return -Infinity;
    gaps += index - cursor; cursor = index + 1;
  }
  return 3000 - gaps - text.length;
}

export function rankedCommands(commands: NativeCommand[], query: string, description: (command: NativeCommand) => string = command => command.description ?? ''): NativeCommand[] {
  const ranked = commands.map((command, index) => ({ command, index, score: Math.max(
    fuzzyRank(command.name, query),
    ...(command.aliases ?? []).map(alias => fuzzyRank(alias, query) - 10),
    fuzzyRank(description(command), query) - 1000,
    fuzzyRank(command.source ?? 'builtin', query) - 2000,
  ) })).filter(row => Number.isFinite(row.score)).sort((a, b) => b.score - a.score || a.index - b.index);
  // Keep each source contiguous; the best matching source leads the list.
  const groups = new Map<string, NativeCommand[]>();
  for (const { command } of ranked) {
    const source = commandSource(command);
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source)!.push(command);
  }
  return [...groups.values()].flat();
}

export function modelGroups(models: NativeModel[], selected?: NativeModel): [string, NativeModel[]][] {
  const groups = new Map<string, NativeModel[]>();
  for (const model of models) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider)!.push(model);
  }
  return [...groups].sort(([a], [b]) => Number(b === selected?.provider) - Number(a === selected?.provider)).map(([provider, rows]) => [provider, rows.slice().sort((a, b) => Number(b.id === selected?.id) - Number(a.id === selected?.id))]);
}

export function effectiveThinking(levels: string[], selected?: string, reasoning?: boolean): string | null {
  if (reasoning === false || !levels.length) return null;
  return selected || (levels.length === 1 ? levels[0] : null);
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

const hiddenFileReferences: Record<string, true> = { '.git': true, node_modules: true, '.DS_Store': true };

/** Infrastructure is quiet by default, but an explicit path remains discoverable. */
export function visibleFileReference(path: string, query: string): boolean {
  const requested = query.toLowerCase().split('/');
  return path.split('/').every(part => !Object.hasOwn(hiddenFileReferences, part) || requested.some(segment => segment.length > 0 && part.toLowerCase().startsWith(segment)));
}
