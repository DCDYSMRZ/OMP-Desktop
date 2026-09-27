import type { Attachment } from '../../../shared/contracts';
import type { ComposerFileReference } from './model';

export interface Draft { text: string; references: ComposerFileReference[]; attachments: Attachment[] }
export interface DraftSnapshot { draft: Draft; busy: boolean; error: string }

/** Logical composition survives worker adoption, view remounts and async completion. */
export class ComposerDraft {
  private snapshot: DraftSnapshot = { draft: { text: '', references: [], attachments: [] }, busy: false, error: '' };
  private readonly listeners = new Set<() => void>();
  private appliedEditorId?: string;
  getSnapshot = (): DraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get draft(): Draft { return this.snapshot.draft; }
  private publish(patch: Partial<DraftSnapshot>): void { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  setDraft(draft: Draft): void { this.publish({ draft }); }
  setError(error: string): void { this.publish({ error }); }
  applyEditor(id: string, text: string): void {
    if (this.appliedEditorId === id) return;
    this.appliedEditorId = id;
    this.setDraft({ ...this.draft, text, references: [] });
  }
  moveTo(target: ComposerDraft, editorId?: string): void {
    if (target === this) return;
    target.appliedEditorId = editorId;
    target.publish({ draft: this.snapshot.draft, error: '' });
    this.publish({ draft: { text: '', references: [], attachments: [] }, error: '' });
  }
  async perform(action: () => Promise<void>): Promise<void> {
    if (this.snapshot.busy) return;
    this.publish({ busy: true, error: '' });
    try { await action(); } catch (cause) { this.publish({ error: String(cause) }); } finally { this.publish({ busy: false }); }
  }
  async submit(send: (draft: Draft) => Promise<void>): Promise<void> {
    if (this.snapshot.busy) return;
    const submitted = this.snapshot.draft;
    this.publish({ busy: true, error: '' });
    try {
      await send(submitted);
      // Clear only the accepted composition; keep edits made during admission.
      if (this.snapshot.draft === submitted) this.publish({ draft: { text: '', references: [], attachments: [] } });
      else if (submitted.attachments.length) {
        const accepted = new Set(submitted.attachments.map(attachment => attachment.id));
        this.publish({ draft: { ...this.snapshot.draft, attachments: this.snapshot.draft.attachments.filter(attachment => !accepted.has(attachment.id)) } });
      }
    } catch (cause) { this.publish({ error: String(cause) }); }
    finally { this.publish({ busy: false }); }
  }
}
const drafts = new Map<string, ComposerDraft>();
export function getComposerDraft(key: string): ComposerDraft {
  let draft = drafts.get(key);
  if (!draft) { draft = new ComposerDraft(); drafts.set(key, draft); }
  return draft;
}
