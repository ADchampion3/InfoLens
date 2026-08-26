# Infolens 架构

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

## 状态

这是 MVP 当前的架构基线，记录受信任的 Plugin 边界、Standalone Daemon、Browser/Electron
Client、Package Contract、Workspace 嵌入、Plugin 持久化、版本化 HTTP API 和本地诊断策略。

## 架构意图

Infolens 是围绕 Standalone Infolens Daemon 构建的 local-first 应用。Daemon 负责
Plugin Runtime、Plugin Discovery、持久化状态、Task 执行、Diagnostics 和版本化 Business
HTTP API。Host Web 是客户端 Shell，可以在普通浏览器中运行，也可以运行在 Electron
Desktop Shell 中。Electron Process 只是可以启动或发现 Daemon 并提供 OS Primitive 的
Thin Client，不拥有 Daemon 的生命周期。每个 Plugin 负责自己的信息源采集、信息源专属
本地持久化、刷新行为和完整用户界面。

Daemon Distribution 内置固定版本的 OpenCLI Runtime，并调用应用本地的 CLI 路径。
Plugin Backend 不能直接启动 OpenCLI、使用全局 Adapter Discovery 或传入任意 Command
Path；它只能调用 `context.opencli.run(commandKey, args, signal)`。Daemon 根据 Manifest
中声明的 Command Mapping 和受管理的 Adapter Scope 解析实际执行。浏览器依赖型
OpenCLI Adapter 仍要求用户安装并连接 Chrome Browser Bridge 扩展；Host Web 展示依赖
状态和恢复操作。

Browser Bridge 可用性是 Plugin 级依赖。连接缺失或站点登录过期，只会让受影响的
Plugin 无法进行浏览器依赖型采集；不依赖浏览器的 Plugin 仍会正常启动、刷新和渲染。
受影响 Plugin 在自己的 Workspace 中负责详细的连接或登录指引，Host 只在导航中显示
简短的依赖状态。

应用不能 Fork OpenCLI，也不能复制它的 Browser Bridge、Chrome Daemon、Extension
Protocol、Adapter Discovery 或抓取逻辑。Daemon 可以使用 OpenCLI 为信息源提供的现有
只读 Adapter，以及 Adapter 需要登录时使用其浏览器执行路径，但必须经过声明的
Command 和受管理的 Adapter Boundary。

## 系统边界

```text
Browser Client / Electron Client
  Host Web Shell
  Plugin Navigation and Settings
  Plugin Workspace Container
          |
          | authenticated loopback HTTP: /api/v1
          v
Standalone Infolens Daemon
  Discovery and Package Validation
  Plugin Lifecycle and Host State
  Plugin Task and Batch Scheduling
  Diagnostics and Backup/Restore
  Versioned Business API (/api/v1)
          |
          v
Trusted Source Plugins
  OpenCLI Strategy Representative Plugins
    Hacker News Plugin (PUBLIC)
    GitHub Trending Plugin (PUBLIC)
    Zhihu Hot List Plugin (COOKIE)
    Product Hunt Plugin (INTERCEPT)
    Plugin UI
      same-origin HTTP through the daemon
          |
          v
Plugin Runtime inside the Daemon
  Plugin Backend Modules
  Plugin Workspace Static Assets
  Plugin-Scoped HTTP Routes
  Plugin Task Scheduler
  Plugin Stores and Refresh Logic
  OpenCLI CLI Process Adapter
          |
          v
OpenCLI Runtime
  Bundled Pinned CLI
  Adapter Registry and Commands
  Browser Bridge / Local Daemon
  Chrome Profile and Login State
          |
          v
External Sources
  Hacker News | GitHub Trending | Zhihu | Product Hunt
```

