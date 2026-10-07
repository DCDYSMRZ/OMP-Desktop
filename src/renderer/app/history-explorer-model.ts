import type { HistoryTreeNode, HistoryTreeSnapshot } from '../../shared/contracts';

export interface HistoryTurn {
  id: string; parentId: string | null; node: HistoryTreeNode; entries: HistoryTreeNode[];
  children: string[]; lane: number; depth: number;
}
export interface HistoryExplorerModel { turns: HistoryTurn[]; entryTurn: Map<string, string>; hiddenTechnical: number; laneCount: number }
export interface HistoryExplorerRow { id: string; node: HistoryTreeNode; turn: HistoryTurn; detail: boolean; parentRowId: string | null; lane: number; depth: number; matched: boolean }

export class HistoryTreeWindowError extends Error {
  constructor(readonly reason: 'revision' | 'cursor') { super(reason); }
}

/** Refresh the mounted range atomically; never publish a shorter tail while refilling it. */
export async function readHistoryTreeWindow(read: (before?: string) => Promise<HistoryTreeSnapshot>, oldestId: string | undefined, isCurrent: () => boolean): Promise<HistoryTreeSnapshot | undefined> {
  let tree = await read();
  if (!isCurrent()) return undefined;
  const seen = new Set(tree.nodes.map(node => node.id));
  const cursors = new Set<string>();
  while (oldestId && !seen.has(oldestId) && tree.hasMore) {
    const cursor = tree.nextBefore;
    if (!cursor || cursors.has(cursor)) throw new HistoryTreeWindowError('cursor');
    cursors.add(cursor);
    const page = await read(cursor);
    if (!isCurrent()) return undefined;
    if (page.revision !== tree.revision) throw new HistoryTreeWindowError('revision');
    if (page.hasMore && (!page.nextBefore || cursors.has(page.nextBefore))) throw new HistoryTreeWindowError('cursor');
    const earlier = page.nodes.filter(node => !seen.has(node.id));
    for (const node of earlier) seen.add(node.id);
    tree = { ...page, leafId: tree.leafId, nodes: [...earlier, ...tree.nodes], diagnostics: [...new Set([...tree.diagnostics, ...page.diagnostics])] };
  }
  return tree;
}

export function isTechnicalHistoryNode(node: HistoryTreeNode): boolean {
  return node.type !== 'message' || !['user', 'assistant', 'toolResult', 'tool'].includes(node.role ?? '');
}

/** Contract hidden metadata out of the graph, then fold only unbranched non-user chains.
 * Fork points always remain distinct, including forks inside an assistant turn.
 */
