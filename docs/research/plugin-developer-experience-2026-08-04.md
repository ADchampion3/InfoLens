# Infolens 插件开发者体验研究

研究日期：2026-08-04

## 研究边界与方法

本笔记只使用仓库中的源码、架构文档、插件开发文档、ADR、官方插件示例和测试夹具。没有运行桌面应用或进行 UI 测试；仅运行了插件 CLI 的非 UI 契约检查，以确认文档和实现是否一致。

术语遵循 [`CONTEXT.md`](../../CONTEXT.md)：Plugin 是可信本地包，Plugin Runtime 是加载后端模块、调度任务并调用 OpenCLI 的共享 Node 子进程，Plugin Workspace 是插件拥有的完整主内容界面。

## 结论摘要

当前机制的核心边界是清楚的：一个插件包同时拥有 `manifest.json`、后端模块、静态 Workspace、Plugin Store、刷新策略和 OpenCLI 映射；Host Shell 只负责发现、生命周期、导航和诊断。Contract V2 对 manifest、Provided Adapter 和 OpenCLI 命令做了比普通本地脚本更严格的预检，且插件之间的数据和失败边界清晰。[`ARCHITECTURE.md:59-80`](../../ARCHITECTURE.md) [`docs/adr/0006-trusted-plugin-owned-workspaces.md`](../adr/0006-trusted-plugin-owned-workspaces.md) [`docs/adr/0049-plugin-provided-opencli-adapters.md`](../adr/0049-plugin-provided-opencli-adapters.md)

但从插件开发者角度，当前产品更像“仓库内 Bundled Plugin 的实现约定”，还不是一条独立、可重复、可发布的第三方开发链。最高优先级摩擦如下：

| 优先级 | 结论 | 直接证据 |
| --- | --- | --- |
| P0 | CLI 本地 `validate`/`pack` 使用了 `hostVersion: "0.1.0"`，而 Runtime 和官方 manifest 使用 `0.2.0`；官方插件在作者本地校验会被错误拒绝。 | `packages/plugin-sdk/bin/infolens-plugin.mjs:28-33, validateAt`；`packages/plugin-runtime/src/contract.mjs:5-7`；`plugins/hn/manifest.json:6-7`。实测命令见下文。 |
| P0 | 没有 `init`/scaffold、外部可安装的 SDK 发布路径或插件 Web 构建脚手架；作者需要手工组装包，并自行解决 Backend、SQLite、Workspace 构建和测试。 | `docs/plugin-development.md:3-28`；`packages/plugin-sdk/package.json:1-16`；`package.json:12-42`；四个插件的 `package.json` 均只有 `type: module`，例如 `plugins/hn/package.json:1-5`。 |
| P1 | `dev` 只生成 Adapter 的链接 Scope，不会启动插件 Runtime、Workspace 预览或热更新；`scripts/dev.mjs` 也只启动 Host Vite 和 Electron。 | `packages/plugin-sdk/bin/infolens-plugin.mjs:49-58, dev`；`packages/plugin-runtime/src/server.mjs:41-52`；`scripts/dev.mjs:start`。 |
| P1 | 安装和升级是两个不连续的概念：同 ID 必须先删除，删除同时清除包、Plugin Store、日志和 Host State；Plugin 自己写的 SQLite migration 因此没有正常的用户升级入口。 | `packages/plugin-runtime/src/server.mjs:653-730, installPlugin/removePlugin`；`docs/adr/0016-explicit-plugin-replacement.md`；`docs/adr/0017-delete-plugin-data-on-removal.md`。 |
| P1 | `validate` 主要验证 manifest、文件存在和 Adapter 注册，不会 import Backend、调用路由或验证 Workspace；很多错误会推迟到启动/激活。 | `packages/plugin-runtime/src/contract.mjs:34-81, validatePluginPackage`；`packages/plugin-sdk/bin/infolens-plugin.mjs:44-52, validate`；`packages/plugin-runtime/src/server.mjs:435-452, activatePlugin`。 |
| P1 | 发布仍是“把一个本地目录交给另一个本地目录”：没有插件 Registry、归档格式、签名、发布元数据或升级交易。 | `packages/plugin-sdk/bin/infolens-plugin.mjs:60-80, pack`；`apps/desktop/main.cjs:319-325`；`packages/plugin-runtime/src/server.mjs:653-687`；`docs/adr/0013-fixed-directory-and-local-plugin-installation.md`。 |

## 当前机制模型

### 包形状

文档给出的 Contract V2 包形状是：

```text
my-plugin/
  manifest.json
  backend/
  web/
  opencli-adapters/
    source/
      opencli-plugin.json
      package.json
      command.js
```

