import { useContext, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsDestination } from '../app/settings-destination';
import { IconChevronRight } from '../ui/icons';
import { Button } from '../ui/ui';
import { Collapse } from '../ui/Collapse';
import { DisclosureAnchor, DisclosureScope, useAutomaticDisclosure } from './disclosure';
import type { HomeReadiness } from './home-model';
import { NativeLoginCard } from './NativeLoginCard';
import '../styles/home.css';

export interface HomeContext {
  readiness: HomeReadiness; missingWorkspace?: string; connectionError?: string; connecting?: boolean; onRetryConnection: () => void; onCopy: (text: string) => Promise<void>;
  onChooseWorkspace: () => void; onChooseExecutable: () => void; onRemoveWorkspace: () => void; onSettings: (destination: SettingsDestination) => void;
}
export function HomePanel({ cwd, context }: { cwd: string; context: HomeContext }) {
  const { t } = useTranslation();
  const workspace = cwd.split(/[/\\]/).filter(Boolean).at(-1);
  return <div className="home-panel">
    <header className="home-intro"><h1>{workspace ? <>{t('composer.homeBefore')}<button type="button" className="home-workspace" title={cwd} onClick={context.onChooseWorkspace}>{workspace}</button>{t('composer.homeAfter')}</> : t('home.titleUnchosen')}</h1></header>
    {context.missingWorkspace ? <section className="home-readiness" role="alert"><p>{t('composer.workspaceMissing', { path: context.missingWorkspace })}</p><button onClick={context.onChooseWorkspace}>{t('composer.chooseOther')}</button><button onClick={context.onRemoveWorkspace}>{t('composer.removeWorkspace')}</button></section> : context.readiness.missing.includes('model') ? <NativeLoginCard details={context.connectionError} checking={!!context.connecting} onRecheck={context.onRetryConnection}/> : !context.readiness.complete && <section className="home-readiness"><h2>{t('composer.setupHeading')}</h2><ol>{context.readiness.missing.map((step, index) => <li key={step}><span className="home-step-mark">{index + 1}</span><span>{t(`composer.setup.${step}`)}</span><button type="button" onClick={step === 'workspace' ? context.onChooseWorkspace : context.onChooseExecutable}>{t(`composer.setupAction.${step}`)}</button></li>)}</ol></section>}
    {context.connectionError && context.readiness.complete && !context.missingWorkspace && <StartupRecovery kind="connection" details={context.connectionError} busy={context.connecting} onPrimary={context.onRetryConnection} onCopy={context.onCopy}/>}
  </div>;
}
export function HomeSuggestions({ cwd, onPrompt }: { cwd: string; onPrompt: (text: string) => void }) {
  const { t } = useTranslation();
  const workspace = cwd.split(/[/\\]/).filter(Boolean).at(-1) || t('home.project');
  return <div className="home-prompt-chips">{['read', 'fix', 'review'].map(kind => <button type="button" key={kind} onClick={() => onPrompt(t(`home.prompt.${kind}`, { workspace }))}>{t(`home.example.${kind}`)}</button>)}</div>;
}

export function StartupRecovery({ kind, details, busy, onPrimary, onCopy }: { kind: 'installation' | 'connection' | 'bootstrap'; details: string; busy?: boolean; onPrimary: () => void; onCopy: (text: string) => Promise<void> }) {
  const { t } = useTranslation();
  const disclosure = useAutomaticDisclosure(false, `startup:${kind}`);
  const anchor = useContext(DisclosureAnchor);
  const id = useId();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const prefix = kind === 'installation' ? 'install' : kind;
  return <section className="home-recovery no-drag" aria-label={t(`home.recovery.${kind}`)}>
    <p className="home-recovery-lead" role="alert">{t(`home.recovery.${kind}`)}</p>
    <Button variant="primary" disabled={busy} onClick={onPrimary}>{t(`home.recovery.${kind === 'installation' ? 'choose' : kind === 'bootstrap' ? 'initialize' : 'retry'}`)}</Button>
    <ol>{[1, 2, 3].map(step => <li key={step}>{t(`home.recovery.${prefix}Step${step}`)}</li>)}</ol>
    <DisclosureScope disclosure={disclosure}><button type="button" className="home-details-toggle" ref={disclosure.titleRef} aria-expanded={disclosure.open} aria-controls={id} onClick={() => { anchor(disclosure.titleRef.current); disclosure.toggle(); }}><IconChevronRight size="var(--icon-meta)"/>{t('home.details')}</button><Collapse open={disclosure.open} id={id} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}><div className="home-recovery-details"><pre>{details}</pre><Button onClick={() => { setCopyError(''); void onCopy(details).then(() => setCopied(true), cause => setCopyError(String(cause))); }}>{t(copied ? 'home.copied' : 'home.copy')}</Button>{copyError && <p role="alert">{copyError}</p>}</div></Collapse></DisclosureScope>
  </section>;
}
