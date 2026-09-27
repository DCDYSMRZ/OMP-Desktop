# OMP-Desktop 验证记录

## 环境与结论

2026-09-27，在 macOS 25.6.0 / Apple Silicon arm64 上使用 Electron 43.7.5、pnpm 10.34.5 与实际安装的 omp 18.3.2 验证。下文区分早期原生适配和后续历史修正；早期 32 项回归及旧截图不是后续产物的完整验收记录。

原生运行使用隔离 HOME/workspace/userData 和确定性的本机 OpenAI-compatible HTTP fixture（`desktop-fixture/desktop-smoke`）。**omp 进程、原生工具、子代理、持久化与 Electron 窗口是真实执行；模型端是测试 fixture，不代表真实商业/远程服务商、用户认证或模型质量已验证。** 未读取或修改真实用户认证/配置以构造场景。

## 早期原生适配：构建与原生运行

| 检查 | 实际结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm test` | 早期联合记录 136 成功，32 tests passed |
| 生产构建 / `env CSC_IDENTITY_AUTO_DISCOVERY=false npx --yes pnpm@10.34.5 run pack` | 成功生成 `release/mac-arm64/OMP-Desktop.app`；identity=null，未签名、未公证 |
| 冻结依赖安装 | `pnpm install --frozen-lockfile` 成功，锁文件已是最新，根 `install-electron` postinstall exit 0 |
| Electron 安装器 | `pnpm exec install-electron` exit 0；实际 dist/version 为 43.7.5 |
| 原生协议与 service smoke | 记录 84 exit 0：v2、流式、read、ask/select、取消、abort、task/subagent、字节游标、持久化及重启；provider rejection 0、unexpectedDisconnect 0、expected aborts 2 |
| 首次无模型配置 | 通过：空 profile、临时 wrapper 转发真实 omp 并仅限制其出站网络，实际 UI 显示原生 No models available、认证/模型与中文 setup 引导以及设置/检查安装/重启入口 |
| 正常退出 / owned 子进程清理 | 通过：生产 `window.ompDesktop.windowAction('close')` 触发真实窗口关闭流程；主 PID 66822 及四个 owned 子进程 66837/66838/66840/67003 均消失，ps 无输出/exit 1，service exit 0 |

原生 smoke 首次记录 74 曾因 provider 请求计数未涵盖原生 child label 请求而 exit 1，补全核对后的完整记录 84 已通过。构建仍报告大于 500 kB 的 chunk 警告；highlight 选择器存在优化器警告，但实际 Chromium 中 `CSS.supports('selector(::highlight(transcript-search))')` 为 true。后者不代表所有搜索行为已验证。

记录编号（如 84、136）对应本次集成会话的 `artifact://` 证据，不是公开下载链接。

无模型专项使用项目外的临时 OS 网络隔离 wrapper，仅转发真实 omp 并限制其出站网络，配合空原生 profile；未改变 Electron 安全设置或 renderer sandbox，也未停止用户本地模型服务。首次仅空 HOME 的尝试自动发现了本地无认证模型，未向它发送推理；该尝试不计入无模型覆盖。关闭测试覆盖实际窗口关闭 handler；CDP 合成 Cmd+Q 不是有效的原生菜单测试，不据此宣称 Cmd+Q 已验证。

## 早期原生适配：实际打包窗口交互

