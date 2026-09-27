import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSidebar, IconNewSession, IconSearch, IconClose, IconMinus, IconSquare, IconInfo, IconCircleAlert, IconFolder } from '../ui/icons';
import { TooltipButton } from '../ui/ui';
import type { RuntimeNotice } from './runtime-store';

export function ConversationTopbar({title,project,collapsed,panelOpen,onToggleSidebar,onNew,onSearch,onChooseWorkspace}:{title:string;project:string;collapsed:boolean;panelOpen:boolean;onToggleSidebar:()=>void;onNew:()=>void;onSearch:()=>void;onChooseWorkspace:()=>void}) {
  const { t } = useTranslation();
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
      <div className="ct-left">
        <div ref={lead} className="ct-lead" inert={!leadVisible || undefined} aria-hidden={!leadVisible || undefined}>
          <TooltipButton data-sidebar-toggle="expand" className="ct-icon-btn lg-thin lg-capsule lg-pressable" tooltip={`${t('nav.toggleSidebar')} (⌘/Ctrl+B)`} ariaLabel={t('nav.toggleSidebar')} tabIndex={leadVisible ? undefined : -1} onClick={onToggleSidebar}><IconSidebar size={15}/></TooltipButton>
        </div>
        <div className="ct-title-wrap" title={`${project} · ${title}`}><span className="ct-title">{title}</span></div>
        <button type="button" className="omp-workspace-chip no-drag lg-thin lg-capsule lg-pressable" title={`${t('omp.shell.switchWorkspace')}${project ? `\n${project}` : ''}`} aria-label={`${t('omp.shell.switchWorkspace')}${project ? `: ${project}` : ''}`} onClick={onChooseWorkspace}><IconFolder size={13}/><span>{project.split(/[/\\]/).filter(Boolean).pop() || t('omp.shell.chooseWorkspace')}</span></button>
      </div>
      <div className="ct-right"><div className="ct-actions">
        <TooltipButton className="ct-icon-btn lg-thin lg-capsule lg-pressable" tooltip={`${t('omp.shell.newSession')} (⌘/Ctrl+N)`} ariaLabel={t('omp.shell.newSession')} onClick={onNew}><IconNewSession size={15}/></TooltipButton>
        <TooltipButton className="ct-icon-btn lg-thin lg-capsule lg-pressable" tooltip={`${t('nav.search')} (⌘/Ctrl+K)`} ariaLabel={t('nav.search')} onClick={onSearch}><IconSearch size={15}/></TooltipButton>
      </div></div>
    </div>
  );
}
export function WindowControls({platform,onError}:{platform:string;onError:(error:unknown)=>void}) {
  const { t } = useTranslation();
  if(platform === 'darwin') return null;
  return <div className="window-controls no-drag">{(['minimize','maximize','close'] as const).map(action => (
    <TooltipButton key={action} className={`window-control-btn${action === 'close' ? ' window-control-close' : ''}`} tooltip={action === 'maximize' ? `${t('window.maximize')} / ${t('window.restore')}` : t(`window.${action}`)} ariaLabel={t(`window.${action}`)} onClick={()=>{void window.ompDesktop.windowAction(action).catch(onError);}}>
      {action === 'minimize' ? <IconMinus size={12}/> : action === 'maximize' ? <IconSquare size={10}/> : <IconClose size={12}/>}
    </TooltipButton>
  ))}</div>;
}
export type Toast = RuntimeNotice & {id:number};
function ToastCard({toast,onDismiss,onError}:{toast:Toast;onDismiss:(id:number)=>void;onError:(error:unknown)=>void}) {
  const { t } = useTranslation();
  const [paused,setPaused]=useState(false);
  const [closing,setClosing]=useState(false);
  const dismiss=()=>{if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)onDismiss(toast.id);else setClosing(true);};
  const remaining=useRef(7000);
  useEffect(()=>{if(paused || closing || toast.error || toast.url) return; const start=Date.now(); const timer=window.setTimeout(()=>{if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)onDismiss(toast.id);else setClosing(true);},remaining.current); return ()=>{window.clearTimeout(timer);remaining.current-=Date.now()-start;};},[paused,closing,toast,onDismiss]);
  return (
    <div className={`toast lg-thick lg-refract lg-capsule ${toast.error ? 'error' : 'info'}${closing ? ' closing' : ''}`} role={toast.error ? 'alert' : 'status'} onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)} onAnimationEnd={event=>{if(event.target===event.currentTarget&&event.animationName==='toast-out')onDismiss(toast.id);}}>
      <span className="toast-icon">{toast.error ? <IconCircleAlert size={16}/> : <IconInfo size={16}/>}</span>
      <span className="toast-message selectable">{toast.message}{toast.url && <button className="omp-toast-link" onClick={()=>{void window.ompDesktop.openExternal(toast.url!).catch(onError);}}>{toast.url}</button>}</span>
      <TooltipButton className="toast-dismiss" tooltip={t('common.close')} ariaLabel={t('common.close')} onClick={dismiss}><IconClose size={13}/></TooltipButton>
    </div>
  );
}
export function ToastHost({toasts,onDismiss,onError}:{toasts:Toast[];onDismiss:(id:number)=>void;onError:(error:unknown)=>void}) {
  return <div className="toast-viewport" aria-live="polite">{toasts.map(toast=><ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} onError={onError}/>)}</div>;
}
