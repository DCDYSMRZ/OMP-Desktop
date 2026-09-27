# OMP-Desktop 第三方归属与许可通知

本项目包含原有项目的复制/修改版本和第三方依赖。产品更名、替换运行时或删除功能不会消除原作者权利，也不构成宽松重新许可。以下改编记录日期为 **2026-09-27**；完整条款以各许可原文为准。除许可明确规定外，软件按原样提供、不附带保证；名称与图像归属不代表上游作者为本派生产品背书或授予商标权。

## 1. 主视觉与前端：PI-Desktop

- 来源：[vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)，本地参考快照目录 `PI-Desktop-main`。上游项目及其贡献者保留各自代码、样式与素材权利；不将仓库所有者身份误写成全部素材的唯一作者。
- 上游 README 明确采用 GNU Lesser General Public License v3.0，根 LICENSE 为 Version 3。未据此推定额外的 or-later 授权，本项目 manifest 使用 `LGPL-3.0-only`。
- 根 [LICENSE](LICENSE) 与 [licenses/LGPL-3.0.txt](licenses/LGPL-3.0.txt) 保留上游 LGPL 全文；[licenses/GPL-3.0.txt](licenses/GPL-3.0.txt) 提供 LGPL 所引用的 GPLv3 全文，来自 [GNU 官方文本](https://www.gnu.org/licenses/gpl-3.0.txt)。
- 修改性质：保留原有展示结构与视觉资源，产品品牌改为 OMP-Desktop，移除 PI runtime/store/API、插件与额外业务耦合，改用受限 DesktopApi 与外部原生 omp。原有源文件通知保留；新增适配不是对原作的重新授权。

### 已确认改编映射

源路径除另注外均相对 `PI-Desktop-main/apps/desktop/src/`；目标相对本项目根。映射记录实现负责人报告的实际复制/改编，不把只读研究建议当成已复制代码。

| 原始来源 | OMP-Desktop 目标 | 改编内容 |
| --- | --- | --- |
| `components/{ui,icons,ContextMenu,HomeMascotLogo,BrandLogo,Markdown,MarkdownTable}.tsx` | `src/renderer/ui/` 同名组件 | 公共控件、图标包装、首页组合、Markdown/代码/数学/图表/表格；替换 store/API/文件及链接边界 |
| `components/settings/{AnchoredMenu,SettingsMenuSelect}.tsx` | `src/renderer/ui/` 同名组件 | 菜单与键盘交互 |
| `features/settings/primitives.tsx` 的 SettingsRow/Card | `src/renderer/ui/SettingsPrimitives.tsx` | 去除 PI 专用设置类型，仅保留呈现 primitives |
| `styles/` 中实际保留的 CSS | `src/renderer/styles/` | 原始级联顺序、tokens 与保留表面样式；未引入已删除的插件/voice 专用样式 |
| `lib/` 的 Markdown 分块/源码/表格/图片/链接、LaTeX、Shiki/Mermaid、portal/context-menu、selection-tex、scrollbar、minimap、resize/reorder helpers | `src/renderer/lib/` 对应文件 | 保留展示算法，切断 PI 业务执行依赖 |
| `lib/fonts.ts` 的纯字体定义/格式化部分 | `src/renderer/lib/fonts.ts` | 保留系统字体栈，去除 PI 系统字体枚举 API |
| `PI-Desktop-main/packages/i18n/src/` 九种语言目录 | `src/renderer/locales/` | 保留翻译资源，产品字面量改为 OMP-Desktop；不因此启用被删除功能 |
| `features/app/AppShell.tsx` | `src/renderer/App.tsx` | 原主布局接入新 DesktopApi controller |
| `components/Sidebar.tsx` | `src/renderer/app/Sidebar.tsx` | 项目/原生会话呈现，移除 PI 存储业务动作 |
| `components/{ConversationTopbar,WindowControls,Toast}.tsx` | `src/renderer/app/Chrome.tsx` | 标题栏、窗口操作与通知布局 |
| `components/{SearchDialog,SessionRenameDialog}.tsx` | `src/renderer/app/Dialogs.tsx` | 原对话框外观接入真实历史/改名行为 |
| `features/settings/SettingsPage.tsx` | `src/renderer/settings/SettingsPage.tsx` | 全页 shell/rail/search/content 布局；原生设置表单逻辑另行实现 |
| `components/workpanel/WorkPanel.tsx` | `src/renderer/workspace/WorkPanel.tsx` | 面板 tabs、调整宽度与最大化；删除插件视图 |
| `components/workpanel/FilesTab.tsx` | `src/renderer/workspace/FilesTab.tsx` | 只读工作区文件浏览/预览 |
| `components/workpanel/SubagentTranscriptTab.tsx` | `src/renderer/workspace/SubagentTranscriptTab.tsx` | 使用原生 subagent transcript 与字节游标 |
| `components/ReviewChangeCard.tsx` | `src/renderer/workspace/ReviewChangeCard.tsx` | 保留 diff 卡片 DOM，使用当前 Git 差异，不使用 PI 回滚快照 |
| `PI-Desktop-main/apps/desktop/electron.vite.config.ts` | `electron.vite.config.ts` | 主进程/沙箱 preload CJS 构建入口结构 |
| `components/ChatSurface.tsx`、`ConversationWidthHandles.tsx` | `src/renderer/chat/ChatView.tsx` | 首页/会话展示和内容宽度控制 |
| `components/Composer.tsx`、`features/chat/composer/{ComposerInput,ComposerToolbar}.tsx` | `src/renderer/chat/Composer.tsx` | 保留 contenteditable/IME、输入与工具栏结构；绑定原生发送/队列 |
| `features/chat/transcript/{MessageRow,AssistantTurn,ToolRow}.tsx` | `src/renderer/chat/Transcript.tsx` | 保留消息/工具结构，投影原生消息与 toolCallId |
| `features/chat/composer/{editor,native-deletion}.ts` 与 ComposerFileReference 类型 | `src/renderer/chat/composer/` 对应文件及 `model.ts` | 文件引用编辑/删除算法；去除 PI 类型依赖 |
| `lib/assistant-turns.ts`、`lib/turn-process.ts` | `src/renderer/chat/presentation.ts` | 参照 user-level turn 与过程/最终正文划分，适配原生多请求片段；未导入 PI UiMessage/store |
| `features/chat/transcript/{TurnProcess,shared,AssistantTurn}.tsx` | `src/renderer/chat/Transcript.tsx` | 过程/思考的独立折叠、collapse rail、延迟正文、prose-chat 包装与过程/回复位置；不是整套 PI disclosure framework 移植 |

历史修正继续在上述派生展示表面上修改：只读历史/会话树接入既有 ChatView、Transcript、Composer、Modal 与 Button；`src/renderer/app/history-store.ts` 与会话树控制为本项目的原生历史集成，不代表另行复制完整 PI 历史数据层、运行时或额外素材。独立历史状态面板已移除，访问状态复用 composer/TooltipButton，树入口复用会话菜单；标题/列表及过程折叠修正不改变既有 LGPL 来源归属。

上述新增来源映射是展示语义与结构的原生数据改编，不是整文件照搬。用量格式化、原生块顺序/工具结果适配、durable ID 与历史分页/阅读位置保持为独立 OMP 集成；没有另行复制 PI 用量组件。

### 素材与字体

以下六个上游素材按原始字节复制到 `src/renderer/assets/`：

- `brand/logo-dark.png`、`brand/logo-light.png`；
- `home-mascot-dark.gif`、`home-mascot-light.gif`；
- `home-mascot-still-dark.png`、`home-mascot-still-light.png`。

macOS 应用图标另按原始字节复制：`PI-Desktop-main/apps/desktop/build/icon.icns` → `build/icon.icns`，由 `electron-builder.yml` 的 `mac.icon` 使用。来源仍为 vastsa/PI-Desktop 及其贡献者，按主项目 LGPLv3 归属保留，不是本项目新生成的图像；本次未复制 Windows icon.ico。

原目录未提供独立素材作者/许可通知；本项目将其按上游项目许可与归属保留，**不另行宣称公有领域、CC0 或独占所有权**。产品品牌文字变化不改变素材来源。不捆绑自定义 UI 字体，使用系统安装字体；KaTeX 数学字体属于其包资源，通知见依赖许可集合。Lucide 图标属于 Lucide/Feather 作者，而非新绘制 OMP 图标。

## 2. 进程发现与传输算法：pi-desktop

- 来源：[FaqFirebase/pi-desktop](https://github.com/FaqFirebase/pi-desktop)，本地参考 `pi-desktop-master`。
- **Copyright 2026 HighlandJewls, PikkonMG, FaqFirebase**
- Licensed under the Apache License, Version 2.0. 完整上游许可和署名保存在 [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)。本次检查未发现该参考项目另附的 NOTICE 文件。

| 原始来源 | 目标 | 2026-09-27 修改 |
| --- | --- | --- |
| `src/main/pi-binary-resolution.ts` | `src/main/omp/discovery.ts` | GUI login-shell sentinel PATH 恢复、PATH 合并与候选策略；仅发现外部 omp，不保留 Pi fallback |
| `src/main/pi-rpc-manager.ts` 的 RpcFrameDecoder 算法 | `src/main/omp/framing.ts` | 原生 v2 chunk/UTF-8/字节边界校验，受限缓冲和显式错误；不照搬混合引擎 manager |

这两个改编文件保留 Apache 原作者与修改通知。其余新的 host/preload/lifecycle 代码不因参考架构就被记为整文件复制。第二参考不取代主视觉，也不允许将 LGPL 派生前端整体改标为 Apache/MIT。没有复制桌面权限注入扩展、Pi 内核、混合引擎历史或独立认证业务。

## 3. 外部 oh-my-pi

运行时为用户单独安装的 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)，不是本包内依赖副本。其源码用于核对协议、原生目录/会话格式与设置 metadata；`src/main/data/` 为本机适配，不复制 PI 数据层。JSONL/gzip 只读历史、临时 SQLite 元数据、保存子任务/资源及 Darwin 占用观察属于桌面适配；明确续写/fork 仍调用真实原生 `--resume` / `--fork`，认证登录也转交原生，不是随桌面分发的修改版内核。此次未修改 oh-my-pi 源码或用户安装，18.3.2 的 session_start 同步 UI 超时仍保留。运行时及用户另装工具/扩展许可由各自发行物保留，不由本项目覆盖。

## 4. 前端包与传递依赖

实际安装版本、包声明许可、作者、仓库和原始通知文件名记录在 [licenses/frontend-dependencies.json](licenses/frontend-dependencies.json)。完整原始 LICENSE/COPYING/NOTICE/AUTHORS 文本收集于 [licenses/frontend-dependencies.txt](licenses/frontend-dependencies.txt)。采集范围是使用到的前端直接包及其已安装声明依赖的**保守超集**，不是声称其中每个包的全部代码都进入最终 bundle。

主要包族包括 React/ReactDOM、i18next/react-i18next、Lucide、react-markdown/unified/remark/rehype、KaTeX、Shiki、Mermaid、DOMPurify、pinyin-pro、Zustand、Tailwind 及它们的依赖。不能因为 manifest 将其列为 devDependencies 就遗漏打包进 renderer 的许可。各包保持自身许可；这份列表不是把它们统一重新许可为 LGPL。特别保留：

- Lucide 原包 LICENSE 中的 ISC 与 Feather/MIT 署名；
- KaTeX 原包 MIT 通知及打包的数学资源归属；
- DOMPurify 原包 LICENSE 与 LICENSE-MPL 双重许可文本；
- Mermaid/D3 等可视化包及其传递依赖各自通知。

四个包没有独立根 LICENSE 文件，补充来源如下：

- `remark-math@6.0.0`、`rehype-katex@7.0.1` 的已安装 README 声明 MIT、署名 Junyoung Choi，并链接同一上游 [license](https://github.com/remarkjs/remark-math/blob/main/license)；该文本保存在 [licenses/remark-math-LICENSE.txt](licenses/remark-math-LICENSE.txt)。下载日期 2026-09-27，来源为 README 链接的 main 文本，不宣称特定 release tag 已核对。
- `fastdom@1.0.12` 的 README 内嵌 MIT 全文（Copyright (c) 2016 Wilson Page），保存在 [licenses/fastdom-LICENSE.txt](licenses/fastdom-LICENSE.txt)。
- `strictdom@1.0.1` 的 README 内嵌 MIT 全文（Copyright (c) 2013 Wilson Page），保存在 [licenses/strictdom-LICENSE.txt](licenses/strictdom-LICENSE.txt)。

依赖升级后需要依据新锁文件刷新通知，不能把当前快照当成所有未来版本的授权清单。

## 5. Electron 与 Chromium

已安装 Electron **43.7.5** npm 包的 MIT 文本保存在 [licenses/Electron-LICENSE.txt](licenses/Electron-LICENSE.txt)。二进制下载完成后，另从实际 `node_modules/electron/dist/` 原样保存 [licenses/Electron-binary-LICENSE.txt](licenses/Electron-binary-LICENSE.txt) 与完整 [licenses/LICENSES.chromium.html](licenses/LICENSES.chromium.html)；后者保留 Chromium 及其第三方组件的通知，不能只用 Electron MIT 文本代替。版本由该目录的 `version` 文件确认。

2026-09-27 采集的文件内容校验值：Electron binary LICENSE 为 1,096 字节，SHA-256 `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`；Chromium 通知为 19,956,022 字节，SHA-256 `7ae82e97b8a60b9d97871e0e11a05285aea2d42bef665f93f6a4f415235839ed`。这证明通知采集来源与版本，不证明应用窗口、打包产物启动或发布合规已通过。

## 6. 再分发注意事项

`electron-builder.yml` 将根 LICENSE、本文和 `licenses/**` 列入本地包。实际打包 `app.asar` 已确认包含 LGPL LICENSE、完整 Chromium 通知与前端依赖清单；应用图标与来源校验一致。具体成品证据及未覆盖边界见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

分发派生源码时保留适用的原版权、许可与修改说明。分发二进制/组合作品时，依适用 LGPL/GPL 条款提供对应源码、构建/安装及重新组合或重新链接所需材料，并保留接收者修改和调试这些修改的权利；不能以打包/签名方式剥夺许可授予的权利。最直接的源码提供方式是与特定二进制一起提供匹配的完整源代码、锁文件、构建配置与本文。对外发行者仍需审查其具体发行方式的合规要求。
