import { preserveUserError } from '../../lib/user-errors';
import type { Attachment } from '../../../shared/contracts';
import type { ComposerFileReference } from './model';

export interface Draft { text: string; references: ComposerFileReference[]; attachments: Attachment[] }
export interface DraftSnapshot { draft: Draft; busy: boolean; error: Error | string; pending?: Draft }

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
  setError(error: unknown): void { this.publish({ error: preserveUserError(error) }); }
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
    try { await action(); } catch (cause) { this.setError(cause); } finally { this.publish({ busy: false }); }
  }
  async submit(send: (draft: Draft) => Promise<void>): Promise<void> {
    if (this.snapshot.busy) return;
    const submitted = this.snapshot.draft;
    this.publish({ busy: true, error: '', pending: submitted });
    try {
      await send(submitted);
      const current = this.snapshot.draft;
      const text = current.text === submitted.text ? '' : current.text;
      const acceptedAttachments = new Set(submitted.attachments.map(item => item.id));
      const acceptedReferences = new Set(submitted.references.map(item => item.id));
      this.publish({ draft: { text, attachments: current.attachments.filter(item => !acceptedAttachments.has(item.id)), references: current.references.filter(item => !acceptedReferences.has(item.id) || !!item.token && text.includes(item.token)) } });
    } catch (cause) {
      // Admission never owns the editable draft; a rejection leaves current edits intact.
      this.setError(cause);
    }
    finally { this.publish({ busy: false, pending: undefined }); }
  }
}
const drafts = new Map<string, ComposerDraft>();
export function getComposerDraft(key: string): ComposerDraft {
  let draft = drafts.get(key);
  if (!draft) { draft = new ComposerDraft(); drafts.set(key, draft); }
  return draft;
}
export function forgetComposerDraft(key: string): void { drafts.delete(key); }
