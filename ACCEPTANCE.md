# OpenCLI Adapter Contract V2 Acceptance

状态：Ready for review

验收对象：Infolens Plugin Contract V2、Provided OpenCLI Adapter、Adapter Store/Scope、Product Hunt 迁移

验收基线：当前工作区源码及 `release/infolens-win32-x64` 本地构建产物

## 1. Review Boundary

本次验收只接受：

- 仓库中可直接检查的源代码和声明文件；
- 插件包内已经构建好的 JavaScript；
- 无需安装依赖即可启动的 Windows 构建产物；
- 使用本地已有依赖执行的校验、开发链接和打包命令。

本次明确禁止：

- 插件安装脚本或生命周期脚本；
- 插件安装时或运行时下载依赖；
- TypeScript 等源码的运行时编译；
- Adapter 自带独立 `node_modules`。

## 2. Acceptance Criteria

| ID | 验收条件 | 检查入口 | 通过标准 |
| --- | --- | --- | --- |
| AC-01 | 只支持 Plugin Contract V2 | `packages/plugin-runtime/src/contract.mjs`、各插件 `manifest.json` | V2 manifest 可加载；非 V2 返回 `INCOMPATIBLE_CONTRACT` |
| AC-02 | 插件可自带普通 OpenCLI Adapter | `openCliAdapters`、`opencli-adapters/` | Adapter 包含 `opencli-plugin.json`、可检查源码和可直接执行 JS |
| AC-03 | 安装不执行脚本、编译或下载 | `packages/plugin-runtime/src/server.mjs`、`adapter-scope.mjs` | 安装过程仅复制、校验、哈希、注册探测和写 Scope |
| AC-04 | Adapter 不存放在 OpenCLI `node_modules` | `adapterRegistryRoot`、Scope Lock | 已安装内容位于 Infolens 管理的 `opencli-adapters/store` |
| AC-05 | 每个插件使用精确 Adapter Scope | `scope.lock.json` 生成逻辑 | Lock 包含 Adapter ID、版本、SHA-256、绝对路径和注册命令 |
| AC-06 | 支持版本共存并阻止内容替换 | `packages/plugin-runtime/src/adapter-scope.mjs` | 同 ID/版本/哈希去重；同 ID/版本不同哈希拒绝；不同版本共存 |
| AC-07 | Store 内容复用前验证完整性 | `hashPublishedAdapter` | Store 内容与记录哈希不一致时返回 `ADAPTER_STORE_CORRUPTED` |
| AC-08 | 只暴露 manifest 声明的命令 | 注册报告与 `openCliCommands` 对照逻辑 | 未声明命令、命令冲突、Hook、策略或 access 不一致均被拒绝 |
| AC-09 | OpenCLI 只扫描当前 Scope | `OPENCLI_PLUGIN_PATHS`、`OPENCLI_DISABLE_USER_DISCOVERY` | 禁止用户全局发现，只传入当前插件的精确 Adapter 路径 |
| AC-10 | 重名检查先于 Scope 提交 | `discoverPlugins`、`installPlugin` | 重复插件 ID 不覆盖已有 Scope；同 ID 并发安装只能有一个成功 |
| AC-11 | 安装预检和失败回滚无残留 | 临时 preflight Registry、安装回滚逻辑 | 预检不修改正式 Store；复制或正式校验失败后清除 Scope 和未引用 Store |
| AC-12 | 资源许可按每次 `opencli.run` 获取 | `packages/plugin-runtime/src/server.mjs`、`task-manager.mjs` | `PUBLIC` 与浏览器资源按实际命令策略获取和释放 |
| AC-13 | Product Hunt 使用 Provided Adapter | `plugins/product-hunt/manifest.json`、`opencli-adapters/producthunt` | 注册 `infolens-producthunt today`，策略为 `INTERCEPT`、access 为 `read` |
| AC-14 | 开发者工具可用 | `packages/plugin-sdk/bin/infolens-plugin.mjs` | 支持 `validate`、`dev`、`pack`、`adapters list` |
| AC-15 | OpenCLI 临时补丁受版本保护 | `scripts/apply-opencli-overrides.mjs` | 仅允许 `@jackwener/opencli@1.8.6`，其他名称或版本在修改源码前拒绝 |
| AC-16 | 有可直接运行的 Windows 产物 | `release/infolens-win32-x64/Infolens.exe` | 双击或执行 EXE 可启动，不需要安装脚本、编译或网络下载 |

## 3. Source Review Map

- Contract V2：`packages/plugin-runtime/src/contract.mjs`
- Adapter Store、Scope Lock、哈希及注册约束：`packages/plugin-runtime/src/adapter-scope.mjs`
- 精确 OpenCLI 路径与运行入口：`packages/plugin-runtime/src/opencli-adapter.mjs`
- 插件发现、安装、判重与回滚：`packages/plugin-runtime/src/server.mjs`
- 每次命令的资源许可：`packages/plugin-runtime/src/task-manager.mjs`
- OpenCLI 兼容补丁：`scripts/apply-opencli-overrides.mjs`
- Product Hunt Adapter：`plugins/product-hunt/opencli-adapters/producthunt/`
- 插件开发 CLI：`packages/plugin-sdk/bin/infolens-plugin.mjs`
- 架构决策：`docs/adr/0049-plugin-provided-opencli-adapters.md`
- 开发者说明：`docs/plugin-development.md`

## 4. Reviewer Checks

以下命令只使用工作区已有依赖，不安装软件、不下载内容：

```powershell
npm run plugin -- validate plugins\product-hunt
npm run plugin -- adapters list plugins\product-hunt
node --test tests\adapter-scope.test.mjs
node --test --test-name-pattern "duplicate plugin ids" tests\sprint6-host-operations.test.mjs
node --test --test-name-pattern "unpinned package version" tests\sprint8-release-evidence.test.mjs
```

直接运行构建产物：

```powershell
.\release\infolens-win32-x64\Infolens.exe
```

人工检查重点：

1. Product Hunt 能作为已启用插件出现，并使用 `infolens-producthunt today`。
2. Adapter 源码位于 Product Hunt 插件目录，而非 OpenCLI `node_modules`。
3. 创建 Scope 后，Lock 中的版本、哈希、路径和命令与 manifest 一致。
4. 重复插件 ID 被拒绝，已有插件 Scope 保持不变。
5. 修改 Store 中已经发布的 JS 后，下一次注册校验拒绝该 Store。
6. Adapter 多注册 manifest 未声明的命令时，整个插件被拒绝。

## 5. Accepted Limitations

- 本阶段信任本地插件包，不提供进程或权限安全沙箱。
- 不支持 `UI` 策略、全局 OpenCLI Hook、命令覆盖或 Plugin Contract V1。
- OpenCLI 精确路径发现和机器可读注册报告当前通过固定 `1.8.6` 补丁提供。
- 长期方案是能力进入 OpenCLI 上游后升级固定依赖并删除补丁，不维护 Fork。

## 6. Review Decision

- [ ] Accept
- [ ] Accept with follow-up items
- [ ] Reject

Reviewer：____________________

Date：________________________

Blocking findings：

```text

```

Follow-up items：

```text

```