Daemon 负责 Plugin Discovery、Package Validation、Lifecycle、Host State、Task/Batch
Scheduling、Diagnostics 和 `/api/v1` Business Boundary。Host Web 负责 Navigation、
Presentation 和 Client Session State。Electron 可以启动或发现 Daemon、将 BrowserWindow
连接到 Daemon 提供的 Host Web，并提供 OS Primitive；关闭窗口只会断开 Client，不会停止
Daemon。Plugin 负责自己的持久化记录、Refresh Policy、Content UI 和信息源 Schema。
OpenCLI 负责在 Daemon 授权的 Manifest Command 下获得 Collection Result。

## 仓库结构

```text
apps/desktop/              Electron Thin Client 和 OS Integration
packages/plugin-runtime/   Standalone Daemon 和 Plugin Runtime
packages/plugin-sdk/       共享 Manifest、Backend 和 Workspace Helpers
packages/plugin-distribution/  确定性的 ZIP Artifact 和 Distribution Source
plugins/hn/                Bundled Hacker News Plugin (`PUBLIC`)
plugins/github-trending/   Bundled GitHub Trending Plugin (`PUBLIC`)
plugins/zhihu-hot/         Bundled Zhihu Hot List Plugin (`COOKIE`)
plugins/product-hunt/      Bundled Product Hunt Plugin (`INTERCEPT`)
```

仓库固定的 `plugins/` 目录是构建后 Package 的开发和 Daemon Discovery 位置。
Personal Plugin Distribution 会在该目录之外暂存确定性的 ZIP，验证后将解压出的 Package
提交到同一个受管理位置。MVP 不区分官方 Package 和用户安装的 Package；所有被发现的
Package 使用相同的 Daemon-owned Lifecycle 和移除语义。

Host Web 使用 React、Vite 和 TypeScript。它渲染持久的左侧 Plugin
Navigation Rail、选中 Plugin 的右侧 Workspace Frame，以及导航底部的 Plugin 管理和
应用 Settings 项。它负责 Navigation、Daemon-backed Lifecycle Status 和 Client 级
Error State，不会渲染 Content Dashboard 或 Plugin Business Content。Electron 只提供
Window 和 OS Integration，不复制这些 Business Logic。

## Plugin SDK 边界

`@infolens/plugin-sdk` 是轻量的 Runtime Contract Package。它提供类型化 Manifest
Helper、Backend Module Activation 和 Health Helper、Plugin Data Directory 访问、Task
Registration、Enqueue 和 Schedule Registration Helper、OpenCLI JSON 调用 Helper，以及
解析 Daemon 中 `/api/v1` Plugin API Path 的 Workspace Helper。`/runtime/` 只保留给
浏览器 SDK 等静态 Workspace Support Resource，不是 Business API。

SDK 不定义 Content Schema、Database、Refresh Policy、UI Component System 或 Frontend
Framework。这些是 Plugin 自己的决策。Plugin Runtime 根据 Plugin 注册的 Policy 实现
共享 Scheduler。

## Bundled Plugin 持久化

每个 Bundled MVP Plugin 都会在自己的 Plugin Data Directory 中使用独立的 SQLite
Database 保存记录。每个 Plugin 自己负责 Schema Version 和 Migration；Host 不协调也
不解释这些 Migration。这让 Bundled Plugin 可以使用一致的持久化实现，同时不会创建
跨 Plugin 的 Schema 或 Database。

## Host State

Daemon 在自己的 Daemon Data Root 下用原子写入的文件保存 Host State 和其他 Daemon-owned
Metadata，包括 Enabled Plugin ID、最后选中的可用 Plugin、System/Light/Dark Theme
Preference、每个 Plugin 的 Status Snapshot、Task/Batch Evidence、Diagnostics 和
Discovery Record。Host Web 与 Electron 只保存临时 Client State，不成为 Plugin State
或 Lifecycle 的第二个所有者。

Bundled Plugin 会跟随选定的 Host Theme。第三方 Plugin 可以选择遵循 Theme Convention，
但 Host 不要求它们使用 Host 的 UI Component 或 Styling System。

## Plugin Package Contract

受信任的 Plugin Package 至少包含：

```text
plugin/
  manifest.json
  backend/
    index.js
  web/
    dist/
      index.html
      assets/
```

