import { UserFacingError, preserveUserError } from '../lib/user-errors';
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ConfigEntry, JsonValue, NativeModel, SettingsWriteResult } from '../../shared/contracts';
import { SettingsRow } from '../ui/SettingsPrimitives';
import { SettingsMenuSelect } from '../ui/SettingsMenuSelect';
import { Button, Input, SettingsToggle, Textarea } from '../ui/ui';
import { commonSettings, curatedAdvancedSettings, modelRoles, stringRoleRecord, type SettingProvenance } from './settings-model';
import { SettingsError } from './SettingsError';

export type SettingsText = TFunction;
export const isCredential = (entry: ConfigEntry) => Boolean(entry.credential || entry.redacted);
export function displayValue(entry: ConfigEntry): string {
  if (isCredential(entry) || entry.value === undefined) return '';
  return typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value, null, 2);
}
function parseValue(type: string, value: string, t: SettingsText): JsonValue {
  if (type === 'string' || type === 'enum') return value;
  if (type === 'number') {
    if (!value.trim() || !Number.isFinite(Number(value))) throw new UserFacingError(t('omp.settings.enterAFiniteNumber'));
    return Number(value);
  }
  if (type === 'boolean') return value === 'true';
  const parsed: JsonValue = JSON.parse(value);
  if (type === 'array' && !Array.isArray(parsed)) throw new UserFacingError(t('omp.settings.enterAJSONArray'));
  if (type === 'record' && (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')) throw new UserFacingError(t('omp.settings.enterAJSONObject'));
  return parsed;
}
export function NativeSettingRow({ entry, busy, t, onWrite, models = [], thinkingLevels = [], provenance = 'unknown', modified = false, onDraftChange }: {
  entry: ConfigEntry; busy: boolean; t: SettingsText; models?: NativeModel[]; thinkingLevels?: string[]; provenance?: SettingProvenance; modified?: boolean;
  onDraftChange?: (key: string, dirty: boolean) => void;
  onWrite: (key: string, value: JsonValue | undefined) => Promise<SettingsWriteResult>;
}) {
  const value = displayValue(entry);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<Error | string>('');
  const [copied, setCopied] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { onDraftChange?.(entry.key, draft !== value); }, [draft, value, entry.key, onDraftChange]);
  const known = Object.hasOwn(commonSettings, entry.key) ? commonSettings[entry.key] : Object.hasOwn(curatedAdvancedSettings, entry.key) ? curatedAdvancedSettings[entry.key] : undefined;
  const label = known ? t(`settings.${known.name}`) : t(`settings.native.${entry.key}`, { defaultValue: entry.key });
  const secret = isCredential(entry);
  const structured = entry.type === 'array' || entry.type === 'record';
  const supported = ['string', 'enum', 'number', 'boolean', 'array', 'record'].includes(entry.type);
  let parsedRoles: Record<string, string> | null = null;
  if (entry.key === 'modelRoles') { try { const parsed: JsonValue = draft ? JSON.parse(draft) : {}; if (stringRoleRecord(parsed)) parsedRoles = parsed; } catch { /* Unknown structures retain the JSON editor. */ } }
  const roles = parsedRoles;
  const enums = entry.key === 'modelRoleStorage' ? ['global', 'project'] : entry.key === 'tools.approvalMode' ? ['always-ask', 'write', 'yolo'] : entry.key === 'defaultThinkingLevel' && thinkingLevels.length ? [...new Set(['auto', ...thinkingLevels])] : [];
  const options = enums.map(id => ({ id, label: t(`settings.${id}`, { defaultValue: id }) }));
  if (options.length && !enums.includes(draft)) options.unshift({ id: draft, label: draft ? t(`settings.${draft}`, { defaultValue: draft }) : t('omp.settings.notSet') });
  const catalog = [...models].sort((a, b) => a.provider.localeCompare(b.provider) || (a.name ?? a.id).localeCompare(b.name ?? b.id)).map(model => ({ id: `${model.provider}/${model.id}`, label: model.name || model.id, group: model.provider }));
  async function commit(reset: boolean, next = draft) {
    setError(''); setResetArmed(false);
    try {
      const result = await onWrite(entry.key, reset ? undefined : parseValue(entry.type, next, t));
      const effective = result.snapshot.entries.find(item => item.key === entry.key);
      if (effective) setDraft(displayValue(effective));
    } catch (reason) { setError(preserveUserError(reason)); if (entry.type === 'boolean') setDraft(value); }
  }
  return <div className={`native-setting${roles ? ' native-setting-roles' : ''}`} id={`setting-${entry.key}`} tabIndex={-1}>
    <SettingsRow title={<>{label}{(modified || draft !== value) && <span className="settings-modified" title={t('settings.modified')} aria-label={t('settings.modified')}>●</span>}</>} description={known ? t(`settings.${known.name}Help`) : entry.description ? `${t('settings.nativeDescription')} · ${entry.description}` : undefined}
      detail={<><button type="button" className="settings-key" title={`${t('settings.copyKey')}: ${entry.key}`} onClick={() => { void navigator.clipboard.writeText(entry.key).then(() => setCopied(true)).catch(reason => setError(String(reason))); }}><code>{entry.key}</code>{copied && <span>{t('settings.copied')}</span>}</button><details className="settings-technical-details"><summary>{t('settings.details')}</summary><span className="settings-provenance" title={t('settings.sourceHelp')}>{t(`settings.source.${provenance}`)}</span>{known && entry.description && <p>{t('settings.nativeDescription')} · {entry.description}</p>}</details></>}>
      {secret ? <span className="native-setting-muted">{entry.redacted ? t('settings.present') : t('settings.absent')}</span> : !supported ? <span className="native-setting-muted">{t('omp.settings.thisNativeTypeIsReadOnlyHereUseOmp')}</span> :
        <form className="native-setting-form" onSubmit={event => { event.preventDefault(); void commit(false); }}>
          {entry.type === 'boolean' ? <SettingsToggle checked={draft === 'true'} label={label} busy={busy} onChange={() => { const next = draft === 'true' ? 'false' : 'true'; setDraft(next); void commit(false, next); }} />
            : roles ? <div className="settings-role-table">{[...new Set([...modelRoles, ...Object.keys(roles)])].map(role => {
              const selected = roles[role] ?? '';
              const roleLabel = t(`settings.role.${role}`, { defaultValue: role });
              const roleOptions = [{ id: '', label: t('settings.inherit') }, ...catalog];
              if (selected && !catalog.some(model => model.id === selected)) roleOptions.splice(1, 0, { id: selected, label: selected });
              const change = (next: string) => { const record = { ...roles }; if (next) record[role] = next; else delete record[role]; setDraft(JSON.stringify(record, null, 2)); };
              return <div className="settings-role-row" key={role}><div className="settings-role-copy"><div><span title={role}>{roleLabel}</span></div><p>{t(`settings.roleHelp.${role}`, { defaultValue: t('settings.roleHelp.custom') })}</p></div><SettingsMenuSelect label={`${label} · ${roleLabel}`} value={selected} options={roleOptions} searchable fullWidth disabled={busy || !models.length} onChange={change} />{!models.length && <p className="native-setting-muted">{t('settings.catalogUnavailable')}</p>}</div>;
            })}</div>
            : options.length ? <SettingsMenuSelect label={label} value={draft} options={options} fullWidth disabled={busy} onChange={setDraft} />
            : structured ? <Textarea aria-label={label} rows={5} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
            : <Input aria-label={label} type={entry.type === 'number' ? 'number' : 'text'} step="any" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />}
          <div className="native-setting-actions">{entry.type !== 'boolean' && <Button type="submit" size="sm" variant="primary" disabled={busy || draft === value}>{t('omp.settings.save')}</Button>}<Button type="button" size="sm" disabled={busy} onClick={() => setResetArmed(!resetArmed)}>{t('omp.settings.resetKey')}</Button></div>
          {structured && !roles && <span className="native-setting-muted">{t('omp.settings.jSONReplacesThisKeyOnlyNotTheFullConfig')}</span>}
          {resetArmed && <div className="native-reset-confirm"><span>{t('omp.settings.removeThisGlobalKeyNativeDefaultsOrOverridesWill')}</span><Button type="button" size="sm" disabled={busy} onClick={() => void commit(true)}>{t('omp.settings.confirmReset')}</Button><Button type="button" size="sm" onClick={() => setResetArmed(false)}>{t('omp.settings.cancel')}</Button></div>}
        </form>}
    </SettingsRow>{error && <SettingsError error={error} />}
  </div>;
}