[`docs/plugin-development.md:3-15`](../plugin-development.md) 只要求到了目录形状和 Adapter 文件；架构文档进一步要求 `ui.entry` 指向已构建的 `web/dist/index.html`，Workspace 内资源必须使用相对路径。[`ARCHITECTURE.md:92-107`](../../ARCHITECTURE.md)

### 从源代码到运行时的路径

```text
手工创建包
  -> manifest 校验 + Provided Adapter 注册探测
  -> pack 复制为一个本地目录并写 adapter-integrity.json
  -> Host 选择绝对路径，预检后复制到 managed plugins/
  -> 启动时再次 discovery/compatibility check
  -> Plugin Runtime import backend.entry
  -> activate(context) 注册 route/task/schedule
  -> Workspace iframe 直接访问同一 Runtime origin 下的 Plugin API
```

Host 的 packaged 路径是用户数据目录下的 `plugins/`，开发态默认直接使用仓库 `plugins/`；官方包首次启动时才会被复制到 packaged profile。[`apps/desktop/main.cjs:51-58, managedPaths`](../../apps/desktop/main.cjs) [`apps/desktop/main.cjs:70-80, seedBundledPlugins`](../../apps/desktop/main.cjs)

## 开发者旅程与摩擦点

### 1. 创建：没有从零开始的最短路径

当前 CLI 只有 `validate`、`dev`、`pack`、`adapters list` 四个命令，没有 `init`、模板选择、示例包复制或生成 manifest 的命令。[`packages/plugin-sdk/bin/infolens-plugin.mjs:96-103`](../../packages/plugin-sdk/bin/infolens-plugin.mjs) 文档也只展示了手工目录树和命令。[`docs/plugin-development.md:3-28`](../plugin-development.md)

这对官方插件作者尤其明显：四个插件的 Backend 都要自行处理输入校验、结果归一化、SQLite schema/migration、刷新设置、状态、路由、错误保留和 Workspace；例如 Hacker News 的 `activate` 自己注册 Store、refresh task、多个 API route、schedule 和 cleanup。[`plugins/hn/backend/index.js:36-100, activate`](../../plugins/hn/backend/index.js)

SDK 也没有形成外部开发者可直接依赖的发布渠道：`@infolens/plugin-sdk` 标记为 `private: true`，仓库根包同样是 private；官方插件的 `package.json` 没有 SDK dependency、构建脚本或测试脚本。[`packages/plugin-sdk/package.json:1-16`](../../packages/plugin-sdk/package.json) [`package.json:1-10`](../../package.json) [`plugins/hn/package.json:1-5`](../../plugins/hn/package.json)

**摩擦判断：高。** “Plugin 由插件拥有业务行为”是正确的架构取舍，但当前没有把重复的基础工作变成可复制模板。第三方作者需要先读源码才能知道最小 Backend、路由、关闭和数据目录约定。

**建议：** 增加 `init` 生成最小可运行包、Backend/Workspace/Adapter 三种模板和最小测试；同时决定 SDK 是发布为可安装包，还是明确支持“复制 SDK 源码”的开发模式。这个建议不改变 Plugin 的业务所有权，只减少样板代码。

### 2. 声明：契约边界明确，但缺少可消费的 schema 和能力协商

`validatePluginPackage` 会检查 manifest JSON、ID/版本、Contract Version、Minimum Host Version、Backend/Workspace 文件、Adapter/Command 对象，并限制 command path 不能带 options、`access` 必须为 `read`、输出必须为 JSON、`site` 必须等于 command 首段，Built-in command 必须存在。[`packages/plugin-runtime/src/contract.mjs:34-81, validatePluginPackage`](../../packages/plugin-runtime/src/contract.mjs)

官方 manifest 展示了实际写法：Built-in 命令和 Provided Adapter 命令都要在 `openCliCommands` 再声明一次；Product Hunt 的 `INTERCEPT` 命令通过 `productHunt` key 绑定到包内 Adapter。[`plugins/product-hunt/manifest.json:1-25`](../../plugins/product-hunt/manifest.json) [`plugins/github-trending/manifest.json:9-32`](../../plugins/github-trending/manifest.json)

SDK 有 TypeScript 类型，但没有 JSON Schema 或编辑器可消费的 manifest schema。类型还明确表示 command 的参数只是 `readonly string[]`，没有参数 schema、结果 schema 或 capability/feature negotiation。[`packages/plugin-sdk/src/index.d.ts:1-29`](../../packages/plugin-sdk/src/index.d.ts) [`packages/plugin-sdk/src/index.d.ts:91-117`](../../packages/plugin-sdk/src/index.d.ts)

架构刻意规定 Runtime 不增加第二套参数协议，Backend 自己验证输入后把参数向下传递。[`ARCHITECTURE.md:147-153`](../../ARCHITECTURE.md) 这保留了来源特异性，但开发者需要同时维护 command 参数、OpenCLI Adapter 输出和 Plugin Store schema 的三份隐式约定；Host 也无法帮助生成调用文档或静态检查参数。

