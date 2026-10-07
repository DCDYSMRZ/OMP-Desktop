import { useEffect, useRef, useState } from 'react';
import type { ObservedActivity } from '../../shared/contracts';
import { selectTurnClock, turnClockElapsed } from './turn-clock';
import { useTranslation } from 'react-i18next';
import type { ChatState } from './model';
import type { AssistantTurnEntry } from './presentation';
import { advanceActiveClock, deriveLiveStatus } from './live-status-model';
import { WorkChip } from './session-meter/SessionMeterView';
import { selectWorkMeter } from '../app/session-meter-model';
import { IconArrowDown } from '../ui/icons';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import './live-status.css';

export function LiveStatusRow({ chat, entry, startedAt, following, visible, onLatest, onOpenSubagent, queuedCount = 0, observedLive = false }: { chat: ChatState; entry?: AssistantTurnEntry; startedAt?: number; following: boolean; visible: boolean; onLatest: () => void; onOpenSubagent: (id: string) => void; queuedCount?: number; observedLive?: boolean }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const status = deriveLiveStatus(chat, entry, following, observedLive, t);
  const source = selectTurnClock(chat.state.observedActivity as ObservedActivity | undefined, { startedAt, running: chat.isRunning });
  const clock = useRef({ at: Date.now(), elapsed: turnClockElapsed(source, Date.now()) ?? 0, paused: status.paused });
  const [elapsed, setElapsed] = useState(clock.current.elapsed);
  const wasRunning = useRef(chat.isRunning);
  useEffect(() => {
    if (chat.isRunning && !wasRunning.current) { clock.current = { at: Date.now(), elapsed: 0, paused: status.paused }; setElapsed(0); }
    wasRunning.current = chat.isRunning;
  }, [chat.isRunning]);
  useEffect(() => {
    const update = () => { clock.current = advanceActiveClock(clock.current, Date.now(), status.paused); setElapsed(clock.current.elapsed); };
    update();
    if (status.paused) return;
    const timer = window.setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [status.paused, status.kind]);
  const [settledLabel, setSettledLabel] = useState(status.label);
  const [announcement, setAnnouncement] = useState('');
  const lastAnnounced = useRef('');
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettledLabel(status.label);
      if (status.kind === 'hidden' || status.kind === 'latest') {
        const completion = chat.outcome === 'aborted' ? 'stopped' : chat.error || chat.outcome === 'error' ? 'failed' : 'completed';
        if (!chat.isRunning && lastAnnounced.current && lastAnnounced.current !== `settled:${completion}`) { lastAnnounced.current = `settled:${completion}`; setAnnouncement(t(`omp.live.${completion}`)); }
      }
      else if (status.announcementReady && lastAnnounced.current !== status.announcementKey) { lastAnnounced.current = status.announcementKey; setAnnouncement(status.label); }
    }, 180);
    return () => clearTimeout(timer);
  }, [status.kind, status.label, status.announcementKey, status.announcementReady, chat.isRunning, chat.outcome, chat.error, t]);
  const stateLabel = status.kind === 'attention' ? t(['select', 'confirm'].includes(chat.prompts[0]?.method ?? '') ? 'omp.live.waitingChoice' : 'omp.live.waitingReply') : status.kind === 'retry' ? t('omp.live.retrying') : status.kind === 'stale' ? t('omp.observe.stale') : t('shell.running');
  const label = settledLabel || stateLabel;
  return <><span className="live-status-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span><div className="live-status-row" data-state={status.kind} aria-hidden={!visible} inert={!visible}>
    <button type="button" className="live-status-main" onClick={onLatest} title={label} aria-label={t('omp.live.returnLatest', { state: stateLabel })}><span className="live-status-dot" /><span className="live-status-label" aria-hidden="true">{label}</span>{status.kind !== 'retry' && status.kind !== 'attention' && elapsed >= 1000 && <span className="live-status-time" aria-hidden="true">· {formatElapsed(elapsed, durationStyle, i18n.language)}</span>}</button>
    {queuedCount > 0 && <span className="live-status-queue">{t('omp.live.queued', { count: queuedCount })}</span>}
    <WorkChip work={selectWorkMeter(chat, observedLive)} onOpenSubagent={onOpenSubagent} expandedLabel />
    {!following && <button className="live-status-return" type="button" onClick={onLatest} aria-label={t('chat.scrollToBottom')}><IconArrowDown size="var(--icon-meta)" /></button>}
  </div></>;
}
