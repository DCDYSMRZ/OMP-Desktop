import type { DesktopApi, HistoryRead, HistorySnapshot, SessionAccess } from '../../shared/contracts';
import { createChatState, type ChatState } from '../chat/model';
import { errorText } from './runtime-store';
import i18next from 'i18next';
import { readingAnchorMessageIds, recallReadingPosition, rememberReadingPosition } from '../lib/transcript-reading-position';

export interface HistoryView { options: HistoryRead; snapshot?: HistorySnapshot; chat: ChatState | null; access?: SessionAccess; loading: boolean; paging: boolean; error: string }

/** One window follows one durable journal; no runtime is created by this store. */
export class HistoryStore {
  private value: HistoryView | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private update = 0;
  private watchQueue: Promise<unknown> = Promise.resolve();
  constructor(private api: DesktopApi) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.value;
  private publish(value: HistoryView | null) { this.value = value; for (const listener of this.listeners) listener(); }
  private fail(error: unknown) { if (this.value) this.publish({ ...this.value, loading: false, paging: false, error: errorText(error), access: { status: 'unknown', reason: errorText(error), checkedAt: Date.now() } }); }
  connect() {
    const detach = this.api.onHistoryEvent(event => {
      if (!this.value || (event.path !== this.value.options.path && event.path !== this.value.snapshot?.session.path)) return;
      if (event.kind === 'error') { this.update++; this.fail(event.error); }
      else if (event.kind === 'access') this.publish({ ...this.value, access: event.access });
      else if (!this.value.loading && (this.value.options.leafId === undefined || event.snapshot.selectedLeafId === this.value.options.leafId)) void this.replace(event.snapshot);
    });
    return () => { detach(); this.clear(); };
  }
  clear() {
    this.generation++; this.update++; this.publish(null);
    this.watchQueue = this.watchQueue.catch(() => undefined).then(() => this.api.unwatchHistory()).catch(() => undefined);
  }
  async select(options: HistoryRead) {
    const generation = ++this.generation; this.update++;
    const previous = this.value?.options.path === options.path ? this.value : null;
    this.publish({ options, snapshot: previous?.snapshot, chat: previous?.chat ?? null, loading: true, paging: false, error: '' });
    const operation = this.watchQueue.catch(() => undefined).then(async () => {
      if (generation !== this.generation) return;
      try {
        const snapshot = await this.api.watchHistory(options);
        if (generation === this.generation) await this.replace(snapshot, previous?.options.leafId === options.leafId);
      } catch (error) { if (generation === this.generation) this.fail(error); }
    });
    this.watchQueue = operation;
    await operation;
  }
  private project(snapshot: HistorySnapshot): ChatState {
    const chat = createChatState({ runtimeId: `history:${snapshot.session.path}`, cwd: snapshot.session.cwd, state: { sessionId: snapshot.session.id, sessionFile: snapshot.session.path, sessionName: snapshot.session.title, isStreaming: false, isSettled: true }, messages: snapshot.messages.map(message => message.raw), messageIds: snapshot.messages.map(message => message.id), models: [], commands: [], thinkingLevels: [] });
    chat.messages=chat.messages.map((message,index)=>({...message,resourceReference:snapshot.messages[index]?.resourceReference}));
    return chat;
  }
  private async replace(latest: HistorySnapshot, retainPages = true) {
    const current = this.value; if (!current) return;
    const generation = this.generation, update = ++this.update;
    const oldestId = retainPages ? current.snapshot?.messages[0]?.id : undefined;
    const readingKey = `history:${latest.session.path}:${latest.session.id}`;
    const readingPosition = recallReadingPosition(readingKey);
    const readingIds = readingAnchorMessageIds(readingPosition);
    const targets = new Set(readingIds);
    if (oldestId) targets.add(oldestId);
    for (const message of latest.messages) targets.delete(message.id);
    let snapshot = latest;
    try {
      // Rebuild the saved reader's window before publishing a shorter latest
      // page. The durable row survives page-boundary shifts and new appends.
      while (snapshot.hasMore && snapshot.nextBefore && targets.size > 0) {
        const page = await this.api.readHistory({ ...current.options, leafId: latest.selectedLeafId, before: snapshot.nextBefore });
        if (generation !== this.generation || update !== this.update) return;
        if (page.revision !== latest.revision) throw new Error(i18next.t('omp.history.revisionChanged'));
        for (const message of page.messages) targets.delete(message.id);
        snapshot = { ...latest, messages: [...page.messages, ...snapshot.messages], hasMore: page.hasMore, nextBefore: page.nextBefore, diagnostics: [...new Set([...snapshot.diagnostics, ...page.diagnostics])] };
      }
      if (generation !== this.generation || update !== this.update) return;
      if (!snapshot.hasMore && readingIds.length > 0 && readingIds.every(id => targets.has(id))) {
        // Only an exhausted, revision-consistent history proves disappearance.
        // A failed read never discards the durable anchor.
        snapshot = latest;
        rememberReadingPosition(readingKey, { scrollTop: 0, following: true, anchors: [] });
      }
      this.publish({ ...current, snapshot, chat: this.project(snapshot), access: this.value?.access && this.value.access.checkedAt > snapshot.access.checkedAt ? this.value.access : snapshot.access, loading: false, paging: false, error: '' });
    } catch (error) { if (generation === this.generation && update === this.update) this.fail(error); }
  }
  async older() {
    const current = this.value, snapshot = current?.snapshot;
    if (!current || !snapshot?.hasMore || !snapshot.nextBefore || current.paging) return;
    const generation = this.generation, update = ++this.update;
    this.publish({ ...current, paging: true });
    try {
      const page = await this.api.readHistory({ ...current.options, leafId: snapshot.selectedLeafId, before: snapshot.nextBefore });
      if (generation !== this.generation || update !== this.update) return;
      if (page.revision !== snapshot.revision) {
        const latest = await this.api.readHistory(current.options);
        if (generation !== this.generation || update !== this.update) return;
        await this.replace(latest);
        return;
      }
      const ids = new Set(snapshot.messages.map(message => message.id));
      const merged = { ...snapshot, messages: [...page.messages.filter(message => !ids.has(message.id)), ...snapshot.messages], hasMore: page.hasMore, nextBefore: page.nextBefore, diagnostics: [...new Set([...page.diagnostics, ...snapshot.diagnostics])] };
      this.publish({ ...this.value!, snapshot: merged, chat: this.project(merged), paging: false, error: '' });
    } catch (error) { if (generation === this.generation && update === this.update) this.fail(error); }
  }
}
