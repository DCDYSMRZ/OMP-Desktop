import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigEntry, JsonValue, NativeModel, SettingsSnapshot, SettingsWriteResult } from '../../shared/contracts';
import { Button } from '../ui/ui';
import { SettingsCard, SettingsRow } from '../ui/SettingsPrimitives';
import { isCredential, NativeSettingRow, type SettingsText } from './NativeSettingRow';

// Source-verified native registry keys. Entries are rendered only when the installed CLI lists them.
const commonKeys: Record<string, true> = { modelRoles: true, modelRoleStorage: true, defaultThinkingLevel: true, 'tools.approvalMode': true, 'compaction.enabled': true, 'compaction.thresholdPercent': true, 'compaction.thresholdTokens': true };
export function NativeSettings({ workspace, models, runtimeId, onNativeLogin, query, section, t }: {
  workspace: string; models: NativeModel[]; runtimeId: string | null; query: string;
  onNativeLogin: (runtimeId: string, providerId: string) => Promise<void>;
  section: 'common' | 'advanced' | 'credentials'; t: SettingsText;
}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [error, setError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [writeNotice, setWriteNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const pending = useRef(false);
  const sequence = useRef(0);
  async function load() {
    const version = ++sequence.current;
    setLoading(true); setError('');
    try {
      const next = await window.ompDesktop.listSettings(workspace);
      if (version === sequence.current) setSnapshot(next);
    } catch (reason) { if (version === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (version === sequence.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [workspace]);
  async function write(key: string, value: JsonValue | undefined): Promise<SettingsWriteResult> {
    if (pending.current) throw new Error(t('Wait for the current save to complete.', '请等待当前保存完成。'));
    pending.current = true; setWriting(true); setWriteError(''); setWriteNotice('');
    try {
      const result = value === undefined
        ? await window.ompDesktop.resetSetting(workspace, key)
        : await window.ompDesktop.setSetting(workspace, key, value);
      setSnapshot(result.snapshot);
      const message = result.overriddenBy
        ? t('Saved globally; effective value is overridden by: ', '已保存到全局；当前生效值被以下来源覆盖：') + result.overriddenBy
        : result.fallbackEnv
          ? t('Saved; blank saved values use environment fallback: ', '已保存；空配置值使用以下环境回退：') + result.fallbackEnv
          : value === undefined
            ? t('Global key removed. Effective values have been reloaded; project or environment values may still apply.', '全局键已移除，已重新读取生效值；项目或环境配置仍可能生效。')
            : t('Saved. Effective values have been reloaded.', '已保存，并已重新读取生效值。');
      setWriteNotice(`${key}: ${message}`);
      return result;
    } catch (reason) {
      setWriteError(`${key}: ${reason instanceof Error ? reason.message : String(reason)}`);
      throw reason;
    } finally { pending.current = false; setWriting(false); }
  }
  const q = query.trim().toLocaleLowerCase();
  const entries = useMemo(() => (snapshot?.entries ?? []).filter(entry => !q || `${entry.key} ${entry.type} ${entry.description}`.toLocaleLowerCase().includes(q)), [snapshot, q]);
  const common = entries.filter(entry => Object.hasOwn(commonKeys, entry.key) && !isCredential(entry));
  const credentials = entries.filter(isCredential);
  const groups = new Map<string, ConfigEntry[]>();
  for (const entry of entries) {
    if (Object.hasOwn(commonKeys, entry.key) || isCredential(entry)) continue;
    const group = entry.key.includes('.') ? entry.key.split('.')[0] : t('Other native settings', '其他原生设置');
    const list = groups.get(group) ?? []; list.push(entry); groups.set(group, list);
  }
  const show = (name: typeof section) => Boolean(q) || section === name;
  const row = (entry: ConfigEntry) => <NativeSettingRow key={entry.key} entry={entry} busy={writing || loading} t={t} onWrite={write} />;
  return <div className="settings-stack">
    <div className="native-settings-note">
      <p>{t('Owned by omp. Saves and resets affect the active profile’s global native config, including terminal omp. Project and environment overrides may remain effective. Other keys and credentials are preserved.', '配置由 omp 管理。保存和重置会修改当前 profile 的全局原生配置，也会影响终端 omp。项目及环境覆盖可能继续生效；其他键和凭据保持不变。')}</p>
      <p>{t('These are freshly listed CLI effective values, not a live session snapshot. Start a new session to apply runtime settings; an existing session can keep its own overrides.', '此处显示 CLI 最新读取的生效值，并非运行中会话快照。原生运行设置请在新会话中使用；现有会话可能保留自己的覆盖值。')}</p>
      <dl><dt>{t('Workspace', '工作目录')}</dt><dd>{workspace || t('No workspace selected', '尚未选择工作目录')}</dd>
        {snapshot && <><dt>{t('Native config directory', '原生配置目录')}</dt><dd>{snapshot.directory}</dd></>}
        <dt>{t('Session', '会话')}</dt><dd>{runtimeId ? t('Connected; changes are not injected into this session', '已连接；配置修改不会注入当前会话') : t('Not connected', '未连接')}</dd></dl>
      <Button size="sm" disabled={loading || writing} onClick={() => void load()}>{loading ? t('Loading…', '读取中…') : t('Reload native values', '重新读取原生值')}</Button>
    </div>
    {error && <div className="native-setting-error native-settings-note" role="alert">{error}</div>}
    {writeError && <div className="native-setting-error native-settings-note" role="alert">{writeError}</div>}
    {writeNotice && <div className="native-settings-note" role="status">{writeNotice}</div>}
    {writing && <div role="status">{t('Saving native setting…', '正在保存原生设置…')}</div>}
    {loading && !snapshot && <div role="status">{t('Reading installed omp settings…', '正在读取已安装 omp 的设置…')}</div>}
    <div hidden={!show('credentials')}><NativeAccounts key={runtimeId ?? 'disconnected'} runtimeId={runtimeId} onNativeLogin={onNativeLogin} query={q} t={t} /></div>
    {snapshot && <>
      {show('common') && <><SettingsCard title={t('Models & runtime defaults', '模型与运行默认值')}>
        {common.length ? common.map(row) : <p className="native-settings-empty">{t('No matching common keys were returned by this omp installation.', '当前 omp 未返回匹配的常用键。')}</p>}
      </SettingsCard>
        {!q && <div className="native-settings-note"><strong>{t('Models from the connected runtime', '已连接运行时提供的模型')}</strong>
          {models.length ? <details className="native-model-list"><summary>{t('Available model selectors', '可用模型标识')} ({models.length})</summary><ul>{models.map(model => <li key={`${model.provider}/${model.id}`}><code>{model.provider}/{model.id}</code>{model.name && <span> — {model.name}</span>}</li>)}</ul></details>
          : <p>{t('No runtime model catalog is available. Configure authentication and models using the installed omp, then start a new session. This desktop does not maintain a separate provider configuration.', '暂无运行时模型目录。请使用已安装的 omp 配置认证和模型，然后新建会话。桌面端不会维护另一套服务商配置。')}</p>}
        </div>}
      </>}
      {show('advanced') && <section className="native-advanced"><h2 className="settings-card-heading">{t('Advanced native settings', '高级原生设置')}</h2>
        <p className="native-setting-muted">{t('All other entries returned by omp are listed by key prefix. Expand a group, or search to reveal matching entries.', 'omp 返回的其余设置按键前缀分组。展开分组，或通过搜索自动显示匹配项。')}</p>
        {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => <div key={name} className="native-setting-group">
          <button className="native-group-toggle" type="button" aria-expanded={Boolean(q) || expanded.has(name)} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(name)) next.delete(name); else next.add(name); return next; })}>
            <span>{q || expanded.has(name) ? '▾' : '▸'} {name}</span><span>{list.length}</span>
          </button>
          {(q || expanded.has(name)) && <div className="settings-panel lg-regular lg-pane">{list.map(row)}</div>}
        </div>)}
        {!groups.size && <p>{t('No matching advanced settings.', '没有匹配的高级设置。')}</p>}
      </section>}
      {show('credentials') && <SettingsCard title={t('Credential presence', '凭据状态')}>
        <div className="native-settings-note"><p>{t('Configuration presence only: secret values are never requested or edited here. These fields do not identify signed-in accounts or prove that credentials are valid. Manage these credential fields with the installed omp using the same profile.', '仅显示配置是否存在：不会读取或编辑秘密原文。这些字段不代表已登录账户，也不能证明凭据有效。请使用相同 profile 的已安装 omp 管理这些凭据字段。')}</p></div>
        {credentials.length ? credentials.map(row) : <p className="native-settings-empty">{t('No matching credential metadata returned.', '未返回匹配的凭据元数据。')}</p>}
      </SettingsCard>}
    </>}
  </div>;
}

