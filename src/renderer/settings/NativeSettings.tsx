import { UserFacingError, preserveUserError } from '../lib/user-errors';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConfigEntry, JsonValue, NativeModel, SettingsSnapshot, SettingsWriteResult } from '../../shared/contracts';
import { Button, Input, SettingsToggle } from '../ui/ui';
import { SettingsCard } from '../ui/SettingsPrimitives';
import { isCredential, NativeSettingRow, type SettingsText } from './NativeSettingRow';
import { SettingsError } from './SettingsError';

import { commonSettings, indexNativeSettings, providerGroup, receiptProvenance, settingGroup, type SettingProvenance, type SettingSearchRow } from './settings-model';
export function NativeSettings({ workspace, models, thinkingLevels, runtimeId, onNativeLogin, section, t, onIndex, targetKey, revealSequence }: {
  workspace: string; models: NativeModel[]; thinkingLevels: string[]; runtimeId: string | null;
  onIndex: (rows: SettingSearchRow[]) => void; targetKey?: string;
  revealSequence?: number;
  onNativeLogin: (runtimeId: string, providerId: string) => Promise<void>;
  section: 'common' | 'advanced' | 'credentials'; t: SettingsText;
}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [error, setError] = useState<Error | string>('');
  const [writeError, setWriteError] = useState<Error | string>('');
  const [writeNotice, setWriteNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [modified, setModified] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<Record<string, SettingProvenance>>({});
  const draftChanged = useCallback((key: string, changed: boolean) => setDirty(previous => { if (previous.has(key) === changed) return previous; const next = new Set(previous); if (changed) next.add(key); else next.delete(key); return next; }), []);
  const pending = useRef(false);
  const sequence = useRef(0);
  async function load() {
    const version = ++sequence.current;
    setLoading(true); setError('');
    try {
      const next = await window.ompDesktop.listSettings(workspace);
      if (version === sequence.current) { setSnapshot(next); setSources({}); }
    } catch (reason) { if (version === sequence.current) setError(preserveUserError(reason)); }
    finally { if (version === sequence.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [workspace]);
  async function write(key: string, value: JsonValue | undefined): Promise<SettingsWriteResult> {
    if (pending.current) throw new UserFacingError(t('omp.settings.waitForTheCurrentSaveToComplete'));
    pending.current = true; setWriting(true); setWriteError(''); setWriteNotice('');
    const label = indexed.find(row => row.key === key)?.label ?? key;
    try {
      const result = value === undefined
        ? await window.ompDesktop.resetSetting(workspace, key)
        : await window.ompDesktop.setSetting(workspace, key, value);
      setSnapshot(result.snapshot);
      setModified(previous => { const next = new Set(previous); if (value === undefined) next.delete(key); else next.add(key); return next; });
      setSources(previous => ({ ...previous, [key]: receiptProvenance(result, value === undefined) }));
      const message = result.overriddenBy
        ? t('omp.settings.savedGloballyEffectiveValueIsOverriddenBy') + result.overriddenBy
        : result.fallbackEnv
          ? t('omp.settings.savedBlankSavedValuesUseEnvironmentFallback') + result.fallbackEnv
          : value === undefined
            ? t('omp.settings.globalKeyRemovedEffectiveValuesHaveBeenReloadedProject')
            : t('omp.settings.savedEffectiveValuesHaveBeenReloaded');
      setWriteNotice(`${label}: ${message}`);
      return result;
    } catch (reason) {
      setWriteError(`${label}: ${reason instanceof Error ? reason.message : String(reason)}`);
      throw reason;
    } finally { pending.current = false; setWriting(false); }
  }
  const indexed = useMemo(() => indexNativeSettings(snapshot?.entries ?? [], key => t(key)), [snapshot, t]);
  useEffect(() => { onIndex(indexed); }, [indexed, onIndex]);
  useLayoutEffect(() => { if (!targetKey) return; setModifiedOnly(false); setExpanded(previous => new Set([...previous, settingGroup(targetKey)])); }, [targetKey, revealSequence]);
  const entries = snapshot?.entries ?? [];
  const common = entries.filter(entry => Object.hasOwn(commonSettings, entry.key) && !isCredential(entry));
  const credentials = entries.filter(isCredential);
  const groups = new Map<string, ConfigEntry[]>();
  for (const entry of entries) {
    if (Object.hasOwn(commonSettings, entry.key) || isCredential(entry) || (modifiedOnly && !modified.has(entry.key) && !dirty.has(entry.key))) continue;
    const group = settingGroup(entry.key);
    const list = groups.get(group) ?? []; list.push(entry); groups.set(group, list);
  }
  const show = (name: typeof section) => section === name;
  const row = (entry: ConfigEntry) => <NativeSettingRow key={entry.key} entry={entry} busy={writing || loading} models={models} thinkingLevels={thinkingLevels} provenance={sources[entry.key]} modified={modified.has(entry.key)} onDraftChange={draftChanged} t={t} onWrite={write} />;
  return <div className="settings-stack">
    <div className="native-settings-toolbar"><span className="native-setting-muted">{t('settings.newSessions')}</span>
      <Button size="sm" disabled={loading || writing} onClick={() => void load()}>{loading ? t('omp.settings.loading') : t('settings.reload')}</Button>
    </div>
    {error && <SettingsError error={error} />}
    {writeError && <SettingsError error={writeError} />}
    {writeNotice && <div className="native-settings-note" role="status">{writeNotice}</div>}
    {writing && <div role="status">{t('omp.settings.savingNativeSetting')}</div>}
    {loading && !snapshot && <div role="status">{t('omp.settings.readingInstalledOmpSettings')}</div>}
    {show('credentials') && <NativeAccounts key={runtimeId ?? 'disconnected'} runtimeId={runtimeId} models={models} onNativeLogin={onNativeLogin} t={t} />}
    {snapshot && <>
      <div hidden={!show('common')} className="settings-panel">{common.length ? common.map(row) : <p className="native-settings-empty">{t('omp.settings.noMatchingCommonKeysWereReturnedByThisOmp')}</p>}</div>
      <section className="native-advanced" hidden={!show('advanced')}><div className="settings-filter"><SettingsToggle checked={modifiedOnly} label={t('settings.modifiedOnly')} onChange={() => setModifiedOnly(!modifiedOnly)} /></div>
        <p className="native-setting-muted">{t('settings.modifiedOnly')} · {t('settings.modifiedHelp')}</p>
        {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => <div key={name} className="native-setting-group">
          <button className="native-group-toggle" type="button" aria-expanded={expanded.has(name)} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(name)) next.delete(name); else next.add(name); return next; })}>
            <span>{expanded.has(name) ? '▾' : '▸'} {t(`settings.group.${name}`, { defaultValue: name.replace('namespace:', '') })}</span><span>{list.length}</span>
          </button>
          <div hidden={!expanded.has(name)} className="settings-panel">{list.map(row)}</div>
        </div>)}
        {!groups.size && <p>{t('omp.settings.noMatchingAdvancedSettings')}</p>}
      </section>
      <div hidden={!show('credentials')}><SettingsCard title={t('settings.credentialsTitle')}>
        <p className="native-setting-muted">{t('settings.credentialStatusHelp')}</p>
        <table className="settings-credentials"><thead><tr><th>{t('settings.credentialPurpose')}</th><th>{t('settings.status')}</th><th>{t('settings.action')}</th></tr></thead><tbody>{credentials.map(entry => <tr key={entry.key} id={`setting-${entry.key}`} tabIndex={-1}><td><span>{t(`settings.credential.${entry.key}`,{defaultValue:entry.description || t('settings.credentialOther')})}</span><details><summary>{t('settings.details')}</summary><code>{entry.key}</code></details></td><td>{entry.redacted ? t('settings.credentialHidden') : t('settings.absent')}</td><td>{t('settings.manageCredentialConfig')}</td></tr>)}</tbody></table>
      </SettingsCard></div>
    </>}
  </div>;
}

