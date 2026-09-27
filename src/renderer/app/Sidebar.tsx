import { useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PortalVisibilityContext, portalToBody, useGlassExit } from '../lib/portal-visibility';
import type { SessionSummary } from '../../shared/contracts';
import { IconSidebar, IconSettings, IconFolder, IconNewSession, IconNewProject, IconChevronDown, IconMore, IconPin, IconSearch } from '../ui/icons';
import { TooltipButton } from '../ui/ui';
import { useLiquidIndicator } from '../lib/glass/useLiquidIndicator';

export type SidebarSession = SessionSummary & {runtimeId?:string;running?:boolean;failed?:boolean;pending?:boolean;closed?:boolean};
interface Props {sessions:SidebarSession[];workspaces:string[];workspace:string;active:string|null;pinned:string[];width:number;widthMax:number;version?:string;loading:boolean;errors:{path:string;message:string}[];exiting?:boolean;onExitComplete?:()=>void;onSelect:(session:SidebarSession)=>void;onNew:(cwd?:string)=>void;onChoose:()=>void;onHome:()=>void;onSearch:()=>void;onSettings:()=>void;onOpenFile:()=>void;onRefresh:()=>void;onToggle:()=>void;onWidth:(width:number,commit:boolean)=>void;onPin:(session:SidebarSession)=>void;onRename:(session:SidebarSession)=>void;onBranch:(session:SidebarSession)=>void;onDisconnect:(session:SidebarSession)=>void}
export function Sidebar(props:Props) {
  const { t } = useTranslation();
  const visible = useContext(PortalVisibilityContext);
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({}),[expanded,setExpanded]=useState<Record<string,boolean>>({}),[menu,setMenu]=useState<{session:SidebarSession;x:number;y:number}|null>(null);
  const resize=useRef<{x:number;width:number;current:number}|null>(null);
  const menuRef=useRef<HTMLDivElement>(null);
  useGlassExit(menuRef,!!menu&&visible);
  useLayoutEffect(()=>{
    const surface=menuRef.current;
    if(!menu||!visible||!surface)return;
    const rect=surface.getBoundingClientRect();
    surface.style.setProperty('--lg-origin-x',`${menu.x-rect.left}px`);
    surface.style.setProperty('--lg-origin-y',`${menu.y-rect.top}px`);
    surface.classList.add('lg-morph-in');
  },[menu,visible]);
  const listRef=useRef<HTMLDivElement>(null),pinnedRef=useRef<HTMLDivElement>(null);
  const selectedSession=props.sessions.find(session=>props.active===(session.runtimeId||session.path)||props.active===session.path);
  const selectedKey=selectedSession?.id??null;
  const indicatorRef=useLiquidIndicator(listRef,selectedSession&&collapsed[selectedSession.cwd]?null:selectedKey,'y');
  const pinnedIndicatorRef=useLiquidIndicator(pinnedRef,selectedSession&&props.pinned.includes(selectedSession.path)?selectedKey:null,'y');
  const [diagnosticsOpen,setDiagnosticsOpen]=useState(false);
  useEffect(()=>{if(!visible||props.exiting)setMenu(null);},[visible,props.exiting]);
  useEffect(()=>{
    if(!menu || !visible)return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close=(event:MouseEvent)=>{if(!menuRef.current?.contains(event.target as Node))setMenu(null);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setMenu(null);};
    window.addEventListener('pointerdown',close);window.addEventListener('keydown',key);
    return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',key);};
  },[menu,visible]);
  useEffect(()=>()=>document.documentElement.removeAttribute('data-sidebar-resizing'),[]);
  const workspaces=[...new Set([...props.workspaces,...props.sessions.map(session=>session.cwd)].filter(Boolean))];
  const pinned=props.sessions.filter(session=>props.pinned.includes(session.path));
  const renderSession=(session:SidebarSession,global=false)=>(
    <div key={session.path||session.id} data-liquid-key={session.id} className={`thread-item ${props.active===(session.runtimeId||session.path)||props.active===session.path?'active':''}`} onContextMenu={event=>{event.preventDefault();setMenu({session,x:event.clientX,y:event.clientY});}}>
      <button className="thread-item-main" title={`${session.title}\n${session.preview}\n${session.cwd}`} onClick={()=>props.onSelect(session)}>
        <span className={`thread-item-status ${session.failed?'failed':session.running?'running':session.pending?'waiting':'completed'}`} aria-label={t(!session.runtimeId||session.closed?'omp.history.readonly':session.failed?'nav.sessionFailed':session.running?'nav.sessionRunning':session.pending?'omp.shell.needsResponse':'sessionCollaboration.statusIdle')}/>
        {props.pinned.includes(session.path)&&<IconPin size={11} className="thread-item-pin"/>}
        <span className="thread-item-title">{session.title||t('omp.shell.newSession')}</span>
        {global&&<span className="thread-item-project">{session.cwd.split(/[/\\]/).filter(Boolean).pop()}</span>}
      </button>
      <div className="sidebar-row-actions"><TooltipButton className="thread-item-more" tooltip={t('nav.sessionActions')} ariaLabel={t('nav.sessionActions')} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setMenu({session,x:rect.right,y:rect.bottom});}}><IconMore size={14}/></TooltipButton></div>
    </div>
  );
  const finishResize=(event:PointerEvent<HTMLDivElement>)=>{if(!resize.current)return;const width=resize.current.current;resize.current=null;document.documentElement.removeAttribute('data-sidebar-resizing');if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(width<180)props.onToggle();else props.onWidth(Math.max(240,width),true);};
  return (
    <aside className={`sidebar omp-sidebar lg-regular lg-pane${props.exiting?' is-exiting':''}`} style={{width:props.width}} inert={props.exiting||undefined} aria-hidden={props.exiting||undefined} onAnimationEnd={event=>{if(event.target===event.currentTarget&&(event.animationName==='sidebar-out'||event.animationName==='sidebar-out-windows'))props.onExitComplete?.();}}>
      <div className="sidebar-header">
        <TooltipButton className="brand no-drag" tooltip={t('nav.home')} ariaLabel={t('nav.home')} onClick={props.onHome}><span className="omp-brand-mark">omp</span><span>Desktop</span></TooltipButton>
        <div className="sidebar-header-actions no-drag"><TooltipButton data-sidebar-toggle="collapse" className="icon-btn icon-btn-square" tooltip={t('nav.collapseSidebar')} ariaLabel={t('nav.collapseSidebar')} onClick={props.onToggle}><IconSidebar size={16}/></TooltipButton></div>
      </div>
      <div className="sidebar-body no-drag">
        <div className="omp-sidebar-navigation">
          <button className="search-item" onClick={()=>props.onNew()}><IconNewSession size={15}/><span>{t('omp.shell.newSession')}</span></button>
          <button className="search-item" onClick={props.onSearch}><IconSearch size={15}/><span>{t('nav.search')}</span></button>
        </div>
        {pinned.length>0&&<section className="sidebar-pinned-sessions"><div className="sidebar-list-toolbar sidebar-list-toolbar-secondary"><span className="sidebar-list-label">{t('nav.pinnedSessions')}</span></div><div ref={pinnedRef} className="sidebar-session-group-body pinned"><div ref={pinnedIndicatorRef} className="lg-liquid-indicator" aria-hidden />{pinned.map(session=>renderSession(session,true))}</div></section>}
        <div className="sidebar-list-toolbar"><span className="sidebar-list-label">{t('nav.projects')}</span><TooltipButton className="sidebar-toolbar-button" tooltip={t('omp.shell.chooseWorkspace')} ariaLabel={t('omp.shell.chooseWorkspace')} onClick={props.onChoose}><IconNewProject size={15}/></TooltipButton></div>
        <div ref={listRef} className="sidebar-session-groups min-h-0 flex-1 overflow-auto px-0.5">
          <div ref={indicatorRef} className="lg-liquid-indicator" aria-hidden />
          {workspaces.map(cwd=>{
            const sessions=props.sessions.filter(session=>session.cwd===cwd);
            const rows=expanded[cwd]?sessions:sessions.slice(0,10);
            let lastGroup='';
            return (
              <section key={cwd} className="sidebar-session-group project-group" data-current-workspace={props.workspace===cwd?'true':undefined}>
                <div className="sidebar-session-group-header">
                  <button className="sidebar-session-group-title project-toggle" title={cwd} aria-expanded={!collapsed[cwd]} onClick={()=>setCollapsed(value=>({...value,[cwd]:!value[cwd]}))}>
                    <IconChevronDown size={13} className={`sidebar-disclosure-icon ${collapsed[cwd]?'collapsed':''}`}/><IconFolder size={13}/>
                    <span>{cwd.split(/[/\\]/).filter(Boolean).pop()||cwd}</span>{props.workspace===cwd&&<span className="sidebar-project-active-dot"/>}
                  </button>
                  <TooltipButton className="sidebar-session-group-add" tooltip={t('omp.shell.newSession')} ariaLabel={t('omp.shell.newSession')} onClick={()=>props.onNew(cwd)}><IconNewSession size={13}/></TooltipButton>
                </div>
                <div className={`sidebar-session-group-body project ${collapsed[cwd]?'collapsed':''}`} aria-hidden={!!collapsed[cwd]} inert={collapsed[cwd]||undefined}><div className="sidebar-session-group-clip"><div className="sidebar-session-group-list">
                  {rows.map(session=>{
                    const age=Date.now()-Date.parse(session.updatedAt);
                    const group=age<86400000?'omp.shell.today':age<7*86400000?'nav.timeGroupThisWeek':'nav.timeGroupArchived';
                    const header=lastGroup!==group;lastGroup=group;
                    return <div key={session.path||session.id}>{header&&<div className="sidebar-time-group-header">{t(group)}</div>}{renderSession(session)}</div>;
                  })}
                  {!sessions.length&&<div className="sidebar-session-empty">{t('nav.noProjectSessions')}</div>}
                  {sessions.length>10&&!expanded[cwd]&&<button className="sidebar-load-more" onClick={()=>setExpanded(value=>({...value,[cwd]:true}))}>{t('nav.loadMoreCount',{count:sessions.length-10})}</button>}
                </div></div></div>
              </section>
            );
          })}
          {!workspaces.length&&<button className="sidebar-session-group-title" onClick={props.onChoose}><IconFolder size={13}/>{t('omp.shell.chooseWorkspace')}</button>}
          {props.loading&&<div className="sidebar-session-empty" role="status">{t('omp.shell.readingHistory')}</div>}
        </div>
        {props.errors.length>0&&<section className="omp-history-diagnostics lg-thin lg-control">
          <div className="omp-diagnostic-row"><button type="button" className="omp-diagnostic-toggle" aria-expanded={diagnosticsOpen} aria-controls="history-source-diagnostics" onClick={()=>setDiagnosticsOpen(value=>!value)}><IconChevronDown size={12} className={`sidebar-disclosure-icon ${diagnosticsOpen?'':'collapsed'}`}/><span>{t('omp.shell.historySourcesUnreadable',{count:props.errors.length})}</span></button><button type="button" className="omp-diagnostic-retry" disabled={props.loading} onClick={props.onRefresh}>{t('omp.shell.retry')}</button></div>
          {diagnosticsOpen&&<ul id="history-source-diagnostics" className="omp-diagnostic-list">{props.errors.map((item,index)=><li key={`${item.path}:${index}`} title={item.path?`${item.path}\n${item.message}`:item.message}><strong>{item.path.split(/[/\\]/).filter(Boolean).pop()||t('omp.shell.historySource')}</strong><span>{item.message.split(/[,\n]/,1)[0]}</span>{item.path&&<input readOnly aria-label={t('omp.shell.sourcePath')} title={item.path} value={item.path} onFocus={event=>event.currentTarget.select()}/>}</li>)}</ul>}
        </section>}
        <div className="sidebar-footer no-drag"><div className="footer-actions">
          <TooltipButton className="footer-action" tooltip={`${t('nav.settings')} (⌘/Ctrl+,)`} ariaLabel={t('nav.settings')} onClick={props.onSettings}><IconSettings size={16}/></TooltipButton>
          <TooltipButton className="footer-action" tooltip={t('omp.shell.openSessionFile')} ariaLabel={t('omp.shell.openSessionFile')} onClick={props.onOpenFile}><IconFolder size={16}/></TooltipButton>
        </div><span className="footer-build" title={t('omp.shell.installedRuntime')}>{props.version?`omp ${props.version}`:t('omp.shell.localRuntime')}</span></div>
      </div>
      <div className="sidebar-resize-handle no-drag" role="separator" tabIndex={0} aria-label={t('nav.resizeSidebar')} aria-orientation="vertical" aria-valuemin={240} aria-valuemax={props.widthMax} aria-valuenow={props.width} onDoubleClick={()=>props.onWidth(275,true)} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();props.onWidth(Math.max(240,Math.min(props.widthMax,props.width+(event.key==='ArrowLeft'?-16:16))),true);}}} onPointerDown={event=>{resize.current={x:event.clientX,width:props.width,current:props.width};event.currentTarget.setPointerCapture(event.pointerId);document.documentElement.setAttribute('data-sidebar-resizing','true');}} onPointerMove={event=>{const current=resize.current;if(!current)return;current.current=Math.min(props.widthMax,current.width+event.clientX-current.x);props.onWidth(Math.max(160,current.current),false);}} onPointerUp={finishResize} onPointerCancel={finishResize}/>
      {menu&&visible&&portalToBody(
        <div ref={menuRef} className="sidebar-row-menu sidebar-floating-menu lg-regular lg-menu" role="menu" style={{position:'fixed',left:Math.max(8,Math.min(menu.x,window.innerWidth-220)),top:Math.max(8,Math.min(menu.y,window.innerHeight-220))}} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const buttons=Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')??[]);const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}}}>
          <button role="menuitem" onClick={()=>{props.onPin(menu.session);setMenu(null);}}>{t(props.pinned.includes(menu.session.path)?'nav.unpinTask':'nav.pinTask')}</button>
          <button role="menuitem" disabled={!menu.session.runtimeId||menu.session.closed} title={!menu.session.runtimeId||menu.session.closed?t('omp.history.ownedBranchOnly'):undefined} onClick={()=>{props.onRename(menu.session);setMenu(null);}}>{t('nav.renameTask')}</button>
          <button role="menuitem" onClick={()=>{props.onBranch(menu.session);setMenu(null);}}>{t('omp.history.tree')}</button>
          {menu.session.runtimeId&&!menu.session.closed&&<button role="menuitem" onClick={()=>{props.onDisconnect(menu.session);setMenu(null);}}>{t('omp.shell.disconnectRuntime')}</button>}
        </div>
      )}
    </aside>
  );
}
