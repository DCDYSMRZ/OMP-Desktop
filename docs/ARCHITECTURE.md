# 架构与并行契约

## 固定路线

Electron 主进程 → 本机 omp --mode rpc-ui（标准输入/输出 JSONL）；sandbox preload 只暴露 src/shared/contracts.ts 的 DesktopApi；React 渲染器只管理展示投影。主视觉来自 PI-Desktop-main；第二参考只借鉴已安装进程桥接算法。禁止引入 PI runtime、Rust host、桌面权限扩展、Agent SDK 或第二套工具执行器。

共享类型由编排者维护。修改接口须先通知编排者，不能为编译方便自行加空实现。各执行者不得中途跑 build/typecheck/test/lint/formatter；完成后由编排者统一验证。

## 目录所有权与导出契约

### 工程与 Electron（DesktopHost）

拥有 package.json、pnpm 配置/锁文件、tsconfig、electron.vite.config.ts、electron-builder 配置、src/main/index.ts、src/preload/index.ts、src/renderer/index.html。其他模块的缺失先按契约接入，不创建替代文件。使用 pnpm@10.34.5（本机无 pnpm 时可 npx --yes pnpm@10.34.5），不要全局安装。依赖安装由编排者执行。

创建安全 BrowserWindow（sandbox/contextIsolation 开，nodeIntegration 关），统一校验 IPC sender，限制导航/外链协议。DesktopApi 每个方法有明确通道，不暴露 ipcRenderer。窗口生命周期负责关闭 owned omp 子进程。选择目录/文件使用原生 dialog；附件选择后交 WorkspaceService 授权/解析。自定义运行路径仅为本机 omp，不接受任意启动参数。

### omp 传输（OmpTransport）

