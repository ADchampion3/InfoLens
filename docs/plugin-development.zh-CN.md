# Plugin 开发

[English](plugin-development.md) | [简体中文](plugin-development.zh-CN.md)

Plugin Contract Version 2 支持在 Infolens Plugin Package 中使用标准 OpenCLI
Plugin：

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

OpenCLI Adapter 的 JavaScript 只能导入 Node 内置模块、相对路径文件和 OpenCLI
公开导出，例如 `@jackwener/opencli/registry`。其他生产依赖必须在验证前打包。
不要包含 `node_modules`、仅支持 TypeScript 的 Command、Lifecycle Hook 或 Install
Script。

```powershell
infolens-plugin help
infolens-plugin init . --check --format text
infolens-plugin validate .
infolens-plugin doctor . --timeout 10000
infolens-plugin dev .
infolens-plugin preview . --format text
infolens-plugin adapters list .
infolens-plugin pack . --out ..\my-plugin.infolens-plugin
```

在 Infolens 源码仓库中，SDK Package 尚未作为依赖安装前，使用
`npm run plugin -- <command> ...`。独立项目使用已安装的
`@infolens/plugin-sdk`、`@infolens/release-metadata` 和
`@infolens/bundled-opencli` Package Boundary，不需要 Infolens 仓库目录。

`validate` 是快速的 Package Contract Gate。它检查 Manifest、必要文件、Command
Mapping 和 Provided OpenCLI Adapter Scope，但不会导入或激活 Plugin Backend Module。
`doctor` 包含这些检查，然后在临时 Plugin Runtime 中导入并激活真实 Backend，记录
Route、Task 和 Schedule，检查 Plugin Health，运行清理流程，并遍历静态 Workspace
Bundle Graph。`pack` 会把最终包内容过滤到唯一的 Staging Directory，在写出
`adapter-integrity.json` 并通过 Atomic Rename 发布前运行完整的 `doctor` Gate。
已有的输出路径会被拒绝。

这些命令是分层的：`validate` 是 Contract 子集，`doctor` 是生命周期和 Workspace
检查的超集，`preview` 是前台 Author Loop，`pack` 是经过 Staging 的 `doctor` 加上
完整性检查和发布。JSON 结果中的 Warning 和 Information Finding 不会导致命令失败；
Error Finding 会产生非零退出状态。自动化应依赖稳定字段 `ok`、`command`、
`environment`、`checks` 和 `error.code`/`error.phase`/`error.checkId`。人类可读消息
和解析后的文件系统路径属于诊断详情。

所有 Author Command 都会报告解析后的 Plugin Contract Version、Target Host Version
和 Bundled OpenCLI Version，以及逻辑来源和（可用时的）来源路径。
`--target-host-version <semver>` 只改变 Minimum Host Version 比较，并将来源标为
`cli-option`；它不能改变受支持的 Contract Version 或命令能力。`--timeout <ms>`
应用于每个 `doctor` 生命周期阶段，默认 10 秒；`pack` 会把同一个值传给 Staged
`doctor`。

`doctor` 使用临时的 Plugin、Data、Host State、Managed Adapter Store 和 Adapter
Scope 根目录，并且只加载目标 Package。这是状态和生命周期隔离，不是 Node 或操作系统
安全 Sandbox：受信任的 Backend 代码仍是普通 Node.js 代码，可以使用文件系统、网络、
环境变量或子进程 API。`doctor` 不会启动 Electron、打开浏览器、执行 Workspace
JavaScript、在激活时调用 OpenCLI、启动 Schedule 或运行 Task。

`dev` 使用相同的环境解析方式，并在 `.infolens-dev/opencli-adapters` 创建链接的
Development Scope（Windows 上使用 Junction 和 Hard Link）。`adapters list` 会报告
其他命令使用的相同 Bundled OpenCLI Inventory 和 Provided Adapter Scope。
`INFOLENS_BUNDLED_OPENCLI_ROOT` 环境变量可用于受控 Fixture，结果会报告该 Override
路径。

## 创建 Plugin 骨架

使用 `init` 创建最小的、与框架无关的 Package。在 Infolens 源码仓库根目录运行：

```powershell
npm run plugin -- init path\to\my-plugin --check --format text
```