Provided Adapter 的契约更深：需要 reverse-domain ID、相同的 `opencli-plugin.json` name/version、兼容 OpenCLI range、可直接运行的 JS；不能有 `node_modules`、运行时依赖、生命周期 Hook。[`packages/plugin-runtime/src/adapter-scope.mjs:6-7, 60-79`](../../packages/plugin-runtime/src/adapter-scope.mjs)

**摩擦判断：中高。** 运行时拒绝原因较具体，但作者必须从实现和错误码反推完整 schema，且 Contract Version 之外没有能力级别声明。例如 `downloadableResponse`、批量刷新和 Workspace shared controls 所需的 Host 能力只能通过 `minHostVersion` 间接表达。

**建议：** 发布 `manifest.schema.json` 和 Adapter schema；保留 command 参数由 Plugin 自己拥有，但至少允许声明参数/结果契约和需要的 Host capability。这样不会把业务 schema 收回 Host，却能让 `validate` 和 IDE 给出可操作反馈。

### 3. 构建：包要求是 built artifact，但仓库没有 Plugin build pipeline

架构要求 `web/dist/index.html` 和 entry-relative assets，但契约只检查 `backend.entry`、`ui.entry` 指向的文件是否存在；它不检查静态资源引用、JavaScript import graph、Backend 的依赖是否可加载或 UI 是否真的能启动。[`ARCHITECTURE.md:94-107`](../../ARCHITECTURE.md) [`packages/plugin-runtime/src/contract.mjs:49-58`](../../packages/plugin-runtime/src/contract.mjs)

根 `build` 只构建 Host 的 `apps/desktop/vite.config.ts`，没有插件构建命令；四个官方插件把 `web/dist` 产物直接放在仓库中，插件 `package.json` 没有 `build`/`test` script。[`package.json:12-42`](../../package.json) [`apps/desktop/vite.config.ts:1-25`](../../apps/desktop/vite.config.ts) [`plugins/hn/package.json:1-5`](../../plugins/hn/package.json)

`pack` 也不构建，只先调用当前 CLI 的 validate，再递归复制整个目录，排除 `node_modules`、`.git`、`.infolens-dev`，最后写入 `adapter-integrity.json`；输出路径还必须事先不存在。[`packages/plugin-sdk/bin/infolens-plugin.mjs:60-80, pack`](../../packages/plugin-sdk/bin/infolens-plugin.mjs)

**摩擦判断：高。** “构建完成的目录”与“可开发的源码项目”没有清晰边界。外部作者需要自行选择 Vite/React/其他前端工具、处理根路径、复制 runtime SDK 依赖并保证最终目录可被 Runtime 挂载。

官方 Workspace 直接从 Runtime 的绝对路径载入 SDK 和 shared history controls，并从 query 参数读 `apiBaseUrl`；这在 Host 中有效，但没有 standalone preview 命令。[`plugins/hn/web/dist/workspace.js:1-11`](../../plugins/hn/web/dist/workspace.js) [`packages/plugin-runtime/src/server.mjs:774-818`](../../packages/plugin-runtime/src/server.mjs)

**建议：** 提供不强制框架的 `build`/`preview` 约定和最小静态 Workspace 模板；`pack` 后追加一次“解包/启动 smoke check”，至少 import Backend、请求 health、检查 Workspace 入口的静态依赖。若不想规定前端框架，也应规定产物检查，而不是只检查一个文件存在。

### 4. 本地验证和开发循环：校验命令与实际 Runtime 已经分叉

CLI 的 `validateAt` 把 host 版本写死为 `0.1.0`，而 Plugin Runtime 使用 `HOST_VERSION = "0.2.0"`。[`packages/plugin-sdk/bin/infolens-plugin.mjs:26-33, validateAt`](../../packages/plugin-sdk/bin/infolens-plugin.mjs) [`packages/plugin-runtime/src/contract.mjs:5-7`](../../packages/plugin-runtime/src/contract.mjs)

四个官方 manifest 都要求 `minHostVersion: "0.2.0"`，例如 Hacker News。[`plugins/hn/manifest.json:4-7`](../../plugins/hn/manifest.json) 在当前工作区运行：

```text
npm run plugin -- validate plugins\hn
=> {"ok":false,"code":"INCOMPATIBLE_HOST","error":"plugin requires host >=0.2.0; current host is 0.1.0"}

npm run plugin -- validate plugins\product-hunt
=> 同样返回 INCOMPATIBLE_HOST
```

