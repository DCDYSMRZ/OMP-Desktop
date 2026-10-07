import { formatCurrency } from '../lib/format-cost';
import type { NativeSubagent, SavedSubagentEdge, SavedSubagentNavigation } from '../../shared/contracts';
import type { ChatMessage } from '../chat/model';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { visibleAgentPhase, normalizeAgent, reconcileAgent, evidenceOf } from '../../shared/subagent-evidence';
import { nativeHarnessNotice } from '../../shared/native-harness-notice';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
export type SubagentPhase = 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown';
export function subagentPhase(agent: NativeSubagent): SubagentPhase {
  const phase = visibleAgentPhase(agent);
  return phase === 'queued' ? 'pending' : phase === 'stopped' ? 'aborted' : phase;
}
/** Runtime ownership grants observation; persisted phase alone never grants a live clock. */
export function subagentObservedLive(agent: NativeSubagent, observedLive: boolean): boolean {
  return observedLive && agent.historical !== true && agent.observationLost !== true;
}
export function subagentActive(agent: NativeSubagent, observedLive: boolean): boolean {
  const phase = subagentPhase(agent);
  return (subagentObservedLive(agent, observedLive) || evidenceOf(agent).observation === 'inferred') && (phase === 'running' || phase === 'pending');
}
/** Keep a whole-chip prefix, reserving the exact width of the remaining-count control. */
export function fittedSubagentCount(widths: readonly number[], overflowWidths: readonly number[], available: number, gap: number): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
  if (total <= available) return widths.length;
  let used = 0, count = 0;
  for (let visible = 0; visible < widths.length; visible++) {
    if (used + (visible ? gap : 0) + (overflowWidths[widths.length - visible - 1] ?? 0) <= available) count = visible;
    used += (visible ? gap : 0) + widths[visible]!;
    if (used > available) break;
  }
  return count;
}
/** Activity and attention are orthogonal: running never erases failure counts. */
export function aggregateSubagentPhase(phases: readonly SubagentPhase[]): SubagentPhase {
  for (const phase of ['running', 'failed', 'aborted', 'unknown', 'pending'] as const) if (phases.includes(phase)) return phase;
  return phases.length ? 'completed' : 'unknown';
}
export function subagentSummary(agents: readonly NativeSubagent[]) {
  const counts: Record<SubagentPhase, number> = { running: 0, pending: 0, completed: 0, failed: 0, aborted: 0, unknown: 0 };
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    counts[subagentPhase(agent)]++;
  }
  return { counts, total: seen.size, attention: counts.failed + counts.aborted + counts.unknown, phase: aggregateSubagentPhase(Object.keys(counts).filter(phase => counts[phase as SubagentPhase]) as SubagentPhase[]) };
}
export function flattenSubagentTree(nodes: readonly SubagentNode[]): NativeSubagent[] {
  const agents = new Map<string, NativeSubagent>();
  const visit = (items: readonly SubagentNode[]) => { for (const node of items) { agents.set(node.agent.id, node.agent); visit(node.children); } };
  visit(nodes);
  return [...agents.values()];
}
const firstLine = (value: unknown): string => string(value).trim().split(/\r?\n/, 1)[0];
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function subagentTitle(agent: NativeSubagent): string {
  const handle = [agent.nativeId, agent.id, agent.progress?.id].map(string).find(value => value && !/^(saved-|planned:)/.test(value));
  return handle?.split('.').at(-1) || string(agent.name) || string(agent.agent) || string(agent.progress?.agent);
}
/** Plain, meaningful task prose; headings and fenced examples are not briefs. */
export function subagentPreview(value: unknown, lines = 2): string {
  let fenced = false;
  const result: string[] = [];
  for (const raw of string(value).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced || /^\s*#{1,6}(?:\s|$)/.test(raw)) continue;
    const line = plainMarkdownLine(raw);
    if (line && !/^[-=]{3,}$/.test(line)) result.push(line);
    if (result.length === lines) break;
  }
  return result.join('\n');
}
export function subagentBrief(agent: NativeSubagent): string {
  const source = [agent.description, agent.assignment, agent.progress?.assignment, agent.task, agent.progress?.task].map(value => subagentPreview(value, 1)).find(Boolean) ?? '';
  const sentence = source.match(/^.*?(?:[。！？]|[.!?](?:\s|$))/)?.[0].trim() || source;
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}
function resultFieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
export interface SubagentOutcomeChip { key: string; label: string; value: string | true }
export interface SubagentResultSummary { text?: string; chips?: SubagentOutcomeChip[] }
const proseFields = ['summary', 'report', 'conclusion', 'message', 'finding', 'result'];
const outcomeIdentityFields: Record<string, true> = { agent: true, name: true, id: true, nativeid: true, agentid: true };
/** Shared visible metadata; the caller controls its display limit. */
export function subagentResultFields(value: unknown): SubagentOutcomeChip[] {
  const fields: SubagentOutcomeChip[] = [];
  for (const [key, item] of Object.entries(object(value))) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (outcomeIdentityFields[normalized] || proseFields.includes(key) || item === false || item == null || typeof item === 'object' && !Array.isArray(item)) continue;
    const value = item === true ? true : Array.isArray(item) ? item.filter(value => typeof value === 'string' || typeof value === 'number').join(', ') : subagentPreview(String(item), 1);
    if (value) fields.push({ key: normalized, label: resultFieldLabel(key), value });
  }
  return fields;
}
/** Human conclusions are shared by roster previews and the persistent child outcome. */
export function subagentResultSummary(value: unknown, lines = 3): SubagentResultSummary {
  let parsed = value;
  const source = string(value).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1').trim();
  if (typeof value === 'string' && /^[{[]/.test(source)) {
    try { parsed = JSON.parse(source); } catch {
      const fields = [...source.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)];
      const preferred = fields.find(([, key]) => /^(summary|report|result|conclusion|message|finding)$/i.test(key));
      if (preferred) return { text: subagentPreview(preferred[2], lines) };
      const status = fields.find(([, key]) => /status|correctness|verdict|outcome/i.test(key));
      return { text: status ? `${resultFieldLabel(status[1])}: ${status[2]}` : undefined };
    }
  }
  if (Array.isArray(parsed)) return { text: parsed.map(item => subagentResultSummary(item, 1).text).filter(Boolean).slice(0, lines).join('\n') || undefined };
  if (parsed && typeof parsed === 'object') {
    const result = object(parsed);
    let conclusion: SubagentResultSummary | undefined;
    for (const key of proseFields) {
      if (result[key] != null) { const candidate = subagentResultSummary(result[key], lines); if (candidate.text) { conclusion = candidate; break; } }
    }
    if (!conclusion && result.data && typeof result.data === 'object') conclusion = subagentResultSummary(result.data, lines);
    const fields = subagentResultFields(result);
    if (conclusion?.text) return { text: conclusion.text, chips: [...(conclusion.chips ?? []), ...fields].slice(0, 3) };
    const preferred = fields.filter(field => /status|correctness|verdict|outcome|success/i.test(field.key));
    return { text: (preferred.length ? preferred : fields).slice(0, lines).map(field => field.value === true ? field.label : `${field.label}: ${field.value}`).join('\n') || undefined };
  }
  return { text: subagentPreview(value, lines) || undefined };
}
export interface SubagentOutcome { phase: SubagentPhase; tone: 'completed' | 'issues' | 'failed' | 'aborted' | 'pending'; summary?: string; chips: SubagentOutcomeChip[]; issueCount: number; toolFailureCount: number; report?: unknown; reportRowId?: string }
/** Counts explicit evidence only; overlapping progress/result/history sources are not additive. */
export function subagentOutcome(agent: NativeSubagent, rows: readonly ChatMessage[] = [], result?: unknown): SubagentOutcome {
  const phase = subagentPhase(agent);
  let report: unknown = result ?? agent.output;
  let reportRowId: string | undefined;
  const failures = new Set<string>();
  for (const row of rows) {
    const raw = row.raw;
    if (raw.role === 'toolResult' && (raw.isError === true || object(raw.details).isError === true) && !nativeHarnessNotice(raw)) failures.add(string(raw.toolCallId) || row.id);
    if (raw.role !== 'assistant') continue;
    const blocks = Array.isArray(raw.content) ? raw.content.map(object) : [];
    const calls = blocks.filter(block => block.type === 'toolCall');
    const delivery = calls.find(block => /^(?:functions\.)?yield$/.test(string(block.name)) && !Array.isArray(object(block.arguments).type));
    const prose = typeof raw.content === 'string' ? raw.content : blocks.filter(block => block.type === 'text').map(block => string(block.text)).join('\n');
    if (delivery) { const args = object(delivery.arguments); const delivered = args.data ?? args.error ?? (prose.trim() || undefined); if (delivered !== undefined) { report = delivered; reportRowId = row.id; } }
    else if (!calls.length && prose.trim()) { report = prose; reportRowId = row.id; }
  }
  const counts: number[] = [0];
  for (const value of [agent, agent.progress, result, agent.output, report]) {
    let source = value;
    if (typeof source === 'string') { try { source = JSON.parse(source); } catch { continue; } }
    const data = object(source);
    for (const key of ['issueCount', 'errorCount']) { const count = finite(data[key]); if (count !== undefined) counts.push(Math.floor(count)); }
    for (const key of ['issues', 'errors']) if (Array.isArray(data[key])) counts.push(data[key].length);
  }
  const issueCount = Math.max(...counts);
  const resultSummary = subagentResultSummary(report);
  const summary = (phase === 'failed' || phase === 'aborted' ? subagentPreview(subagentError(agent), 3) : '') || resultSummary.text;
  const toolFailureCount = Math.max(failures.size, finite(agent.toolFailureCount) ?? 0, finite(agent.progress?.toolFailureCount) ?? 0);
  return { phase, tone: phase === 'completed' ? issueCount ? 'issues' : 'completed' : phase === 'failed' || phase === 'aborted' ? phase : 'pending', summary, chips: resultSummary.chips ?? [], issueCount, toolFailureCount, report, reportRowId };
}
export function formatSubagentCost(value: number): string { return formatCurrency(value); }
/** A fixed compact scale keeps roster and child-header counts comparable in every locale. */
const compactTokens = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export function formatSubagentTokens(value: number): string { return compactTokens.format(value); }
/** Blocking task batches carry their delivery on the tool result, not an async message. */
export function withTaskResults(nodes: SubagentNode[], results: unknown): SubagentNode[] {
  if (!Array.isArray(results)) return nodes;
  const rows = results.map(object);
  return nodes.map(node => {
    const matches = rows.filter(row => string(row.id) && [node.agent.id, node.agent.nativeId, string(node.agent.progress?.id)].includes(string(row.id)));
    const result = matches.length === 1 ? matches[0] : undefined;
    return { agent: result ? reconcileAgent(node.agent, normalizeAgent({ ...node.agent, ...result, id: node.agent.id }, { source: 'task', historical: node.agent.historical })) : node.agent, children: withTaskResults(node.children, results) };
  });
}
export interface SubagentMetrics { toolCount?: number; tokens?: number; cost?: number; durationMs?: number }
export function subagentMetrics(agent: NativeSubagent): SubagentMetrics {
  const phase = subagentPhase(agent);
  const terminal = phase === 'completed' || phase === 'failed' || phase === 'aborted';
  if (evidenceOf(agent).metricsSource === 'spawn') return {};
  return {
    toolCount: finite(agent.progress?.toolCount) ?? finite(agent.toolCount),
    tokens: finite(agent.progress?.tokens) ?? finite(agent.tokens),
    cost: finite(agent.progress?.cost) ?? finite(agent.cost),
    durationMs: terminal ? finite(agent.durationMs) ?? finite(agent.progress?.durationMs) : finite(agent.progress?.durationMs) ?? finite(agent.durationMs),
  };
}
/** Loaded history is a fallback, never a claim about unloaded pages. */
export function childHistoryMetrics(rows: ChatMessage[]): SubagentMetrics {
  let toolCount = 0, tokens = 0, cost = 0, hasTokens = false, hasCost = false;
  let first = Infinity, last = -Infinity;
  for (const { raw } of rows) {
    const timestamp = typeof raw.timestamp === 'string' ? finite(Date.parse(raw.timestamp)) : finite(raw.timestamp);
    if (timestamp !== undefined) { first = Math.min(first, timestamp); last = Math.max(last, timestamp); }
    if (raw.role === 'toolResult' && typeof raw.toolCallId === 'string') toolCount++;
    if (raw.role !== 'assistant') continue;
    const usage = object(raw.usage);
    const tokenParts = ['input', 'output', 'cacheWrite'].map(key => finite(usage[key]));
    hasTokens ||= tokenParts.some(value => value !== undefined);
    tokens += tokenParts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const measuredCost = finite(object(usage.cost).total) ?? finite(usage.cost);
    hasCost ||= measuredCost !== undefined;
    cost += measuredCost ?? 0;
  }
  return { toolCount: rows.length ? toolCount : undefined, tokens: hasTokens ? tokens : undefined, cost: hasCost ? cost : undefined, durationMs: Number.isFinite(first) && last > first ? last - first : undefined };
}
export function subagentActivity(agent: NativeSubagent): string | undefined {
  if (subagentPhase(agent) !== 'running') return undefined;
  const progress = agent.progress ?? agent;
  const intent = firstLine(progress.lastIntent);
  if (intent) return intent;
  const tool = string(progress.currentTool);
  if (!tool) return undefined;
  const args = progress.currentToolArgs;
  const preview = typeof args === 'string' ? firstLine(args) : Object.values(object(args)).filter(value => typeof value === 'string').map(firstLine).join(' · ');
  return preview ? `${tool} · ${preview.slice(0, 100)}` : tool;
}
export function subagentError(agent: NativeSubagent): string | undefined {
  return string(agent.error) || string(agent.abortReason) || string(agent.progress?.error) || string(agent.progress?.abortReason) || string(object(agent.progress?.retryFailure).errorMessage) || string(object(agent.retryFailure).errorMessage) || undefined;
}
export interface PlannedSubagent { index: number; name?: string; agent?: string; task?: string }
export function plannedSubagents(args: unknown): PlannedSubagent[] {
  const input = object(args);
  const tasks = 'tasks' in input ? input.tasks : [input];
  if (!Array.isArray(tasks) || !tasks.length) return [];
  if (tasks.some(value => { const task = object(value); return !string(task.task).trim() || ('agent' in task && !string(task.agent).trim()) || ('name' in task && typeof task.name !== 'string'); })) return [];
  return tasks.map((value, index) => {
    const task = object(value);
    return { index, name: string(task.name) || undefined, agent: string(task.agent) || undefined, task: string(task.task) };
  });
}
/** A terminal parent cannot leave an unspawned slot looking active. */
export function plannedSubagentPhase(toolStatus: string | undefined): SubagentPhase {
  if (!toolStatus || toolStatus === 'pending' || toolStatus === 'running' || toolStatus === 'started') return 'pending';
  if (toolStatus === 'complete' || toolStatus === 'completed' || toolStatus === 'interrupted' || toolStatus === 'aborted' || toolStatus === 'cancelled' || toolStatus === 'stopped') return 'aborted';
  if (toolStatus === 'error' || toolStatus === 'failed' || toolStatus === 'timed_out' || toolStatus === 'denied') return 'failed';
  return 'unknown';
}
const UNLINKED_SLOT = 'A child execution has not yet been uniquely linked to this declared task.';
/** A declared slot waits while its parent call is observed live; without live observation its execution stays unconfirmed. */
export function plannedSlotStatus(toolStatus: string | undefined, observedLive: boolean): { status: SubagentPhase; ownershipReason?: string } {
  const phase = plannedSubagentPhase(toolStatus);
  if (phase === 'pending' && observedLive) return { status: 'pending' };
  return { status: phase === 'pending' ? 'unknown' : phase, ownershipReason: UNLINKED_SLOT };
}

export function subagentIndex(agent: NativeSubagent): number | undefined {
  const value = finite(agent.index) ?? finite(agent.progress?.index);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}
export function groupSubagentsByToolCall(agents: NativeSubagent[], anchoredToolCallIds: ReadonlySet<string>): { byToolCall: Map<string, NativeSubagent[]>; orphans: NativeSubagent[]; resolvedTrees: SubagentNode[] } {
  const byToolCall = new Map<string, NativeSubagent[]>();
  const orphans: NativeSubagent[] = [];
  const resolvedTrees = subagentTree(agents);
  for (const { agent } of resolvedTrees) {
    const id = agent.parentToolCallId;
    if (!id || !anchoredToolCallIds.has(id)) { orphans.push(agent); continue; }
    const group = byToolCall.get(id);
    if (group) group.push(agent); else byToolCall.set(id, [agent]);
  }
  const compare = (a: NativeSubagent, b: NativeSubagent) => (subagentIndex(a) ?? Infinity) - (subagentIndex(b) ?? Infinity);
  for (const group of byToolCall.values()) group.sort(compare);
  orphans.sort(compare);
  return { byToolCall, orphans, resolvedTrees };
}

/** Metadata from authorized reads only; never retain transcript pages or grant source access. */
export function retainSavedNavigation(previous: readonly SavedSubagentNavigation[], navigation: SavedSubagentNavigation): SavedSubagentNavigation[] {
  const route = JSON.stringify(navigation.ancestry);
  const id = navigation.childAncestry.at(-1)?.subagentId;
  const next = previous.filter(item => JSON.stringify(item.ancestry) !== route || item.childAncestry.at(-1)?.subagentId !== id);
  // Keep the current ancestry chain ahead of unrelated cached disclosures.
  const parents = new Set(navigation.childAncestry.map((_, index) => JSON.stringify(navigation.childAncestry.slice(0, index + 1))));
  const chain = next.filter(item => parents.has(JSON.stringify(item.childAncestry)));
  const others = next.filter(item => !parents.has(JSON.stringify(item.childAncestry)));
  return [...others.slice(-(127 - chain.length)), ...chain, navigation];
}

export function projectSavedHierarchy(agents: NativeSubagent[], navigation: readonly SavedSubagentNavigation[]): NativeSubagent[] {
  if (!navigation.length) return agents;
  const reads = new Map(navigation.map(item => [JSON.stringify([item.ancestry, item.childAncestry.at(-1)?.subagentId]), item]));
  const visit = (agent: NativeSubagent, ancestry: SavedSubagentEdge[]): NativeSubagent => {
    const found = reads.get(JSON.stringify([ancestry, agent.savedId ?? agent.id]));
    if (!found || ancestry.length >= 63) return agent;
    return { ...agent, savedChildren: found.children.map(child => visit({ ...child, historical: true, savedAncestry: found.childAncestry }, found.childAncestry)) };
  };
  return agents.map(agent => visit(agent, []));
}
export interface SubagentNode { agent: NativeSubagent; children: SubagentNode[] }
function nestedAgents(agent: NativeSubagent): NativeSubagent[] {
  const progress = agent.progress ?? agent;
  const extracted = object(progress.extractedToolData);
  const details = [...(Array.isArray(extracted.task) ? extracted.task : []), progress.inflightTaskDetails].filter(Boolean);
  const children = new Map<string, NativeSubagent>();
  for (const raw of details) {
    const detail = object(raw);
    for (const item of Array.isArray(detail.progress) ? detail.progress : []) {
      const child = object(item); const id = string(child.id);
      if (id) children.set(id, normalizeAgent({ ...child, id, progress: child }, { source: 'progress', historical: agent.historical }));
    }
    for (const item of Array.isArray(detail.results) ? detail.results : []) {
      const child = object(item); const id = string(child.id);
      if (id) children.set(id, reconcileAgent(children.get(id), normalizeAgent({ ...child, id }, { source: 'task', historical: agent.historical })));
    }
  }
  return [...children.values()];
}
/** Nest only explicit native task details; dotted IDs do not prove ancestry. */
export function subagentTree(agents: NativeSubagent[]): SubagentNode[] {
  const live = new Map(agents.map(agent => [agent.id, agent]));
  const aliases = new Map<string, NativeSubagent | undefined>();
  for (const agent of agents) if (agent.nativeId) aliases.set(agent.nativeId, aliases.has(agent.nativeId) ? undefined : agent);
  for (const [id, agent] of aliases) if (agent && !live.has(id)) live.set(id, agent);
  const nested = new Set<string>();
  const visit = (agent: NativeSubagent, ancestors: Set<string>): SubagentNode => {
    const path = new Set(ancestors).add(agent.id);
    const parentPhase = subagentPhase(agent);
    const observationEnded = agent.observationLost === true || parentPhase === 'completed' || parentPhase === 'failed' || parentPhase === 'aborted';
    const explicit = nestedAgents(agent).map(child => live.get(child.id) ?? { ...child, historical: agent.historical });
    const saved = agent.savedChildren ?? [];
    // Saved IDs are source-specific; native aliases may repeat in unrelated journals.
    const explicitById = new Map(explicit.map(child => [child.id, child]));
    const explicitByNative = new Map<string, NativeSubagent | undefined>();
    const savedNativeCounts = new Map<string, number>();
    for (const child of explicit) { const id = child.nativeId ?? child.id; explicitByNative.set(id, explicitByNative.has(id) ? undefined : child); }
    for (const item of saved) if (item.nativeId) savedNativeCounts.set(item.nativeId, (savedNativeCounts.get(item.nativeId) ?? 0) + 1);
    const matched = new Set<string>();
    const discovered = saved.map(item => {
      const existing = explicitById.get(item.id) ?? (item.nativeId && savedNativeCounts.get(item.nativeId) === 1 ? explicitByNative.get(item.nativeId) : undefined);
      if (existing) matched.add(existing.id);
      return existing && existing.historical !== true ? { ...existing, savedChildren: item.savedChildren } : item;
    });
    const children = [...explicit.filter(child => !matched.has(child.id)), ...discovered].filter(child => !path.has(child.id)).map(child => {
      nested.add(child.id);
      const phase = subagentPhase(child);
      // A task-call progress snapshot is not an independently observed worker.
      // An authoritative roster child can outlive its parent, but embedded
      // nonterminal facts cannot keep clocks running after that observation ends.
      const authoritative = live.get(child.id);
      const independentlyObserved = authoritative && authoritative.historical !== true && authoritative.observationLost !== true;
      const unobserved = observationEnded && !independentlyObserved && (phase === 'running' || phase === 'pending' || phase === 'unknown');
      return visit(unobserved ? { ...child, observationLost: true, observationReason: agent.observationReason ?? 'Parent task observation ended; nested task status is last observed.' } : child, path);
    });
    return { agent, children };
  };
  const trees = agents.map(agent => visit(agent, new Set()));
  // Preserve disconnected cyclic components even when ordinary roots exist.
  const roots = trees.filter(node => !nested.has(node.agent.id));
  const reachable = new Set(flattenSubagentTree(roots).map(agent => agent.id));
  for (const tree of trees) if (!reachable.has(tree.agent.id)) {
    roots.push(tree);
    for (const agent of flattenSubagentTree([tree])) reachable.add(agent.id);
  }
  return roots;
}
/** Presentation only: the native alias survives a verified live/saved merge. */
export function subagentPresentationId(agent: NativeSubagent): string {
  return agent.historical === true ? agent.id : agent.nativeId ?? agent.id;
}

/** Merge only unique aliases inside the same authorized immediate-child context. */
export function mergeChildRoster(saved: readonly NativeSubagent[], live: readonly NativeSubagent[]): NativeSubagent[] {
  const used = new Set<NativeSubagent>();
  const savedCounts = new Map<string, number>();
  const liveAliases = new Map<string, NativeSubagent[]>();
  const liveIds = new Map(live.map(child => [child.id, child]));
  for (const child of saved) if (child.nativeId) savedCounts.set(child.nativeId, (savedCounts.get(child.nativeId) ?? 0) + 1);
  for (const child of live) {
    const alias = child.nativeId ?? child.id;
    const matches = liveAliases.get(alias);
    if (matches) matches.push(child); else liveAliases.set(alias, [child]);
  }
  const merged = saved.map(child => {
    const alias = child.nativeId;
    const exact = liveIds.get(child.id);
    const candidates = alias && savedCounts.get(alias) === 1 ? liveAliases.get(alias) ?? [] : [];
    const current = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!current || used.has(current) || (current.parentToolCallId && child.parentToolCallId && current.parentToolCallId !== child.parentToolCallId)) return child;
    used.add(current);
    return { ...reconcileAgent(current, child), id: current.id, historical: current.historical === true, nativeId: current.nativeId ?? current.id, savedId: child.savedId ?? child.id, savedAncestry: child.savedAncestry, savedChildren: child.savedChildren ?? current.savedChildren };
  });
  return [...merged, ...live.filter(child => !used.has(child))];
}
export interface SavedChildRecovery { subagentId: string; ancestry: SavedSubagentEdge[] }