interface NativeLoginProvider { id: string; name: string; available: boolean; authenticated: boolean }
function NativeAccounts({ runtimeId, models, onNativeLogin, t }: {
  runtimeId: string | null; models: NativeModel[]; onNativeLogin: (runtimeId: string, providerId: string) => Promise<void>; t: SettingsText;
}) {
  const [providers, setProviders] = useState<NativeLoginProvider[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | string>('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (runtimeId) void act(); }, [runtimeId]);
  async function readProviders(id: string) {
    const result = await window.ompDesktop.request<{ providers: NativeLoginProvider[] }>(id, { type: 'get_login_providers' });
    if (!result || !Array.isArray(result.providers) || !result.providers.every(provider => provider && typeof provider.id === 'string' && typeof provider.name === 'string' && typeof provider.available === 'boolean' && typeof provider.authenticated === 'boolean')) {
      throw new UserFacingError(t('omp.settings.theInstalledOmpReturnedUnsupportedSignInProviderMetadata'));
    }
    if (mounted.current) setProviders(result.providers.map(({ id, name, available, authenticated }) => ({ id, name, available, authenticated })));
  }
  async function act(provider?: NativeLoginProvider) {
    if (!runtimeId || pending.current || (provider && !provider.available)) return;
    pending.current = true; setBusy(provider?.id ?? ''); setError(''); setNotice('');
    try {
      if (provider) {
        await onNativeLogin(runtimeId, provider.id);
        if (mounted.current) setNotice(t('omp.settings.nativeSignInCompletedCredentialsRemainManagedByOmp'));
      }
      await readProviders(runtimeId);
    } catch (reason) { if (mounted.current) setError(preserveUserError(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(null); }
  }
  const catalogProviders = [...new Set(models.map(model => model.provider))];
  const combined = [...(providers ?? []), ...catalogProviders.filter(id => !providers?.some(provider => provider.id === id)).map(id => ({ id, name: id, available: false, authenticated: false }))];
  const filtered = combined.filter(provider => `${provider.name} ${provider.id} ${t(`settings.providerGroup.${providerGroup(provider)}`)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <SettingsCard>
    <Input aria-label={t('settings.providerSearch')} placeholder={t('settings.providerSearch')} value={query} onChange={event => setQuery(event.target.value)} />
    <div className="native-settings-toolbar">
      <details><summary>{t('settings.details')}</summary><p>{t('omp.settings.accountsAndCredentialsBelongToTheInstalledOmpAnd')}</p>
      <p>{runtimeId ? t('omp.settings.checkProvidersToReadThisConnectedRuntimeSSign') : t('omp.settings.noInitializedNativeSessionIsConnectedOpeningSettingsDoes')}</p>
      <p>{t('omp.settings.signInIsAnExplicitNativeActionAndMay')}</p>
      <p>{t('omp.settings.terminalFallbackRunTheSameOmpExecutableAndProfile')}</p></details>
      <Button size="sm" disabled={!runtimeId || busy !== null} onClick={() => void act()}>{busy === '' ? t('omp.settings.checking') : t('settings.checkProviders')}</Button>
    </div>
    {error && <SettingsError error={error} />}
    {notice && <div className="native-settings-note" role="status">{notice}</div>}
    {busy !== null && busy !== '' && <p className="native-setting-message" role="status">{t('omp.settings.waitingForNativeSignInFollowTheNativeBrowser')}</p>}
    {(['configured', 'login', 'api', 'local'] as const).map(group => {
      const rows = filtered.filter(provider => providerGroup(provider) === group);
      return <section className="settings-provider-group" key={group}><h3>{t(`settings.providerGroup.${group}`)} <span>{rows.length}</span></h3>{rows.length ? <table className="settings-credentials"><tbody>{rows.map(provider => <tr key={provider.id}><td>{provider.name || provider.id}<code>{provider.id}</code></td><td>{provider.authenticated ? t('settings.present') : catalogProviders.includes(provider.id) ? t('settings.providerCatalog') : t('settings.absent')}</td><td>{provider.available ? <Button size="sm" disabled={busy !== null} aria-label={`${t('settings.signIn')} ${provider.name || provider.id}`} onClick={() => void act(provider)}>{busy === provider.id ? t('omp.settings.signingIn') : t('settings.signIn')}</Button> : t('settings.manageCLI')}</td></tr>)}</tbody></table> : <p className="native-setting-muted">{t('omp.settings.notSet')}</p>}</section>;
    })}
  </SettingsCard>;
}