这不是作者包本身的问题，而是同一仓库的 CLI 和 Runtime 使用了两个 Host Version 真相源；它会让官方作者无法通过文档推荐的 `validate`，`pack` 也会复用同一失败路径。[`packages/plugin-sdk/bin/infolens-plugin.mjs:60-63, pack`](../../packages/plugin-sdk/bin/infolens-plugin.mjs)

此外，`validate` 的成功含义只覆盖 manifest/文件和 Adapter registration probe。真正的 Backend module import 发生在 Runtime activation，导入失败、缺少依赖、重复路由、task 注册问题要到 `activatePlugin` 才暴露。[`packages/plugin-runtime/src/server.mjs:394-452, activatePlugin`](../../packages/plugin-runtime/src/server.mjs)

`infolens-plugin dev` 的实现只在插件目录下创建 `.infolens-dev/opencli-adapters`，用 junction/hard link 生成开发 Scope 并输出 lock 路径。[`packages/plugin-sdk/bin/infolens-plugin.mjs:49-58, dev`](../../packages/plugin-sdk/bin/infolens-plugin.mjs) 但 Runtime 的默认 `adapterRegistryRoot` 来自 Plugin data 旁的 `opencli-adapters`，其 `adapterScopeOptions` 没有开启 `development`；Host 的 `scripts/dev.mjs` 只启动 Host renderer 和 Electron，也没有把这个 Scope 接入 Runtime。[`packages/plugin-runtime/src/server.mjs:19-52`](../../packages/plugin-runtime/src/server.mjs) [`scripts/dev.mjs:start`](../../scripts/dev.mjs)

**摩擦判断：P0 + 高。** 作者需要自己记住“先构建 dist、再启动整个 Host、再从 UI/Runtime 看结果”，而推荐的本地 validate 当前还会误报。

**建议：** 让 CLI 共享 Runtime 的 `HOST_VERSION`/版本模块；增加 `doctor`（contract + Backend import + Workspace + Adapter + Runtime health）和 `run`/`watch`；明确 `dev` Scope 是否由 Runtime 消费。若保留静态包，至少提供“不启动 Electron 的 Runtime + Workspace preview”命令。

### 5. 安装：预检和失败清理扎实，但用户入口只有本地绝对目录

桌面安装器只打开 `openDirectory` 目录选择器，并把绝对路径 POST 给 Runtime。[`apps/desktop/main.cjs:319-325`](../../apps/desktop/main.cjs) Runtime 先验证 candidate manifest 和重复 ID，再用临时 preflight registry 验证；随后复制到 `.install-<id>-...`，再次正式验证，rename 到 managed `plugins/<id>`，更新 Host State 并立即激活。[`packages/plugin-runtime/src/server.mjs:653-695, installPlugin`](../../packages/plugin-runtime/src/server.mjs)

这条链对 Provided Adapter 做了实际注册探测、hash、Scope Lock 和命令冲突检查；安装不会运行 package scripts、编译或联网拉依赖。[`packages/plugin-runtime/src/adapter-scope.mjs:90-119, publishAdapter`](../../packages/plugin-runtime/src/adapter-scope.mjs) [`docs/adr/0049-plugin-provided-opencli-adapters.md`](../adr/0049-plugin-provided-opencli-adapters.md)

然而安装 UI 不接受归档文件或版本选择，只接受一个本地文件夹；Runtime 也只接受绝对路径。[`packages/plugin-runtime/src/server.mjs:653-657`](../../packages/plugin-runtime/src/server.mjs) 这使“发布”与“安装”依赖作者和用户共享文件系统，而不是一个可传递的插件 artifact。

还有一个状态反馈问题：`activatePlugin` 会捕获 activation exception、记录失败并返回，不向 `installPlugin` 抛出；`installPlugin` 随后仍返回 ID，HTTP 层会返回 201，而插件实际可能已经是 `failed`。[`packages/plugin-runtime/src/server.mjs:435-452`](../../packages/plugin-runtime/src/server.mjs) [`packages/plugin-runtime/src/server.mjs:679-687`](../../packages/plugin-runtime/src/server.mjs) 因此“installed and enabled”不等于“Backend ready”。

**建议：** 保留现有 preflight/二次校验，但返回明确的 `installed`、`activated`、`failed` 状态和 activation log correlation；定义一个可复制的目录归档格式，仍可先不引入远程 Registry。

### 6. 加载与运行：边界很小，但作者要理解共享进程和手工取消

每个启用插件的 Backend 都 export `activate(context)`。Context 提供数据目录、相对路径解析、插件范围 route、task/enqueue/schedule、health、refresh options、logger 和 `opencli.run`；插件不能自己开 HTTP port、直接 spawn OpenCLI 或维护独立 scheduler。[`packages/plugin-sdk/src/index.d.ts:91-123`](../../packages/plugin-sdk/src/index.d.ts) [`packages/plugin-runtime/src/server.mjs:394-432`](../../packages/plugin-runtime/src/server.mjs)