目标目录必须不存在或为空。命令会从目录名推断小写连字符格式的 Plugin ID，也可以使用
`--id <id>` 和 `--name <name>` 覆盖。它会创建 `manifest.json`、`package.json`、
ESM Backend，以及位于 `web/dist/` 下包含 `index.html`、`workspace.js` 和
`styles.css` 的静态 Workspace Bundle。生成的 Package 包含空的 OpenCLI 声明，并
包含调用 `infolens-plugin` Binary 的 `validate`、`doctor`、`dev`、`preview` 和
`pack` Script。作者环境必须能够找到这个 Binary；`init` 不会添加 SDK 依赖，也不
代表已有独立的外部 Package Distribution 流程。

`--check` 会在写文件后运行完整的 `doctor` 命令。检查失败时命令返回非零退出状态，
但会保留生成的 Package 供检查。`--format text` 会输出 Plugin Identity、解析后的
Environment、检查数量、失败的 Check ID/Code/Phase、Warning 和下一步操作；自动化
默认使用 JSON。

生成的 Workspace 通过 Runtime Mount 调用 Plugin API。它的动态 API URL 会被静态
Workspace Diagnosis 报告为 `WORKSPACE_DYNAMIC_REFERENCE` Warning。这是预期行为，
因为 URL 由 Host 在运行时注入，不会使 Package 失败。

## Package Contract

Infolens Plugin 是受信任的本地 Package。Host 会将它复制到受管理的 `plugins/` 目录，
并在 Plugin Runtime 中加载 Backend。Plugin 负责自己的 Backend 行为、持久化数据、
OpenCLI Mapping 和静态 Workspace；Host 负责发现、生命周期、Task 调度、诊断和
Runtime Boundary。

最小可用 Package 的结构如下：

```text
my-plugin/
  package.json
  manifest.json
  backend/
    index.js
  web/
    dist/
      index.html
      workspace.js
      styles.css
  opencli-adapters/             # optional
    my-adapter/
      opencli-plugin.json
      package.json
      command.js
```

`manifest.json` 必须指向实际会发布的文件。Host 不会在安装时编译 TypeScript、启动
Frontend Dev Server、安装依赖或运行 Package Lifecycle Script。`pack` 会移除
`node_modules`，因此 Backend 依赖必须由 Host SDK 提供，或已经打包进 Backend 输出。

独立项目需要 `@infolens/plugin-sdk`、`@infolens/plugin-runtime`、
`@infolens/release-metadata` 和 `@infolens/bundled-opencli` 这些 Package Boundary。
它不需要 Infolens 仓库目录。在本仓库内，使用 `npm run plugin -- ...`。

### Manifest