- **运行时与聊天：** 识别 omp 18.3.2；Home 发送 `SMOKE_TEXT` 并流式呈现；原生 read 返回 `READ_OK`；真实 ask 对话框选择 Continue 后收到结果；慢速流点击 Stop 后回到 idle。
- **子代理：** 原生 task 返回 `TASK_OK`，面板可见完成的子代理 transcript；原生 smoke 同时覆盖 byte cursor。
- **设置：** 暗色主题持久化；zh-CN→English 改变主侧栏/聊天标签。UI 保存 `temperature=-1` 与 `modelRoles.default`，隔离 `config.yml` 确认落盘；保存期间 Back→Settings 未丢失，随后恢复原值。
- **工作区：** `/var` 与 `/private/var` 指向同一物理目录时仅显示一个工作区组，不再按路径别名重复分组。
- **面板：** 1312×768 窗口下 panel=480、main=572；键盘 Home 调整至 244，鼠标恢复 480。关闭文件 tab、再关闭/打开面板，Git 选择保留，已关文件 tab 不复活。
- **文件与 Git：** 文件链接打开真实 fixture 文本；Git 面板显示实际补丁 `+Desktop diff verification.`。
- **拖放附件：** Chromium File drop 产生 chip；受理发送后 chip 清除；原生 journal 的 user entry 包含 `ATTACHMENT_FINAL` 及逐字 UTF-8 文件正文。
- **中文工作面板：** 最终 `.app` 实际显示“新建 / 放大 / 关闭面板 / 文件 / 当前 Git 更改”。

早期真实窗口截图：[子代理详情](screenshots/subagent.webp) · [文件预览](screenshots/file-preview.webp) · [Git 差异](screenshots/git-diff.webp) · [无模型错误与中文配置引导](screenshots/no-model.webp) · [原生启动扩展超时](screenshots/startup-limitation.webp)。它们不是组件预览、模拟界面或概念图，也不作为后续历史修正界面的截图证据。

## 后续历史修正：隔离原生与打包窗口实测

历史修正应用暂存于 **`release/history-fix/mac-arm64/OMP-Desktop.app`**，不覆盖用户正在运行的旧 `release/mac-arm64/OMP-Desktop.app`。常规 `pnpm run pack` 的输出目录仍为 `release/` 下的平台目录；`pnpm pack` 不是该桌面脚本。记录 199 已完成类型检查、83 项回归（83 passed / 0 failed / 0 skipped）、构建与 mac-arm64 未签名打包。随后协调修正后的记录 223 再次完成类型检查、同样 83 项回归、构建与未签名打包；重新启动了该产物。构建通过和单张窗口截图不等于全部交互/布局验收完成。

以下均由编排者在隔离 HOME/workspace/userData 中运行真实已安装 omp、真实 `.app` 和本机模型 fixture 观察；不是仅根据源码或 mock 推断。原生源码、安装及真实用户会话/认证未为此修改。

| 场景 | 已观察结果 |
| --- | --- |
| 只读历史与树 | 打开历史没有模型请求，原 JSONL 字节保持不变；打开树后源文件 hash 不变 |
| 原生终端空闲占用 | 终端仍在提示符时 access=external，草稿可编辑而 Send 持续禁用；直接调用主进程 startSession 也拒绝外部占用 |
| 持久化跟随 | 原终端经真实 PTY 发送的消息自动出现在查看器；Send 仍禁用，桌面草稿保留；仅证明已落盘记录跟随 |
| 正常退出与接管 | 原终端 Ctrl+D 正常 exit 0 后虽有陈旧 breadcrumb，access 变为 idle、Send 启用；明确续写落盘到同一个原 session ID，clear 前历史仍在 DOM |
| 显式 fork | 原生 `--fork` 创建不同 session ID 并带 parentSession，源文件未变；发送实际到达 omp 与本机模型 fixture |
| PI 风格正文/过程 | 实际 h2 为 18px / 600；无序列表为 disc、缩进 19.6px；思考片段呈紧凑过程，用量摘要 `$0.30 / 431.7K` 属于请求范围，不是会话累计 |
| 旧标题区阶段复验（记录 223） | 当时的窗口显示正常文档流中的标题/工作区、紧凑只读状态与操作入口；该独立状态/Continue 面板现已被 composer 绿/红图标取代，不作为当前最终界面示例 |

此前用户截图确认过跳转按钮文字竖排、历史状态/续写/树入口被遮挡的问题，推动了后续输入区状态与导航修正。记录 199/223 和旧顶栏截图只证明对应阶段；不能把 83 项回归或旧底部截图当成当前完整体验验收。