Runtime 把所有 Backend module 放进一个 Node 子进程，单个插件的 activation/route/task/cleanup 普通异常会被隔离，但 Runtime 进程本身退出会短暂影响所有插件；这不是 hostile-code sandbox。[`ARCHITECTURE.md:145-155`](../../ARCHITECTURE.md) [`docs/adr/0047-plugin-scoped-runtime-error-boundaries.md`](../adr/0047-plugin-scoped-runtime-error-boundaries.md)

Workspace 通过 Runtime 同源 URL 加载，Host 传入 `pluginId`、`apiBaseUrl` 和 theme，业务请求由 Workspace 直接访问自己的 API。[`apps/desktop/src/App.tsx:630-635`](../../apps/desktop/src/App.tsx) [`packages/plugin-runtime/src/server.mjs:959-1004`](../../packages/plugin-runtime/src/server.mjs) 这避免了 CORS 和 Host RPC，但也意味着作者必须自己处理 URL、路由、错误和前端状态。

取消是一个容易踩坑的细节：route request 提供 `request.signal`，`opencli.run` 也接受可选 signal，但官方 GitHub README route 调用 `opencli.run` 时没有传 route signal；OpenCLI child process 只有收到这个 signal 才会被 spawn API 取消。[`packages/plugin-sdk/src/index.d.ts:102-116`](../../packages/plugin-sdk/src/index.d.ts) [`packages/plugin-runtime/src/opencli-adapter.mjs:69-95`](../../packages/plugin-runtime/src/opencli-adapter.mjs) [`plugins/github-trending/backend/index.js:99-113`](../../plugins/github-trending/backend/index.js)

**摩擦判断：中。** Context 的设计是窄而稳定的，但没有提供更高层的“可取消 route task”辅助，作者需要手工把 signal 从请求一路传到 OpenCLI，并理解 task queue 的区别。

**建议：** 增加 `context.runOpenCli`/route helper 自动绑定 request signal；在开发文档中明确短 route、长 task、cleanup 和 signal 的推荐模式。保留 `context.opencli.run` 作为底层能力即可。

### 7. 调试：有用户诊断闭环，没有开发者诊断闭环

Runtime 为每个插件写 bounded rotating log，默认每个文件 256 KiB、最多 3 个文件；Plugin Manager 可以复制 status snapshot 和最近日志组成 Plugin Diagnostic Report。[`packages/plugin-runtime/src/logger.mjs:8-18, 26-67`](../../packages/plugin-runtime/src/logger.mjs) [`packages/plugin-runtime/src/server.mjs:732-745, pluginDiagnostics`](../../packages/plugin-runtime/src/server.mjs)

这适合用户报障，但不适合作者定位代码：Runtime 的 `errorDetails` 只保留 code 和经过 redaction/240 字符截断的 message；activation/route 错误默认不会把 stack 写入诊断报告。[`packages/plugin-runtime/src/server.mjs:73-77`](../../packages/plugin-runtime/src/server.mjs) [`packages/plugin-runtime/src/refresh-outcome.mjs:20-24`](../../packages/plugin-runtime/src/refresh-outcome.mjs) [`packages/plugin-runtime/src/logger.mjs:39-50`](../../packages/plugin-runtime/src/logger.mjs)

仓库没有 `plugin test`、`plugin doctor`、Backend attach/debug 配置、实时 plugin log 命令或 Workspace standalone preview。现有测试覆盖 Runtime contract、Adapter Scope 和官方插件，但测试夹具是仓库内部实现，不是第三方作者可以初始化的 harness。[`package.json:24-42`](../../package.json) [`tests/sprint2-contract.test.mjs:78-124`](../../tests/sprint2-contract.test.mjs) [`tests/adapter-scope.test.mjs:13-56`](../../tests/adapter-scope.test.mjs)

**建议：** `doctor` 至少输出 activation stack、route/task registration、health、Workspace 资源错误和 Adapter registration report；增加 `--watch`/`--inspect` 选项或给出 Node inspector 的标准启动方式。用户诊断报告可以继续保持 redacted/短消息，不应与开发者诊断混为一谈。

### 8. 发布：Adapter 发布约束清楚，Plugin 发布协议仍不存在

`pack` 会生成一个自包含的插件目录和 Adapter integrity metadata；Provided Adapter 的内容放入 Infolens 管理的 immutable Store，Scope Lock 记录精确 ID、版本、hash、路径和注册命令，OpenCLI 禁止用户全局 discovery，只加载当前 Scope。[`packages/plugin-runtime/src/adapter-scope.mjs:145-225`](../../packages/plugin-runtime/src/adapter-scope.mjs) [`packages/plugin-runtime/src/opencli-adapter.mjs:98-117`](../../packages/plugin-runtime/src/opencli-adapter.mjs)

