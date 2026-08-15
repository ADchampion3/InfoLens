# Infolens

[English](README.md) | [简体中文](README.zh-CN.md)

Infolens 是一个 local-first 的 Electron 信息插件 Host。它提供统一的桌面
Shell，用于跟踪多个信息源，同时让每个 Plugin 自己负责采集策略、本地数据、
刷新策略和阅读工作区。

项目仍在积极开发中。不同版本之间可能会调整 API、包契约和用户界面。

## 从这里开始

- 想在本地运行应用，请看[快速开始](#快速开始)。
- 想参与 Host Shell、Plugin Runtime 或 Bundled Plugin 的开发，请看
  [贡献指南](CONTRIBUTING.zh-CN.md)。
- 想创建 Plugin，请看 [Plugin 开发指南](docs/plugin-development.zh-CN.md)。
- 想了解系统边界，请先看[架构说明](ARCHITECTURE.zh-CN.md)。

当前部署工作和待决策事项记录在[项目路线图](ROADMAP.md)中。

## 项目内容

仓库包含四个 Bundled Plugin：

| Plugin | 采集策略 | Browser Bridge |
| --- | --- | --- |
| Hacker News | `PUBLIC` | 不需要 |
| GitHub Trending | `PUBLIC` | 不需要 |
| Zhihu Hot List | `COOKIE` | 需要已登录的 Chrome Profile |
| Product Hunt | `INTERCEPT` | 实时采集时需要 |

每个 Plugin 都拥有自己的 Backend、SQLite Store、刷新行为和静态 Plugin
Workspace。Host Shell 不会把它们的记录合并成一个共享信息流。

应用内置 OpenCLI 1.8.6 并调用本地运行时，不需要全局安装 OpenCLI。浏览器依赖型
Plugin 使用 OpenCLI Browser Bridge 扩展和用户现有的 Chrome Session。

## 环境要求

- 推荐 Node.js 22 或更高版本。
- npm 10 或更高版本。
- Windows 是当前维护的打包发布目标。其他平台可以运行 Electron 开发环境，
  但当前发布流程不负责跨平台打包。
- `COOKIE` 和 `INTERCEPT` 采集需要 Chrome 以及 OpenCLI Browser Bridge 扩展。

## 快速开始

```powershell
git clone <repository-url>
cd infolens
npm install
npm run dev
```

请在 GitHub 仓库的 Code 菜单中获取真实的 clone 地址，并替换
`<repository-url>`。首次执行 `npm install` 需要网络，因为安装流程会把固定版本的
OpenCLI Distribution 安装到 `resources/opencli`，然后应用仓库中经过版本检查的
Overrides。

`npm run dev` 会同时启动 Vite Renderer、Electron Host 和共享 Plugin Runtime。
开发状态写入被忽略的 `.infolens-data` 目录。

要构建并启动本地生产 Renderer：

```powershell
npm run build
npm start
```

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `apps/desktop/` | Electron Main Process 和 Host Shell |
| `packages/plugin-runtime/` | 共享 Plugin Runtime 和 Plugin API 边界 |
| `packages/plugin-sdk/` | Plugin SDK 和 Plugin 作者 CLI |
| `packages/plugin-workspace/` | 仅负责展示的共享 Plugin Workspace UI |
| `plugins/` | Bundled Plugin 包和它们的 Workspace Bundle |
| `resources/opencli/` | 固定版本的 Bundled OpenCLI Runtime Distribution |
| `scripts/` | 开发、发布和验证脚本 |
| `tests/` | Node Test Runner 测试和 Fixtures |

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Electron 开发会话 |
| `npm run build` | 验证发布元数据并构建 Renderer |
| `npm run typecheck` | 检查 Desktop Host 和 Plugin SDK 的类型 |
| `npm test` | 构建本地包并运行仓库测试套件 |
| `npm run verify:release` | 检查包版本和 Bundled OpenCLI 版本一致性 |
| `npm run package:release` | 在本地构建并组装 Release Package |
| `npm run verify:real-source` | 对配置的实时信息源运行 Real Strategy Verification |
| `npm run plugin -- init <path> --check --format text` | 创建并检查 Plugin 包骨架 |
| `npm run plugin -- help` | 查看 Plugin 作者命令和选项 |
| `npm run plugin -- validate <path>` | 验证 Plugin 包契约 |
| `npm run plugin -- doctor <path>` | 运行隔离的 Plugin 生命周期和 Workspace 检查 |
| `npm run plugin -- adapters list <path>` | 查看 Bundled 和 Provided OpenCLI Adapter |
| `npm run plugin -- pack <path> --out <directory>` | 创建经过验证的 Plugin 包 |

运行指定测试文件时，可以直接使用 Node Test Runner：

```powershell
node --test tests/browser-bridge.test.mjs tests/opencli-adapter.test.mjs
```

自动化检查不能替代浏览器依赖型 Plugin 的实时信息源验证。对于 `COOKIE` 和
`INTERCEPT` 信息源，仍需要在配置好 Browser Bridge 和对应站点 Session 的开发机上
执行 Release Candidate 检查。

`npm run verify:real-source` 是有意设计为开发机检查的命令，需要选定 Plugin 所需
的外部信息源 Session 和 Browser Bridge；它不是确定性测试套件的替代品。

## Browser Bridge

Host Shell 启动时不会主动探测 Browser Bridge。需要恢复浏览器依赖型流程时，打开
Settings 读取缓存状态，然后使用 `Check connection` 或 `Reconnect`。

浏览器依赖型采集只影响需要它的 Plugin。Bridge 不可用或站点未登录不会导致公共信息源
Plugin 不可用；刷新失败后，已经保留的 Plugin 内容仍可阅读。

自动化使用后台窗口和临时 Site Session。Runtime 会在命令成功或失败后释放自己的临时
Session Lease；应用退出时不会关闭用户自己拥有的 Chrome Tab。

## 架构

```text
Electron Main Process
  Host Shell (React, Vite, TypeScript)
    Plugin navigation and host settings
    Plugin workspace frames
          |
          v
  Shared Plugin Runtime (Node)
    Plugin backends and task scheduling
    Plugin-scoped HTTP APIs and static workspaces
    Plugin-owned SQLite stores
    Bundled OpenCLI process boundary
          |
          v
  OpenCLI 1.8.6
    Public adapters and browser-backed adapters
    Browser Bridge daemon and Chrome session
```

主要架构参考：

- [架构基线](ARCHITECTURE.zh-CN.md)（[English](ARCHITECTURE.md)）
- [Plugin 开发指南](docs/plugin-development.zh-CN.md)
- [Architecture Decisions](docs/adr/)
- [Browser Bridge Session 契约](docs/adr/0058-browser-bridge-session-ux.md)

## 应提交的文件

`plugins/*/web/dist/` 下的 Plugin Workspace Bundle 是随应用发布的资源，仓库会
有意跟踪它们。Bundled Plugin Workspace 发生变化时，请重新生成这些文件。

不要提交 `node_modules`、`.infolens-data`、`.infolens-dev`、`.infolens-live`、
`.infolens-acceptance`、`release`、Chrome Profile、Cookie 或导出的日志。

## Plugin 开发

Plugin 是受信任的本地包。Plugin Backend 是由共享 Plugin Runtime 加载的普通
Node.js 代码；当前包模型不是安全 Sandbox，也不是权限系统。

包契约要求 Manifest、Backend Entry 和构建后的静态 Workspace。每一个 OpenCLI
Command 都必须在 Manifest 中声明。Provided Adapter 会在打包时复制并验证；Adapter
流程不包含 Package Script、网络安装或任意依赖安装。

请先阅读 [Plugin 开发指南](docs/plugin-development.zh-CN.md)，然后从仓库根目录运行：

```powershell
npm run plugin -- init path\to\my-plugin --check --format text
npm run plugin -- doctor path\to\my-plugin --format text
npm run plugin -- preview path\to\my-plugin --format text
npm run plugin -- pack path\to\my-plugin --out ..\my-plugin.infolens-plugin
```

生成的骨架与框架无关，不会添加 SDK 依赖。它生成的 `validate`、`doctor`、`dev`、
`preview` 和 `pack` Script 会调用 `infolens-plugin`；当作者环境能够找到该 CLI
时即可使用。外部 Package Distribution 流程另行处理。

## 数据与隐私

Infolens 是 local-first 应用。Host State、Plugin 记录和日志都存储在本地机器上。
每个 Plugin 拥有自己的数据目录和持久化 Schema。应用不提供 Cloud Synchronization
或托管 Crawler Service。

浏览器登录状态保留在 Chrome 中，并通过 Browser Bridge 访问。不要把 Chrome Profile、
Cookie、导出日志、生成的 Release Directory 或 `.infolens-data` 提交到仓库。

## 贡献代码

请阅读[贡献指南](CONTRIBUTING.zh-CN.md)，其中包含首次运行、代码边界、验证命令、
Plugin 作者路径和 Pull Request 清单。Source-specific 行为应放在所属 Plugin 中，
保留 Plugin Runtime 的进程边界；架构决策发生变化时，请更新对应的 ADR。

`AGENTS.md` 记录仓库本地的 Agent 工作约定。

## License

仓库目前还没有 License 文件。在允许外部再分发或接受第三方贡献之前，必须先选择并
添加 License。