每个 Plugin 都必须提供构建后的静态 Web Workspace：`web/dist/index.html`。所有
Workspace Asset URL 必须相对于该 Entry，这样 Bundle 被 Daemon 挂载到
`/plugins/<pluginId>/workspace/` 下时仍然有效。Daemon 不要求 Bundle 使用特定 Frontend
Framework；Host Web 和 Bundled MVP Plugin 使用 React、Vite。

初始 Manifest Contract 至少声明：

- 稳定的 Plugin `id`、展示用 `name`、`version` 和可选的 `icon`；
- Infolens Plugin Package Contract 的 `contractVersion`，以及 Semantic Version 格式
  的最低版本 `minHostVersion`；
- Plugin Backend Module Activation Entry Point：`backend.entry`；
- 构建后 Plugin Workspace：`ui.entry`；
- Plugin 的 OpenCLI Command Mapping。

当前只支持 Plugin Contract Version 2。OpenCLI Command Mapping 以 `commandKey` 为
Key，并明确指定 `adapter: "builtin"` 或 Provided OpenCLI Adapter Declaration。每项
还声明 `site`、不可变的 `command` Path、`strategy`（`PUBLIC`、`COOKIE` 或
`INTERCEPT`）、`access: "read"` 和 `outputFormat: "json"`。Adapter 兼容性由标准
`opencli-plugin.json` 负责；Runtime 会根据固定的 OpenCLI Version 验证它、探测实际
Registration、拒绝 Hook 和 Command Collision，并将结果写入 Plugin Scope Lock。
`UI` 仍不受支持。

Provided Adapter 会被复制到 Infolens 管理的不可变 Store 中，位置在 OpenCLI 的
`node_modules` 之外。相同 ID、Version 和 Content Hash 会去重；同一 ID 和 Version 下
不同内容会被拒绝。多个 Version 可以共存。每个 Plugin 获得一个 Scope Lock，其中包含
准确的 Adapter Path、Version、Hash 和已注册 Command。OpenCLI 禁用用户全局 Discovery，
只接收这些精确路径。Development Scope 链接源文件，Installed Scope 引用不可变 Store
内容。

将 Distribution Artifact 提交到受管理的 Plugin Directory 之前，Daemon 会限制并安全检查
ZIP，然后检查 Contract Version 是否受支持、Daemon Semantic Version 是否满足
`minHostVersion`，以及每个声明的 Command Mapping 是否受支持。启动 Discovery 时，Daemon
会对每个 Package 重复这些检查。发现不兼容时，会在任何安装变更或 Module Activation 之前
说明原因并拒绝。被拒绝的 Package 不会被激活，也不会出现在普通 Navigation 中，但会保留
在 Plugin Management 中供检查和移除。Daemon 只执行 Discovery 和启动所需的结构性
Package Validation。默认情况下，已安装的本地 Plugin 是受信任的：没有 Permission
Approval、Package Review、Data Generation System 或由发布方控制的发布工作流。

启动时，Daemon 扫描项目固定的 `plugins/` 目录寻找 Plugin Package。Personal Plugin
Distribution 接受本地 ZIP，或带预期 SHA-256 的直接 HTTPS ZIP URL，在受管理目录之外暂存，
并在验证成功后立即启用。没有既有 Daemon State 的有效 Discovered Plugin 默认启用；用户
禁用的 Plugin 保持禁用。MVP Development Build 会在官方 Plugin 的仓库目录中运行它们，
不支持外部 Development Link、Symbolic Link 或 Plugin Hot Reload。

已有 External Plugin ID 必须使用显式的 Replace Intent；Bundled Plugin 不能由 Personal
Plugin Distribution 替换。Replace 和 Rollback 按 Plugin 串行执行。切换前，Daemon 会快照
Package、Plugin-owned Data、Adapter Scope、Host State Metadata 和启用状态，只保留一个完整
的上一版本；Deactivate、磁盘、Validation、切换或 Activation 失败时恢复该版本。Rollback
交换当前和上一版本的完整快照，不执行 Data Migration。