## 当前桌面体验集成：源码与实际窗口证据

最终源码记录 **562** 的类型检查与 **154 项测试通过**，最新应用打包记录 **564**。新包完成下述列明的隔离窗口重放，不从测试通过推定全界面完成。此前记录 512 为 150 项通过；记录 336 曾为 130 项中 128 通过、2 失败，保留其阶段差异，不把旧失败记录改写为全通过。目标平台仍仅为本机未签名 mac-arm64，不是签名公证发行验收。

### 编排者的隔离原生/历史窗口实测

| 场景 | 已观察结果及范围 |
| --- | --- |
| gzip 归档完整正文 | 12 个问题和全部 12 个回答可读，最后一段叙述可经既有过程折叠访问；3 个压缩摘要及 reset 保留 |
| 树的旧节点查看 | 选中较早节点只显示其较早祖先链；来源 hash 不变，只读期间 provider 请求计数不变 |
| 真实原生子任务 | 实际 3 子任务运行中 A/B 完成、C 失败；修复后保存 UI 重建相同结果，C 的原生提醒折叠，错误和任务说明可见。不据此宣称所有 live/reopen/fork 组合通过 |
| 保存图片与签名 | 两张各 7 MiB 的保存图片通过内联及受限按需入口解码为 1024×599；2 MiB 隐藏签名不再掩盖可见正文 |
| 长子会话分页 | 240 条消息可访问 0…239；前插分页阅读锚点偏移由约 159 px 改善到 0.03125 px |
| 归档 fork 草稿/附件 | 保留 FINAL_ARCHIVE_FORK_DRAFT 与真实拖放 branch-attachment.txt；取消确认保留二者并恢复状态图标焦点。明确 Create new branch 后 provider 计数仍为 37，gzip hash 不变，没有自动发送 |
| fork 后明确发送 | 点击已观察到的、可访问名称精确为“发送”的 Send 控件后，实际本机模型请求 37→38；原生落盘 UTF-8 附件正文，显示 HISTORY_NATIVE_REPLY，提交的草稿清空。泛用“发送”选择器可能匹配状态解释，未据错误目标宣称通过 |
| 先前主历史分页/跳转 | 真正滚轮触顶后 200→400 行保留 p0000260 在 0.086 px 内、400→460 行保留 p0000060 在 0.242 px 内；460 行时更早入口消失。跳转 32×32、单 SVG、无可见文字，点击回最新且保留 460 行。该次截图仍含旧顶栏，不作为最终示例 |

owned archive fork 曾丢失保存子任务卡片，现已由最新包实际复验解决：连续原生 fork 后仍有 **20 个保存子任务**，打开复制的子日志可读 **40…239**，不增加 provider 请求，原保存草稿/附件保留。随后恢复该会话并运行 **3 个真实原生子任务**，与 20 个保存任务合并后恰好 **23 张卡片**；实时 C 可见，释放后 A/B 完成、C 失败。断开后只读重开仍恰好 23 张卡片，无不支持命令错误，provider 计数在重开期间保持 **69**。这是保存/实时合并与重开证据，不仅是原先的草稿交接通过。

最新包还重放了终端占用边界：原外部终端仍停在真实提示符；两个空闲的保存兄弟会话显示绿色原会话发送状态，实际被外部终端持有的来源显示“已在其他进程打开”、Send 禁用及明确归属原因。查看三个来源期间 provider 计数保持 69；没有为通过验收终止该终端或向模型发送请求。

### 独立打包窗口审查

VisualNavigationProof 在暂存包的独立隔离窗口实际调整原生窗口：宽 1312×769（恢复后 1312×768）与最小 900×600，亮/暗四种组合无页面横向溢出。工作面板/侧栏关闭重开、最小窗口自动收起侧栏、真实滚轮、minimap 点击/Enter 导航、32×32 SVG 跳转回最新、Cmd+K 搜索输入/选择/Escape 焦点恢复与 Tab 圈定均有观察。长代码仅自身横向滚动；保存工具过程展开显示真实 read 结果。已挂载窗口切换 reduced-motion 时，跳转动画和 marker transition 随之缩短/禁用；不外推到未测流式动画。

