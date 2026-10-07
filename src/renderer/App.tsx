import { presentUserError, UserFacingError } from './lib/user-errors';
import { UserErrorNotice } from './lib/UserErrorNotice';
import { displaySessionTitle } from './lib/session-title';
import { modelNames } from '../shared/model-display-name';
import { settleAgentMessage } from '../shared/subagent-evidence';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { DisplayPreferencesContext } from './lib/display-preferences';
import { animateTo, isMotionPaused, motion } from './ui/motion';
import type { ReviewPanelRequest as PanelRequest } from './workspace/WorkPanel';
import type { Bootstrap, DesktopPreferences, NativeSubagent, PromptInput, RuntimeAccess, SavedSubagentNavigation, SessionSummary, SessionParentResolution, SessionRemovalTarget, SessionRemovalResult } from '../shared/contracts';
import { ChatView } from './chat/ChatView';
import { StartupRecovery } from './chat/HomePanel';
import { deriveHomeReadiness, sessionProseExcerpt } from './chat/home-model';
import { ExtensionDialog } from './chat/ExtensionDialog';
import type { TranscriptHandle } from './chat/Transcript';
import { SettingsPage } from './settings/SettingsPage';
import { forgetWorkPanelSources, WorkPanel } from './workspace/WorkPanel';
import { PortalVisibilityProvider } from './lib/portal-visibility';
import { IconPanel, IconPanelOpen } from './ui/icons';
import { Button, TooltipButton, OverlayPresence } from './ui/ui';
import type { SettingsDestination, SettingsRequest } from './app/settings-destination';
import { Sidebar } from './app/Sidebar';
import { isSidebarConversation, sidebarSubmission, sidebarConversationDetails, type SidebarSession } from './app/sidebar-session';
import { BranchDialog, RenameDialog, RemoveSessionDialog } from './app/Dialogs';
import { CommandPalette, type PaletteTarget } from './app/CommandPalette';
import { ShortcutHelp } from './app/ShortcutHelp';
import { resolveShortcut, shortcutKeycaps, type PaletteActionId } from './app/shortcuts';
import type { PaletteScope } from './app/palette-model';
import { setEditorCaret } from './chat/composer/editor';
import { ConversationTopbar, HistoryMenu, ToastHost, WindowControls } from './app/Chrome';
import { RuntimeStore, appendToast, routeSessionPrompts, errorText, type NoticeSeverity, type Toast, type RuntimeRecord, type InboxItem } from './app/runtime-store';
import { Inbox, inboxLabel } from './app/Inbox';
import { messageText } from './chat/model';
import { describeTool } from './chat/tools/tool-model';
import { HistoryStore } from './app/history-store';
import { HistoryTreeDialog } from './app/HistoryTreeDialog';
import { forgetComposerDraft, getComposerDraft } from './chat/composer/drafts';
import { partitionSourceDiagnostics } from './chat/message-details';
import { workPanelWidthForSidebarReopen } from './lib/work-panel-resize';
import { parseFileTarget } from './lib/file-target';
import { FileObjectProvider } from './lib/file-object';
import { projectSavedHierarchy, retainSavedNavigation } from './workspace/subagent-model';
import { SourceReadScope } from './workspace/source-read-scope';
import { submissions } from './chat/submissions';
import { runtimeComposerReady, savedComposerMode } from './app/composer-mode';
import { migrateSidebarPreferences } from './app/sidebar-preferences';