这解决了“Adapter 是否污染全局 `node_modules`”和“同 ID/版本内容是否被替换”的问题；Product Hunt 是实际使用 Provided Adapter 的示例。[`plugins/product-hunt/opencli-adapters/producthunt/opencli-plugin.json:1-5`](../../plugins/product-hunt/opencli-adapters/producthunt/opencli-plugin.json) [`plugins/product-hunt/opencli-adapters/producthunt/today.js:32-101`](../../plugins/product-hunt/opencli-adapters/producthunt/today.js)

但 `pack` 的输出是一个目录，不是压缩包或带签名的发行物；Host 的安装入口是选择本地目录，且没有 Registry、发布索引、README/license/release notes 约定或 package signature。[`packages/plugin-sdk/bin/infolens-plugin.mjs:64-80`](../../packages/plugin-sdk/bin/infolens-plugin.mjs) [`apps/desktop/main.cjs:319-325`](../../apps/desktop/main.cjs) [`docs/adr/0007-simplified-trusted-plugin-package.md`](../adr/0007-simplified-trusted-plugin-package.md)

真实来源发布验证还需要开发者机器上的 Browser Bridge 和登录会话；CI 只做 credential-free 测试，不能替代 `COOKIE`/`INTERCEPT` 的真实验证。[`ARCHITECTURE.md:182-188`](../../ARCHITECTURE.md) `scripts/verify-sprint8-real-source.mjs:87-121` 也会启动 packaged app、点击每个 Workspace 的 refresh、检查 SQLite 和重启后的记录；本研究没有运行该脚本。

**摩擦判断：中高。** Adapter 的供应链校验已较完整，但 Plugin 本身没有可供社区作者重复的 release checklist、artifact identity 和发布渠道。

**建议：** 先定义本地发布协议：固定 artifact 目录/归档、manifest 校验、内容 hash、作者 README、支持的 Host/OpenCLI 范围、真实来源验证记录。未来引入 Registry 时再把该协议映射到索引和签名，不要把当前本地安装假设直接扩展成隐式 marketplace。

### 9. 升级与数据迁移：当前是明确的破坏性替换

同一 manifest ID 已存在时，安装直接返回 `DUPLICATE_PLUGIN_ID`，要求先 remove；Runtime remove 会先停 task、调用 cleanup、删除包、删除 `dataRoot/<id>`、删除 Adapter Scope 和 Host State。[`packages/plugin-runtime/src/server.mjs:653-675`](../../packages/plugin-runtime/src/server.mjs) [`packages/plugin-runtime/src/server.mjs:697-729`](../../packages/plugin-runtime/src/server.mjs)

Host 的 fallback removal 也会在 Runtime 无法及时停下时重启 Runtime，再递归删除 package 和 plugin data。[`apps/desktop/main.cjs:189-217`](../../apps/desktop/main.cjs) 这与 ADR-0016/0017 一致：MVP 没有 in-place upgrade、rollback、data migration transaction，并且 replacement 不保留 source data。[`docs/adr/0016-explicit-plugin-replacement.md`](../adr/0016-explicit-plugin-replacement.md) [`docs/adr/0017-delete-plugin-data-on-removal.md`](../adr/0017-delete-plugin-data-on-removal.md)

架构文档同时把 schema/migration 责任交给 Plugin。[`ARCHITECTURE.md:82-84`](../../ARCHITECTURE.md) 但在当前 Plugin Manager 流程中，这种 migration 只能覆盖同一份 data directory 被重新激活的情形，不能覆盖正常的用户版本升级；作者要么要求用户导出/重建，要么承担数据丢失。

**摩擦判断：高，且是架构级决策。** 这不是文档不足，而是“Plugin-owned migration”和“remove deletes data”之间的产品取舍。若目标是方便长期插件开发，必须新建或修订 ADR，明确升级时是否保留 data、如何运行 migration、失败如何 rollback；不能只增加一个 `--replace` 参数。

### 10. 兼容性：检查项严格，但版本真相和能力表达不完整

当前兼容性分成四层：

