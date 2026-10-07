import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChildHistoryRead, HistoryTranscriptPage, NativeSubagent, ObservedActivity, SavedSubagentEdge, SavedSubagentPage, SessionParentResolution, SessionResourcePage, SessionSummary } from '../../shared/contracts';
import type { NativeAsyncDeliveryJob } from '../../shared/native-task-results';
import { record } from './io';
import { HistoryReader, HistoryRevisionChangedError } from './journal';
import { ChildEvidenceReader } from './subagent-evidence';
import { normalizeAgent, jobEvidence, evidenceOf, evidenceTime, reconcileAgent, terminalPhase, inferChildActivity } from '../../shared/subagent-evidence';

const PAGE_BYTES = 64 * 1024;
const SCAN_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 20000;
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown, limit = 4096): string | undefined => typeof value === 'string' ? value.slice(0, limit) : undefined;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string): Record<string, unknown> {
  if (value.length > 4096) throw new Error('Resource cursor is too large');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new Error('Invalid resource cursor'); }
  if (!record(parsed)) throw new Error('Invalid resource cursor');
  return parsed;
}
function diagnostic(items: string[], message: string): void { if (items.length < 100 && !items.includes(message)) items.push(message); }
interface Child { metadata: NativeSubagent; sourceName?: string; age: number }
interface Discovery { children: Child[]; parent: HistoryTranscriptPage; roots: string[]; blobs: string; diagnostics: string[]; complete: boolean }
interface Selection { id: string; ranges: [number, number][]; region?: number; tailLines?: number }
function selection(reference: string): Selection {
  const match = /^artifact:\/\/(\d+)((?::[^\s()]+)*)(?:\s*\(region (\d+)\))?$/.exec(reference);
  if (!match) throw new Error('Expected a native artifact://numeric-id reference, optionally with line selectors or (region N)');
  const ranges: [number, number][] = [];
  let tailLines: number | undefined;
  for (const selector of match[2]!.split(':').filter(Boolean)) {
    if (selector === 'raw') continue;
    if (ranges.length || tailLines !== undefined) throw new Error('Only one line selector is supported per artifact reference');
    if (/^-\d+$/.test(selector)) {
      tailLines = Number(selector.slice(1));
      if (!Number.isSafeInteger(tailLines) || tailLines < 1) throw new Error('Invalid native tail line count');
      continue;
    }
    for (const part of selector.split(',')) {
      const range = /^(\d+)(?:(-)(\d*)|\+(\d+))?$/.exec(part);
      if (!range) throw new Error('Use positive native line selectors N, N-M, N-, or N+count');
      const start = Number(range[1]);
      const end = range[2] ? (range[3] ? Number(range[3]) : Number.MAX_SAFE_INTEGER) : range[4] ? start + Number(range[4]) - 1 : start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || ranges.length >= 64) throw new Error('Invalid or excessive artifact line range');
      ranges.push([start, end]);
    }
  }
  const region = match[3] === undefined ? undefined : Number(match[3]);
  if (region !== undefined && (!Number.isSafeInteger(region) || region < 1)) throw new Error('Invalid recovery region');
  if (tailLines !== undefined && region !== undefined) throw new Error('Read a recovery region or a tail selector separately');
  return { id: match[1]!, ranges, region, tailLines };
}

interface AgentSelection { id: string; segments: string[] }
function agentSelection(reference: string): AgentSelection {
  const match = /^agent:\/\/([^/]+)(?:\/(.*))?$/.exec(reference);
  if (!match || !SAFE_NAME.test(match[1]!) || match[1] === 'all') throw new Error('Expected an individual native agent://task-id output reference');
  const segments = (match[2] ?? '').split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { throw new Error('Invalid agent output JSON-path encoding'); }
  });
  if (segments.length > 128) throw new Error('Agent output JSON path exceeds the 128-segment bound');
  return { id: match[1]!, segments };
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Read-only resources for authorized parents, including owned runtimes; persisted paths never grant filesystem authority. */
export class SessionResources {
  private readonly childEvidence = new ChildEvidenceReader();
  private readonly completedDiscoveries = new Map<string, Discovery>();
  constructor(private readonly reader: HistoryReader, private readonly blobsRoot: (parentPath: string) => Promise<string>, private readonly observeParent?: (path: string, leafId: string | null) => ObservedActivity | undefined | Promise<ObservedActivity | undefined>) {}

  /** Main-only: the caller has already authorized this parent and selected branch. */
  async readEvidenceParent(options: { path: string; leafId?: string | null; before?: string }): Promise<HistoryTranscriptPage> {
    return this.reader.readEvidence(options);
  }

  async resolveParentSession(options: { path: string; sources: readonly SessionSummary[] }): Promise<SessionParentResolution> {
    const current = (await this.reader.resourceContext(options.path)).session;
    const parentSession = current.parentSession;
    if (!parentSession) return { status: 'none', reason: 'This native source records no parent session.' };
    const candidates = options.sources.filter(source => source.id === parentSession || source.path === parentSession || source.previousSessionFiles?.includes(parentSession));
    const matches = new Map<string, SessionSummary>();
    const diagnostics: string[] = [];
    for (const candidate of candidates) {
      try {
        const path = await realpath(candidate.path);
        if (path === await realpath(options.path)) continue;
        const context = await this.reader.resourceContext(candidate.path);
        if (context.session.id !== candidate.id) { diagnostics.push('A listed source changed its native identity.'); continue; }
        if (context.session.id === parentSession || candidate.path === parentSession || context.session.previousSessionFiles?.includes(parentSession)) matches.set(path, context.session);
      } catch (error) { diagnostics.push(errorText(error)); }
    }
    if (matches.size > 1 || (matches.size && diagnostics.length)) return { status: 'ambiguous', parentSession, reason: 'Multiple or unverifiable listed sources match the recorded parent; no parent was selected.' };
    if (!matches.size) return { status: 'missing', parentSession, reason: `The recorded parent is not uniquely readable among already listed or granted sources.${diagnostics.length ? ` ${diagnostics.join(' ')}` : ''}` };
    return { status: 'resolved', parentSession, session: [...matches.values()][0]! };
  }

