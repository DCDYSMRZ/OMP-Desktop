import { execFile } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { RuntimeShutdownOutcome, SessionAccess, SessionRemovalResult, SessionRemovalTarget, SessionSummary } from '../../shared/contracts';
import { parseSessionPrefix } from './history';
import { isMissing, record } from './io';
import { relevantLsofDiagnostics } from './lsof-diagnostics';

/** Main-only authority, constructed while holding runtime then canonical-source admission. */
export interface RemovalAuthorization {
  sessionId: string;
  source: { status: 'unpersisted' | 'persisted' | 'unavailable'; path?: string };
  initialEmpty: boolean;
  affectedRuntimeIds: string[];
  roots: { sessions: string; archives: string; registry: string };
  revalidate(phase: 'before-close' | 'after-close' | 'before-trash'): Promise<void>;
  close?(): Promise<RuntimeShutdownOutcome>;
  inspectWriters(path: string, tree: boolean): Promise<{ safe: boolean; reason?: string; uncertain?: boolean }>;
}
export interface SessionRemovalDependencies {
  withAdmission(target: SessionRemovalTarget, run: (authorization: RemovalAuthorization) => Promise<SessionRemovalResult>): Promise<SessionRemovalResult>;
  trashItem(path: string): Promise<void>;
}

export class RemovalOccupancyError extends Error {
  constructor(readonly status: 'external' | 'unknown', reason: string) { super(reason); }
}
/** Unknown observations require an explicit recoverable Trash decision, never write permission. */
export function requireRemovalAccess(access: SessionAccess, allowUncertain = false): void {
  if (access.status === 'external') throw new RemovalOccupancyError('external', 'An external terminal or process holds this session. Close it before removal.');
  if (access.status === 'unknown' && !allowUncertain) throw new RemovalOccupancyError('unknown', access.reason || 'Session occupancy could not be established.');
}
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 32;
const PREFIX_BYTES = 64 * 1024;
const MAX_COMPRESSED_HEADER_BYTES = 1024 * 1024;
const HEADER_DEADLINE_MS = 2000;
type Snapshot = { path: string; info: BigIntStats };
type WorkspaceBinding = { recordedPath: string; workspace?: Snapshot; missing?: ConfiguredRootBinding };
type ConfiguredRootBinding = { configuredPath: string; path: string; anchor: Snapshot; missing: boolean };
type ConfiguredRootBindings = Record<keyof RemovalAuthorization['roots'], ConfiguredRootBinding>;
/** Read-only reference identity; never a mutation target or ownership grant. */
type ProvenanceBinding = { reference: string; path: string; parent: Snapshot; entry?: Snapshot; target?: Snapshot };
type SourceProvenance = { header: SessionSummary; references: ProvenanceBinding[] };
type RegisteredSourceBinding = { reference: string; path: string; parent: Snapshot; source?: Snapshot };
type PlanItem = Snapshot & { tree?: Snapshot[]; discovery?: Discovery; workspaces?: WorkspaceBinding[]; backup?: boolean; roots?: ConfiguredRootBindings; registration?: RegisteredSourceBinding };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
class RetentionError extends Error {
  constructor(readonly reasonCode: 'shared' | 'workspace' | 'provenance' | 'writer', reason: string) { super(reason); }
}
const stamp = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

