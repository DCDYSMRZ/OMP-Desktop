import type { ConfigEntry, JsonValue, SettingsWriteResult } from '../../shared/contracts';
import { nativeSettingTitles } from './native-setting-titles';

export type SettingsCategory = 'desktop' | 'presence' | 'runtime' | 'common' | 'advanced' | 'credentials' | 'about';
export const commonSettings: Record<string, { name: string; group: string; synonyms: string }> = {
  modelRoles: { name: 'roles', group: 'models', synonyms: '模型 model role default task smol slow plan commit advisor 默认 任务 快速 慢速 计划 提交 顾问' },
  modelRoleStorage: { name: 'storage', group: 'models', synonyms: '模型 model role storage global project 全局 项目' },
  defaultThinkingLevel: { name: 'thinking', group: 'models', synonyms: '模型 model reasoning thinking effort 思考 推理 强度' },
  'tools.approvalMode': { name: 'approval', group: 'tools', synonyms: 'approval permission security yolo 审批 权限 安全 执行' },
  'compaction.enabled': { name: 'compaction', group: 'context', synonyms: 'context compaction compression 上下文 压缩 自动' },
  'compaction.thresholdPercent': { name: 'percent', group: 'context', synonyms: 'context compression threshold percentage 上下文 压缩 阈值 百分比' },
  'compaction.thresholdTokens': { name: 'tokens', group: 'context', synonyms: 'context compression threshold tokens 上下文 压缩 阈值 令牌' },
};
export const curatedAdvancedSettings: Record<string, { name: string; group: string; synonyms: string }> = {
  modelTags: { name: 'modelTags', group: 'models', synonyms: '模型 model tags labels 标签 名称' },
  modelProviderOrder: { name: 'providerOrder', group: 'models', synonyms: '模型 model provider order 提供方 排序' },
  'model.loopGuard.enabled': { name: 'loopGuard', group: 'models', synonyms: '模型 model reasoning loop guard 推理 重复 循环' },
  'model.loopGuard.checkAssistantContent': { name: 'loopProse', group: 'models', synonyms: '模型 model loop prose 正文 循环' },
  'model.loopGuard.toolCallReminder': { name: 'loopReminder', group: 'models', synonyms: '模型 model loop tool reminder 工具 提醒 循环' },
  'model.toolCallLoopGuard.enabled': { name: 'toolLoop', group: 'models', synonyms: '模型 model tool loop 工具 重复 循环' },
  'model.toolCallLoopGuard.threshold': { name: 'toolLoopThreshold', group: 'models', synonyms: '模型 model tool loop threshold 工具 循环 阈值' },
  'model.toolCallLoopGuard.exemptTools': { name: 'toolLoopExempt', group: 'models', synonyms: '模型 model tool loop exempt 工具 循环 豁免' },
};
export const modelRoles = ['default', 'task', 'smol', 'slow', 'plan', 'commit', 'advisor', 'tiny', 'memory'] as const;
// Native login metadata reports availability, not the credential mechanism. This
// curated presentation map separates subscription/OAuth flows from API-key prompts.
const subscriptionProviders: Record<string, true> = { 'openai-codex': true, 'openai-codex-device': true, anthropic: true, 'zai-coding-plan': true, 'github-copilot': true, cursor: true, devin: true, 'google-antigravity': true, 'google-gemini-cli': true, 'xai-oauth': true, 'gitlab-duo': true, 'gitlab-duo-agent': true, 'alibaba-coding-plan': true, 'qwen-portal': true, firepass: true, 'cline-pass': true, 'muse-code': true, perplexity: true };
const localProviders: Record<string, true> = { local: true, ollama: true, 'llama.cpp': true, 'lm-studio': true, apple: true, tiny: true, vllm: true };
export function providerGroup(provider: { id: string; authenticated: boolean }): 'configured' | 'login' | 'api' | 'local' {
  if (provider.authenticated) return 'configured';
  if (Object.hasOwn(localProviders, provider.id)) return 'local';
  return Object.hasOwn(subscriptionProviders, provider.id) ? 'login' : 'api';
}
export function settingGroup(key: string): string {
  if (Object.hasOwn(commonSettings, key)) return commonSettings[key].group;
  if (/^(theme|symbolPreset|colorBlindMode|composer|statusLine|terminal|tui|display|showHardwareCursor|hideThinkingBlock|doubleEscapeAction|treeFilterMode|autocompleteMaxVisible|spelling|emojiAutocomplete|paste|completion\.notify|error\.notify|ask\.notify|task\.showResolvedModelBadge|goal\.statusInFooter|git\.enabled)/.test(key)) return 'terminal';
  if (/^(task|tasks|subagent|advisor|async|isolation|worktree|todo|plan|goal|loop|steeringMode|followUpMode|interruptMode)/.test(key)) return 'tasks';
  if (/^(model|enabledModels|enabledProviders|disabledProviders|cycleOrder|defaultThinking|thinking|proseOnlyThinking|omitThinking|externalThinking|temperature|topP|topK|minP|presencePenalty|repetitionPenalty|textVerbosity|tier|provider)/.test(key)) return 'models';
  if (/^(compaction|context|extendedContext|snapcompact|branchSummary)/.test(key)) return 'context';
  if (/^(memory|memories|hindsight|mnemopi|sharpshooter|autolearn)/.test(key)) return key.split('.')[0].replace(/^memories$/, 'memory');
  if (/^(retry|network|proxy|http|web|searxng|auth|exa|fetch|browser|collab|share|stream)/.test(key)) return 'network';
  if (/^(startup|setupVersion|autoResume|update|marketplace|prewalk|power|recap|workspace)/.test(key)) return 'startup';
  if (/^(extensions|disabledExtensions|skills|commands|extensionHandlers|mcp)/.test(key)) return 'extensions';
  if (/^(tools?|bash|shell|exec|lsp|approval|edit|read|grep|glob|ast|find|debug|launch|checkpoint|security|ask|eval|python|computer|vault|github|ida|secrets)/.test(key)) return 'tools';
  if (/^(images|speech|speechgen|generate_image|live|tts|stt)/.test(key)) return 'media';
  if (/^(include|inlineTool|skillful|personality|magicKeywords|ttsr)/.test(key)) return 'prompts';
  if (/^(dev|telemetry|features|gc|commit|title|codexResets|claudeResets)/.test(key)) return 'maintenance';
  // Future namespaces retain their own home rather than growing an opaque Other bucket.
  return `namespace:${key.split('.')[0]}`;
}
export interface SettingSearchRow { key: string; category: SettingsCategory; label: string; help: string; group: string; synonyms: string; nativeDescription?: boolean }
export function indexDesktopSettings(translate: (key: string) => string): SettingSearchRow[] {
  const rows: [string, SettingsCategory, string, string, string?][] = [
    ['language', 'desktop', 'omp.settings.language', 'language locale 语言'],
    ['fontFamily', 'desktop', 'omp.settings.fontFamily', 'font typeface 字体 外观', 'omp.settings.useAFontInstalledOnThisComputerOrA'],
    ['fontSize', 'desktop', 'omp.settings.fontSize', 'font size 字号 大小'],
    ['messageMeta', 'desktop', 'settings.messageMeta', 'footer metadata hover always 消息 详情 悬停 始终', 'settings.messageMetaHelp'],
    ['durationStyle', 'desktop', 'settings.durationStyle', 'elapsed time clock units 耗时 时间 时钟', 'settings.durationStyleHelp'],
    ['notifications', 'presence', 'shell.notifications', 'notification 通知', 'shell.notificationsHint'],
    ['preferredEditor', 'desktop', 'objects.preferredEditor', 'editor vscode cursor zed 编辑器'],
    ['enterToSend', 'desktop', 'omp.settings.enterToSend', 'input enter send 输入 发送', 'omp.settings.whenEnabledShiftEnterInsertsANewlineOtherwiseUse'],
    ['terminalPresence', 'presence', 'settings.terminalPresence', 'terminal presence session 在场 终端 会话', 'settings.terminalPresenceHelp'],
    ['runtimeStatus', 'runtime', 'omp.settings.runtimeStatus', 'health version connection 健康 版本 连接'],
    ['executablePath', 'runtime', 'omp.settings.executablePath', 'path executable 路径 可执行文件', 'omp.settings.leaveBlankToDiscoverInstalledOmpBrowseSelectsA'],
    ['profile', 'runtime', 'omp.settings.nativeProfile', 'profile 配置', 'omp.settings.exactNativeProfileNameBlankUsesOmpSDefault'],
    ['lastWorkspace', 'runtime', 'omp.settings.defaultWorkspace', 'workspace folder 工作区 目录', 'omp.settings.desktopPreferenceForSubsequentWorkspaceSelectionItDoesNot'],
    ['about', 'about', 'settings.about', 'license credits LGPL Apache 许可 致谢'],
  ];
  return rows.map(([key, category, label, synonyms, help]) => ({ key, category, label: translate(label), help: help ? translate(help) : '', synonyms, group: translate(category === 'desktop' ? 'omp.settings.appearanceInput' : category === 'runtime' ? 'omp.settings.localRuntime' : 'settings.about') }));
}
export function indexNativeSettings(entries: readonly ConfigEntry[], translate: (key: string) => string): SettingSearchRow[] {
  return entries.map(entry => {
    const common = Object.hasOwn(commonSettings, entry.key);
    const known = common ? commonSettings[entry.key] : Object.hasOwn(curatedAdvancedSettings, entry.key) ? curatedAdvancedSettings[entry.key] : undefined;
    const group = settingGroup(entry.key);
    const translatedGroup = translate(`settings.group.${group}`);
    return { key: entry.key, category: entry.credential || entry.redacted ? 'credentials' : common ? 'common' : 'advanced',
      label: known ? translate(`settings.${known.name}`) : translate(`settings.native.${entry.key}`) === `settings.native.${entry.key}` ? entry.key : translate(`settings.native.${entry.key}`), help: known ? translate(`settings.${known.name}Help`) : entry.description,
      nativeDescription: !known && !!entry.description,
      group: translatedGroup === `settings.group.${group}` ? group.replace('namespace:', '') : translatedGroup, synonyms: `${known?.synonyms ?? ''} ${nativeSettingTitles[entry.key]?.join(' ') ?? ''} ${entry.type} ${entry.description}` };
  });
}
export function searchSettings(rows: readonly SettingSearchRow[], query: string): SettingSearchRow[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => { const text = `${row.key} ${row.label} ${row.help} ${row.group} ${row.synonyms}`.toLocaleLowerCase(); return terms.every(term => text.includes(term)); });
}
export function highlightSetting(text: string, query: string): { text: string; match: boolean }[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return [{ text, match: false }];
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(pattern).filter(Boolean).map(part => ({ text: part, match: terms.some(term => term.toLocaleLowerCase() === part.toLocaleLowerCase()) }));
}
export function stringRoleRecord(value: JsonValue | undefined): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string');
}
export type SettingProvenance = 'unknown' | 'global' | 'project' | 'environment' | 'override';
// config list reports effective values, not their source. Only write receipts are evidence.
export function receiptProvenance(result: SettingsWriteResult, reset: boolean): SettingProvenance {
  if (result.fallbackEnv) return 'environment';
  if (result.overriddenBy === 'project') return 'project';
  if (result.overriddenBy === 'overlay' || result.overriddenBy === 'runtime') return 'override';
  if (result.overriddenBy) return 'environment';
  return reset ? 'unknown' : 'global';
}
