import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { AnchoredMenu } from '../../ui/AnchoredMenu';
import type { DesktopQueue, QueuedPrompt, QueueDelivery } from './queue';
import type { ComposerDraft } from './drafts';
import { presentUserError } from '../../lib/user-errors';

export function QueueChips({ items, queue, draftStore, running, onFocus }: { items: QueuedPrompt[]; queue: DesktopQueue; draftStore: ComposerDraft; running: boolean; onFocus: () => void }) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const send = (item: QueuedPrompt, mode: QueueDelivery) => { void queue.send(item.id, mode).catch(() => undefined); };
  const row = (item: QueuedPrompt) => <section key={item.id} className="composer-queued-prompt" tabIndex={0} aria-label={`${t(item.paused ? 'composer.queuePaused' : 'composer.queueWaiting')}: ${item.input.text}`} title={item.input.text}>
    <span className="composer-queued-state" title={t(item.paused ? 'composer.queuePaused' : 'composer.queueWaiting')}>{t(item.paused ? 'composer.queuePaused' : 'composer.queueShort')}</span><span aria-hidden="true">·</span>
    <span className="composer-queued-prompt-text">{item.input.text.split('\n')[0] || item.draft.attachments.map(file => file.name).join(', ')}</span>
    {item.error && <details className="composer-queued-error"><summary title={presentUserError(item.error).message} aria-label={presentUserError(item.error).message}>!</summary><pre>{item.error}</pre></details>}
    <div className="composer-queued-actions">
      <button disabled={item.sending || item.paused && running} onClick={() => send(item, running && !item.paused ? 'steer' : 'prompt')}>{t(running && !item.paused ? 'composer.queueInsert' : 'chat.send')}</button>
      {running && !item.paused && <button disabled={item.sending} onClick={() => send(item, 'abort_and_prompt')}>{t('composer.queueReplace')}</button>}
      <button disabled={item.sending} onClick={() => { const removed = queue.remove(item.id); if (!removed) return; const current = draftStore.draft; draftStore.setDraft({ text: [current.text, removed.draft.text].filter(Boolean).join('\n\n'), references: [...current.references, ...removed.draft.references], attachments: [...current.attachments, ...removed.draft.attachments] }); setMoreOpen(false); onFocus(); }}>{t('composer.queueEdit')}</button>
      <button disabled={item.sending} onClick={() => { const removed = queue.remove(item.id); for (const attachment of removed?.draft.attachments ?? []) void window.ompDesktop.removeAttachment(attachment.id).catch(() => undefined); }}>{t('composer.queueDelete')}</button>
    </div>
  </section>;
  return items.length ? <div className="composer-queued-prompts">{items.slice(0, 3).map(row)}{items.length > 3 && <AnchoredMenu open={moreOpen} onClose={() => setMoreOpen(false)} side="top" align="end" matchAnchorWidth role="dialog" label={t('composer.queueMore', { count: items.length - 3 })} menuClassName="composer-queue-overflow" trigger={ref => <button ref={ref} className="composer-queue-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>{t('composer.queueMore', { count: items.length - 3 })}</button>}>{items.slice(3).map(row)}</AnchoredMenu>}</div> : null;
}
