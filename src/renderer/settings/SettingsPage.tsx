import { UserFacingError, preserveUserError } from '../lib/user-errors';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { formatElapsed } from '../lib/format-duration';
import type { DesktopPreferences, DesktopDiagnostics, NativeModel, RuntimeInfo, PresenceSettingsStatus } from '../../shared/contracts';
import type { SettingsRequest } from '../app/settings-destination';
import { PortalVisibilityProvider } from '../lib/portal-visibility';
import { Button, Input, SettingsToggle, cx } from '../ui/ui';
import { SettingsCard, SettingsRow } from '../ui/SettingsPrimitives';
import { SettingsMenuSelect } from '../ui/SettingsMenuSelect';
import { IconChevronLeft, IconKey, IconPalette, IconSearch, IconSettings, IconSliders, IconTerminal } from '../ui/icons';
import { NativeSettings } from './NativeSettings';
import { highlightSetting, indexDesktopSettings, searchSettings, type SettingSearchRow, type SettingsCategory } from './settings-model';
import './settings-native.css';
import { SettingsError } from './SettingsError';
import { NativeLoginCard } from '../chat/NativeLoginCard';

export interface SettingsPageProps {
  active: boolean;
  destination?: SettingsRequest;
  initialQuery?: string;
  preferences: DesktopPreferences; workspace: string; runtimeInfo: RuntimeInfo; models: NativeModel[]; runtimeId: string | null;
  thinkingLevels?: string[];
  loginRecovery: { details: string; checking: boolean; onRecheck: () => void };
  onPreferencesChange: (patch: Partial<DesktopPreferences>) => Promise<void>; onClose: () => void;
  onNativeLogin: (runtimeId: string, providerId: string) => Promise<void>;
}
type Tab = SettingsCategory;

