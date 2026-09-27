import { useEffect, useState } from 'react';
import type { ConfigEntry, JsonValue, SettingsWriteResult } from '../../shared/contracts';
import { SettingsRow } from '../ui/SettingsPrimitives';
import { Button, Input, Select, Textarea } from '../ui/ui';

export type SettingsText = (english: string, chinese: string) => string;
export const isCredential = (entry: ConfigEntry) => Boolean(entry.credential || entry.redacted);
export function displayValue(entry: ConfigEntry): string {
  if (isCredential(entry)) return '';
  if (entry.value === undefined) return '';
  return typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value, null, 2);
}

function parseValue(type: string, value: string, t: SettingsText): JsonValue {
  if (type === 'string' || type === 'enum') return value;
  if (type === 'number') {
    if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(t('Enter a finite number.', '请输入有效的有限数字。'));
    return Number(value);
  }
  if (type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error(t('Choose true or false.', '请选择 true 或 false。'));
    return value === 'true';
  }
  const parsed: JsonValue = JSON.parse(value);
  if (type === 'array' && !Array.isArray(parsed)) throw new Error(t('Enter a JSON array.', '请输入 JSON 数组。'));
  if (type === 'record' && (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')) throw new Error(t('Enter a JSON object.', '请输入 JSON 对象。'));
  return parsed;
}

export function NativeSettingRow({ entry, busy, t, onWrite }: {
  entry: ConfigEntry; busy: boolean; t: SettingsText;
  onWrite: (key: string, value: JsonValue | undefined) => Promise<SettingsWriteResult>;
}) {
  const value = displayValue(entry);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [resetArmed, setResetArmed] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  const secret = isCredential(entry);
  const supported = ['string', 'enum', 'number', 'boolean', 'array', 'record'].includes(entry.type);
  const structured = entry.type === 'array' || entry.type === 'record';
  async function commit(reset: boolean) {
    setError(''); setResetArmed(false);
    try {
      const result = await onWrite(entry.key, reset ? undefined : parseValue(entry.type, draft, t));
      const effective = result.snapshot.entries.find(item => item.key === entry.key);
      if (effective) setDraft(displayValue(effective));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <div className="native-setting">
    <SettingsRow title={entry.key} description={entry.description || undefined}
      detail={<><span className="native-setting-type">{entry.type}</span>{secret
        ? <span>{entry.redacted ? t('Configured · hidden', '已配置 · 内容隐藏') : t('Not configured', '未配置')}</span>
        : <span>{t('Effective: ', '当前生效：')}<code>{entry.value === undefined ? t('(not set)', '（未设置）') : value}</code></span>}</>}>
      {secret ? <span className="native-setting-muted">{t('Manage in omp', '请在 omp 中管理')}</span>
        : !supported ? <span className="native-setting-muted">{t('This native type is read-only here. Use omp config.', '此原生类型仅供查看，请使用 omp config 修改。')}</span>
        : <form className="native-setting-form" onSubmit={event => { event.preventDefault(); void commit(false); }}>
          {entry.type === 'boolean' ? <Select className="lg-thin lg-control" aria-label={entry.key} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}>
            {draft !== 'true' && draft !== 'false' && <option value="">{t('Not set', '未设置')}</option>}
            <option value="true">true</option><option value="false">false</option>
          </Select> : structured ? <Textarea className="lg-thin lg-control" aria-label={entry.key} rows={5} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
          : <Input className="lg-thin lg-control" aria-label={entry.key} type={entry.type === 'number' ? 'number' : 'text'} step="any" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />}
          <div className="native-setting-actions">
            <Button type="submit" size="sm" variant="primary" disabled={busy}>{t('Save', '保存')}</Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => setResetArmed(!resetArmed)}>{t('Reset key', '重置此项')}</Button>
          </div>
          {entry.type === 'enum' && <span className="native-setting-muted">{t('Native CLI validates allowed values; this version does not publish enum options in JSON.', '允许值由原生 CLI 校验；此版本的 JSON 元数据不包含枚举选项。')}</span>}
          {structured && <span className="native-setting-muted">{t('JSON · replaces this key only, not the full config.', 'JSON · 仅替换此键，不覆盖整个配置。')}</span>}
          {resetArmed && <div className="native-reset-confirm">
            <span>{t('Remove this global key? Native defaults or overrides will apply.', '移除此全局键？之后将采用原生默认值或覆盖值。')}</span>
            <Button type="button" size="sm" disabled={busy} onClick={() => void commit(true)}>{t('Confirm reset', '确认重置')}</Button>
            <Button type="button" size="sm" onClick={() => setResetArmed(false)}>{t('Cancel', '取消')}</Button>
          </div>}
        </form>}
    </SettingsRow>
    {error && <div className="native-setting-message native-setting-error" role="alert">{error}</div>}
  </div>;
}
