import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptInput } from '../../shared/contracts';
import { HomeMascotLogo } from '../ui/HomeMascotLogo';
import { Composer, type ComposerAccess } from './Composer';
import { Transcript } from './Transcript';
import type { ChatState } from './model';
import './chat.css';
interface ChatWidthPreferences { contentWidth: number; onContentWidthChange: (width: number) => void }
export interface ChatViewProps { chat: ChatState | null; cwd: string; activeSubagentId?: string | null; composerKey?: string; enterToSend?: boolean; historyHeader?: ReactNode; readonlyHistory?: boolean; sendDisabled?: boolean; mutationDisabled?: boolean; access?: ComposerAccess; onSend: (input: PromptInput) => Promise<void>; onAbort: () => Promise<void>; onModelChange: (provider: string, modelId: string) => Promise<void>; onThinkingChange: (level: string) => Promise<void>; onOpenFile: (path: string) => void; onOpenSubagent: (id: string) => void; onOpenSessionResource?: (reference: string) => void; }
export function ChatView(props: ChatViewProps & ChatWidthPreferences) {
  const { t } = useTranslation();
  const { chat, cwd, onOpenFile, onOpenSubagent } = props;
  const composerKey = props.composerKey ?? (chat ? `${chat.runtimeId}:${chat.state.sessionId}` : `draft:${cwd}`);
  const surface = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(props.contentWidth);
  const [resizing, setResizing] = useState<string | null>(null);
  const drag = useRef<{ x: number; width: number; current: number; side: string } | null>(null);
  useEffect(() => { if (!drag.current) setWidth(props.contentWidth); }, [props.contentWidth]);
  useEffect(() => () => document.documentElement.removeAttribute('data-chat-resizing'), []);
  const home = !chat || (!props.readonlyHistory && !chat.messages.length && !Object.keys(chat.tools).length && !chat.subagents.length && !chat.notices.length && !chat.isRunning);
  const clamp = (value: number) => Math.max(360, Math.min(1600, surface.current?.clientWidth ?? 1600, value));
  const commitWidth = (value: number) => { setWidth(value); props.onContentWidthChange(value); };
  const finishResize = (commit: boolean) => {
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null; setResizing(null);
    document.documentElement.removeAttribute('data-chat-resizing');
    if (commit) commitWidth(gesture.current); else setWidth(gesture.width);
  };
  const style = { '--chat-content-max-width': `${width}px`, '--chat-composer-max-width': `${width}px`, '--chat-prose-max-width': `${width}px` } as CSSProperties;
  return <div className="chat-surface route-surface" ref={surface} style={style} data-chat-resizing={resizing ? 'true' : undefined}>
    <div className="chat-width-handles">{['left', 'right'].map(side => <div key={side} role="separator" aria-orientation="vertical" aria-label={t('nav.resizeChatWidth')} aria-valuemin={360} aria-valuemax={1600} aria-valuenow={width} tabIndex={0} data-side={side} className={`chat-width-handle chat-width-handle-${side} no-drag${resizing === side ? ' is-resizing' : ''}`}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width, current: width, side }; setResizing(side); document.documentElement.setAttribute('data-chat-resizing', 'true'); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { const gesture = drag.current; if (!gesture) return; gesture.current = clamp(gesture.width + (event.clientX - gesture.x) * (gesture.side === 'left' ? -2 : 2)); setWidth(gesture.current); }}
      onPointerUp={event => { finishResize(true); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => finishResize(false)} onLostPointerCapture={() => finishResize(false)}
      onDoubleClick={() => commitWidth(760)} onKeyDown={event => { if (event.key === 'Escape') finishResize(false); else if (event.key === 'Home') { event.preventDefault(); commitWidth(760); } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); commitWidth(clamp(width + ((event.key === 'ArrowRight') === (side === 'right') ? 20 : -20))); } }} />)}</div>
    {props.readonlyHistory && !chat ? <><div className="omp-history-initial">{props.historyHeader}</div><Composer key={composerKey} {...props} composerKey={composerKey} variant="docked" /></> : home ? <div className="home-main-content" data-home-session-kind={cwd ? 'project' : 'empty'}><div className="home-scroll"><div className="home-stack-inner"><div className="empty-hero"><div className="empty-hero-icon" aria-hidden><HomeMascotLogo /></div><h1>{cwd ? t('chat.emptyTitleInProject', { project: cwd.split('/').filter(Boolean).pop() }) : t('chat.emptyTitle')}</h1></div></div></div><div className="home-composer-wrap"><Composer key={composerKey} {...props} composerKey={composerKey} variant="home" /></div></div> : <><div className="session-panes"><div className="session-pane" data-visible="true"><Transcript key={`${chat.runtimeId}:${chat.state.sessionId}`} chat={chat} cwd={cwd} activeSubagentId={props.activeSubagentId} historyHeader={props.historyHeader} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} onOpenSessionResource={props.onOpenSessionResource} /></div></div><Composer key={composerKey} {...props} composerKey={composerKey} variant="docked" /></>}
    {chat?.error && <div className="chat-error-layer"><div className="chat-error-notice" role="alert"><span>{chat.error}</span></div></div>}
  </div>;
}
