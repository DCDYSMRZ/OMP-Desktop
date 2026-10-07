import { UserFacingError } from '../lib/user-errors';
import type { NativeFrame, PromptInput, PromptAcceptance } from '../../shared/contracts';
import i18next from 'i18next';

export interface SubmissionReceipt { id: string; runtimeId: string; sessionId: string; input: PromptInput; requestId?: string; status: 'submitting' | 'accepted' | 'queue-accepted' | 'local' | 'completed' | 'aborted' | 'error' | 'unknown'; submittedAt: number; error?: string; sessionSettled?: boolean }
const CAPACITY = 64;
const COMPLETED_RETENTION = 12;
export function submissionReceiptVisible(receipt: SubmissionReceipt, now: number): boolean {
  if (receipt.status === 'submitting') return now - receipt.submittedAt >= 3000;
  return receipt.status === 'queue-accepted' || receipt.status === 'error' && receipt.sessionSettled === undefined || receipt.status === 'unknown';
}
/** Nonpersistent original intent, never a transcript or inferred delivery ledger. */
export class SubmissionStore {
  private receipts: SubmissionReceipt[] = [];
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.receipts;
  private publish(receipts: SubmissionReceipt[]) {
    const successful = receipts.filter(receipt => ['completed', 'local', 'aborted'].includes(receipt.status) || receipt.status === 'error' && receipt.sessionSettled !== undefined);
    const discard = new Set(successful.slice(0, Math.max(0, successful.length - COMPLETED_RETENTION)).map(item => item.id));
    this.receipts = receipts.filter(item => !discard.has(item.id));
    for (const listener of this.listeners) listener();
  }
  begin(runtimeId: string, sessionId: string, input: PromptInput): SubmissionReceipt {
    if (this.receipts.length >= CAPACITY) throw new UserFacingError(i18next.t('omp.intent.capacity'));
    const receipt: SubmissionReceipt = { id: crypto.randomUUID(), runtimeId, sessionId, submittedAt: Date.now(), input: { ...input, attachmentIds: input.attachmentIds ? [...input.attachmentIds] : undefined }, status: 'submitting' };
    this.publish([...this.receipts, receipt]);
    return receipt;
  }
  private update(id: string, change: (receipt: SubmissionReceipt) => SubmissionReceipt) { this.publish(this.receipts.map(item => item.id === id ? change(item) : item)); }
  accepted(id: string, accepted: PromptAcceptance) {
    this.update(id, item => {
      if (!['submitting', 'accepted'].includes(item.status)) return { ...item, requestId: accepted.requestId };
      const local = !!accepted.data && typeof accepted.data === 'object' && 'agentInvoked' in accepted.data && accepted.data.agentInvoked === false;
      return { ...item, requestId: accepted.requestId, status: item.input.mode && item.input.mode !== 'prompt' ? 'queue-accepted' : local ? 'local' : 'accepted' };
    });
  }
  rejected(id: string, error: string) { this.update(id, item => ({ ...item, status: 'error', error })); }
  started(runtimeId: string, correlation: { submissionId?: string; requestId: string; sessionId?: string }) {
    const item = this.receipts.find(value => value.runtimeId === runtimeId && value.id === correlation.submissionId);
    if (!item || item.requestId) return;
    if (item.sessionId !== correlation.sessionId) {
      this.update(item.id, value => ({ ...value, requestId: correlation.requestId, status: 'error', error: i18next.t('omp.intent.targetChanged') }));
      return;
    }
    this.update(item.id, value => ({ ...value, requestId: correlation.requestId }));
  }
  receive(runtimeId: string, frame: NativeFrame) {
    if (frame.type !== 'prompt_result' && !(frame.type === 'response' && frame.success === false)) return;
    const receipt = this.receipts.find(item => item.runtimeId === runtimeId && item.requestId && item.requestId === frame.id);
    if (!receipt) return;
    if (receipt.status === 'error' && frame.status !== 'error' && frame.type !== 'response') return;
    const error = typeof frame.error === 'string' ? frame.error : frame.error && typeof frame.error === 'object' && 'message' in frame.error ? String(frame.error.message) : undefined;
    this.update(receipt.id, item => ({ ...item, status: frame.type === 'response' || frame.status === 'error' ? 'error' : frame.status === 'completed' ? 'completed' : frame.status === 'aborted' ? 'aborted' : 'unknown', error, sessionSettled: typeof frame.sessionSettled === 'boolean' ? frame.sessionSettled : undefined }));
  }
  unobserved(runtimeId: string) { this.publish(this.receipts.map(item => item.runtimeId === runtimeId && ['submitting', 'accepted', 'queue-accepted'].includes(item.status) ? { ...item, status: 'unknown', error: i18next.t('omp.intent.connectionEnded') } : item)); }
  dismiss(id: string) { this.publish(this.receipts.filter(item => item.id !== id || item.status === 'submitting')); }
  forget(runtimeIds: readonly string[]) { this.publish(this.receipts.filter(item => !runtimeIds.includes(item.runtimeId))); }
}
export const submissions = new SubmissionStore();