  private async runtimeChild(parentPath: string, childPath: string, subagentId: string): Promise<{ path: string; roots: string[]; diagnostics: string[] }> {
    if (!SAFE_NAME.test(subagentId) || ![`${subagentId}.jsonl`, `${subagentId}.jsonl.gz`].includes(basename(childPath))) throw new Error('Runtime child source does not match its native identity');
    const context = await this.reader.resourceContext(parentPath);
    const diagnostics = [...context.diagnostics];
    const roots = await this.safeRoots(context.artifactRoots, diagnostics);
    const path = join(await realpath(dirname(childPath)), basename(childPath));
    if (!roots.some(root => contained(root, path)) || await realpath(path) !== path) throw new Error('Runtime child source escapes the authorized parent artifact roots');
    const file = await open(path, FLAGS);
    try { if (!(await file.stat()).isFile()) throw new Error('Runtime child source is not a regular file'); }
    finally { await file.close(); }
    return { path, roots, diagnostics };
  }

  async readRuntimeSubagent(options: { parentPath: string; childPath: string; subagentId: string } & ChildHistoryRead): Promise<HistoryTranscriptPage> {
    this.validateChildReading(options);
    const child = await this.runtimeChild(options.parentPath, options.childPath, options.subagentId);
    const binding = digest(JSON.stringify([resolve(options.parentPath), child.path, options.subagentId]));
    let before: string | undefined;
    let leafId: string | null | undefined = options.childLeafId;
    if (options.before) {
      const cursor = decode(options.before);
      if (cursor.binding !== binding || typeof cursor.before !== 'string' || !(cursor.leaf === null || typeof cursor.leaf === 'string')) throw new Error('Runtime child cursor belongs to another native source');
      before = cursor.before; leafId = cursor.leaf;
    }
    const page = await this.reader.read({ path: child.path, before, leafId, beforeEntryId: options.beforeEntryId }, await this.blobsRoot(options.parentPath));
    if (options.childRevision !== undefined && page.revision !== options.childRevision) throw new Error('Child reading anchor is stale; reload the latest page');
    return { ...page, session: { ...page.session, writable: false, canFork: false }, diagnostics: [...child.diagnostics, ...page.diagnostics], ...(page.nextBefore ? { nextBefore: encode({ binding, before: page.nextBefore, leaf: page.selectedLeafId }) } : {}) };
  }

  private validateChildReading(options: ChildHistoryRead): void {
    if (options.before !== undefined && (options.beforeEntryId !== undefined || options.childLeafId !== undefined || options.childRevision !== undefined)) throw new Error('Select one child cursor or bound reading selection');
    if (options.beforeEntryId !== undefined && (typeof options.beforeEntryId !== 'string' || !options.beforeEntryId || options.beforeEntryId.length > 4096)) throw new Error('Invalid child entry anchor');
    if (options.beforeEntryId === undefined && options.childLeafId === undefined && options.childRevision === undefined) return;
    if (typeof options.childRevision !== 'string' || !options.childRevision || options.childRevision.length > 1024 || !(options.childLeafId === null || typeof options.childLeafId === 'string' && options.childLeafId.length <= 512)) throw new Error('Child reading selection requires its selected branch and revision');
  }

  async readRuntimeArtifact(options: { parentPath: string; childPath?: string; reference: string; cursor?: string; subagentId?: string; nativeSubagents?: readonly NativeSubagent[]; leafId?: string | null }): Promise<SessionResourcePage> {
    if (options.reference.length > 4096) throw new Error('Resource reference is too large');
    if (options.reference.startsWith('desktop-image:') && options.cursor) throw new Error('Saved images do not have a text cursor');
    const child = options.childPath && options.subagentId ? await this.runtimeChild(options.parentPath, options.childPath, options.subagentId) : undefined;
    if (options.childPath && !child) throw new Error('Runtime child resource requires its native identity');
    if (options.reference.startsWith('agent://')) return this.readAgentOutput(options, options.nativeSubagents);
    if (child && (options.reference.startsWith('desktop-image:') || options.reference.startsWith('desktop-entry:'))) {
      const page = options.reference.startsWith('desktop-image:')
        ? await this.reader.imageDetail({ path: child.path, reference: options.reference }, await this.blobsRoot(options.parentPath))
        : await this.readEntryReference(child.path, options.reference, options.cursor);
      return { ...page, diagnostics: [...child.diagnostics, ...page.diagnostics] };
    }
    return this.readSessionArtifact({ parentPath: options.parentPath, reference: options.reference, cursor: options.cursor });
  }

