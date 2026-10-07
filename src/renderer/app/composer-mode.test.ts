import test from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryView } from './history-store';
import type { HistorySnapshot, SessionAccess } from '../../shared/contracts';
import { runtimeComposerReady, savedComposerMode, savedSessionHeader } from './composer-mode';
import { ComposerDraft } from '../chat/composer/drafts';

const session: HistorySnapshot['session'] = { id: 'saved', path: '/saved.jsonl', cwd: '/project', title: 'Saved', preview: '', updatedAt: '', sourceKind: 'journal', writable: true, canFork: true };
const view: HistoryView = { options: { path: session.path }, snapshot: { session, access: { status: 'idle', checkedAt: 1 }, revision: 'one', leafId: 'tip', selectedLeafId: 'tip', messages: [], hasMore: false, diagnostics: [] }, access: { status: 'idle', checkedAt: 1 }, loading: false, paging: false, error: '', chat: null };

test('latest writable journal opens the editor and admits resume-on-send only when idle', () => {
  assert.deepEqual(savedComposerMode(view), { readonly: false, ready: true, canFork: true, category: 'ready' });
  for (const status of ['unknown', 'owned'] as SessionAccess['status'][]) {
    assert.deepEqual(savedComposerMode({ ...view, access: { status, checkedAt: 2 } }), { readonly: false, ready: false, canFork: true, category: 'unknown' });
  }
});

test('checking keeps the editor, then external access switches to a forkable readonly bar', () => {
  const checking = { ...view, snapshot: undefined, access: undefined, loading: true };
  assert.deepEqual(savedComposerMode(checking), { readonly: false, ready: false, canFork: false, category: 'checking' });
  assert.equal(savedComposerMode({ ...view, access: undefined }).category, 'checking');
  assert.deepEqual(savedComposerMode({ ...view, access: { status: 'external', checkedAt: 2 } }), { readonly: true, ready: false, canFork: true, category: 'external' });
  assert.equal(savedComposerMode(view).readonly, false);
});

test('pending access never admits sending or reports external ownership', () => {
  for (const status of ['idle', 'owned', 'external', 'unknown'] as const) {
    const mode = savedComposerMode({ ...view, access: { status, pending: true, checkedAt: 0 } });
    assert.equal(mode.ready, false);
    assert.equal(mode.readonly, false);
    assert.equal(mode.category, 'checking');
  }
});

test('historical nodes including root never admit sends; archive and nonwritable sources stay readonly', () => {
  for (const leafId of ['older', null]) assert.deepEqual(savedComposerMode({ ...view, options: { ...view.options, leafId } }), { readonly: true, ready: false, canFork: true, category: 'historical' });
  for (const source of [{ ...session, writable: false }, { ...session, sourceKind: 'archive' as const }]) assert.deepEqual(savedComposerMode({ ...view, snapshot: { ...view.snapshot!, session: source } }), { readonly: true, ready: false, canFork: true, category: 'readonly' });
});

test('fork capability requires a readable loaded snapshot, not write access', () => {
  for (const status of ['idle', 'external', 'unknown', 'owned'] as const) {
    const input = { ...view, access: { status, checkedAt: 2 } };
    assert.equal(savedComposerMode(input).canFork, true);
    assert.equal(savedComposerMode({ ...input, loading: true }).canFork, false);
    assert.equal(savedComposerMode({ ...input, error: 'Source missing' }).canFork, false);
    assert.equal(savedComposerMode({ ...input, snapshot: { ...view.snapshot!, session: { ...session, canFork: false } } }).canFork, false);
  }
  assert.deepEqual(savedComposerMode({ ...view, error: 'Source missing' }), { readonly: false, ready: false, canFork: false, category: 'source-unavailable' });
});

test('saved header stays neutral for editable readers and marks only genuinely readonly modes', () => {
  for (const input of [view, {...view, loading:true}, {...view, access:{status:'unknown' as const,checkedAt:2}}]) {
    const mode=savedComposerMode(input);
    assert.equal(mode.readonly,false);
    assert.equal(savedSessionHeader(mode),null);
  }
  for (const input of [{...view,options:{...view.options,leafId:null}}, {...view,access:{status:'external' as const,checkedAt:2}}, {...view,snapshot:{...view.snapshot!,session:{...session,sourceKind:'archive' as const}}}]) {
    const mode=savedComposerMode(input);
    assert.equal(mode.readonly,true);
    assert.equal(savedSessionHeader(mode),'omp.history.readonly');
  }
});

test('immediate Enter stays pending through access checks and submits exactly once', async () => {
  const draft = new ComposerDraft();
  draft.setDraft({ text: 'First request', attachments: [], references: [] });
  const admission = Promise.withResolvers<void>();
  let submissions = 0;
  assert.equal(runtimeComposerReady(undefined, undefined, true, ''), true);
  assert.equal(runtimeComposerReady({ closed: false }, undefined, false, ''), true);
  const send = () => draft.submit(async () => { await admission.promise; submissions++; });
  const pending = send();
  await send();
  assert.equal(draft.getSnapshot().pending?.text, 'First request');
  assert.equal(submissions, 0);
  admission.resolve();
  await pending;
  assert.equal(submissions, 1);
  assert.equal(draft.draft.text, '');
  assert.equal(draft.getSnapshot().pending, undefined);
});

test('known denials and disconnected runtimes never accept queued intent', () => {
  assert.equal(runtimeComposerReady({ closed: false }, { canSend: false }, true, ''), false);
  assert.equal(runtimeComposerReady({ closed: true }, undefined, true, ''), false);
  assert.equal(runtimeComposerReady({ closed: false }, undefined, true, 'Startup failed'), false);
  assert.equal(runtimeComposerReady(undefined, undefined, false, ''), false);
});