interface NativeLoginProvider { id: string; name: string; available: boolean; authenticated: boolean }
function NativeAccounts({ runtimeId, onNativeLogin, query, t }: {
  runtimeId: string | null; onNativeLogin: (runtimeId: string, providerId: string) => Promise<void>; query: string; t: SettingsText;
}) {
  const [providers, setProviders] = useState<NativeLoginProvider[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function readProviders(id: string) {
    const result = await window.ompDesktop.request<{ providers: NativeLoginProvider[] }>(id, { type: 'get_login_providers' });
    if (!result || !Array.isArray(result.providers) || !result.providers.every(provider => provider && typeof provider.id === 'string' && typeof provider.name === 'string' && typeof provider.available === 'boolean' && typeof provider.authenticated === 'boolean')) {
      throw new Error(t('The installed omp returned unsupported sign-in provider metadata. Use its terminal /login flow.', '已安装的 omp 返回了不支持的登录服务商元数据。请使用其终端 /login 流程。'));
    }
    if (mounted.current) setProviders(result.providers.map(({ id, name, available, authenticated }) => ({ id, name, available, authenticated })));
  }
  async function act(provider?: NativeLoginProvider) {
    if (!runtimeId || pending.current || (provider && !provider.available)) return;
    pending.current = true; setBusy(provider?.id ?? ''); setError(''); setNotice('');
    try {
      if (provider) {
        await onNativeLogin(runtimeId, provider.id);
        if (mounted.current) setNotice(t('Native sign-in completed. Credentials remain managed by omp.', '原生登录已完成。凭据仍由 omp 管理。'));
      }
      await readProviders(runtimeId);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(null); }
  }
  const visible = providers?.filter(provider => !query || `${provider.id} ${provider.name}`.toLocaleLowerCase().includes(query));
  return <SettingsCard title={t('Native sign-in', '原生登录')}>
    <div className="native-settings-note">
      <p>{t('Accounts and credentials belong to the installed omp and its selected profile. This desktop does not keep a separate account registry.', '账户和凭据由已安装的 omp 及其所选 profile 管理。桌面端不会另建账户注册表。')}</p>
      <p>{runtimeId ? t('Check providers to read this connected runtime’s sign-in capabilities. Credential presence is not proof of a valid account. Available providers may still require terminal-only prompts.', '检查服务商以读取当前已连接运行时的登录能力。凭据存在不代表账户有效；可用服务商仍可能需要仅终端支持的交互。') : t('No initialized native session is connected. Opening settings does not start omp or authentication. If RPC cannot initialize, sign in through the terminal first.', '尚未连接已初始化的原生会话。打开设置不会启动 omp 或认证。若 RPC 无法初始化，请先在终端登录。')}</p>
      <p>{t('Sign in is an explicit native action and may save credentials to the current omp profile. Follow the native link or input prompt; browser links open only when you click them.', '登录是明确的原生操作，可能将凭据保存到当前 omp profile。请按原生链接或输入提示操作；浏览器链接仅在点击后打开。')}</p>
      <p>{t('Terminal fallback: run the same omp executable and profile in this workspace, then use /login. Secret input and providers that need interactive setup before opening a browser must use the native terminal flow.', '终端替代方式：在此工作目录运行相同的 omp 可执行文件和 profile，然后使用 /login。需要秘密输入或在打开浏览器前需要交互设置的服务商，必须使用原生终端流程。')}</p>
      <Button size="sm" disabled={!runtimeId || busy !== null} onClick={() => void act()}>{busy === '' ? t('Checking…', '检查中…') : t('Check native sign-in providers', '检查原生登录服务商')}</Button>
    </div>
    {error && <div className="native-setting-error native-settings-note" role="alert">{error}</div>}
    {notice && <div className="native-settings-note" role="status">{notice}</div>}
    {busy !== null && busy !== '' && <p className="native-setting-message" role="status">{t('Waiting for native sign-in. Follow the native browser or input prompt. Leaving this page does not cancel authentication.', '正在等待原生登录。请按原生浏览器或输入提示操作。离开此页不会取消认证。')}</p>}
    {visible?.map(provider => <div className="native-setting" key={provider.id}><SettingsRow title={provider.name || provider.id} detail={<>
      <code>{provider.id}</code>
      <span>{provider.available ? t('Sign-in offered by native omp', '原生 omp 提供登录') : t('Sign-in unavailable in this installation', '此安装未提供登录')}</span>
      <span>{provider.authenticated ? t('Native credential source present; not validated', '存在原生凭据来源；未经验证') : t('No native credential source reported', '未报告原生凭据来源')}</span>
    </>}>
      <Button size="sm" disabled={busy !== null || !provider.available} aria-label={`${t('Sign in with', '登录')} ${provider.name || provider.id}`} onClick={() => void act(provider)}>{busy === provider.id ? t('Signing in…', '登录中…') : t('Sign in', '登录')}</Button>
    </SettingsRow></div>)}
    {providers !== null && !visible?.length && <p className="native-settings-empty">{providers.length ? t('No matching native sign-in providers.', '没有匹配的原生登录服务商。') : t('This native runtime reported no sign-in providers. Use its terminal configuration flow.', '此原生运行时未报告登录服务商。请使用其终端配置流程。')}</p>}
  </SettingsCard>;
}