export function SettingsPage({ active, destination, initialQuery = '', preferences, workspace, runtimeInfo, models, thinkingLevels = [], runtimeId, onNativeLogin, loginRecovery, onPreferencesChange, onClose }: SettingsPageProps) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<Tab>('desktop');
  useEffect(() => {
    if (!destination) return;
    const tabs: Record<SettingsRequest['destination'], Tab> = { appearance: 'desktop', runtime: 'runtime', models: 'common', advanced: 'advanced', credentials: 'credentials' };
    setTab(tabs[destination.destination]);
    setQuery(initialQuery);
  }, [destination, initialQuery]);
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => { setQuery(initialQuery); }, [initialQuery]);
  const [nativeIndex, setNativeIndex] = useState<SettingSearchRow[]>([]);
  const [target, setTarget] = useState<{ key: string; sequence: number } | null>(null);
  const [fonts, setFonts] = useState<string[]>([]);
  const [fontFallback, setFontFallback] = useState(false);
  useEffect(() => {
    const candidates = ['PingFang SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'Noto Sans CJK SC', 'LXGW WenKai', 'Inter', 'SF Pro Text', 'Helvetica Neue', 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Menlo'];
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    const sample = 'mmmmmmmmmmWWWWiiii你好世界';
    const fallbacks = ['monospace', 'serif', 'sans-serif'];
    const widths = fallbacks.map(fallback => { context.font = `72px ${fallback}`; return context.measureText(sample).width; });
    setFonts(candidates.filter(name => document.fonts.check(`12px "${name}"`) && fallbacks.some((fallback, index) => { context.font = `72px "${name}", ${fallback}`; return context.measureText(sample).width !== widths[index]; })));
  }, []);
  const [error, setError] = useState<Error | string>('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [runtime, setRuntime] = useState(runtimeInfo);
  const [presence, setPresence] = useState<PresenceSettingsStatus>();
  const [diagnostics, setDiagnostics] = useState<DesktopDiagnostics>();
  useEffect(() => {
    if (!active || tab !== 'about') return;
    let current = true;
    void window.ompDesktop.getDesktopDiagnostics().then(value => { if (current) setDiagnostics(value); }).catch(reason => { if (current) setError(preserveUserError(reason)); });
    return () => { current = false; };
  }, [active, tab, preferences.executablePath, preferences.terminalPresence]);
  useEffect(() => {
    if (!active || tab !== 'presence') return;
    let current = true;
    const refresh = () => { void window.ompDesktop.getPresenceSettings().then(value => { if (current) setPresence(value); }).catch(reason => { if (current) setError(preserveUserError(reason)); }); };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { current = false; window.clearInterval(timer); };
  }, [active, tab, preferences.terminalPresence, preferences.profile, preferences.lastWorkspace]);
  const [executable, setExecutable] = useState(preferences.executablePath);
  const [profile, setProfile] = useState(preferences.profile);
  const [font, setFont] = useState(preferences.fontFamily);
  const [fontSize, setFontSize] = useState(String(preferences.fontSize));
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setRuntime(runtimeInfo); }, [runtimeInfo]);
  useEffect(() => { setExecutable(preferences.executablePath); setProfile(preferences.profile); }, [preferences.executablePath, preferences.profile]);
  useEffect(() => { setFont(preferences.fontFamily); setFontSize(String(preferences.fontSize)); }, [preferences.fontFamily, preferences.fontSize]);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [tab]);
  useEffect(() => {
    if (!target || query.trim()) return;
    const frame = requestAnimationFrame(() => { const node = document.getElementById(`setting-${target.key}`); if (!node) return; node.scrollIntoView({ block: 'center', behavior: 'instant' }); node.focus({ preventScroll: true }); node.classList.remove('ui-flash'); void node.offsetWidth; node.classList.add('ui-flash'); });
    return () => cancelAnimationFrame(frame);
  }, [target, query, nativeIndex]);
  async function scanFonts() {
    const local = window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> };
    try { if (!local.queryLocalFonts) { setFontFallback(true); return; } const installed = await local.queryLocalFonts(); setFonts([...new Set(installed.map(item => item.family))].sort()); setFontFallback(false); } catch { setFontFallback(true); }
  }
  async function action(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (reason) { setError(preserveUserError(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function save(patch: Partial<DesktopPreferences>) {
    await action(async () => { await onPreferencesChange(patch); setNotice('omp.settings.desktopPreferenceSaved'); });
  }
  const nav = [
    { id: 'desktop' as const, label: t('omp.settings.appearanceInput'), icon: <IconPalette size="var(--icon-meta)" /> },
    { id: 'presence' as const, label: t('settings.notificationsPresence'), icon: <IconSettings size="var(--icon-meta)" /> },
    { id: 'runtime' as const, label: t('omp.settings.localRuntime'), icon: <IconTerminal size="var(--icon-meta)" /> },
    { id: 'common' as const, label: t('settings.common'), icon: <IconSettings size="var(--icon-meta)" /> },
    { id: 'credentials' as const, label: t('settings.providers'), icon: <IconKey size="var(--icon-meta)" /> },
    { id: 'advanced' as const, label: t('settings.advanced'), icon: <IconSliders size="var(--icon-meta)" /> },
    { id: 'about' as const, label: t('settings.about'), icon: <IconSettings size="var(--icon-meta)" /> },
  ];
  const q = query.trim().toLocaleLowerCase();
  const results = searchSettings([...indexDesktopSettings(key => t(key)), ...nativeIndex], query);
  const showDesktop = !q && tab === 'desktop';
  const showRuntime = !q && tab === 'runtime';
  const showNative = !q && ['common', 'advanced', 'credentials'].includes(tab);
  const highlight = (text: string) => highlightSetting(text, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text);
  const categoryTransition = useRef<ViewTransition | null>(null);
  useEffect(() => () => categoryTransition.current?.skipTransition(), []);
  const changeCategory = (next: Tab, key?: string) => {
    categoryTransition.current?.skipTransition();
    categoryTransition.current = document.startViewTransition(() => flushSync(() => {
      setTab(next); setQuery('');
      if (key) setTarget(previous => ({ key, sequence: (previous?.sequence ?? 0) + 1 }));
      contentRef.current?.scrollTo({ top: 0 });
    }));
  };
  return <div className="settings-shell settings-shell-full">
    <div className="settings-titlebar" aria-hidden="true" />
    <aside className="settings-nav sidebar-surface" aria-label={t('omp.settings.settings')}>
      <div className="settings-nav-top drag"><div className="settings-search-wrap no-drag">
        <IconSearch size="var(--icon-meta)" /><input className="settings-search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('omp.settings.searchSettings')} aria-label={t('omp.settings.searchSettings')} spellCheck={false} autoCorrect="off" autoCapitalize="off" />
      </div></div>
      <div className="settings-nav-scroll no-drag">
        {[{ label: t('omp.settings.desktop'), items: nav.slice(0, 3) }, { label: 'omp', items: nav.slice(3, 6) }, { label: '', items: nav.slice(6) }].map(group => <div className="settings-nav-group" key={group.label}>
          <div className="settings-nav-group-label">{group.label}</div>
          {group.items.map(item => <button type="button" key={item.id} className={cx('settings-nav-item', !q && tab === item.id && 'active')} aria-current={!q && tab === item.id ? 'page' : undefined} onClick={() => changeCategory(item.id)}>
            <span className="settings-nav-icon">{item.icon}</span><span className="settings-nav-label">{item.label}</span>
          </button>)}
        </div>)}
      </div>
      <div className="settings-nav-footer no-drag"><button type="button" className="settings-back no-drag" data-nav="back-to-app" onClick={onClose}><IconChevronLeft size="var(--icon-ui)" /><span>{t('omp.settings.backToApp')}</span></button></div>
    </aside>
    <div className="settings-content" ref={contentRef}><div className="settings-content-inner"><div className="settings-content-enter">
      <h1 className="settings-section-title">{q ? t('omp.settings.searchSettings') : nav.find(item => item.id === tab)?.label}</h1>
      {error && <SettingsError error={error} />}
      {notice && <div className="native-settings-note" role="status">{t(notice)}</div>}
      {busy && <div className="native-settings-note" role="status">{t('omp.settings.applyingDesktopChange')}</div>}
      {q && <div className="settings-search-results">{results.length ? results.map(row => <button type="button" key={`${row.category}:${row.key}`} className="settings-search-result" onClick={() => changeCategory(row.category,row.key)}><span className="settings-result-breadcrumb">{nav.find(item => item.id === row.category)?.label} › {row.group}</span><strong>{highlight(row.label)}</strong><span>{row.nativeDescription && <>{t('settings.nativeDescription')} · </>}{highlight(row.help)}</span><code>{highlight(row.key)}</code></button>) : <p className="native-settings-empty" role="status">{t('settings.noResults')}</p>}</div>}
      {showDesktop && <div className="settings-stack">
        <p className="native-setting-muted">{t('settings.desktopHint')}</p>
        <SettingsCard title={t('omp.settings.appearance')}>
          <SettingsRow id="setting-language" title={t('omp.settings.language')}><SettingsMenuSelect label={t('omp.settings.language')} value={preferences.language} disabled={busy} options={[{ id: 'zh-CN', label: '简体中文' }, { id: 'en', label: 'English' }]} onChange={value => void save({ language: value as DesktopPreferences['language'] })} /></SettingsRow>
          <SettingsRow id="setting-fontFamily" title={t('omp.settings.fontFamily')} description={t('omp.settings.useAFontInstalledOnThisComputerOrA')}><form className="native-setting-form" onSubmit={event => { event.preventDefault(); void save({ fontFamily: font }); }}>
            <SettingsMenuSelect label={t('settings.installedFonts')} value={font} fullWidth options={[{ id: '', label: t('settings.systemFont') }, ...fonts.map(name => ({ id: name, label: name })), ...(!fonts.includes(font) && font ? [{ id: font, label: font }] : [])]} onChange={setFont} disabled={busy} />
            <Input aria-label={t('settings.customFont')} value={font} maxLength={200} disabled={busy} placeholder={t('settings.customFont')} onChange={event => setFont(event.target.value)} />
            <div className="native-setting-actions"><Button type="button" size="sm" onClick={() => void scanFonts()}>{t('settings.scanFonts')}</Button><Button size="sm" disabled={busy || font === preferences.fontFamily}>{t('omp.settings.save')}</Button></div>{fontFallback && <span className="native-setting-muted">{t('settings.fontFallback')}</span>}
          </form></SettingsRow>
          <SettingsRow id="setting-fontSize" title={t('omp.settings.fontSize')}><form className="native-setting-form" onSubmit={event => { event.preventDefault(); void action(async () => { const size = Number(fontSize); if (!fontSize.trim() || !Number.isInteger(size) || size < 10 || size > 32) throw new UserFacingError(t('omp.settings.enterAWholeNumberFontSizeFrom10To')); await onPreferencesChange({ fontSize: size }); setNotice('omp.settings.fontSizeSaved'); }); }}>
            <input aria-label={t('omp.settings.fontSize')} type="range" min={10} max={32} step={1} value={fontSize} disabled={busy} onChange={event => setFontSize(event.target.value)} />
            <div className="settings-size-presets">{[['compact', 13], ['standard', 15], ['comfortable', 17]].map(([name, size]) => <Button type="button" size="sm" key={name} aria-pressed={fontSize === String(size)} onClick={() => setFontSize(String(size))}>{t(`settings.${name}`)}</Button>)}</div>
            <div className="native-desktop-field"><Input aria-label={t('omp.settings.fontSize')} type="number" min={10} max={32} step={1} required value={fontSize} disabled={busy} onChange={event => setFontSize(event.target.value)} /><span>px</span><Button size="sm" disabled={busy || fontSize === String(preferences.fontSize)}>{t('omp.settings.save')}</Button></div>
          </form></SettingsRow>
          <SettingsRow id="setting-messageMeta" title={t('settings.messageMeta')} description={t('settings.messageMetaHelp')}><SettingsMenuSelect label={t('settings.messageMeta')} value={preferences.messageMeta} disabled={busy} options={['always','hover'].map(id=>({id,label:t(`settings.meta.${id}`)}))} onChange={value=>void save({messageMeta:value as DesktopPreferences['messageMeta']})}/></SettingsRow>
          <SettingsRow id="setting-durationStyle" title={t('settings.durationStyle')} description={t('settings.durationStyleHelp')}><SettingsMenuSelect label={t('settings.durationStyle')} value={preferences.durationStyle} disabled={busy} options={['units','clock'].map(id=>({id,label:t(`settings.duration.${id}`)}))} onChange={value=>void save({durationStyle:value as DesktopPreferences['durationStyle']})}/></SettingsRow>
        <section className="settings-preview" aria-label={t('settings.preview')}><h3>{t('settings.preview')}</h3><p className="native-setting-muted">{t('settings.previewHelp')}</p><div className="settings-preview-transcript" tabIndex={0} data-meta={preferences.messageMeta} style={{ fontFamily: font || 'system-ui', fontSize: `calc(var(--text-reading) * ${Math.max(10, Math.min(32, Number(fontSize) || preferences.fontSize)) / preferences.fontSize})` }}><div className="settings-preview-user">{t('settings.previewUser')}</div><div className="settings-preview-tool">{t('settings.previewTool')} · {formatElapsed(8859000,preferences.durationStyle,i18n.language)}</div><p>{t('settings.previewAnswer')}</p><code>const greeting = '你好, world';</code><small>{t('settings.previewMeta')} · 12:04 · Claude · 1.2K tokens · $0.01</small></div></section>
          <SettingsRow id="setting-preferredEditor" title={t('objects.preferredEditor')}><SettingsMenuSelect label={t('objects.preferredEditor')} value={preferences.preferredEditor} disabled={busy} options={[{id:'system',label:t('objects.systemEditor')},{id:'vscode',label:'Visual Studio Code'},{id:'cursor',label:'Cursor'},{id:'zed',label:'Zed'}]} onChange={value=>void save({preferredEditor:value as DesktopPreferences['preferredEditor']})}/></SettingsRow>
        </SettingsCard>
        <SettingsCard title={t('omp.settings.input')}><SettingsRow id="setting-enterToSend" title={t('omp.settings.enterToSend')} description={t('omp.settings.whenEnabledShiftEnterInsertsANewlineOtherwiseUse')}><SettingsToggle checked={preferences.enterToSend} label={t('omp.settings.enterToSend')} busy={busy} onChange={() => void save({ enterToSend: !preferences.enterToSend })} /></SettingsRow></SettingsCard>
      </div>}
      {!q && tab === 'presence' && <div className="settings-stack">
          <SettingsRow id="setting-notifications" title={t('shell.notifications')} description={t('shell.notificationsHint')}><SettingsToggle checked={preferences.notifications} label={t('shell.notifications')} busy={busy} onChange={() => void save({ notifications: !preferences.notifications })} /></SettingsRow>
        <SettingsCard title={t('settings.presenceTitle')}><SettingsRow id="setting-terminalPresence" title={t('settings.terminalPresence')} description={t('settings.terminalPresenceHelp')} detail={presence ? <><span>{presence.installedVersion ? t('settings.presenceVersion', { version: presence.installedVersion }) : t('settings.presenceNotInstalled')}</span><br /><span>{t('settings.presenceCounts', { participating: presence.participating, nonParticipating: presence.nonParticipating })}</span>{presence.error && <span role="alert" className="native-setting-error">{presence.error}</span>}</> : undefined}><SettingsToggle checked={preferences.terminalPresence} label={t('settings.terminalPresence')} busy={busy} onChange={() => void save({ terminalPresence: !preferences.terminalPresence })} /></SettingsRow></SettingsCard>
      </div>}
      {showRuntime && <div className="settings-stack">
        <p className="native-setting-muted">{t('settings.newSessions')}</p>
        <SettingsCard title={t('omp.settings.installedOmp')}>
          <SettingsRow id="setting-runtimeStatus" title={runtime.available ? t('settings.connected') : t('settings.unavailable')} detail={<><span>{runtime.version ?? 'omp'} · {preferences.profile || t('omp.settings.defaultProfile')}</span><code>{runtime.path ?? runtime.error}</code></>}><Button disabled={busy} onClick={() => void action(async () => { setRuntime(await window.ompDesktop.checkRuntime()); })}>{t('omp.settings.checkInstallation')}</Button></SettingsRow>
          <SettingsRow id="setting-executablePath" title={t('omp.settings.executablePath')} description={t('omp.settings.leaveBlankToDiscoverInstalledOmpBrowseSelectsA')}><form className="native-setting-form" onSubmit={event => { event.preventDefault(); void action(async () => { await onPreferencesChange({ executablePath: executable }); setRuntime(await window.ompDesktop.checkRuntime()); setNotice('omp.settings.executableSelectionSavedForNewSessions'); }); }}><Input aria-label={t('omp.settings.executablePath')} value={executable} disabled={busy} placeholder="omp" onChange={event => setExecutable(event.target.value)} /><div className="native-setting-actions"><Button type="button" size="sm" disabled={busy} onClick={() => void action(async () => { const path = await window.ompDesktop.chooseExecutable(); if (path) setExecutable(path); })}>{t('omp.settings.browse')}</Button><Button size="sm" disabled={busy}>{t('omp.settings.saveAndCheck')}</Button></div></form></SettingsRow>
          <SettingsRow id="setting-profile" title={t('omp.settings.nativeProfile')} description={t('omp.settings.exactNativeProfileNameBlankUsesOmpSDefault')}><form className="native-desktop-field" onSubmit={event => { event.preventDefault(); void save({ profile: profile.trim() }); }}><Input aria-label={t('omp.settings.nativeProfile')} value={profile} maxLength={64} disabled={busy} onChange={event => setProfile(event.target.value)} /><Button size="sm" disabled={busy || profile === preferences.profile}>{t('omp.settings.save')}</Button></form></SettingsRow>
          <SettingsRow id="setting-lastWorkspace" title={t('omp.settings.defaultWorkspace')} description={t('omp.settings.desktopPreferenceForSubsequentWorkspaceSelectionItDoesNot')} detail={preferences.lastWorkspace || t('omp.settings.notSelected')}><Button disabled={busy} onClick={() => void action(async () => { const path = await window.ompDesktop.chooseWorkspace(); if (path) { await onPreferencesChange({ lastWorkspace: path, recentWorkspaces: [path, ...preferences.recentWorkspaces.filter(item => item !== path)].slice(0, 40) }); setNotice('omp.settings.defaultWorkspaceSaved'); } })}>{t('omp.settings.chooseFolder')}</Button></SettingsRow>
        </SettingsCard>
      </div>}
      {!q && tab === 'about' && <div id="setting-about" tabIndex={-1} className="settings-stack">
        <SettingsRow title={t('settings.desktopVersion')} detail={diagnostics ? `OMP-Desktop ${diagnostics.desktopVersion} · Electron ${diagnostics.electron}` : 'OMP-Desktop'}>{null}</SettingsRow>
        <SettingsRow title="omp" detail={<><span>{diagnostics?.omp.version ?? runtime.version ?? t('omp.settings.notSet')}</span><code>{diagnostics?.omp.path ?? runtime.path}</code></>}>{null}</SettingsRow>
        <SettingsRow title={t('settings.presenceExtension')} detail={diagnostics?.presenceVersion ?? t('settings.presenceNotInstalled')}>{null}</SettingsRow>
        <div className="native-setting-actions"><Button disabled={busy} onClick={() => void action(() => window.ompDesktop.openLogsFolder())}>{t('settings.openLogs')}</Button><Button disabled={busy || !diagnostics} onClick={() => void action(async () => { await window.ompDesktop.copyText(JSON.stringify(diagnostics, null, 2)); setNotice('settings.copied'); })}>{t('settings.copyDiagnostics')}</Button></div>
        <details className="native-settings-legal"><summary>{t('settings.licenses')}</summary>OMP-Desktop · {t('omp.settings.uIAdaptedFrom')} PI-Desktop (vastsa / contributors), LGPL-3.0. {t('omp.settings.transportAdaptation')} pi-desktop, Copyright 2026 HighlandJewls, PikkonMG, FaqFirebase, Apache-2.0. {t('omp.settings.noWarrantyFullLicensesAndNoticesAreIncludedWith')}</details>
      </div>}
      <div hidden={!showNative}><PortalVisibilityProvider visible={showNative}>{tab === 'credentials' && !runtimeId ? <NativeLoginCard {...loginRecovery} active={active && showNative}/> : <NativeSettings key={`${workspace}\0${preferences.executablePath}\0${preferences.profile}`} workspace={workspace} models={models} thinkingLevels={thinkingLevels} runtimeId={runtimeId} onNativeLogin={onNativeLogin} onIndex={setNativeIndex} targetKey={target?.key} revealSequence={target?.sequence} section={tab === 'advanced' || tab === 'credentials' ? tab : 'common'} t={t} />}</PortalVisibilityProvider></div>
    </div></div></div>
  </div>;
}