| 层 | 当前检查/来源 | 开发者影响 |
| --- | --- | --- |
| Infolens package | `contractVersion: "2"`、semver `minHostVersion`、manifest 结构 | Contract 版本和 Host minimum 必须手工填写；CLI/Runtime 版本漂移会误报。 [`packages/plugin-runtime/src/contract.mjs:5-8, 34-58`](../../packages/plugin-runtime/src/contract.mjs) |
| Built-in OpenCLI | `resources/opencli/runtime.json` 固定为 1.8.6，并列出可用 command paths | manifest 能检查“命令是否存在”，不能声明内建命令的版本范围或输出 schema。 [`resources/opencli/runtime.json:1-15`](../../resources/opencli/runtime.json) |
| Provided Adapter | `opencli-plugin.json` 的 semver range、实际 registration probe、hash/store/Scope Lock | 约束强，但作者必须理解 OpenCLI 内部注册报告和暂时的 1.8.6 patch。 [`packages/plugin-runtime/src/adapter-scope.mjs:60-79, 175-210`](../../packages/plugin-runtime/src/adapter-scope.mjs) [`scripts/apply-opencli-overrides.mjs:1-62`](../../scripts/apply-opencli-overrides.mjs) |
| Runtime capability | SDK 的隐式 `PluginActivationContext` 和 `minHostVersion` | 没有 `requires` capability、Node/Electron/OS/runtime engine 字段；新增 SDK 能力只能粗粒度提升 Host minimum。 [`packages/plugin-sdk/src/index.d.ts:91-150`](../../packages/plugin-sdk/src/index.d.ts) |

当前包契约还只接受 `PUBLIC`、`COOKIE`、`INTERCEPT`，`UI` 在 discovery/install 阶段拒绝；这是 ADR-0046 的有意边界，不是作者可以通过 manifest 绕过的选项。[`packages/plugin-runtime/src/contract.mjs:7, 70-75`](../../packages/plugin-runtime/src/contract.mjs) [`docs/adr/0046-reject-ui-strategy-in-current-contract.md`](../adr/0046-reject-ui-strategy-in-current-contract.md)

另一个兼容性信号是版本分散：根 `package.json` 和 Plugin SDK/Runtime package 都是 `0.1.0`，Runtime contract 常量是 `0.2.0`，官方插件 `minHostVersion` 是 `0.2.0`。[`package.json:1-4`](../../package.json) [`packages/plugin-runtime/package.json:1-8`](../../packages/plugin-runtime/package.json) [`packages/plugin-sdk/package.json:1-4`](../../packages/plugin-sdk/package.json) [`packages/plugin-runtime/src/contract.mjs:5-7`](../../packages/plugin-runtime/src/contract.mjs) 这使作者难以判断“插件版本、SDK 版本、Host 版本、Contract 版本”各自的发布关系。

最后，默认信任模型意味着安装校验主要是可靠性/兼容性校验，不是安全沙箱；Backend 是被 Runtime 加载的可信代码，Host 没有权限声明或审批流程。[`docs/adr/0007-simplified-trusted-plugin-package.md`](../adr/0007-simplified-trusted-plugin-package.md) [`docs/adr/0047-plugin-scoped-runtime-error-boundaries.md`](../adr/0047-plugin-scoped-runtime-error-boundaries.md) 作者发布前需要把外部域名、浏览器会话、数据目录和本地代码信任边界写进自己的发布说明，当前 manifest 没有承载这些信息的字段。

## 已有机制中值得保留的部分

1. **预检顺序和失败清理是正确方向。** 安装在正式目录变更前使用临时 Adapter Scope，复制后再次验证；Adapter Scope 失败时清理临时目录和未引用 Store。[`packages/plugin-runtime/src/server.mjs:668-691`](../../packages/plugin-runtime/src/server.mjs) [`packages/plugin-runtime/src/adapter-scope.mjs:228-260`](../../packages/plugin-runtime/src/adapter-scope.mjs)
2. **命令边界可追踪。** Backend 只能按 manifest 的 command key 调用；Provided Adapter 的实际注册命令必须和 manifest、strategy、access 一致。[`packages/plugin-runtime/src/server.mjs:417-430`](../../packages/plugin-runtime/src/server.mjs) [`packages/plugin-runtime/src/adapter-scope.mjs:196-210`](../../packages/plugin-runtime/src/adapter-scope.mjs)
3. **Plugin 业务所有权清晰。** 独立 SQLite、source-specific schema、Workspace 和 refresh policy 不被 Host 抽象成统一 feed；这让插件能表达 HN、GitHub、知乎和 Product Hunt 的数据差异。[`ARCHITECTURE.md:59-84`](../../ARCHITECTURE.md) [`plugins/github-trending/backend/index.js:58-134`](../../plugins/github-trending/backend/index.js)
4. **运行时失败边界可用。** 单个插件的 activation/route/task 错误会变成该插件的 status/log，兄弟插件继续运行；Runtime 重启时 Host 会重新激活。[`packages/plugin-runtime/src/server.mjs:335-452`](../../packages/plugin-runtime/src/server.mjs) [`apps/desktop/main.cjs:82-149`](../../apps/desktop/main.cjs)

## 建议优先级

### P0：先让“官方文档命令”可靠