初次审查发现过 900×600、面板打开时底部 minimap 预览覆盖 composer/跳转区域（约 72.52 px）。**最终新包 18 个首/中/末 marker 重放场景已解决该遮挡**：900×600 与 1312×768，空输入和真正 Shift+Enter 输入的 12 行草稿，面板打开/关闭/重开；每项均操作 hover 与 focus，二者预览矩形一致。最小窗口、面板打开时末项预览与跳转按钮留 **8 px** 间距，空/12 行 composer 分别有约 **51.81/51.63 px** 净空；所有预览在 rail/chat-pane 范围内、标题之下、composer 之上。真实滚轮后完整圆形/箭头可见，中心命中 Jump to latest，实际点击回到底部（0 至 −1 px 舍入）并移除按钮；聚焦 marker 的 Enter 导航也执行。没有宣称 1440×960、完整键盘滚动或 WCAG 目标尺寸合规；较早 PageUp 观察仍不计通过。

SettingsComposerProof 独立窗口实际读取原生设置，验证常用/折叠高级分组与搜索空状态；compaction.enabled 经真实 CLI 修改、读盘确认、明确 reset 删除键后重读，其他原生值保留。非法 thinking 枚举被原生拒绝且原值不变；隔离配置损坏显示错误，修复其自有 fixture 后重读恢复。测试 token 仅显示 Configured · hidden，DOM 没有该秘密；未配置项有明确状态，断开运行时时登录禁用。

该窗口还操作了 slash 命令目录、上下键/Tab 插入而不发送、@ 文件选择与空结果、Escape 焦点恢复、Shift+Enter 换行及失败发送保留文字。通过浏览器合成 clipboard 事件走真实 renderer/主进程授权路径：拒绝文本文件剪贴板、10 MiB+1 PNG 和签名不匹配图片；有效 PNG 接受，预览 Escape 返回触发器。合成事件不等于所有 OS 剪贴板组合均验证。fork 确认框 Escape 可取消并恢复状态图标焦点。

初次审查曾因无关终端的缺失/陈旧 breadcrumb 阻止新建 owned 会话，且未持久来源错误提供 fork 后触发 ENOENT；当时草稿保留、provider 为 0，不能把那次失败记成成功。**最终同一隔离 fixture 的新包重放已通过新建与持久会话两次实际发送**：第一请求为 proof-alpha / reasoning_effort=low；界面选择 Proof Beta 和 medium 后，第二请求实际为 proof-beta / medium。恰好两次 provider 请求，两条真实回复可见；两次点击后草稿先保留、受理后才清空。第一回复、模型/思考修改、第二回复及 settled 最终检查均无 get_subagents 刷新错误。该 fixture 故意保留旧失败包留下的未保存 registry，因此侧栏仍明确显示那条旧来源 ENOENT；未删除证据来隐藏错误，它不阻止两次发送。

### 最终重放范围与截图

- 新建/持久会话发送与模型/思考级别变化以真实本机 provider 请求读回为证，不只是 chip 文案变化；此前 picker 的 Tab/搜索/Escape/焦点专项记录保留，不将全部快捷键推定通过。
- 窄/宽窗口 minimap、真实 12 行 composer、面板变化及 jump 行为已按上述 18 场景重放；不是静态几何检查代替实际点击。
- repeated fork 的 20 个保存任务、与 3 个真实原生任务合并后的 23 张卡片，以及断开/只读重开已实际验证；无旧 get_subagents 不支持错误。
- 本次列明的功能验收与最终重放已完成；这不把临时 SQLite、资源/恢复区域、认证/审批的全部源码边界外推为全 GUI/服务商矩阵证据。真实 OAuth、完整平台/IME/快捷键矩阵仍未验证。

