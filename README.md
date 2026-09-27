# OMP-Desktop

本机已安装 **omp** 的桌面前端。沿用 PI-Desktop 的布局、聊天交互、主题与工作面板视觉；Agent 执行只交给外部 `omp --mode rpc-ui`，不捆绑另一个运行时。

- 原生会话、流式消息、紧凑工具/思考、内联子代理委派与侧面详情、输入/审批请求、发送与停止；历史默认只读，明确续写或 fork 才启动执行。
- 共享 omp 的配置、认证和文件会话；常用设置优先，高级项按类别折叠。
- 项目/会话侧栏、JSONL/gzip 只读历史与会话树、父任务保存子会话/输出、附件、只读文件预览和当前 Git 工作区差异。
- 不包含 PI runtime、Rust host、插件市场、调度器、远程/云功能或独立权限策略。

**当前源码类型检查与 173 项测试通过。此前已在 macOS arm64 完成列明的未签名打包及真实 omp/窗口专项复验：新建与持久会话发送、模型/思考级别读回、窄/宽窗口导航，以及保存/实时子任务在 fork 和重开后的连续性。模型端使用隔离本机 fixture；其他平台、真实商业服务商/OAuth 与签名公证未验证。** 精确场景、截图和上游限制见 [docs/VERIFICATION.md](docs/VERIFICATION.md)，不把这些局部通过外推为完整平台/快捷键矩阵。

## 前提

1. **仅源码开发/构建需要** Node.js **>=22.19.0** 与 **pnpm 10.34.5**。已打包的 Electron 应用本身不要求另装系统 Node/pnpm；外部 omp 的安装发行方式及它调用的工具仍有各自的运行依赖。
2. 本机独立安装 omp，并配置真实可用的模型/认证。接口适配基于 omp **18.3.2**；启动还要检查原生 RPC 能力，不能仅靠版本号认定兼容。
3. 本地可访问的项目目录。Git 用于差异面板，不是启动聊天的前提。模型服务商、原生工具/扩展各自的外部依赖由 omp 环境提供。