明确移除 Plugin 时，Daemon 会要求 Plugin Runtime Deactivate Module、取消 Task、注销
Route，然后删除 Package、Plugin-owned Data Directory、Adapter Scope 和保留的 Distribution
Revision。如果 Module 在短暂 Grace Period 内没有结束，Daemon 会在删除前重启不包含该
Module 的 Plugin Runtime。除一个显式 Replace Revision 外，Daemon 不保留 Source Data，
因为新 Package 可能使用不兼容的数据格式。

Daemon 在 `http://127.0.0.1:<daemonPort>/plugins/<pluginId>/workspace/` 提供每个
Plugin 的构建后 Web Workspace，在
`http://127.0.0.1:<daemonPort>/api/v1/plugins/<pluginId>/api/` 提供 Business API，
并通过 `GET /api/v1/plugins/<pluginId>/health` 提供 Health。Host Web 在 Frame 中打开
Workspace URL；Plugin 控制 Workspace Body，Host Web 控制周围的 Navigation。共享 Daemon
Origin 让 Workspace 可以在没有 CORS 或 Electron Security Exception 的情况下调用自己的
API。Electron 连接这个 Origin，并可在 Daemon 重启后重新连接；它不拥有 Daemon Process。

## 最小 Plugin 生命周期 Contract

Daemon 绑定一个 Loopback API Port，并写入供 Client 发现的 Discovery Record。激活时，
每个 Enabled Backend Module 获得自己的 Plugin Data Directory，并注册 API Route 和 Task
Handler。只有在 `GET /api/v1/plugins/<pluginId>/health` 返回 `ready` 后，Plugin 才可用；
之前 Host Web 将其显示为 Starting 或 Unavailable。

Health Response 还可以包含最近刷新时间和可选的简短 Navigation Badge。Host 将 Badge
视为不透明的 Plugin Metadata，只展示其值，不赋予共享的 Unread、Task 或 Content 语义。

停止或移除 Plugin 时，Daemon 要求 Plugin Runtime Abort 该 Module 的 Task、调用 Cleanup
Handler 并注销 Route，然后等待短暂的 Grace Period。如果 Module 没有结束，Daemon 会在
完成移除前重启不包含该 Module 的 Plugin Runtime。Client 通过已认证的 `/api/v1`
Administration Boundary 操作，不直接控制进程内 Module State。

## Plugin UI 与 Backend 通信

每个 Backend Module 都在 Daemon 的
`/api/v1/plugins/<pluginId>/api/` 下注册 Plugin-scoped Local HTTP API；Health Endpoint 是
`GET /api/v1/plugins/<pluginId>/health`。打开 Workspace 时，Host Web 将 `pluginId` 和该
Plugin 同源的 `apiBaseUrl` 放入 URL Query Parameter；Workspace Helper 读取这些值，并
直接调用 Plugin API 来获取 Content、执行 Refresh Action 和 Plugin 自己定义的交互。
Electron Client 不会 Route、Validate 或 Translate Business Request。Daemon 重启时，Client
重新连接 Discovery Origin 并重新加载受影响的 Workspace。

Host 还会在 Iframe URL 中提供初始 Theme，并通过最小的 `postMessage` Payload 发送
Theme Change。Workspace SDK Helper 读取初始值并订阅更新。这只是外观约定，不是 Host
Business RPC Channel。

Standalone Daemon 在自己的 Node Process 中运行共享 Plugin Runtime。它动态加载每个
Enabled Backend Module，按 Plugin ID 隔离 Route 和 Task State，提供 Workspace Asset，
并通过本地 CLI Child Process 调用 OpenCLI。Backend Module 负责信息源专属的持久化和
HTTP Handler；Daemon 负责生命周期、Task Scheduling、Resource Permit、Static Workspace
Delivery、Route Dispatch、Authentication 和 Client Session。Electron 可以验证 Readiness
并保存临时连接状态，但不会代理 OpenCLI Command，也不会暴露第二套 Business RPC Surface。