每个 Package 都必须在根目录包含 `manifest.json`：

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "icon": "web/dist/icon.png",
  "contractVersion": "2",
  "minHostVersion": "0.2.0",
  "backend": { "entry": "backend/index.js" },
  "ui": { "entry": "web/dist/index.html" },
  "openCliAdapters": {},
  "openCliCommands": {
    "topStories": {
      "site": "hackernews",
      "adapter": "builtin",
      "command": ["hackernews", "top"],
      "strategy": "PUBLIC",
      "access": "read",
      "outputFormat": "json"
    }
  }
}
```

Validator 要求：

- `id` 只能包含小写字母、数字和连字符，并且必须以字母或数字开头。
- `version` 和 `minHostVersion` 必须是 Semantic Version。
- `contractVersion` 必须等于当前解析出的 Supported Contract Version，目前是字符串
  `"2"`。
- `backend.entry` 和 `ui.entry` 必须是 Package 内已存在文件的相对路径。
- `openCliAdapters` 和 `openCliCommands` 必须是对象；即使没有 Adapter 或 Command，
  也要使用空对象。

每个 `openCliCommands` Mapping 都是有意保持窄范围的。它的 `command` 是非空的
Command Path Segment 数组，不能包含选项；`site` 必须等于第一个 Command Segment。
`access` 必须是 `"read"`，`outputFormat` 必须是 `"json"`，`strategy` 必须是
`PUBLIC`、`COOKIE` 或 `INTERCEPT`。当前 Contract 不支持 `UI`。

对于 Bundled OpenCLI Inventory 中的 Command，使用 `adapter: "builtin"`。对于由
Plugin 提供的 Command，使用 `openCliAdapters` 中的 Key。Backend 通过 Manifest Key
调用 Mapping，例如 `context.opencli.run("topStories")`。

最小 Plugin `package.json` 使用常规 Node Metadata：

```json
{
  "name": "@example/infolens-plugin-my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@infolens/plugin-sdk": "0.1.0"
  }
}
```

SDK 导出 `defineManifest` 和用于类型化源代码的 TypeScript Declaration，但最终
Package 的根目录仍然必须包含 JSON Manifest。

## Backend API

Backend Entry 必须导出 `activate(context)`：

```js
export async function activate(context) {
  // Register routes and tasks, load plugin-owned state, and set initial health.
  context.setHealth({ state: "ready" });
}
```

Activation Context 包含：

| API | Contract |
| --- | --- |
| `pluginId` | Manifest 中的 Plugin ID。 |
| `dataDir` | Plugin 私有的持久化数据目录。 |
| `resolveDataPath(relativePath)` | 解析 `dataDir` 下非空的相对路径；绝对路径和越出目录的路径会被拒绝。 |
| `route(method, path, handler)` | 注册唯一 API Route；`path` 必须以 `/` 开头。 |
| `task(name, handler)` | 注册 Task。名称只能使用字母、数字、`.`、`_` 和 `-`，且必须唯一。 |
| `enqueue(name, input, options)` | 将已注册 Task 入队并返回结果；支持 `reason` 和 `coalesceKey`。 |
| `schedule(name, options)` | 周期性运行已注册 Task，并返回取消函数。 |
| `setHealth(health)` | 向 Host 发布 Health State、Badge、Message 或刷新时间。 |
| `setRefreshOptions(provider)` | 向 Host Workspace 发布经过验证的刷新控件。 |
| `logger` | 异步的 `debug`、`info`、`warn` 和 `error` 方法。 |
| `opencli.run(key, args, signal)` | 运行 Manifest 声明的 OpenCLI Command，并返回 JSON。 |

Route Handler 接收 `{ method, url, headers, signal }`。当前 Plugin API 不提供解析后
的 Request Body。Route 输入请使用 Query Parameter 或 Header；如果 Package 需要
Request Body，请在 Backend 中自行加入 Parser。普通返回值会序列化为 JSON。未处理的
Route Error 会被记录，使 Plugin 进入 Failed State，并返回 HTTP 500。

长时间运行的工作以及 OpenCLI 调用都要传递 Request 或 Task Signal：

```js
export async function activate(context) {
  context.task("refresh", async (input, task) => {
    context.setHealth({ state: "refreshing" });
    try {
      const rows = await context.opencli.run(
        "topStories",
        ["--limit=30"],
        task.signal,
      );

      await saveRows(context.resolveDataPath("state.json"), rows);
      const completedAt = new Date().toISOString();
      context.setHealth({ state: "ready", lastSuccessfulRefresh: completedAt });
      return { ok: true, lastSuccessfulRefresh: completedAt };
    } catch (error) {
      context.setHealth({ state: "failed", message: String(error) });
      return { ok: false, code: "SOURCE_REFRESH_FAILED" };
    }
  });

  context.route("GET", "/summary", async () => {
    return readSummary(context.resolveDataPath("state.json"));
  });

  context.route("POST", "/refresh", () => {
    return context.enqueue("refresh", undefined, {
      reason: "manual",
      coalesceKey: "collection",
    });
  });
}
```

`saveRows` 和 `readSummary` 是 Plugin 自己的函数，不是 Host API。保存前要验证外部
结果，并将信息源 Schema 和 Migration 放在 Plugin 自己的数据目录中。

### Task、Schedule 和清理

每个 Plugin 同时只有一个正在执行的 Task。使用相同 Task Name 和 `coalesceKey` 的
重复入队请求会共享同一个 Pending Operation。Task 接收 `{ signal, reason }`，在
Signal 被 Abort 时应尽快停止。

Schedule 引用已经注册的 Task，并要求 `intervalMs` 至少为 100 毫秒。保留取消函数，
在 Settings 变化时以及 `deactivate` 中调用：

```js
let cancelSchedule;

function configureSchedule(context, intervalMs) {
  cancelSchedule?.();
  cancelSchedule = context.schedule("refresh", {
    intervalMs,
    reason: "schedule",
    coalesceKey: "collection",
  });
}