  private readEntryReference(path: string, reference: string, cursor?: string): Promise<SessionResourcePage> {
    const encoded = reference.slice('desktop-entry:'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid saved entry reference');
    return this.readSessionEntry({ parentPath: path, entryId: Buffer.from(encoded, 'base64url').toString('utf8'), cursor });
  }

  async listHistorySubagents(options: { path: string; leafId?: string | null }): Promise<{ subagents: NativeSubagent[]; diagnostics: string[] }> {
    const found = await this.discover(options);
    return { subagents: found.children.map(child => child.metadata), diagnostics: found.diagnostics };
  }

  /** Internal accounting only: paths stay in main and retain the existing saved-child authority checks. */
  async resolveUsageChildren(options: { path: string; leafId?: string | null; toolCallIds: string[]; taskEntries?: { toolCallId: string; entryId: string }[] }): Promise<{ children: { path: string; toolCallId: string }[]; unrecorded: number }> {
    const wanted = new Set(options.toolCallIds);
    const found = await this.discover({ path: options.path, leafId: options.leafId });
    const children: { path: string; toolCallId: string }[] = [];
    let unrecorded = 0;
    const handled = new Set<string>();
    const collect = async (discovery: Discovery, only?: string) => {
      for (const child of discovery.children) {
        const call = child.metadata.parentToolCallId;
        if (!call || !wanted.has(call) || only && call !== only || handled.has(child.metadata.id)) continue;
        handled.add(child.metadata.id);
        try {
          const source = await this.childSource(discovery, child, new Set([await realpath(options.path)]));
          children.push({ path: source.path, toolCallId: call });
        } catch { unrecorded++; }
      }
    };
    await collect(found);
    // Whole-session spend includes abandoned branches, unlike the selected context anchor.
    for (const task of options.taskEntries ?? []) {
      if (!wanted.has(task.toolCallId) || found.children.some(child => child.metadata.parentToolCallId === task.toolCallId)) continue;
      try { await collect(await this.discover({ path: options.path, leafId: task.entryId }), task.toolCallId); } catch { /* The reader counts unresolved task children below. */ }
    }
    return { children, unrecorded };
  }

  private async childSource(found: Discovery, child: Child, visited: Set<string>): Promise<{ path: string; roots: string[] }> {
    if (!found.complete) throw new Error(`Saved task ancestry cannot be verified completely: ${found.diagnostics.join(' ')}`);
    if (!child.sourceName) throw new Error('Saved task metadata is available, but no native child journal identity was persisted.');
    if (found.children.filter(item => item.sourceName === child.sourceName).length !== 1) throw new Error('Saved child journal identity is ambiguous across persisted task edges');
    const paths = await this.findFiles(found.roots, name => name === `${child.sourceName}.jsonl` || name === `${child.sourceName}.jsonl.gz`, found.diagnostics);
    if (paths.length !== 1) throw new Error(paths.length ? 'Child journal is ambiguous across parent artifact roots' : 'Child journal is unavailable; saved task metadata has been retained.');
    const path = paths[0]!;
    if (visited.has(path)) throw new Error('Saved task ancestry contains a journal cycle');
    visited.add(path);
    const childRoots = await this.safeRoots([path.replace(/\.jsonl(?:\.gz)?$/, '')], found.diagnostics);
    return { path, roots: [...new Set([...found.roots, ...childRoots])] };
  }

  private async savedSelection(options: { parentPath: string; leafId?: string | null; ancestry?: SavedSubagentEdge[] }) {
    const ancestry = options.ancestry ?? [];
    if (!Array.isArray(ancestry)) throw new Error('Invalid saved task ancestry');
    let found = await this.discover({ path: options.parentPath, leafId: options.leafId });
    const root = found.parent;
    const visited = new Set<string>([await realpath(options.parentPath)]);
    const ancestors: NativeSubagent[] = [];
    for (const edge of ancestry) {
      if (!record(edge) || typeof edge.subagentId !== 'string' || typeof edge.revision !== 'string' || !(edge.leafId === null || typeof edge.leafId === 'string')) throw new Error('Invalid saved task ancestry selector');
      const child = found.children.find(item => item.metadata.id === edge.subagentId);
      if (!child) throw new Error('Saved child does not belong to the selected parent task ancestry');
      const source = await this.childSource(found, child, visited);
      const nested = await this.discover({ path: source.path, leafId: edge.leafId }, { roots: source.roots, blobs: found.blobs });
      if (nested.parent.revision !== edge.revision || nested.parent.selectedLeafId !== edge.leafId) throw new Error('Saved task selected branch changed; reopen it from its parent');
      nested.diagnostics = [...found.diagnostics, ...nested.diagnostics];
      ancestors.push(child.metadata);
      found = nested;
    }
    return { found, root, visited, ancestors, ancestry };
  }

  async readHistorySubagent(options: { parentPath: string; subagentId: string; leafId?: string | null; ancestry?: SavedSubagentEdge[] } & ChildHistoryRead): Promise<SavedSubagentPage> {
    this.validateChildReading(options);
    const { found, root, visited, ancestors, ancestry } = await this.savedSelection(options);
    const child = found.children.find(item => item.metadata.id === options.subagentId);
    if (!child) throw new Error('Saved child does not belong to the selected parent task ancestry');
    const binding = digest(JSON.stringify([resolve(options.parentPath), root.revision, root.selectedLeafId, ancestry, child.metadata.id]));
    let before: string | undefined;
    let leafId: string | null | undefined = options.childLeafId;
    if (options.before) {
      const cursor = decode(options.before);
      if (cursor.binding !== binding || typeof cursor.before !== 'string' || !(cursor.leaf === null || typeof cursor.leaf === 'string')) throw new Error('Saved child cursor is stale or belongs to another parent task');
      before = cursor.before; leafId = cursor.leaf;
    }
    let source: { path: string; roots: string[] };
    try { source = await this.childSource(found, child, visited); }
    catch (error) {
      if (options.before || options.beforeEntryId !== undefined || options.childRevision !== undefined || ancestry.length) throw error;
      return { session: { ...found.parent.session, id: child.metadata.id, title: child.metadata.description || child.metadata.agent || 'Saved child', writable: false, canFork: false }, revision: found.parent.revision, leafId: null, selectedLeafId: null, messages: [], hasMore: false, diagnostics: [...found.diagnostics, errorText(error)] };
    }
    const nested = await this.discover({ path: source.path, leafId }, { roots: source.roots, blobs: found.blobs });
    if (options.childRevision !== undefined && nested.parent.revision !== options.childRevision) throw new Error('Child reading anchor is stale; reload the latest page');
    const page = before || options.beforeEntryId !== undefined ? await this.reader.read({ path: source.path, leafId: nested.parent.selectedLeafId, before, beforeEntryId: options.beforeEntryId }, found.blobs) : nested.parent;
    if (page.revision !== nested.parent.revision) throw new Error('Saved task selected branch changed while reading');
    return { ...page, session: { ...page.session, writable: false, canFork: false }, diagnostics: [...found.diagnostics, ...nested.diagnostics, ...page.diagnostics], navigation: { ancestry, ancestors, children: nested.children.map(item => item.metadata), childAncestry: [...ancestry, { subagentId: child.metadata.id, leafId: page.selectedLeafId, revision: page.revision }] }, ...(page.nextBefore ? { nextBefore: encode({ binding, leaf: page.selectedLeafId, before: page.nextBefore }) } : {}) };
  }

  readSessionEntry(options: { parentPath: string; entryId: string; cursor?: string }): Promise<SessionResourcePage> {
    return this.reader.entryDetail({ path: options.parentPath, entryId: options.entryId, cursor: options.cursor });
  }

  async readSessionArtifact(options: { parentPath: string; reference: string; cursor?: string; subagentId?: string; leafId?: string | null; ancestry?: SavedSubagentEdge[] }): Promise<SessionResourcePage> {
    if (options.reference.length > 4096) throw new Error('Resource reference is too large');
    if (options.reference.startsWith('agent://')) return this.readAgentOutput(options);
    let entryPath = options.parentPath;
    let childDiagnostics: string[] = [];
    if (options.subagentId !== undefined) {
      const { found, visited } = await this.savedSelection(options);
      const child = found.children.find(item => item.metadata.id === options.subagentId);
      if (!child) throw new Error('Saved child does not belong to the selected parent task ancestry');
      if (!found.complete) throw new Error(`Saved task ancestry cannot be verified completely: ${found.diagnostics.join(' ')}`);
      if (child.sourceName && found.children.filter(item => item.sourceName === child.sourceName).length !== 1) throw new Error('Saved child journal identity is ambiguous across persisted task edges');
      // Shared native artifacts belong to the verified parent's store. Only
      // journal-backed entry/image references require the selected child file.
      if (options.reference.startsWith('desktop-image:') || options.reference.startsWith('desktop-entry:')) {
        const source = await this.childSource(found, child, visited);
        entryPath = source.path;
      }
      childDiagnostics = [...found.diagnostics];
    }
    if (options.reference.startsWith('desktop-image:')) {
      if (options.cursor) throw new Error('Saved images do not have a text cursor');
      const page = await this.reader.imageDetail({ path: entryPath, reference: options.reference }, await this.blobsRoot(options.parentPath));
      return { ...page, diagnostics: [...childDiagnostics, ...page.diagnostics] };
    }
    if (options.reference.startsWith('desktop-entry:')) {
      const page = await this.readEntryReference(entryPath, options.reference, options.cursor);
      return { ...page, diagnostics: [...childDiagnostics, ...page.diagnostics] };
    }
    const selected = selection(options.reference);
    const context = await this.reader.resourceContext(options.parentPath);
    // Native children adopt the parent's ArtifactManager; numeric IDs share the parent's store.
    const diagnostics = [...childDiagnostics, ...context.diagnostics];
    const roots = await this.safeRoots(context.artifactRoots, diagnostics);
    const paths = await this.findFiles(roots, name => name.startsWith(`${selected.id}.`) && /^\d+\.[A-Za-z0-9_-]+\.log$/.test(name), diagnostics);
    const base: SessionResourcePage = { name: options.reference, kind: 'text', sourceLabel: 'Saved native artifact', diagnostics };
    if (paths.length !== 1) {
      diagnostic(diagnostics, paths.length ? 'Artifact ID is ambiguous across persisted parent roots; no source was selected.' : 'Artifact is missing from the authorized parent artifact roots.');
      return base;
    }
    return this.readArtifact(paths[0]!, options, selected, base);
  }

  private async readAgentOutput(options: { parentPath: string; reference: string; cursor?: string; subagentId?: string; leafId?: string | null; ancestry?: SavedSubagentEdge[] }, nativeSubagents?: readonly NativeSubagent[]): Promise<SessionResourcePage> {
    const selected = agentSelection(options.reference);
    const live = nativeSubagents?.filter(child => (child.nativeId ?? child.id) === selected.id) ?? [];
    if (live.length > 1) throw new Error('Agent output identity is ambiguous in the owned native roster');
    if (live.length === 1) {
      // The caller revalidates current ownership and the native leaf around this
      // read. Saved discovery is a separate authority, not a roster prerequisite.
      const context = await this.reader.resourceContext(options.parentPath);
      const diagnostics = [...context.diagnostics];
      const roots = new Set(await this.safeRoots(context.artifactRoots, diagnostics));
      if (live[0]!.sessionFile) {
        const source = await this.runtimeChild(options.parentPath, live[0]!.sessionFile, selected.id);
        roots.add(dirname(source.path));
      }
      return this.readSelectedAgentOutput(options, selected, roots, diagnostics);
    }
    let parent: Discovery;
    if (!nativeSubagents && options.subagentId) {
      const { found } = await this.savedSelection(options);
      const child = found.children.find(item => item.metadata.id === options.subagentId);
      if (!child) throw new Error('Saved child does not belong to the selected parent task ancestry');
      if (!found.complete) throw new Error(`Saved task ancestry cannot be verified completely: ${found.diagnostics.join(' ')}`);
      // The supplied verified chain also supports native IDs without dotted names.
      parent = found;
    } else parent = await this.discover({ path: options.parentPath, leafId: options.leafId });
    const diagnostics = [...parent.diagnostics];
    const roots = new Set(parent.roots);
    const matches = new Set<string>();
    const visited = new Set<string>([resolve(options.parentPath)]);
    const pending: Discovery[] = [parent];
    let sources = 0;
    while (pending.length) {
      if (++sources > 64) throw new Error('Agent output ancestry reached the 64-source discovery bound; uniqueness cannot be established');
      const found = pending.pop()!;
      if (!found.complete) throw new Error(`Agent output identity cannot be verified completely: ${found.diagnostics.join(' ')}`);
      for (const child of found.children) {
        if (child.sourceName === selected.id) matches.add(child.metadata.id);
        // Dots only narrow the search. A persisted parent task and its unique
        // confined journal, never the spelling alone, establish each edge.
        if (!child.sourceName || !selected.id.startsWith(`${child.sourceName}.`)) continue;
        if (found.children.filter(item => item.sourceName === child.sourceName).length !== 1) throw new Error('Nested task parent identity is ambiguous');
        const journals = await this.findFiles(found.roots, name => name === `${child.sourceName}.jsonl` || name === `${child.sourceName}.jsonl.gz`, diagnostics);
        if (journals.length !== 1) throw new Error(journals.length ? 'Nested task journal is ambiguous' : 'Nested task journal is unavailable');
        const path = journals[0]!;
        if (visited.has(path)) throw new Error('Agent output ancestry contains a journal cycle');
        visited.add(path);
        const childRoots = await this.safeRoots([path.replace(/\.jsonl(?:\.gz)?$/, '')], diagnostics);
        for (const root of childRoots) roots.add(root);
        const nested = await this.discover({ path }, { roots: [...new Set([...found.roots, ...childRoots])], blobs: parent.blobs });
        pending.push(nested);
        for (const reason of nested.diagnostics) diagnostic(diagnostics, reason);
      }
    }
    if (matches.size > 1) throw new Error('Agent output identity is ambiguous in the selected parent task ancestry');
    if (!matches.size) throw new Error('Agent output does not belong to the selected parent task ancestry or owned native roster');
    return this.readSelectedAgentOutput(options, selected, roots, diagnostics);
  }

  private async readSelectedAgentOutput(options: { parentPath: string; reference: string; cursor?: string }, selected: AgentSelection, roots: Set<string>, diagnostics: string[]): Promise<SessionResourcePage> {
    const paths = await this.findFiles([...roots], name => name === `${selected.id}.md`, diagnostics);
    const base: SessionResourcePage = { name: options.reference, kind: 'text', sourceLabel: `Native task output · ${selected.id}`, diagnostics };
    if (paths.length !== 1) {
      diagnostic(diagnostics, paths.length ? 'Agent output is ambiguous across authorized roots; no file was selected.' : 'Agent output is unavailable in the authorized parent artifact roots.');
      return base;
    }
    if (!selected.segments.length) return this.readArtifact(paths[0]!, options, { id: selected.id, ranges: [] }, base);
    // A sidecar belongs only to the unique Markdown output's own directory.
    const sidecars = await this.findFiles([dirname(paths[0]!)], name => name === `${selected.id}.json`, diagnostics);
    if (diagnostics.some(reason => /uniqueness cannot|Unsafe or nonregular/.test(reason))) throw new Error('Structured agent output could not be safely resolved');
    let source = paths[0]!;
    let value: unknown;
    let revision: string;
    if (sidecars.length) {
      const json = await this.outputJson(sidecars[0]!);
      try { value = JSON.parse(json.content); source = sidecars[0]!; revision = json.revision; }
      catch { diagnostic(diagnostics, 'Structured sidecar is not valid JSON; reading the native Markdown output as JSON.'); }
    }
    if (source === paths[0]) {
      const json = await this.outputJson(source);
      try { value = JSON.parse(json.content); } catch { throw new Error('Native agent output is not valid JSON and has no readable structured sidecar'); }
      revision = json.revision;
    }
    for (const segment of selected.segments) {
      if (value === null || typeof value !== 'object') throw new Error(`Agent output JSON path is missing: /${selected.segments.join('/')}`);
      const key = Array.isArray(value) && /^\d+$/.test(segment) && Number.isSafeInteger(Number(segment)) ? String(Number(segment)) : segment;
      if (!Object.hasOwn(value, key) || (Array.isArray(value) && !/^\d+$/.test(key))) throw new Error(`Agent output JSON path is missing: /${selected.segments.join('/')}`);
      value = (value as Record<string, unknown>)[key];
    }
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (content === undefined) throw new Error('Agent output JSON path has no serializable value');
    const bytes = Buffer.from(content);
    const binding = digest(JSON.stringify([resolve(options.parentPath), options.reference, source, revision!]));
    let offset = 0;
    if (options.cursor) {
      const cursor = decode(options.cursor);
      if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > bytes.length) throw new Error('Agent output cursor is stale or invalid');
      offset = Number(cursor.offset);
    }
    let end = Math.min(offset + PAGE_BYTES, bytes.length);
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
    return { ...base, sourceLabel: `${base.sourceLabel} · JSON /${selected.segments.join('/')}`, content: bytes.toString('utf8', offset, end), ...(end < bytes.length ? { nextCursor: encode({ binding, offset: end }) } : {}) };
  }