## Plugin Backend Module 接口

每个 `backend.entry` 都导出 `activate(context)`。Runtime 在 Module Activation 时
调用一次，并要求得到支持 Cleanup 的生命周期结果。Activation Context 提供 Plugin ID
和 Data Directory、Plugin-scoped HTTP Route Registration、Task Definition/Enqueueing/
Schedule Registration、Logger，以及 `opencli.run(commandKey, args, signal)`。

Backend Module 从自己的 Data Directory 打开并 Migration 自己的 SQLite Store，在自己的
Prefix 下注册 Route，并注册长时间运行工作的 Handler。它从自己的 Store 读取 Refresh
Setting，并通过 Context 注册选定的 Schedule；不能创建独立 Timer 或 Scheduler。Runtime
提供 Task Cancellation 并强制执行 Permit。

`opencli.run` 只接受该 Plugin Manifest Mapping 中声明的 Command Key。已验证的 Task
Argument 会直接作为 Command 的 Argument Vector 传入；Runtime 不引入序列化 Argument
Schema 或第二套 Task Transfer Protocol。Runtime 解析不可变的 Command Path，验证固定
OpenCLI Version 和 Command Availability，获取对应 Resource Permit，并以 JSON Output
启动 Bundled OpenCLI Process。Backend Module 不能监听自己的 Port、直接创建 OpenCLI
Subprocess 或管理独立 Scheduler。Cleanup Result 应在 Deactivation 时取消 Database
Handle 和 Subscription 等 Source-owned Resource。

Runtime 为 Module Activation、Route Handler、Task Handler 和 Cleanup 包裹 Plugin-scoped
Error Boundary。普通 Plugin Exception 只会使该 Plugin Unavailable 或 Failed，不会停止
兄弟 Module。Runtime-level Exit 可能短暂中断所有 Plugin API，直到 Daemon Recovery 并重新
激活 Enabled Module；Client 重新连接 Daemon Origin。MVP 不试图阻止受信任 Plugin 故意终止
Runtime Process 或导致 Native Process Crash。

## 本地诊断

Daemon 将结构化的 Lifecycle 和 Refresh Outcome 发给自己的 Host State，并原子地保存
Status Snapshot。Host State 不包含 Raw Log、采集的信息源记录、网站凭据、Chrome Profile
或 Browser Bridge Session Data。

Activation Context Logger 会在每个 Plugin 的 Data Directory 中写入有大小限制的循环
日志。Host Web 可以通过 Daemon 的 `/api/v1` Diagnostics Boundary 请求选定 Plugin 的
Diagnostic Report，报告包含 Status Snapshot 和最近的 Log Entry，然后可以在本地复制。
Report 按 Plugin 隔离，不包含信息源记录或身份验证材料。移除 Plugin 时，这些日志会与
Package Data 一起删除。

## Plugin Task 执行

激活时，Backend Module 向 Daemon 的 Plugin Runtime 注册命名 Task Handler。Task Enqueue Request
只包含 Plugin ID、Task Name、Input 和 Trigger Reason；加载后的 Handler 自己验证
Input，Crawler Implementation 保留在内存中的 Plugin Code 中，不通过 HTTP 发送，也不
序列化进 Queue。

Plugin Workspace 通过自己的 Route 入队 Refresh 等长时间运行的工作。Plugin-local
Schedule 使用同一条 Enqueue Path。短暂的 SQLite Read 和 Detail Query 直接在自己的
Plugin Route Handler 中执行。

Daemon 每个 Plugin 最多允许一个 Active Collection Task，并合并该 Plugin 的重复刷新
请求。每次 `opencli.run` 都从已验证的 Command Mapping 获取 Permit：最多并发运行三个
`PUBLIC` Command，同时最多运行一个浏览器依赖型 `COOKIE` 或 `INTERCEPT` Command。
因此一个 Task 可以调用不同 Strategy 的 Command，而不必把整个 Plugin 分类为浏览器
依赖型。Task Failure 只更新该 Plugin 的 Status；Daemon 自己退出时，Client 可以在它
重启后重新连接，Active Work 会被标记为 `interrupted`。