/** A saved selector is recovery metadata, not a reason to pin an observed native child. */
export function childPanelTarget(agent: NativeSubagent, ancestry: SavedSubagentEdge[], roster: readonly NativeSubagent[], observedLive: boolean): { subagentId: string; savedSubagent?: NativeSubagent; savedAncestry?: SavedSubagentEdge[]; savedRecovery?: SavedChildRecovery } {
  const alias = agent.nativeId;
  const candidates = alias ? roster.filter(child => (child.nativeId ?? child.id) === alias) : [];
  const current = candidates.length === 1 ? candidates[0] : undefined;
  if (agent.historical !== true && current && subagentObservedLive(current, observedLive) && (!agent.parentToolCallId || !current.parentToolCallId || agent.parentToolCallId === current.parentToolCallId)) {
    return { subagentId: current.id, savedSubagent: undefined, savedAncestry: undefined, savedRecovery: { subagentId: agent.savedId ?? agent.id, ancestry } };
  }
  return { subagentId: agent.savedId ?? agent.id, savedSubagent: { ...agent, id: agent.savedId ?? agent.id, historical: true }, savedAncestry: ancestry, savedRecovery: undefined };
}
export function findSubagent(agents: NativeSubagent[], id: string): NativeSubagent | undefined {
  const aliases = new Map<string, NativeSubagent>();
  const visit = (nodes: SubagentNode[]): NativeSubagent | undefined => {
    for (const node of nodes) {
      if (node.agent.id === id || node.agent.savedId === id) return node.agent;
      if (node.agent.nativeId === id) aliases.set(node.agent.id, node.agent);
      const child = visit(node.children);
      if (child) return child;
    }
  };
  const exact = visit(subagentTree(agents));
  return exact ?? (aliases.size === 1 ? aliases.values().next().value : undefined);
}