export function App() {
 const { t } = useTranslation();
 const api=window.ompDesktop;
 const [boot,setBoot]=useState<Bootstrap|null>(null),[bootError,setBootError]=useState(''),[bootAttempt,setBootAttempt]=useState(0);
 const [history,setHistory]=useState<SessionSummary[]>([]),[historyErrors,setHistoryErrors]=useState<{path:string;message:string}[]>([]),[historyLoading,setHistoryLoading]=useState(false);
 const [activeId,setActiveId]=useState<string|null>(null),[workspace,setWorkspace]=useState(''),[settings,setSettings]=useState(false),[search,setSearch]=useState<{scope:PaletteScope;query?:string;path?:string}|null>(null);
 const hiddenProjects=boot?.preferences.hiddenProjects??[];
 const [shortcutHelp,setShortcutHelp]=useState(false),[settingsQuery,setSettingsQuery]=useState('');
 const [focusMessage,setFocusMessage]=useState<{id:string;sequence:number}>();
 const [findRequest,setFindRequest]=useState<{sequence:number;query?:string;scope:string}>();
 const transcriptNavigation=useRef<TranscriptHandle>(null);
 const revealLatest=()=>transcriptNavigation.current?.revealLatest();
 const revealAttention=()=>transcriptNavigation.current?.revealAttention();
 const pendingPaletteTarget=useRef<PaletteTarget|null>(null);
 const [settingsMounted,setSettingsMounted]=useState(false);
 const [settingsPresented,setSettingsPresented]=useState(false);
 const [settingsDestination,setSettingsDestination]=useState<SettingsRequest>({destination:'appearance',sequence:0});
 const openSettings=useCallback((destination:SettingsDestination='appearance',query='')=>{setSettingsQuery(query);setSettingsDestination(value=>({destination,sequence:value.sequence+1}));setSettings(true);},[]);
 const [returnToTurn,setReturnToTurn]=useState<{id:string;sequence:number}|null>(null);
 const chatShell=useRef<HTMLDivElement>(null),settingsShell=useRef<HTMLDivElement>(null);
 const settingsOpener=useRef<HTMLElement|null>(null);
 const chatVisible=!settings||!settingsPresented,settingsVisible=settings||settingsPresented;
 const [sidebarCollapsed,setSidebarCollapsed]=useState(false),[sidebarWidth,setSidebarWidth]=useState(275),[panelOpen,setPanelOpen]=useState(false),[panelRequest,setPanelRequest]=useState<PanelRequest|null>(null),[viewportWidth,setViewportWidth]=useState(window.innerWidth);
 const [activeSubagentId,setActiveSubagentId]=useState<string|null>(null);
 const [panelMounted,setPanelMounted]=useState(false);
 const [reducedMotion,setReducedMotion]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 const [panelWidthOverride,setPanelWidthOverride]=useState<number|null>(null);
 const autoCollapsedSidebar=useRef(false);
 const sidebarManuallyReopened=useRef(false);
 const [starting,setStarting]=useState(false),[startError,setStartError]=useState(''),[toasts,setToasts]=useState<Toast[]>([]);
 const [rename,setRename]=useState<SidebarSession|null>(null),[branch,setBranch]=useState<{runtimeId:string;messages:{entryId:string;text:string}[]}|null>(null);
 const [treeSession,setTreeSession]=useState<SidebarSession|null>(null);
 const [removal,setRemoval]=useState<SidebarSession|null>(null),[sourceGeneration,setSourceGeneration]=useState(0);
 const [viewer]=useState(()=>new HistoryStore(api));
 const viewed=useSyncExternalStore(viewer.subscribe,viewer.getSnapshot);
 useEffect(()=>viewer.connect(),[viewer]);
 useEffect(()=>api.onHistoryEvent(event=>{if(event.kind==='listing'){historySequence.current++;setHistory(event.listing.sessions);setHistoryErrors(event.listing.diagnostics);setHistoryLoading(false);}else if(event.kind==='error'&&!event.path)setHistoryErrors([{path:'',message:event.error}]);else if(event.kind==='activity')setHistory(items=>items.map(session=>session.path===event.path?{...session,activity:event.activity,activitySource:event.activitySource,updatedAt:event.updatedAt}:session));}),[api]);
 const savedChildKey=viewed?.snapshot?JSON.stringify([viewed.options.path,viewed.snapshot.selectedLeafId,viewed.snapshot.revision,viewed.snapshot.activity?.childrenRevision]):null;
 const savedChildSourceKey=viewed?JSON.stringify([viewed.options.path,viewed.options.leafId]):null;
 const [savedChildren,setSavedChildren]=useState<{key:string;sourceKey:string|null;subagents:NativeSubagent[];diagnostics:string[]}|null>(null);
 useEffect(()=>{
   if(!savedChildKey||!viewed?.snapshot)return;
   let current=true;
   void api.listHistorySubagents({path:viewed.options.path,...(viewed.options.leafId===undefined?{}:{leafId:viewed.snapshot.selectedLeafId})}).then(result=>{if(current)setSavedChildren({key:savedChildKey,sourceKey:savedChildSourceKey,...result});},cause=>{if(current)setSavedChildren({key:savedChildKey,sourceKey:savedChildSourceKey,subagents:[],diagnostics:[errorText(cause)]});});
   return()=>{current=false;};
 },[api,savedChildKey]);
 const historicalChildren=savedChildren?.sourceKey===savedChildSourceKey?savedChildren:null;
 const historyDiagnostics=useMemo(()=>partitionSourceDiagnostics([...(viewed?.snapshot?.diagnostics??[]),...(historicalChildren?.diagnostics??[])]),[viewed?.snapshot?.diagnostics,historicalChildren?.diagnostics]);
 const toastSequence=useRef(0),selection=useRef(0),historySequence=useRef(0),preferencesRef=useRef<DesktopPreferences|null>(null),preferencesQueue=useRef<Promise<unknown>>(Promise.resolve());
 const historyTimer=useRef<number|undefined>(undefined);
 const pendingSelection=useRef<{ticket:number;promise:Promise<RuntimeRecord>}|null>(null);
 const [homeComposerKey,setHomeComposerKey]=useState('home:0');
 const homeDraft=useRef({key:'home:0',cwd:''});
 const workspaceDrafts=useRef(new Map<string,{key:string;cwd:string}>());
 const composerSequence=useRef(0);
 const [draftFocus,setDraftFocus]=useState(0);
 const runtimeComposerKeys=useRef(new Map<string,string>());
 const toast=useCallback((message:string,severity:NoticeSeverity='info',runtimeId='',url?:string)=>setToasts(items=>appendToast(items,{message,severity,runtimeId,url,...(severity==='error'||severity==='warning'?{error:presentUserError(message)}:{})},++toastSequence.current)),[]);
 const onError=useCallback((error:unknown,operation?:string)=>{const presented=presentUserError(error);setToasts(items=>appendToast(items,{message:presented.message,severity:'error',runtimeId:'',error:presented,operation},++toastSequence.current));},[]);
 const refreshHistory=useCallback(async()=>{const ticket=++historySequence.current;setHistoryLoading(true);try{const result=await api.listHistory();if(ticket===historySequence.current){setHistory(result.sessions);setHistoryErrors(result.diagnostics);}}catch(error){if(ticket===historySequence.current)setHistoryErrors([{path:'',message:errorText(error)}]);}finally{if(ticket===historySequence.current)setHistoryLoading(false);}},[api]);
 const attentionContext=useRef({activeId,settings,viewed:!!viewed});attentionContext.current={activeId,settings,viewed:!!viewed};
 const nativeInboxEvent=useRef<(item:InboxItem)=>void>(()=>{});
 const [runtimes]=useState(()=>new RuntimeStore(api,notice=>setToasts(items=>appendToast(items,notice,++toastSequence.current)),()=>{window.clearTimeout(historyTimer.current);historyTimer.current=window.setTimeout(()=>{void refreshHistory();},150);},{isAway:id=>document.hidden||!document.hasFocus()||attentionContext.current.activeId!==id||attentionContext.current.settings||attentionContext.current.viewed,onEvent:item=>nativeInboxEvent.current(item)}));
 const inboxItems=useSyncExternalStore(runtimes.subscribe,runtimes.getInboxSnapshot);
 nativeInboxEvent.current=item=>{
   if(item.kind!=='prompt'&&item.kind!=='failed'&&!(item.kind==='completed'&&(item.durationMs??0)>20000))return;
   const record=runtimes.getSnapshot()[item.runtimeId];
   const title=displaySessionTitle(record?.chat.state.sessionName||i18next.t('omp.shell.newSession'),key=>i18next.t(key)).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160);
   void api.notify({title:'OMP-Desktop',body:`${title} · ${i18next.t(inboxLabel[item.kind])}`.slice(0,320),runtimeId:item.runtimeId}).catch(onError);
 };
 const records=useSyncExternalStore(runtimes.subscribe,runtimes.getSnapshot);
 const selectedRuntimeRef=useRef(activeId);selectedRuntimeRef.current=activeId;
 const warmDraft=!activeId&&!viewed?runtimes.getDraft(homeComposerKey):undefined;
 const active=activeId?records[activeId]:warmDraft;
 const draftShown=!!boot?.runtime.available&&!!workspace&&!activeId&&!viewed;
 useEffect(()=>{
   if(!draftShown)return;
   let current=true;
   setStarting(true);
   void runtimes.showDraft(homeComposerKey,workspace).then(()=>{if(current)setStartError('');}).catch(error=>{if(current)setStartError(errorText(error));}).finally(()=>{if(current)setStarting(false);});
   return()=>{current=false;void runtimes.releaseDraft(homeComposerKey).catch(error=>setStartError(errorText(error)));};
 },[draftShown,homeComposerKey,workspace,draftFocus,runtimes]);
 const setupWasOpen=useRef(settings);
 useEffect(()=>{const returning=setupWasOpen.current&&!settings;setupWasOpen.current=settings;if(returning&&draftShown&&!active&&!starting)setDraftFocus(value=>value+1);},[settings,draftShown,active,starting]);
 useEffect(()=>{const focus=()=>{if(draftShown&&(!runtimes.getDraft(homeComposerKey)||runtimes.getDraft(homeComposerKey)?.closed))setDraftFocus(value=>value+1);};window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);},[draftShown,homeComposerKey,runtimes]);
 useEffect(()=>{if(activeId&&active&&starting){setStarting(false);setWorkspace(active.cwd);}else if(activeId&&starting&&!runtimes.hasStarting){setStarting(false);setActiveId(null);}},[active,activeId,starting,runtimes,records]);
 const hierarchyKey=JSON.stringify([viewed?.options.path??active?.chat.historySource?.path??active?.chat.state.sessionFile,viewed?viewed.snapshot?.selectedLeafId:active?.chat.historySource?.leafId,viewed?viewed.snapshot?.revision:active?.history?.revision]);
 const hierarchyScope=useRef<SourceReadScope|null>(null);
 if(!hierarchyScope.current||hierarchyScope.current.key!==hierarchyKey){hierarchyScope.current?.invalidate();hierarchyScope.current=new SourceReadScope(hierarchyKey);}
 const hierarchyGeneration=hierarchyScope.current;
 const [savedNavigation,setSavedNavigation]=useState<{key:string;items:SavedSubagentNavigation[]}|null>(null);
 const onSavedNavigation=useCallback((navigation:SavedSubagentNavigation)=>setSavedNavigation(previous=>hierarchyGeneration.active?{key:hierarchyKey,items:retainSavedNavigation(previous?.key===hierarchyKey?previous.items:[],navigation)}:previous),[hierarchyKey,hierarchyGeneration]);
 const sourceChat=viewed?viewed.chat:active?.chat??null;
 // Reference badges describe only the selected session and never authorize file access.
 const referencedPaths=useMemo(()=>{
   const paths=new Set<string>();
   if(!workspace)return paths;
   const root=workspace.replace(/\\/g,'/').replace(/\/+$/,'');
   for(const tool of Object.values(sourceChat?.tools??{})){
     const target=describeTool(tool).file?.path;
     if(!target)continue;
     let path=target.replace(/\\/g,'/');
     if(path.startsWith(`${root}/`))path=path.slice(root.length+1);
     else if(path.startsWith('/')||/^[a-z][a-z\d+.-]*:/i.test(path))continue;
     const parts:string[]=[];
     let outside=false;
     for(const part of path.split('/')){
       if(!part||part==='.')continue;
       if(part==='..'){if(!parts.length){outside=true;break;}parts.pop();}
       else parts.push(part);
     }
     if(!outside&&parts.length)paths.add(parts.join('/'));
   }
   return paths;
 },[sourceChat?.tools,workspace]);
 const sourceAgents=viewed?historicalChildren?.subagents:active?.chat.subagents;
 const sharedAgents=useMemo(()=>{let agents=projectSavedHierarchy(sourceAgents??[],savedNavigation?.key===hierarchyKey?savedNavigation.items:[]);for(const row of sourceChat?.messages??[])if(row.raw.role==='toolResult'||row.raw.role==='custom')agents=settleAgentMessage(agents,row.raw);return agents;},[sourceAgents,sourceChat?.messages,savedNavigation,hierarchyKey]);
 const projectedChat=useMemo(()=>sourceChat?{...sourceChat,subagents:sharedAgents}:null,[sourceChat,sharedAgents]);
 const sourcePath=viewed?.options.path??(active?.source.status==='persisted'?active.source.path:undefined);
 const sourceRevision=viewed?viewed.snapshot?.revision:active?.history?.historySource?.path===sourcePath?active?.history?.revision:undefined;
 const parentSourceKey=sourcePath&&sourceRevision?JSON.stringify([sourcePath,sourceRevision]):null;
 const [parentSource,setParentSource]=useState<{key:string;result:SessionParentResolution}|null>(null);
 useEffect(()=>{
   setParentSource(null);
   if(!sourcePath||!parentSourceKey)return;
   let current=true;
   void api.resolveHistoryParent(sourcePath).then(result=>{if(current)setParentSource({key:parentSourceKey,result});},cause=>{if(current)onError(cause);});
   return()=>{current=false;};
 },[api,sourcePath,parentSourceKey,onError]);
 const composerKey=viewed ? `history:${viewed.options.path}` : activeId&&active ? runtimeComposerKeys.current.get(`${active.runtimeId}:${active.chat.state.sessionId}`) ?? `session:${active.runtimeId}:${active.chat.state.sessionId}` : homeComposerKey;
 const [runtimeAccess,setRuntimeAccess]=useState<{key:string;value:RuntimeAccess}|null>(null);
 const accessRefresh=useRef<(fresh?:boolean)=>Promise<void>>(async()=>{});
 const activeAccessKey=!viewed&&active&&!active.closed?`${active.runtimeId}:${active.chat.state.sessionId}:${active.chat.state.sessionFile??''}`:null;
 useEffect(()=>{
   if(!activeAccessKey||!active||settings){accessRefresh.current=async()=>{};return;}
   setRuntimeAccess(null);
   let live=true,pending:Promise<void>|null=null;
   const refresh=(fresh=false):Promise<void>=>{
     if(pending)return fresh?pending.then(()=>live?refresh():undefined):pending;
     pending=api.getRuntimeAccess(active.runtimeId).then(value=>{const current=runtimes.getSnapshot()[active.runtimeId];if(live&&current&&current.chat.state.sessionFile===active.chat.state.sessionFile&&value.source.sessionId===current.chat.state.sessionId){runtimes.updateSource(active.runtimeId,value.source);setRuntimeAccess({key:activeAccessKey,value});}},cause=>{if(live)setRuntimeAccess({key:activeAccessKey,value:{source:active.source,status:'unknown',reason:errorText(cause),checkedAt:Date.now(),canSend:false,canFork:false}});}).finally(()=>{pending=null;});
     return pending;
   };
   accessRefresh.current=refresh;
   const focus=()=>{setRuntimeAccess(null);void refresh(true);};
   void refresh();
   window.addEventListener('focus',focus);
   return()=>{live=false;window.removeEventListener('focus',focus);if(accessRefresh.current===refresh)accessRefresh.current=async()=>{};};
 },[activeAccessKey,settings,api]);
 const refreshAccess=useCallback(async()=>{const view=viewer.getSnapshot();if(view)await viewer.select(view.options);else await accessRefresh.current(true);},[viewer]);
 useEffect(()=>runtimes.connect(),[runtimes]);
 useEffect(()=>()=>window.clearTimeout(historyTimer.current),[]);
 useEffect(()=>{if(settings)setSettingsMounted(true);},[settings]);
 useLayoutEffect(()=>{
   if(settings===settingsPresented)return;
   // Reveal the destination first, transfer focus, then hide the old surface.
   // Both commits finish before paint, including the first Settings mount.
   if(settings){
     const focused=document.activeElement;
     settingsOpener.current=focused instanceof HTMLElement&&chatShell.current?.contains(focused)?focused:null;
     settingsShell.current?.querySelector<HTMLButtonElement>('.settings-back')?.focus({preventScroll:true});
   }else{
     const opener=settingsOpener.current;
     const target=opener?.isConnected&&!opener.closest('[hidden], [inert], [aria-hidden="true"]')&&!opener.matches(':disabled')&&opener.getClientRects().length?opener:chatShell.current?.querySelector<HTMLElement>('.composer-input[contenteditable="true"]');
     target?.focus({preventScroll:true});
     settingsOpener.current=null;
   }
   setSettingsPresented(settings);
 },[settings,settingsPresented]);
 useEffect(()=>{let cancelled=false;setBootError('');void api.bootstrap().then(result=>{if(cancelled)return;modelNames.capture(result.modelNames??[], 'cached');preferencesRef.current=result.preferences;homeDraft.current.cwd=result.preferences.lastWorkspace;workspaceDrafts.current.set(homeDraft.current.cwd,homeDraft.current);if(result.runtime.available&&result.preferences.lastWorkspace)void runtimes.showDraft(homeDraft.current.key,result.preferences.lastWorkspace).catch(()=>{});setBoot(result);setWorkspace(result.preferences.lastWorkspace);setSidebarWidth(result.preferences.sidebarWidth);document.documentElement.dataset.platform=result.platform;void refreshHistory();}).catch(error=>{if(!cancelled)setBootError(errorText(error));});return()=>{cancelled=true;};},[api,bootAttempt,refreshHistory,runtimes]);
 useEffect(()=>{if(!boot)return;const preferences=boot.preferences;document.documentElement.lang=preferences.language;document.documentElement.style.setProperty('--font-scale',String(preferences.fontSize/14));document.documentElement.style.fontSize='var(--text-ui)';if(preferences.fontFamily)document.documentElement.style.setProperty('--font-sans',preferences.fontFamily);else document.documentElement.style.removeProperty('--font-sans');void i18next.changeLanguage(preferences.language).catch(onError);},[boot?.preferences,onError]);
 useEffect(()=>{const resize=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 useEffect(()=>{const apply=(state:{fullscreen:boolean})=>{document.documentElement.dataset.fullscreen=String(state.fullscreen);};const off=api.onWindowChrome(apply);void api.getWindowChrome().then(apply).catch(onError);return off;},[api,onError]);
 const panelWidth=Math.min(viewportWidth*.4,panelWidthOverride??boot?.preferences.panelWidth??420);
 useEffect(()=>{
   const media=window.matchMedia('(prefers-reduced-motion: reduce)');
   const update=()=>setReducedMotion(media.matches);
   media.addEventListener('change',update);
   return()=>media.removeEventListener('change',update);
 },[]);
 const sidebarPositions=useRef<{key:string;panel:boolean;collapsed:boolean;autoCollapsed:boolean;width:number;positions:Map<HTMLElement,number>;animations:Animation[]}|null>(null);
 useLayoutEffect(()=>{
   if(settings||!chatVisible){sidebarPositions.current?.animations.forEach(animation=>animation.cancel());sidebarPositions.current=null;return;}
   const pane=chatShell.current?.querySelector<HTMLElement>('.main-pane');
   if(!pane)return;
   const previous=sidebarPositions.current;
   const positions=new Map<HTMLElement,number>();
   const width=pane.offsetWidth;
   const navigated=previous?.key!==composerKey;
   const resized=previous?.width!==width;
   const panelChanged=previous?.panel!==panelOpen;
   if(navigated||resized||panelChanged)previous?.animations.forEach(animation=>animation.cancel());
   const animations:Animation[]=navigated||resized||panelChanged?[]:previous?.animations??[];
   const changed=previous&&!navigated&&!panelChanged&&!panelOpen&&!previous.autoCollapsed&&!autoCollapsedSidebar.current&&previous.collapsed!==sidebarCollapsed;
   const surfaces=pane.querySelectorAll<HTMLElement>('.conversation-topbar,.home-panel,.composer-stack,.thread-content');
   for(const node of surfaces){
     if(!node.getClientRects().length)continue;
     const surface=node.matches('.home-panel,.composer-stack')?node.parentElement!:node;
     const transform=getComputedStyle(surface).transform;
     const offset=transform==='none'?0:new DOMMatrixReadOnly(transform).m41;
     const target=node.getBoundingClientRect().left-offset;
     positions.set(node,target);
     const before=previous?.positions.get(node);
     if(reducedMotion)surface.getAnimations().forEach(animation=>animation.cancel());
     else if(changed&&before!==undefined&&!isMotionPaused()&&!document.documentElement.hasAttribute('data-sidebar-resizing')){
       const delta=before+offset-target;
       if(Math.abs(delta)>.1)animations.push(animateTo(surface,[{transform:`translateX(${delta}px)`},{transform:'none'}],{duration:motion.gentle,easing:motion.enter}));
     }
   }
   sidebarPositions.current={key:composerKey,panel:panelOpen,collapsed:sidebarCollapsed,autoCollapsed:autoCollapsedSidebar.current,width,positions,animations};
 },[settings,chatVisible,composerKey,panelOpen,sidebarCollapsed,sidebarWidth,panelWidth,viewportWidth,reducedMotion,Boolean(active?.chat.messages.length)]);
 useEffect(()=>{if(panelOpen)setPanelMounted(true);else if(reducedMotion||settings)setPanelMounted(false);},[panelOpen,reducedMotion,settings]);
 useEffect(()=>{
   if(!panelOpen){
     if(autoCollapsedSidebar.current){autoCollapsedSidebar.current=false;setSidebarCollapsed(false);}
     sidebarManuallyReopened.current=false;
     return;
   }
   if(boot&&!sidebarCollapsed&&!sidebarManuallyReopened.current&&viewportWidth<sidebarWidth+panelWidth+560+16){autoCollapsedSidebar.current=true;setSidebarCollapsed(true);}
   else if(boot&&sidebarCollapsed&&autoCollapsedSidebar.current&&viewportWidth>=sidebarWidth+panelWidth+560+16){autoCollapsedSidebar.current=false;setSidebarCollapsed(false);}
 },[panelOpen,boot,viewportWidth,sidebarWidth,panelWidth,sidebarCollapsed]);
 const savePreferences=useCallback((patch:Partial<DesktopPreferences>):Promise<void>=>{
   const operation=preferencesQueue.current.then(async()=>{
     const changesRuntime=patch.profile!==undefined&&patch.profile!==preferencesRef.current?.profile||patch.executablePath!==undefined&&patch.executablePath!==preferencesRef.current?.executablePath;
     if(changesRuntime&&(runtimes.hasStarting||Object.values(runtimes.getSnapshot()).some(record=>!record.closed))) throw new UserFacingError(i18next.t('omp.shell.disconnectBeforeRuntimeChange'));
     const preferences=await api.setPreferences(patch);
     preferencesRef.current=preferences;
     setBoot(value=>value?{...value,preferences}:value);
     if(patch.sidebarWidth!==undefined)setSidebarWidth(preferences.sidebarWidth);
     if(changesRuntime){
       viewer.clear();runtimes.forgetClosed();setActiveId(null);setHistory([]);
       setHomeComposerKey(homeDraft.current.key);
       const runtime=await api.checkRuntime();
       setBoot(value=>value?{...value,runtime}:value);
       await refreshHistory();
     }
   });
   // Keep serialization usable; the returned operation still rejects to its caller.
   preferencesQueue.current=operation.catch(()=>undefined);
   return operation;
 },[api,runtimes,viewer,refreshHistory]);
 useEffect(()=>{
   if(!boot||boot.preferences.sidebarStateMigrated)return;
   let cancelled=false,idle:number|undefined,second:number|undefined;
   const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{idle=requestIdleCallback(()=>{
     void preferencesQueue.current.then(async()=>{
       if(cancelled||!preferencesRef.current)return;
       await migrateSidebarPreferences(()=>preferencesRef.current!,savePreferences,()=>window.localStorage);
     }).catch(onError);
   });});});
   return()=>{cancelled=true;cancelAnimationFrame(first);if(second!==undefined)cancelAnimationFrame(second);if(idle!==undefined)cancelIdleCallback(idle);};
 },[boot?.preferences.sidebarStateMigrated,savePreferences,onError]);
 const toggleSidebar=useCallback(()=>{
   autoCollapsedSidebar.current=false;
   sidebarManuallyReopened.current=sidebarCollapsed;
   if(sidebarCollapsed&&panelOpen){
     const next=workPanelWidthForSidebarReopen({containerWidth:viewportWidth-16,sidebarWidth,currentPanelWidth:panelWidth});
     setPanelWidthOverride(next);
     void savePreferences({panelWidth:next}).catch(onError);
   }
   setSidebarCollapsed(value=>!value);
 },[sidebarCollapsed,panelOpen,viewportWidth,sidebarWidth,panelWidth,savePreferences,onError]);
 const rememberWorkspace=useCallback(async(cwd:string)=>{const current=preferencesRef.current;if(!current)return;await savePreferences({lastWorkspace:cwd,recentWorkspaces:[cwd,...current.recentWorkspaces.filter(item=>item!==cwd)].slice(0,30)});},[savePreferences]);
 const openSession=useCallback(async(cwd:string,sessionPath:string,adoptComposerKey:string,mode:'resume'):Promise<RuntimeRecord>=>{
   const ticket=++selection.current;
   const draftKey=adoptComposerKey;
   setStarting(true);setStartError('');setSettings(false);if(!viewer.getSnapshot())setWorkspace(cwd);setActiveId(null);
   const promise=runtimes.start({cwd,sessionPath,mode});
   pendingSelection.current={ticket,promise};
   try{
     const record=await promise;
     const nativeKey=`${record.runtimeId}:${record.chat.state.sessionId}`;
     if(!runtimeComposerKeys.current.has(nativeKey))runtimeComposerKeys.current.set(nativeKey,draftKey);
     if(ticket===selection.current){viewer.clear();setActiveId(record.runtimeId);setWorkspace(record.cwd);setPanelRequest(null);void rememberWorkspace(record.cwd).catch(onError);}
     return record;
   }catch(error){if(ticket===selection.current)setStartError(errorText(error));throw error;}
   finally{if(ticket===selection.current)setStarting(false);if(pendingSelection.current?.ticket===ticket)pendingSelection.current=null;}
 },[runtimes,viewer,rememberWorkspace,onError]);
 const viewSession=useCallback(async(path:string,cwd:string,leafId?:string|null,anchorId?:string)=>{const record=Object.values(runtimes.getSnapshot()).find(record=>record.source.path===path||`runtime:${record.runtimeId}`===path);if(record&&record.source.status!=='persisted')throw (record.source.reason ? new Error(record.source.reason) : new UserFacingError(i18next.t('omp.removal.notSaved')));const ticket=++selection.current;pendingSelection.current=null;setActiveId(null);setWorkspace(cwd);setSettings(false);setStarting(false);setStartError('');setPanelRequest(null);await viewer.select({path,...(leafId!==undefined?{leafId}:{}),...(anchorId?{anchorId}:{})});const snapshot=viewer.getSnapshot()?.snapshot;if(ticket===selection.current&&snapshot)setWorkspace(snapshot.session.cwd);},[viewer,runtimes]);
 const browseWorkspace=useCallback((cwd:string)=>{
   const hidden=preferencesRef.current?.hiddenProjects??[];
   if(hidden.includes(cwd))void savePreferences({hiddenProjects:hidden.filter(path=>path!==cwd)}).catch(onError);
   const draft=getComposerDraft(composerKey).draft;
   const adopt=!active&&!viewed&&!workspace&&!draft.attachments.length&&!draft.references.length&&!workspaceDrafts.current.has(cwd);
   const next=workspaceDrafts.current.get(cwd)??{key:adopt?composerKey:`home:${++composerSequence.current}`,cwd};
   if(adopt)workspaceDrafts.current.delete('');
   workspaceDrafts.current.set(cwd,next);homeDraft.current=next;selection.current++;pendingSelection.current=null;viewer.clear();
   setHomeComposerKey(next.key);setWorkspace(cwd);setActiveId(null);setSettings(false);setStarting(false);setStartError('');setPanelRequest(null);
   void rememberWorkspace(cwd).catch(onError);
 },[viewer,rememberWorkspace,onError,active,viewed,workspace,composerKey,savePreferences]);
 const removeWorkspace=async(cwd:string)=>{await savePreferences({hiddenProjects:[...new Set([...(preferencesRef.current?.hiddenProjects??[]),cwd])].slice(-200),recentWorkspaces:(preferencesRef.current?.recentWorkspaces??[]).filter(path=>path!==cwd),...(preferencesRef.current?.lastWorkspace===cwd?{lastWorkspace:''}:{})});};
 const chooseWorkspace=useCallback(async()=>{const cwd=await api.chooseWorkspace();if(cwd)browseWorkspace(cwd);},[api,browseWorkspace]);
 const newSession=useCallback(async(cwd?:string)=>{const selected=cwd||workspace||preferencesRef.current?.lastWorkspace||await api.chooseWorkspace();if(selected){workspaceDrafts.current.delete(selected);browseWorkspace(selected);}},[api,workspace,browseWorkspace]);
 const home=useCallback(()=>{const unbound=workspaceDrafts.current.get('');const draft=unbound?getComposerDraft(unbound.key).draft:null;const next=unbound&&draft&&(draft.text||draft.attachments.length||draft.references.length)?unbound:homeDraft.current;selection.current++;viewer.clear();pendingSelection.current=null;homeDraft.current=next;setHomeComposerKey(next.key);setActiveId(null);setWorkspace(next.cwd);setSettings(false);setStarting(false);setStartError('');setPanelRequest(null);},[viewer]);
 const selectSession=useCallback(async(session:SidebarSession)=>{const preferred=session.runtimeId?records[session.runtimeId]:undefined;const current=preferred&&(!preferred.closed||preferred.source.status!=='persisted')?preferred:Object.values(records).find(record=>record.source.path===session.path&&!record.closed);if(current){selection.current++;viewer.clear();pendingSelection.current=null;setActiveId(current.runtimeId);setWorkspace(current.cwd);setSettings(false);setStarting(false);setStartError('');setPanelRequest(null);void rememberWorkspace(current.cwd).catch(onError);return;}await viewSession(session.path,session.cwd);},[records,viewer,viewSession,rememberWorkspace,onError]);
 const openNativeFile=useCallback(async()=>{const path=await api.chooseSessionFile();if(path)await viewSession(path,history.find(session=>session.path===path)?.cwd||'');},[api,history,viewSession]);
 const beginBranch=useCallback(async(session:SidebarSession)=>{const record=session.runtimeId?records[session.runtimeId]:undefined;if(!record||record.closed)throw new UserFacingError(i18next.t('omp.history.ownedBranchOnly'));runtimes.requireOpen(record.runtimeId);const result=await api.request<{messages:{entryId:string;text:string}[]}>(record.runtimeId,{type:'get_branch_messages'});setBranch({runtimeId:record.runtimeId,messages:result.messages});},[api,records,runtimes]);
 const resumeHistory=useCallback(async()=>{const view=await viewer.waitForAccess();if(!view.snapshot||!savedComposerMode(view).ready)throw new UserFacingError(i18next.t('omp.history.sendBlocked'),view.access?.reason??'');return openSession(view.snapshot.session.cwd,view.options.path,`history:${view.options.path}`,'resume');},[viewer,openSession]);
 const forkSession=useCallback(async(session:{path:string;cwd:string},sourceKey?:string)=>{
   const ticket=selection.current;
   const record=await runtimes.start({cwd:session.cwd,sessionPath:session.path,mode:'fork'});
   runtimes.requireOpen(record.runtimeId);
   const forkKey=`fork:${++composerSequence.current}:${session.path}`;
   runtimeComposerKeys.current.set(`${record.runtimeId}:${record.chat.state.sessionId}`,forkKey);
   if(ticket!==selection.current)return;
   if(sourceKey)getComposerDraft(sourceKey).moveTo(getComposerDraft(forkKey),record.chat.editorText?.id);
   selection.current++;viewer.clear();setActiveId(record.runtimeId);setWorkspace(record.cwd);setSettings(false);setStartError('');setPanelRequest(null);
   void rememberWorkspace(record.cwd).catch(onError);
 },[runtimes,viewer,rememberWorkspace,onError]);
 const forkDraft=useCallback(async()=>{
   const view=viewer.getSnapshot();
   const path=view?.options.path??(active?.source.status==='persisted'?active.source.path:undefined);
   if(!path)throw new UserFacingError(i18next.t('omp.history.noForkSource'));
   if(view&&!savedComposerMode(view).canFork)throw new UserFacingError(i18next.t('omp.history.forkUnavailable'));
   if(!view&&(!active||!(await api.getRuntimeAccess(active.runtimeId)).canFork))throw new UserFacingError(i18next.t('omp.history.forkUnavailable'));
   try{await forkSession({path,cwd:view?.snapshot?.session.cwd||active?.cwd||workspace},composerKey);}
   catch(error){await refreshAccess();throw error;}
 },[active,api,workspace,composerKey,viewer,forkSession,refreshAccess]);
 const send=useCallback(async(input:PromptInput)=>{
   try{
     let record=active;
     if(record?.closed)throw new UserFacingError(i18next.t('omp.shell.reopenToSend'));
     if(!record){
       const pending=pendingSelection.current;
       if(pending?.ticket===selection.current)record=await pending.promise;
       else if(viewer.getSnapshot())record=await resumeHistory();
       else {const cwd=workspace||await api.chooseWorkspace();if(!cwd)throw new UserFacingError(i18next.t('omp.shell.selectWorkspaceToSend'));record=await runtimes.showDraft(composerKey,cwd);}
     }
     runtimes.requireOpen(record.runtimeId);
     if(!activeId&&!viewer.getSnapshot()){
       runtimes.adoptDraft(composerKey);
       runtimeComposerKeys.current.set(`${record.runtimeId}:${record.chat.state.sessionId}`,composerKey);
       const next={key:`home:${++composerSequence.current}`,cwd:record.cwd};
       homeDraft.current=next;workspaceDrafts.current.set(record.cwd,next);setHomeComposerKey(next.key);
       setActiveId(record.runtimeId);setWorkspace(record.cwd);
     }
     await runtimes.sendPrompt(record.runtimeId,input,getComposerDraft(composerKey).draft);
   }catch(error){await refreshAccess();throw error;}
 },[active,activeId,api,workspace,runtimes,viewer,resumeHistory,onError,composerKey,refreshAccess]);
 const submissionReceipts=useSyncExternalStore(submissions.subscribe,submissions.getSnapshot);
 const desktopQueue=useSyncExternalStore(runtimes.desktopQueue.subscribe,runtimes.desktopQueue.getSnapshot);
 const sessions=useMemo(()=>{
   const rows=new Map<string,SidebarSession>(history.map(session=>[session.path,session]));
   for(const record of Object.values(records)){
     const state=record.chat.state;
     const accepted=sidebarSubmission(submissionReceipts,record.runtimeId,state.sessionId);
     if(runtimes.isDraft(record.runtimeId)||!isSidebarConversation(record.source,record.chat.messages,accepted))continue;
     const path=record.source.path||`runtime:${record.runtimeId}`;
     const old=rows.get(path);
     if(record.closed&&old?.runtimeId&&!old.closed)continue;
     const details=sidebarConversationDetails(record.chat.messages,accepted,old);
     const lastAssistant=record.chat.messages.findLast(row=>row.raw.role==='assistant');
     rows.set(path,{...old,id:state.sessionId,path,cwd:record.cwd,source:record.source,title:state.sessionName||old?.title||details.title||t('omp.shell.newSession'),preview:old?.preview||details.title,updatedAt:details.updatedAt,sourceKind:old?.sourceKind??'journal',writable:!record.closed,canFork:record.source.status==='persisted',runtimeId:record.runtimeId,running:record.chat.isRunning,failed:inboxItems.some(item=>item.runtimeId===record.runtimeId&&!item.read&&(item.kind==='failed'||item.kind==='child')),closed:record.closed,lastAssistantExcerpt:lastAssistant?sessionProseExcerpt(messageText(lastAssistant.raw))||undefined:undefined,modelId:state.model?.id,modelProvider:state.model?.provider});
   }
   return [...rows.values()].map(session=>({...session,title:displaySessionTitle(session.title,t)})).sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0));
 },[history,records,inboxItems,submissionReceipts,t]);
 const prompts=[...runtimes.startupPrompts,...Object.values(records).flatMap(record=>record.closed?[]:record.chat.prompts.map(request=>({runtimeId:record.runtimeId,request})))];
 const [dismissedPrompts,setDismissedPrompts]=useState<ReadonlySet<string>>(()=>new Set());
 const {prompt}=routeSessionPrompts(prompts,!settings&&!viewed?activeId:null,dismissedPrompts);
 const promptCounts=new Map<string,number>();for(const item of prompts)promptCounts.set(item.runtimeId,(promptCounts.get(item.runtimeId)??0)+1);
 const openRuntime=useCallback(async(runtimeId:string)=>{setDismissedPrompts(items=>new Set([...items].filter(key=>!key.startsWith(`${runtimeId}:`))));const session=sessions.find(session=>session.runtimeId===runtimeId);if(session){await selectSession(session).catch(onError);return;}if(runtimes.startupPrompts.some(item=>item.runtimeId===runtimeId)){selection.current++;viewer.clear();pendingSelection.current=null;setActiveId(runtimeId);setStarting(true);setStartError('');setSettings(false);setPanelRequest(null);}},[sessions,selectSession,onError,runtimes,viewer]);
 const toastSources=Object.fromEntries(sessions.filter(session=>session.runtimeId).map(session=>[session.runtimeId!,{title:session.title,project:session.cwd}]));
 const pendingPromptKeys=JSON.stringify(prompts.map(item=>`${item.runtimeId}:${item.request.id}`).sort());
 const previousPromptKeys=useRef<Set<string>>(new Set());
 useEffect(()=>{const next=new Set<string>(JSON.parse(pendingPromptKeys));const added=[...next].some(key=>!previousPromptKeys.current.has(key));previousPromptKeys.current=next;void api.setAttention({badge:promptCounts.size?String(promptCounts.size):'',...(added?{bounce:'informational' as const}:{})}).catch(onError);},[api,pendingPromptKeys,onError]);
 const openRuntimeRef=useRef(openRuntime);openRuntimeRef.current=openRuntime;
 useEffect(()=>api.onNotificationClick(runtimeId=>{openRuntimeRef.current(runtimeId);runtimes.markInboxRead(undefined,runtimeId);}),[api,runtimes]);
 const conversationTitle=displaySessionTitle(viewed ? viewed.snapshot?.session.title||history.find(session=>session.path===viewed.options.path)?.title||t('omp.shell.readingHistory') : active?.chat.state.sessionName||sessions.find(session=>session.runtimeId===activeId)?.title||t('omp.shell.newSession'),t);
 const windowTitle=`${conversationTitle} — ${workspace.split(/[/\\]/).filter(Boolean).pop()||'OMP-Desktop'}${!viewed&&active?.chat.isRunning&&!active.closed?` · ${t('shell.running')}`:''}`.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,512);
 useEffect(()=>{void api.setWindowTitle(windowTitle).catch(onError);},[api,windowTitle,onError]);
 const sessionCommand=useCallback(async(command:Parameters<typeof runtimes.command>[1])=>{if(!active||viewer.getSnapshot())throw new UserFacingError(i18next.t('omp.history.sendBlocked'));try{return await runtimes.command(active.runtimeId,command);}catch(error){await refreshAccess();throw error;}},[active,runtimes,viewer,refreshAccess]);
 const openPicker=useCallback(async()=>{
   const pending=pendingSelection.current;
   if(pending?.ticket===selection.current){await pending.promise;return;}
   if(viewer.getSnapshot())await resumeHistory();
 },[viewer,resumeHistory]);
 const openInboxItem=(item:InboxItem)=>{void (async()=>{await openRuntime(item.runtimeId);const ticket=selection.current;const record=runtimes.getSnapshot()[item.runtimeId];if(item.turnId&&record&&!record.closed&&!record.historyFollowing)await runtimes.latest(item.runtimeId);if(ticket!==selection.current)return;const turnId=runtimes.getInboxSnapshot().find(current=>current.id===item.id)?.turnId??item.turnId;if(turnId)setReturnToTurn(value=>({id:turnId,sequence:(value?.sequence??0)+1}));})().catch(onError);};
 const dismissToast=useCallback((id:number)=>setToasts(items=>items.filter(item=>item.id!==id)),[]);
 const surfacedError=!settings?(startError||(!boot?.runtime.available?boot?.runtime.error:'')||''):'';
 useEffect(()=>{
   if(surfacedError&&toasts.some(item=>item.severity==='error'&&item.message===surfacedError))setToasts(items=>items.filter(item=>item.severity!=='error'||item.message!==surfacedError));
 },[surfacedError,toasts]);
 const openPanel=(request:PanelRequest)=>{setPanelRequest(request);setPanelOpen(true);};
 const runNavigation=async(id:PaletteActionId)=>{
   switch(id){
     case 'new-session': await newSession(); break;
     case 'open-workspace': await chooseWorkspace(); break;
     case 'palette': setSearch({scope:'all'}); break;
     case 'quick-open': setSearch({scope:'files'}); break;
     case 'search-messages': setSearch({scope:'messages'}); break;
     case 'find': if(active||viewed){flushSync(()=>{setSettings(false);setFindRequest(value=>({sequence:(value?.sequence??0)+1,scope:composerKey}));});} break;
     case 'toggle-sidebar': toggleSidebar(); break;
     case 'toggle-panel': setPanelOpen(value=>!value); break;
     case 'settings': openSettings(); break;
     case 'shortcuts': setShortcutHelp(true); break;
     case 'open-files': case 'open-changes': case 'open-tasks': case 'open-session': setSettings(false); openPanel({kind:id.slice(5) as 'files'|'changes'|'tasks'|'session'}); break;
     case 'jump-latest': setSettings(false); revealLatest(); break;
     case 'stop': if(active&&!viewed&&!active.closed&&active.chat.isRunning)await sessionCommand({type:'abort'}); break;
     case 'close-tab': if(document.querySelector('[aria-modal="true"]'))document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));else if(settings)setSettings(false);else if(panelOpen)setPanelOpen(false);else home(); break;
     case 'next-tab': case 'prev-tab': {const index=sessions.findIndex(session=>viewed?session.path===viewed.options.path:session.runtimeId===activeId);const next=sessions[(index+(id==='next-tab'?1:-1)+sessions.length)%sessions.length];if(next)await selectSession(next);break;}
   }
 };
 const navigationRef=useRef(runNavigation);navigationRef.current=runNavigation;
 useEffect(()=>{
   const key=(event:KeyboardEvent)=>{
     const editable=event.target instanceof HTMLElement&&!!event.target.closest('input,textarea,select,[contenteditable=true]');
     const id=resolveShortcut(event,boot?.platform??document.documentElement.dataset.platform??'darwin',editable);
     if(!id||document.querySelector('[aria-modal="true"]')&&id!=='close-tab')return;
     event.preventDefault();void navigationRef.current(id).catch(onError);
   };
   window.addEventListener('keydown',key);
   const unsubscribe=api.onMenuCommand(command=>{if(document.querySelector('[aria-modal="true"]')&&command!=='close-tab')return;void navigationRef.current(command as PaletteActionId).catch(onError);});
   return()=>{window.removeEventListener('keydown',key);unsubscribe();};
 },[api,boot?.platform,onError]);
 const selectPaletteTarget=async(target:PaletteTarget)=>{
   if(target.kind==='action'){await runNavigation(target.id);return;}
   if(target.kind==='settings'){openSettings('appearance',target.query);return;}
   if(target.kind==='file'){setSettings(false);openPanel({kind:'file',...parseFileTarget(target.path)});return;}
   if(target.kind==='session'){await selectSession(target.session);return;}
   if(target.kind==='command'){const draft=getComposerDraft(composerKey);const prefix=draft.draft.text.match(/^\/[^\s]*\s?/);const command=`/${target.name} `;draft.setDraft({...draft.draft,text:command+draft.draft.text.slice(prefix?.[0].length??0)});setSettings(false);requestAnimationFrame(()=>{const editor=chatShell.current?.querySelector<HTMLElement>('.composer-input[contenteditable="true"]');if(editor){editor.focus();setEditorCaret(editor,command.length);}});return;}
   const hit=target.hit;
   const live=Object.values(records).find(record=>!record.closed&&record.source.path===hit.path&&record.chat.messages.some(message=>message.id===hit.entryId));
   const expectedSelection=selection.current+1;
   if(live){const session=sessions.find(session=>session.runtimeId===live.runtimeId);if(session)await selectSession(session);}else await viewSession(hit.path,hit.cwd,hit.entryId,hit.entryId);
   if(selection.current===expectedSelection)setFocusMessage(value=>({id:hit.entryId,sequence:(value?.sequence??0)+1}));
 };
 const paletteSelectionRef=useRef(selectPaletteTarget);paletteSelectionRef.current=selectPaletteTarget;
 useEffect(()=>{
   if(search||!pendingPaletteTarget.current)return;
   const land=()=>{if(document.querySelector('.palette-overlay'))return;const target=pendingPaletteTarget.current;pendingPaletteTarget.current=null;if(target)void paletteSelectionRef.current(target).catch(onError);};
   const observer=new MutationObserver(land);observer.observe(document.body,{childList:true,subtree:true});land();return()=>observer.disconnect();
 },[search,onError]);
 const removeConversation=async(session:SidebarSession,allowUncertain=false):Promise<SessionRemovalResult>=>{
   const target:SessionRemovalTarget=session.runtimeId?{kind:'runtime',runtimeId:session.runtimeId,sessionId:session.id}:{kind:'saved',path:session.path,sessionId:session.id};
   target.allowUncertain=allowUncertain;
   const operation=preferencesQueue.current.then(()=>runtimes.remove(target));
   preferencesQueue.current=operation.catch(()=>undefined);
   const result=await operation;
   if(result.preferences){preferencesRef.current=result.preferences;setBoot(value=>value?{...value,preferences:result.preferences!}:value);}
   if(result.sourceRemoved){
     ++historySequence.current;window.clearTimeout(historyTimer.current);setSourceGeneration(value=>value+1);
     const removed=Object.values(runtimes.getSnapshot()).filter(record=>result.affectedRuntimeIds.includes(record.runtimeId)||(!!result.sourcePath&&record.source.path===result.sourcePath&&record.chat.state.sessionId===result.sessionId));const ids=new Set([...result.affectedRuntimeIds,...removed.map(record=>record.runtimeId)]);
     for(const record of removed){const identity=`${record.runtimeId}:${record.chat.state.sessionId}`;const key=runtimeComposerKeys.current.get(identity);if(key)forgetComposerDraft(key);forgetComposerDraft(`session:${identity}`);runtimeComposerKeys.current.delete(identity);}
     if(result.sourcePath)forgetComposerDraft(`history:${result.sourcePath}`);
     const currentView=viewer.getSnapshot();const selectedRemoved=!!selectedRuntimeRef.current&&ids.has(selectedRuntimeRef.current)||!!currentView&&(currentView.options.path===result.sourcePath||currentView.snapshot?.session.path===result.sourcePath);
     runtimes.forget([...ids]);
     forgetWorkPanelSources([...ids],result.sourcePath);
     if(selectedRemoved){selection.current++;pendingSelection.current=null;setPanelRequest(null);setPanelOpen(false);setPanelMounted(false);setActiveSubagentId(null);setReturnToTurn(null);setSavedNavigation(null);setSavedChildren(null);if(currentView)viewer.clear();}
     setActiveId(value=>value&&ids.has(value)?null:value);
     setRename(value=>value&&(ids.has(value.runtimeId??'')||value.path===result.sourcePath)?null:value);
     setTreeSession(value=>value&&(ids.has(value.runtimeId??'')||value.path===result.sourcePath)?null:value);
     setBranch(value=>value&&ids.has(value.runtimeId)?null:value);
     setPanelRequest(value=>value?.context&&(value.context.kind==='runtime'?ids.has(value.context.runtimeId):value.context.parentPath===result.sourcePath)?null:value);
     setHistory(items=>items.filter(item=>item.path!==result.sourcePath));
     if(selectedRemoved)home();
   }
   await refreshHistory();
   if(result.sourceRemoved&&!result.errors.length&&!result.warnings.length&&!result.retained.length){setRemoval(null);toast(i18next.t(result.disposition==='discarded'?'omp.removal.discarded':'omp.removal.trashed'),'success');}
   return result;
 };
 if(!boot)return <div className="app-shell app-shell-boot"><div className="omp-startup-card no-drag"><h1>OMP-Desktop</h1>{bootError?<StartupRecovery kind="bootstrap" details={bootError} onPrimary={()=>setBootAttempt(value=>value+1)} onCopy={text=>api.copyText(text)}/>:<p role="status">{t('omp.shell.discovering')}</p>}</div><WindowControls platform={document.documentElement.dataset.platform||'darwin'} onError={onError}/></div>;
 const preferences=boot.preferences;
 const observed=runtimeAccess?.key===activeAccessKey?runtimeAccess.value:undefined;
 const historyMode=viewed?savedComposerMode(viewed):undefined;
 const historyReady=!!historyMode?.ready;
 const runtimeReady=!!active&&!active.closed&&!!observed?.canSend;
 const draftConnecting=draftShown&&!startError&&!active;
 const accessReady=viewed?!starting&&!startError&&(historyReady||!!viewed.snapshot&&!viewed.error&&!historyMode?.readonly&&!!viewed.access?.pending):runtimeComposerReady(active,observed,draftConnecting,startError)||!active&&!workspace&&!starting&&!startError;
 const accessReason=starting?t('omp.history.connecting'):viewed?historyMode?.category==='checking'?t('omp.history.checking'):viewed.error?presentUserError(viewed.error).message:historyMode?.category==='historical'?t('omp.history.branchReadonly'):historyMode?.category==='readonly'?t('omp.history.sourceReadonly'):historyReady?t('omp.history.readyOriginal'):`${t(`omp.history.${viewed.access?.status??'unknown'}`)} ${viewed.access?.reason??''}`:active?.closed?t('omp.shell.reopenToSend'):active?active.source.status==='unavailable'?active.source.reason||t('omp.removal.sourceUnavailable'):runtimeReady?t(active.source.status==='unpersisted'?'omp.removal.notSaved':'omp.history.readyOriginal'):!observed?t('omp.history.checking'):`${t(`omp.history.${observed.status}`)} ${observed.reason??observed.source.reason??''}`:t('omp.history.readyNew');
 const accessCategory=draftConnecting||starting?'connecting':startError?'disconnected':historyMode?historyMode.category:active?.closed?'disconnected':active?active.source.status==='unavailable'?'source-unavailable':!observed?'checking':observed.status==='external'?'external':!runtimeReady?'unknown':active.source.status==='unpersisted'?'unpersisted':'ready':'ready';
  const selectedSession:SidebarSession|undefined=sessions.find(session=>viewed?session.path===viewed.options.path:session.runtimeId===activeId)??viewed?.snapshot?.session;
 const connectedSession=sourcePath?sessions.find(session=>session.path===sourcePath&&session.runtimeId&&!session.closed):undefined;
 const provenance=parentSource?.key===parentSourceKey?parentSource?.result:null;
 return (
   <DisplayPreferencesContext.Provider value={{messageMeta:preferences.messageMeta,durationStyle:preferences.durationStyle}}>
   <FileObjectProvider cwd={workspace} onOpenFile={target=>openPanel({kind:'file',...parseFileTarget(target)})}>
   <div
     className={`app-shell${settings ? ' settings-mode' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
     style={{ '--ds-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
   >
     <PortalVisibilityProvider visible={chatVisible}>
       <div ref={chatShell} className="app-chat-shell" hidden={!chatVisible} inert={!chatVisible || undefined} aria-hidden={!chatVisible || undefined}>
           <Sidebar
             exiting={sidebarCollapsed}
             sessions={sessions.map(session=>({...session,activity:session.path===viewed?.options.path?viewed.snapshot?.activity?.state:session.activity,unreadCompletion:inboxItems.some(item=>item.runtimeId===session.runtimeId&&item.kind==='completed'&&!item.read),pendingCount:session.runtimeId?promptCounts.get(session.runtimeId)??0:0}))}
             workspaces={preferences.recentWorkspaces}
             workspace={workspace}
             active={viewed?.options.path??activeId}
             pinned={preferences.pinnedSessions}
             width={sidebarWidth}
             widthMax={Math.max(240, Math.min(520, viewportWidth - 560 - 8 - (panelOpen ? panelWidth + 8 : 0)))}
             loading={historyLoading}
             errors={historyErrors}
             onSelect={session => { if ((viewed ? session.path===viewed.options.path : session.runtimeId===activeId) && (session.running || session.activity==='running' || active?.chat.isRunning)) { revealLatest(); if(session.runtimeId)runtimes.markInboxRead(undefined,session.runtimeId); } else void selectSession(session).then(()=>{if(session.runtimeId)runtimes.markInboxRead(undefined,session.runtimeId);}).catch(onError); }}
             onBrowseWorkspace={browseWorkspace}
             onRemoveWorkspace={cwd=>{void removeWorkspace(cwd).catch(onError);}}
             hiddenProjects={hiddenProjects}
             collapsedProjects={preferences.collapsedProjects}
             onCollapse={(cwd,collapsed)=>{void savePreferences({collapsedProjects:{...preferencesRef.current?.collapsedProjects,[cwd]:collapsed}}).catch(onError);}}
             onNew={cwd => { void newSession(cwd).catch(onError); }}
             onChoose={() => { void chooseWorkspace().catch(onError); }}
             onHome={home}
             onSearch={() => setSearch({scope:'all'})}
             onSettings={() => openSettings()}
             onRefresh={() => { void refreshHistory(); }}
             onToggle={toggleSidebar}
             onWidth={(width, commit) => {
               setSidebarWidth(width);
               if (commit) void savePreferences({ sidebarWidth: width }).catch(onError);
             }}
             onPin={session => {
               const pins = preferencesRef.current?.pinnedSessions || [];
               void savePreferences({
                 pinnedSessions: pins.includes(session.path) ? pins.filter(path => path !== session.path) : [...pins, session.path],
               }).catch(error=>onError(error,t(pins.includes(session.path)?'omp.errors.unpinFailed':'omp.errors.pinFailed')));
             }}
             onRename={setRename}
             onBranch={setTreeSession}
             onFork={session=>forkSession(session,viewed?.options.path===session.path?composerKey:undefined)}
             onError={onError}
             onDisconnect={session => {
               if (session.runtimeId) void runtimes.close(session.runtimeId).catch(onError);
             }}
             onRemove={setRemoval}
           />
         <section className={`main-pane${viewed ? ' main-pane-history' : ''}`}>
           <ConversationTopbar
             title={conversationTitle}
             attention={<Inbox items={inboxItems} sources={toastSources} onOpen={openInboxItem} onRead={runtimes.markInboxRead}/>}
             project={workspace}
             onError={onError}
             onRename={selectedSession?.runtimeId&&!selectedSession.closed?()=>setRename(selectedSession):undefined}
             identity={<div className="omp-conversation-identity no-drag">
              {viewed ? viewed.access?.pending ? <span className="omp-conversation-mode">{t('omp.history.checking')}</span> : viewed.options.leafId!==undefined||viewed.snapshot?.session.sourceKind==='archive' ? <span className="omp-conversation-mode">{t('shell.readonly')}</span> : viewed.snapshot?.activity?.owner==='external'||viewed.access?.status==='external' ? viewed.snapshot?.activity?.state==='running' ? <button className="omp-conversation-mode" onClick={revealLatest}><span className="ui-live-dot" aria-hidden/>{t('shell.externalRunning')}</button> : <span className="omp-conversation-mode">{t('shell.externalIdle')}</span> : null : active&&!active.closed&&active.chat.prompts.length ? <button className="omp-conversation-mode is-waiting" onClick={revealAttention}><span className="ui-live-dot" aria-hidden/>{t('omp.live.waitingChoice')}</button> : active?.chat.isRunning&&!active.closed ? <button className="omp-conversation-mode" onClick={revealLatest}><span className="ui-live-dot" aria-hidden/>{t('shell.running')}</button> : null}
             </div>}
             history={sourcePath&&<HistoryMenu>
              {selectedSession&&<button type="button" onClick={()=>setTreeSession(selectedSession)}>{t('shell.historyBranches')}</button>}
              {viewed&&<button type="button" disabled={viewed.loading} onClick={()=>{void viewer.latest().catch(onError);}}>{t('omp.shell.savedLatest')}</button>}
              {viewed&&connectedSession&&<button type="button" onClick={()=>{void selectSession(connectedSession).catch(onError);}}>{t('omp.shell.returnConnected')}</button>}
              {!viewed&&active?.historyFollowing===false&&<button type="button" disabled={active.historyPaging} onClick={()=>{void runtimes.latest(active.runtimeId).catch(onError);}}>{t('omp.shell.latest')}</button>}
              {provenance?.status==='resolved'&&<button type="button" title={provenance.session.path} onClick={()=>{void viewSession(provenance.session.path,provenance.session.cwd).catch(onError);}}>{t('omp.shell.parentSource')}</button>}
              {provenance&&(provenance.status==='missing'||provenance.status==='ambiguous')&&<span className="omp-source-unavailable" title={provenance.reason}>{t(provenance.status==='missing'?'omp.shell.parentSourceMissing':'omp.shell.parentSourceAmbiguous')}</span>}
              {[...historyDiagnostics.material, ...historyDiagnostics.information, ...(active?.history?.diagnostics ?? [])].length > 0 && <details className="shell-history-diagnostics"><summary>{t('omp.chat.sourceDetails')}</summary>{[...historyDiagnostics.material, ...historyDiagnostics.information, ...(active?.history?.diagnostics ?? [])].map((message,index)=><p key={index}>{message}</p>)}</details>}
              {viewed?.snapshot?.sourceReference && <button type="button" onClick={()=>openPanel({kind:'resource',context:{kind:'saved',parentPath:viewed.options.path,leafId:viewed.snapshot?.selectedLeafId},reference:viewed.snapshot!.sourceReference!})}>{t('omp.resource.title')}</button>}
             </HistoryMenu>}
             collapsed={sidebarCollapsed}
             panelOpen={panelOpen}
             onToggleSidebar={toggleSidebar}
             onNew={() => { void newSession().catch(onError); }}
             onSearch={() => setSearch({scope:'all'})}
             onChooseWorkspace={() => { void chooseWorkspace().catch(onError); }}
           />
           <ChatView
             chat={projectedChat}
             homeContext={{readiness:deriveHomeReadiness(boot.runtime,workspace,active?[active.chat]:[],startError),connectionError:startError,connecting:starting,onRetryConnection:()=>setDraftFocus(value=>value+1),onCopy:text=>api.copyText(text),missingWorkspace:workspace&&/ENOENT|does not exist|not a directory/i.test(startError)?workspace:undefined,onChooseExecutable:()=>{void api.chooseExecutable().then(async path=>{if(path){await savePreferences({executablePath:path});const runtime=await api.checkRuntime();setBoot(value=>value?{...value,runtime}:value);}}).catch(onError);},onRemoveWorkspace:()=>{void removeWorkspace(workspace).then(()=>browseWorkspace('')).catch(onError);},onChooseWorkspace:()=>{void chooseWorkspace().catch(onError);},onSettings:openSettings}}
             runtimeId={viewed?null:active?.runtimeId??null}
             desktopQueue={runtimes.desktopQueue}
             queuedPrompts={desktopQueue.filter(item=>item.runtimeId===active?.runtimeId&&item.sessionId===active.chat.state.sessionId)}
             onCommand={sessionCommand}
             onOpenInspector={()=>openPanel({kind:'session'})}
             observedLive={viewed ? viewed.options.leafId===undefined && viewed.snapshot?.activity?.state==='running' : !!active && !active.closed}
             activeSubagentId={activeSubagentId}
             returnToTurn={returnToTurn}
             focusMessage={focusMessage}
             findRequest={findRequest?.scope===composerKey?findRequest:undefined}
             navigationRef={transcriptNavigation}
             onSearchAll={query=>setSearch({scope:'messages',query,path:sourcePath})}
            history={viewed?{hasMore:!!viewed.snapshot?.hasMore,loading:viewed.loading||viewed.paging,error:viewed.error,loadBefore:entryId=>viewer.older(entryId),latest:()=>viewer.latest()}:active?{hasMore:!!active.history?.hasMore,loading:active.historyPaging,error:active.historyError,following:active.historyFollowing,loadBefore:entryId=>runtimes.older(active.runtimeId,entryId),latest:()=>runtimes.latest(active.runtimeId)}:undefined}
             readonlyHistory={!!viewed}
             composerReadonly={!!historyMode?.readonly}
             sendDisabled={!accessReady}
             access={{ready:accessReady,category:accessCategory,reason:startError||warmDraft?.closed&&warmDraft.chat.error||accessReason,canFork:!starting&&(historyMode?historyMode.canFork:!!observed?.canFork),onFork:forkDraft,onRefresh:async()=>{if(draftShown)setDraftFocus(value=>value+1);else await refreshAccess();},onLatest:viewed&&viewed.options.leafId!==undefined?()=>{void viewSession(viewed.options.path,workspace).catch(onError);}:undefined,onReturn:viewed&&connectedSession?()=>{void selectSession(connectedSession).catch(onError);}:undefined}}
             mutationDisabled={!!viewed || starting || !!active?.closed || !!active&&!runtimeReady}
             onPickerOpen={openPicker}
             pickerDisabled={starting||!!startError||(viewed?!historyReady:!runtimeReady)}
             configuredModel={!activeId&&!viewed?boot.configuredModel:undefined}
             historyLoading={!!viewed?.loading}
             historyHeader={viewed && <div className="omp-history-pages">
               {viewed.error && !viewed.snapshot && <UserErrorNotice error={viewed.error} onRetry={()=>{void viewer.select(viewed.options);}}/>}
               {viewed.snapshot && !viewed.snapshot.messages.length && !viewed.error && <p>{t('omp.history.empty')}</p>}
             </div> || active&&<div className="omp-history-pages">
               {active.historyError&&!active.history&&<UserErrorNotice error={active.historyError} onRetry={()=>{void runtimes.latest(active.runtimeId).catch(onError);}}/>}
             </div>}
             composerKey={composerKey}
             cwd={workspace}
             onSend={send}
             onOpenSettings={()=>openSettings('credentials')}
             onAbort={async () => {
               if (active) try { await runtimes.command(active.runtimeId, { type: 'abort' }); } catch (error) { await refreshAccess(); throw error; }
             }}
             onModelChange={async (provider, modelId) => {
               const record=active??await resumeHistory();
               await runtimes.command(record.runtimeId, { type: 'set_model', provider, modelId });
             }}
             onThinkingChange={async level => {
               const record=active??await resumeHistory();
               await runtimes.command(record.runtimeId, { type: 'set_thinking_level', level });
             }}
             onOpenFile={(path,originTurnId) => openPanel({ kind: 'file', ...parseFileTarget(path), originTurnId })}
             sourceContext={viewed ? {kind:'saved',parentPath:viewed.options.path,leafId:viewed.snapshot?.selectedLeafId} : active ? {kind:'runtime',runtimeId:active.runtimeId} : undefined}
             onOpenChanges={request=>openPanel(request)}
             onOpenSubagent={(subagentId,originTurnId) => openPanel({ kind: 'subagent', subagentId, originTurnId })}
             onOpenSessionResource={(reference,originTurnId)=>{if(viewed)openPanel({kind:'resource',context:{kind:'saved',parentPath:viewed.options.path,leafId:viewed.snapshot?.selectedLeafId},reference,originTurnId});else if(active)openPanel({kind:'resource',context:{kind:'runtime',runtimeId:active.runtimeId},reference,originTurnId});else onError(new UserFacingError(t('omp.history.noForkSource')));}}
             enterToSend={preferences.enterToSend}
             contentWidth={preferences.chatContentWidth}
             onContentWidthChange={width => { void savePreferences({chatContentWidth:width}).catch(onError); }}
           />
         </section>
         {(panelOpen || panelMounted && !reducedMotion && !settings) && workspace && (
           <WorkPanel
             onActiveSubagentChange={setActiveSubagentId}
             onReturnToTurn={id=>{setReturnToTurn(value=>({id,sequence:(value?.sequence??0)+1}));setPanelOpen(false);}}
             inspector={{runtimeId:viewed?null:active?.runtimeId??null,state:viewed?null:active?.chat.state??null,connected:!!active&&!active.closed&&!viewed,canMutate:runtimeReady&&!viewed&&!starting,accessReason,onCommand:sessionCommand}}
             exiting={!panelOpen}
             onExitComplete={() => { if(!panelOpen)setPanelMounted(false); }}
             cwd={workspace}
             referencedPaths={referencedPaths}
             runtimeId={activeId}
             observedLive={!viewed && !!active && !active.closed}
             subagents={sharedAgents}
             onSavedNavigation={onSavedNavigation}
             parentSessionPath={sourcePath}
             historyLeafId={viewed?viewed.snapshot?.selectedLeafId:active?.chat.historySource?.leafId}
             historyFollowing={!viewed && active?.historyFollowing === true}
             request={panelRequest}
             width={panelWidth}
             onWidthChange={width => { setPanelWidthOverride(width); void savePreferences({ panelWidth: width }).catch(onError); }}
             onClose={() => setPanelOpen(false)}
           />
         )}
         <TooltipButton
           className="app-work-panel-toggle no-drag"
           tooltip={`${t('nav.toggleWorkPanel')} (${shortcutKeycaps('toggle-panel',boot.platform).join('')})`}
           ariaLabel={t('nav.toggleWorkPanel')}
           aria-pressed={panelOpen}
           disabled={!workspace}
           onClick={() => setPanelOpen(value => !value)}
         >
           <span className="app-work-panel-toggle-icon"><IconPanel size="var(--icon-ui)" /><IconPanelOpen size="var(--icon-ui)" /></span>
         </TooltipButton>
       </div>
     </PortalVisibilityProvider>
     {(settings || settingsMounted) && (
       <PortalVisibilityProvider visible={settingsVisible}>
         <div ref={settingsShell} className="omp-settings-retained" hidden={!settingsVisible} inert={!settingsVisible || undefined} aria-hidden={!settingsVisible || undefined}>
           <SettingsPage
            active={settings}
             destination={settingsDestination}
             initialQuery={settingsQuery}
             preferences={preferences}
             workspace={workspace || boot.home}
             runtimeInfo={boot.runtime}
             models={active?.chat.models ?? []}
            thinkingLevels={active?.chat.thinkingLevels ?? []}
             runtimeId={active?.runtimeId ?? null}
             loginRecovery={{details:startError,checking:starting,onRecheck:()=>{if(draftShown)setDraftFocus(value=>value+1);else{setSettings(false);void newSession(workspace||boot.home).catch(onError);}}}}
             onPreferencesChange={savePreferences}
             onNativeLogin={async(runtimeId,providerId)=>{await runtimes.command(runtimeId,{type:'login',providerId});}}
             onClose={() => {
               setSettings(false);
               if (!activeId && !starting && !viewer.getSnapshot()) {
                 const nextWorkspace=preferencesRef.current?.lastWorkspace || '';
                 if(nextWorkspace!==workspace){const draft=getComposerDraft(homeComposerKey).draft;if(draft.text||draft.attachments.length||draft.references.length)return;const next=workspaceDrafts.current.get(nextWorkspace)??{key:`home:${++composerSequence.current}`,cwd:nextWorkspace};homeDraft.current=next;workspaceDrafts.current.set(nextWorkspace,next);setHomeComposerKey(next.key);}
                 setWorkspace(nextWorkspace);
               }
             }}
           />
         </div>
       </PortalVisibilityProvider>
     )}
     <WindowControls platform={boot.platform} onError={onError} />
     <OverlayPresence>
     {search && (
       <CommandPalette
         key={`${search.scope}:${search.path??''}:${search.query??''}`}
         onClose={() => setSearch(null)}
         sourceGeneration={sourceGeneration}
         liveSessions={sessions.filter(session=>!!session.runtimeId&&!session.closed)}
         cwd={workspace} commands={!viewed&&!active?.closed?active?.chat.commands??[]:[]} platform={boot.platform}
         initialScope={search.scope} initialQuery={search.query} messagePath={search.path}
         onOpenSessionFile={()=>{void openNativeFile().catch(onError);}}
         onSearchCurrent={active&&!runtimes.isDraft(active.runtimeId)||viewed?query=>{setSearch(null);setSettings(false);setFindRequest(value=>({sequence:(value?.sequence??0)+1,scope:composerKey,query}));}:undefined}
         onSelect={target=>{pendingPaletteTarget.current=target;setSearch(null);}}
       />
     )}
     </OverlayPresence>
     <OverlayPresence>{shortcutHelp&&<ShortcutHelp platform={boot.platform} onClose={()=>setShortcutHelp(false)}/>}</OverlayPresence>
     <OverlayPresence>
     {rename && (
       <RenameDialog
         session={rename}
         onClose={() => setRename(null)}
         onSave={async name => {
           const record=rename.runtimeId?runtimes.getSnapshot()[rename.runtimeId]:undefined;
           if(!record||record.closed)throw new UserFacingError(t('omp.history.ownedBranchOnly'));
           await runtimes.command(record.runtimeId, { type: 'set_session_name', name });
           await refreshHistory();
         }}
       />
     )}
     </OverlayPresence>
     <OverlayPresence>
     {treeSession && <HistoryTreeDialog key={treeSession.path} session={treeSession} runtimeLeafId={treeSession.runtimeId?records[treeSession.runtimeId]?.chat.historySource?.leafId:undefined} selectedLeafId={viewed?.options.path===treeSession.path?viewed.options.leafId:undefined} onClose={()=>setTreeSession(null)} onView={leafId=>viewSession(treeSession.path,treeSession.cwd,leafId)} onFork={async()=>{try{await forkSession(treeSession);}catch(error){await refreshAccess();throw error;}}} onOwnedBranch={treeSession.runtimeId&&!records[treeSession.runtimeId]?.closed?()=>beginBranch(treeSession):undefined}/> }
     </OverlayPresence>
     <OverlayPresence>
     {removal&&<RemoveSessionDialog session={removal} onClose={()=>setRemoval(null)} onRemove={allowUncertain=>removeConversation(removal,allowUncertain)}/>}
     </OverlayPresence>
     <OverlayPresence>
     {branch && (
       <BranchDialog
         messages={branch.messages}
         onClose={() => setBranch(null)}
         onBranch={async entryId => {
           const result = await runtimes.command<{ cancelled: boolean; text: string }>(branch.runtimeId, { type: 'branch', entryId });
           if (result.cancelled) throw new UserFacingError(t('omp.shell.branchCancelled'));
           const record = runtimes.getSnapshot()[branch.runtimeId];
           selection.current++;
           viewer.clear();
           setActiveId(branch.runtimeId);
           setWorkspace(record.cwd);
           setSettings(false);
           setStarting(false);
           setPanelRequest(null);
           if (result.text) toast(t('omp.shell.branchedBefore',{text:result.text}));
           await refreshHistory();
         }}
       />
     )}
     </OverlayPresence>
     <OverlayPresence key={`${activeId}:${!!viewed}:${settings}`}>
     {prompt && (
       <>
         <ExtensionDialog
           key={`${prompt.runtimeId}:${prompt.request.id}`}
           request={prompt.request}
           inlineRuntimeId={prompt.runtimeId===active?.runtimeId&&!settings&&!viewed&&!runtimes.startupPrompts.some(item=>item.runtimeId===prompt.runtimeId)?prompt.runtimeId:undefined}
           originLabel={sessions.find(session=>session.runtimeId===prompt.runtimeId)?.title||t('omp.shell.startingRuntime')}
           onDismiss={()=>setDismissedPrompts(items=>new Set([...items,`${prompt.runtimeId}:${prompt.request.id}`]))}
           onRespond={response => runtimes.respond(prompt.runtimeId, response)}
         />
       </>
     )}
     </OverlayPresence>
     <ToastHost toasts={toasts.filter(item=>item.severity!=='error'||item.message!==surfacedError)} sources={toastSources} onOpen={runtimeId=>{const record=runtimes.getSnapshot()[runtimeId];if(!record?.closed){void openRuntime(runtimeId);return;}const key=runtimeComposerKeys.current.get(`${runtimeId}:${record.chat.state.sessionId}`)??`reconnect:${runtimeId}`;if(record.source.status==='persisted'){void openSession(record.cwd,record.source.path,key,'resume').catch(onError);}else{workspaceDrafts.current.set(record.cwd,{key,cwd:record.cwd});void runtimes.releaseDraft().then(()=>{browseWorkspace(record.cwd);setDraftFocus(value=>value+1);}).catch(onError);}}} onDismiss={dismissToast} onError={onError} />
   </div>
   </FileObjectProvider>
   </DisplayPreferencesContext.Provider>
 );
}