## Plugin Collection Contract

每个 Plugin 在 Manifest 中声明 OpenCLI Command Mapping，但只有 Daemon 可以跨进程调用
OpenCLI。Plugin Backend 通过注入的 `context.opencli.run(commandKey, args, signal)` 使用
它，并且必须：

1. 只传入 Manifest 声明的 Command Key 和已经验证的 Argument Vector。
2. 让 Daemon 选择固定的 Executable、受管理的 Adapter Scope、Resource Permit 和 JSON Output。
3. 返回 Daemon Result 以及开始时间、结束时间、Failure 和原始信息源标识等执行元数据。
4. 不向 UI Code 暴露 OpenCLI Command Parsing、Browser Transport 或 Browser Session
   Implementation。

MVP 中，每个受信任 Plugin 都将信息源映射到对应的 OpenCLI Read Command。这个 Mapping
保留在 Plugin Manifest 和 Backend 内；Host Web 选择的是 Plugin 或 Task，而不是信息源或
任意 Command String。Daemon 会拒绝未声明的 Command Key 和用户传入的 Command Path。

Bundled MVP 必须包含三个 OpenCLI Website Collection Strategy 的正常、可见官方 Plugin：
Hacker News 和 GitHub Trending 使用 `PUBLIC`，Zhihu Hot List 使用 `COOKIE`，Product
Hunt Today's Top Launches 使用 `INTERCEPT`。这些是官方日常使用的 Workspace，不是隐藏
的 Strategy Verification Fixture。Strategy 在每个 Plugin 的 OpenCLI Command Mapping
中声明，并且必须与真实 Adapter Execution 一致。

OpenCLI 的 `UI` Strategy 不在当前 Plugin Package 和 Runtime Contract 内。MVP 不会
Bundled 或接受它用于本地安装。将来支持它需要修订 Contract，定义交互式执行和资源策略。

Release Verification 会在 Release Candidate 开发机的真实信息源环境中，通过 Bundled
OpenCLI Runtime 运行全部四个 MVP Plugin。环境需要连接 Browser Bridge，并准备所需的
浏览器 Session。只有当 OpenCLI Command 产生可用结果、Plugin 将结果写入自己的 SQLite
Store、Workspace 能渲染保留的结果时，Strategy Representative 才算通过。隔离自动化
测试可以使用 Fake OpenCLI Output，但这不能证明 Strategy Representative 正常工作。

CI 只运行不需要凭据的 Unit Test 和 Contract Test。它不会保留网站凭据、Chrome Profile
或 Browser Bridge Session，也不能证明实时的 `COOKIE` 或 `INTERCEPT` Operation。

## Runtime Flow

### 启动应用

1. Daemon 发现 Plugin Package，验证 Package 和 OpenCLI 兼容性，并确定启用状态。没有既有
   Daemon State 的兼容 Package 默认启用；被拒绝的 Package 只保留在 Plugin Management 中。
2. Daemon 启动自己的 Plugin Runtime，激活所有 Enabled Plugin Backend Module，绑定
   Loopback HTTP，并写入 Discovery Record。
3. Host Web 或 Electron 通过 `/api/v1` 完成 Bootstrap/Authentication，读取 Daemon-backed
   Status，并打开选中的 Workspace。
4. 运行中的 Plugin 在 Daemon 生命周期内遵循自己的 Refresh Policy，不依赖某一个 Client。

### 退出应用

1. 关闭 Electron BrowserWindow 只会断开该 Client，不会停止 Daemon。
2. Daemon 继续为 Host Web、Plugin Workspace 和其他 Client 提供服务并运行 Schedule。
3. 只有显式的、已认证的 Daemon Stop 才会 Deactivate Module，并将未完成 Task 或 Batch
   Item 标记为 `interrupted`；关闭 Electron Window 不会触发它。