async function snapshot(path: string, directory = false): Promise<Snapshot> {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new Error(`Noncanonical removal path: ${path}`);
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error(`Removal target is not a regular ${directory ? 'directory' : 'file'}: ${path}`);
  if (!directory && info.nlink !== 1n) throw new Error(`Removal target has shared hard links: ${path}`);
  if (await realpath(path) !== path) throw new Error(`Removal target crosses a symbolic link: ${path}`);
  return { path, info };
}
async function optionalSnapshot(path: string, directory = false): Promise<Snapshot | undefined> {
  try { return await snapshot(path, directory); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
async function unchanged(item: Snapshot, directory = false): Promise<void> {
  if (stamp((await snapshot(item.path, directory)).info) !== stamp(item.info)) throw new Error(`Removal target changed: ${item.path}`);
}
/** Removal has its own bounded reader; history range caching is not a discovery budget. */
async function summary(item: Snapshot): Promise<SessionSummary> {
  const compressed = item.path.endsWith('.gz');
  if (compressed && item.info.size > BigInt(MAX_COMPRESSED_HEADER_BYTES)) throw new Error(`Compressed header input exceeds the 1 MiB removal discovery limit: ${item.path}`);
  const deadline = Date.now() + HEADER_DEADLINE_MS;
  const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let prefix: Buffer;
  try {
    if (stamp(await file.stat({ bigint: true })) !== stamp(item.info)) throw new Error(`Session changed before header discovery: ${item.path}`);
    const input = Buffer.alloc(Number(item.info.size < BigInt(compressed ? MAX_COMPRESSED_HEADER_BYTES : PREFIX_BYTES) ? item.info.size : BigInt(compressed ? MAX_COMPRESSED_HEADER_BYTES : PREFIX_BYTES)));
    let length = 0;
    while (length < input.length) {
      if (Date.now() >= deadline) throw new Error(`Session header discovery timed out: ${item.path}`);
      const read = await file.read(input, length, input.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (Date.now() >= deadline) throw new Error(`Session header discovery timed out: ${item.path}`);
    if (compressed) {
      const unzip = createGunzip({ chunkSize: PREFIX_BYTES });
      const timer = setTimeout(() => unzip.destroy(new Error(`Compressed header discovery timed out: ${item.path}`)), Math.max(1, deadline - Date.now()));
      const output = Buffer.alloc(PREFIX_BYTES);
      let count = 0;
      try {
        unzip.end(input.subarray(0, length));
        for await (const chunk of unzip) {
          const bytes = chunk as Buffer;
          const take = Math.min(bytes.length, PREFIX_BYTES - count);
          bytes.copy(output, count, 0, take);
          count += take;
          if (count === PREFIX_BYTES) break;
        }
        prefix = output.subarray(0, count);
      } finally { clearTimeout(timer); unzip.destroy(); }
    } else prefix = input.subarray(0, length);
    if (Date.now() >= deadline) throw new Error(`Session header discovery timed out: ${item.path}`);
    const text = prefix.toString('utf8');
    const parsed = parseSessionPrefix(text, item.path, '');
    if (!parsed) throw new Error(`Missing bounded native session header: ${item.path}`);
    // Display summaries filter/truncate lineage. Removal must first establish that
    // the complete bounded header can be represented without losing references.
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const header: unknown = JSON.parse(line);
      if (!record(header)) throw new Error(`Invalid removal header: ${item.path}`);
      if (header.type === 'title') continue;
      const aliases = header.previousSessionFiles;
      if (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > 1000 || aliases.some(value => typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')))) throw new Error(`Incomplete or invalid session provenance; removal ownership is unproven: ${item.path}`);
      if (header.parentSession !== undefined && (typeof header.parentSession !== 'string' || !header.parentSession || header.parentSession.includes('\0'))) throw new Error(`Invalid parent provenance; removal ownership is unproven: ${item.path}`);
      break;
    }
    await unchanged(item);
    return parsed;
  } finally { await file.close(); }
}

async function bindWorkspace(recordedPath: string, resource: string): Promise<WorkspaceBinding> {
  let workspace: Snapshot;
  try { workspace = await snapshot(await realpath(recordedPath), true); }
  catch (error) {
    if (isMissing(error)) {
      // Walk to a real ancestor: ENOENT is absence, but a dangling alias is not.
      const missing = await bindConfiguredRoot(recordedPath);
      if (missing.missing) return { recordedPath, missing };
    }
    throw new Error(`Workspace identity cannot be established for ${recordedPath}: ${message(error)}`);
  }
  if (workspace.path === resource || workspace.path.startsWith(`${resource}${sep}`)) throw new RetentionError('workspace', `Resource tree contains a recorded workspace: ${recordedPath}`);
  return { workspace, recordedPath };
}

async function revalidateWorkspaces(workspaces: WorkspaceBinding[] | undefined, resource: string): Promise<void> {
  for (const binding of workspaces ?? []) {
    const current = await bindWorkspace(binding.recordedPath, resource);
    if (binding.missing && current.missing) assertConfiguredRootBinding(binding.missing, current.missing);
    else if (!binding.workspace || !current.workspace || current.workspace.path !== binding.workspace.path || current.workspace.info.dev !== binding.workspace.info.dev || current.workspace.info.ino !== binding.workspace.info.ino || current.workspace.info.birthtimeNs !== binding.workspace.info.birthtimeNs) throw new Error(`Workspace identity changed: ${binding.recordedPath}`);
  }
}

async function assertSourceAbsent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if (isMissing(error)) return; throw error; }
  throw new Error(`Source path reappeared after Trash; ancillary data retained: ${path}`);
}
async function markerText(item: Snapshot): Promise<string> {
  if (item.info.size > 8192n) throw new Error(`Oversized native registration: ${item.path}`);
  const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (stamp(await file.stat({ bigint: true })) !== stamp(item.info)) throw new Error(`Registration changed: ${item.path}`);
    const bytes = Buffer.alloc(8193);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 8192) throw new Error(`Registration grew beyond the bounded read: ${item.path}`);
    const text = bytes.toString('utf8', 0, length).trim();
    if (!isAbsolute(text) || /[\0\r\n]/.test(text)) throw new Error(`Malformed native registration: ${item.path}`);
    await unchanged(item);
    return resolve(text);
  } finally { await file.close(); }
}

/** Fail closed on inaccessible directories, links, incomplete scans and observation limits. */
async function entries(path: string, budget: { count: number }, visit: (path: string, directory: boolean) => Promise<void>): Promise<void> {
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (++budget.count > MAX_ENTRIES) throw new Error('Removal discovery exceeded 10000 entries; resources retained');
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Ambiguous entry in removal discovery: ${join(path, entry.name)}`);
    await visit(join(path, entry.name), entry.isDirectory());
  }
}
async function treeSnapshot(root: string): Promise<Snapshot[]> {
  const result: Snapshot[] = [];
  const budget = { count: 0 };
  async function walk(path: string, directory: boolean, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error('Resource tree exceeded the safe discovery depth');
    result.push(await snapshot(path, directory));
    if (directory) await entries(path, budget, (child, isDirectory) => walk(child, isDirectory, depth + 1));
  }
  await walk(root, true, 0);
  return result;
}
async function unchangedTree(items: Snapshot[]): Promise<void> {
  for (const item of items) await unchanged(item, item.info.isDirectory());
}

/** Only trusted configuration roots may resolve aliases; mutation targets stay strict. */
async function bindConfiguredRoot(configuredPath: string): Promise<ConfiguredRootBinding> {
  if (!isAbsolute(configuredPath) || configuredPath.includes('\0')) throw new Error(`Invalid configured discovery root: ${configuredPath}`);
  let candidate = resolve(configuredPath);
  const missing: string[] = [];
  for (;;) {
    let canonical: string;
    try { canonical = await realpath(candidate); } catch (error) {
      if (!isMissing(error)) throw error;
      // A dangling configured link is uncertainty, not proof of an absent root.
      try {
        await lstat(candidate);
        throw new Error(`Configured discovery root has an unresolved alias: ${candidate}`);
      } catch (missingError) { if (!isMissing(missingError)) throw missingError; }
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`Configured discovery root has no existing directory ancestor: ${configuredPath}`);
      missing.unshift(basename(candidate));
      candidate = parent;
      continue;
    }
    const anchor = await snapshot(canonical, true);
    return { configuredPath, path: join(canonical, ...missing), anchor, missing: missing.length > 0 };
  }
}

function assertConfiguredRootBinding(expected: ConfiguredRootBinding, current: ConfiguredRootBinding): void {
  if (current.path !== expected.path || current.missing !== expected.missing || current.anchor.path !== expected.anchor.path || current.anchor.info.dev !== expected.anchor.info.dev || current.anchor.info.ino !== expected.anchor.info.ino || current.anchor.info.birthtimeNs !== expected.anchor.info.birthtimeNs) throw new Error(`Configured discovery root identity or alias resolution changed: ${expected.configuredPath}`);
}

async function revalidateConfiguredRoots(roots: ConfiguredRootBindings | undefined): Promise<void> {
  if (!roots) return;
  for (const binding of Object.values(roots)) assertConfiguredRootBinding(binding, await bindConfiguredRoot(binding.configuredPath));
}

interface Discovery { roots: ConfiguredRootBindings; sources: Snapshot[]; directories: Snapshot[]; markers: { item: Snapshot; target: string; binding: RegisteredSourceBinding }[]; absent: string[]; provenance: Map<string, SourceProvenance> }
async function discover(roots: RemovalAuthorization['roots'], removedSource?: string, expectedRoots?: ConfiguredRootBindings): Promise<Discovery> {
  const bindings: ConfiguredRootBindings = { sessions: await bindConfiguredRoot(roots.sessions), archives: await bindConfiguredRoot(roots.archives), registry: await bindConfiguredRoot(roots.registry) };
  if (expectedRoots) for (const category of ['sessions', 'archives', 'registry'] as const) assertConfiguredRootBinding(expectedRoots[category], bindings[category]);
  const result: Discovery = { roots: bindings, sources: [], directories: [], markers: [], absent: [], provenance: new Map() };
  const budget = { count: 0 };
  const sourceIdentities = new Map<string, Snapshot>();
  const addSource = (source: Snapshot) => {
    const identity = `${source.info.dev}:${source.info.ino}`;
    const previous = sourceIdentities.get(identity);
    if (previous) {
      if (previous.path !== source.path || stamp(previous.info) !== stamp(source.info)) throw new Error(`Discovered source identity changed during enumeration: ${source.path}`);
      return;
    }
    sourceIdentities.set(identity, source);
    result.sources.push(source);
  };
  for (const category of ['sessions', 'archives', 'registry'] as const) {
    const binding = bindings[category];
    const root = binding.path;
    if (binding.missing) { result.absent.push(root); continue; }
    result.directories.push(binding.anchor);
    if (category === 'registry') {
      await entries(root, budget, async (path, directory) => {
        if (directory) throw new Error(`Unexpected registration directory: ${path}`);
        const item = await snapshot(path);
        let binding: RegisteredSourceBinding;
        try { binding = await bindRegisteredSource(await markerText(item), removedSource); }
        catch (error) { if (isMissing(error)) return; throw error; }
        // Lazy allocations and trashed journals leave harmless native markers.
        if (!binding.source && binding.path !== removedSource) return;
        result.markers.push({ item, target: binding.path, binding });
        if (binding.source) addSource(binding.source);
      });
    } else {
      await entries(root, budget, async (path, directory) => {
        if (!directory) { if (/\.jsonl(?:\.gz)?$/.test(path)) addSource(await snapshot(path)); return; }
        result.directories.push(await snapshot(path, true));
        await entries(path, budget, async (child, childDirectory) => {
          if (!childDirectory && /\.jsonl(?:\.gz)?$/.test(child)) addSource(await snapshot(child));
        });
      });
    }
  }
  await revalidateRegistrations(result, removedSource);
  await revalidateConfiguredRoots(bindings);
  return result;
}

/** Parent aliases on read-only registry references do not authorize linked leaves. */
async function bindRegisteredSource(reference: string, removedSource?: string): Promise<RegisteredSourceBinding> {
  const parent = await snapshot(await realpath(dirname(reference)), true);
  const path = join(parent.path, basename(reference));
  const source = await optionalSnapshot(path);
  const currentParent = await snapshot(await realpath(dirname(reference)), true);
  if (currentParent.path !== parent.path || currentParent.info.dev !== parent.info.dev || currentParent.info.ino !== parent.info.ino || currentParent.info.birthtimeNs !== parent.info.birthtimeNs) throw new Error(`Registered source parent alias changed during resolution: ${reference}`);
  if (source) await unchanged(source);
  return { reference, path, parent, source };
}

async function revalidateRegisteredSource(expected: RegisteredSourceBinding, removedSource?: string): Promise<void> {
  const current = await bindRegisteredSource(expected.reference, removedSource);
  if (current.path !== expected.path || current.parent.path !== expected.parent.path || current.parent.info.dev !== expected.parent.info.dev || current.parent.info.ino !== expected.parent.info.ino || current.parent.info.birthtimeNs !== expected.parent.info.birthtimeNs) throw new Error(`Registered source identity or alias resolution changed: ${expected.reference}`);
  if (expected.path === removedSource && expected.source && !current.source) return;
  if (!!current.source !== !!expected.source || (current.source && expected.source && stamp(current.source.info) !== stamp(expected.source.info))) throw new Error(`Registered source changed: ${expected.reference}`);
}

async function revalidateRegistrations(discovery: Discovery | undefined, removedSource?: string): Promise<void> {
  if (!discovery) return;
  for (const marker of discovery.markers) {
    await unchanged(marker.item);
    await revalidateRegisteredSource(marker.binding, removedSource);
    await unchanged(marker.item);
  }
}

async function bindProvenance(reference: string): Promise<ProvenanceBinding> {
  try {
    const parent = await snapshot(await realpath(dirname(reference)), true);
    const entryPath = join(parent.path, basename(reference));
    let entry: Snapshot | undefined;
    try { entry = { path: entryPath, info: await lstat(entryPath, { bigint: true }) }; }
    catch (error) { if (!isMissing(error)) throw error; }
    if (entry && !entry.info.isFile() && !entry.info.isSymbolicLink()) throw new Error('Session provenance does not name a regular file');
    // A final reference symlink may be read to establish sharing, but never grants
    // authority to remove that link or its target. Dangling links stay uncertain.
    const target = entry ? await snapshot(await realpath(entryPath)) : undefined;
    const currentParent = await snapshot(await realpath(dirname(reference)), true);
    if (currentParent.path !== parent.path || currentParent.info.dev !== parent.info.dev || currentParent.info.ino !== parent.info.ino || currentParent.info.birthtimeNs !== parent.info.birthtimeNs) throw new Error('Session provenance parent identity changed during resolution');
    if (entry) {
      if (stamp(await lstat(entryPath, { bigint: true })) !== stamp(entry.info)) throw new Error('Session provenance entry changed during resolution');
    } else if (await optionalSnapshot(entryPath)) throw new Error('Session provenance entry appeared during resolution');
    if (target) await unchanged(target);
    return { reference, path: target?.path ?? entryPath, parent, entry, target };
  } catch (error) { throw new Error(`Session provenance resolution is uncertain for ${reference}: ${message(error)}`); }
}

async function sourceProvenance(discovery: Discovery, source: Snapshot): Promise<SourceProvenance> {
  const cached = discovery.provenance.get(source.path);
  if (cached) return cached;
  const header = await summary(source);
  const references: ProvenanceBinding[] = [];
  for (const reference of [...(header.previousSessionFiles ?? []), ...(header.parentSession && isAbsolute(header.parentSession) ? [header.parentSession] : [])]) references.push(await bindProvenance(reference));
  const provenance = { header, references };
  discovery.provenance.set(source.path, provenance);
  return provenance;
}

async function revalidateProvenance(discovery: Discovery | undefined, removedSource?: string): Promise<void> {
  if (!discovery) return;
  for (const provenance of discovery.provenance.values()) for (const expected of provenance.references) {
    const current = await bindProvenance(expected.reference);
    if (current.path !== expected.path || current.parent.path !== expected.parent.path || current.parent.info.dev !== expected.parent.info.dev || current.parent.info.ino !== expected.parent.info.ino || current.parent.info.birthtimeNs !== expected.parent.info.birthtimeNs) throw new Error(`Session provenance identity or alias resolution changed: ${expected.reference}`);
    // Keep the pre-removal canonical binding after our exact primary disappears.
    // Do not drop that reference or accept a retargeted/dangling alias as absence.
    if (removedSource === expected.path && expected.target && expected.entry?.info.isFile() && !current.entry && !current.target) continue;
    if (!!current.entry !== !!expected.entry || !!current.target !== !!expected.target || (current.entry && expected.entry && stamp(current.entry.info) !== stamp(expected.entry.info)) || (current.target && expected.target && stamp(current.target.info) !== stamp(expected.target.info))) throw new Error(`Session provenance target changed: ${expected.reference}`);
  }
}

async function planAncillary(auth: RemovalAuthorization, source: Snapshot, header: SessionSummary, result: SessionRemovalResult): Promise<PlanItem[]> {
  const planned: PlanItem[] = [];
  const registrations: PlanItem[] = [];
  const retain = (path: string, reason: string, reasonCode: NonNullable<SessionRemovalResult['retained'][number]['reasonCode']> = 'unverified') => result.retained.push({ path, reason, reasonCode });
  // Exact marker cleanup does not depend on unrelated registered transcripts.
  // Resource ownership still requires the full conservative discovery below.
  try {
    const registry = await bindConfiguredRoot(auth.roots.registry);
    const roots = { sessions: await bindConfiguredRoot(auth.roots.sessions), archives: await bindConfiguredRoot(auth.roots.archives), registry };
    if (!registry.missing) await entries(registry.path, { count: 0 }, async (path, directory) => {
      if (directory) return;
      const item = await snapshot(path);
      const reference = await markerText(item);
      let canonical: string;
      try { canonical = join(await realpath(dirname(reference)), basename(reference)); }
      catch (error) { if (isMissing(error)) return; throw error; }
      if (canonical !== source.path) return;
      const registration = await bindRegisteredSource(reference);
      registrations.push({ ...item, registration, roots });
    });
  } catch (error) { retain(auth.roots.registry, `Own registration cleanup could not be established: ${message(error)}`); }
  const resource = source.path.replace(/\.jsonl(?:\.gz)?$/, '');
  let discovery: Discovery | undefined;
  let discoveryError: unknown;
  try { discovery = await discover(auth.roots); } catch (error) { discoveryError = error; }
  // A native filename and native bucket are necessary but never sufficient ownership evidence.
  const nativeName = header.createdAt ? `${header.createdAt.replace(/[:.]/g, '-')}_${header.id}.jsonl` : '';
  const nativeBucket = !!discovery && !discovery.roots.sessions.missing && dirname(dirname(source.path)) === discovery.roots.sessions.path;
  for (const alias of header.previousSessionFiles ?? []) retain(alias.replace(/\.jsonl(?:\.gz)?$/, ''), 'Move alias retained; read provenance is not deletion authority');
  if (resource === source.path) retain(dirname(source.path), 'Custom source has no independently proven resource boundary; containing directory is untouched');
  else {
    try {
      const root = await optionalSnapshot(resource, true);
      if (root) {
        if (!nativeBucket || basename(source.path) !== nativeName || header.sourceKind !== 'journal') throw new Error('Custom or archived source resources are not proven exclusive');
        const workspaces = [await bindWorkspace(header.cwd, resource)];
        if (header.parentSession || header.previousSessionFiles?.length) throw new RetentionError('provenance', 'Fork/move provenance may share resources; ancestry is not deletion authority');
        if (!discovery) throw new Error(`Bounded discovery could not establish exclusive resource ownership: ${message(discoveryError)}`);
        for (const candidate of discovery.sources) {
          if (candidate.path === source.path) continue;
          const { header: other, references } = await sourceProvenance(discovery, candidate);
          workspaces.push(await bindWorkspace(other.cwd, resource));
          if (candidate.path.startsWith(`${resource}${sep}`)) throw new RetentionError('shared', `Another source occupies the resource tree: ${candidate.path}`);
          if (other.id === header.id || other.parentSession === header.id || references.some(reference => reference.path === source.path || reference.path.replace(/\.jsonl(?:\.gz)?$/, '') === resource || reference.path.startsWith(`${resource}${sep}`)) || candidate.path.replace(/\.jsonl(?:\.gz)?$/, '') === resource) throw new RetentionError('shared', `Another source may reference these resources: ${candidate.path}`);
        }
        planned.push({ ...root, tree: await treeSnapshot(resource), discovery, workspaces });
      }
    } catch (error) { retain(resource, message(error), error instanceof RetentionError ? error.reasonCode : 'unverified'); }
  }
  // Native EPERM rewrite backups use exactly a 16-lowercase-hex Snowflake suffix.
  try {
    await entries(dirname(source.path), { count: 0 }, async (path, directory) => {
      if (directory || !basename(path).startsWith(`${basename(source.path)}.`) || !path.endsWith('.bak')) return;
      try {
        if (!/^[0-9a-f]{16}\.bak$/.test(basename(path).slice(basename(source.path).length + 1))) throw new Error('Candidate does not have the native rewrite-backup naming pattern');
        if (!discovery) throw new Error(`Complete discovery is required to establish backup ownership: ${message(discoveryError)}`);
        const backup = await snapshot(path);
        if ((await summary(backup)).id !== header.id) throw new Error('Backup belongs to a different native identity');
        await assertBackupOwnership(backup, discovery);
        planned.push({ ...backup, discovery, backup: true });
      } catch (error) { retain(path, message(error)); }
    });
  } catch (error) { retain(dirname(source.path), `Backup discovery incomplete: ${message(error)}`); }
  if (discovery) {
    for (const item of planned) item.roots = discovery.roots;
    // This preflight closes the scan window before the source operation. Repeated after source Trash below.
    try { await validateDiscovery(discovery); } catch (error) {
      for (const item of planned.splice(0)) retain(item.path, `Ancillary discovery changed: ${message(error)}`);
    }
  }
  return [...planned, ...registrations];
}

async function assertBackupOwnership(backup: Snapshot, discovery: Discovery): Promise<void> {
  if (discovery.sources.some(candidate => candidate.path === backup.path)) throw new Error(`Backup is a separately registered or current source: ${backup.path}`);
  for (const candidate of discovery.sources) {
    const { references } = await sourceProvenance(discovery, candidate);
    if (references.some(reference => reference.path === backup.path)) throw new Error(`Backup is referenced by another source: ${candidate.path}`);
  }
}
async function validateDiscovery(discovery: Discovery): Promise<void> {
  await revalidateConfiguredRoots(discovery.roots);
  for (const item of discovery.directories) await unchanged(item, true);
  for (const item of discovery.sources) await unchanged(item);
  await revalidateRegistrations(discovery);
  for (const path of discovery.absent) if (await optionalSnapshot(path, true)) throw new Error(`Discovery root appeared: ${path}`);
  await revalidateProvenance(discovery);
  await revalidateConfiguredRoots(discovery.roots);
}

async function revalidateAncillaryDiscovery(item: PlanItem, roots: RemovalAuthorization['roots'], sourcePath: string): Promise<void> {
  if (!item.discovery) return;
  await revalidateProvenance(item.discovery, sourcePath);
  await revalidateRegistrations(item.discovery, sourcePath);
  const current = await discover(roots, sourcePath, item.discovery.roots);
  if (current.sources.some(candidate => candidate.path === sourcePath)) throw new Error(`Source path reappeared during ownership discovery: ${sourcePath}`);
  await assertSourceAbsent(sourcePath);
  if (item.backup) await assertBackupOwnership(item, current);
  // Source Trash changes its bucket metadata. Compare all other source/marker revisions
  // and directory identities plus the entire discovered namespace, not that mtime.
  const fingerprint = (value: Discovery, excludeRemovedSource: boolean) => [
    ...value.sources.filter(file => !excludeRemovedSource || file.path !== sourcePath).map(file => `file:${file.path}:${stamp(file.info)}`),
    ...value.markers.map(marker => `marker:${marker.item.path}:${stamp(marker.item.info)}:${marker.target}:${marker.binding.reference}`),
    ...value.directories.map(directory => `directory:${directory.path}:${directory.info.dev}:${directory.info.ino}:${directory.info.birthtimeNs}`),
    ...value.absent.map(path => `absent:${path}`),
  ].sort().join('\n');
  if (fingerprint(current, false) !== fingerprint(item.discovery, true)) throw new Error('Resource ownership discovery changed after source removal');
}

/** No renderer paths are interpreted until the main adapter grants the exact target under admission. */
export async function removeSession(target: SessionRemovalTarget, dependencies: SessionRemovalDependencies): Promise<SessionRemovalResult> {
  const result: SessionRemovalResult = { disposition: 'retained', sourceRemoved: false, sessionId: target.sessionId, affectedRuntimeIds: [], trashed: [], retained: [], errors: [], warnings: [] };
  try {
    return await dependencies.withAdmission(target, async auth => {
      let planned: PlanItem[] = [];
      try {
        if (!auth.sessionId || auth.sessionId !== target.sessionId) throw new Error('Authenticated session identity changed');
        result.sourcePath = auth.source.path;
        if (target.kind === 'saved' && target.path !== auth.source.path) throw new Error('Saved removal path changed');
        if (auth.source.status === 'unavailable') throw new Error('Session source is unavailable');
        const empty = target.kind === 'runtime' && auth.initialEmpty && auth.source.status === 'unpersisted' && !!auth.close;
        if (auth.source.status === 'unpersisted' && !empty) throw new Error('Only an exact owned initial session may be discarded');
        if (target.kind === 'runtime' && !auth.close) throw new Error('Owned runtime shutdown is required');
        await auth.revalidate('before-close');
        const path = auth.source.path;
        const initial = path ? await optionalSnapshot(path) : undefined;
        if (!initial && !empty) throw new Error('Previously persisted source is missing');
        if (initial && (await summary(initial)).id !== auth.sessionId) throw new Error('Native source identity does not match the target');
        if (auth.close) {
          result.affectedRuntimeIds = [...auth.affectedRuntimeIds];
          const outcome = await auth.close();
          if (!outcome.clean || outcome.forced || outcome.exitCode !== 0 || outcome.signal || outcome.error) throw new Error(`Owned shutdown was not clean; source retained${outcome.error ? `: ${outcome.error}` : ''}`);
        }
        await auth.revalidate('after-close');
        const current = path ? await optionalSnapshot(path) : undefined;
        if (!current) {
          if (!empty || initial) throw new Error('Source disappeared during shutdown; removal is not proven');
          result.sourceRemoved = true;
          result.disposition = 'discarded';
          return result;
        }
        if (initial && !(initial.info.dev === current.info.dev && initial.info.ino === current.info.ino && initial.info.birthtimeNs === current.info.birthtimeNs)) throw new Error('Source was replaced during shutdown');
        if (initial && !auth.close && stamp(initial.info) !== stamp(current.info)) throw new Error('Saved source changed during admission');
        const header = await summary(current);
        if (header.id !== auth.sessionId) throw new Error('Native source identity changed during shutdown');
        planned = await planAncillary(auth, current, header, result);
        for (let index = planned.length - 1; index >= 0; index--) {
          const item = planned[index]!;
          try {
            await revalidateConfiguredRoots(item.roots);
            if (item.tree) await unchangedTree(item.tree); else await unchanged(item);
            await revalidateWorkspaces(item.workspaces, item.path);
            const writers = await auth.inspectWriters(item.path, !!item.tree);
            if (!writers.safe) throw new RetentionError('writer', writers.reason || 'Ancillary writer exclusion could not be established');
            await revalidateConfiguredRoots(item.roots);
            await revalidateProvenance(item.discovery);
            await revalidateRegistrations(item.discovery);
            if (item.registration) await revalidateRegisteredSource(item.registration);
          } catch (error) {
            result.retained.push({ path: item.path, reason: message(error), reasonCode: error instanceof RetentionError ? error.reasonCode : 'unverified' });
            planned.splice(index, 1);
          }
        }
        await auth.revalidate('before-trash');
        const occupancy = await auth.inspectWriters(current.path, false);
        if (!occupancy.safe && !(occupancy.uncertain && target.allowUncertain)) throw new RemovalOccupancyError(occupancy.uncertain ? 'unknown' : 'external', occupancy.reason || 'Source writer exclusion could not be established');
        await unchanged(current);
        await dependencies.trashItem(current.path);
        result.sourceRemoved = true;
        result.trashed.push(current.path);
        // The source is gone: each later failure is explicit partial success, never rollback fiction.
        for (const item of planned) {
          try {
            await assertSourceAbsent(current.path);
            if (item.tree) await unchangedTree(item.tree); else await unchanged(item);
            const writers = await auth.inspectWriters(item.path, !!item.tree);
            if (!writers.safe) throw new RetentionError('writer', writers.reason || 'Ancillary writer exclusion could not be established');
            await revalidateAncillaryDiscovery(item, auth.roots, current.path);
            await revalidateWorkspaces(item.workspaces, item.path);
            if (item.tree) await unchangedTree(item.tree); else await unchanged(item);
            await revalidateConfiguredRoots(item.roots);
            await revalidateProvenance(item.discovery, current.path);
            await revalidateRegistrations(item.discovery, current.path);
            if (item.registration) { await revalidateRegisteredSource(item.registration, current.path); await unchanged(item); }
            await assertSourceAbsent(current.path);
            await dependencies.trashItem(item.path);
            result.trashed.push(item.path);
          } catch (error) {
            const reason = message(error);
            result.retained.push({ path: item.path, reason, reasonCode: error instanceof RetentionError ? error.reasonCode : 'unverified' });
            result.errors.push(`${item.path}: ${reason}`);
          }
        }
        result.disposition = result.errors.length || result.retained.length || result.warnings.length ? 'partial' : 'trashed';
        return result;
      } catch (error) {
        const reason = message(error);
        if (error instanceof RemovalOccupancyError) result.occupancy = { status: error.status, reason };
        result.errors.push(reason);
        if (result.sourcePath && !result.sourceRemoved) result.retained.push({ path: result.sourcePath, reason });
        if (!result.sourceRemoved) for (const item of planned) result.retained.push({ path: item.path, reason: 'Source removal failed; ancillary item was not touched' });
        result.disposition = result.sourceRemoved ? 'partial' : 'retained';
        return result;
      }
    });
  } catch (error) { if (error instanceof RemovalOccupancyError) result.occupancy = { status: error.status, reason: error.message }; result.errors.push(message(error)); return result; }
  finally {
    const companion = result.sourcePath?.replace(/\.jsonl(?:\.gz)?$/, '');
    for (const item of result.retained) item.kind = item.path === result.sourcePath ? 'source' : companion !== result.sourcePath && item.path === companion ? 'companion' : 'associated';
  }
}

/** Observation only, not a cross-client lease. Any open descriptor conservatively retains the item. */
export async function inspectRemovalWriters(path: string, tree: boolean): Promise<{ safe: boolean; reason?: string; uncertain?: boolean }> {
  if (process.platform !== 'darwin') return { safe: false, uncertain: true, reason: 'Removal writer inspection is supported only on macOS' };
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
    execFile('/usr/sbin/lsof', args, { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) reject(error);
      else resolveResult({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
  try {
    const help = await run(['-h']);
    const text = help.stdout + help.stderr;
    if (![0, 1].includes(help.code) || !/lsof/i.test(text) || !/(?:usage|help|list open files)/i.test(text)) throw new Error('Open-file inspection capabilities unavailable');
    const args = ['-nP', '-l', ...(/(?:^|\s)-D/.test(text) ? ['-Di'] : []), '-F0pfn', ...(tree ? ['+D', path] : ['--', path])];
    // Re-observe the exact path to avoid retaining it for a descriptor that closed
    // between enumeration and the removal decision. Ancillary checks stay strict.
    for (let attempt = 0; attempt < 3; attempt++) {
      const observed = await run(args);
      if (relevantLsofDiagnostics(observed.stderr, path) || ![0, 1].includes(observed.code)) return { safe: false, uncertain: true, reason: 'Open-file inspection was indeterminate' };
      if (observed.code === 1 && !observed.stdout.trim()) return { safe: true };
      if (!observed.stdout.endsWith('\0\n') || !/^p[1-9]\d*\0/.test(observed.stdout)) return { safe: false, uncertain: true, reason: 'Open-file inspection was incomplete' };
    }
    return { safe: false, reason: 'Open descriptors remain on the removal target' };
  } catch (error) { return { safe: false, uncertain: true, reason: `Open-file inspection failed: ${message(error)}` }; }
}