  private async outputJson(path: string): Promise<{ content: string; revision: string }> {
    const file = await open(path, FLAGS);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || await realpath(path) !== path) throw new Error('Structured output is not a confined regular file');
      if (info.size > BigInt(SCAN_BYTES)) throw new Error('Structured output exceeds the 8 MiB extraction bound; open the full output instead');
      const revision = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const bytes = Buffer.alloc(Number(info.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error('Structured output changed while reading');
        offset += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== revision || await realpath(path) !== path) throw new Error('Structured output changed while reading');
      return { content: bytes.toString('utf8'), revision };
    } finally { await file.close(); }
  }

  private async discover(options: { path: string; leafId?: string | null }, scope?: { roots: string[]; blobs: string }): Promise<Discovery> {
    const key = JSON.stringify({ path: options.path, leafId: options.leafId, scope });
    const cached = this.completedDiscoveries.get(key);
    let fallback: Discovery | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const found = await this.discoverSnapshot(options, scope, baseline => {
          fallback = cached?.parent.session.id === baseline.parent.session.id ? cached : baseline;
        });
        if (found.complete) {
          this.completedDiscoveries.delete(key); this.completedDiscoveries.set(key, found);
          if (this.completedDiscoveries.size > 6) this.completedDiscoveries.delete(this.completedDiscoveries.keys().next().value!);
        }
        return found;
      } catch (error) { if (!(error instanceof HistoryRevisionChangedError)) throw error; }
    }
    if (!fallback) throw new HistoryRevisionChangedError();
    const reason = fallback.complete ? 'Saved task history is still changing; retaining the last complete discovery until the next refresh.' : 'Saved task history is still changing; no complete discovery is available yet.';
    return { ...fallback, complete: false, diagnostics: [...fallback.diagnostics, reason] };
  }

  private async discoverSnapshot(options: { path: string; leafId?: string | null }, scope: { roots: string[]; blobs: string } | undefined, retain: (baseline: Discovery) => void): Promise<Discovery> {
    const context = await this.reader.resourceContext(options.path);
    const diagnostics = [...context.diagnostics];
    const roots = scope?.roots ?? await this.safeRoots(context.artifactRoots, diagnostics);
    const blobs = scope?.blobs ?? await this.blobsRoot(options.path);
    const parent = await this.reader.read(options, blobs);
    retain({ children: [], parent, roots, blobs, diagnostics, complete: false });
    let page = parent;
    const children = new Map<string, Child>();
    const deliveries = new Map<string, { job: NativeAsyncDeliveryJob; age: number }>();
    let age = 0;
    let complete = true;
    do {
      const metadata = await this.reader.taskMetadata({ path: options.path, revision: page.revision, entryIds: page.messages.map(message => message.entryId ?? Buffer.from(message.resourceReference!.slice('desktop-entry:'.length), 'base64url').toString('utf8')) });
      for (const item of metadata.diagnostics) diagnostic(diagnostics, item);
      if (metadata.diagnostics.length) complete = false;
      for (let position = metadata.records.length - 1; position >= 0; position--) {
        const item = metadata.records[position]!;
        const currentAge = age++;
        if (item.delivery) {
          for (const reason of item.delivery.diagnostics) diagnostic(diagnostics, reason);
          for (const job of item.delivery.jobs) {
            if (!job.agentId || deliveries.has(job.agentId)) continue;
            deliveries.set(job.agentId, { job, age: currentAge });
          }
          continue;
        }
        const message = item.message;
        if (!message || message.role !== 'toolResult' || message.toolName !== 'task' || typeof message.toolCallId !== 'string' || !record(message.details)) continue;
        const details = message.details;
        const results = Array.isArray(details.results) ? details.results : [];
        const progress = Array.isArray(details.progress) ? details.progress : [];
        for (const row of [...results, ...progress]) {
          if (!record(row)) continue;
          const nativeId = typeof row.id === 'string' && row.id.length <= 200 ? row.id : undefined;
          const index = typeof row.index === 'number' && Number.isSafeInteger(row.index) && row.index >= 0 ? row.index : undefined;
          if (!nativeId && index === undefined) { diagnostic(diagnostics, 'A saved task row has neither a native ID nor a task index and cannot be identified safely.'); continue; }
          const identity = `${message.toolCallId}:${index === undefined ? `id:${nativeId}` : `index:${index}`}`;
          const existing = children.get(identity);
          if (existing) {
            if (!existing.metadata.assignment && typeof row.assignment === 'string') {
              existing.metadata.assignment = text(row.assignment);
              existing.metadata.task = text(row.assignment) || existing.metadata.task;
            }
            continue;
          }
          const outputPath = text(row.outputPath, 4096);
          let sourceName = nativeId && SAFE_NAME.test(nativeId) ? nativeId : undefined;
          if (!sourceName && outputPath) {
            const candidate = basename(outputPath, '.md');
            if (outputPath.endsWith('.md') && SAFE_NAME.test(candidate) && context.artifactRoots.some(root => resolve(dirname(outputPath)) === resolve(root))) sourceName = candidate;
          }
          const metadata = normalizeAgent({
            ...row, id: `saved-${digest(JSON.stringify([context.session.path, message.toolCallId, index ?? nativeId]))}`,
            ...(nativeId ? { nativeId } : {}), parentToolCallId: message.toolCallId,
            agent: text(row.agent, 256), description: text(row.description), task: text(row.assignment) || text(row.task), assignment: text(row.assignment), readonly: true,
          }, { source: 'task', historical: true, observedAt: evidenceTime(message.timestamp) });
          const metrics: Record<string, unknown> = {};
          for (const key of ['index', 'durationMs', 'tokens', 'requests', 'contextTokens', 'contextWindow', 'cost', 'toolCount', 'issueCount']) if (typeof row[key] === 'number' && Number.isFinite(row[key])) metrics[key] = row[key];
          for (const key of ['lastIntent', 'currentTool', 'resolvedModel', 'modelRole', 'error', 'abortReason']) if (typeof row[key] === 'string') metrics[key] = text(row[key]);
          metadata.progress = metrics;
          children.set(identity, { metadata, sourceName, age: currentAge });
        }
      }
      for (const message of page.diagnostics) diagnostic(diagnostics, message);
      if (!page.nextBefore) break;
      page = await this.reader.read({ ...options, leafId: parent.selectedLeafId, before: page.nextBefore }, blobs);
      if (page.revision !== parent.revision) throw new HistoryRevisionChangedError();
    } while (true);
    const byNativeId = new Map<string, Child[]>();
    for (const child of children.values()) {
      const id = child.metadata.nativeId;
      if (id) {
        const matches = byNativeId.get(id);
        if (matches) matches.push(child);
        else byNativeId.set(id, [child]);
      }
    }
    for (const [id, delivery] of deliveries) {
      const matches = byNativeId.get(id);
      if (!matches) continue; // Notification identities never establish children or paths.
      if (matches.length !== 1) {
        diagnostic(diagnostics, `Native task delivery identity ${id} matches multiple saved children; settlement is unknown.`);
        for (const child of matches) if (delivery.age < child.age) child.metadata = normalizeAgent({ ...child.metadata, status: 'unknown', error: undefined, exitCode: undefined }, { source: 'delivery', historical: true, observedAt: evidenceTime(delivery.job.observedAt), reason: 'The native alias matches multiple saved task owners; settlement cannot be assigned safely.' });
        continue;
      }
      const child = matches[0]!;
      if (delivery.age >= child.age) continue; // A delivery cannot settle a later task record.
      child.metadata = jobEvidence(child.metadata, delivery.job, evidenceTime(delivery.job.observedAt));
    }
    const openTasks = complete ? await this.reader.openTaskMetadata({ path: options.path, leafId: parent.selectedLeafId, revision: parent.revision }) : [];
    if (openTasks.length && !options.leafId) {
      const candidates = await this.findFiles(roots, name => /\.jsonl(?:\.gz)?$/.test(name), diagnostics);
      const known = new Set([...children.values()].map(child => child.sourceName));
      for (const path of candidates) {
        const nativeId = basename(path).replace(/\.jsonl(?:\.gz)?$/, '');
        if (!SAFE_NAME.test(nativeId) || known.has(nativeId)) continue;
        try {
          const header = (await this.reader.resourceContext(path)).session;
          const parents = [context.session.path, context.session.id, ...(context.session.previousSessionFiles ?? [])];
          if (!header.parentSession || !parents.includes(header.parentSession) && await realpath(header.parentSession).catch(() => undefined) !== await realpath(options.path)) continue;
          const createdAt = evidenceTime(header.createdAt);
          const eligible = openTasks.filter(task => createdAt !== undefined && createdAt >= task.startedAt);
          if (!eligible.length) continue;
          const matches = eligible.filter(task => task.name && (nativeId === task.name || nativeId.startsWith(`${task.name}-`) && /^[1-9][0-9]*$/.test(nativeId.slice(task.name.length + 1))));
          const owner = matches.length === 1 ? matches[0] : undefined;
          const id = `saved-${digest(JSON.stringify([context.session.path, 'child-source', nativeId]))}`;
          const metadata = normalizeAgent({ id, nativeId, readonly: true, provisional: true, ...(owner ? { parentToolCallId: owner.toolCallId, index: owner.index, task: owner.task, assignment: owner.task, agent: owner.agent } : { ownershipReason: matches.length ? 'The child matches multiple open task declarations.' : 'The child parent is verified, but its task declaration is not uniquely linked.' }) }, { source: 'journal', historical: true, observedAt: createdAt });
          children.set(`journal:${nativeId}`, { metadata, sourceName: nativeId, age: -1 });
          known.add(nativeId);
        } catch (error) { diagnostic(diagnostics, `Provisional child evidence unavailable: ${errorText(error)}`); }
      }
    }
    // Unique authorized journal identity is stable before and after the parent result arrives.
    const sourceCounts = new Map<string, number>();
    for (const child of children.values()) if (child.sourceName) sourceCounts.set(child.sourceName, (sourceCounts.get(child.sourceName) ?? 0) + 1);
    for (const child of children.values()) if (child.sourceName && sourceCounts.get(child.sourceName) === 1) child.metadata.id = `saved-${digest(JSON.stringify([context.session.path, 'child-source', child.sourceName]))}`;
    const found = { children: [...children.values()], parent, roots, blobs, diagnostics, complete };
    const parentActivity = options.leafId ? undefined : await this.observeParent?.(options.path, parent.selectedLeafId);
    for (const child of found.children) {
      try {
        const source = await this.childSource(found, child, new Set([await realpath(options.path)]));
        const journal = await this.childEvidence.read(source.path, options.leafId ? evidenceTime(parent.messages.at(-1)?.raw.timestamp) : undefined);
        const prior = evidenceOf(child.metadata), evidence = evidenceOf(journal);
        const resumed = evidence.generationStartedAt !== undefined && prior.observedAt !== undefined && evidence.generationStartedAt > prior.observedAt;
        const ambiguous = prior.reason?.includes('ambiguous') || prior.reason?.includes('multiple');
        const fallback = !terminalPhase(prior.phase) && !ambiguous || resumed;
        const progress = { ...child.metadata.progress };
        const metricSources = { ...prior.metricSources };
        for (const key of ['tokens', 'toolCount', 'cost', 'durationMs'] as const) if ((progress[key] === undefined || progress[key] === 0 || prior.metricsSource === 'spawn' || prior.source === 'delivery') && journal.progress?.[key] !== undefined) { progress[key] = journal.progress[key]; metricSources[key] = 'journal'; }
        progress.issueCount = Math.max(Number(progress.issueCount ?? 0), evidence.findings);
        progress.toolFailureCount = journal.progress?.toolFailureCount;
        if (fallback) { progress.currentTool = journal.progress?.currentTool; progress.lastIntent = journal.progress?.lastIntent; }
        const next = { ...child.metadata, status: journal.status, followupCompleted: journal.followupCompleted, journalOpen: journal.journalOpen, evidence: { ...evidence, metricSources }, progress };
        child.metadata = fallback ? inferChildActivity(reconcileAgent(child.metadata, next), parentActivity) : { ...child.metadata, progress, evidence: { ...prior, metricSources, findings: Number(progress.issueCount), metricsSource: prior.metricsSource === 'spawn' ? 'journal' : prior.metricsSource } };
      } catch (error) {
        const evidence = evidenceOf(child.metadata);
        if (!terminalPhase(evidence.phase)) child.metadata.evidence = { ...evidence, reason: evidence.reason ?? errorText(error) };
      }
    }
    return found;
  }

  private async safeRoots(candidates: string[], diagnostics: string[]): Promise<string[]> {
    const roots = new Set<string>();
    for (const candidate of candidates.slice(0, 128)) {
      try {
        const parent = await realpath(dirname(candidate));
        const expected = join(parent, basename(candidate));
        const actual = await realpath(candidate);
        if (actual !== expected || !(await stat(actual)).isDirectory()) { diagnostic(diagnostics, 'A parent artifact root is not a direct, nonsymlink directory and was excluded.'); continue; }
        roots.add(actual);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic(diagnostics, `Artifact root unavailable: ${errorText(error)}`); }
    }
    if (candidates.length > 128) diagnostic(diagnostics, 'Artifact root provenance exceeded the 128-root bound.');
    return [...roots];
  }

  private async findFiles(roots: string[], matches: (name: string) => boolean, diagnostics: string[]): Promise<string[]> {
    const found = new Set<string>();
    let entries = 0;
    for (const root of roots) {
      try {
        const directory = await opendir(root);
        for await (const entry of directory) {
          if (++entries > MAX_DIRECTORY_ENTRIES) { diagnostic(diagnostics, 'Artifact directory scan reached the 20,000-entry bound; uniqueness cannot be established.'); return []; }
          if (!matches(entry.name)) continue;
          const path = join(root, entry.name);
          if (!entry.isFile() || await realpath(path) !== path) { diagnostic(diagnostics, `Unsafe or nonregular resource ${entry.name} was excluded.`); continue; }
          found.add(path);
        }
      } catch (error) { diagnostic(diagnostics, `Artifact directory could not be read; uniqueness cannot be established: ${errorText(error)}`); return []; }
    }
    return [...found];
  }

  private async readArtifact(path: string, options: { parentPath: string; reference: string; cursor?: string }, selected: Selection, base: SessionResourcePage): Promise<SessionResourcePage> {
    const file = await open(path, FLAGS);
    try {
      const info = await file.stat({ bigint: true });
      if (await realpath(path) !== path) throw new Error('Artifact containment changed while opening the resource');
      if (!info.isFile()) throw new Error('Artifact is not a regular file');
      const revision = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const binding = digest(JSON.stringify([resolve(options.parentPath), options.reference, path, revision]));
      const size = Number(info.size);
      let offset = 0, line = 1, region = 0;
      let lineStart = true;
      let tailRemaining = selected.tailLines;
      if (tailRemaining !== undefined) offset = size;
      if (options.cursor) {
        const cursor = decode(options.cursor);
        if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > size || !Number.isSafeInteger(cursor.line) || Number(cursor.line) < 1 || !Number.isSafeInteger(cursor.region) || Number(cursor.region) < 0 || typeof cursor.lineStart !== 'boolean') throw new Error('Artifact cursor is stale or invalid');
        offset = Number(cursor.offset); line = Number(cursor.line); region = Number(cursor.region); lineStart = cursor.lineStart;
        tailRemaining = typeof cursor.tailRemaining === 'number' ? cursor.tailRemaining : undefined;
        if (tailRemaining !== undefined && (!Number.isSafeInteger(tailRemaining) || tailRemaining < 1 || selected.tailLines === undefined || tailRemaining > selected.tailLines)) throw new Error('Invalid tail scan cursor');
      }
      if (tailRemaining !== undefined) {
        const backwards = Buffer.alloc(PAGE_BYTES);
        let scannedTail = 0;
        while (offset > 0 && tailRemaining > 0 && scannedTail < SCAN_BYTES) {
          const start = Math.max(0, offset - Math.min(PAGE_BYTES, SCAN_BYTES - scannedTail));
          const { bytesRead } = await file.read(backwards, 0, offset - start, start);
          if (bytesRead !== offset - start) throw new Error('Artifact changed during tail scan');
          let boundary = -1;
          for (let position = bytesRead - 1; position >= 0; position--) {
            if (backwards[position] !== 10 || start + position === size - 1) continue;
            if (--tailRemaining === 0) { boundary = start + position + 1; break; }
          }
          scannedTail += bytesRead;
          offset = boundary >= 0 ? boundary : start;
        }
        if (offset > 0 && tailRemaining > 0) {
          const after = await file.stat({ bigint: true });
          if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== revision) throw new Error('Artifact changed during tail scan');
          return { ...base, content: '', diagnostics: [...base.diagnostics, 'Tail scan reached the 8 MiB work bound; continue to locate the requested lines.'], nextCursor: encode({ binding, offset, line, region, lineStart, tailRemaining }) };
        }
      }
      const output: Buffer[] = [];
      let outputBytes = 0, scanned = 0;
      let done = false, pageFull = false;
      const buffer = Buffer.alloc(PAGE_BYTES + 4);
      const lastLine = selected.ranges.length ? Math.max(...selected.ranges.map(range => range[1])) : Number.MAX_SAFE_INTEGER;
      while (offset < size && outputBytes < PAGE_BYTES && scanned < SCAN_BYTES && !done && !pageFull) {
        const startOffset = offset;
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) break;
        const usable = Math.min(bytesRead, PAGE_BYTES, SCAN_BYTES - scanned);
        let position = 0;
        while (position < usable && outputBytes < PAGE_BYTES) {
          if (lineStart && selected.region !== undefined && bytesRead - position < 256 && startOffset + bytesRead < size) break;
          const newline = buffer.indexOf(10, position);
          let end = newline >= 0 && newline < usable ? newline + 1 : usable;
          if (lineStart && selected.region !== undefined) {
            const header = /^### region (\d+) \(/.exec(buffer.toString('utf8', position, Math.min(bytesRead, position + 256)));
            if (header) region = Number(header[1]);
            if (region > selected.region) { done = true; break; }
          }
          const include = (selected.region === undefined || region === selected.region) && (!selected.ranges.length || selected.ranges.some(([first, last]) => line >= first && line <= last));
          if (line > lastLine) { done = true; break; }
          if (include) end = Math.min(end, position + PAGE_BYTES - outputBytes);
          // Read-ahead makes the first byte of the next code point visible.
          if (end < bytesRead) while (end > position && (buffer[end]! & 0xc0) === 0x80) end--;
          if (end === position) { pageFull = true; break; }
          if (include) { const part = Buffer.from(buffer.subarray(position, end)); output.push(part); outputBytes += part.length; }
          lineStart = buffer[end - 1] === 10;
          if (lineStart) line++;
          const count = end - position; offset += count; scanned += count; position = end;
        }
        if (offset === startOffset && !done) break;
      }
      const after = await file.stat({ bigint: true });
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== revision) throw new Error('Artifact changed while reading; reload the resource');
      const content = Buffer.concat(output, outputBytes).toString('utf8');
      if (content.includes('\0')) return { ...base, kind: 'binary', diagnostics: [...base.diagnostics, 'Artifact contains binary bytes; inline text display was withheld.'] };
      const hasMore = !done && offset < size;
      if (hasMore && scanned >= SCAN_BYTES) diagnostic(base.diagnostics, 'Recovery scan reached the 8 MiB work bound; continue to scan the next bounded segment.');
      if (!hasMore && selected.region !== undefined && region < selected.region) diagnostic(base.diagnostics, `Recovery region ${selected.region} was not found in this artifact.`);
      return { ...base, content, ...(hasMore ? { nextCursor: encode({ binding, offset, line, region, lineStart }) } : {}) };
    } finally { await file.close(); }
  }
}