### 打开 Plugin

1. Host Web 渲染 Plugin Navigation 和 Daemon-backed Status。
2. 用户选择一个 Plugin。
3. Host Web 在主内容区域打开 Daemon 提供的该 Plugin Workspace。
4. Plugin 读取并渲染自己保留的记录。

### 刷新

1. Plugin UI Action 或自己的 Refresh Policy 请求刷新。
2. Daemon 合并该 Plugin 冲突的 Collection Work，并应用对应 Resource Permit。
3. Plugin Backend 通过 `context.opencli.run` 请求声明的 Command，Daemon 调用 OpenCLI。
4. OpenCLI 根据 Adapter 的要求，使用原生 Public Fetch 或 Browser-backed Mechanism。
5. Plugin 使用自己的信息源记录 Model 验证并持久化成功结果。
6. 失败时，Plugin 保留最近一次成功的记录，Daemon 为 Client 记录 Operational Status。

## 核心概念

**Plugin** 是受信任的本地 Package，为一种面向信息源的体验负责采集、持久化和
Workspace。

Bundled MVP Plugin 按 Infolens Package Contract 重新设计。它们可以复用通用的 React、
Vite、Electron 和 OpenCLI 技术，但不会继承 TractIt 的 Plugin 行为、Data Model、
Lifecycle 或 Workspace Implementation。

**Plugin Workspace** 是一个 Plugin 渲染的完整主内容用户界面。

**Plugin Manifest** 是 Daemon 用于验证、识别、激活并暴露 Plugin 的小型 Package Descriptor。

**Source** 是 Plugin 采集的外部 Provider。MVP 信息源是 Hacker News、GitHub Trending、
Zhihu Hot List 和 Product Hunt Today's Top Launches。

**Refresh Policy** 是 Plugin 定义的信息源采集规则。Manual-only 是有效策略。

对于 Bundled Plugin，用户在 Plugin Workspace Settings 中选择 Manual-only、Disabled 或
支持的固定 Interval。Plugin 将 Setting 保存到自己的 SQLite Store 并调度 Collection；
Host 只展示结果 Status。

所有新安装的 Plugin 都从 Manual-only Mode 开始。只有用户明确在 Plugin Settings 中
选择 Interval 后，Plugin 才会进行自动后台采集。

**Plugin Store** 是一个 Plugin 拥有的本地持久化 Store，保存该 Plugin 的记录，并在没有
Host 定义的 Business Schema 的情况下演进。

## 可靠性原则

- Plugin-owned Cached Content 是主要读取路径；Collection 是异步工作。
- 普通 Plugin Activation、Route、Task 或 Cleanup Failure 必须隔离，不能阻塞 Host Web
  Navigation 或其他 Plugin。Daemon-level Crash 可能在恢复前短暂中断 Plugin API；Active
  Work 会被标记为 `interrupted`。
- Plugin 保留最新的成功内容，直到成功替换它。
- Daemon 通过 `/api/v1` 暴露简短的 Lifecycle 和 Last-refresh Status；Plugin 自己选择详细的 Refresh UI。
- OpenCLI 可能报告不确定的 Browser Command Outcome。Plugin 将其记录为 Uncertain 或
  Failed，不会静默重放 Collection。

## 安全边界

MVP 是一个默认信任已安装 Plugin 的单用户本地应用。它没有 Plugin Permission Review、
Approval 或恶意代码 Sandbox Layer。Host 仍通过隔离 Plugin Lifecycle、Workspace Loading、
Log 和 Diagnostic Report，将普通故障限制在 Plugin 自己的边界内。

## 明确不属于本架构的内容

MVP 不是 Hosted Multi-tenant Service、Distributed Crawler System、Plugin Marketplace、
Generic OpenCLI Command Launcher、集中规范化的信息源数据 Store，也不是由 Host 管理的
跨 Plugin Content Feed。