- 让 CLI 和 Runtime 读取同一个 Host version source；同时把根 package、Runtime package、SDK package、Release manifest 的版本关系写成单一规则。
- 在 `validate`/`pack` 失败信息中打印实际 contract、Host、OpenCLI 版本和对应来源。
- 增加 `doctor`，把 manifest、Adapter probe、Backend import、route/task registration、health 和 Workspace 静态资源检查合并成一个作者可运行的命令。

### P1：把仓库约定变成开发工具

- 提供 `init` 模板和一个不依赖 Electron 的 Runtime/Workspace preview。
- 让 `dev` 的 linked Scope 真正接入 Runtime，或删除这个命令并明确只支持 immutable Store；补上 watch/reload 和日志 tail。
- 输出可复制的本地 artifact（目录或归档均可），包含 manifest、支持矩阵、README、Adapter integrity 和校验结果；安装仍可保持 local-first。
- 将安装响应拆为 copied/validated/activated/failed，并保留 operation/log ID。

### P1：为长期升级建立明确的数据策略

- 如果坚持删除数据，文档应明确 migration 只适用于同目录重新激活，并提供 Plugin-owned export/import 作为替代。
- 如果要支持用户升级，需要新 ADR 修订 ADR-0016/0017：保留旧 data、执行 Plugin migration、失败回滚、再切换 package；不能由 Host 猜测业务 schema。

### P2：提高兼容性和可维护性

- 增加 manifest JSON Schema、Adapter schema、Host capability 列表和最低 Node/Electron/OS 字段。
- 允许 Built-in command 声明 OpenCLI 版本范围或输出契约；继续由 Plugin 负责 source schema 和业务模型。
- 增加开发者级 stack/trace 诊断，与面向用户的 redacted Plugin Diagnostic Report 分开。

## 总判断

当前 Plugin Runtime 和 Provided Adapter 机制已经具备较好的内部工程边界，适合继续开发少量可信 Bundled Plugin；真正的短板不在“还能不能加载一个插件”，而在“外部作者能否不读 Host 源码就创建、运行、验证、发布并安全升级一个插件”。

最有效的改善顺序是：先修正 CLI/Runtime 版本真相，再提供 scaffold + doctor + preview/dev loop，随后定义可复制的 artifact 和升级数据策略。后两项会触及 ADR-0040、ADR-0016、ADR-0017 的既有决定，应在实现前显式修订决策。

## 目标开发者工作流

建议把常规作者路径收敛成一个独立 CLI，而不是要求作者拼接 Host、Runtime、Vite 和 Adapter 的内部命令：

```powershell
npm create @infolens/plugin my-plugin
cd my-plugin
npm install
npm run dev
npm run check
npm test
npm run pack -- --out .\dist\my-plugin.infolens-plugin
```

模板生成的最小包可以包含：

```text
my-plugin/
  package.json
  manifest.json              # 或由 typed manifest source 生成
  backend/index.ts           # activate(context)
  web/index.html
  web/src/main.ts
  web/vite.config.ts
  tests/backend-contract.test.mjs
  opencli-adapters/          # 可选
```

作者只需要理解四件事：manifest 声明身份、Workspace/Backend entry 和 OpenCLI requirement；`activate(context)` 注册 Plugin API/Task/cleanup；Plugin Store 保存 source-specific records；Adapter 产出结构化结果后由 Backend 做验证和持久化。版本来源、路径安全、Adapter Scope、Runtime smoke test、静态 bundle 检查、日志和打包完整性由 SDK/CLI 负责。

实现上建议维持三层：

1. **稳定核心契约**：保留 `Plugin Activation Context` 和声明式 command mapping。它是一个有深度的 seam，Runtime 隐藏任务队列、取消、并发许可、日志和路由生命周期；不要把 source schema 或 Host business API 加进来。
2. **可安装 SDK + 可选 recipes**：SDK 提供 types、manifest schema、Workspace helpers 和可发布的 runtime helpers；可选 recipe package 提供 refresh task、route/body validation、SQLite migration runner 等重复 wiring，但不拥有业务模型。`pack` 必须产出不依赖安装时 `node_modules` 的 self-contained Backend/Adapter。
3. **作者 CLI**：`create` 生成模板，`dev` 启动隔离 Runtime/Workspace watch，`check` 一次给出字段级契约与依赖错误，`test` 提供 credential-free fake Runtime/Adapter replay，`doctor` 输出开发者级关联日志，`pack` 生成可复制 artifact 和 inspection report。

这套分层能降低作者学习成本，同时保留当前最有价值的约束：正式安装仍然是 immutable/self-contained copy，OpenCLI 仍然只能执行 manifest 声明的 command key，真实 `COOKIE`/`INTERCEPT` 验证仍然独立于无凭据 CI。
