import { UserFacingError } from '../lib/user-errors';
import type { DesktopApi, HistoryRead, HistorySnapshot, SessionAccess } from '../../shared/contracts';
import { createChatState, record, text, type ChatState } from '../chat/model';
import { errorText } from './runtime-store';
import i18next from 'i18next';
import { readingAnchorMessageIds, recallReadingPosition, rememberReadingPosition } from '../lib/transcript-reading-position';
import { presenceTailMatches } from '../../shared/presence-tail';

export interface HistoryView { options: HistoryRead; snapshot?: HistorySnapshot; chat: ChatState | null; access?: SessionAccess; loading: boolean; paging: boolean; error: Error | string }

/** One window follows one durable journal; no runtime is created by this store. */
export class HistoryStore {
  private value: HistoryView | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private update = 0;
  private watchQueue: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, HistoryView>();
  private prepend: { generation: number; deferred?: HistorySnapshot } | undefined;
  private viewKey(options: HistoryRead) { return JSON.stringify([options.path, options.leafId, options.anchorId]); }
  constructor(private api: DesktopApi) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.value;
  waitForAccess(): Promise<HistoryView> {
    const generation = this.generation;
    const { promise, resolve, reject } = Promise.withResolvers<HistoryView>();
    const check = () => {
      const view = this.value;
      if (generation !== this.generation || !view) { detach(); reject(new UserFacingError(i18next.t('omp.intent.latestChanged'))); return; }
      if (view.error) { detach(); reject(view.error); return; }
      if (view.loading || !view.access || view.access.pending) return;
      detach(); resolve(view);
    };
    const detach = this.subscribe(check);
    check();
    return promise;
  }
  private publish(value: HistoryView | null) {
    this.value = value;
    if (value?.snapshot && value.chat && !value.loading && !value.paging && !value.error) {
      const key = this.viewKey(value.options);
      this.cache.delete(key); this.cache.set(key, value);
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
    }
    for (const listener of this.listeners) listener();
  }
  private fail(error: unknown) { if (this.value) this.publish({ ...this.value, loading: false, paging: false, error: error instanceof UserFacingError ? error : errorText(error) }); }
  connect() {
    const detach = this.api.onHistoryEvent(event => {
      if (event.kind === 'activity' || event.kind === 'listing') return;
      if (!this.value || (event.path !== this.value.options.path && event.path !== this.value.snapshot?.session.path)) return;
      if (event.kind === 'error') { this.update++; this.fail(event.error); }
      else if (event.kind === 'access') this.publish({ ...this.value, access: event.access });
      else if (event.kind === 'presence') {
        if (!this.value.snapshot || this.value.options.leafId !== undefined) return;
        const snapshot = { ...this.value.snapshot, activity: event.activity, liveTail: event.liveTail };
        this.publish({ ...this.value, snapshot, chat: this.project(snapshot) });
      }
      else if (!this.value.loading && (this.value.options.leafId === undefined || event.snapshot.selectedLeafId === this.value.options.leafId)) {
        if (this.prepend?.generation === this.generation) this.prepend.deferred = event.snapshot;
        else void this.replace(event.snapshot);
      }
    });
    return () => { detach(); this.clear(); };
  }
  clear() {
    this.generation++; this.update++; this.publish(null);
    this.watchQueue = this.watchQueue.catch(() => undefined).then(() => this.api.unwatchHistory()).catch(() => undefined);
  }
  async select(options: HistoryRead) {
    const generation = ++this.generation; this.update++;
    const key = this.viewKey(options);
    const previous = this.value && this.viewKey(this.value.options) === key ? this.value : this.cache.get(key);
    this.publish({ options, snapshot: previous?.snapshot, chat: previous?.chat ?? null, loading: true, paging: false, error: '' });
    const operation = this.watchQueue.catch(() => undefined).then(async () => {
      if (generation !== this.generation) return;
      try {
        const snapshot = await this.api.watchHistory(options);
        if (generation === this.generation) await this.replace(snapshot, options.anchorId === undefined && previous?.options.leafId === options.leafId);
      } catch (error) { if (generation === this.generation) this.fail(error); }
    });
    this.watchQueue = operation;
    await operation;
  }
  async latest() {
    const current = this.value;
    if (!current) throw new UserFacingError(i18next.t('omp.intent.latestChanged'));
    const generation = this.generation, update = ++this.update;
    this.publish({ ...current, paging: true, error: '' });
    try {
      const snapshot = await this.api.readHistory({ path: current.options.path, ...(current.options.leafId !== undefined ? { leafId: current.options.leafId } : {}) });
      if (generation !== this.generation || update !== this.update) throw new UserFacingError(i18next.t('omp.intent.latestChanged'));
      const chat = this.project(snapshot);
      this.publish({ ...current, snapshot, chat, access: this.value?.access && this.value.access.checkedAt > snapshot.access.checkedAt ? this.value.access : snapshot.access, loading: false, paging: false, error: '' });
      rememberReadingPosition(`history:${snapshot.session.path}:${snapshot.session.id}`, { scrollTop: 0, following: true, anchors: [] });
    } catch (error) { if (generation === this.generation && update === this.update) this.fail(error); throw error; }
  }
  private project(snapshot: HistorySnapshot): ChatState {
    const activity = this.value?.options.leafId === undefined ? snapshot.activity : undefined;
    const running = activity?.state === 'running';
    const settled = !activity || activity.state === 'idle';
    const previous = this.value?.chat;
    const sameSource = previous?.runtimeId === `history:${snapshot.session.path}` && previous.state.sessionId === snapshot.session.id;
    const oldMessages = this.value?.snapshot?.messages;
    const offset = snapshot.messages.length - (oldMessages?.length ?? 0);
    const prepend = !!(sameSource && previous && oldMessages?.length && offset >= 0 && !running && snapshot.activity === this.value?.snapshot?.activity && !snapshot.liveTail?.length && !this.value?.snapshot?.liveTail?.length && oldMessages.every((message, index) => snapshot.messages[offset + index] === message));
    const incoming = prepend ? snapshot.messages.slice(0, offset) : snapshot.messages;
    const chat = createChatState({ source: { status: 'persisted', sessionId: snapshot.session.id, path: snapshot.session.path }, runtimeId: `history:${snapshot.session.path}`, cwd: snapshot.session.cwd, state: { sessionId: snapshot.session.id, sessionFile: snapshot.session.path, sessionName: snapshot.session.title, isStreaming: running, isSettled: settled, ...(activity ? { observedSource: 'external', observedActivity: activity } : {}) }, messages: incoming.map(message => message.raw), messageIds: incoming.map(message => message.id), models: [], commands: [], thinkingLevels: [] });
    if (prepend && previous) {
      for (let index = 0; index < incoming.length; index++) chat.messages[index].resourceReference = incoming[index].resourceReference;
      chat.messages = chat.messages.concat(previous.messages);
      const tools = { ...previous.tools };
      for (const [id, earlier] of Object.entries(chat.tools)) {
        const later = tools[id];
        if (!later) { tools[id] = earlier; continue; }
        const merged = { ...earlier, ...later };
        if (!Object.hasOwn(later, 'args')) merged.name = text(record(later.result).toolName) || earlier.name || 'Tool';
        if (!Object.hasOwn(later, 'result')) merged.status = earlier.status;
        tools[id] = merged;
      }
      chat.tools = tools;
      chat.state.model = snapshot.selection?.model;
      chat.state.thinkingLevel = snapshot.selection?.thinkingLevel ?? undefined;
      chat.subagents = previous.subagents;
      return chat;
    }
    chat.state.model = snapshot.selection?.model;
    chat.state.thinkingLevel = snapshot.selection?.thinkingLevel ?? undefined;
    if (running && activity?.currentTool) {
      const tool = activity.currentTool;
      const saved = chat.tools[tool.toolCallId];
      chat.tools[tool.toolCallId] = { ...saved, id: tool.toolCallId, name: tool.name, status: 'running', args: saved?.args ?? (tool.intent ? { i: tool.intent } : undefined) };
    }
    const rows = new Map(sameSource ? previous.messages.map(row => [row.id, row]) : []);
    chat.messages = chat.messages.map((message, index) => {
      const resourceReference = snapshot.messages[index]?.resourceReference;
      const old = rows.get(message.id);
      return old?.raw === message.raw && old.resourceReference === resourceReference ? old : { ...message, resourceReference };
    });
    const knownIds = new Set(this.value?.snapshot?.messages.map(message => message.id));
    const previousTails = this.value?.snapshot?.liveTail ?? [];
    const replacements = new Map<string, string>();
    for (const message of snapshot.messages) {
      if (knownIds.has(message.id)) continue;
      const tail = previousTails.find(tail => presenceTailMatches(tail, message));
      if (tail) replacements.set(message.id, tail.id);
    }
    chat.messages = chat.messages.map(message => {
      const id = replacements.get(message.id);
      return id ? { ...message, presentation: { id, sessionId: snapshot.session.id } } : rows.get(message.id)?.presentation ? { ...message, presentation: rows.get(message.id)!.presentation } : message;
    });
    if (this.value?.options.leafId === undefined) for (const tail of snapshot.liveTail ?? []) {
      if (snapshot.messages.some(message => !knownIds.has(message.id) && presenceTailMatches(tail, message))) continue;
      chat.messages.push({ id: tail.id, source: 'live', raw: { role: 'assistant', timestamp: tail.startedAt, content: tail.content }, streaming: !tail.ended, presentation: { id: tail.id, sessionId: snapshot.session.id } });
    }
    if (sameSource) {
      chat.subagents = previous.subagents;
      for (const [id, tool] of Object.entries(chat.tools)) {
        const old = previous.tools[id];
        if (old && old.name === tool.name && old.args === tool.args && old.result === tool.result && old.status === tool.status) chat.tools[id] = old;
      }
    }
    return chat;
  }
  private async replace(latest: HistorySnapshot, retainPages = true) {
    const current = this.value; if (!current) return;
    const generation = this.generation, update = ++this.update;
    const observedAccess = () => this.value?.access && this.value.access.checkedAt > latest.access.checkedAt ? this.value.access : latest.access;
    if (retainPages && current.snapshot?.revision === latest.revision && current.snapshot.selectedLeafId === latest.selectedLeafId && current.snapshot.messages.at(-1)?.id === latest.messages.at(-1)?.id && current.chat && !latest.liveTail?.length && !current.snapshot.liveTail?.length && JSON.stringify(current.chat.state.observedActivity) === JSON.stringify(latest.activity)) {
      this.publish({ ...current, snapshot: { ...latest, messages: current.snapshot.messages, hasMore: current.snapshot.hasMore, nextBefore: current.snapshot.nextBefore }, access: observedAccess(), loading: false, paging: false, error: '' });
      return;
    }
    const oldestId = retainPages ? current.snapshot?.messages[0]?.id : undefined;
    const readingKey = `history:${latest.session.path}:${latest.session.id}`;
    const readingPosition = retainPages ? recallReadingPosition(readingKey) : undefined;
    const readingIds = readingAnchorMessageIds(readingPosition);
    const targets = new Set(readingIds);
    if (oldestId) targets.add(oldestId);
    for (const message of latest.messages) targets.delete(message.id);
    let snapshot = latest;
    try {
      // Rebuild the saved reader's window before publishing a shorter latest
      // page. The durable row survives page-boundary shifts and new appends.
      let restoredPages = 0;
      while (snapshot.hasMore && snapshot.nextBefore && targets.size > 0 && restoredPages++ < 8) {
        const page = await this.api.readHistory({ path: current.options.path, leafId: latest.selectedLeafId, before: snapshot.nextBefore });
        if (generation !== this.generation || update !== this.update) return;
        if (page.revision !== latest.revision) throw new UserFacingError(i18next.t('omp.history.revisionChanged'));
        for (const message of page.messages) targets.delete(message.id);
        snapshot = { ...latest, messages: [...page.messages, ...snapshot.messages], hasMore: page.hasMore, nextBefore: page.nextBefore, diagnostics: [...new Set([...snapshot.diagnostics, ...page.diagnostics])] };
      }
      if (targets.size && snapshot.hasMore) {
        // Preserve the existing anchored window instead of eagerly reading the
        // entire journal. Scrolling can continue paging the retained window.
        if (generation === this.generation && update === this.update) {
          const access = observedAccess();
          const retained = current.chat && current.snapshot ? { ...current.snapshot, session: latest.session, access } : snapshot;
          this.publish({ ...current, snapshot: retained, chat: current.chat ?? this.project(snapshot), access, loading: false, paging: false, error: '' });
        }
        return;
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
  async older(beforeEntryId?: string) {
    const current = this.value, snapshot = current?.snapshot;
    if (!current || !snapshot || current.paging || (!beforeEntryId && (!snapshot.hasMore || !snapshot.nextBefore))) return;
    const generation = this.generation, update = ++this.update;
    const prepend = { generation } as { generation: number; deferred?: HistorySnapshot };
    this.prepend = prepend;
    this.publish({ ...current, paging: true, error: '' });
    try {
      const page = await this.api.readHistory({ path: current.options.path, leafId: snapshot.selectedLeafId, ...(beforeEntryId ? { beforeEntryId } : { before: snapshot.nextBefore }) });
      if (generation !== this.generation) return;
      if (update !== this.update) throw new UserFacingError(i18next.t('omp.history.revisionChanged'));
      if (page.revision !== snapshot.revision) {
        const latest = await this.api.readHistory(current.options);
        if (generation !== this.generation) return;
        if (update !== this.update) throw new UserFacingError(i18next.t('omp.history.revisionChanged'));
        await this.replace(latest);
        throw new UserFacingError(i18next.t('omp.history.revisionChanged'));
      }
      const ids = new Set(snapshot.messages.map(message => message.id));
      const earlier = page.messages.filter(message => !ids.has(message.id));
      let merged = snapshot;
      // Publish from the fetched page's newest edge so every slice is a prepend.
      // Give input/paint a turn between slices rather than monopolizing one commit.
      for (let end = earlier.length; end > 0; end -= 6) {
        await new Promise<void>(resolve => {
          if (typeof requestAnimationFrame === 'undefined') setTimeout(resolve, 0);
          else requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
        });
        if (generation !== this.generation) return;
        if (update !== this.update) throw new UserFacingError(i18next.t('omp.history.revisionChanged'));
        const start = Math.max(0, end - 6);
        merged = { ...snapshot, messages: [...earlier.slice(start, end), ...merged.messages], hasMore: start > 0 || page.hasMore, nextBefore: start > 0 ? undefined : page.nextBefore, diagnostics: [...new Set([...page.diagnostics, ...snapshot.diagnostics])] };
        this.publish({ ...this.value!, snapshot: merged, chat: this.project(merged), paging: start > 0, error: '' });
      }
      if (!earlier.length) this.publish({ ...this.value!, snapshot: { ...snapshot, hasMore: page.hasMore, nextBefore: page.nextBefore }, paging: false, error: '' });
    } catch (error) { if (generation === this.generation && update === this.update) this.fail(error); throw error; }
    finally {
      if (this.prepend === prepend) {
        this.prepend = undefined;
        if (generation === this.generation && prepend.deferred && !this.value?.error) await this.replace(prepend.deferred);
      }
    }
  }
}
