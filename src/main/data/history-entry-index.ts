import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { HistoryTreeNode, NativeMessage } from '../../shared/contracts';
import type { ActivitySignal } from './session-observer';

export interface IndexedHistoryEntry extends HistoryTreeNode {
  offset: number; length: number; visible: boolean; oversized?: boolean; method?: string; firstKept?: string | number; tokensBefore?: number;
  activity?: ActivitySignal;
  evidence?: NativeMessage;
}

/** One disposable metadata index. No transcript payloads, original writes, or reusable history database.
 * SQLite page cache: 8 MiB; no mmap/journal or cumulative history-size quota. Deleted on source eviction/reader close.
 * Selected ancestry lives on disk too, so branch depth never creates an unbounded JavaScript array/set. */
export class HistoryEntryIndex {
  private readonly directory = mkdtempSync(join(tmpdir(), 'omp-desktop-history-index-'));
  private readonly db!: DatabaseSync;
  private readonly find: StatementSync;
  private readonly exists: StatementSync;
  private readonly insert: StatementSync;
  private readonly label: StatementSync;
  private readonly selectionByKind: StatementSync;
  private readonly insertTool: StatementSync;
  private readonly deleteTools: StatementSync;
  private selectedLeaf?: string | null;
  private selectedStart = 0;
  private selectedDiagnostics: string[] = [];
  private closed = false;