return {
  async deactivate() {
    cancelSchedule?.();
    await closePluginStore();
  },
};
```

诊断命令 `doctor` 会记录 Schedule，但不会启动 Timer、执行 Task 或调用 OpenCLI。
这样可以在不访问信息源、不修改 Plugin 数据的情况下完成生命周期检查。

启动、刷新和失败状态变化时都应使用 `setHealth`。SDK Health State 包括 `ready`、
`starting`、`refreshing`、`failed`、`unavailable` 和 `disabled`。对于名为 `refresh`
的 Task，成功时返回 `{ ok: true }`，预期的信息源失败返回
`{ ok: false, code, message }`。没有 `ok` 的普通结果会被视为刷新完成。信息源刷新
失败时要保留仍可使用的旧数据。

`setRefreshOptions` 可以向 Host 暴露控件：

```js
context.setRefreshOptions(() => ({
  title: "Collection settings",
  fields: [
    {
      key: "limit",
      label: "Result limit",
      type: "number",
      min: 1,
      max: 50,
      default: 30,
    },
    {
      key: "includeRead",
      label: "Include read items",
      type: "boolean",
      default: false,
    },
  ],
}));
```

当前 Sanitizer 最多接受 8 个 Field。Field Key 以小写字母开头，可以包含字母、数字、
`_` 或 `-`。支持的 Type 是 `select`、`text`、`number` 和 `boolean`。

## 静态 Workspace

`ui.entry` 必须指向构建后的静态 HTML 文件。Host 会提供该文件及其本地资源：

```text
/plugins/<plugin-id>/workspace/
/plugins/<plugin-id>/api/
/plugins/<plugin-id>/health
```

Workspace 会收到 `pluginId`、`apiBaseUrl` 和 `theme` Query Parameter。请从 Runtime
Mount 导入浏览器 SDK：

```js
import {
  observeWorkspaceTheme,
  workspaceRuntimeConfig,
  workspaceTheme,
} from "/runtime/plugin-sdk.js";

const { apiBaseUrl } = workspaceRuntimeConfig();
const request = (route, options) =>
  fetch(new URL(route.replace(/^\/+/, ""), apiBaseUrl), options).then((response) => {
    if (!response.ok) throw new Error("Plugin API returned " + response.status);
    return response.json();
  });

document.documentElement.dataset.theme = workspaceTheme();
observeWorkspaceTheme((theme) => {
  document.documentElement.dataset.theme = theme;
});

