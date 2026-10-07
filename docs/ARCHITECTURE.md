# 架构与并行契约

## 固定路线

Electron 主进程 → 本机 omp --mode rpc-ui（标准输入/输出 JSONL）；sandbox preload 只暴露 src/shared/contracts.ts 的 DesktopApi；React 渲染器只管理展示投影。PI-Desktop-main 提供对话主线、层级与阅读设计原则，不是 OMP 类型/任务深度/生命周期的上限；第二参考只借鉴已安装进程桥接算法。禁止引入 PI runtime、Rust host、桌面权限扩展、Agent SDK 或第二套工具执行器。当前语义呈现不改变引擎、认证及既有来源/资源授权。

整体体验升级以区域职责为约束：侧栏导航，头部给出位置与至多一个操作状态，主列阅读并在回复位置承载运行状态，底部浮动行仅在原位标题离屏时兜底，输入区负责写作/发送与紧凑用量，工作面板检查，浮层承载检索和操作。基线审计与仓库内日常路径 E2E 先于实施；状态不在多个区域重复成为权威。

共享类型由编排者维护。修改接口须先通知编排者，不能为编译方便自行加空实现。各执行者不得中途跑 build/typecheck/test/lint/formatter；完成后由编排者统一验证。

## 目录所有权与导出契约

### 工程与 Electron（DesktopHost）

拥有 package.json、pnpm 配置/锁文件、tsconfig、electron.vite.config.ts、electron-builder 配置、src/main/index.ts、src/preload/index.ts、src/renderer/index.html。其他模块的缺失先按契约接入，不创建替代文件。使用 pnpm@10.34.5（本机无 pnpm 时可 npx --yes pnpm@10.34.5），不要全局安装。依赖安装由编排者执行。

构建依赖 `yaml@2.9.1`（ISC）打包进主进程，用于只读解析模型配置；已登记于 `licenses/frontend-dependencies.json` / `.txt`。

`resources/omp-desktop-presence.ts` v1.0.0 是无依赖 omp 扩展，经 electron-builder `extraResources` 非打包携带；桌面运行时始终通过 `-e` 加载，不修改 omp 本体。

创建安全 BrowserWindow（sandbox/contextIsolation 开，nodeIntegration 关），统一校验 IPC sender，限制导航/外链协议。DesktopApi 每个方法有明确通道，不暴露 ipcRenderer。真正退出时关闭 owned omp 子进程，不将运行中 macOS 关窗隐藏当作退出。选择目录/文件使用原生 dialog；附件选择后交 WorkspaceService 授权/解析。自定义运行路径仅为本机 omp，不接受任意启动参数。

`src/main/lifecycle.ts` 区分隐藏、恢复与退出：macOS 运行中关闭窗口只隐藏，Dock/activate 恢复；明确退出或非 macOS 运行中关闭先确认，默认取消，接受“停止并退出”才清理自有运行时，空闲关闭正常退出。`OmpRuntimeService.ownedRunningCount()` 由流式、排队/后台工作和活动子代理事件维护，不靠轮询或仅看主答复是否结束。

`desktop-objects.ts` 承载编辑器打开、快速查看、访达定位与拖出等桌面对象边界；工作区和真实路径授权在主进程校验。首选编辑器为系统/VS Code/Cursor/Zed，使用 `execFile` 参数而非 shell，不从 renderer 接受任意可执行脚本。图片没有通用保存授权，不提供无法兑现的保存动作。

以下 `DesktopApi` 方法经 sandbox preload/IPC 边界提供，不暴露通用文件写入或命令执行；会话在场扩展另使用协议 v1 的本机只读 Unix socket，不提供 Agent 控制命令：

- `searchMessages` 返回命中、截断、诊断与 `coverage`，覆盖用户/助手正文及工具参数/结果，不含附件、sidecar、思考。`MessageSearchHit` 保留 path/title/cwd/entryId、user/assistant/toolResult 角色、snippet/match、时间及可选 toolName/position；保存条目导航不授予新来源访问权。
- `openInEditor(request: { cwd; path; line?; column? }): Promise<void>`、`quickLook(request: { cwd; path }): Promise<void>`、`startFileDrag(request: { cwd; path }): void`：桌面文件对象动作，路径仍需主进程授权。
- `setAttention(options: { badge: string; bounce?: 'informational' | 'critical' }): Promise<void>`、`notify(options: { title; body; runtimeId }): Promise<void>`、`setWindowTitle(title: string): Promise<void>`：Dock/通知/标题投影；`onNotificationClick(listener: (runtimeId: string) => void): () => void` 返回取消订阅函数，点击按 runtimeId 回到会话，通知正文不含请求文本。
- `onMenuCommand(listener: (command: string) => void): () => void`：原生菜单与 renderer 命令路由，返回取消订阅函数。命令 ID 为 new-session、open-workspace、palette、quick-open、search-messages、find、toggle-sidebar、toggle-panel、settings、shortcuts、close-tab、next-tab、prev-tab、jump-latest、stop；它们复用已有操作与守卫，不形成第二套执行语义。
- `getSessionUsage(path, leafId?)`：返回所选分支的上下文 token、模型、窗口及来源、压缩状态，以及整个会话主/子代理花费、未记录子代理数、最近一次请求等；对应扩展的 `SessionUsageSummary`。
- `getModelCapacity(provider, id)`：查询模型窗口，保存历史无需启动 omp、联网或写配置。
- `getWindowChrome()` / `onWindowChrome(listener)`：读取并订阅原生全屏状态，用于 macOS hiddenInset 红绿灯预留；不是 renderer 猜测全屏。
- `gitDiff(cwd, path?, referencedPaths?)`：按引用文件发现嵌套 Git 仓库，支持按需读取所选文件补丁。
- `getTurnChanges(query: TurnChangeQuery)` / `onTurnChanges(listener)`：在已授权会话/分支内读取最终净结果及覆盖信息，订阅捕获变化；查询定位不授予新的路径权限，不从 Git HEAD 补本轮删除行数。

### omp 传输（OmpTransport）

