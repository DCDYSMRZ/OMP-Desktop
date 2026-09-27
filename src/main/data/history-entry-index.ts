import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { HistoryTreeNode } from '../../shared/contracts';

export interface IndexedHistoryEntry extends HistoryTreeNode {
  offset: number; length: number; visible: boolean; oversized?: boolean; method?: string; firstKept?: string | number; tokensBefore?: number;
}

/** One disposable metadata index. No transcript payloads, original writes, or reusable history database.
 * SQLite page cache: 8 MiB; database: 2 GiB maximum; no mmap/journal. Deleted on source eviction/reader close.
 * Selected ancestry lives on disk too, so branch depth never creates an unbounded JavaScript array/set. */
export class HistoryEntryIndex {
  private readonly directory = mkdtempSync(join(tmpdir(), 'omp-desktop-history-index-'));
  private readonly db!: DatabaseSync;
  private readonly find: StatementSync;
  private readonly exists: StatementSync;
  private readonly insert: StatementSync;
  private readonly label: StatementSync;
  private selectedLeaf?: string | null;
  private selectedDiagnostics: string[] = [];
  private closed = false;

  constructor() {
    try {
      this.db = new DatabaseSync(join(this.directory, 'metadata.sqlite'));
      this.db.exec('PRAGMA page_size=4096; PRAGMA max_page_count=524288; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; CREATE TABLE entries(id TEXT PRIMARY KEY,parent TEXT,offset INTEGER NOT NULL,visible INTEGER NOT NULL,body TEXT NOT NULL); CREATE INDEX entries_offset ON entries(offset); CREATE TABLE labels(id TEXT PRIMARY KEY,label TEXT NOT NULL); CREATE TABLE selected(id TEXT PRIMARY KEY,position INTEGER UNIQUE NOT NULL); BEGIN');
      this.find = this.db.prepare('SELECT e.body,l.label FROM entries e LEFT JOIN labels l ON l.id=e.id WHERE e.id=?');
      this.exists = this.db.prepare('SELECT 1 FROM entries WHERE id=?');
      this.insert = this.db.prepare('INSERT OR REPLACE INTO entries(id,parent,offset,visible,body) VALUES(?,?,?,?,?)');
      this.label = this.db.prepare('INSERT OR REPLACE INTO labels(id,label) VALUES(?,?)');
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
  set(id: string, entry: IndexedHistoryEntry): void { this.insert.run(id, entry.parentId, entry.offset, entry.visible ? 1 : 0, JSON.stringify(entry)); }
  setLabel(id: string, label: string): void { this.label.run(id, label); }
  finish(): string[] {
    this.db.exec('COMMIT');
    return this.db.prepare('SELECT DISTINCT e.parent FROM entries e LEFT JOIN entries p ON p.id=e.parent WHERE e.parent IS NOT NULL AND p.id IS NULL LIMIT 100').all().map(row => `Missing history parent ${String(row.parent)}`);
  }
  async select(leaf: string | null): Promise<string[]> {
    if (this.selectedLeaf === leaf) return this.selectedDiagnostics;
    this.selectedLeaf = undefined;
    this.db.exec('DELETE FROM selected; BEGIN');
    const remember = this.db.prepare('INSERT OR IGNORE INTO selected(id,position) VALUES(?,?)');
    const parent = this.db.prepare('SELECT parent FROM entries WHERE id=?');
    const diagnostics: string[] = [];
    let current = leaf; let position = 0;
    try {
      while (current !== null) {
        const row = parent.get(current);
        if (!row) { diagnostics.push(`Missing history parent ${current}`); break; }
        if (remember.run(current, position).changes === 0) { diagnostics.push(`History ancestry cycle at ${current}`); break; }
        current = row.parent === null ? null : String(row.parent);
        if (++position % 2000 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        if (this.closed) throw new Error('History reader is closed');
      }
      this.db.exec('COMMIT');
    } catch (error) { if (!this.closed) this.db.exec('ROLLBACK'); throw error; }
    this.selectedLeaf = leaf; this.selectedDiagnostics = diagnostics;
    return diagnostics;
  }
  page(before: string | undefined): IndexedHistoryEntry[] {
    let position = 0;
    if (before !== undefined) {
      const cursor = this.db.prepare('SELECT s.position FROM selected s JOIN entries e ON e.id=s.id WHERE s.id=? AND e.visible=1').get(before);
      if (!cursor) throw new Error('History page cursor no longer belongs to the selected branch');
      position = Number(cursor.position) + 1;
    }
    return this.db.prepare('SELECT e.body,l.label FROM selected s JOIN entries e ON e.id=s.id LEFT JOIN labels l ON l.id=e.id WHERE s.position>=? AND e.visible=1 ORDER BY s.position LIMIT 201').all(position).map(row => {
      const entry = JSON.parse(String(row.body)) as IndexedHistoryEntry;
      if (typeof row.label === 'string') entry.label = row.label;
      return entry;
    });
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
