# 为 Infolens 贡献代码

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

Infolens 仍在积极开发中。Plugin Contract、API 和用户界面可能在不同版本之间变化。
请让改动集中在真正拥有该行为的边界上，并记录有意进行的契约变化。

## 首次运行

使用 Node.js 22 或更高版本，以及 npm 10 或更高版本。Windows 是当前维护的发布目标；
其他平台可以运行 Electron 开发环境，但当前流程不负责跨平台打包。

```powershell
git clone <repository-url>
cd infolens
npm install
npm run verify:release
npm run typecheck
npm run dev
```

请使用 GitHub 仓库 Code 菜单中的 clone 地址。首次安装需要网络，因为 `postinstall`
会把固定版本的 Bundled OpenCLI Distribution 安装到 `resources/opencli`，并应用仓库
Overrides。

## 找到正确的代码边界

| 改动内容 | 从这里开始 |
| --- | --- |
| Electron 生命周期、导航、Settings 或 Host IPC | `apps/desktop/` |
| Plugin 发现、生命周期、调度、诊断或 Plugin API | `packages/plugin-runtime/` |
| Plugin 作者 CLI 或类型化 Plugin SDK Contract | `packages/plugin-sdk/` |
| 信息源采集、存储或 Plugin Workspace | `plugins/<plugin-id>/` |
| 仅负责展示的共享 Workspace 控件 | `packages/plugin-workspace/` |

修改领域术语前先阅读 `CONTEXT.md`。修改既有架构边界前，先阅读 `docs/adr/` 下的
相关 ADR。架构概览见 [中文架构说明](ARCHITECTURE.zh-CN.md)；英文原文见
`ARCHITECTURE.md`。

## 验证

根据改动边界运行最小的必要检查：

```powershell
# TypeScript Contract 和 Release Metadata
npm run typecheck
npm run verify:release

# 单个聚焦的 Node Test 文件
node --test tests/plugin-runtime-contract.test.mjs

# Desktop 或 Workspace 资源变化时构建 Renderer
npm run build
```

完整测试命令会先构建本地 Release Package，再运行所有 Node Test 文件：

```powershell
npm test
```

如果测试依赖实时 Browser Bridge 或外部信息源 Session，请在变更说明中明确写出。
确定性 Fixture 不能证明实时的 `COOKIE` 或 `INTERCEPT` 采集仍然有效；只有在开发机完成
所需配置后，才能使用 `npm run verify:real-source`。

## Plugin 作者路径

创建新 Plugin 时，请先阅读 [Plugin 开发指南](docs/plugin-development.zh-CN.md)：

```powershell
npm run plugin -- init path\to\my-plugin --check --format text
npm run plugin -- doctor path\to\my-plugin --format text
npm run plugin -- preview path\to\my-plugin --format text
npm run plugin -- pack path\to\my-plugin --out ..\my-plugin.infolens-plugin
```

`validate` 是快速的包契约检查。`doctor` 会在临时状态中运行真实 Backend 生命周期。
`pack` 会暂存最终包内容，并在写出 Artifact 前运行完整包检查。受信任的 Plugin Backend
是普通 Node.js 代码；这些命令提供的是生命周期和状态隔离，不是安全 Sandbox。

## 生成文件与本地文件

当 Plugin Workspace 源码变化时，提交 `plugins/*/web/dist/` 下的静态 Workspace Bundle。
以下本地路径不要提交：

- `node_modules/`
- `.infolens-data/`、`.infolens-dev/`、`.infolens-live/` 和 `.infolens-acceptance/`
- `release/`
- Chrome Profile、Cookie、导出的日志，以及包含凭据的诊断材料

创建 Pull Request 前运行 `git status --short`，检查每一个新增文件。仓库是 local-first
应用，浏览器登录状态必须留在 Chrome 中，不要写进 Fixture 或文档。

## Pull Request

说明改动的行为、所属边界，以及对 Contract 或数据的影响。列出实际运行过的验证命令，
并标明没有运行的实时信息源检查。当命令、包契约或安装要求变化时，请同步更新用户或
开发者文档。

不要在功能或 Bug 修复中混入无关重构。如果架构决策发生变化，请更新或新增对应 ADR，
并在 Pull Request 中说明该决策。不要提交 Secret、本地生成状态或未经检查的 Plugin
Package Artifact。

仓库本地的 Agent 工作约定见 [AGENTS.md](AGENTS.md)。
