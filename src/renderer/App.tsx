import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import type { Bootstrap, DesktopPreferences, NativeSubagent, PanelRequest, PromptInput, RuntimeAccess, SessionSummary } from '../shared/contracts';
import { ChatView } from './chat/ChatView';
import { ExtensionDialog } from './chat/ExtensionDialog';
import { SettingsPage } from './settings/SettingsPage';
import { WorkPanel } from './workspace/WorkPanel';
import { PortalVisibilityProvider } from './lib/portal-visibility';
import { IconChevronRight, IconPanel, IconPanelOpen } from './ui/icons';
import { Button, TooltipButton } from './ui/ui';
import { LiquidDefs } from './ui/liquid/LiquidDefs';
import { CapsuleMorphLayer } from './ui/liquid/CapsuleMorphLayer';
import { Sidebar, type SidebarSession } from './app/Sidebar';
import { BranchDialog, RenameDialog, SearchDialog } from './app/Dialogs';
import { ConversationTopbar, ToastHost, WindowControls, type Toast } from './app/Chrome';
import { RuntimeStore, errorText, type RuntimeRecord } from './app/runtime-store';
import { HistoryStore } from './app/history-store';
import { HistoryTreeDialog } from './app/HistoryTreeDialog';
import { getComposerDraft } from './chat/composer/drafts';
import { partitionSourceDiagnostics } from './chat/message-details';
import { workPanelWidthForSidebarReopen } from './lib/work-panel-resize';

