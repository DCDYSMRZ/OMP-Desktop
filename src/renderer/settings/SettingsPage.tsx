import { useEffect, useRef, useState } from 'react';
import type { DesktopPreferences, NativeModel, RuntimeInfo } from '../../shared/contracts';
import { Button, Input, SettingsToggle, cx } from '../ui/ui';
import { SettingsCard, SettingsRow } from '../ui/SettingsPrimitives';
import { SettingsMenuSelect } from '../ui/SettingsMenuSelect';
import { useLiquidIndicator } from '../lib/glass/useLiquidIndicator';
import { IconChevronLeft, IconKey, IconPalette, IconSearch, IconSettings, IconSliders, IconTerminal } from '../ui/icons';
import { NativeSettings } from './NativeSettings';
import './settings-native.css';

export interface SettingsPageProps {
  preferences: DesktopPreferences; workspace: string; runtimeInfo: RuntimeInfo; models: NativeModel[]; runtimeId: string | null;
  onPreferencesChange: (patch: Partial<DesktopPreferences>) => Promise<void>; onClose: () => void;
  onNativeLogin: (runtimeId: string, providerId: string) => Promise<void>;
}
type Tab = 'desktop' | 'runtime' | 'common' | 'advanced' | 'credentials';

export function SettingsPage({ preferences, workspace, runtimeInfo, models, runtimeId, onNativeLogin, onPreferencesChange, onClose }: SettingsPageProps) {
  const t = (english: string, chinese: string) => preferences.language === 'zh-CN' ? chinese : english;
  const [tab, setTab] = useState<Tab>('desktop');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [runtime, setRuntime] = useState(runtimeInfo);
  const [executable, setExecutable] = useState(preferences.executablePath);
  const [profile, setProfile] = useState(preferences.profile);
  const [font, setFont] = useState(preferences.fontFamily);
  const [fontSize, setFontSize] = useState(String(preferences.fontSize));
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setRuntime(runtimeInfo); }, [runtimeInfo]);
  useEffect(() => { setExecutable(preferences.executablePath); setProfile(preferences.profile); }, [preferences.executablePath, preferences.profile]);
  useEffect(() => { setFont(preferences.fontFamily); setFontSize(String(preferences.fontSize)); }, [preferences.fontFamily, preferences.fontSize]);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [tab]);
  async function action(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function save(patch: Partial<DesktopPreferences>) {
    await action(async () => { await onPreferencesChange(patch); setNotice(t('Desktop preference saved.', '桌面偏好已保存。')); });
  }
  const nav = [
    { id: 'desktop' as const, label: t('Appearance & input', '外观与输入'), keywords: 'theme font size language enter 主题 字体 大小 语言 发送', icon: <IconPalette size={14} /> },
    { id: 'runtime' as const, label: t('Local runtime', '本地运行时'), keywords: 'executable profile workspace version path 可执行文件 工作目录 版本 路径', icon: <IconTerminal size={14} /> },
    { id: 'common' as const, label: t('Models & defaults', '模型与默认值'), keywords: 'model thinking approval compaction 模型 思考 审批 压缩', icon: <IconSettings size={14} /> },
    { id: 'advanced' as const, label: t('Advanced native settings', '高级原生设置'), keywords: 'advanced native 高级 原生', icon: <IconSliders size={14} /> },
    { id: 'credentials' as const, label: t('Credentials', '凭据'), keywords: 'credentials authentication login 凭据 认证 登录', icon: <IconKey size={14} /> },
  ];
  const q = query.trim().toLocaleLowerCase();
  const railRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useLiquidIndicator(railRef, q ? null : tab, 'y');
  const desktopMatches = !q || `${nav[0].label} ${nav[0].keywords}`.toLocaleLowerCase().includes(q);
  const runtimeMatches = !q || `${nav[1].label} ${nav[1].keywords}`.toLocaleLowerCase().includes(q);
  const showDesktop = q ? desktopMatches : tab === 'desktop';
  const showRuntime = q ? runtimeMatches : tab === 'runtime';
  const showNative = Boolean(q) || !['desktop', 'runtime'].includes(tab);
  return <div className="settings-shell settings-shell-full">
    <div className="settings-titlebar" aria-hidden="true" />
    <aside className="settings-nav" aria-label={t('Settings', '设置')}>
      <div className="settings-nav-top drag"><div className="settings-search-wrap no-drag">
        <IconSearch size={14} /><input className="settings-search lg-thin lg-control" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search settings', '搜索设置')} aria-label={t('Search settings', '搜索设置')} spellCheck={false} autoCorrect="off" autoCapitalize="off" />
      </div></div>
      <div className="settings-nav-scroll no-drag" ref={railRef}>
        <div ref={indicatorRef} className="lg-liquid-indicator" aria-hidden="true" />
        {[{ label: t('Desktop', '桌面端'), items: nav.slice(0, 2) }, { label: 'omp', items: nav.slice(2) }].map(group => <div className="settings-nav-group" key={group.label}>
          <div className="settings-nav-group-label">{group.label}</div>
          {group.items.map(item => <button type="button" key={item.id} data-liquid-key={item.id} className={cx('settings-nav-item', !q && tab === item.id && 'active')} aria-current={!q && tab === item.id ? 'page' : undefined} onClick={() => { setTab(item.id); setQuery(''); }}>
            <span className="settings-nav-icon">{item.icon}</span><span className="settings-nav-label">{item.label}</span>
          </button>)}
        </div>)}
      </div>
      <div className="settings-nav-footer no-drag"><button type="button" className="settings-back no-drag" data-nav="back-to-app" onClick={onClose}><IconChevronLeft size={15} /><span>{t('Back to app', '返回应用')}</span></button></div>
    </aside>
    <div className="settings-content" ref={contentRef}><div className="settings-content-inner"><div className="settings-content-enter">
      <h1 className="settings-section-title">{q ? t('Search settings', '搜索设置') : nav.find(item => item.id === tab)?.label}</h1>
      {error && <div className="native-settings-note native-setting-error" role="alert">{error}</div>}
      {notice && <div className="native-settings-note" role="status">{notice}</div>}
      {showDesktop && <div className="settings-stack">
        <p className="native-setting-muted">{t('Desktop-only preferences apply immediately and never modify omp configuration.', '桌面偏好立即生效，不会修改 omp 原生配置。')}</p>
        <SettingsCard title={t('Appearance', '外观')}>
          <SettingsRow title={t('Theme', '主题')}><SettingsMenuSelect label={t('Theme', '主题')} value={preferences.theme} disabled={busy} options={[{ id: 'system', label: t('System', '跟随系统') }, { id: 'light', label: t('Light', '浅色') }, { id: 'dark', label: t('Dark', '深色') }]} onChange={value => void save({ theme: value as DesktopPreferences['theme'] })} /></SettingsRow>
          <SettingsRow title={t('Language', '语言')}><SettingsMenuSelect label={t('Language', '语言')} value={preferences.language} disabled={busy} options={[{ id: 'zh-CN', label: '简体中文' }, { id: 'en', label: 'English' }]} onChange={value => void save({ language: value as DesktopPreferences['language'] })} /></SettingsRow>
          <SettingsRow title={t('Font family', '字体')} description={t('Use a font installed on this computer or a CSS font stack. No fonts are downloaded.', '使用本机已安装字体或 CSS 字体列表，不会下载字体。')}><form className="native-desktop-field" onSubmit={event => { event.preventDefault(); void save({ fontFamily: font }); }}><Input className="lg-thin lg-control" aria-label={t('Font family', '字体')} value={font} maxLength={200} disabled={busy} onChange={event => setFont(event.target.value)} /><Button size="sm" disabled={busy || font === preferences.fontFamily}>{t('Save', '保存')}</Button></form></SettingsRow>
          <SettingsRow title={t('Font size', '字号')}><form className="native-desktop-field" onSubmit={event => { event.preventDefault(); void action(async () => { const size = Number(fontSize); if (!fontSize.trim() || !Number.isInteger(size) || size < 10 || size > 32) throw new Error(t('Enter a whole-number font size from 10 to 32.', '请输入 10 至 32 之间的整数字号。')); await onPreferencesChange({ fontSize: size }); setNotice(t('Font size saved.', '字号已保存。')); }); }}><Input className="lg-thin lg-control" aria-label={t('Font size', '字号')} type="number" min={10} max={32} step={1} required value={fontSize} disabled={busy} onChange={event => setFontSize(event.target.value)} /><span>px</span><Button size="sm" disabled={busy || fontSize === String(preferences.fontSize)}>{t('Save', '保存')}</Button></form></SettingsRow>
        </SettingsCard>
        <SettingsCard title={t('Input', '输入')}><SettingsRow title={t('Enter to send', '回车发送')} description={t('When enabled, Shift+Enter inserts a newline. Otherwise use Ctrl/Cmd+Enter to send.', '启用后 Shift+Enter 换行；关闭时使用 Ctrl/Cmd+Enter 发送。')}><SettingsToggle checked={preferences.enterToSend} label={t('Enter to send', '回车发送')} disabled={busy} onChange={() => void save({ enterToSend: !preferences.enterToSend })} /></SettingsRow></SettingsCard>
        <div className="native-settings-legal">OMP-Desktop · {t('UI adapted from', '界面改编自')} PI-Desktop (vastsa / contributors), LGPL-3.0. {t('Transport adaptation:', '传输适配：')} pi-desktop, Copyright 2026 HighlandJewls, PikkonMG, FaqFirebase, Apache-2.0. {t('No warranty. Full licenses and notices are included with the application.', '不提供担保。完整许可证及声明随应用分发。')}</div>
      </div>}
      {showRuntime && <div className="settings-stack">
        <div className="native-settings-note"><p>{t('Executable and profile select the installed omp used for subsequent sessions and native config/history reads. Disconnect existing runtimes before changing them; ongoing work is never cancelled automatically. Start a new session after changing them; restarting the desktop reconnects discovery.', '可执行文件和 profile 决定后续会话及原生配置、历史读取使用的 omp。修改前请先断开已有运行时；应用不会自动取消进行中的工作。修改后请新建会话；重启桌面端可重新发现运行时。')}</p></div>
        <SettingsCard title={t('Installed omp', '已安装的 omp')}>
          <SettingsRow title={t('Runtime status', '运行时状态')} detail={<span>{runtime.available ? `${runtime.version ?? 'omp'} · ${runtime.path ?? ''}` : runtime.error || t('Unavailable', '不可用')}</span>}><Button disabled={busy} onClick={() => void action(async () => { setRuntime(await window.ompDesktop.checkRuntime()); })}>{t('Check installation', '检查安装')}</Button></SettingsRow>
          <SettingsRow title={t('Executable path', '可执行文件路径')} description={t('Leave blank to discover installed omp. Browse selects a path; Save and check activates and verifies it. No arbitrary command arguments are accepted.', '留空自动发现已安装的 omp。浏览仅选择路径；保存并检查后才启用并验证。不接受任意命令参数。')}><form className="native-setting-form" onSubmit={event => { event.preventDefault(); void action(async () => { await onPreferencesChange({ executablePath: executable }); setRuntime(await window.ompDesktop.checkRuntime()); setNotice(t('Executable selection saved for new sessions.', '可执行文件已保存，将用于新会话。')); }); }}><Input className="lg-thin lg-control" aria-label={t('Executable path', '可执行文件路径')} value={executable} disabled={busy} placeholder="omp" onChange={event => setExecutable(event.target.value)} /><div className="native-setting-actions"><Button type="button" size="sm" disabled={busy} onClick={() => void action(async () => { const path = await window.ompDesktop.chooseExecutable(); if (path) setExecutable(path); })}>{t('Browse', '浏览')}</Button><Button size="sm" disabled={busy}>{t('Save and check', '保存并检查')}</Button></div></form></SettingsRow>
          <SettingsRow title={t('Native profile', '原生 profile')} description={t('Exact native profile name; blank uses omp’s default. This is not a second desktop configuration profile.', '填写原生 profile 名称；留空使用 omp 默认配置。这不是桌面端创建的另一套配置。')} detail={preferences.profile || t('Default profile', '默认 profile')}><form className="native-desktop-field" onSubmit={event => { event.preventDefault(); void save({ profile: profile.trim() }); }}><Input className="lg-thin lg-control" aria-label={t('Native profile', '原生 profile')} value={profile} maxLength={64} disabled={busy} onChange={event => setProfile(event.target.value)} /><Button size="sm" disabled={busy || profile === preferences.profile}>{t('Save', '保存')}</Button></form></SettingsRow>
          <SettingsRow title={t('Default workspace', '默认工作目录')} description={t('Desktop preference for subsequent workspace selection; it does not move an active session or change native config ownership.', '用于后续工作区选择的桌面偏好，不会移动运行中的会话或改变原生配置归属。')} detail={preferences.lastWorkspace || t('Not selected', '尚未选择')}><Button disabled={busy} onClick={() => void action(async () => { const path = await window.ompDesktop.chooseWorkspace(); if (path) { await onPreferencesChange({ lastWorkspace: path, recentWorkspaces: [path, ...preferences.recentWorkspaces.filter(item => item !== path)].slice(0, 40) }); setNotice(t('Default workspace saved.', '默认工作目录已保存。')); } })}>{t('Choose folder', '选择文件夹')}</Button></SettingsRow>
        </SettingsCard>
      </div>}
      <div hidden={!showNative}><NativeSettings key={`${workspace}\0${preferences.executablePath}\0${preferences.profile}`} workspace={workspace} models={models} runtimeId={runtimeId} onNativeLogin={onNativeLogin} query={query} section={tab === 'advanced' || tab === 'credentials' ? tab : 'common'} t={t} /></div>
    </div></div></div>
  </div>;
}