拥有 src/main/omp/**。导出 discovery.ts 的 resolveInstallation(override?: string): Promise<{info: RuntimeInfo; env: NodeJS.ProcessEnv}>；cli.ts 的 runNativeCommand(context: ExecutionContext,args:string[]): Promise<{stdout:string;stderr:string}>；service.ts 的 OmpRuntimeService。ExecutionContext 在此模块导出，结构 {executable:string;env:NodeJS.ProcessEnv;cwd:string;profile?:string}。

OmpRuntimeService 构造函数接收 (event:RuntimeEvent)=>void；start(options:StartSession,context:ExecutionContext):Promise<SessionConnection>；request<T>(runtimeId,command:NativeFrame):Promise<T> 返回已检查 success 的 data；respond(runtimeId,ExtensionResponse):Promise<void> 是独立侧通道；getCwd(runtimeId):string；close(runtimeId):Promise<RuntimeShutdownOutcome>；closeAll():Promise<void>。单次关闭共享同一结果，`RuntimeShutdownOutcome` 包含 clean、forced、exitCode 及可选 signal/error；普通断开仍可有界升级到 TERM/KILL，但移除来源只接受无强制终止、无错误的干净零退出，不把退出等同于持久化成功或额外 fsync 保证。

start 安装事件监听后启动，协商 v2，get_state 作初始化屏障，分页读取原生消息，拉取 models/commands/thinking levels，订阅 subagent events。start 返回前的事件必须排队并在渲染器能够关联 runtimeId 后可靠送达；可在 start 返回消息后由主进程微任务/后续轮发送，主应用也须暂存未知 runtimeId 的事件。不能将命令 ACK/agent_end 当作 session_settled。限制物理/逻辑帧与 stderr 内存，严格处理 UTF-8/chunk/error/EOF，不自动重试用户请求。关闭先 abort/EOF/drain，再有界终止真正 owned 进程。

首页/新建草稿获知工作区后立即预连接原生运行时，最多一个；临时 `--config` overlay 设置 `autoResume:false`，不恢复旧会话，不调用 `new_session`。旧 `new_session → ensureOnDisk` 强制创建只有头部的 journal；现在使用原生 `#shouldHaveSessionFile` 延迟建文件，第一条真实消息前不落盘。选择器独占连接中提示，就绪后可选真实模型/思考；首次发送复用运行时，连接中 Enter 就绪后只提交一次，失败恢复草稿与原因，失败预连接聚焦时重启，离开未发送草稿安静释放且不留条目/文件。

`service.ts` 用独立 `allocatedSource` 保存新建/fork 分配身份，不随首次持久化时的 `initialSource` 清理而丢失；真正无路径的分配接纳首个持久路径，后续 ID/路径变化撤销分配身份，恢复会话不算分配。此修正避免已持久化新会话在无关终端缺少有效 breadcrumb 时被错误拒绝发送；`service.test.ts` 增加对应回归，占用规则本身不变。

`service.ts` 的 `requestWithId` 按当前运行时公布的等级校验 `set_thinking_level`，随模型更新，支持原生公布的 max/inherit。RuntimeStore 的模型/思考命令立即投影标签并关闭菜单，后台提交、失败回滚并在输入框内提示，仅应用目标状态，不做完整刷新/historyChanged，不触发占用探测或锁住输入框。

`main/omp/configured-model.ts` 只读解析原生全局→项目→`PI_CONFIG_FILES` 配置层，遵循 profile/环境，有歧义的选择器保持未知；草稿约 0.5 秒显示配置默认模型及禁用选择器，运行时真实模型以 120ms 交叉淡入接替。`main/omp/native-login.ts` 使用解析后的可执行文件与已配置 profile 打开 Terminal 执行 `omp login`，脚本权限 0700，不接收 renderer 自定参数，启动时清理陈旧脚本；首页和无运行时的凭据设置共用恢复入口，窗口重新聚焦后检查。

### 原生数据（NativeData）

拥有 src/main/data/**。导出 service.ts 的 NativeDataService，构造 {userDataDir:string,getContext:(cwd:string)=>Promise<ExecutionContext>}。方法 getPreferences():Promise<DesktopPreferences>、setPreferences(patch):Promise<DesktopPreferences>、listHistory(options?):Promise<SessionSummary[]>、listSettings(cwd):Promise<SettingsSnapshot>、setSetting(cwd,key,value):Promise<SettingsWriteResult>、resetSetting(cwd,key):Promise<SettingsWriteResult>。

只读索引 native sessions/archives 与原生登记的外部路径，采用真实 header.cwd；工作区、来源文件、授权、watch、接管及 state.sessionFile 按真实路径统一身份，未落盘路径按已存在祖先归一。不可用工作区保留记录路径，不改写原生 header 或因读偏好而回写文件。支持 native profile/env/XDG roots。设置走原生 config CLI，set/reset 后重读；分别保留 overriddenBy 与 fallbackEnv。凭据仅暴露原生存在性，不向 renderer 传明文，不建立第二套认证或会话权威存储。临时历史元数据索引与 Electron userData 偏好不取代原生记录。

`src/main/data/session-usage.ts` 汇总保存来源：上下文沿当前分支取最后一次请求的 `contextSnapshot.promptTokens`，缺失时用 input + cacheRead + cacheWrite，不计该次 output；会话花费合计主会话助手与子代理用量。子代理优先用 task 结果 `details.usage`，缺失时由 `SessionResources.resolveUsageChildren` 只解析匹配的已授权子会话来源并递归汇总，有深度/数量上限、环路与去重保护；原始子路径不暴露给 renderer，无法解析的计入未记录用量子代理数。实时与保存花费定义一致，未落盘实时会话才回退到 `get_session_stats`。

`src/main/data/model-capacity.ts` 为保存上下文补充窗口：先使用实时连接 `get_available_models`/当前模型目录的 userData 缓存（带时间戳），再只读解析 omp 代理目录的 `models.yml`/`.yaml`/`.json`，保留模型身份、名称、窗口及能力，不保留或记录凭据。`SessionModelCapacity` 新增 `input` 与布尔 `remoteCompaction`，不导出远程 URL。未知不提供虚构默认值，也不为此启动 omp、联网或写配置。实时上下文以原生 `contextUsage` 为准，窗口 0 视为未知并回退模型窗口，每次模型请求完成后约 400ms 刷新，不逐 token 轮询；`runtime-store` 的 get_state 上下文刷新同时复制 `systemPrompt` 与 `dumpTools`。

`main/data/compaction-policy.ts` 结合模型能力与通过既有 `listSettings` 只读读取的 `config list --json` 配置，计算自动压缩及提前准备刻度，标注「按当前配置」与百分比/token；无法判断不显示提前刻度，不冒充历史配置。保存请求快照保留 `nonMessageTokens`、`compactionEpoch`、`historyRewriteTokensRemoved`、`contextPrompt`，失败/中断请求不覆盖有效测量。实时展示系统提示、项目规则与环境、工具定义、技能、对话消息五类估算及可用空间；保存记录无 `session_init` 时仅非消息估算/消息两类。

`main/data/session-observer.ts` 的增量日志/有界尾部为未参与进程提供推断，保留偏移/索引，仅截断或改写重扫。参与进程由 `main/data/presence.ts` 消费精确 socket 状态与助手文字/思考尾部，`shared/presence-tail.ts` 支持落盘对账不重复；超时为运行状态未知，不降为空闲。`ObservedActivity`、`SessionSummary.activity`、`HistorySnapshot.activity` 区分精确证据与推断，陈旧/未知不证明完成。

正文宽度使用独立桌面偏好 `chatContentWidth`：主进程校验为 360–1600 的有限数值后保存，renderer 由偏好驱动拖柄与重置（760px），重载后恢复；不写入原生 omp 配置。

`DesktopPreferences` 不再包含 `theme` 或 `motionMode`。读取旧桌面偏好时先仅剔除这两个退役键，再对其余内容进行原有严格校验；返回值及新保存数据不包含退役键，公开 patch 接口拒绝它们。格式错误的 JSON、其他未知键和无效值仍失败，不借迁移清空其他偏好，也不读写原生 omp 的主题、配置、认证或会话。

新增桌面偏好 `notifications: boolean`（默认 true）与 `preferredEditor: 'system' | 'vscode' | 'cursor' | 'zed'`（默认 system），仍保存在独立 Electron userData；不写入 omp 配置或认证。原生配置列表不提供来源/默认值元数据，设置来源只从已知写入回执显示，“已修改”仅表示本次设置会话的记录。

`DesktopPreferences.messageMeta: 'always' | 'hover'` 默认 `always`，`durationStyle: 'units' | 'clock'` 默认 `units`。主进程校验并持久化；`setPreferences` 第二道白名单保留外观字段（含 `preferredEditor`）。设置 raw key 以次要等宽文字呈现，原生说明标明来源。

侧栏隐藏项目与各项目折叠状态纳入 DesktopPreferences，随 bootstrap 下发、异步保存，限定至多 200 个规范化路径；渲染器不再以 localStorage 为持久化来源。旧值仅在首次绘制后迁移一次并移除旧键，启动关键路径不再同步读取侧栏状态。

`DesktopPreferences.terminalPresence` 默认开启，控制用户 `<agentDir>/extensions/omp-desktop-presence.ts` 的安装。`main/presence-install.ts` 原子安装/更新且仅覆盖管理标记文件，关闭时移除；设置显示版本及参与/未参与进程数。TUI、rpc-ui、print 与子代理按 omp 扩展机制加载，安装后启动的进程才参与，桌面显式 `-e` 加载独立保留。

协议 v1：每个参与进程为打开的主/运行中子会话在 `~/.omp/run/omp-desktop-presence/v1/sessions/<sha256(realpath)>.lock` 持有 `O_SHLOCK|O_CLOEXEC` 共享内核咨询锁，切换/退出/崩溃/SIGKILL 由系统释放。每进程 socket 为 `~/.omp/run/omp-desktop-presence/v1/procs/<pid>-<start>.sock`，权限 0600；响应 hello/status 并流送状态、当前工具、助手文字/思考增量，不暴露 prompts、工具参数或输出，不改变 omp 状态，加载/处理错误隔离。

macOS socket 路径超过 104 字节限制时回退至 `/tmp/omp-presence-<uid>/`；共享锁路径与只读协议不变。占用判断按应用主进程的后代关系识别桌面自有进程，并在检查末尾刷新 owned 事实，避免检查期间新启动或响应较慢的自有运行时阻塞自身会话。

保存来源模型取最后助手消息，思考取最近等级条目；历史索引增加 `kind` 列定位，替代整条祖先链 JSON 扫描。10 万条历史该查询从 190s 降至 0.07ms，不代表完整历史载入耗时。

### 历史查看与写入准入

`readHistory` / `readHistoryTree` / `watchHistory` 提供只读 JSONL/gzip 分支投影与持久化更新，不创建 RPC 会话、不迁移来源或调用模型。`HistoryStore` 按 revision/游标维护 durable ID，`RuntimeStore` 管理 owned RPC；树浏览仅改变查看叶节点，未指定叶节点时跟随最新。所有所选祖先链上的 compaction/reset 记录保留，投影不是模型上下文重建。每页树最多 1,000 节点；不再以 100,000 图节点 cutoff 改为原始源码替代聊天。

`message-search.ts` 只读检索授权 JSONL/gzip 的用户/助手正文和工具参数/结果，不含附件、sidecar 与思考。支持 CJK/多词字面匹配，默认 50、最多 100 命中，预算 1.5 秒、最多 1,000 来源、每文件解压后 8 MiB；部分覆盖返回明确原因并提供当前会话完整搜索。面板仅将同会话相同片段折成「N 处」，跨会话不合并，保留工具名与紧凑时间；准确 entry 导航不启动执行。

桌面派生 `RuntimeSourceState` 独立于原始 `NativeState`，通过 SessionConnection、RuntimeHistory、RuntimeAccess 传递：unpersisted / persisted / unavailable 绑定准确 sessionId 与可选 path（persisted 必须有路径），并保留原因。不装饰原生消息/state，曾持久来源丢失必须显示 unavailable，不退回空草稿。可信原生预分配路径的授权与持久化事实分开，owned 未落盘仍使用运行时视图，不尝试读取尚不存在的文件。

可信原生来源在连接发布时即加入保存来源授权，包括尚未落盘的预分配路径，确保断开后可重新打开/续写；这不将预分配当作持久化成功。列表授权同样规范化路径，renderer 任意路径仍被拒绝。`app/history-store.ts` 按 path/branch/anchor 缓存至多六份视图，保留大会话窗口不再污染另一来源的可用性或错误；导航清除视图局部错误。

保存会话先发布/绘制正文，再在后台完成 access/occupancy 检查；pending access 通过 composer/头部「检查中」呈现，发送仍等待准入，不以首屏可读代替可写。`history-store` 将前插期间的 watch snapshots 合并，待分页完成后应用，不让后台更新取消旧页；失败页重新开放分页触发。正文以每帧六轮的小批次插入，继续维护来源/revision 校验与阅读锚点。

完整祖先索引采用单活动来源的临时 SQLite：8 MiB cache、关闭 mmap/journal、2 GiB 临时数据库上限，按文件偏移和小型预览保存元数据而非正文副本；换来源、关闭或失败释放。gzip 范围缓存最多 16 MiB，正文仍分页；超大单条记录来源细节按 64 KiB 读取。临时索引不是原生会话数据库。

Owned runtime 首次连接只物化一个 durable 正文窗口（最多 200 条、按 8 MiB 预算选页；图片 hydration 另有上限），不再把整条历史累加到 128 MiB 后拒绝连接。`readRuntimeHistory(runtimeId, {before?, beforeEntryId?, anchorId?, leafId?})` 读取一个窗口，`RuntimeStore.older(id, beforeEntryId?)` 替换窗口，`latest(id)` 返回活动末尾；按 durable ID 保留阅读锚点。来源失败保留运行时连接并显示 `historyError`，不改用模型上下文。所有更早祖先仍可继续逐窗访问。内部叶节点查询用现有 bounded journal index 的最新持久 entry ID 作为 `get_entries(since)` 传输游标，只接受该原生回复的 `leafId`，绝不把文件末尾或模型上下文当成活动分支；查询前后仍核对原生 session ID/path，并校验 durable source session ID。`unknown_since`、来源失败与 RPC 错误显式传播，不回退到整树或猜测叶节点。`get_tree` 会序列化完整历史正文并可能先被原生 producer 的 64 MiB 上限拒绝，因此内部叶查询不再调用它。既有物理帧、逻辑帧、UTF-8、chunk 顺序与请求身份限制不变；并发追加后尚未观察的 suffix 仍受普通 RPC 上限约束。这是桌面可见窗口与身份传输的界限，不能声称原生进程加载整份 journal 的内存或 producer 成本有固定窗口上限。

可写保存会话连接前显示记录模型/思考，打开选择器按发送同样的准入连接一次，发送复用，未提前连接才在首次发送 resume。只读模式禁用记录模型，标题与 composer 共享可写性决定。派生仍只读目前已保存来源，不改原文件或带入后续进展；startSession fork 不经写原会话准入，canFork 不要求 write access，成功带草稿、失败原位提示。

归档 fork 暂存解压 JSONL 与资源，两者分别上限 512 MiB，资源最多 10,000 项；拒绝符号链接/变化中的文件，按 SHA-256 核对原生创建的目标后再暴露运行时。Host 清理自己的临时目录，不删除原生持久目标。`previousSessionFiles` 仅用于来源/移动线索，不拼接历史。

归档列表不预先宣称可 fork；打开来源后执行有界只读 preflight 并给出失败原因。preflight 不是预约，实际 fork 仍重新暂存、核对目标并保留失败时的新来源诊断。

桌面自有运行时直接准入，不做全机进程探测；共享来源在场锁优先，不能确认自有的持有者不响应仍按外部保护。仅未参与进程才使用 ps/lsof，缓存 10 秒。`main/data/presence.ts` 的 `watchPresenceChanges` 订阅在场目录（包括迟创建目录）事件，配合窗口聚焦驱动访问刷新；空闲零周期进程探测，替代此前约 300 次/分钟。breadcrumbs、单次写入锁与打开描述符不替代在场锁。

`main/data/lsof-diagnostics.ts` 只过滤已知且与目标无关的挂载点警告，其他 stderr 仍视为证据缺失；删除自身的 lsof 检查同样按目标限定，不让无关挂载警告或短暂解释器进程阻塞所有来源。

来源、写入和派生能力保持独立，composer-mode 共用标题/输入模式判断。重新打开保存会话的 access 检查期间，Enter 保留 pending 意图并显示检查中，ready 且允许后只提交一次；blocked/external/unknown 保留原文与原因，切换离开取消等待。选择器可先连接供发送复用，canFork 不沿用写原文件权限。

### 来源级可逆移除

`DesktopApi.removeSession(target)` 经 preload 到主进程，`SessionRemovalTarget` 仍区分 runtime/saved 来源，主进程解析授权身份，不接受 renderer 任意删除路径清单。`main/data/session-removal.ts` 与 `main/omp/removal-admission.ts` 要求未知占用的移除具备明确同意；已证实外部持有仍拒绝，不能由同意绕过。授权、身份、类型、替换风险与关联资源独占性检查保留，观察并非跨客户端租约。

未保存桌面会话直接丢弃、不做占用探测；未发送预连接草稿释放运行时，不留文件/条目。桌面持有的已保存来源安全关闭后移到废纸篓；TUI 持锁时即使 socket 不响应也阻止删除，不能用未知同意绕过。终端 /exit 或 SIGKILL 后系统释放锁；未参与进程的真正不确定证据仍需明确同意，关联资源安全检查不放宽。

移除引擎使用 Electron `shell.trashItem`，不调用原生永久删除命令，不提供 unlink/rm 回退。先移动准确来源，再移动有证据的附属项。资源树须为原生 sessions bucket 中准确 timestamp_ID 布局、无 fork/move 来源，并通过有界的 sessions/archive/登记引用检查及树类型/占用检查；工作区别名须规范化、绑定身份并在占用探测后复验，无法解析时保留树。共享 stem、其他引用、软/硬链接、未完成发现或不明占用使资源保留；归档/custom/fork/moved 根保守保留。备份还须满足原生 Snowflake 后缀格式、完整发现且无独立登记/引用，并在操作前重新核验；登记项须准确指向来源。gzip 身份读取限制压缩输入、解压输出和耗时，超限保留不确定数据。来源移走后如被重新创建，停止附属项清理；每次附属 Trash 前复验来源仍缺失。不遍历 parentSession/previousSessionFiles，不从只读 artifactRoots 推导删除权限，工作区与共享 blobs 不动。

工作区已删除时通过现存父目录解析，不再仅因 cwd 缺失保留配套附属文件夹；共享、使用中及无法证明独占的项目继续保留。确认明确附属文件为子代理记录和生成文件，系统 Trash 可由访达 Put Back 恢复；干净成功只有提示，部分结果按项目用普通句子解释并提供访达入口。

`SessionRemovalResult` 区分 discarded / trashed / partial / retained，并记录 sourceRemoved、sessionId、可选 sourcePath、affectedRuntimeIds、实际 trashed、retained 路径及原因、errors/warnings 和可选最新 preferences。多项 Trash 不原子，sourceRemoved 才决定清理来源状态；停止成功但来源保留不能当成功。实际移除后只清理匹配 runtime/watch/选择/对话框/草稿/pin，并使迟到结果失效；另一个当前选择不受影响。附属资源或偏好清理失败单独报告，不复活已移除来源。恢复只有系统 Trash，不承诺应用内恢复事务或原生额外持久化保证。

`SessionRemovalResult.retained[]` 增加 `reasonCode` / `kind`，支撑保留原因和附属类型文案；「在访达中显示」IPC 仅接受最近一次移除结果发出的确切 retained 路径，不开放任意路径定位。路径/ID 收在详情。


### 工作区（WorkspacePanel）

工作区主进程负责受限文件读取、路径搜索、Git 差异及磁盘/剪贴板附件授权。附件保留 source/expiry，无路径的剪贴板图片按 MIME 签名核对；24 项/32 MiB/30 分钟限制，提示词受理后才消费 ID，过期不自动重读。路径搜索以目录前缀缩小遍历，10,000 项/500 结果有部分结果诊断；git 只读 argv 调用。

`src/main/workspace/service.ts` 将未跟踪 UTF-8 文本投影为完整新增 diff，保留空文件、BOM/CRLF/无末尾换行语义，受 4 MiB/5,000 行限制；二进制/过大文件给出说明。这是当前工作区的只读呈现，不授予暂存、撤销或历史快照回滚。

WorkPanel 的实时子会话使用 `readRuntimeSubagent({runtimeId,subagentId,before?})` 的 durable 分页投影（compaction/reset/custom/images 与保存来源相同），未落盘尾部只来自真实 `subagent_event`，不再使用无界 byte-suffix RPC。资源上下文为 `{kind:'saved',parentPath,leafId?,subagentId?}` 或 `{kind:'runtime',runtimeId,subagentId?}`；实时路径只由 owned runtime/current native child 身份解析，renderer 路径不授予权限，读取前后重新核对父会话和子任务归属。保存子会话按父来源/toolCall 只读解析，不启动 RPC/watch；缺失/歧义保留元数据和明确诊断。资源/区域每页 64 KiB、每次扫描 8 MiB 后提供续读；目录最多 20,000 项、根 128、子会话 10,000，子任务发现历史扫描最多 100,000 条或 512 页并显示诊断。这些发现边界不截断完整主会话祖先索引。

`agent://task.id` 与 `/key/index` 输出只在所选父任务祖先或当前 owned native roster 授权下读取；完整输出按页显示，结构化提取限制 8 MiB，递归来源祖先限制 64。资源名、URI 路径片段及通知文本不会产生文件权限。父会话导航仅解析已经列出/获准来源的 ID 和别名；缺失或多个候选显式报告，不按 header 路径发现新的来源。

WorkPanel 通过 `onActiveSubagentChange(id | null)` 报告活动详情 tab；App 保存 `activeSubagentId`，经 ChatView/Transcript 传给 `workspace/TaskStep.tsx` 等名册呈现，内联行、未锚定 SubagentStage 与 TaskOverview 总览共享行选中和详情入口。非子代理 tab、关闭或卸载面板清空选中；保存/实时身份与读取作用域不因展示重排改变。

面板几何测量实际产生布局盒的 `.app-shell`；`.app-chat-shell` 使用 `display: contents`，不能将其 bounding box 作为可用宽度。`work-panel-resize.ts`/偏好将默认宽度设为 420px，常规上限为窗口 40%，为阅读区预留 560px；自动收起侧栏在空间恢复后还原，手动选择优先。`PanelRequest.line/endLine` 与 `lib/file-target.ts` 将 `:N`、`:N-M`、`:N+K`、`#LN-LM` 文件目标传给 FilesTab，保留 hashline `#TAG`；CodeView 定位、高亮并显示范围，来自对话的预览标注“当前工作区版本”，Markdown 可切换预览/源码，仍受现有读取授权和 5,000 行上限约束。

WorkPanel 统一「文件 / 更改 / 任务 / 会话」目的地，文档 tabs 只在各自目的地中呈现，不叠加全局重复入口。文件保留隐藏项、引用点与临时/固定标签，Git 状态本地化，最大化提供树/预览分栏；任务保留委派分组与过滤，原有子会话授权不变。

`ReviewChangeCard` 与 `unified-diff` 负责聚焦 diff、词级行内差异、上下文展开和文件头动作；Changes 将汇总、模糊筛选、文件列表与一个聚焦 diff 组合，≥900px/最大化支持并排，J/K、N/P、W、U/S 分别控制文件、hunk、换行、布局。`chat/TurnChanges.tsx` 与审阅共用每文件一份最终净结果；默认不展示 1/N 操作导航或逐步累加统计。「过程与来源」默认收起，展开后才查看步骤和按授权上下文定位主/子来源。

`PanelRequest.turnChanges?: TurnChangeResult` 携带已有结果，`turnChangeQuery?: TurnChangeQuery` 携带 `{context, anchorId, toolCallIds?}` 定位器；`path?` 选择文件，`line?`/`endLine?` 仍为当前文件定位。旧的 `PanelRequest.paths`/`changes` 不再是契约。本轮查询不调用 Git；当前 Git 工作区是单独标注的审阅，按仓库分组、先元数据再选中文件补丁。嵌套仓库发现最多 500 个引用/32 个仓库，缓存 30 秒；无仓库不阻止本轮最终结果，也不授予恢复或回滚能力。

### 本轮最终改动捕获与证据

`main/workspace/turn-change-coordinator.ts` 仅在自有运行时空闲且实际 prompt 发送前捕获基线，完成或明确降级后才继续发送。终点以原生 settlement 和异步/子任务状态核验为准，不以答复出现或 `agent_end` 为准；中断/退出保留观测限制，原生身份变更撤销绑定。steer/follow-up 不生成冒充整轮的中途基线；多个提交共用区间时不冒充某一个精确轮次。

`main/workspace/turn-snapshots.ts` 使用流式 SHA-256 清单和有界 RAM 文本，不写快照、溢写文件或磁盘缓存。全局池统计清单元数据、正文、临时读/解码内存及最终 diff，多个会话共享；内存压力先释放正文和最终 diff，不抹除已有哈希。硬件预算为总内存的 1/64，限于 32–512 MiB；实际目标还受 `(可用内存估计 − 256 MiB) / 4` 限制，最低可为 0，而非保证保留 32 MiB。Electron 优先使用 available，缺失时用 free 加四分之一明确 purgeable，再回退到宿主可用/空闲估计；不把全部文件缓存视为可回收。缩减立即生效，目标至少增长 25% 且保持 5 秒后才提高预算；活动协调器每 2 秒检查压力。该预算是应用记账与估计，不是进程 RSS 或操作系统零 swap 保证。

当前扫描默认 30 秒（调用上限 60 秒）、100,000 条目、64 层，单文件保留文本至多 2 MiB，哈希块 64 KiB；清单元数据上限 32 MiB、在途缓冲上限 8 MiB。默认未另设实用的哈希总字节配额（`Number.MAX_SAFE_INTEGER`），仍受时间、条目、元数据与安全读取边界约束，不能据此承诺无界扫描。排除 `.git`、`.hg`、`.svn`、`node_modules`、`.pnpm`、`.yarn`、`__pycache__`、`.venv`、`venv`、`dist`、`build`、`out`、`coverage`、`.next`、`.nuxt`、`.cache`、`target`；不跟随符号链接，读取前后校验路径/文件身份。超时、权限、竞争与上限写入覆盖原因，`complete` 只针对已声明扫描范围，不等于全项目。

协调器最多保留 24 份捕获记录，不为新会话挤掉活动基线；最终计算后释放前后端点正文，最终 diff 受同一 RAM 池管理并可被淘汰。捕获端点随主进程重启丢失，不存在永久中间版本；已有原生历史仍可重读。

`main/data/turn-change-evidence.ts` 始终读取真实工具证据，与可用捕获共同归约，不只作为快照失败的后备。按已授权父来源、分支、原始 task 调用与真实子关系收集，核对分页 revision，关联可证明的迟到结果；身份保留 source/session、entry、tool，报告中的文件清单不是证据。完整原始历史按段读取与投影，只将所选轮次相关的工具记录送入归约；不再以累计页数、消息数、输入字节、来源数、递归深度或操作数截断证据。索引/journal 的原始 JSON 分块投影也覆盖超大单条记录，不先把整份历史或整条无关正文加载到 RAM。授权、分支身份、环路/去重与来源版本核验仍保留；真实缺失、损坏或身份歧义须给出原因，完整历史的累计长度本身不是缺证据原因。

子任务边界保留原生消息的 attribution/steering 元数据：只有明确 `attribution: agent` 且 `steering: true` 的协调消息不作为新委派起点，普通用户消息仍保留任务边界。终态前已排队的 steering 可继续当前委派；终态后续写须有所选父轮次中对同一已授权子代理的精确成功类型化投递证据。此规则不靠代理名称、正文相似或位置猜测归属，不将无关父轮次或未授权子来源纳入。

每次历史证据查询持有查询局部 reader/resources，避免并发读取互相淘汰来源索引；这不改变来源授权或来源版本核验。renderer 仅让可见轮次准入证据查询，离屏轮次不提前填满两槽 FIFO。合并订阅仍须响应同一来源的历史与子证据变化，作废旧结果并重新读取；仅查询键相同不能证明结果新鲜。

生产路径通过 `onStart` / `onOperation` 将操作逐个交给按文件维护的净结果累加器，不保留整轮操作载荷数组再二次归约；处理过的历史正文可以释放，最终状态与必要内容仅在 RAM 中保留。不新增正文、快照或中间版本磁盘缓存，已有可丢弃的偏移/身份元数据索引仍可使用，不是第二套 journal。这不等于固定 RSS 或操作系统零 swap 保证。

`shared/change-net.ts` 增量合并编号/统一/apply-patch、read/write、命令候选等原生证据与前后端点。`RecordedFileChange` 是最终净结果，`steps` 仅是可选过程证据；过程明细最多保留 256 步 / 1 MiB，省略时以 `processTruncated` 明示，但后续操作仍继续参与最终净结果，不能因过程展示预算耗尽而降低最终证据完整性。`evidence`、`content`、`countsKnown` 分开表达证据与内容/行数可用性。已证明改回原样或创建后删除会消失；缺基线不推定新建、候选命令不直接证明修改、未知/截断正文不生成精确行数，删除不取 Git HEAD 替代本轮基线。单个 patch/diff 的解析与行数运算仍有边界，分段收集完整历史不意味着任意大小补丁都能精确重建。哈希确认变化即使无正文/作者也保留文件；哈希只证明区间变化，不证明独占作者，并发会话或用户修改不被伪造归属。历史/外部轮次及已释放端点从原始保存证据重建，不读取今天的工作区来冒充历史终点。`TurnChangeResult.coverage` 独立给出 snapshot/evidence 状态、原因与排除项。

摘要与审阅区分已知零变化和结果尚不能确定；活动轮次或尚无结果的加载阶段不呈现最终改动卡。无法确定时保留已知文件，并在审阅中安静说明原因，不以「0 个文件」加部分覆盖提示替代实际收集。原会话固定轮次的实际模块 smoke 已得到 15 个文件身份、完整且不再 pending，包含最后文档端点；重建后 Electron 与当前包也实际显示该轮 15 文件、已知精确小计 +35/−7 及 `contracts.ts` 的原生精确 diff，无收集中、部分覆盖提示或警报。不由此推断所有文件的 patch/行数精确或所有历史来源均已验证。当前及分段修正历史证据分列于 [验收记录](VERIFICATION.md#当前验收原会话最终答复缺文件回归--2026-10-01)。

`SessionResourcePage.display?` 提供可读标题与内容；完整工具输出先呈现标题和带换行的高亮内容，条目 ID、来源路径与原始 JSON 收在技术详情，预览上限 64Ki UTF-16 字符并标注截断。

### 公共视觉（VisualFoundation）

拥有 src/renderer/ui/**、styles/**、assets/**、lib/**、locales/**。保留原 CSS 顺序、tokens、字体、图标 wrappers、ui 控件、portal/context menu、home mascot、Markdown/代码/数学/mermaid 安全渲染及 minimap 可复用算法。Markdown.tsx 导出 Markdown({source:string,baseDir?:string,cwd?:string,onOpenFile?:(path:string)=>void})、HighlightedCode({code:string,lang?:string})；cwd 为受限本地文件/图片读取提供绝对工作区上下文，不得导入 app/chat store。主入口 src/renderer/styles/globals.css。ui/ui.tsx 和 ui/icons.tsx 保留原公共组件/图标导出；ui/HomeMascotLogo.tsx 导出 HomeMascotLogo。裁掉的业务样式/依赖不进入工程。链接/图片用 DesktopApi 限制访问。

共享呈现包括 `ui/Collapse.tsx`、`ui/CodeView.tsx`、文件目标解析与 Markdown 纯文本摘要。`ui/motion/` 统一状态切换 120ms、折叠/浮层 180ms（淡入 + 0.98 缩放）、面板/首发输入框 240ms、大表面 320ms；reduced-motion 禁止空间运动，仅 80ms 透明度交叉淡入，流式字形动画关闭。输入框 FLIP 仅首次发送，导航与面板开关不动画、不留 ghost layer；历史前插不动画。Esc 恢复菜单/检索/对话框焦点，重命名/删除回到会话行，项目动作支持 focus-visible；常驻 polite live region 只播报状态，不播报 token/部分参数。字阶、字号与点击目标继续共用 tokens。

`file-object.tsx` 统一文件右键菜单、空格快速查看、Cmd/Ctrl+Enter 编辑器定位及带图标拖出；复制路径移除行选择器，执行端仍走主进程授权。工具各族保留延迟加载结果图片，浏览器/计算机动作优先截图，编辑诊断保留级别与路径行导航；图片查看器支持适应/100%、有界缩放平移、尺寸和 filmstrip，授权路径才可访达定位。缺失媒体/资源在内容后汇总一条提示，不用传输包装或技术占位冒充内容。

`shared/model-display-name.ts` 与 `lib/use-model-display-name.ts` 按实时模型目录→持久目录名称→id 统一输入区、页脚、子指标与侧栏提示名称。`lib/format-cost.ts` 全界面统一低于一美分为 `<$0.01`、其余两位小数并带分组；未知值不补零。`lib/highlight-client.ts` / `lib/highlight.worker.ts` 将语法高亮移入模块 worker，查找索引/匹配分块处理，避免揭示高亮内容阻塞主线程。

`lib/user-errors.ts` 与 `UserErrorNotice.tsx` 统一通知、轮次卡和提示。本地化标题、已知原因建议、按需技术详情分离；「omp：原文」只用于真实原生来源：跨 IPC 标记的 native RPC response，以及原生 frames/notices/turn errors。未知桌面错误只显示上下文中文标题，raw text 收入技术详情；去除 IPC 包装前缀，不混淆不同故障。明确标记的 UserFacingError 是桌面已编写说明，可作主文案。崩溃只通知一次，重新连接保留草稿；自动后台刷新失败保留 scoped diagnostics，不生成 toast 或 transcript notice。

### 聊天（ChatExperience）

拥有 src/renderer/chat/**。model.ts 导出 ChatState、createChatState(connection:SessionConnection)、reduceChatFrame(state:ChatState,frame:NativeFrame):ChatState。ChatState 必须有 state:NativeState、messages（自有展示类型）、models、commands、thinkingLevels、isRunning、isSettled、error?:string、prompts:ExtensionRequest[]、subagents:NativeSubagent[]。raw message snapshots 与 streaming delta 不重复累计；live IDs 不当作 durable IDs，恢复以 native snapshot 为准。工具结果按 toolCallId 关联，不出现两张终态卡。

ChatView.tsx 保留 ChatState、工作区、composerKey、发送/停止、模型/思考及文件/子代理回调。输入框与标题共用 composer-mode，可写保存会话先显示记录模型/思考，打开选择器按发送准入连接并复用，只读模式禁用模型。草稿预连接可先选模型，逻辑身份跨预连接和首次发送连续，失败保留输入；原有阅读、附件、IME 和消息操作保留。

连接保存来源时，仅实质性历史问题显示为对话提示；「默认查看最后持久条目而非已验证活动叶」等来源说明留在来源详情，不作为警告插入末尾。

`SubmissionStore` 保存提交意图；预连接或准入检查中的 Enter 进入 pending，就绪且允许后只提交一次，双 Enter 不重复。启动/准入失败保留草稿和原因，原生行接替本地气泡；侧栏在提交受理同帧投影会话行，不等待原生用户帧，也不伪造 journal。

`SubmissionStore` 回执仍为「提交记录与诊断」，不重复队列总数；输入错误在输入区内部布局。`chat/composer/queue.ts` 的 `DesktopQueue` 由 `RuntimeStore` 持有，运行中输入先排在桌面，不送 native follow_up；settled 后发下一项，Stop 暂停且不在后续收敛自动发送。队列最多三条 chip，其余为向上全宽弹层，明确动作分别为 steer、abort_and_prompt、编辑、删除。

命令 ID、进程消息、durable journal 与子任务 ID 不混用。原生 ACK 不证明逐项送达，迟到失败保留原意图；原生命令回执容量 64、已完成/本地成功至多 12，活动/失败/未知不静默淘汰。移除回执不是撤销原生命令，断线结果不明时仍标 unknown，不自动重发。

`messageSemantics(raw)` 独立给出 visibility、actor、family、initiatesTurn 与 label，不重写 raw role/attribution。用户文字逐字呈现并保留链接/附件入口；用户归属 skill-prompt/collab-prompt 可开启请求轮，任意用户归属上下文不会因此开启新轮。代理分配及自动继续有真实归属；system/developer、display:false 及未明确 display:true 的 custom/hook 指令不进入普通对话。

`chat/inline-image-markers.ts` 保留图片芯片与原文复制。`chat/streaming-reveal.ts` 的 StreamingReveal、`streaming-markdown.ts` 与 `ui/Markdown.tsx` 按 Intl.Segmenter grapheme 渐进释放，不拆 cluster/surrogate pair。每帧释放 `max(1, ceil(backlog × (1 − exp(−dt / 60ms))))`，等待 ≥250ms 的字形本帧强制释放；流结束用 τ30ms 排空，+120ms 强制完成。答复与推理共用节奏。每字从 release time 起以 220ms、`cubic-bezier(0.33, 0, 0.2, 1)` 做 opacity 0→1，最多 128 个，禁 transform/blur/colour；代码块/行内代码/数学/表格只 paced release、不逐字 fade。历史/保存、替换与 reduced-motion 立即显示，无 fade。

流式 Markdown 中未闭合的强调、行内代码与链接不露出语法标记。

`NativeMessageContent` / `NativeActivityContent` 共用于主/子会话：上下文压缩/分支/reset、执行与文件引用、诊断/advisor/IRC/launch/handoff、重试恢复/中断、redacted/server-tool/provider-fallback 各保留原生含义。未知可见类型继承明确的消息/工具/会话上下文，先读取声明的正文和媒体，再提供有界技术预览；不递归挖掘签名或提供者回放当正文。恢复或被后续尝试取代的诊断与当前失败区分，内部 silent abort 不制造新失败，真实错误及部分正文仍显示。完整持久来源/输出沿既有授权、分页与 resource callback 访问；技术预览不等于完整来源，也不新增授权。

保存图片的有界枚举包含原生 `fileMention.files[].image`，与其他声明图片共用既有字节限制和资源身份；完整图片通过授权的保存来源恢复，不因文件引用中出现路径就开放任意读取。损坏或缺失的图片仍报告真实限制，不用替代图伪装恢复成功。

`chat/turn-model.ts` 的 `projectTurn` 保留 answer、answerSource、noAnswerReason、chapters 与 epilogue；运行中不分类 answer/epilogue，只渲染过程与底部最新文字尾部，settled 后形成用户→过程→答复→后续更新→页脚。受理后用户消息下方即有「正在思考 · N秒」，再进入运行过程标题，当前章展开、文字在下方流式呈现；标题含状态/耗时/章节/步骤/子代理数，完成默认收起；步骤直接渲染，仅连续至少五个成功 read/search 合组，压缩保留章节标题，思考普通字重，当前章轨线 1px。

`Transcript.tsx`、`presentation.ts`、`chat/disclosure.tsx` 与 `timeline.css` 管理实时思考二级展开：运行轮次最新部分为可读流式 reasoning 时自动展开，本轮该行手动选择优先。live 标题取最新独立 `**…**` 段，否则最新段落前 40 graphemes，120ms 交叉淡入，不重复耗时。框高至多 168px（含底部 12px），13px/1.6、muted ink，滚动条 hover 可见，滚后顶部 fade mask；内部 τ80ms、lag ≤12px，框长满后外层不再移动。下一部分开始或 settled 后 600ms 才以统一 180ms disclosure 收起思考行，程序内滚不延迟，手动 toggles 保留；不可读/redacted 不自动展开，settled/saved 展开为自然高度全文。

`chat/thinking-follow.ts` 按用户输入方向恢复内层跟随：上滚暂停且不恢复；下滚结束在输入开始时已布局底部的 8px 内才恢复，扣除输入至 scroll/scrollend 之间新增的内容高度，两类事件均评估。仅推理轮次的父级原位 disclosure 在 `max(completion, answerStart + 600ms)` 调度一次收起，不再因程序滚动重复延后；手动选择优先，有工具章节的 settle 行为不变。

问题数按结果计算，排除已完成报告、已恢复操作、预期失败与用户停止；`shared/native-harness-notice.ts` 保留原生跳过/中断的中性判定。失败轮只留一个本地化卡与重试/打开设置，最终重试通知不重复，服务商重试归原位运行标题及其离屏浮动兜底。

主动 Stop 使用平静的已停止头部与耗时结束行，保留部分答复；被中断工具不计红色失败，也不产生停止错误 toast/banner，意外错误仍本地化显示。轮次 settle 时自动折叠维持底部跟随或恢复阅读锚点，手动展开选择优先，不以答复跳动换取紧凑。

`chat/tools/tool-model.ts` 统一 family、动作、对象与元数据；仅保存结果可从原生 metadata 恢复目标，缺参数明确区分未载入、未记录、正在接收，不只显示动词。`ToolStep.tsx` 与各类型详情负责字面结果、运行中命令/eval 尾部、读取/编辑/搜索等视图；Markdown/纯文本读取换行，代码横向滚动。原始 args/result/details/stream 与完整输出保留授权入口，错误正文不重复堆栈。

`toolStepLabel` / `nativeActivityLabel` 在 `chat/tools/tool-model.ts` 统一主体、对象与结果，供 ToolStep、TaskStep 和状态行消费。覆盖消息/群发、等待/读取结果、后台任务、计划、委派、异步来信/退出，以及旧 hub、设备和 MCP；未知异步结果明确为状态未知，细节仍可展开。

`workspace/TaskStep.tsx` 与 `chat/body-props.ts` 复用主/子呈现。`MessageFooter.tsx` 仅结束后显示时间、模型、本轮 tokens/费用，零用量隐藏，messageMeta 控制始终/悬停。关闭页脚只计算轻量合计；用量表和原始记录列表仅打开时构建，避免长会话每轮承担明细成本。弹层保留总 tokens/费用/请求数/子代理数与 #、输入、输出、缓存读写、费用表及子合计；原始记录按编号/角色/时间/预览，菜单保留焦点返回。起点标记仅真实分页起点，minimap 少于三轮隐藏且标记具名可访问。

`parseNativeAsyncDelivery` 保留 task/bash/eval job、图片、schema/捕获错误和 residualContent；`resolveNativeTaskOwnership` 在呈现前仅凭授权 roster 的唯一原生别名与来源中实际、唯一且早于交付的 task 调用分配所有者。jobId 不等于 agentId，不按点号名字、通知措辞或邻近位置关联。可证明的迟到结果回到原 task 名册对应行，一个混合批次可分给多个调用；残余/非任务/歧义内容保持原序的紧凑中性活动并说明归属限制，不默认成为助手答复或全局尾部日志。原始记录只保留一个 canonical DOM anchor，完整来源仍可访问。

混合批次解析兼容原生历史版本的简短通知前缀，但仍要求逐项 `── Job … ──` 边界与对应 job 元数据一致。缺少 Job 分隔符的合成批次不是可据以猜测所有者的原生格式；保留残余与诊断，不为兼容任意文本放宽归属证明。

实时消息落盘时，原生消息 ID、正文阅读锚点与资源引用仍使用持久来源；React 另保留同一逻辑回复的稳定呈现身份，不依赖材质场景。只有最新原生快照中唯一匹配的已结束实时消息可以转移该身份：沿用原生持久化判别字段，不匹配正文，不跨会话，不向旧历史/回填转移，任一侧歧义或证据不足即不转移。身份只附着于当前消息窗口，没有额外身份账本。

主/子会话共用 `NativeLiveSequence`，默认最多 256 行，按 message_start/update/end 生命周期更新，而非每个 frame 新建行或只保留最后一条子消息。缺少 messageId 时使用生命周期局部兼容身份并标记不确定；超限记录截断提示，通过持久分页访问已保存历史。用户/custom 的呈现连续性也只用唯一且受会话约束的原生时间戳、归属等元数据，不匹配正文；未结束流、旧页回填和歧义不提升为持久身份。

`nativeEventPresentation` 给有意义的会话事件按生命周期键更新有界状态，已知 transport/control 帧仍走原生 reducer，不形成逐事件日志。命令输出单独保留有界 `commandOutputs` 与可证明的相邻消息锚点；durable 刷新后只在当前来源窗口可核对时归位，无法定位的内容明确留作会话输出，不尾附到无关的后续答复。

`subagent-model.ts` 集中提供状态、任务名、纯文本简述、活动、指标与计划条目投影；任务名取 handle，嵌套名称显示最后一段，简述取 description 或跳过标题后的首个有效分配句。结果摘要取结构化 summary/status 或阻塞批次 `details.results`，不把完整 JSON 当标题。`groupSubagentsByToolCall` 先按全部子代理解析原生明确祖先关系，返回 `byToolCall`、`orphans` 和 `resolvedTrees`；根按 `parentToolCallId` 匹配可见调用，按顶层 index/progress.index 排序，否则保留到达顺序。分组呈现复用完整 `resolvedTrees`，不按局部列表重建关系、不靠点号 ID 猜祖先；未锚定根只在末尾 SubagentStage 出现一次。`plannedSubagents` 从 task 参数生成待创建行并按 index 绑定真实子代理，父调用终止后未创建行不得继续显示运行中。

`workspace/subagent-model.ts` 的 `plannedSlotStatus` 与 `SubagentStage.tsx` 将 live running task 未关联 child 的声明名额投影为中性等待中，头部同口径计数；unobserved/saved 保留状态未知/尚未关联，settled 且未启动的名额保留已停止/失败。

`workspace/TaskStep.tsx` 显示「委派 N 个子代理 · a 运行中 · b 已完成」与「查看原始参数」；头部与 `TaskCards.tsx` 行复用同一对账证据，行显示名字、任务、当前步骤、状态/耗时，同级不随选中重排。已确认终态不被同代模糊证据降级，未创建条目不冒充真实任务。

`shared/subagent-evidence.ts` / `main/data/subagent-evidence.ts` 归一化 task、进度、自定义交付、wait/jobs/cancel、复活代次、合并失败与授权子记录结果。外部同步任务按打开的 task 声明 ID、父会话头、执行开始及创建时间唯一关联，歧义留未分配名单并说明原因；父活动且子记录 120 秒内追加时推断运行，来源只在名单头部标一次。复活后正常结束并处置者显示已完成/已处理后续消息，不用中途工具失败覆盖最终证据。

共享树行保留真实缩进、连接线、分支折叠与子任务计数；状态切换遵循共享动效，历史加载不入场。从行打开子面板保留阅读上下文，过程与单份报告共用阅读区域，失败状态完整显示。

`SubagentTranscriptTab.tsx` 依次组织祖先面包屑、状态/耗时、一行模型/步骤/子代理累计 tokens/费用、一处任务说明、过程与一份报告。指标优先快照、缺少时用已加载历史，token 定义与页脚一致，名称/费用共用 resolver/formatter；不重复分配气泡或结论卡报告，技术身份与来源按需展开。终态 yield 与结构化有效字段保留可见正文，运行中不制造报告，重读保持 child 身份。

保存子代理的已授权详情读取会发布祖先/直接子级元数据，供 App 在同一来源 path/leaf/revision 下投影为聊天与工作面板共用的树。发现记录最多保留 128 份并优先保留当前祖先链，不复制完整子历史、不靠名称推断关系，也不取代主进程对每次子级/资源读取的授权复验。来源切换使旧发现代次失效，包括 A→B→A。

保存子代理 discovery 遇 journal 增长时最多重试三次；仍无法得到完整一致结果时保留上次完整结果并附诊断，不把正常续写中的追加当作会话失败。自动后台刷新错误只进入局部诊断，显式操作与真实原生轮次错误仍保留各自反馈。

实时/保存合并只提升呈现身份，不授予资源权限；真实多层及多父出现关系仍按原生证据保留。详情在 child 仍被观测时优先使用 live 身份读取，保存 counterpart 只提供绑定原父来源/分支/版本的恢复上下文，不因已经落盘将仍活动的后代改成只读旧快照。任务分配显示真实折叠消息或任务说明，不在缺少用户行的历史页伪造重复提问；主代理 agent_end 不结束独立、仍被观测的后台任务。

App/WorkPanel 将阅读模式 `historyFollowing` 与权威父来源 `historyLeafId` 分开传递。跟随最新时，父 leaf 的正常推进不重置或排除已验证的子会话实时序列；非空 leaf 本身不等于用户选择了旧分支。显式历史选择、子会话分页、保存模式或失去观测仍排除实时行。该区分只决定展示窗口是否叠加实时消息，父来源、祖先链、child 身份与资源授权继续使用原有权威选择器校验。

子会话分页区分不透明 `before` 游标与 `ChildHistoryRead` 的压缩前 entry anchor；后者必须绑定所选 child leaf/revision，不接受混合、过期或外来分支选择器。`SourceReadScope` 使初始读取、回退读取和翻页使用同一代次/请求接受规则：正文页、资源上下文、诊断和发现元数据一起提交，过期成功或失败都不能覆盖新来源。该路径复用现有 HistoryReader 与授权子读取，不增加原生 omp RPC。

子会话 Before/Later/Latest 在发起读取前同步截取完整选择器、所选 child leaf/revision、资源上下文与阅读位置；读取成功且通过同一来源/请求接受校验后才提交页面和导航状态。Later 可使用既有 child leaf/revision 恢复绑定分支的尾页，或恢复先前的中间游标/entry 选择，不等同于当前 Latest。失败或过期读取保留当前页面与 Later 目的地，不能提前消耗返回路径。

共享名册行与详情复用状态及组件级实时耗时；仅运行中计时，终态冻结，不把计时 tick 写进 reducer。终态 task 结果可补齐匹配子代理缺失的 error/abortReason，不能覆盖既有原生状态或把其他调用/异步运行中的子代理终止。状态文字与减少动态效果规则独立于颜色/动画。

运行时丢失后，未结束的实时子任务标记 `observationLost/status:unknown`，停止运行计时和假运行状态；保留已确认 completed/failed/aborted 事实。原生 contextUsage/todoPhases/fast enabled 与 active/吞吐/队列模式有显式 DTO。Inspector 的写操作仍走主进程字段校验与 ownership admission，仅开放已有精确 RPC；HTML 导出通过用户明确选择的保存路径执行原生 export_html，不接受 renderer 任意 outputPath。

`inspector-model` 将会话面板组织为身份、单一活动卡、上下文、生成与花费；思考等级本地化、花费共用 formatter，策略默认收起。仅重组展示，不新增写命令或绕过 guards/receipts。

终态或失去观察的父代理遗留的未结束嵌套进度快照也标记不可观测并停止计时；保留原生最后状态与已确认终态。拥有独立、仍被观察的权威 roster 记录的子代理不受父级结束影响，避免把合法的独立活动错误终止。

`transcript-reading-position.ts` 在 renderer 内存中按会话键最多保存 64 份滚动位置、跟随状态和阅读锚点，不持久化正文或折叠状态。Transcript 恢复几何位置；HistoryStore 先用持久消息 ID 重建包含锚点的分页窗口，再发布投影。分页失败/版本不一致保留锚点，只有一致祖先链读尽且锚点均不存在才回到最新；此内存记录不承诺重启后恢复。

`chat/smooth-follow.ts` 是 Transcript 与 thinking box 共用控制器。主对话 τ80ms 指数趋近底部，每帧及 layout 后 pre-paint 限 lag ≤64px；≤1.5px 精确 settle，单次增长超过 viewport 则 snap 到 64px 后滑动。`timeline.css` 固定 108px reserve（72+36），浮动行显隐不改 composer/transcript 几何，180ms disclosure 高度动画在 following 时仍启用。用户 wheel/touch/key/scroll 立即中断程序运动，程序写入不冒充用户输入。

`ui/motion/programmatic-scroll.ts` 记录主对话 glide、返回 tween 与思考框的程序滚动写入；全局 motion guard 与 `useFlipList` 忽略这些记录，不把自动跟随当作用户滚动。因此滑动跟随期间章节自动收起、子代理卡折叠与空间入场/FLIP 正常进行；真实 wheel/touch/key/scrollbar 输入仍使用既有 140ms 保护，延后自动变化。

`transcript-follow.ts` / `revealLatest` 将状态行、头部、最新按钮与 minimap 最后标记统一到返回控制器：距底部两屏内为 300ms `cubic-bezier(0.2, 0, 0, 1)` tween，动态 retarget live bottom，开始恢复 following；更远瞬跳。history prepend 锚点、session 首屏、find/jump-to-message、reduced-motion 保持 instant，最新流式不重复读 history。LiveStatusRow/live-status-model 仍只在原位标题离屏时浮动兜底，120ms/reduced 80ms opacity，持久 polite region 不变；实时推理使用上述二级展开生命周期。

`TranscriptDisclosureProvider` 保留窗格/来源下的嵌套手动展开、焦点/选区/锚点，完成不覆盖手动选择。历史窗口 Latest 读真实最新页并通过来源/选择/revision 校验后恢复，失败保留原页；最新流式窗口按共享返回规则恢复跟随，后台刷新不拉走旧页。

前插较早页面重组不完整轮次时，以首个可见消息保留阅读位置（±1px）；被重新归位的 IRC 交付/回复恢复准确 disclosure 路径，避免锚点随折叠结构迁移而消失。查找需要展开多层 disclosure 时批量提交，minimap 在分页稳定后重算。

向上分页在每次提交前保留可见文字片段锚点，并在该次布局提交后、绘制前恢复，而不是整页始终复用一份旧几何快照；保持消息身份与准确 disclosure 路径，最新跟随不被锚点恢复抢占。子代理行按实际尺寸测量，避免估算高度变化推走正文；运行时最新来源权威与用户视口锚点独立，阅读旧位置不改变当前运行时末端。查找栏打开时暂停向上加载历史，关闭后恢复，使当前命中位置稳定；全历史检索仍走命令面板。

内部性能路径不改变展示语义：耗时、时间、数字共用缓存的 Intl 格式器；shell 几何记录只在真实外壳布局切换时执行，FLIP 列表在动画禁用时跳过几何测量，代码块不在初次挂载时重置横向滚动。

滚动接管依据明确的用户 wheel/touch/key/scrollbar 意图，不仅凭 scroll 事件猜测；程序写入、布局变化和浏览器位置修正不冒充新输入。导航使用取消代次与请求生命周期，切换来源或选择后，迟到的定位/刷新不得覆盖新阅读位置。FLIP 在禁用或滚动保护后重置几何基线，不以旧基线补播位移；同文件审阅及侧栏/文件列表刷新保留当前阅读状态。

历史树同源刷新先暂存一致的新窗口，读取至此前已挂载的最旧条目后一次发布；不先用短暂缩小的行集替换可见窗口，避免浏览器原生 scroll clamp。取消、revision 与游标安全检查继续生效，刷新期间不以临时几何重置用户阅读位置。

文本输入去掉全局不透明 focus 阴影，原生 `appearance: none` 仅限文本编辑控件，不波及选择框/复选框等原生控件。历史与审阅搜索使用共享 `field-surface` 外层与透明 `field-editor` 内层，独立搜索复用共享 `Input`；内层不重复绘制背景、边框、阴影或 outline，外层/独立输入仍保留可见键盘焦点。该规则覆盖常态和 focus-visible，不靠单个页面补丁或移除键盘可访问性处理黑框。

当前会话 native ask 在正文内呈现，方向键/Enter 回答，Esc 不关闭必答问题，头部 cue 可聚焦；输入框保持焦点与草稿，可编辑但禁发送并解释，结束后留下本地化回执。启动/其他会话请求保留 ExtensionDialog 模态路径；deadline/超时由 RuntimeStore 唯一处理，不重算期限、不假批准。

### 固定基础呈现与正常内容流

主进程 `nativeTheme` 与 renderer 首屏统一固定深色，根背景使用 PI-Desktop 原版中性色 `#181818`。这是此前回退选定的基线，不声称原版 PI 后续一直固定深色；没有桌面主题、材质或动效选择器。定制熔岩/黑曜石/玻璃配色、`ui/liquid`、光学 WebGL/SVG 材质基础设施与弹簧指示器已移除，而非隐藏或另留兼容皮肤。原生窗口 vibrancy 不属于被移除的自定义玻璃材质。

TaskStep、SubagentStage 和共享总览使用同一名册行，子详情在正常文档流中按内容形成尺寸；此前 PI raised 阶段卡是历史呈现，不再描述当前 UI。不以独立分支画布、材质 inset 或固定场景高度承载正文；真实 OMP 祖先关系、原生状态、分页、稳定消息身份、阅读锚点与来源/资源授权保持不变，不导入 PI runtime 的单层限制。

保留原版间距、字体、点击目标及层级变量的操作契约；portal 的 pointer-events/z-index、焦点交接、原生 vibrancy 与系统减少动态效果支持继续有效。正文、长标题、代码、表格及嵌套任务按正常布局展开或滚动，不用裁切、缩字号或静默丢弃内容掩盖问题。

Composer 仅清除编辑节点继承的 outline 与方形 box-shadow；圆角外壳的可见 focus-within 提示须胜过既有主题覆盖规则，按钮/菜单保留独立 focus-visible。状态 chip 展示简短来源/准入类别，完整诊断与恢复操作留在可键盘访问的展开面板；不修改编辑器草稿、IME、原生权限或全局焦点规则。


### 应用外壳（AppShell）

App 接入 DesktopApi、Chat、SettingsPage 与 WorkPanel；start Promise 前的事件仍按 runtimeId 暂存重放，请求按 runtimeId/request.id 归属，当前 ask 内联，启动/其他会话保留模态路径。停止/错误显式清状态，不自动重发，导航保留草稿且清除视图局部来源错误。

头部为「项目 / 会话标题」与至多一个状态 cue，标题单行/提示/双击改名；右侧是仅保存文件可用的「会话历史与分支」、未读时才有徽标的收件箱与面板开关，28px 控件同中心线。输入区 SessionMeter 只含计划/上下文/花费，无费用值先隐藏；终端持有来源为紧凑只读栏与右侧派生。

容器查询依次收起花费、计划文字与上下文百分比，低于 600px 使用溢出入口；运行状态按原位标题可见性切换浮动兜底，不挤占用量区。`TodoDock.tsx` 仅提供 PlanContent 弹层，不常驻展开；工作面板徽标至多 99+，窄时仅图标。

macOS hiddenInset 预留 88px 红绿灯区，侧栏收起时按钮 x=88、标题 x=124；原生全屏取消预留，按钮 x=8。`getWindowChrome` / `onWindowChrome` 提供原生状态，侧栏切换为一次连续位移，头部与正文同步移动并遵循 reduced-motion。

头部 FLIP 将整个 topbar 作为一个表面移动，修正侧栏/视口变化期间铃铛图标短暂覆盖工作区标签的问题。

`styles/chrome.css` 单独负责头部的单行标题与统一中心线；侧栏/预览共用等待、失败、运行、完成未读优先级。桌面/参与终端是精确证据，未参与终端才标推断；头部与 composer 共用可写性判断，运行点遵循 reduced-motion。

| 模块 | 桌面呈现职责与边界 |
| --- | --- |
| `CommandPalette` / `palette-model` / `shortcuts` | 空查询当前项目最近会话优先，根文件单行，原生英文说明次要呈现；打开会话文件迁入动作。消息部分覆盖、同会话片段合并与准确条目导航共用检索契约，命令只填草稿。 |
| `FindBar` / `find-model` | 原生 Cmd+F 同步打开并聚焦查找框，立即输入不进入 composer；当前对话索引/匹配分块，精确计数与揭示命中，高亮由模块 worker 执行。 |
| `history-explorer-model` | 「会话历史与分支」组织只读树；动作区分从最新内容派生与仅原生支持时的从所选消息前派生，查看不自动执行。 |
| `app/session-meter-model.ts` | `SessionMeterModel`、`buildSessionMeter`、格式化及移植 omp 的 `contextLevel`：警告 50% 或 150K、紫色 70% 或 270K、错误 90% 或 500K，取最高等级；占用不含 output。 |
| `app/useSessionMeter.ts` | 会话状态数据接入；实时原生上下文与保存分支最后请求区分，每次模型请求完成后约 400ms 刷新，未落盘花费回退运行时统计。 |
| `chat/session-meter/SessionMeter.tsx` 与视图/样式 | 输入区计划/上下文/花费，未知费用隐藏；圆环/阈值/模型来源与主子用量拆分保留。运行子代理/队列不在此重复计数，金额交共享 formatter。 |
| `chat/TodoDock.tsx` 的 `PlanContent` | 计划弹出层列出阶段/任务/受阻原因/放弃项并展开当前阶段，区分进行中/计划/来自保存历史/已暂停。芯片为清单图标+完成/总数，有空间时显示实时当前任务；完成+放弃全部结束时为完成样式，受阻有提示点。 |
| `Inbox` / `runtime-store` inbox reducer | 按会话归并待回复、失败、离开时完成与子代理关注；内存已读和跳转不等于取消/回答请求。原生通知仅会话标题/状态，不含请求正文，点击聚焦并选择会话；Dock 标记待回复会话、新请求后台提醒一次。 |
| `SessionPreviewCard` | 悬停/焦点显示状态、项目、时间、请求/答复摘录和模型；不设置独立关注分区。 |
| `HomePanel` / `home-model` | 居中项目提问、同一 composer 与三个建议；仅缺失条件显示依赖顺序卡，缺工作区/已删除/无模型提供直接恢复动作，连接故障保留居中重试卡。 |
| `lib/format-duration.ts` / `lib/display-preferences.ts` | 统一显示偏好及耗时格式；`units` 从月/周/天/时/分/秒取最高两级，1 小时以上不显示秒，`clock` 可显示 147:39。时间线、停止、工具、子代理、收件箱与状态共用。 |
| `ui/motion/` | Presence、Swap、AnimatedNumber 与 useFlipList 共用动效限制。Swap 以共享 IntersectionObserver 跟踪可见性，初次挂载/未变化/屏外标签不动画；状态交换不读取 offsetWidth/offsetHeight/getBoundingClientRect，不做宽度缩放，可见变化仍为 120ms，减少动态效果为 80ms 透明度过渡。 |
| `chat/streaming-reveal.ts` / `streaming-markdown.ts` / `ui/Markdown.tsx` | 完整字形渐进释放，250ms 等待上限/120ms 结束排空，220ms opacity（至多 128）；代码/数学/表格不逐字 fade，历史/替换/reduced-motion 立即显示。 |
| `chat/inline-image-markers.ts` | 图片标记的内联预览/不可用提示，选择复制保留原文。 |
| `chat/TurnChanges.tsx` / `RecordedChangeStep` / `RecordedFileChange` | 每文件最终净结果与 diff，精确行数仅在内容充分时提供；步骤/来源按需展开，不把过程累加或 Git 当前状态当作本轮结果。 |
| `main/data/session-usage.ts` / `DesktopApi.getSessionUsage(path, leafId?)` / `SessionUsageSummary` | 分支有效请求测量、模型/窗口及来源、压缩状态、主/子花费与未记录子代理数；保留 `nonMessageTokens`、`compactionEpoch`、`historyRewriteTokensRemoved`、`contextPrompt`，失败/中断不覆盖有效测量。 |
| `main/data/model-capacity.ts` / `DesktopApi.getModelCapacity(provider, id)` / `SessionModelCapacity` | 模型目录/只读配置提供窗口；新增 `input` 与布尔 `remoteCompaction`，不导出 URL 或凭据，不启动 omp 或联网，未知保持未知。 |
| `SessionResources.resolveUsageChildren` | 只解析匹配的授权子会话，递归用量汇总受深度/数量、环路及去重约束，不向 renderer 暴露原始路径。 |
| `yaml@2.9.1` | ISC 构建依赖，打包进主进程解析只读模型配置；许可记录在 `licenses/frontend-dependencies.json` / `.txt`。 |
| `DesktopApi.getWindowChrome()` / `onWindowChrome(listener)` | 原生全屏状态的读取与订阅，驱动 hiddenInset 预留。 |
| `DesktopApi.gitDiff(cwd, path?, referencedPaths?)` / `WorkspaceDiff` | 嵌套仓库发现；契约增加仓库与延迟补丁元数据，先元数据后所选补丁。 |
| `DesktopApi.getTurnChanges` / `onTurnChanges` / `TurnChangeQuery` / `TurnChangeResult` | 已授权轮次定位、RAM 哈希/内容与递归工具证据融合；结果区分最终变化、内容/行数与覆盖状态，不用 HEAD 补本轮删除统计。 |
| `SessionResourcePage.display?` | 可读输出标题/内容，技术详情保留 ID、路径与原始 JSON，预览截断显式标注。 |
| `DesktopPreferences.messageMeta` / `durationStyle` | 分别为 `always`/`hover`（默认 `always`）与 `units`/`clock`（默认 `units`），经主进程校验、独立持久化；第二道白名单保留外观字段及 `preferredEditor`。 |
| `chat/turn-model.ts` / `TurnProjection` | `projectTurn` 提供 answer、answerSource（final / report-before-epilogue / superseded / yield / none）、noAnswerReason、含边界片段的 chapters 与 epilogue。 |
| `shared/native-harness-notice.ts` | 六类原生跳过/中断通知的统一中性判定；问题计数排除已被成功重试解决的失败。 |
| `shared/subagent-evidence.ts` / `main/data/subagent-evidence.ts` | 多来源与复活代次证据归一化、外部同步任务唯一关联、最终失败/报告发现与中途工具失败分离。 |
| `main/data/session-observer.ts` / `ObservedActivity` | 未参与进程使用增量日志/有界尾部推断；参与进程使用在场 socket 精确状态，超时未知而非 idle。 |
| `main/data/history-discovery.ts` / `HistoryEvent` `listing` | 会话根与项目目录的 fs.watch 提示（300ms 去抖）加 5s 权威对账，复用显式刷新的同一列表与活动推断，经既有 history 事件发布列表；桌面会话落盘确认也触发。 |
| `chat/turn-clock.ts` | 请求开始至各结果收敛的统一时钟；native ask 与明确审批/输入等待在实时及重开后均扣除，等待暂停，亚秒/未知只显示状态。观测陈旧仍不伪造持续运行。 |
| `SessionSummary.activity` / `HistorySnapshot.activity` | 附加只读活动证据，不修改发送/占用准入；陈旧/未知不证明完成。 |
| `app/sidebar-status.ts` | 侧栏/预览/首页共用标记，区分桌面及参与终端的精确证据与未参与终端推断。 |
| `chat/MessageFooter.tsx` / `styles/message-footer.css` | 结束后本轮 tokens/费用、请求表及子合计；原始记录编号/角色/时间/预览，键盘与焦点返回。 |
| `main/data/compaction-policy.ts` / `runtime-store` | 当前配置与模型能力决定压缩/提前准备刻度；配置沿既有只读 listSettings，get_state 刷新同时复制 systemPrompt/dumpTools。 |
| `styles/chrome.css` | 头部唯一样式 owner，项目/单行会话标题、单个状态 cue 与 28px 控件共线。 |
| `locales/messages/turn.ts` / `observe.ts` | 阅读章节、无答复原因与观测状态文案。 |
| `app/composer-mode.ts` | 可写保存来源直接输入；准入检查中 Enter 进入待发送，完成且允许后只提交一次，unknown/external 不绕过写入保护。 |
| `main/data/occupancy.ts` / `main/data/lsof-diagnostics.ts` | 在场锁优先后，只对未参与进程执行目标限定旧启发式；socket 超时不推断锁释放。 |
| `main/data/session-removal.ts` / `main/omp/removal-admission.ts` / `SessionRemovalTarget` | 未保存丢弃免探测；桌面持有先安全关闭；external 阻止，unknown 移到废纸篓需明确同意，关联资源检查不放宽。 |
| `main/omp/service.ts` 的 `requestWithId` / RuntimeStore | 思考等级以运行时公布值校验并随模型更新；标签先更新、失败回滚，目标状态应用不触发全量刷新/historyChanged 或占用检查。 |
| `main/index.ts` 的 `startSession` / runtime access `canFork` | fork 只读来源，不再通过写原会话准入或要求 write access；resume 准入不变。 |
| `resources/omp-desktop-presence.ts` / `extraResources` | 无依赖扩展 v1.0.0，非打包随包携带；桌面始终 `-e` 加载，共享锁/只读 socket 不修改 omp 本体。 |
| `main/presence-install.ts` / `DesktopPreferences.terminalPresence` | 默认开启，原子管理 agentDir 扩展文件，仅覆盖管理标记文件，关闭移除；版本与参与进程数可见。 |
| `main/data/presence.ts` / `shared/presence-tail.ts` | 协议 v1 hello/status 与状态/助手文字流；锁证明持有，实时尾部落盘对账不重复，不提供 prompts、工具参数/输出或控制接口。 |
| 草稿 `--config` / 历史索引 `kind` | 临时 autoResume:false 且不发 new_session，真实消息前不建文件；kind 定位模型/思考，避免全祖先链扫描。 |
| `sidebar-session.ts` | 项目按近期活动、项目内置顶优先；当前项目 8 行/其余 5 行，可展开。共享分钟时钟、派生父标题提示、首消息同帧淡入行；底部仅设置与来源问题。 |
| `chat/smooth-follow.ts` / `transcript-follow.ts` / `revealLatest` | 主/思考框共用 τ80ms controller 与 pre-paint 限幅；两屏内 300ms 动态返回，远处/instant 路径直接定位，用户输入立即中断。 |
| `chat/LiveStatusRow.tsx` / `chat/live-status-model.ts` | 与回复位置原位标题共用运行/等待/重试状态；仅原位标题离屏时浮动兜底，不移动 composer 或改变 transcript 高度，120ms/减少动态效果 80ms 透明度，持续礼貌播报不变。 |
| `chat/tools/tool-model.ts` | toolStepLabel / nativeActivityLabel 统一主体、对象、结果及未知状态，供 ToolStep/TaskStep/状态行使用。 |
| `SessionRemovalResult.retained[]` / 访达定位 IPC | reasonCode/kind 支撑可读保留原因；仅接纳最近移除发出的确切 retained 路径。 |
| presence socket / occupancy | 长路径回退 `/tmp/omp-presence-<uid>/`，主进程后代判为 owned，检查末尾刷新自有事实。 |

Toast 按真实级别、会话/项目来源和跳转动作呈现，重复合并、最多三条可见并用 FLIP 重排；后台通知、标题与 Dock 是注意力投影，不产生新调度或原生权限。

### 设置界面（SettingsSurface）

SettingsPage 的侧栏为桌面端（外观与输入、通知与在场、本地运行时）/omp（模型与默认值、提供商与凭据、高级设置）/关于。高级项整理为 16 个中文分类、122 个标题，raw key 次要等宽，原生说明及搜索结果标为「omp 原文说明」；模型角色查实时目录，服务商按已配置/登录订阅/API 密钥/本地分组检索。来源/默认值未知不臆造，已修改只限本次设置会话，秘密不暴露。

原生认证仍在已有 owned runtime 上显式查询与 login；不能启动时共用 native-login 终端恢复，无隐式登录或秘密存储。关于页显示桌面/omp/在场/引擎版本、打开日志文件夹及不含环境变量/凭据的诊断复制；在场轮询仅在通知栏目可见时进行。固定深色、无主题/动效选择器，动效只跟随系统。

### 文档与许可（ProjectDocs）

本轮产品文档由文档执行者维护 README.md、CHANGELOG.md、docs/SCOPE.md、docs/ARCHITECTURE.md 与 docs/USAGE.md；编排者独占 docs/VERIFICATION.md 和最终证据。现有 LICENSE、THIRD_PARTY_NOTICES.md 与 licenses/** 的主视觉 LGPL、第二参考 Apache 及原作者声明保持不变。使用说明中文，区分实现契约、历史结果与本轮实际观察，不能提前写通过。

## 最终验证

编排者统一安装依赖、typecheck/build、运行协议/数据边界回归，使用真实 installed omp 的隔离配置场景并启动实际 Electron 窗口进行 CDP 浏览器视觉/交互验收。测试数据只写临时 HOME/workspace/userData；不修改用户现有认证、全局设置或会话。最终文档区分已实测、源码支持及已知原生接口边界。

`pnpm e2e` 独立于 `pnpm test`，入口 `bun e2e/run.mjs`，仅 macOS。17 场景为 cold-launch、immediate-enter、live-follow、minimap-follow、completion、concurrent、saved-idle、thinking、thinking-live、thinking-kept、delete、terminal、settings、provider-error、ask、slow-first-token、find-immediate。支持 `--scenario`、`--size`、`--locale zh-CN|en`（默认 zh-CN）、`--app <dir>`、`--out`、fixture/CDP 端口；每场景全新 HOME/userData，拒绝真实 ~/.omp 与非 loopback 网络，本机 fixture/真实 PTY，只清理自身 Trash journal。契约不等于未执行场景已通过。

实时状态 E2E 契约：slow-first-token 断言首输出前的原位思考标题及隐藏底部行；live-follow 断言原位标题离开视口后才出现底部浮动行。

live-follow、minimap-follow、slow-first-token 共用滑动契约：painted gap ≤64px，最后增长后 350ms 内 ≤1px；未触发 lag clamp 时速度 ≤1.45px/ms，触发时位移不大于本帧增长，位移 p95 ≤12px，返回 ≤400ms 且已恢复 following；rAF p95 <20ms，无任务 >100ms。内容缩短、视口调整、显式 snap/settle 豁免。thinking-live 在 1440×900 / 1100×800 覆盖自动展开、内层跟随/可见性、标题交叉淡入、收起时机、手动收起保留与结束后自然高度；thinking-kept 检查结束/保存推理保留及标签一致。

集成补充契约：live-follow 要求跟随时已完成章节在下一章开始后 400ms 内收起，用户滚轮期间仍延后；thinking-kept 要求父标题收起在 `[answerStart + 550ms, max(completion, answerStart + 600ms) + 150ms]`；thinking-live 用应用本地化格式核对耗时，并验证扣除增长的下滚恢复。

本轮证据见 [当前验收：整体体验升级 — 2026-09-30](VERIFICATION.md#当前验收整体体验升级--2026-09-30)，架构契约不代替实际验收。[会话流程、实时阅读、步骤说明与删除 — 2026-09-29](VERIFICATION.md#历史验收会话流程实时阅读步骤说明与删除--2026-09-29) 与更早记录按各自历史范围保留，不证明本轮全量 UI 重放。
