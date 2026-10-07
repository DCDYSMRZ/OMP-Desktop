import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptInput } from '../../shared/contracts';
import { Composer, type ComposerAccess, type PickerConnection } from './Composer';
import { Transcript, type TranscriptHistory, type TranscriptNavigationProps } from './Transcript';
import type { TurnChangesProps } from './TurnChanges';
import { SessionMeter } from './session-meter/SessionMeter';
import type { ChatState } from './model';
import './chat.css';
import { submissions } from './submissions';
import { projectSubmissions } from './presentation';
import { HomePanel, HomeSuggestions, type HomeContext } from './HomePanel';
import { getComposerDraft } from './composer/drafts';
import { setEditorCaret } from './composer/editor';
import type { DesktopQueue, QueuedPrompt } from './composer/queue';
import { useReducedMotion } from '../ui/motion';
interface ChatWidthPreferences { contentWidth: number; onContentWidthChange: (width: number) => void }
interface HomeViewProps { homeContext: HomeContext }
export interface ChatViewProps extends TranscriptNavigationProps, TurnChangesProps { chat: ChatState | null; cwd: string; runtimeId: string | null; observedLive?: boolean; onCommand: (command: { type: 'get_session_stats' | 'get_state' }) => Promise<unknown>; onOpenInspector: () => void; activeSubagentId?: string | null; composerKey?: string; enterToSend?: boolean; historyHeader?: ReactNode; historyLoading?: boolean; history?:TranscriptHistory; returnToTurn?:{id:string;sequence:number}|null; readonlyHistory?: boolean; sendDisabled?: boolean; mutationDisabled?: boolean; access?: ComposerAccess; onSend: (input: PromptInput) => Promise<void>; onAbort: () => Promise<void>; onModelChange: (provider: string, modelId: string) => Promise<void>; onThinkingChange: (level: string) => Promise<void>; onOpenFile: (path: string, originTurnId?:string) => void; onOpenSubagent: (id: string, originTurnId?:string) => void; onOpenSessionResource?: (reference: string, originTurnId?:string) => void; }
interface ComposerModeProps extends PickerConnection { composerReadonly?: boolean; desktopQueue: DesktopQueue; queuedPrompts: QueuedPrompt[] }
export function ChatView(props: ChatViewProps & ChatWidthPreferences & HomeViewProps & ComposerModeProps) {
  const { t } = useTranslation();
  const { chat, cwd, onOpenFile, onOpenSubagent } = props;
  const receipts = useSyncExternalStore(submissions.subscribe, submissions.getSnapshot, submissions.getSnapshot);
  const hasPendingSubmission = !!chat && projectSubmissions(receipts, chat.messages, chat.runtimeId, chat.state.sessionId).pending.length > 0;
  const composerKey = props.composerKey ?? (chat ? `${chat.runtimeId}:${chat.state.sessionId}` : `draft:${cwd}`);
  const surface = useRef<HTMLDivElement>(null);
  const [liveStatusHost, setLiveStatusHost] = useState<HTMLDivElement | null>(null);
  const dockPosition = useRef<{ key: string; home: boolean; top: number } | null>(null);
  const firstSendKey = useRef<string | null>(null);
  const glide = useRef<Animation | null>(null);
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(props.contentWidth);
  const [resizing, setResizing] = useState<string | null>(null);
  const drag = useRef<{ x: number; width: number; current: number; side: string } | null>(null);
  useEffect(() => { if (!drag.current) setWidth(props.contentWidth); }, [props.contentWidth]);
  useEffect(() => () => document.documentElement.removeAttribute('data-chat-resizing'), []);
  const home = !chat&&!props.readonlyHistory;
  const connectedEmpty=!!chat&&!props.readonlyHistory&&!hasPendingSubmission&&!chat.messages.length&&!Object.keys(chat.tools).length&&!chat.subagents.length&&!chat.notices.length&&!chat.isRunning;
  const homeVisible = home || connectedEmpty;
  useLayoutEffect(() => {
    const dock = surface.current?.querySelector<HTMLElement>('.composer-dock');
    if (!dock) return;
    glide.current?.cancel();
    const top = dock.getBoundingClientRect().top;
    const previous = dockPosition.current;
    dockPosition.current = { key: composerKey, home: homeVisible, top };
    if (previous?.key !== composerKey) firstSendKey.current = null;
    if (previous?.key === composerKey && previous.home && !homeVisible && firstSendKey.current === composerKey && !reducedMotion) {
      firstSendKey.current = null;
      glide.current = dock.animate([{ transform: `translateY(${previous.top - top}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
    return () => { glide.current?.cancel(); };
  }, [homeVisible, composerKey, reducedMotion]);
  useLayoutEffect(() => {
    if (!homeVisible || !surface.current) return;
    const element = surface.current;
    const update = () => { const dock = element.querySelector<HTMLElement>('.composer-dock'); if (dock) dockPosition.current = { key: composerKey, home: true, top: dock.getBoundingClientRect().top }; };
    const observer = new ResizeObserver(update); observer.observe(element);
    const dock = element.querySelector('.composer-dock'); if (dock) observer.observe(dock);
    return () => observer.disconnect();
  }, [homeVisible, composerKey]);
  const fillPrompt = (text: string) => {
    const store = getComposerDraft(composerKey);
    store.setDraft({ ...store.draft, text: store.draft.text ? `${store.draft.text}\n\n${text}` : text });
    requestAnimationFrame(() => { const editor = surface.current?.querySelector<HTMLElement>('.composer-input[contenteditable="true"]'); if (editor) { editor.focus(); setEditorCaret(editor, store.draft.text.length); } });
  };
  const lastUserContent = chat?.messages.findLast(row => row.raw.role === 'user')?.raw.content;
  const retryText = typeof lastUserContent === 'string' ? lastUserContent : Array.isArray(lastUserContent) && lastUserContent.every(part => part.type === 'text') ? lastUserContent.map(part => String(part.text ?? '')).join('\n') : '';
  const retryTurn = retryText && !chat?.isRunning && !props.composerReadonly ? () => { void props.onSend({ text: retryText, mode: 'prompt' }).catch(cause => getComposerDraft(composerKey).setError(cause)); } : undefined;
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
  return <div className="chat-surface route-surface" ref={surface} style={style} data-home={homeVisible} data-chat-resizing={resizing ? 'true' : undefined}>
    <div className="chat-width-handles">{['left', 'right'].map(side => <div key={side} role="separator" aria-orientation="vertical" aria-label={t('nav.resizeChatWidth')} aria-valuemin={360} aria-valuemax={1600} aria-valuenow={width} tabIndex={0} data-side={side} className={`chat-width-handle chat-width-handle-${side} no-drag${resizing === side ? ' is-resizing' : ''}`}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width, current: width, side }; setResizing(side); document.documentElement.setAttribute('data-chat-resizing', 'true'); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { const gesture = drag.current; if (!gesture) return; gesture.current = clamp(gesture.width + (event.clientX - gesture.x) * (gesture.side === 'left' ? -2 : 2)); setWidth(gesture.current); }}
      onPointerUp={event => { finishResize(true); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => finishResize(false)} onLostPointerCapture={() => finishResize(false)}
      onDoubleClick={() => commitWidth(760)} onKeyDown={event => { if (event.key === 'Escape') finishResize(false); else if (event.key === 'Home') { event.preventDefault(); commitWidth(760); } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); commitWidth(clamp(width + ((event.key === 'ArrowRight') === (side === 'right') ? 20 : -20))); } }} />)}</div>
    <div className="session-panes">
      <div className="session-pane" data-visible="true">
        {props.readonlyHistory && !chat ? <div className="omp-history-initial">{props.historyLoading && <p role="status">{t('omp.shell.readingHistory')}</p>}{props.historyHeader}</div> : chat && !homeVisible && <Transcript key={`${chat.runtimeId}:${chat.state.sessionId}`} chat={chat} cwd={cwd} sourceContext={props.sourceContext} liveStatusHost={liveStatusHost} queuedCount={props.queuedPrompts.length} navigationRef={props.navigationRef} attentionRequest={props.attentionRequest} observedLive={props.observedLive} activeSubagentId={props.activeSubagentId} historyHeader={props.historyHeader} history={props.history} returnToTurn={props.returnToTurn} focusMessage={props.focusMessage} findRequest={props.findRequest} onSearchAll={props.onSearchAll} onOpenChanges={props.onOpenChanges} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} onOpenSessionResource={props.onOpenSessionResource} onRetryTurn={retryTurn} onOpenSettings={props.onOpenSettings} />}
        {chat && props.historyLoading && <div className="omp-history-loading" role="status">{t('omp.shell.readingHistory')}</div>}
      </div>
    </div>
    {homeVisible && <HomePanel cwd={cwd} context={props.homeContext}/>}
    <div className="chat-live-status-anchor"><div ref={setLiveStatusHost} className="chat-live-status-host"/></div>
    <Composer key={composerKey} {...props} composerKey={composerKey} variant={homeVisible ? 'home' : 'docked'}
      onSend={async input => { if (homeVisible) firstSendKey.current = composerKey; try { await props.onSend(input); } catch (error) { firstSendKey.current = null; throw error; } }}
      setupRequired={homeVisible && (!props.homeContext.readiness.complete || !!props.homeContext.connectionError || !!props.homeContext.missingWorkspace)}
      sessionMeter={chat && <SessionMeter cwd={cwd} runtimeId={props.runtimeId} chat={chat} live={!!props.observedLive} onCommand={props.onCommand} onOpenInspector={props.onOpenInspector} onOpenSubagent={onOpenSubagent} variant={props.composerReadonly ? 'readonly' : 'toolbar'} />}
    />
    {homeVisible && <HomeSuggestions cwd={cwd} onPrompt={fillPrompt}/>}
  </div>;
}