最终实际窗口截图：[窄窗口 12 行输入、minimap 预览与跳转净空](screenshots/final-minimap-narrow12.png) · [两次真实本机回复与 Beta/medium 读回](screenshots/final-model-thinking-send.png) · [23 子任务会话重开后的保存子任务详情](screenshots/final-saved-children.png)。均为隔离 fixture 的真实窗口，按原始字节复制，不是组件或概念预览。第二张保留旧 fixture registry 的真实 ENOENT 诊断，不是此次两次发送失败；第三张展示真实原生任务与保存任务共存后的重开及受限子日志详情，不把 fixture 正文当成真实用户会话。

### 最终交付与验收清理

交付为记录 564 的本机未签名 `release/history-fix/mac-arm64/OMP-Desktop.app`，与记录 562 的类型检查/154 项测试及上述最终窗口证据对应，不覆盖用户原来运行的旧应用。所列功能验收已完成；原生上游限制、平台/OAuth 和发行合规边界仍按下文保留。

编排者已停止自有 `omp-experience-release`、`omp-composer-terminal` 及端口 64146 的本机模型服务，释放四个受管浏览器句柄；`browser.tabs()` 返回空。两个独立验收者亦确认自有应用/模型服务已停止。对 57841、57842、57853、57844、64146 的最终 lsof 检查均无监听者（exit 1、无输出）。原 gzip 的最终 SHA-256 仍与验收前一致。仅 OMP-Desktop 项目源码/产物/文档、自有临时验收目录和基础设施输出受影响；未终止无关进程，未更改真实原生安装、用户配置/认证或原始用户数据。




## 早期成品资源与许可

- 原始与 `.app` 内应用图标 SHA-256 一致：`5077858234a590cb9d4885f99a12229d7514e8978f6cf2afc17b1098cbdc9ddf`。
- 实际 `app.asar` 已确认包含 LGPL `LICENSE`、完整 `licenses/LICENSES.chromium.html` 与 `licenses/frontend-dependencies.json`。
- Electron 二进制通知副本与 dist 原件 SHA-256 一致；266 个已安装前端包版本的许可/作者清单已保存。来源与全文见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。许可文件存在不等于对所有发行方式作法律合规保证。

## 实测的原生上游限制

**omp 18.3.2 的 `session_start` 扩展若同步 await UI 回答，会遇到启动分发顺序限制。** 独立诊断直接与安装的 omp 通讯，未经过桌面：ready 在 357.123 ms，confirm request 在 357.674 ms，匹配 id 的 `confirmed:true` 在 357.693 ms 写入；约 30361 ms 原生取消/declined，随后报告 `handler timed out after 30000ms`，get_state 于 30386 ms 才成功。诊断 exit 1，原生进程退出 0。

此限制可在无桌面时复现；没有修改原生运行时、自动批准或注入桌面规避逻辑。**已进入正常运行会话后的 ask/select 已实测通过，不能把启动扩展问题泛化为所有原生对话框失效。** 需要在 session_start 等待 UI 的扩展应先核对上游支持，不依赖桌面替它解除原生初始化阻塞。

## 未覆盖边界

- Windows、Linux、Intel macOS、真实服务商/OAuth、签名/公证和对外安装器发行未验证。当前交付为本机未签名 mac-arm64 `.app`。
- 原生选择器、全部 IME/快捷键、全部 select/confirm/input/editor 超时/后台归属组合、完整 config reset/覆盖来源矩阵未逐项穷举。已执行项目如上，不将局部通过外推为全矩阵通过。
- 任意 TUI 组件、替代 SQL/Redis 会话存储及未登记外部历史目录不在原生 RPC/本地索引保证范围；Git 差异不是 PI 回滚快照。

安装与限制见 [USAGE.md](USAGE.md)，验收边界见 [SCOPE.md](SCOPE.md)。
