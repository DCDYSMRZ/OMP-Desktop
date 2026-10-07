import { useEffect, useRef } from 'react';
import { useSessionMeter } from '../../app/useSessionMeter';
import type { ChatState } from '../model';
import { latestTodoPhases } from '../todo-dock-model';
import { SessionMeterView } from './SessionMeterView';

export interface SessionMeterProps {
  cwd: string; runtimeId: string | null; chat: ChatState; live: boolean;
  onCommand: (command: { type: 'get_session_stats' | 'get_state' }) => Promise<unknown>;
  onOpenInspector: () => void; onOpenSubagent: (id: string) => void; variant: 'toolbar' | 'readonly';
}

export function SessionMeter(props: SessionMeterProps) {
  const identity = JSON.stringify([props.runtimeId, props.chat.state.sessionId, props.chat.historySource?.path ?? props.chat.state.sessionFile, props.live]);
  return <SessionMeterSession key={identity} {...props}/>;
}

function SessionMeterSession(props: SessionMeterProps) {
  const model = useSessionMeter(props);
  const connected = props.live && !!props.runtimeId;
  const observed = useRef(false);
  // Saved hydration and a session's first observation are never transitions.
  const animate = connected && observed.current;
  useEffect(() => { if (model.context.state !== 'none' || model.spend.state === 'known') observed.current = true; }, [model.context.state, model.spend.state]);
  const provenance = !connected ? 'saved' : props.chat.outcome === 'aborted' ? 'stopped' : props.chat.isRunning ? 'live' : 'connected';
  return <SessionMeterView model={model} phases={latestTodoPhases(props.chat, connected)} provenance={provenance} animate={animate} variant={props.variant} onOpenInspector={props.onOpenInspector} onOpenSubagent={props.onOpenSubagent}/>;
}