export function App() {
 const { t } = useTranslation();
 const api=window.ompDesktop;
 const [boot,setBoot]=useState<Bootstrap|null>(null),[bootError,setBootError]=useState(''),[bootAttempt,setBootAttempt]=useState(0);
 const [history,setHistory]=useState<SessionSummary[]>([]),[historyErrors,setHistoryErrors]=useState<{path:string;message:string}[]>([]),[historyLoading,setHistoryLoading]=useState(false);
 const [activeId,setActiveId]=useState<string|null>(null),[workspace,setWorkspace]=useState(''),[settings,setSettings]=useState(false),[search,setSearch]=useState(false);
 const [settingsMounted,setSettingsMounted]=useState(false);
 const [settingsPresented,setSettingsPresented]=useState(false);
 const chatShell=useRef<HTMLDivElement>(null),settingsShell=useRef<HTMLDivElement>(null);
 const settingsOpener=useRef<HTMLElement|null>(null);
 const chatVisible=!settings||!settingsPresented,settingsVisible=settings||settingsPresented;
 const [sidebarCollapsed,setSidebarCollapsed]=useState(false),[sidebarWidth,setSidebarWidth]=useState(275),[panelOpen,setPanelOpen]=useState(false),[panelRequest,setPanelRequest]=useState<PanelRequest|null>(null),[viewportWidth,setViewportWidth]=useState(window.innerWidth);
 const [activeSubagentId,setActiveSubagentId]=useState<string|null>(null);
 const [sidebarMounted,setSidebarMounted]=useState(true),[panelMounted,setPanelMounted]=useState(false);
 const [reducedMotion,setReducedMotion]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 const [panelWidthOverride,setPanelWidthOverride]=useState<number|null>(null);
 const autoCollapsedSidebar=useRef(false);
 const sidebarManuallyReopened=useRef(false);
 const [starting,setStarting]=useState(false),[startError,setStartError]=useState(''),[toasts,setToasts]=useState<Toast[]>([]);
 const [rename,setRename]=useState<SidebarSession|null>(null),[branch,setBranch]=useState<{runtimeId:string;messages:{entryId:string;text:string}[]}|null>(null);
 const [treeSession,setTreeSession]=useState<SidebarSession|null>(null);
 const [viewer]=useState(()=>new HistoryStore(api));
 const viewed=useSyncExternalStore(viewer.subscribe,viewer.getSnapshot);
 useEffect(()=>viewer.connect(),[viewer]);
 const savedChildKey=viewed?.snapshot?JSON.stringify([viewed.options.path,viewed.snapshot.selectedLeafId,viewed.snapshot.revision]):null;
 const [savedChildren,setSavedChildren]=useState<{key:string;subagents:NativeSubagent[];diagnostics:string[]}|null>(null);
 useEffect(()=>{
   if(!savedChildKey||!viewed?.snapshot)return;
   let current=true;
   void api.listHistorySubagents({path:viewed.options.path,leafId:viewed.snapshot.selectedLeafId}).then(result=>{if(current)setSavedChildren({key:savedChildKey,...result});},cause=>{if(current)setSavedChildren({key:savedChildKey,subagents:[],diagnostics:[errorText(cause)]});});
   return()=>{current=false;};
 },[api,savedChildKey]);
 const historicalChildren=savedChildren?.key===savedChildKey?savedChildren:null;
 const historyDiagnostics=useMemo(()=>partitionSourceDiagnostics([...(viewed?.snapshot?.diagnostics??[]),...(historicalChildren?.diagnostics??[])]),[viewed?.snapshot?.diagnostics,historicalChildren?.diagnostics]);
 const historicalChat=useMemo(()=>viewed?.chat?{...viewed.chat,subagents:historicalChildren?.subagents??[]}:null,[viewed?.chat,historicalChildren]);
 const toastSequence=useRef(0),selection=useRef(0),historySequence=useRef(0),preferencesRef=useRef<DesktopPreferences|null>(null),preferencesQueue=useRef<Promise<unknown>>(Promise.resolve());
 const historyTimer=useRef<number|undefined>(undefined);
 const pendingSelection=useRef<{ticket:number;promise:Promise<RuntimeRecord>}|null>(null);
 const [homeComposerKey,setHomeComposerKey]=useState('home:0');
 const homeDraft=useRef({key:'home:0',cwd:''});
 const workspaceDrafts=useRef(new Map<string,{key:string;cwd:string}>());
 const composerSequence=useRef(0);
 const runtimeComposerKeys=useRef(new Map<string,string>());
 const toast=useCallback((message:string,error=false,runtimeId='',url?:string)=>setToasts(items=>[...items,{id:++toastSequence.current,message,error,runtimeId,url}]),[]);
 const onError=useCallback((error:unknown)=>toast(errorText(error),true),[toast]);
 const refreshHistory=useCallback(async()=>{const ticket=++historySequence.current;setHistoryLoading(true);try{const result=await api.listHistory();if(ticket===historySequence.current){setHistory(result.sessions);setHistoryErrors(result.diagnostics);}}catch(error){if(ticket===historySequence.current)setHistoryErrors([{path:'',message:errorText(error)}]);}finally{if(ticket===historySequence.current)setHistoryLoading(false);}},[api]);
 const [runtimes]=useState(()=>new RuntimeStore(api,notice=>toast(notice.message,notice.error,notice.runtimeId,notice.url),()=>{window.clearTimeout(historyTimer.current);historyTimer.current=window.setTimeout(()=>{void refreshHistory();},150);}));
 const records=useSyncExternalStore(runtimes.subscribe,runtimes.getSnapshot);
 const active=activeId?records[activeId]:undefined;
 const composerKey=viewed ? `history:${viewed.options.path}` : active ? runtimeComposerKeys.current.get(`${active.runtimeId}:${active.chat.state.sessionId}`) ?? `session:${active.runtimeId}:${active.chat.state.sessionId}` : homeComposerKey;
 const [runtimeAccess,setRuntimeAccess]=useState<{key:string;value:RuntimeAccess}|null>(null);
 const accessRefresh=useRef<(fresh?:boolean)=>Promise<void>>(async()=>{});
 const activeAccessKey=!viewed&&active&&!active.closed?`${active.runtimeId}:${active.chat.state.sessionId}:${active.chat.state.sessionFile??''}`:null;
 useEffect(()=>{
   if(!activeAccessKey||!active||settings){accessRefresh.current=async()=>{};return;}
   setRuntimeAccess(null);
   let live=true,pending:Promise<void>|null=null;
   const refresh=(fresh=false):Promise<void>=>{
     if(pending)return fresh?pending.then(()=>live?refresh():undefined):pending;
     pending=api.getRuntimeAccess(active.runtimeId).then(value=>{if(live)setRuntimeAccess({key:activeAccessKey,value});},cause=>{if(live)setRuntimeAccess({key:activeAccessKey,value:{status:'unknown',reason:errorText(cause),checkedAt:Date.now(),canFork:false}});}).finally(()=>{pending=null;});
     return pending;
   };
   accessRefresh.current=refresh;
   const focus=()=>{setRuntimeAccess(null);void refresh(true);};
   void refresh();
   const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},1750);
   window.addEventListener('focus',focus);
   return()=>{live=false;window.clearInterval(timer);window.removeEventListener('focus',focus);if(accessRefresh.current===refresh)accessRefresh.current=async()=>{};};
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
 useEffect(()=>{let cancelled=false;setBootError('');void api.bootstrap().then(result=>{if(cancelled)return;preferencesRef.current=result.preferences;homeDraft.current.cwd=result.preferences.lastWorkspace;workspaceDrafts.current.set(homeDraft.current.cwd,homeDraft.current);setBoot(result);setWorkspace(result.preferences.lastWorkspace);setSidebarWidth(result.preferences.sidebarWidth);document.documentElement.dataset.platform=result.platform;void refreshHistory();}).catch(error=>{if(!cancelled)setBootError(errorText(error));});return()=>{cancelled=true;};},[api,bootAttempt,refreshHistory]);
 useEffect(()=>{if(!boot)return;const preferences=boot.preferences;const media=window.matchMedia('(prefers-color-scheme: dark)');const apply=()=>{document.documentElement.dataset.theme=preferences.theme==='system'?(media.matches?'dark':'light'):preferences.theme;};apply();media.addEventListener('change',apply);document.documentElement.lang=preferences.language;document.documentElement.style.setProperty('--font-scale',String(preferences.fontSize/14));document.documentElement.style.fontSize=`${preferences.fontSize}px`;if(preferences.fontFamily)document.documentElement.style.setProperty('--font-sans',preferences.fontFamily);else document.documentElement.style.removeProperty('--font-sans');void i18next.changeLanguage(preferences.language).catch(onError);return()=>media.removeEventListener('change',apply);},[boot?.preferences,onError]);
 useEffect(()=>{const resize=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 const panelWidth=panelWidthOverride??boot?.preferences.panelWidth??480;
 useEffect(()=>{
   const media=window.matchMedia('(prefers-reduced-motion: reduce)');
   const update=()=>setReducedMotion(media.matches);
   media.addEventListener('change',update);
   return()=>media.removeEventListener('change',update);
 },[]);
 useEffect(()=>{if(!sidebarCollapsed)setSidebarMounted(true);else if(reducedMotion||settings)setSidebarMounted(false);},[sidebarCollapsed,reducedMotion,settings]);
 useEffect(()=>{if(panelOpen)setPanelMounted(true);else if(reducedMotion||settings)setPanelMounted(false);},[panelOpen,reducedMotion,settings]);
 useEffect(()=>{
   if(!panelOpen){
     if(autoCollapsedSidebar.current){autoCollapsedSidebar.current=false;setSidebarCollapsed(false);}
     sidebarManuallyReopened.current=false;
     return;
   }
   if(boot&&!sidebarCollapsed&&!sidebarManuallyReopened.current&&viewportWidth<sidebarWidth+panelWidth+450+16){autoCollapsedSidebar.current=true;setSidebarCollapsed(true);}
 },[panelOpen,boot,viewportWidth,sidebarWidth,panelWidth,sidebarCollapsed]);
 const savePreferences=useCallback((patch:Partial<DesktopPreferences>):Promise<void>=>{
   const operation=preferencesQueue.current.then(async()=>{
     const changesRuntime=patch.profile!==undefined&&patch.profile!==preferencesRef.current?.profile||patch.executablePath!==undefined&&patch.executablePath!==preferencesRef.current?.executablePath;
     if(changesRuntime&&(runtimes.hasStarting||Object.values(runtimes.getSnapshot()).some(record=>!record.closed))) throw new Error(i18next.t('omp.shell.disconnectBeforeRuntimeChange'));
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
 const openSession=useCallback(async(cwd:string,sessionPath?:string,adoptComposerKey?:string,mode?:'resume'|'fork'):Promise<RuntimeRecord>=>{
   const ticket=++selection.current;
   const savedDraft=workspaceDrafts.current.get(cwd);
   const draftKey=adoptComposerKey ?? (sessionPath ? `history:${sessionPath}` : savedDraft?.key ?? `draft:${++composerSequence.current}:${cwd}`);
   if(!sessionPath){homeDraft.current={key:draftKey,cwd};workspaceDrafts.current.set(cwd,homeDraft.current);setHomeComposerKey(draftKey);}
   if(!sessionPath)viewer.clear();
   setStarting(true);setStartError('');setSettings(false);if(!viewer.getSnapshot())setWorkspace(cwd);setActiveId(null);
   const promise=runtimes.start({cwd,sessionPath,mode});
   pendingSelection.current={ticket,promise};
   try{
     const record=await promise;
     const nativeKey=`${record.runtimeId}:${record.chat.state.sessionId}`;
     if(!runtimeComposerKeys.current.has(nativeKey))runtimeComposerKeys.current.set(nativeKey,draftKey);
     if(!sessionPath && workspaceDrafts.current.get(cwd)?.key===draftKey){
       const next={key:`home:${++composerSequence.current}`,cwd:record.cwd};
       workspaceDrafts.current.set(cwd,next);
       if(homeDraft.current.key===draftKey)homeDraft.current=next;
       // Adoption keeps the latest composition on the runtime, never on Home too.
       setHomeComposerKey(key=>key===draftKey?next.key:key);
     }
     if(ticket===selection.current){viewer.clear();setActiveId(record.runtimeId);setWorkspace(record.cwd);setPanelRequest(null);void rememberWorkspace(record.cwd).catch(onError);}
     return record;
   }catch(error){if(ticket===selection.current&&!sessionPath)setStartError(errorText(error));throw error;}
   finally{if(ticket===selection.current)setStarting(false);if(pendingSelection.current?.ticket===ticket)pendingSelection.current=null;}
 },[runtimes,viewer,rememberWorkspace,onError]);
 const viewSession=useCallback(async(path:string,cwd:string,leafId?:string|null)=>{const ticket=++selection.current;pendingSelection.current=null;setActiveId(null);setWorkspace(cwd);setSettings(false);setStarting(false);setStartError('');setPanelRequest(null);await viewer.select({path,...(leafId!==undefined?{leafId}:{})});const snapshot=viewer.getSnapshot()?.snapshot;if(ticket===selection.current&&snapshot)setWorkspace(snapshot.session.cwd);},[viewer]);
 const chooseWorkspace=useCallback(async()=>{const cwd=await api.chooseWorkspace();const draft=getComposerDraft(composerKey).draft;if(cwd)await openSession(cwd,undefined,!active&&!viewed&&(cwd===workspace||!workspace&&!draft.attachments.length&&!draft.references.length)?composerKey:undefined);},[api,openSession,active,viewed,workspace,composerKey]);
 const newSession=useCallback(async(cwd?:string)=>{const selected=cwd||workspace||preferencesRef.current?.lastWorkspace||await api.chooseWorkspace();const draft=getComposerDraft(composerKey).draft;if(selected)await openSession(selected,undefined,!active&&!viewed&&(selected===workspace||!workspace&&!draft.attachments.length&&!draft.references.length)?composerKey:undefined);},[api,workspace,openSession,active,viewed,composerKey]);
 const home=useCallback(()=>{selection.current++;viewer.clear();pendingSelection.current=null;setHomeComposerKey(homeDraft.current.key);setActiveId(null);setWorkspace(homeDraft.current.cwd||preferencesRef.current?.lastWorkspace||'');setSettings(false);setStarting(false);setStartError('');setPanelRequest(null);},[viewer]);
 const selectSession=useCallback(async(session:SidebarSession)=>{const current=session.runtimeId?records[session.runtimeId]:Object.values(records).find(record=>record.chat.state.sessionFile===session.path&&!record.closed);if(current&&!current.closed){selection.current++;viewer.clear();pendingSelection.current=null;setActiveId(current.runtimeId);setWorkspace(current.cwd);setSettings(false);setStarting(false);setStartError('');setPanelRequest(null);void rememberWorkspace(current.cwd).catch(onError);return;}await viewSession(session.path,session.cwd);},[records,viewer,viewSession,rememberWorkspace,onError]);
 const openNativeFile=useCallback(async()=>{const path=await api.chooseSessionFile();if(path)await viewSession(path,history.find(session=>session.path===path)?.cwd||'');},[api,history,viewSession]);
 const beginBranch=useCallback(async(session:SidebarSession)=>{const record=session.runtimeId?records[session.runtimeId]:undefined;if(!record||record.closed)throw new Error(i18next.t('omp.history.ownedBranchOnly'));runtimes.requireOpen(record.runtimeId);const result=await api.request<{messages:{entryId:string;text:string}[]}>(record.runtimeId,{type:'get_branch_messages'});setBranch({runtimeId:record.runtimeId,messages:result.messages});},[api,records,runtimes]);
 const resumeHistory=useCallback(async()=>{const view=viewer.getSnapshot();if(!view?.snapshot||!view.snapshot.session.writable||view.loading||view.error||view.access?.status!=='idle'||view.options.leafId!==undefined)throw new Error(i18next.t('omp.history.sendBlocked'));return openSession(view.snapshot.session.cwd,view.options.path,`history:${view.options.path}`,'resume');},[viewer,openSession]);
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
   const path=view?.options.path??active?.chat.state.sessionFile;
   if(!path)throw new Error(i18next.t('omp.history.noForkSource'));
   if(view&&!view.snapshot?.session.canFork)throw new Error(i18next.t('omp.history.forkUnavailable'));
   if(!view&&(!active||!(await api.getRuntimeAccess(active.runtimeId)).canFork))throw new Error(i18next.t('omp.history.forkUnavailable'));
   try{await forkSession({path,cwd:view?.snapshot?.session.cwd||active?.cwd||workspace},composerKey);}
   catch(error){await refreshAccess();throw error;}
 },[active,api,workspace,composerKey,viewer,forkSession,refreshAccess]);
 const send=useCallback(async(input:PromptInput)=>{
   try{
     let record=active;
     if(record?.closed)throw new Error(i18next.t('omp.shell.reopenToSend'));
     if(!record){
       const pending=pendingSelection.current;
       if(pending?.ticket===selection.current)record=await pending.promise;
       else if(viewer.getSnapshot())record=await resumeHistory();
       else {const cwd=workspace||await api.chooseWorkspace();if(!cwd)throw new Error(i18next.t('omp.shell.selectWorkspaceToSend'));record=await openSession(cwd,undefined,composerKey);}
     }
     runtimes.requireOpen(record.runtimeId);
     const accepted=await api.sendPrompt(record.runtimeId,input);
     const localCommand=!!accepted&&typeof accepted==='object'&&'agentInvoked'in accepted&&accepted.agentInvoked===false;
     void runtimes.refresh(record.runtimeId,localCommand).catch(onError);
   }catch(error){await refreshAccess();throw error;}
 },[active,api,workspace,openSession,runtimes,viewer,resumeHistory,onError,composerKey,refreshAccess]);
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.isComposing||!(event.metaKey||event.ctrlKey)||event.altKey)return;if(document.querySelector('[aria-modal="true"]'))return;const k=event.key.toLowerCase();if(k==='b'){event.preventDefault();if(event.shiftKey)setPanelOpen(value=>!value);else toggleSidebar();}else if(k==='k'||k==='p'){event.preventDefault();setSearch(true);}else if(k==='n'){event.preventDefault();void newSession().catch(onError);}else if(k===','){event.preventDefault();setSettings(value=>!value);}else if(k==='o'){event.preventDefault();void chooseWorkspace().catch(onError);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[newSession,chooseWorkspace,onError,toggleSidebar]);
 const sessions=useMemo(()=>{const rows=new Map<string,SidebarSession>(history.map(session=>[session.path,session]));for(const record of Object.values(records)){const state=record.chat.state;const path=state.sessionFile||`runtime:${record.runtimeId}`;const old=rows.get(path);const access=runtimeAccess?.key===`${record.runtimeId}:${state.sessionId}:${state.sessionFile??''}`?runtimeAccess.value:undefined;rows.set(path,{...old,id:state.sessionId,path,cwd:record.cwd,title:state.sessionName||old?.title||t('omp.shell.newSession'),preview:old?.preview||'',updatedAt:old?.updatedAt||new Date().toISOString(),sourceKind:'journal',writable:!record.closed,canFork:access?.canFork??(old?.id===state.sessionId&&!!old.canFork),runtimeId:record.runtimeId,running:record.chat.isRunning,pending:record.chat.prompts.length>0,failed:!!record.chat.error,closed:record.closed});}return [...rows.values()].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));},[history,records,runtimeAccess,t]);
 const prompts=[...runtimes.startupPrompts,...Object.values(records).flatMap(record=>record.closed?[]:record.chat.prompts.map(request=>({runtimeId:record.runtimeId,request})))];
 const prompt=prompts[0];
 const dismissToast=useCallback((id:number)=>setToasts(items=>items.filter(item=>item.id!==id)),[]);
 const surfacedError=!settings?(startError||(!boot?.runtime.available?boot?.runtime.error:'')||''):'';
 useEffect(()=>{
   if(surfacedError&&toasts.some(item=>item.error&&item.message===surfacedError))setToasts(items=>items.filter(item=>!item.error||item.message!==surfacedError));
 },[surfacedError,toasts]);
 const openPanel=(request:PanelRequest)=>{setPanelRequest(request);setPanelOpen(true);};
 if(!boot)return <div className="app-shell app-shell-boot"><div className="omp-startup-card no-drag"><h1>OMP-Desktop</h1>{bootError?<><p role="alert">{bootError}</p><Button onClick={()=>setBootAttempt(value=>value+1)}>{t('omp.shell.retryInitialization')}</Button></>:<p role="status">{t('omp.shell.discovering')}</p>}</div><WindowControls platform={document.documentElement.dataset.platform||'darwin'} onError={onError}/></div>;
 const preferences=boot.preferences;
 const observed=runtimeAccess?.key===activeAccessKey?runtimeAccess.value:undefined;
 const historyReady=!!viewed?.snapshot?.session.writable&&!viewed.loading&&!viewed.error&&viewed.options.leafId===undefined&&viewed.access?.status==='idle';
 const runtimeReady=!!active&&!active.closed&&(observed?.status==='owned'||observed?.status==='idle');
 const accessReady=!starting&&(viewed?historyReady:active?runtimeReady:true);
 const accessReason=starting?t('omp.history.connecting'):viewed?viewed.loading?t('omp.history.checking'):viewed.error?`${t('omp.history.unknown')} ${viewed.error}`:viewed.snapshot&&!viewed.snapshot.session.writable?t('omp.history.sourceReadonly'):viewed.options.leafId!==undefined?t('omp.history.branchReadonly'):historyReady?t('omp.history.readyOriginal'):`${t(`omp.history.${viewed.access?.status??'unknown'}`)} ${viewed.access?.reason??''}`:active?.closed?t('omp.shell.reopenToSend'):active?runtimeReady?t('omp.history.readyOriginal'):!observed?t('omp.history.checking'):`${t(`omp.history.${observed.status}`)} ${observed.reason??''}`:t('omp.history.readyNew');
 return (
   <div
     className={`app-shell${settings ? ' settings-mode' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
     style={{ '--ds-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
   >
     <div className="app-scenic-backdrop" aria-hidden />
     <PortalVisibilityProvider visible={chatVisible}>
       <div ref={chatShell} className="app-chat-shell" hidden={!chatVisible} inert={!chatVisible || undefined} aria-hidden={!chatVisible || undefined}>
         {(!sidebarCollapsed || sidebarMounted && !reducedMotion && !settings) && (
           <Sidebar
             exiting={sidebarCollapsed}
             onExitComplete={() => { if(sidebarCollapsed)setSidebarMounted(false); }}
             sessions={sessions}
             workspaces={preferences.recentWorkspaces}
             workspace={workspace}
             active={viewed?.options.path??activeId}
             pinned={preferences.pinnedSessions}
             width={sidebarWidth}
             widthMax={Math.max(240, Math.min(520, viewportWidth - 450 - 8 - (panelOpen ? panelWidth + 8 : 0)))}
             version={boot.runtime.version}
             loading={historyLoading}
             errors={historyErrors}
             onSelect={session => { void selectSession(session).catch(onError); }}
             onNew={cwd => { void newSession(cwd).catch(onError); }}
             onChoose={() => { void chooseWorkspace().catch(onError); }}
             onHome={home}
             onSearch={() => setSearch(true)}
             onSettings={() => setSettings(true)}
             onOpenFile={() => { void openNativeFile().catch(onError); }}
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
               }).catch(onError);
             }}
             onRename={setRename}
             onBranch={setTreeSession}
             onDisconnect={session => {
               if (session.runtimeId) void runtimes.close(session.runtimeId).catch(onError);
             }}
           />
         )}
         <section className={`main-pane${viewed ? ' main-pane-history' : ''}`}>
           <ConversationTopbar
             title={viewed?.snapshot?.session.title || active?.chat.state.sessionName || sessions.find(session => session.runtimeId === activeId)?.title || t('omp.shell.newSession')}
             project={workspace}
             collapsed={sidebarCollapsed}
             panelOpen={panelOpen}
             onToggleSidebar={toggleSidebar}
             onNew={() => { void newSession().catch(onError); }}
             onSearch={() => setSearch(true)}
             onChooseWorkspace={() => { void chooseWorkspace().catch(onError); }}
           />
           {(!boot.runtime.available || startError) && (
             <section className="omp-onboarding no-drag">
               <h2>{t(!boot.runtime.available ? 'omp.shell.installationRequired' : 'omp.shell.startFailed')}</h2>
               <p className="omp-startup-error" role="alert">
                 {startError || boot.runtime.error || t('omp.shell.executableNotFound')}
               </p>
               <p>{t('omp.shell.installationHelp')}</p>
               <p>{t('omp.shell.modelHelp')}</p>
               <div className="omp-onboarding-actions">
                 <Button onClick={() => setSettings(true)}>{t('nav.settings')}</Button>
                 <Button onClick={() => {
                   void api.checkRuntime().then(runtime => setBoot(value => value ? { ...value, runtime } : value)).catch(onError);
                 }}>{t('omp.shell.checkInstallation')}</Button>
                 {workspace && (
                   <Button onClick={() => { void newSession(workspace).catch(onError); }}>{t('omp.shell.startWorkspace')}</Button>
                 )}
               </div>
             </section>
           )}
           {starting && (
             <div className="omp-runtime-progress" role="status">
               {t('omp.shell.startingWorkspace',{workspace})}
             </div>
           )}
           <ChatView
             chat={historicalChat ?? active?.chat ?? null}
             activeSubagentId={activeSubagentId}
             readonlyHistory={!!viewed}
             sendDisabled={!accessReady}
             mutationDisabled={!!viewed || starting || !!active?.closed || !!active&&!runtimeReady}
             access={{ready:accessReady,reason:accessReason,canFork:!starting&&(viewed?!viewed.loading&&!viewed.error&&!!viewed.snapshot?.session.canFork:!!observed?.canFork),onFork:forkDraft,onRefresh:refreshAccess}}
             historyHeader={viewed && <div className="omp-history-pages">
               {viewed.loading && <p role="status">{t('omp.shell.readingHistory')}</p>}
               {viewed.error && <><p role="alert" className="omp-inline-error">{viewed.error}</p><Button disabled={viewed.loading} onClick={()=>{void viewer.select(viewed.options);}}>{t('omp.history.retry')}</Button></>}
               {viewed.snapshot?.hasMore && <Button disabled={viewed.paging || viewed.loading} onClick={()=>{void viewer.older();}}>{t(viewed.paging?'omp.history.loadingEarlier':'omp.history.loadEarlier')}</Button>}
               {historyDiagnostics.material.map(message=><p role="status" key={message}>{message}</p>)}
               {historyDiagnostics.information.length>0 && <details className="saved-resource-source native-disclosure"><summary>{t('omp.chat.sourceDetails')}<IconChevronRight size={12} className="native-disclosure-caret" aria-hidden /></summary>{historyDiagnostics.information.map(message=><p key={message}>{message}</p>)}</details>}
               {viewed.snapshot?.sourceReference && <Button onClick={()=>openPanel({kind:'resource',parentPath:viewed.options.path,reference:viewed.snapshot!.sourceReference!})}>{t('omp.resource.title')}</Button>}
               {viewed.snapshot && !viewed.snapshot.messages.length && !viewed.loading && !viewed.error && <p>{t('omp.history.empty')}</p>}
             </div>}
             composerKey={composerKey}
             cwd={workspace}
             onSend={send}
             onAbort={async () => {
               if (active) try { await runtimes.command(active.runtimeId, { type: 'abort' }); } catch (error) { await refreshAccess(); throw error; }
             }}
             onModelChange={async (provider, modelId) => {
               if (!active) throw new Error(t('omp.shell.startToSelectModel'));
               try { await runtimes.command(active.runtimeId, { type: 'set_model', provider, modelId }); } catch (error) { await refreshAccess(); throw error; }
             }}
             onThinkingChange={async level => {
               if (!active) throw new Error(t('omp.shell.startToSelectThinking'));
               try { await runtimes.command(active.runtimeId, { type: 'set_thinking_level', level }); } catch (error) { await refreshAccess(); throw error; }
             }}
             onOpenFile={path => openPanel({ kind: 'file', path })}
             onOpenSubagent={subagentId => openPanel({ kind: 'subagent', subagentId })}
             onOpenSessionResource={reference=>{const parentPath=viewed?.options.path??active?.chat.state.sessionFile;if(parentPath)openPanel({kind:'resource',parentPath,reference});else onError(new Error(t('omp.history.noForkSource')));}}
             enterToSend={preferences.enterToSend}
             contentWidth={preferences.chatContentWidth}
             onContentWidthChange={width => { void savePreferences({chatContentWidth:width}).catch(onError); }}
           />
         </section>
         {(panelOpen || panelMounted && !reducedMotion && !settings) && workspace && (
           <WorkPanel
            sessionTitle={viewed?.snapshot?.session.title || active?.chat.state.sessionName || sessions.find(session => session.runtimeId === activeId)?.title || t('omp.shell.newSession')}
             onActiveSubagentChange={setActiveSubagentId}
             exiting={!panelOpen}
             onExitComplete={() => { if(!panelOpen)setPanelMounted(false); }}
             cwd={workspace}
             runtimeId={activeId}
             subagents={viewed?historicalChildren?.subagents??[]:active?.chat.subagents??[]}
             parentSessionPath={viewed?.options.path??active?.chat.historySource?.path??active?.chat.state.sessionFile}
             historyLeafId={viewed?viewed.snapshot?.selectedLeafId:active?.chat.historySource?.leafId}
             request={panelRequest}
             width={panelWidth}
             onWidthChange={width => { setPanelWidthOverride(width); void savePreferences({ panelWidth: width }).catch(onError); }}
             onClose={() => setPanelOpen(false)}
           />
         )}
         <TooltipButton
           className="app-work-panel-toggle no-drag lg-thin lg-capsule lg-pressable"
           tooltip={`${t('nav.toggleWorkPanel')} (⌘/Ctrl+Shift+B)`}
           ariaLabel={t('nav.toggleWorkPanel')}
           aria-pressed={panelOpen}
           disabled={!workspace}
           onClick={() => setPanelOpen(value => !value)}
         >
           <span className="app-work-panel-toggle-icon"><IconPanel size={15} /><IconPanelOpen size={15} /></span>
         </TooltipButton>
       </div>
     </PortalVisibilityProvider>
     {(settings || settingsMounted) && (
       <PortalVisibilityProvider visible={settingsVisible}>
         <div ref={settingsShell} className="omp-settings-retained" hidden={!settingsVisible} inert={!settingsVisible || undefined} aria-hidden={!settingsVisible || undefined}>
           <SettingsPage
             preferences={preferences}
             workspace={workspace || boot.home}
             runtimeInfo={boot.runtime}
             models={active?.chat.models ?? []}
             runtimeId={activeId}
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
     <LiquidDefs />
     <CapsuleMorphLayer />
     <WindowControls platform={boot.platform} onError={onError} />
     {search && (
       <SearchDialog
         onClose={() => setSearch(false)}
         onSelect={session => { void viewSession(session.path,session.cwd).catch(onError); }}
         onNew={() => { void newSession().catch(onError); }}
         onSettings={() => setSettings(true)}
       />
     )}
     {rename && (
       <RenameDialog
         session={rename}
         onClose={() => setRename(null)}
         onSave={async name => {
           const record=rename.runtimeId?runtimes.getSnapshot()[rename.runtimeId]:undefined;
           if(!record||record.closed)throw new Error(t('omp.history.ownedBranchOnly'));
           await runtimes.command(record.runtimeId, { type: 'set_session_name', name });
           await refreshHistory();
         }}
       />
     )}
     {treeSession && <HistoryTreeDialog key={treeSession.path} session={treeSession} onClose={()=>setTreeSession(null)} onView={leafId=>viewSession(treeSession.path,treeSession.cwd,leafId)} onFork={async()=>{try{await forkSession(treeSession);}catch(error){await refreshAccess();throw error;}}} onOwnedBranch={treeSession.runtimeId&&!records[treeSession.runtimeId]?.closed?()=>beginBranch(treeSession):undefined}/>}
     {branch && (
       <BranchDialog
         messages={branch.messages}
         onClose={() => setBranch(null)}
         onBranch={async entryId => {
           const result = await runtimes.command<{ cancelled: boolean; text: string }>(branch.runtimeId, { type: 'branch', entryId });
           if (result.cancelled) throw new Error(t('omp.shell.branchCancelled'));
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
     {prompt && (
       <>
         <ExtensionDialog
           key={`${prompt.runtimeId}:${prompt.request.id}`}
           request={prompt.request}
           originLabel={[records[prompt.runtimeId] ? records[prompt.runtimeId].chat.state.sessionName || t('omp.shell.newSession') : t('omp.shell.startingRuntime'),records[prompt.runtimeId]?.cwd,records[prompt.runtimeId]?.chat.state.sessionId,prompt.runtimeId,t('omp.shell.pendingRequests',{count:prompts.length})].filter(Boolean).join(' · ')}
           onRespond={response => runtimes.respond(prompt.runtimeId, response)}
         />
       </>
     )}
     <ToastHost toasts={toasts.filter(item=>!item.error||item.message!==surfacedError)} onDismiss={dismissToast} onError={onError} />
   </div>
 );
}
