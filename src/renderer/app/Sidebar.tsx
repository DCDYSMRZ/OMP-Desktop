import { useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PortalVisibilityContext, portalToBody } from '../lib/portal-visibility';
import { projectSidebarSessions, sidebarProjects, sidebarProjectRows, sidebarProjectNeedsAttention, sidebarForkReason, type SidebarSession } from './sidebar-session';
import { IconSidebar, IconSettings, IconFolder, IconNewSession, IconNewProject, IconChevronDown, IconMore, IconPin, IconSearch, IconBranch } from '../ui/icons';
import { TooltipButton } from '../ui/ui';
import { SessionPreviewCard } from './SessionPreviewCard';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { useFlipList } from '../ui/motion';
import { sidebarStatus } from './sidebar-status';
import { AnchoredMenu } from '../ui/AnchoredMenu';
import { presentUserError } from '../lib/user-errors';
import { shouldRevealSidebar, type SidebarRevealTarget } from './sidebar-reveal';
import { noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';

interface Props {sessions:SidebarSession[];workspaces:string[];hiddenProjects:readonly string[];workspace:string;active:string|null;pinned:string[];width:number;widthMax:number;loading:boolean;errors:{path:string;message:string}[];exiting?:boolean;onSelect:(session:SidebarSession)=>void;onBrowseWorkspace:(cwd:string)=>void;onRemoveWorkspace:(cwd:string)=>void;onNew:(cwd?:string)=>void;onChoose:()=>void;onHome:()=>void;onSearch:()=>void;onSettings:()=>void;onRefresh:()=>void;onToggle:()=>void;onWidth:(width:number,commit:boolean)=>void;onPin:(session:SidebarSession)=>void;onRename:(session:SidebarSession)=>void;onBranch:(session:SidebarSession)=>void;onDisconnect:(session:SidebarSession)=>void;onRemove:(session:SidebarSession)=>void}
interface Props { collapsedProjects: Record<string, boolean>; onCollapse: (path: string, collapsed: boolean) => void }
interface ForkProps { onFork: (session: SidebarSession) => Promise<void>; onError: (error: unknown) => void }
export function Sidebar(props:Props & ForkProps) {
  const { t } = useTranslation();
  const visible = useContext(PortalVisibilityContext);
  const collapsed=props.collapsedProjects;
  const [expanded,setExpanded]=useState<Record<string,boolean>>({}),[menu,setMenu]=useState<{session:SidebarSession;x:number;y:number}|null>(null);
  const [projectMenu,setProjectMenu]=useState<string|null>(null);
  const resize=useRef<{x:number;width:number;current:number}|null>(null);
  const menuRef=useRef<HTMLDivElement>(null);
  const menuReturnFocus=useRef<HTMLButtonElement|null>(null);
  const dismissMenu=()=>{menuReturnFocus.current?.focus({preventScroll:true});setMenu(null);};
  const [diagnosticsOpen,setDiagnosticsOpen]=useState(false);
  const [forking,setForking]=useState<string|null>(null);
  const forkReason=menu?sidebarForkReason(menu.session):undefined;
  const forkable=!!menu&&!forkReason;
  const fork=async(session:SidebarSession)=>{
    if(forking)return;
    setForking(session.path);
    try{await props.onFork(session);setMenu(null);}
    catch(error){props.onError(error);}
    finally{setForking(null);}
  };
  const list=useRef<HTMLDivElement>(null);
  useFlipList(list,props.sessions.map(session=>session.runtimeId||session.path||session.id),{animate:!props.loading,insert:'fade'});
  const activeSession=props.sessions.find(session=>props.active===(session.runtimeId||session.path)||props.active===session.path);
  const activeProject=activeSession?.cwd;
  const revealTarget=useRef<SidebarRevealTarget | undefined>(undefined);
  useLayoutEffect(()=>{
    const row=list.current?.querySelector<HTMLElement>('.thread-item.active');
    const scroller=list.current?.querySelector<HTMLElement>('.sidebar-session-groups');
    const next={active:props.active,project:activeProject,visible:visible&&!props.exiting,rowVisible:!!row&&!row.closest('[aria-hidden="true"]')};
    const reveal=shouldRevealSidebar(revealTarget.current,next);
    revealTarget.current=next;
    if(!reveal||!row||!scroller)return;
    const bounds=row.getBoundingClientRect(),viewport=scroller.getBoundingClientRect();
    const delta=bounds.top<viewport.top?bounds.top-viewport.top:bounds.bottom>viewport.bottom?bounds.bottom-viewport.bottom:0;
    if(delta){scroller.scrollTop+=delta;noteProgrammaticScroll(scroller);}
  });
  useEffect(()=>{if(!visible||props.exiting)setMenu(null);},[visible,props.exiting]);
  useEffect(()=>{
    if(!menu || !visible)return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close=(event:MouseEvent)=>{if(!menuRef.current?.contains(event.target as Node))setMenu(null);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')dismissMenu();};
    window.addEventListener('pointerdown',close);window.addEventListener('keydown',key);
    return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',key);};
  },[menu,visible]);
  useEffect(()=>()=>document.documentElement.removeAttribute('data-sidebar-resizing'),[]);
  const workspaces=sidebarProjects(props.workspaces,props.sessions).filter(cwd=>!props.hiddenProjects.includes(cwd));
  const titles=new Map<string,number>();
  for(const session of props.sessions){const title=plainMarkdownLine(session.title).replace(/\s+/g,' ').trim();titles.set(title,(titles.get(title)??0)+1);}
  const renderSession=(session:SidebarSession)=>(
    <SessionPreviewCard key={session.runtimeId||session.path||session.id} session={session} disabled={!!menu||props.exiting} className={`thread-item ${props.active===(session.runtimeId||session.path)||props.active===session.path?'active':''}`} onContextMenu={event=>{event.preventDefault();menuReturnFocus.current=event.currentTarget.querySelector<HTMLButtonElement>('.thread-item-more');setMenu({session,x:event.clientX,y:event.clientY});}}>
      {({descriptionId,relativeTime})=>{const status=sidebarStatus(session);const inferred=status==='running'&&session.activity==='running'&&(!session.running||session.closed);const statusLabel=status?t(inferred?(session.activitySource==='presence'?'sidebar.status.presenceRunning':'sidebar.status.observedRunning'):`sidebar.status.${status}`,{time:relativeTime}):undefined;return <>
      <button className="thread-item-main" aria-current={props.active===(session.runtimeId||session.path)||props.active===session.path?'page':undefined} aria-describedby={descriptionId} onClick={()=>props.onSelect(session)}>
        <span className={`thread-item-status${status?` ${status}`:''}`} title={statusLabel} aria-label={statusLabel} aria-hidden={!status||undefined}/>
        {props.pinned.includes(session.path)&&<IconPin size="var(--icon-caption)" className="thread-item-pin"/>}
        {session.parentSession&&<span className="thread-item-fork" title={t('sidebar.forkOf',{title:props.sessions.find(parent=>parent.path===session.parentSession||parent.id===session.parentSession)?.title||t('sidebar.parentUnavailable')})}><IconBranch size="var(--icon-caption)"/></span>}
        <span className="thread-item-title">{plainMarkdownLine(session.title).replace(/\s+/g, ' ').trim()||t('omp.shell.newSession')}</span>
        <span className={`thread-item-time${(titles.get(plainMarkdownLine(session.title).replace(/\s+/g,' ').trim())??0)>1?' is-disambiguation':''}`} aria-label={t('sidebar.updated',{time:relativeTime})}>{relativeTime}</span>
      </button>
      <div className="sidebar-row-actions"><TooltipButton className="thread-item-more" tooltip={t('nav.sessionActions')} ariaLabel={t('nav.sessionActions')} onClick={event=>{menuReturnFocus.current=event.currentTarget;const rect=event.currentTarget.getBoundingClientRect();setMenu({session,x:rect.right,y:rect.bottom});}}><IconMore size="var(--icon-meta)"/></TooltipButton></div>
      </>;}}
    </SessionPreviewCard>
  );
  const finishResize=(event:PointerEvent<HTMLDivElement>)=>{if(!resize.current)return;const width=resize.current.current;resize.current=null;document.documentElement.removeAttribute('data-sidebar-resizing');if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(width<180)props.onToggle();else props.onWidth(Math.max(240,width),true);};
  return (
    <aside className={`sidebar sidebar-surface omp-sidebar${props.exiting?' is-exiting':''}`} style={{width:props.width}} inert={props.exiting||undefined} aria-hidden={props.exiting||undefined}>
      <div className="sidebar-header">
        <TooltipButton className="brand no-drag" tooltip={t('nav.home')} ariaLabel={t('nav.home')} onClick={props.onHome}><span className="omp-brand-mark">omp</span><span>Desktop</span></TooltipButton>
        <div className="sidebar-header-actions no-drag"><TooltipButton data-sidebar-toggle="collapse" className="icon-btn icon-btn-square" tooltip={t('nav.collapseSidebar')} ariaLabel={t('nav.collapseSidebar')} onClick={props.onToggle}><IconSidebar size="var(--icon-ui)"/></TooltipButton></div>
      </div>
      <div ref={list} className="sidebar-body no-drag">
        <div className="omp-sidebar-navigation">
          <button className="search-item" onClick={()=>props.onNew()}><IconNewSession size="var(--icon-ui)"/><span>{t('omp.shell.newSession')}</span></button>
          <button className="search-item" onClick={props.onSearch}><IconSearch size="var(--icon-ui)"/><span>{t('nav.search')}</span></button>
        </div>
        <div className="sidebar-list-toolbar"><span className="sidebar-list-label">{t('nav.projects')}</span><TooltipButton className="sidebar-toolbar-button" tooltip={t('sidebar.addProject')} ariaLabel={t('sidebar.addProject')} onClick={props.onChoose}><IconNewProject size="var(--icon-ui)"/></TooltipButton></div>
        <div className="sidebar-session-groups min-h-0 flex-1 overflow-auto px-0.5">
          
          {workspaces.map((cwd,projectIndex)=>{
            const sessions=projectSidebarSessions(props.sessions,cwd,props.pinned);
            const isCollapsed=!sidebarProjectNeedsAttention(sessions,props.active)&&(collapsed[cwd]??projectIndex>=3);
            const rows=sidebarProjectRows(sessions,props.workspace===cwd,!!expanded[cwd],props.active);
            return (
              <section key={cwd} className="sidebar-session-group project-group" data-current-workspace={props.workspace===cwd?'true':undefined}>
                <div className="sidebar-session-group-header">
                  <button className="omp-project-disclosure" title={cwd} aria-label={t(isCollapsed?'omp.shell.expandWorkspace':'omp.shell.collapseWorkspace',{workspace:cwd})} aria-expanded={!isCollapsed} onClick={()=>props.onCollapse(cwd,!isCollapsed)}><IconChevronDown size="var(--icon-meta)" className={`sidebar-disclosure-icon ${isCollapsed?'collapsed':''}`}/></button>
                  <button className="sidebar-session-group-title project-toggle" title={t('omp.shell.browseWorkspaceNamed',{workspace:cwd})} aria-current={props.workspace===cwd?'location':undefined} onClick={()=>props.onBrowseWorkspace(cwd)}>
                    <IconFolder size="var(--icon-meta)"/><span>{cwd.split(/[/\\]/).filter(Boolean).pop()||cwd}</span>
                  </button>
                  <TooltipButton className="sidebar-session-group-add" tooltip={t('omp.shell.newSession')} ariaLabel={t('omp.shell.newSession')} onClick={()=>props.onNew(cwd)}><IconNewSession size="var(--icon-meta)"/></TooltipButton>
                  <AnchoredMenu open={projectMenu===cwd} onClose={()=>setProjectMenu(null)} menuClassName="shell-history-menu" label={t('sidebar.projectActions')} trigger={ref=><button ref={ref} className="sidebar-session-group-add" aria-label={t('sidebar.projectActions')} onClick={()=>setProjectMenu(projectMenu===cwd?null:cwd)}><IconMore size="var(--icon-meta)"/></button>}>
                    <button onClick={()=>{setProjectMenu(null);void window.ompDesktop.revealFile(cwd,'.').catch(props.onError);}}>{t('sidebar.revealProject')}</button>
                    <button onClick={()=>{setProjectMenu(null);void window.ompDesktop.openInEditor({cwd,path:'.'}).catch(props.onError);}}>{t('sidebar.editProject')}</button>
                    <button onClick={()=>{setProjectMenu(null);props.onRemoveWorkspace(cwd);}}>{t('sidebar.removeProject')}</button>
                  </AnchoredMenu>
                </div>
                <div className={`sidebar-session-group-body project ${isCollapsed?'collapsed':''}`} aria-hidden={isCollapsed} inert={isCollapsed||undefined}><div className="sidebar-session-group-clip"><div className="sidebar-session-group-list">
                  {rows.map(renderSession)}
                  {!sessions.length&&<div className="sidebar-session-empty">{t('nav.noProjectSessions')}</div>}
                  {sessions.length>rows.length&&<button className="sidebar-load-more" onClick={()=>setExpanded(value=>({...value,[cwd]:true}))}>{t('sidebar.showRemaining',{count:sessions.length-rows.length})}</button>}
                  {expanded[cwd]&&sessions.length>(props.workspace===cwd?8:5)&&<button className="sidebar-load-more" onClick={()=>setExpanded(value=>({...value,[cwd]:false}))}>{t('sidebar.showLess')}</button>}
                </div></div></div>
              </section>
            );
          })}
          {!workspaces.length&&<button className="sidebar-session-group-title" onClick={props.onChoose}><IconFolder size="var(--icon-meta)"/>{t('omp.shell.chooseWorkspace')}</button>}
          {props.loading&&<div className="sidebar-session-empty" role="status">{t('omp.shell.readingHistory')}</div>}
        </div>
        {props.errors.length>0&&<section className="omp-history-diagnostics">
          <div className="omp-diagnostic-row"><button type="button" className="omp-diagnostic-toggle" aria-expanded={diagnosticsOpen} aria-controls="history-source-diagnostics" onClick={()=>setDiagnosticsOpen(value=>!value)}><span>{t('sidebar.sourceProblems',{count:props.errors.length})}</span></button></div>
          {diagnosticsOpen&&<ul id="history-source-diagnostics" className="omp-diagnostic-list">{props.errors.map((item,index)=>{const problem=presentUserError(item.message);return <li key={`${item.path}:${index}`}><span>{problem.message} {problem.action}</span><details><summary>{t('omp.errors.details')}</summary><p>{item.message}</p>{item.path&&<input readOnly aria-label={t('omp.shell.sourcePath')} value={item.path} onFocus={event=>event.currentTarget.select()}/>}</details></li>;})}<li><button disabled={props.loading} onClick={props.onRefresh}>{t('omp.shell.retry')}</button></li></ul>}
        </section>}
        <div className="sidebar-footer no-drag"><button className="footer-action" title={`${t('nav.settings')} (⌘/Ctrl+,)`} onClick={props.onSettings}><IconSettings size="var(--icon-ui)"/><span>{t('nav.settings')}</span></button></div>
      </div>
      <div className="sidebar-resize-handle no-drag" role="separator" tabIndex={0} aria-label={t('nav.resizeSidebar')} aria-orientation="vertical" aria-valuemin={240} aria-valuemax={props.widthMax} aria-valuenow={props.width} onDoubleClick={()=>props.onWidth(275,true)} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();props.onWidth(Math.max(240,Math.min(props.widthMax,props.width+(event.key==='ArrowLeft'?-16:16))),true);}}} onPointerDown={event=>{resize.current={x:event.clientX,width:props.width,current:props.width};event.currentTarget.setPointerCapture(event.pointerId);document.documentElement.setAttribute('data-sidebar-resizing','true');}} onPointerMove={event=>{const current=resize.current;if(!current)return;current.current=Math.min(props.widthMax,current.width+event.clientX-current.x);props.onWidth(Math.max(160,current.current),false);}} onPointerUp={finishResize} onPointerCancel={finishResize}/>
      {menu&&visible&&portalToBody(
        <div ref={menuRef} className="sidebar-row-menu sidebar-floating-menu" role="menu" style={{position:'fixed',left:Math.max(8,Math.min(menu.x,window.innerWidth-220)),top:Math.max(8,Math.min(menu.y,window.innerHeight-220))}} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const buttons=Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')??[]);const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}}}>
          <button role="menuitem" onClick={()=>{props.onPin(menu.session);setMenu(null);}}>{t(props.pinned.includes(menu.session.path)?'nav.unpinTask':'nav.pinTask')}</button>
          <button role="menuitem" disabled={!menu.session.runtimeId||menu.session.closed} title={!menu.session.runtimeId||menu.session.closed?t('omp.history.ownedBranchOnly'):undefined} onClick={()=>{dismissMenu();props.onRename(menu.session);}}>{t('sidebar.renameSession')}</button>
          <button role="menuitem" disabled={!!menu.session.source&&menu.session.source.status!=='persisted'} onClick={()=>{dismissMenu();props.onBranch(menu.session);}}>{t('shell.historyBranches')}</button>
          <button role="menuitem" disabled={!forkable||!!forking} title={forkReason?t(`sidebar.fork.${forkReason}`):t('omp.history.forkTooltip')} onClick={()=>void fork(menu.session)}>{t(forking===menu.session.path?'omp.history.forking':'omp.composer.fork')}{forkReason&&<small className="sidebar-fork-reason">{t(`sidebar.fork.${forkReason}`)}</small>}</button>
          {menu.session.runtimeId&&!menu.session.closed&&<button role="menuitem" onClick={()=>{props.onDisconnect(menu.session);setMenu(null);}}>{t('sidebar.disconnectSession')}</button>}
          <button role="menuitem" onClick={()=>{dismissMenu();props.onRemove(menu.session);}}>{t(menu.session.source?.status==='unpersisted'?'omp.removal.discard':'sidebar.deleteSession')}</button>
        </div>
      )}
    </aside>
  );
}