已有 omp 不需要重新安装。没有时遵循 [oh-my-pi 官方安装说明](https://github.com/can1357/oh-my-pi#install)。macOS 可选：

```sh
brew install can1357/tap/omp
omp --version
omp setup
```

没有可用模型时，原生非交互 RPC 可能在 ready 前退出。请先在终端 `omp setup` 或原生 `omp` 中完成 `/login`、`/model` 配置，再打开桌面；不依赖虚构模型、占位密钥或桌面自建认证库。

## 安装项目依赖与开发

从包含 `OMP-Desktop` 的父目录执行以下命令；若已经在项目根目录，跳过第一行 `cd`。命令仅安装桌面依赖，不安装或更换 omp：

```sh
cd OMP-Desktop
npx --yes pnpm@10.34.5 install
npx --yes pnpm@10.34.5 dev
```

已有项目锁文件时，复现安装可以使用 `install --frozen-lockfile`。首次安装需要访问包仓库与 Electron 下载源；不要跳过必要的 Electron 安装脚本或禁用 sandbox 来掩盖缺失二进制。已安装正确版本的 pnpm 时，可将 `npx --yes pnpm@10.34.5` 简写为 `pnpm`。

项目根 `postinstall` 调用 `install-electron` 下载 Electron 二进制。当前 Electron 43.7.5 npm 包自身不再声明 postinstall，因此 `pnpm rebuild electron` 不能代替安装器。如果先前跳过了脚本或下载未完成，确认网络可用并清除 `ELECTRON_SKIP_BINARY_DOWNLOAD` 后恢复：

```sh
unset ELECTRON_SKIP_BINARY_DOWNLOAD
npx --yes pnpm@10.34.5 exec install-electron
```

该恢复命令仅安装项目 Electron，不安装 omp。不要以手工构造空 `dist/`、复制不匹配版本二进制或禁用安全特性代替成功下载。

首次打开后选择工作区；若 GUI 环境找不到运行文件，在设置中选择真实 `omp` 可执行文件。桌面与终端应使用相同 profile 和环境。全局配置修改会影响终端 omp，凭据仍由原生管理。

需要隔离桌面偏好时，可将环境变量 `OMP_DESKTOP_USER_DATA` 设为专用目录的绝对路径；它只隔离 Electron userData，**不会自动隔离 omp 配置/认证/历史**。原生隔离仍需单独设置临时 HOME/profile 及其环境。不要在实际用户数据上运行写入性验收。

## 检查、构建与预览

```sh
npx --yes pnpm@10.34.5 typecheck
npx --yes pnpm@10.34.5 test
npx --yes pnpm@10.34.5 build
npx --yes pnpm@10.34.5 preview
```

`build` 使用 electron-vite，输出到 `out/`；`preview` 启动已构建的 Electron 应用，不是打包后的安装包。`test` 执行仓库中维护的 TypeScript 行为回归。类型检查、单元回归、构建、实际 omp 场景、Electron 窗口和打包产物启动是不同证据，不能相互替代。

## 未签名本地打包

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npx --yes pnpm@10.34.5 run pack
```

必须使用 `run pack` 调用本项目脚本；`pnpm pack` 是包管理器自身的 npm tarball 命令，不是桌面打包。上面的环境变量在 macOS/Linux shell 中关闭签名身份自动发现，不使用个人签名身份或发布凭据。

此脚本先构建，再调用 `electron-builder --dir --publish never`，将当前宿主平台的**未打包目录形式应用**输出到 `release/`。平台/架构对应子目录由 electron-builder 决定；macOS 的目录中包含 `OMP-Desktop.app`。它不是 DMG/PKG/NSIS 安装器，也不是发布或上传命令。应用内包含 Electron 与前端，不包含 omp 可执行文件、用户认证或原生历史。目标机器仍需另行安装和配置 omp。

本次历史/桌面体验修正产物单独放在 **`release/history-fix/mac-arm64/OMP-Desktop.app`**，刻意不覆盖用户正在运行的旧 `release/mac-arm64/OMP-Desktop.app`。最新打包记录为 564，实际复验范围见验证文档。上述常规 `run pack` 仍输出到 `release/` 的平台目录；打开旧路径不构成本次修正证据。两者均不内置 omp。

当前配置关闭 macOS 签名身份、公证与 hardened runtime，Windows 不做可执行文件签名；不存在已签名、公证、自动更新或跨平台实测发行版承诺。优先在同平台本机打包与运行，不以配置中存在平台字段宣称该平台已经验证。

macOS 对未签名应用可能显示安全提示。仅对你审核并在本机生成的可信产物，按系统“隐私与安全性”提示处理；不要全局关闭 Gatekeeper、递归去除来源不明软件的隔离标记或禁用 Electron 沙箱。

## 数据、安全与限制

- 通常使用 `~/.omp/agent` 的原生配置与会话，但 profile、环境变量和 XDG 根目录可能改变位置。桌面偏好单独存于 Electron `userData`；历史临时 SQLite 只存可丢弃元数据，不是第二套 Agent 会话权威存储。
- 历史搜索是本地文件会话标题/预览索引，不是全部正文全文搜索，也不覆盖所有 SDK 替代存储和未登记外部目录。打开历史和会话树只读，不自动恢复、迁移原文件或发起模型请求；明确续写才交给 omp 恢复。
- Send 旁在阻塞时直接显示原因；点击可刷新状态，有可读来源时提供需确认的 fork，转移草稿/附件但不自动发送。可发送时没有常驻绿灯或独立 Continue 面板；终端正常退出后重新观察为空闲，才可主动发送续写原会话。
- 占用判断基于 macOS 的进程、终端及目标文件证据，不是所有客户端共同遵守的原子锁。未知状态不允许写入；无关健康 headless 进程没有目标证据时不会全局阻塞。查看器跟随持久化记录，不展示另一个终端尚未落盘的 token。
- 文件面板只读；差异展示当前 Git 工作区状态，可能包含用户修改，不是 PI 每工具快照，也没有假回滚。
- 任意原生 TUI 组件不能通过 RPC 完整显示；需要终端交互的扩展或首次认证应回到原生 omp。
- 渲染器沙箱不等于 Agent 工具沙箱。omp 使用当前用户权限；工具可能修改文件、运行命令、联网并产生费用。停止不能撤销已经执行的操作。

详细说明见 [使用指南](docs/USAGE.md)、[需求边界](docs/SCOPE.md)、[架构](docs/ARCHITECTURE.md) 与 [变更记录](CHANGELOG.md)。

## 许可与上游

主视觉与前端派生自 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)，保留 **GNU LGPL v3.0**（本项目使用保守标识 `LGPL-3.0-only`，不推定额外的 or-later 授权）。部分进程发现/传输算法改编自 [FaqFirebase/pi-desktop](https://github.com/FaqFirebase/pi-desktop)，保留 **Apache-2.0** 与原作者署名。这不是将主项目重新许可为 Apache/MIT。

见 [LICENSE](LICENSE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [licenses/](licenses/)。发行二进制时还需按适用许可提供对应源码、构建/重新组合材料及各依赖的许可通知；本地打包成功不等于已完成对外发行合规。项目按适用许可“按原样”提供，不附带保证。