  constructor() {
    try {
      this.db = new DatabaseSync(join(this.directory, 'metadata.sqlite'));
      this.db.exec('PRAGMA page_size=4096; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; CREATE TABLE entries(id TEXT PRIMARY KEY,parent TEXT,offset INTEGER NOT NULL,visible INTEGER NOT NULL,kind TEXT,body TEXT NOT NULL); CREATE INDEX entries_offset ON entries(offset); CREATE TABLE labels(id TEXT PRIMARY KEY,label TEXT NOT NULL); CREATE TABLE selected(id TEXT PRIMARY KEY,position INTEGER UNIQUE NOT NULL,kind TEXT); CREATE INDEX selected_kind_position ON selected(kind,position) WHERE kind IS NOT NULL; BEGIN');
      this.db.exec('CREATE TABLE evidence_tools(entry TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL); CREATE INDEX evidence_tool_identity ON evidence_tools(id,kind); CREATE INDEX evidence_tool_entry ON evidence_tools(entry)');
      this.insertTool = this.db.prepare('INSERT INTO evidence_tools(entry,id,kind) VALUES(?,?,?)');
      this.deleteTools = this.db.prepare('DELETE FROM evidence_tools WHERE entry=?');
      this.find = this.db.prepare('SELECT e.body,l.label FROM entries e LEFT JOIN labels l ON l.id=e.id WHERE e.id=?');
      this.exists = this.db.prepare('SELECT 1 FROM entries WHERE id=?');
      this.insert = this.db.prepare('INSERT OR REPLACE INTO entries(id,parent,offset,visible,kind,body) VALUES(?,?,?,?,?,?)');
      this.label = this.db.prepare('INSERT OR REPLACE INTO labels(id,label) VALUES(?,?)');
      this.selectionByKind = this.db.prepare('SELECT body FROM entries WHERE id=(SELECT id FROM selected WHERE kind=? ORDER BY position LIMIT 1)');
    } catch (error) {
      this.db?.close();
      rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
  }
  has(id: string): boolean { return this.exists.get(id) !== undefined; }
  get(id: string): IndexedHistoryEntry | undefined {
    const row = this.find.get(id);
    if (!row) return undefined;
    const entry = JSON.parse(String(row.body)) as IndexedHistoryEntry;
    if (typeof row.label === 'string') entry.label = row.label;
    return entry;
  }
  set(id: string, entry: IndexedHistoryEntry): void {
    if (this.has(id)) this.selectedLeaf = undefined;
    this.insert.run(id, entry.parentId, entry.offset, entry.visible ? 1 : 0, entry.role === 'assistant' ? 'assistant' : entry.type === 'thinking_level_change' ? 'thinking_level_change' : null, JSON.stringify(entry));
    this.deleteTools.run(id);
    const raw = entry.evidence;
    if (raw?.role === 'assistant' && Array.isArray(raw.content)) for (const value of raw.content) {
      const block = value as Record<string, unknown>;
      if (block.type === 'toolCall' && typeof block.id === 'string') this.insertTool.run(id, block.id, 'call');
    }
    if (raw?.role === 'toolResult' && typeof raw.toolCallId === 'string') this.insertTool.run(id, raw.toolCallId, 'result');
  }
  setLabel(id: string, label: string): void { this.label.run(id, label); }
  finish(): string[] {
    this.db.exec('COMMIT');
    return this.db.prepare('SELECT DISTINCT e.parent FROM entries e LEFT JOIN entries p ON p.id=e.parent WHERE e.parent IS NOT NULL AND p.id IS NULL LIMIT 100').all().map(row => `Missing history parent ${String(row.parent)}`);
  }
  async select(leaf: string | null): Promise<string[]> {
    if (this.selectedLeaf === leaf) return this.selectedDiagnostics;
    // Most observations append a short suffix to the selected branch. Retain its
    // disk-backed ancestry instead of walking all historical entries again.
    if (this.selectedLeaf !== undefined && this.selectedLeaf !== null && leaf !== null) {
      const suffix: string[] = [];
      let current: string | null = leaf;
      while (current !== null && current !== this.selectedLeaf && suffix.length < 1000) {
        const entry = this.get(current);
        if (!entry || suffix.includes(current)) break;
        suffix.push(current); current = entry.parentId;
      }
      if (current === this.selectedLeaf) {
        const insert = this.db.prepare('INSERT INTO selected(id,position,kind) SELECT id,?,kind FROM entries WHERE id=?');
        this.db.exec('BEGIN');
        for (let i = suffix.length - 1; i >= 0; i--) insert.run(--this.selectedStart, suffix[i]!);
        this.db.exec('COMMIT'); this.selectedLeaf = leaf;
        return this.selectedDiagnostics;
      }
    }
    this.selectedLeaf = undefined;
    this.db.exec('DELETE FROM selected; BEGIN');
    this.selectedStart = 0;
    const remember = this.db.prepare('INSERT OR IGNORE INTO selected(id,position,kind) VALUES(?,?,?)');
    const parent = this.db.prepare('SELECT parent,kind FROM entries WHERE id=?');
    const diagnostics: string[] = [];
    let current = leaf; let position = 0;
    try {
      while (current !== null) {
        const row = parent.get(current);
        if (!row) { diagnostics.push(`Missing history parent ${current}`); break; }
        if (remember.run(current, position, row.kind).changes === 0) { diagnostics.push(`History ancestry cycle at ${current}`); break; }
        current = row.parent === null ? null : String(row.parent);
        if (++position % 2000 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        if (this.closed) throw new Error('History reader is closed');
      }
      this.db.exec('COMMIT');
    } catch (error) { if (!this.closed) this.db.exec('ROLLBACK'); throw error; }
    this.selectedLeaf = leaf; this.selectedDiagnostics = diagnostics;
    return diagnostics;
  }
  page(before: string | undefined, anchor?: string): IndexedHistoryEntry[] {
    let position = this.selectedStart;
    if (before !== undefined) {
      const cursor = this.db.prepare('SELECT s.position FROM selected s JOIN entries e ON e.id=s.id WHERE s.id=? AND e.visible=1').get(before);
      if (!cursor) throw new Error('History page cursor no longer belongs to the selected branch');
      position = Number(cursor.position) + 1;
    }
    if (anchor !== undefined) {
      const cursor = this.db.prepare('SELECT s.position FROM selected s JOIN entries e ON e.id=s.id WHERE s.id=? AND e.visible=1').get(anchor);
      if (!cursor) throw new Error('Reading anchor no longer belongs to the selected branch');
      position = Number(cursor.position);
    }
    return this.db.prepare('SELECT e.body,l.label FROM selected s JOIN entries e ON e.id=s.id LEFT JOIN labels l ON l.id=e.id WHERE s.position>=? AND e.visible=1 ORDER BY s.position LIMIT 201').all(position).map(row => {
      const entry = JSON.parse(String(row.body)) as IndexedHistoryEntry;
      if (typeof row.label === 'string') entry.label = row.label;
      return entry;
    });
  }
  forwardPage(after?: string): IndexedHistoryEntry[] {
    const cursor = after === undefined ? undefined : this.db.prepare('SELECT position FROM selected WHERE id=?').get(after);
    if (after !== undefined && !cursor) throw new Error('Evidence cursor no longer belongs to the selected branch');
    return this.db.prepare('SELECT e.body FROM selected s JOIN entries e ON e.id=s.id WHERE s.position<? AND e.visible=1 ORDER BY s.position DESC LIMIT 201').all(cursor ? Number(cursor.position) : Number.MAX_SAFE_INTEGER).map(row => JSON.parse(String(row.body)) as IndexedHistoryEntry);
  }
  matchEvidenceTool(options: { startId: string; endId?: string; toolId: string; entryId: string; result?: boolean; late?: boolean }): { count: number; result?: IndexedHistoryEntry; reused: boolean } {
    const position = (id: string) => { const row = this.db.prepare('SELECT position FROM selected WHERE id=?').get(id); if (!row) throw new Error('Evidence interval no longer belongs to the selected branch'); return Number(row.position); };
    const start = position(options.startId), end = options.endId === undefined ? Number.MIN_SAFE_INTEGER : position(options.endId), entry = position(options.entryId);
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM evidence_tools t JOIN selected s ON s.id=t.entry WHERE t.id=? AND t.kind='call' AND s.position<=? AND s.position>?").get(options.toolId, start, options.result ? entry : end)!.count);
    if (options.result || count !== 1) return { count, reused: false };
    const query = this.db.prepare("SELECT e.body FROM evidence_tools t JOIN selected s ON s.id=t.entry JOIN entries e ON e.id=t.entry WHERE t.id=? AND t.kind='result' AND s.position<? AND s.position>? ORDER BY s.position DESC LIMIT 1");
    let matched = query.get(options.toolId, entry, end);
    const reused = options.late === true && !!this.db.prepare("SELECT 1 FROM evidence_tools t JOIN selected s ON s.id=t.entry WHERE t.id=? AND t.kind='call' AND s.position<=? LIMIT 1").get(options.toolId, end);
    if (!matched && options.late && !reused) matched = query.get(options.toolId, entry, Number.MIN_SAFE_INTEGER);
    return { count, reused, ...(matched ? { result: JSON.parse(String(matched.body)) as IndexedHistoryEntry } : {}) };
  }

  selectionEntries(): IndexedHistoryEntry[] {
    const entries: IndexedHistoryEntry[] = [];
    for (const kind of ['assistant', 'thinking_level_change']) {
      const row = this.selectionByKind.get(kind);
      if (row) entries.push(JSON.parse(String(row.body)) as IndexedHistoryEntry);
    }
    return entries;
  }
  tree(before: number): IndexedHistoryEntry[] {
    return this.db.prepare('SELECT e.body,l.label FROM entries e LEFT JOIN labels l ON l.id=e.id WHERE e.offset<? ORDER BY e.offset DESC LIMIT 1001').all(before).map(row => {
      const entry = JSON.parse(String(row.body)) as IndexedHistoryEntry;
      if (typeof row.label === 'string') entry.label = row.label;
      return entry;
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { rmSync(this.directory, { recursive: true, force: true }); }
  }
}