const summary = await request("summary");
document.querySelector("#app").textContent = JSON.stringify(summary);
```

SDK 还提供 `pluginApiUrl`、`pluginHealthUrl` 和 `pluginWorkspaceUrl`。
`downloadExport(route)` 会从当前 Plugin API 开始下载；`copyDownloadable(route)`
会在用户明确操作后，从同一个 Response 复制文本导出。允许的导出格式是 `json`、
`csv`、`markdown` 和 `text`。

每个 Workspace 引用都应是相对且本地的。Static Diagnosis 会遍历 HTML、JavaScript
和 CSS 引用，处理循环，并且：

- 对缺少的本地文件、绝对本地路径和越出 Workspace 目录的引用报错；
- 将外部 URL 和动态/计算引用作为 Warning 报告，但不会获取或执行它们；
- 将 `/runtime/` Mount 报告为 Host Runtime Resource；
- 忽略 Source Map 引用。

`doctor` 不会执行 Workspace。静态检查通过只证明 Staged Asset Graph 存在，不证明
浏览器代码能够正确渲染。

## OpenCLI 集成

### Built-in Command

Manifest 必须声明 Backend 可能使用的每个 Command。当前 Bundled Inventory 包含
`hackernews top`、`github-trending repos`、`zhihu whoami` 和 `zhihu hot`；确切
Inventory 随 Release 变化。选择 Built-in Command 前运行 `adapters list`。

```js
const result = await context.opencli.run(
  "topStories",
  ["--limit=30"],
  task.signal,
);
```

Runtime 会追加 `-f json` 并禁用用户全局 OpenCLI Discovery。不要传递 `--format`、
`-f` 或其他 Format Option。Command Key 必须存在于 `openCliCommands` 中。

`PUBLIC` Command 使用公共 Request Pool。`COOKIE` 和 `INTERCEPT` Command 使用浏览器
依赖型路径，实时运行时可能需要已登录的 Browser Bridge。当前 Contract 不接受
`UI` Strategy。

### Plugin 提供的 OpenCLI Adapter

Provided Adapter 是随 Plugin Package 一起发布、可以直接运行的 JavaScript。请在
Manifest 中声明：

```json
{
  "openCliAdapters": {
    "myAdapter": {
      "id": "io.example.my-source",
      "version": "1.0.0",
      "path": "opencli-adapters/my-adapter"
    }
  }
}
```

Adapter Directory 必须包含 `opencli-plugin.json`，其中的 Identity 和 Version 必须
与声明完全匹配：

```json
{
  "name": "io.example.my-source",
  "version": "1.0.0",
  "description": "My source OpenCLI adapter",
  "opencli": ">=1.8.6 <2.0.0"
}
```

Adapter ID 必须使用 Reverse-Domain 格式，OpenCLI Version Range 必须包含 Bundled
OpenCLI Version。`package.json` 可以把 API 声明为 Peer Dependency：

```json
{
  "name": "@example/opencli-my-source",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "peerDependencies": {
    "@jackwener/opencli": ">=1.8.6 <2.0.0"
  }
}
```

Adapter Validation 要求存在可以直接运行的 `.js` 或 `.mjs` 文件，拒绝
`node_modules`，也拒绝声明的 `dependencies` 或 `optionalDependencies`。所有非
OpenCLI 生产依赖都要打包进 JavaScript 输出。使用
`@jackwener/opencli/registry` 等 OpenCLI Public Export；不要注册 `onStartup`、
`onBeforeExecute` 或 `onAfterExecute` Hook。

验证流程会探测实际 OpenCLI Registration，并拒绝 Command Collision、未声明的
Command、Strategy/Access 不匹配以及与 Bundled Inventory 的 Collision。`pack` 会写入
包含 Plugin Identity 和 Adapter Hash 的 `adapter-integrity.json`。不要手动编辑该文件；
安装时会再次检查。

## 作者工作流

Operational Author Command 默认输出 JSON，`ok` 为 false 时设置非零退出状态。
`help` 输出人类可读的使用说明。给 Operational Command 加上 `--format text` 可以
获得紧凑的作者摘要；JSON 仍然是 Automation Contract。自动化应依赖 `ok`、`command`、
`environment`、`checks` 和 `error.code`/`error.phase`/`error.checkId`。人类消息和
解析后的路径属于诊断详情。

在本仓库中：

```powershell
npm run plugin -- help
npm run plugin -- init . --check --format text
npm run plugin -- validate .
npm run plugin -- doctor . --timeout 10000
npm run plugin -- adapters list .
npm run plugin -- dev .
npm run plugin -- pack . --out ..\my-plugin.infolens-plugin
```

在已安装 SDK 的项目中，使用等价的 `infolens-plugin` Binary：

```powershell
infolens-plugin help
infolens-plugin init . --check --format text
infolens-plugin validate .
infolens-plugin doctor . --timeout 10000
infolens-plugin adapters list .
infolens-plugin dev .
infolens-plugin pack . --out ..\my-plugin.infolens-plugin
```

作者 CLI 可用后，生成的 Package 提供简短的本地工作流：

```powershell
infolens-plugin init .\my-plugin
cd .\my-plugin
npm run doctor
npm run pack
```

### init

`init <path>` 创建新 Package，不会覆盖已有文件。默认 ID 来自目标目录，默认显示名称
来自该 ID，生成的 Version 是 `0.1.0`。命令使用 Release Metadata 中解析出的
Contract Version 和 Minimum Host Version。`--target-host-version` 只改变验证比较，
不会改变生成的 `minHostVersion`。

当前 Release 中，`init` 是仓库根目录 Author Workflow。它不会安装依赖、发布 SDK
Package、启动 Plugin Runtime、提供 Workspace 或创建 Development Link。

### validate

`validate` 检查 Manifest、Entry File、Host 和 Contract Compatibility、Built-in
Command Availability 以及 Provided Adapter Scope。它不会导入或激活 Backend、执行
Route、运行 Task 或检查 Workspace Graph。

### doctor

`doctor` 先运行 `validate`，然后使用临时的 Plugin、Data、Host State、Adapter Store
和 Adapter Scope 根目录启动子 Plugin Runtime。它会导入并激活真实 Backend，记录
Route/Task/Schedule Registration，检查 Plugin Health，运行 `deactivate`，并诊断静态
Workspace Graph。

Diagnostic Mode 不会启动 Electron、打开浏览器、执行 Workspace JavaScript、启动
Schedule、运行 Task 或在激活时调用 OpenCLI。它是生命周期和状态隔离，不是 Node 或
操作系统安全 Sandbox；Backend Code 仍是受信任的普通 Node.js 代码。

`--timeout <milliseconds>` 应用于每个 `doctor` 生命周期阶段，默认 10 秒。`pack`
会将相同值传给 Staged `doctor`。

### adapters list

`adapters list` 执行与 `validate` 相同的 Contract 和 Adapter Probe，并列出 Bundled
OpenCLI Inventory 以及 Plugin 的 Provided Adapter。当 Command 不可用或 Adapter
Range 不匹配时使用它。

### dev

`dev` 验证 Package，并在 `.infolens-dev/opencli-adapters` 创建链接的 Development
Scope。Windows 上使用 Junction 和 Hard Link。它不会启动 Plugin Runtime、提供
Workspace、监视文件或提供 Hot Reload。打包前删除生成目录；`pack` 会自动过滤它。

### preview

`preview` 验证 Package，把过滤后的 Snapshot 复制到临时根目录，然后以前台方式启动
一个隔离的 Plugin Runtime。它报告与 Host 使用的相同 Plugin Workspace、Plugin API
和 Plugin Health URL 形状。默认命令会监视源 Package，发生变化后 Debounce，再从
全新 Snapshot 重启 Runtime，同时保留 Preview Session 的临时数据和 Loopback Port。

```powershell
infolens-plugin preview . --format text
```

按 `Ctrl+C` 或向 stdin 写入 `shutdown` 停止 Preview。Preview 提供已经构建的静态
Workspace Bundle；它不会编译 Frontend Source、执行 Workspace JavaScript、渲染浏览器
或验证真实 Browser Bridge Session。它不会创建 Development Link，也不会修改受管理的
Plugin Directory；`pack` 永远不会调用它。

### pack

`pack` 会在目标输出旁创建唯一的 Staging Directory，复制 Package 时排除
`node_modules`、`.git`、`.infolens-dev` 和旧的 `adapter-integrity.json`，然后针对完全
相同的 Staged Content 运行完整的 `doctor` Check。只有所有 Error-Level Check 通过后，
才会写入新的 Adapter Integrity Metadata，并 Atomic Rename 到输出路径。

输出必须在 Source Package 外部，且不能已经存在。它是带 `.infolens-plugin` 后缀的
Directory，不是 Zip File。Warning 仍会显示，但不会阻止发布；Staging 失败后会被
清理，不会发布不完整 Artifact。

## 安装、替换与发布清单

当前 Host 支持本地 Package Directory 和本地 ZIP Archive。在桌面应用中，选择
`pack` 生成的 Directory，或使用 `Import ZIP` 导入确定性 Archive。Host 会验证选中的
Package，将它复制或安全解压到受管理的 Plugin Directory，创建 Adapter Scope 并启用
Plugin。Archive Import 会复用 Market Archive Safety Boundary，但仍记录为 `local`
Provenance，不代表 Registry Approval。复制后，安装结果不会继续跟随原始 Source
Directory。

Package 是受信任代码，不是安全 Sandbox。安装相同 Plugin ID 的另一个 Package 前，
必须先移除已有 Plugin。移除会停止 Task、调用 `deactivate`、删除受管理的 Package
和 Plugin-owned Data、清理 Adapter Scope，并删除 Host State Entry。不要假设替换后
Plugin Data 仍然存在；如果不兼容版本之间需要保留数据，请提供 Plugin-owned
Export/Import。

把 Package 交给其他用户前：

1. 将 Backend 和静态 Workspace 构建到 Manifest 引用的路径。
2. 确保 Workspace 没有缺失或越界的本地引用。
3. 确保每个 OpenCLI Command 都已声明，并且每个 Provided Adapter 的 Identity、
   Version、Range 和实际 Registration 都匹配。
4. 运行 `validate`、`doctor` 和 `adapters list`，检查所有 Error 和 Warning Check。
5. 将 `pack` 输出到新的路径，并检查 `adapter-integrity.json`。
6. 将打包后的 Directory 安装到干净的本地 Host Profile，验证刷新、失败保留、Settings
   和清理流程。
7. 对 `COOKIE` 或 `INTERCEPT`，单独验证真实 Browser Bridge 和登录状态。无凭据的
   `doctor` 不能代替这项实时信息源测试。

本仓库的 Source-Level Check：

```powershell
npm run typecheck:sdk
npm run verify:release
npm run package:release
```

这些命令验证 SDK 类型、Release Metadata 和 Package Boundary，但不会渲染或交互操作
Workspace。若本指南与安装后的 Host 行为不一致，请对照
`packages/plugin-sdk/src/index.d.ts`、`packages/plugin-runtime/src/contract.mjs`
和 `packages/plugin-sdk/bin/infolens-plugin.mjs`。