拥有 src/main/omp/**。导出 discovery.ts 的 resolveInstallation(override?: string): Promise<{info: RuntimeInfo; env: NodeJS.ProcessEnv}>；cli.ts 的 runNativeCommand(context: ExecutionContext,args:string[]): Promise<{stdout:string;stderr:string}>；service.ts 的 OmpRuntimeService。ExecutionContext 在此模块导出，结构 {executable:string;env:NodeJS.ProcessEnv;cwd:string;profile?:string}。

OmpRuntimeService 构造函数接收 (event:RuntimeEvent)=>void；start(options:StartSession,context:ExecutionContext):Promise<SessionConnection>；request<T>(runtimeId,command:NativeFrame):Promise<T> 返回已检查 success 的 data；respond(runtimeId,ExtensionResponse):Promise<void> 是独立侧通道；getCwd(runtimeId):string；close(runtimeId):Promise<void>；closeAll():Promise<void>。

start 安装事件监听后启动，协商 v2，get_state 作初始化屏障，分页读取原生消息，拉取 models/commands/thinking levels，订阅 subagent events。start 返回前的事件必须排队并在渲染器能够关联 runtimeId 后可靠送达；可在 start 返回消息后由主进程微任务/后续轮发送，主应用也须暂存未知 runtimeId 的事件。不能将命令 ACK/agent_end 当作 session_settled。限制物理/逻辑帧与 stderr 内存，严格处理 UTF-8/chunk/error/EOF，不自动重试用户请求。关闭先 abort/EOF/drain，再有界终止真正 owned 进程。

### 原生数据（NativeData）

拥有 src/main/data/**。导出 service.ts 的 NativeDataService，构造 {userDataDir:string,getContext:(cwd:string)=>Promise<ExecutionContext>}。方法 getPreferences():Promise<DesktopPreferences>、setPreferences(patch):Promise<DesktopPreferences>、listHistory(options?):Promise<SessionSummary[]>、listSettings(cwd):Promise<SettingsSnapshot>、setSetting(cwd,key,value):Promise<SettingsWriteResult>、resetSetting(cwd,key):Promise<SettingsWriteResult>。

只读索引 native sessions/archives 与原生登记的外部路径，采用真实 header.cwd；工作区、来源文件、授权、watch、接管及 state.sessionFile 按真实路径统一身份，未落盘路径按已存在祖先归一。不可用工作区保留记录路径，不改写原生 header 或因读偏好而回写文件。支持 native profile/env/XDG roots。设置走原生 config CLI，set/reset 后重读；分别保留 overriddenBy 与 fallbackEnv。凭据仅暴露原生存在性，不向 renderer 传明文，不建立第二套认证或会话权威存储。临时历史元数据索引与 Electron userData 偏好不取代原生记录。

正文宽度使用独立桌面偏好 `chatContentWidth`：主进程校验为 360–1600 的有限数值后保存，renderer 由偏好驱动拖柄与重置（760px），重载后恢复；不写入原生 omp 配置。

### 历史查看与写入准入

`readHistory` / `readHistoryTree` / `watchHistory` 提供只读 JSONL/gzip 分支投影与持久化更新，不创建 RPC 会话、不迁移来源或调用模型。`HistoryStore` 按 revision/游标维护 durable ID，`RuntimeStore` 管理 owned RPC；树浏览仅改变查看叶节点，未指定叶节点时跟随最新。所有所选祖先链上的 compaction/reset 记录保留，投影不是模型上下文重建。每页树最多 1,000 节点；不再以 100,000 图节点 cutoff 改为原始源码替代聊天。

完整祖先索引采用单活动来源的临时 SQLite：8 MiB cache、关闭 mmap/journal、2 GiB 临时数据库上限，按文件偏移和小型预览保存元数据而非正文副本；换来源、关闭或失败释放。gzip 范围缓存最多 16 MiB，正文仍分页；超大单条记录来源细节按 64 KiB 读取。临时索引不是原生会话数据库。

明确续写使用 `StartSession.mode = 'resume'` / 原生 `--resume`；明确 fork 使用 `'fork'` / `--fork`，源路径与新会话的 `state.sessionFile` 不混同。fork 的新 ID/parentSession 由原生生成，选中树节点不作为任意 fork 起点。发送后的模型/工具/持久化仍只由真实原生执行。

归档 fork 暂存解压 JSONL 与资源，两者分别上限 512 MiB，资源最多 10,000 项；拒绝符号链接/变化中的文件，按 SHA-256 核对原生创建的目标后再暴露运行时。Host 清理自己的临时目录，不删除原生持久目标。`previousSessionFiles` 仅用于来源/移动线索，不拼接历史。

主进程按规范化会话身份串行化本应用写入准入，写操作前检查 `SessionAccess`（idle / external / owned / unknown），不能依赖 renderer 灰按钮。Darwin 探测综合原生终端 breadcrumb、实际进程/终端和目标文件证据；陈旧 breadcrumb 本身不是活跃所有权，终端未生成但仍存活也不是 idle。健康且没有目标证据的无关 headless 进程不全局阻塞；失败/相关歧义返回 unknown。该检查不是原生全客户端原子 lease，其他平台不冒充可靠空闲。只读跟随与占用刷新各有事件，草稿保留，未落盘 token 不进入历史投影。

`getRuntimeAccess` 只读观察已拥有运行时的缓存启动上下文/当前路径，不为状态轮询物化正文或发原生命令。新建/fork 的分配身份由原生 ID/规范化路径校验，首次落盘不自动撤销；身份变化、关闭/错误不冒充 owned。无路径仅在已验证初始新会话且尚未观察到持久来源的窄条件下可用。renderer 在可见 owned composer 的聚焦/合并轮询和准入失败后刷新观察，但不是 lease。可写时直接 Send，不常驻绿灯；阻塞时显示原因，展开后可刷新或在有可读来源时明确确认 fork，原子转移最新文字/引用/附件且不自动发送。会话树使用现有菜单，没有独立的历史状态/Continue 面板。


### 工作区（WorkspacePanel）

工作区主进程负责受限文件读取、路径搜索、Git 差异及磁盘/剪贴板附件授权。附件保留 source/expiry，无路径的剪贴板图片按 MIME 签名核对；24 项/32 MiB/30 分钟限制，提示词受理后才消费 ID，过期不自动重读。路径搜索以目录前缀缩小遍历，10,000 项/500 结果有部分结果诊断；git 只读 argv 调用。

WorkPanel 保留 Files/Git/子会话与保存资源 tabs，并通过启动页带数量的子代理入口打开 `agents` 总览 tab。总览复用 `groupSubagentsByToolCall` 与 `SubagentStage`，按调用分组并单列未锚定子代理；行仍打开原有详情 tab，不在启动页嵌入第二份子代理列表。活动详情使用原生 byte cursor；保存子会话按父来源/toolCall 只读解析，不启动 RPC/watch，缺失/歧义只保留元数据和诊断。资源引用不授予任意文件读取：仅父来源推导根，排除 symlink/非普通文件。资源/区域每页 64 KiB、每次扫描 8 MiB 后提供续读；目录最多 20,000 项、根 128、子会话 10,000，子任务发现历史扫描最多 100,000 条或 512 页并显示诊断。这些发现边界不截断完整主会话祖先索引。原文用 HighlightedCode，栅格图片按需读取，显式标记二进制/不可用；不引入 Markdown 外部请求。

WorkPanel 通过 `onActiveSubagentChange(id | null)` 报告活动详情 tab；App 保存 `activeSubagentId`，沿 ChatView → Transcript → SubagentStage 下传选中态。非子代理 tab、关闭或卸载面板清空选中；总览与内联卡共享详情入口，保存/实时身份与读取作用域不因展示重排改变。

面板几何测量实际产生布局盒的 `.app-shell`；`.app-chat-shell` 使用 `display: contents`，不能将其 bounding box 作为可用宽度。

### 公共视觉（VisualFoundation）

拥有 src/renderer/ui/**、styles/**、assets/**、lib/**、locales/**。保留原 CSS 顺序、tokens、字体、图标 wrappers、ui 控件、portal/context menu、home mascot、Markdown/代码/数学/mermaid 安全渲染及 minimap 可复用算法。Markdown.tsx 导出 Markdown({source:string,baseDir?:string,cwd?:string,onOpenFile?:(path:string)=>void})、HighlightedCode({code:string,lang?:string})；cwd 为受限本地文件/图片读取提供绝对工作区上下文，不得导入 app/chat store。主入口 src/renderer/styles/globals.css。ui/ui.tsx 和 ui/icons.tsx 保留原公共组件/图标导出；ui/HomeMascotLogo.tsx 导出 HomeMascotLogo。裁掉的业务样式/依赖不进入工程。链接/图片用 DesktopApi 限制访问。

### 聊天（ChatExperience）

拥有 src/renderer/chat/**。model.ts 导出 ChatState、createChatState(connection:SessionConnection)、reduceChatFrame(state:ChatState,frame:NativeFrame):ChatState。ChatState 必须有 state:NativeState、messages（自有展示类型）、models、commands、thinkingLevels、isRunning、isSettled、error?:string、prompts:ExtensionRequest[]、subagents:NativeSubagent[]。raw message snapshots 与 streaming delta 不重复累计；live IDs 不当作 durable IDs，恢复以 native snapshot 为准。工具结果按 toolCallId 关联，不出现两张终态卡。

ChatView.tsx 接入 ChatState、工作区、逻辑 composerKey、发送/停止、模型/思考修改及文件/子代理打开回调，并接收 `activeSubagentId` 与正文宽度偏好。保留 home/docked composer、富文本/思考/活动工具卡、逐答复复制、minimap/follow scroll、附件和 @/slash 菜单、IME 与发送/停止/steer/follow-up；模型/思考共用一个选择入口，不提供整段对话复制。附件通过 DesktopApi；草稿按逻辑 composerKey 保留，外壳可在 home→新运行时接管期间维持该身份，避免重挂载丢失草稿/待发送/错误状态。enterToSend 来自独立桌面偏好。

原生请求片段由 `presentation.ts` 按 assistant turn 投影；`projectTurnProcess` 将过程按 `task` 调用拆成 process/stage 片段，Transcript 在原调用位置渲染 `workspace/SubagentStage.tsx`，最终正文独立展示，stage 不进入折叠的过程。task 不再重复渲染普通 ToolCard，但“原始调用”保留参数/结果访问。思考与普通工具细节独立展开，详情面板复用同一折叠组件。用量摘要取最近有 usage 的原生请求，详情逐请求展示，不将多请求 token/price 误算成整轮汇总。历史接管后的可见旧记录与原生当前上下文分开维护。

`subagent-model.ts` 集中提供状态、标题、活动、指标与计划条目投影。`groupSubagentsByToolCall` 先按全部子代理解析原生明确祖先关系，返回 `byToolCall`、`orphans` 和 `resolvedTrees`；根按 `parentToolCallId` 匹配可见调用，按顶层 index/progress.index 排序，否则保留到达顺序。分组后的 stage 复用完整 `resolvedTrees`，不按局部列表重建关系、不靠点号 ID 猜祖先；未锚定根只在一个末尾 stage 出现。`plannedSubagents` 从 task 参数生成待创建行并按 index 绑定真实子代理，父调用终止后未创建行不得继续显示运行中。

SubagentStage 与详情共享头像/状态和组件级实时耗时；仅运行中计时，终态冻结，不把计时 tick 写进 reducer。终态 task 结果可补齐匹配子代理缺失的 error/abortReason，不能覆盖既有原生状态或把其他调用/异步运行中的子代理终止。状态文字与减少动态效果规则独立于颜色/动画。

`transcript-reading-position.ts` 在 renderer 内存中按会话键最多保存 64 份滚动位置、跟随状态和阅读锚点，不持久化正文或折叠状态。Transcript 恢复几何位置；HistoryStore 先用持久消息 ID 重建包含锚点的分页窗口，再发布投影。分页失败/版本不一致保留锚点，只有一致祖先链读尽且锚点均不存在才回到最新；此内存记录不承诺重启后恢复。

ExtensionDialog 显示真实请求来源与绝对本地 deadline；队列保留 receivedAt/deadlineAt，仅 RuntimeStore 发送超时回答，弹窗不维护倒计时/另设定时器。未提供超时不虚构期限。select/confirm/input/editor、取消，以及 notify/status/widget/editor_text/open_url 都须真实呈现，不能假批准。

### 应用外壳（AppShell）

拥有 src/renderer/App.tsx、main.tsx、app/**（含追加 app 样式），不修改兄弟目录。接入 DesktopApi、Chat model/view、SettingsPage、WorkPanel；保持原布局、侧边栏、主题、project/session 分组、搜索、rename/branch 等真实 native 行为、菜单、快捷键和保存偏好。主进程事件在 start Promise 返回前可到，暂存按 runtimeId 重放。后台会话/交互请求不因切换丢失；全局按 runtimeId+request.id 显示请求。已停止/错误进程显式清状态；不自动重新发送。渲染树在设置/会话切换时保留必要草稿/状态；只显示 native 支持的动作，不留假入口。

### 设置界面（SettingsSurface）

拥有 src/renderer/settings/**。SettingsPage.tsx 导出 SettingsPage({preferences:DesktopPreferences,workspace:string,runtimeInfo:RuntimeInfo,models:NativeModel[],runtimeId:string|null,onPreferencesChange:(patch:Partial<DesktopPreferences>)=>Promise<void>,onClose:()=>void})。保留原全页设置 rail/搜索/cards/rows 外观。常用原生项经源码确认 key 后展示；其余按组默认折叠、搜索可展开定位；只用真实 CLI metadata，不虚构 enum。桌面偏好独立。共享全局修改和覆盖来源明确提示；secret 只显示配置状态并引导原生认证，不暴露 get 原文。无模型的启动失败提供真实配置引导，不造假 key。

原生认证适配仅在已拥有运行时上明确查询 provider metadata、由用户选择后 login，再刷新 metadata/catalog。存在凭据不等于认证验证，原生能力标记不等于全服务商 RPC 兼容；无运行时/交互不支持时保留终端 `/login`。无独立秘密存储，无隐式登录。

### 文档与许可（ProjectDocs）

拥有 README.md、CHANGELOG.md、LICENSE、THIRD_PARTY_NOTICES.md、licenses/**、docs/USAGE.md、docs/VERIFICATION.md。不修改 SCOPE/ARCHITECTURE。记录主视觉 LGPL 和第二参考 Apache 的复制/修改情况；保留许可全文与原作者声明。使用说明中文，真实命令与现有边界；验收结果由编排者最后填写，不能提前写通过。

## 最终验证

编排者统一安装依赖、typecheck/build、运行协议/数据边界回归，使用真实 installed omp 的隔离配置场景并启动实际 Electron 窗口进行 CDP 浏览器视觉/交互验收。测试数据只写临时 HOME/workspace/userData；不修改用户现有认证、全局设置或会话。最终文档区分已实测、源码支持及已知原生接口边界。