export function shapeHistoryTree(nodes: readonly HistoryTreeNode[], showTechnical = false): HistoryExplorerModel {
  const source = new Map(nodes.map(node => [node.id, node]));
  const visible = nodes.filter(node => showTechnical || !isTechnicalHistoryNode(node));
  const included = new Set(visible.map(node => node.id));
  const parents = new Map<string, string | null>();
  const children = new Map<string, HistoryTreeNode[]>();
  const roots: HistoryTreeNode[] = [];
  for (const node of visible) {
    let parent = node.parentId;
    const seen = new Set([node.id]);
    while (parent && !included.has(parent) && !seen.has(parent)) { seen.add(parent); parent = source.get(parent)?.parentId ?? null; }
    if (parent && seen.has(parent)) parent = null;
    parents.set(node.id, parent);
    if (parent && included.has(parent)) { const siblings = children.get(parent) ?? []; siblings.push(node); children.set(parent, siblings); }
    else roots.push(node);
  }
  const turns: HistoryTurn[] = [], entryTurn = new Map<string, string>(), visited = new Set<string>();
  let nextLane = 0;
  const visit = (root: HistoryTreeNode) => {
    const stack: { node: HistoryTreeNode; parent: HistoryTurn | null; lane: number }[] = [{ node: root, parent: null, lane: nextLane++ }];
    while (stack.length) {
      const { node, parent, lane } = stack.pop()!;
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      const siblings = children.get(parents.get(node.id) ?? '') ?? [];
      const fold = parent && node.role !== 'user' && siblings.length === 1;
      const turn: HistoryTurn = fold ? parent : { id: node.id, parentId: parent?.id ?? null, node, entries: [], children: [], lane, depth: parent ? parent.depth + 1 : 0 };
      if (fold) turn.entries.push(node);
      else { turns.push(turn); parent?.children.push(turn.id); }
      entryTurn.set(node.id, turn.id);
      const descendants = children.get(node.id) ?? [];
      const lanes = descendants.map((_, index) => index === 0 ? turn.lane : nextLane++);
      for (let index = descendants.length - 1; index >= 0; index--) stack.push({ node: descendants[index], parent: turn, lane: lanes[index] });
    }
  };
  roots.forEach(visit);
  // A malformed cycle must not make readable entries disappear.
  visible.forEach(node => { if (!visited.has(node.id)) visit(node); });
  // Hidden saved/runtime tips still mark the last visible ancestor.
  for (const node of nodes) if (!entryTurn.has(node.id)) {
    let parent = node.parentId; const seen = new Set([node.id]);
    while (parent && !seen.has(parent)) {
      seen.add(parent); const turn = entryTurn.get(parent);
      if (turn) { entryTurn.set(node.id, turn); break; }
      parent = source.get(parent)?.parentId ?? null;
    }
  }
  return { turns, entryTurn, hiddenTechnical: nodes.length - visible.length, laneCount: nextLane };
}

/** Filtering retains ancestry and reveals matching folded entries without changing manual folds. */
export function historyExplorerRows(model: HistoryExplorerModel, expanded: ReadonlySet<string>, query = ''): HistoryExplorerRow[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (node: HistoryTreeNode) => tokens.every(token => `${node.label ?? ''} ${node.preview} ${node.role ?? ''} ${node.type}`.toLocaleLowerCase().includes(token));
  const byId = new Map(model.turns.map(turn => [turn.id, turn]));
  const retained = new Set<string>();
  for (const turn of model.turns) if (!tokens.length || [turn.node, ...turn.entries].some(matches)) {
    let ancestor: HistoryTurn | undefined = turn;
    while (ancestor && !retained.has(ancestor.id)) { retained.add(ancestor.id); ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined; }
  }
  const rows: HistoryExplorerRow[] = [];
  for (const turn of model.turns) {
    if (!retained.has(turn.id)) continue;
    rows.push({ id: turn.id, node: turn.node, turn, detail: false, parentRowId: turn.parentId, lane: turn.lane, depth: turn.depth, matched: !!tokens.length && matches(turn.node) });
    if (expanded.has(turn.id) || tokens.length) for (const node of turn.entries) {
      if (tokens.length && !matches(node)) continue;
      rows.push({ id: node.id, node, turn, detail: true, parentRowId: turn.id, lane: turn.lane, depth: turn.depth + 1, matched: !!tokens.length && matches(node) });
    }
  }
  return rows;
}

export function historyNodeDate(timestamp: string, locale: string, now = Date.now()): { relative: string; exact: string } | null {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return null;
  const seconds = (value - now) / 1000;
  const [unit, size]: [Intl.RelativeTimeFormatUnit, number] = Math.abs(seconds) < 60 ? ['second', 1] : Math.abs(seconds) < 3600 ? ['minute', 60] : Math.abs(seconds) < 86400 ? ['hour', 3600] : Math.abs(seconds) < 604800 ? ['day', 86400] : Math.abs(seconds) < 2629800 ? ['week', 604800] : Math.abs(seconds) < 31557600 ? ['month', 2629800] : ['year', 31557600];
  return { relative: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(seconds / size), unit), exact: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'medium' }).format(value) };
}
