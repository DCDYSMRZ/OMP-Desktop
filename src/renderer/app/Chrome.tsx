import { UserErrorNotice } from '../lib/UserErrorNotice';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSidebar, IconNewSession, IconSearch, IconClose, IconMinus, IconSquare, IconInfo, IconCircleAlert } from '../ui/icons';
import { TooltipButton } from '../ui/ui';
import type { Toast } from './runtime-store';
import { AnchoredMenu } from '../ui/AnchoredMenu';
import { IconHistory } from '../ui/icons';
import { useFlipList } from '../ui/motion';
import { presentUserError } from '../lib/user-errors';

export function HistoryMenu({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <AnchoredMenu open={open} onClose={() => setOpen(false)} menuClassName="shell-history-menu" role="dialog" label={t('shell.historyBranches')} align="end" trigger={ref => <button ref={ref} type="button" className="shell-history-trigger" title={t('shell.historyBranches')} aria-label={t('shell.historyBranches')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}><IconHistory size="var(--icon-ui)" /></button>}>
    <div onClick={event => { if ((event.target as HTMLElement).closest('button')) setOpen(false); }}>{children}</div>
  </AnchoredMenu>;
}

export function ConversationTopbar({title,project,identity,attention,history,collapsed,panelOpen,onToggleSidebar,onNew,onSearch,onChooseWorkspace,onRename,onError}:{title:string;project:string;identity?:ReactNode;attention?:ReactNode;history?:ReactNode;collapsed:boolean;panelOpen:boolean;onToggleSidebar:()=>void;onNew:()=>void;onSearch:()=>void;onChooseWorkspace:()=>void;onRename?:()=>void;onError:(error:unknown)=>void}) {
  const { t } = useTranslation();
  const [projectOpen,setProjectOpen]=useState(false);
  const lead=useRef<HTMLDivElement>(null);
  const [leadRetained,setLeadRetained]=useState(collapsed);
  const leadVisible=collapsed||leadRetained;
  useLayoutEffect(()=>{
    if(!collapsed&&lead.current?.contains(document.activeElement)){
      lead.current.closest('.app-shell')?.querySelector<HTMLButtonElement>('[data-sidebar-toggle="collapse"]')?.focus({preventScroll:true});
    }
    setLeadRetained(collapsed);
  },[collapsed]);
  return (
    <div className={`conversation-topbar${collapsed ? ' ct-collapsed' : ''}${panelOpen ? ' ct-work-panel-open' : ''}`} role="toolbar" aria-label={t('nav.conversation')}>
      <div ref={lead} className="ct-lead" inert={!leadVisible || undefined} aria-hidden={!leadVisible || undefined}>
        <TooltipButton data-sidebar-toggle="expand" className="ct-icon-btn" tooltip={`${t('nav.toggleSidebar')} (⌘/Ctrl+B)`} ariaLabel={t('nav.toggleSidebar')} tabIndex={leadVisible ? undefined : -1} onClick={onToggleSidebar}><IconSidebar size="var(--icon-ui)"/></TooltipButton>
      </div>
      <div className="ct-left">
        {collapsed&&<div className="ct-actions"><TooltipButton className="ct-icon-btn" tooltip={`${t('omp.shell.newSession')} (⌘/Ctrl+N)`} ariaLabel={t('omp.shell.newSession')} onClick={onNew}><IconNewSession size="var(--icon-ui)"/></TooltipButton><TooltipButton className="ct-icon-btn" tooltip={`${t('nav.search')} (⌘/Ctrl+K)`} ariaLabel={t('nav.search')} onClick={onSearch}><IconSearch size="var(--icon-ui)"/></TooltipButton></div>}
        <div className="ct-title-wrap">
          <AnchoredMenu open={projectOpen} onClose={()=>setProjectOpen(false)} menuClassName="shell-history-menu" label={t('sidebar.projectActions')} trigger={ref=><button ref={ref} className="ct-project no-drag" title={project} onClick={()=>setProjectOpen(value=>!value)}>{project.split(/[/\\]/).filter(Boolean).pop()||t('shell.switchProject')}</button>}>
            <button onClick={()=>{setProjectOpen(false);onChooseWorkspace();}}>{t('shell.switchProject')}</button>
            {project&&<><button onClick={()=>{setProjectOpen(false);void window.ompDesktop.revealFile(project,'.').catch(onError);}}>{t('sidebar.revealProject')}</button><button onClick={()=>{setProjectOpen(false);void window.ompDesktop.openInEditor({cwd:project,path:'.'}).catch(onError);}}>{t('sidebar.editProject')}</button></>}
          </AnchoredMenu>
          <span className="ct-separator" aria-hidden>/</span><span className="ct-title no-drag" title={title} onDoubleClick={onRename}>{title}</span>
        </div>
        {identity}
      </div>
      <div className="ct-right">{history}{attention}</div>
    </div>
  );
}
export function WindowControls({platform,onError}:{platform:string;onError:(error:unknown)=>void}) {
  const { t } = useTranslation();
  if(platform === 'darwin') return null;
  return <div className="window-controls no-drag">{(['minimize','maximize','close'] as const).map(action => (
    <TooltipButton key={action} className={`window-control-btn${action === 'close' ? ' window-control-close' : ''}`} tooltip={action === 'maximize' ? `${t('window.maximize')} / ${t('window.restore')}` : t(`window.${action}`)} ariaLabel={t(`window.${action}`)} onClick={()=>{void window.ompDesktop.windowAction(action).catch(onError);}}>
      {action === 'minimize' ? <IconMinus size="var(--icon-caption)"/> : action === 'maximize' ? <IconSquare size="var(--icon-caption)"/> : <IconClose size="var(--icon-caption)"/>}
    </TooltipButton>
  ))}</div>;
}
type ToastSource = { title: string; project: string };
function ToastCard({toast,source,onOpen,onDismiss,onError}:{toast:Toast;source?:ToastSource;onOpen:(runtimeId:string)=>void;onDismiss:(id:number)=>void;onError:(error:unknown)=>void}) {
  const { t } = useTranslation();
  const error = toast.error ?? (toast.severity === 'error' || toast.severity === 'warning' ? presentUserError(toast.message) : undefined);
  const [paused,setPaused]=useState(false);
  const hovered=useRef(false);
  const [closing,setClosing]=useState(false);
  const dismiss=()=>{if(document.documentElement.dataset.motion==='off'||window.matchMedia('(prefers-reduced-motion: reduce)').matches)onDismiss(toast.id);else setClosing(true);};
  const remaining=useRef(7000);
  useEffect(()=>{if(paused || closing || toast.severity==='error' || toast.url) return; const start=Date.now(); const timer=window.setTimeout(dismiss,remaining.current); return ()=>{window.clearTimeout(timer);remaining.current-=Date.now()-start;};},[paused,closing,toast.id,toast.severity,toast.url,onDismiss]);
  return (
    <div className={`toast ${toast.severity}${closing ? ' closing' : ''}`} role={toast.severity==='error' ? 'alert' : 'status'} onMouseEnter={()=>{hovered.current=true;setPaused(true);}} onMouseLeave={event=>{hovered.current=false;if(!event.currentTarget.contains(document.activeElement))setPaused(false);}} onFocusCapture={()=>setPaused(true)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null)&&!hovered.current)setPaused(false);}} onAnimationEnd={event=>{if(event.target===event.currentTarget&&event.animationName==='toast-out')onDismiss(toast.id);}}>
      <span className="toast-icon">{toast.severity==='error'||toast.severity==='warning' ? <IconCircleAlert size="var(--icon-ui)"/> : <IconInfo size="var(--icon-ui)"/>}</span>
      <div className="toast-content">{source&&<div className="toast-source" title={`${source.title}${source.project ? ` · ${source.project}` : ''}`}><strong>{source.title}</strong>{source.project&&<span>{source.project.split(/[/\\]/).filter(Boolean).pop()}</span>}</div>}
        {error ? <UserErrorNotice error={error.details} presentation={error} operation={toast.operation} actions={<>{source&&<button type="button" onClick={()=>{onOpen(toast.runtimeId);if(error.kind==='runtime')onDismiss(toast.id);}}>{error.kind==='runtime'?error.action:t('shell.openSession')}</button>}{toast.url&&<button type="button" onClick={()=>{void window.ompDesktop.openExternal(toast.url!).catch(onError);}}>{toast.url}</button>}</>} /> : <><div className="toast-message selectable">{toast.message}</div>{(source||toast.url)&&<div className="toast-actions">{source&&<button type="button" onClick={()=>onOpen(toast.runtimeId)}>{t('shell.openSession')}</button>}{toast.url&&<button type="button" onClick={()=>{void window.ompDesktop.openExternal(toast.url!).catch(onError);}}>{toast.url}</button>}</div>}</>}
        {toast.count>1&&<span className="toast-repeat" aria-label={t('shell.toastRepeated',{count:toast.count})}>×{toast.count}</span>}
      </div>
      <TooltipButton className="toast-dismiss" tooltip={t('common.close')} ariaLabel={t('common.close')} onClick={dismiss}><IconClose size="var(--icon-meta)"/></TooltipButton>
    </div>
  );
}
export function ToastHost({toasts,sources,onOpen,onDismiss,onError}:{toasts:Toast[];sources:Record<string,ToastSource>;onOpen:(runtimeId:string)=>void;onDismiss:(id:number)=>void;onError:(error:unknown)=>void}) {
  const { t } = useTranslation();
  const viewport=useRef<HTMLDivElement>(null);
  const visible=toasts.slice(0,3);
  useFlipList(viewport, visible.map(toast=>toast.id));
  return <div ref={viewport} className="toast-viewport" aria-live="polite">{visible.map(toast=><div className="toast-slot" data-flip-key={toast.id} key={toast.id}><ToastCard toast={toast} source={sources[toast.runtimeId]} onOpen={onOpen} onDismiss={onDismiss} onError={onError}/></div>)}{toasts.length>3&&<span className="toast-overflow" aria-label={t('shell.toastMore',{count:toasts.length-3})}>+{toasts.length-3}</span>}</div>;
}
