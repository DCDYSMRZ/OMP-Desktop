import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionModelCapacity, SessionUsageSummary, ConfigEntry } from '../../shared/contracts';
import { record, type ChatState } from '../chat/model';
import { buildSessionMeter, type ContextPrompt, type SessionMeterModel } from './session-meter-model';
import { compactionPolicy } from '../../main/data/compaction-policy';
import { sessionStatusUsage } from './session-status';

export interface SessionMeterArgs { cwd: string; runtimeId: string | null; chat: ChatState | null; live: boolean; onCommand: (command: { type: 'get_session_stats' | 'get_state' }) => Promise<unknown> }

/** One journal definition for saved and persisted live spend; no per-token polling. */
export function useSessionMeter({ cwd, runtimeId, chat, live: observedLive, onCommand }: SessionMeterArgs): SessionMeterModel {
  const live = observedLive && !!runtimeId;
  const path = chat?.historySource?.path ?? chat?.state.sessionFile;
  const leafId = live ? undefined : chat?.historySource?.leafId;
  const identity = JSON.stringify([runtimeId, chat?.state.sessionId, path, leafId, live]);
  const [observation, setObservation] = useState<{ identity: string; usage?: SessionUsageSummary; pending: boolean; unavailable: boolean }>({ identity, pending: false, unavailable: false });
  const command = useRef(onCommand);
  command.current = onCommand;
  let latest: string | undefined;
  const messages = live ? chat?.live.messages : chat?.messages;
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const row = messages![i];
    if (row.raw.role === 'assistant' && !row.streaming) { latest = row.id; break; }
  }
  const settled = chat?.isSettled;
  const streaming = chat?.state.isStreaming;
  useEffect(() => {
    if (!chat || (!path && !live)) return;
    let active = true;
    setObservation(previous => ({ identity, usage: previous.identity === identity ? previous.usage : undefined, pending: true, unavailable: false }));
    const timer = window.setTimeout(async () => {
      try {
        const usage = path ? await window.ompDesktop.getSessionUsage(path, leafId) : sessionStatusUsage(await command.current({ type: 'get_session_stats' }), chat.state.sessionId);
        if (active) setObservation({ identity, usage: usage ?? undefined, pending: false, unavailable: !usage });
      } catch { if (active) setObservation(previous => ({ ...previous, pending: false, unavailable: true })); }
    }, live ? 400 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [identity, path, leafId, live, latest, settled, streaming]);
  const current = observation.identity === identity ? observation : undefined;
  const provider = live ? chat?.state.model?.provider : current?.usage?.model?.provider;
  const modelId = live ? chat?.state.model?.id : current?.usage?.model?.id;
  const [capacity, setCapacity] = useState<SessionModelCapacity>();
  useEffect(() => {
    let active = true;
    if (provider && modelId) void window.ompDesktop.getModelCapacity(provider, modelId).then(value => { if (active) setCapacity(value); }, () => { if (active) setCapacity(undefined); });
    return () => { active = false; };
  }, [provider, modelId]);
  const modelCapacity = capacity?.provider === provider && capacity?.id === modelId ? capacity : undefined;
  const systemPrompt = chat?.state.systemPrompt;
  const dumpTools = chat?.state.dumpTools;
  const [fetchedPrompt, setFetchedPrompt] = useState<{ identity: string; provider?: string; modelId?: string; value: ContextPrompt }>();
  useEffect(() => {
    if (!live || Array.isArray(systemPrompt) && Array.isArray(dumpTools)) return;
    let active = true;
    void command.current({ type: 'get_state' }).then(value => {
      const state = record(value);
      if (active && Array.isArray(state.systemPrompt) && state.systemPrompt.every(part => typeof part === 'string') && Array.isArray(state.dumpTools)) setFetchedPrompt({ identity, provider, modelId, value: { systemPrompt: state.systemPrompt, dumpTools: state.dumpTools } });
    }, () => {});
    return () => { active = false; };
  }, [identity, live, provider, modelId, systemPrompt, dumpTools, latest]);
  const prompt = useMemo(() => Array.isArray(systemPrompt) && systemPrompt.every(part => typeof part === 'string') && Array.isArray(dumpTools) ? { systemPrompt, dumpTools } : fetchedPrompt?.identity === identity && fetchedPrompt.provider === provider && fetchedPrompt.modelId === modelId ? fetchedPrompt.value : undefined, [systemPrompt, dumpTools, fetchedPrompt, identity, provider, modelId]);
  const [settings, setSettings] = useState<{ cwd: string; entries: ConfigEntry[] }>();
  useEffect(() => {
    if (!cwd) return;
    let active = true;
    void window.ompDesktop.listSettings(cwd).then(snapshot => { if (active) setSettings({ cwd, entries: snapshot.entries }); }, () => { if (active) setSettings(undefined); });
    return () => { active = false; };
  }, [cwd, identity, chat?.state.autoCompactionEnabled]);
  const meter = buildSessionMeter({ chat, live, usage: current?.usage, capacity: modelCapacity, prompt, pending: current?.pending ?? !!chat, unavailable: current?.unavailable });
  if (settings?.cwd === cwd && settings && meter.context.window) {
    const model = live ? chat?.state.model : undefined;
    const input = Array.isArray(model?.input) && model.input.every(value => typeof value === 'string') ? model.input : modelCapacity?.input;
    meter.context.policy = compactionPolicy(meter.context.window, settings.entries, { input, remoteCompaction: modelCapacity?.remoteCompaction, remoteCompactionV2: modelCapacity?.remoteCompactionV2 }, live ? chat?.state.autoCompactionEnabled : undefined);
    meter.context.autoCompaction = meter.context.policy.enabled;
  }
  return meter;
}
