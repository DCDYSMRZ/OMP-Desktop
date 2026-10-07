import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionRemovalResult, SessionSummary } from '../../shared/contracts';
import { IconClose } from '../ui/icons';
import { Button, TooltipButton, useModalFocus, portalOverlay, useOverlayLeaving } from '../ui/ui';
import type { SidebarSession } from './sidebar-session';
import { errorText } from './runtime-store';
import { useSurfaceMotion } from '../ui/motion';
import { UserErrorNotice } from '../lib/UserErrorNotice';
import { preserveUserError } from '../lib/user-errors';

export function Modal({title,onClose,children,initialFocus,busy=false,dismissOnBackdrop=true,className=''}:{title:string;onClose:()=>void;children:ReactNode;initialFocus?:RefObject<HTMLElement|null>;busy?:boolean;dismissOnBackdrop?:boolean;className?:string}) {
  const { t } = useTranslation();
  const leaving = useOverlayLeaving();
  const ref=useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useSurfaceMotion(ref, !leaving, 'scale');
  useSurfaceMotion(backdrop, !leaving);
  useModalFocus(ref,{onClose,initialFocus});
  return portalOverlay(
    <div className={`overlay motion-managed motion-dialog-overlay session-rename-dialog-overlay${leaving ? ' is-leaving' : ''}`} onMouseDown={event=>{if(!leaving&&dismissOnBackdrop&&event.target===event.currentTarget)onClose();}}>
      <div ref={backdrop} className="motion-dialog-backdrop" aria-hidden />
      <div ref={ref} className={`dialog motion-managed session-rename-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy}>
        <div className="session-rename-dialog-head"><h2 className="session-rename-dialog-title">{title}</h2><TooltipButton className="session-rename-dialog-close" tooltip={t('common.close')} ariaLabel={t('common.close')} disabled={busy} onClick={onClose}><IconClose size="var(--icon-ui)"/></TooltipButton></div>
        {children}
      </div>
    </div>
  );
}
export function RenameDialog({session,onClose,onSave}:{session:SessionSummary;onClose:()=>void;onSave:(name:string)=>Promise<void>}) {
  const { t } = useTranslation();
  const [draft,setDraft]=useState(session.title),[saving,setSaving]=useState(false),[error,setError]=useState<Error|string>('');
  const input = useRef<HTMLInputElement>(null);
  return (
    <Modal title={t('sidebar.renameSession')} initialFocus={input} busy={saving} onClose={()=>{if(!saving)onClose();}}>
      <p className="session-rename-dialog-description">{t('omp.shell.renameDescription')}</p>
      <form onSubmit={event=>{event.preventDefault();if(!draft.trim()||saving)return;setSaving(true);void onSave(draft.trim()).then(onClose).catch(cause=>setError(preserveUserError(cause))).finally(()=>setSaving(false));}}>
        <label className="session-rename-dialog-label" htmlFor="session-rename-input">{t('sidebar.renameLabel')}</label>
        <input ref={input} id="session-rename-input" className="field-input" value={draft} onChange={event=>setDraft(event.target.value)} disabled={saving}/>
        {error&&<UserErrorNotice error={error}/>}
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
  const [busy,setBusy]=useState(false),[error,setError]=useState<Error|string>('');
  return (
    <Modal title={t('omp.shell.branchTitle')} onClose={()=>{if(!busy)onClose();}}>
      <p className="session-rename-dialog-description">{t('omp.shell.branchDescription')}</p>
      <div className="omp-branch-messages">{messages.length===0?<p>{t('omp.shell.noBranchPoints')}</p>:messages.map(message=>(
        <button className="search-item" key={message.entryId} disabled={busy} onClick={()=>{setBusy(true);void onBranch(message.entryId).then(onClose).catch(cause=>setError(preserveUserError(cause))).finally(()=>setBusy(false));}}><span className="search-item-title">{message.text||message.entryId}</span></button>
      ))}</div>
      {error&&<UserErrorNotice error={error}/>}
    </Modal>
  );
}
export function RemoveSessionDialog({session,onClose,onRemove}:{session:SidebarSession;onClose:()=>void;onRemove:(allowUncertain?:boolean)=>Promise<SessionRemovalResult>}) {
  const { t } = useTranslation();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<SessionRemovalResult|null>(null);
  const dismiss=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(result&&!busy)dismiss.current?.focus();},[result,busy]);
  const discard=session.source?.status==='unpersisted';
  const presentResult=(value:SessionRemovalResult)=>{if(value.disposition==='partial'||value.disposition==='retained')setResult(value);};
  const retained=result?[...new Map(result.retained.map(item=>[item.path,item])).values()]:[];
  return <Modal className="omp-removal-dialog" title={t(result?result.sourceRemoved?'omp.removal.resultTitle':'omp.removal.notRemovedTitle':discard?'omp.removal.discard':'omp.removal.confirmTitle',{title:session.title})} initialFocus={dismiss} busy={busy} dismissOnBackdrop={!result} onClose={()=>{if(!busy)onClose();}}>
    <div className="omp-removal-body">
      {result ? <>
        {!result.sourceRemoved&&<p role="status">{t('omp.removal.retained')}</p>}
        {retained.map(item=><section key={item.path}><p>{t('omp.removal.itemRetained',{item:t(`omp.removal.item.${item.kind??'associated'}`),reason:t(`omp.removal.reason.${item.reasonCode??'unverified'}`)})}</p><Button variant="ghost" onClick={()=>{void window.ompDesktop.revealFile(session.cwd,item.path).catch(cause=>setError(errorText(cause)));}}>{t('objects.reveal')}</Button></section>)}
        {result.occupancy&&<p role="alert">{t(result.occupancy.status==='external'?'omp.removal.external':'omp.removal.uncertain')}</p>}
        {result.trashed.length>0&&<p className="session-rename-dialog-description">{t('omp.removal.recovery')}</p>}
        <details className="omp-removal-details">
          <summary>{t('omp.removal.resultDetails')}</summary>
          <div className="omp-removal-details-content" role="region" aria-label={t('omp.removal.resultDetails')} tabIndex={0}>
        {(result.errors.length>0||result.warnings.length>0)&&<p role="alert">{t('omp.removal.issueCounts',{errors:result.errors.length,warnings:result.warnings.length})}</p>}
            <p>{t('omp.removal.sessionIdentity')}: <code>{result.sessionId}</code></p>
            {result.sourcePath&&<p>{t('omp.shell.sourcePath')}: <code>{result.sourcePath}</code></p>}
            {result.trashed.length>0&&<section><h3>{t('omp.removal.movedItems')}</h3><ul>{result.trashed.map((path,index)=><li key={`${index}:${path}`}><code>{path}</code></li>)}</ul></section>}
            {result.retained.length>0&&<section><h3>{t('omp.removal.retainedItems')}</h3><dl>{result.retained.map((item,index)=><div key={`${index}:${item.path}`}><dt><code>{item.path}</code></dt><dd>{item.reason}</dd></div>)}</dl></section>}
            {result.errors.length>0&&<section><h3>{t('omp.removal.errors')}</h3><ul>{result.errors.map((message,index)=><li key={index}>{message}</li>)}</ul></section>}
            {result.warnings.length>0&&<section><h3>{t('omp.removal.warnings')}</h3><ul>{result.warnings.map((message,index)=><li key={index}>{message}</li>)}</ul></section>}
            {result.occupancy&&<p>{result.occupancy.reason}</p>}
            {error&&<p>{error}</p>}
            {result.affectedRuntimeIds.length>0&&<section><h3>{t('omp.removal.affectedConnections')}</h3><ul>{result.affectedRuntimeIds.map(id=><li key={id}><code>{id}</code></li>)}</ul></section>}
          </div>
        </details>
      </> : <>
        <p className="session-rename-dialog-description">{t(discard?'omp.removal.discardDescription':'omp.removal.trashDescription')}</p>
        <details className="omp-removal-details"><summary>{t('omp.removal.resultDetails')}</summary><div className="omp-removal-details-content">
          <p>{t('omp.shell.sourcePath')}: {session.source?.path??(session.runtimeId?t('omp.composer.accessState.unpersisted'):session.path)}</p>
          <p>{t('omp.settings.workspace')}: {session.cwd}</p>
          <p>{t('omp.removal.retention')}</p>
        </div></details>
        {session.runtimeId&&!session.closed&&<p>{t('omp.removal.stopWork')}</p>}
        <p>{t('omp.removal.scope')}</p>
        {error&&<><p role="alert" className="omp-inline-error">{t('omp.removal.requestFailed')}</p><details className="omp-removal-details"><summary>{t('omp.removal.resultDetails')}</summary><div className="omp-removal-details-content" role="region" aria-label={t('omp.removal.resultDetails')} tabIndex={0}><p>{error}</p></div></details></>}
      </>}
    </div>
    {result&&error&&<p role="alert" className="omp-inline-error">{t('objects.failed')}</p>}
    <div className="session-rename-dialog-actions">
      <Button ref={dismiss} variant="ghost" type="button" disabled={busy} onClick={onClose}>{t(result?'common.close':'common.cancel')}</Button>
      {result?.occupancy?.status==='unknown'&&!result.sourceRemoved&&<Button disabled={busy} onClick={()=>{if(busy)return;setBusy(true);void onRemove(true).then(presentResult).catch(cause=>setError(errorText(cause))).finally(()=>setBusy(false));}}>{t(busy?'omp.removal.busy':'omp.removal.confirmUncertain')}</Button>}
      {!result&&<Button disabled={busy} onClick={()=>{if(busy)return;setBusy(true);setError('');void onRemove().then(presentResult).catch(cause=>setError(errorText(cause))).finally(()=>setBusy(false));}}>{t(busy?'omp.removal.busy':discard?'omp.removal.confirmDiscard':'omp.removal.confirmTrash')}</Button>}
    </div>
  </Modal>;
}
