import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { HistoryListing, SessionSummary } from '../../shared/contracts';
import { IconClose, IconSearch, IconPencil, IconNewSession, IconSettings } from '../ui/icons';
import { Button, TooltipButton } from '../ui/ui';
import { errorText } from './runtime-store';
import { useGlassExit } from '../lib/portal-visibility';

export function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const { t } = useTranslation();
  const ref=useRef<HTMLDivElement>(null);
  useGlassExit(ref, true, true);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null; ref.current?.querySelector<HTMLElement>('input,button')?.focus(); return ()=>{if(previous?.isConnected)previous.focus();};},[]);
  return createPortal(
    <div className="overlay session-rename-dialog-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
      <div ref={ref} className="dialog session-rename-dialog lg-thick lg-refract lg-sheet lg-sheet-in" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event=>{
        if(event.nativeEvent.isComposing)return;
        if(event.key==='Escape'){event.stopPropagation();onClose();}
        if(event.key==='Tab'){
          const all=ref.current?.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled]),textarea:not([disabled])');
          if(!all?.length)return;const first=all[0],last=all[all.length-1];
          if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
          else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
        }
      }}>
        <div className="session-rename-dialog-head"><h2 className="session-rename-dialog-title"><IconPencil size={16}/>{title}</h2><TooltipButton className="session-rename-dialog-close" tooltip={t('common.close')} ariaLabel={t('common.close')} onClick={onClose}><IconClose size={16}/></TooltipButton></div>
        {children}
      </div>
    </div>,document.body
  );
}
export function RenameDialog({session,onClose,onSave}:{session:SessionSummary;onClose:()=>void;onSave:(name:string)=>Promise<void>}) {
  const { t } = useTranslation();
  const [draft,setDraft]=useState(session.title),[saving,setSaving]=useState(false),[error,setError]=useState('');
  return (
    <Modal title={t('session.renameTitle')} onClose={()=>{if(!saving)onClose();}}>
      <p className="session-rename-dialog-description">{t('omp.shell.renameDescription')}</p>
      <form onSubmit={event=>{event.preventDefault();if(!draft.trim()||saving)return;setSaving(true);void onSave(draft.trim()).then(onClose).catch(error=>setError(errorText(error))).finally(()=>setSaving(false));}}>
        <label className="session-rename-dialog-label" htmlFor="session-rename-input">{t('session.renameLabel')}</label>
        <input id="session-rename-input" className="field-input" value={draft} onChange={event=>setDraft(event.target.value)} disabled={saving} autoFocus/>
        {error&&<p role="alert" className="omp-inline-error">{error}</p>}
        <div className="session-rename-dialog-actions">
          <Button variant="ghost" type="button" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving||!draft.trim()}>{t(saving?'common.saving':'common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}
export function BranchDialog({messages,onClose,onBranch}:{messages:{entryId:string;text:string}[];onClose:()=>void;onBranch:(entryId:string)=>Promise<void>}) {
  const { t } = useTranslation();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return (
    <Modal title={t('omp.shell.branchTitle')} onClose={()=>{if(!busy)onClose();}}>
      <p className="session-rename-dialog-description">{t('omp.shell.branchDescription')}</p>
      <div className="omp-branch-messages">{messages.length===0?<p>{t('omp.shell.noBranchPoints')}</p>:messages.map(message=>(
        <button className="search-item" key={message.entryId} disabled={busy} onClick={()=>{setBusy(true);void onBranch(message.entryId).then(onClose).catch(error=>setError(errorText(error))).finally(()=>setBusy(false));}}><span className="search-item-title">{message.text||message.entryId}</span></button>
      ))}</div>
      {error&&<p role="alert" className="omp-inline-error">{error}</p>}
    </Modal>
  );
}
export function SearchDialog({onClose,onSelect,onNew,onSettings}:{onClose:()=>void;onSelect:(session:SessionSummary)=>void;onNew:()=>void;onSettings:()=>void}) {
  const { t } = useTranslation();
  const [query,setQuery]=useState(''),[active,setActive]=useState<number|null>(null),[revision,setRevision]=useState(0);
  const [result,setResult]=useState<{query:string;revision:number;listing:HistoryListing;error:string}|null>(null);
  const ref=useRef<HTMLDivElement>(null),inputRef=useRef<HTMLInputElement>(null);
  useGlassExit(ref, true, true);
  const composing=useRef(false),compositionEndTimer=useRef<number|undefined>(undefined);
  const loading=!result||result.query!==query||result.revision!==revision;
  const sessions=loading?[]:result.listing.sessions;
  const diagnostics=loading?[]:result.listing.diagnostics;
  const error=loading?'':result.error;
  const defaultActive=loading||error||!sessions.length?null:query.trim()?2:0;
  useEffect(()=>{
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    inputRef.current?.focus();
    return()=>{window.clearTimeout(compositionEndTimer.current);if(previous?.isConnected)previous.focus();};
  },[]);
  useEffect(()=>{
    let cancelled=false;
    const timer=window.setTimeout(()=>{
      void window.ompDesktop.listHistory({query}).then(listing=>{
        if(cancelled)return;
        setResult({query,revision,listing,error:''});
        if(document.activeElement===inputRef.current)setActive(listing.sessions.length?(query.trim()?2:0):null);
      }).catch(cause=>{
        if(cancelled)return;
        setResult({query,revision,listing:{sessions:[],diagnostics:[]},error:errorText(cause)});
        if(document.activeElement===inputRef.current)setActive(null);
      });
    },100);
    return()=>{cancelled=true;window.clearTimeout(timer);};
  },[query,revision]);
  useEffect(()=>{ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[active,loading]);
  const actions=[{key:'new',title:t('omp.shell.newSession'),meta:'',run:onNew,icon:<IconNewSession size={15}/>},{key:'settings',title:t('nav.settings'),meta:t('omp.shell.settingsMeta'),run:onSettings,icon:<IconSettings size={15}/>},...sessions.map(session=>({key:session.path,title:session.title,meta:session.cwd,run:()=>onSelect(session),icon:<IconSearch size={15}/>}))];
  const activate=(index:number)=>{const action=actions[index];if(!action||composing.current)return;action.run();onClose();};
  return createPortal(
    <div className="search-overlay" onClick={onClose}>
      <div ref={ref} className="search-dialog lg-thick lg-refract lg-sheet lg-sheet-in" role="dialog" aria-modal="true" aria-label={t('omp.shell.searchHistory')} onClick={event=>event.stopPropagation()} onCompositionStart={()=>{window.clearTimeout(compositionEndTimer.current);composing.current=true;}} onCompositionEnd={()=>{compositionEndTimer.current=window.setTimeout(()=>{composing.current=false;},0);}} onKeyDown={event=>{
        if(composing.current||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229){if(event.key==='Enter')event.preventDefault();return;}
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){
          event.preventDefault();
          const next=active===null?(event.key==='ArrowDown'?0:actions.length-1):Math.max(0,Math.min(actions.length-1,active+(event.key==='ArrowDown'?1:-1)));
          ref.current?.querySelector<HTMLElement>(`#global-search-option-${next}`)?.focus();
        }
        if(event.key==='Enter'&&event.target===inputRef.current){
          event.preventDefault();
          if(!loading&&!error&&sessions.length>0&&active!==null&&(!query.trim()||active>=2))activate(active);
        }
        if(event.key==='Tab'){
          const all=ref.current?.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled])');if(!all?.length)return;const first=all[0],last=all[all.length-1];
          if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
          else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
        }
      }}>
        <div className="search-input-row"><IconSearch size={16}/><input ref={inputRef} className="search-input" role="combobox" aria-expanded="true" aria-controls="global-search-results" aria-activedescendant={active===null?undefined:`global-search-option-${active}`} aria-label={t('omp.shell.searchHistory')} placeholder={t('omp.shell.searchPlaceholder')} value={query} maxLength={500} onFocus={()=>setActive(defaultActive)} onChange={event=>{setQuery(event.target.value);setActive(null);}}/></div>
        <div id="global-search-results" className="search-results" role="listbox" aria-busy={loading}>
          {actions.map((action,index)=><button key={action.key} type="button" id={`global-search-option-${index}`} className={`search-item ${active===index?'active':''}`} role="option" aria-selected={active===index} onFocus={()=>setActive(index)} onClick={()=>activate(index)}><span className="search-item-icon">{action.icon}</span><span className="search-item-title">{action.title}</span><span className="search-item-meta">{action.meta}</span></button>)}
          {loading&&<div className="search-empty" role="status">{t('omp.shell.searchingHistory')}</div>}
          {error&&<div className="search-empty" role="alert">{error}<Button onFocus={()=>setActive(null)} onClick={()=>{setRevision(value=>value+1);setActive(null);inputRef.current?.focus();}}>{t('omp.shell.retry')}</Button></div>}
          {diagnostics.map((diagnostic,index)=><div className="search-empty" role="status" key={`${diagnostic.path}:${diagnostic.kind}:${index}`}>{diagnostic.path}: {diagnostic.message}</div>)}
          {!loading&&!error&&!sessions.length&&<div className="search-empty" role="status">{t('omp.shell.noHistoryMatches')}</div>}
        </div>
      </div>
    </div>,document.body
  );
}
