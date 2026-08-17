# 插件前端开发体验模式研究

研究日期：2026-08-17

范围：只使用项目官方文档和上游源码仓库。重点比较前端框架自由度、构建与开发服务器、HMR/Live Reload、宿主集成、打包以及安全/信任边界。

## 结论

成熟平台通常把两个契约分开：

1. **发布契约**是宿主可验证的静态产物，例如 VSIX、插件目录、ZIP 或 `dist`。
2. **开发契约**允许本地 watch、dev server、自动重载或 HMR，但只在本地预览中启用。
3. 宿主只提供稳定的桥接 API，不要求宿主参与插件前端的 React/Vue/Svelte 编译。
4. 安全边界通常限制资源来源、网络域名、宿主 API 和发布签名；开发服务器应当是显式的开发态例外。

因此，Infolens 目前的 `build:workspace` 能解决“框架可以编译”的问题，但不能解决完整的开发体验。更合适的下一步是：保留静态 `ui.entry` 作为发布契约，再增加仅供 `preview` 使用的本地 dev-server URL/启动命令。没有 dev server 的插件继续使用现有的构建后重启流程。

## 对比总览

| 项目 | 框架自由度 | 开发循环 | 宿主集成与安全边界 |
| --- | --- | --- | --- |
| VS Code Webview | 任意可编译为 HTML/CSS/JS 的前端；官方 API 不绑定 React | 示例使用 TypeScript watch；Webview API 本身没有 HMR 契约 | iframe-like Webview + `postMessage`；资源 URI、`localResourceRoots`、CSP、nonce |
| Grafana Plugins | 以 React 组件为一等公民；Webpack 配置可扩展 | `webpack -w` + LiveReload，配套 Docker Grafana | 直接接入 Grafana React/AMD 运行时；默认要求签名，开发环境可免签名 |
| Figma Plugins | UI 是 HTML/CSS/JS iframe，官方示例包含 React + Vite | 示例同时提供 Vite/React Refresh、esbuild watch 和静态 single-file 构建 | `main` 操作 Plugin API，`ui` 由 `showUI` 打开；`allowedDomains`/`devAllowedDomains` 限制网络 |
| Raycast Extensions | UI 明确限制为 React + Raycast 原生组件 | `ray develop` 保存自动重载和错误覆盖层 | 宿主渲染原生 UI，命令生命周期由 Raycast 管理；发布到公共或组织私有 Store |
| Chrome Extensions | 扩展页面可使用任意打包后的 Web 前端 | Unpacked 开发；官方教程要求按组件手动 reload，HMR 非平台契约 | popup、service worker、content script 通过 manifest 和 messaging 连接；权限、MV3 CSP、商店审核 |

## 1. VS Code Webview

- **框架自由度**：官方文档称 Webview 可以渲染“almost any HTML content”，并通过消息与扩展通信。因此 React、Vue 或 Svelte 只要编译成 Webview 能加载的静态 HTML/JS/CSS，就不需要宿主支持对应框架。
- **开发模型**：官方 `webview-sample` 的 `watch` 只执行 `tsc -w`，Webview 文件位于扩展目录的 `media` 中。Webview API 提供内容更新和消息传递，但没有 dev-server 或 HMR 接口。
- **宿主与安全**：扩展侧设置 `webview.html`；前端通过 `acquireVsCodeApi()`、`postMessage` 与扩展侧通信。官方建议使用 `asWebviewUri`、限制 `localResourceRoots`、CSP 和 nonce，且 Webview 不能直接访问 VS Code API。
- **打包**：`vsce package` 生成可安装的 `.vsix`，发布物包含扩展需要的前端静态资源。

一手来源：

- [Webview API Guide](https://code.visualstudio.com/api/extension-guides/webview)
- [Official webview sample](https://github.com/microsoft/vscode-extension-samples/tree/main/webview-sample)
- [Sample package.json](https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/package.json)
- [Publishing and packaging extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

## 2. Grafana Plugins

- **框架自由度**：Grafana 官方教程明确把 Panel 描述为 ReactJS components。脚手架模板依赖 React、`@grafana/ui`、`@grafana/runtime` 等 Grafana 运行时包，非 React 前端不是默认扩展点。
- **开发模型**：模板生成的 `dev` 脚本是 `webpack -w ... --env development`；官方 Webpack 配置在 development 模式加入 `webpack-livereload-plugin`。`server` 脚本启动 Docker Grafana，形成“watch 构建 + 宿主实例”的本地循环。
- **宿主与打包**：入口通过 `PanelPlugin` 注册，Webpack 输出 AMD library，并把 public path 指向 `public/plugins/<plugin-id>/`。插件依赖 Grafana 提供的运行时模块，而不是把整个宿主 UI 打包进插件。
- **安全与信任**：Grafana 文档说明默认要求插件签名；`@grafana/create-plugin` 生成的 Docker 开发环境允许开发阶段加载未签名插件。生产配置中的 `allow_loading_unsigned_plugins` 明确不推荐。

一手来源：

- [Build a panel plugin](https://grafana.com/developers/plugin-tools/tutorials/build-a-panel-plugin)
- [Generated package template](https://github.com/grafana/plugin-tools/blob/main/packages/create-plugin/templates/common/_package.json)
- [Generated Webpack configuration](https://github.com/grafana/plugin-tools/blob/main/packages/create-plugin/templates/common/.config/webpack/webpack.config.ts)
- [Extend default configurations](https://grafana.com/developers/plugin-tools/how-to-guides/extend-configurations)
- [Sign a plugin](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin)

## 3. Figma Plugins

- **框架自由度**：Figma 官方文档说明插件 UI 是 iframe，可在其中编写任意 HTML、CSS 和 JavaScript；官方文档还链接 React UI 组件方案。上游 `esbuild-react` 示例直接使用 React、Vite 和 TypeScript。
- **开发模型**：示例的 `dev` 同时运行 TypeScript watch、esbuild watch 和 Vite；Vite 配置启用了 React Refresh 与 `vite-plugin-singlefile`。但 manifest 的 `ui` 仍指向 `dist/index.html`，所以 HMR 属于本地工具体验，不是 Figma 发布契约。
- **宿主与通信**：manifest 分别声明 `main` 和 `ui`；主代码调用 `figma.showUI(__html__)`，UI 通过 `parent.postMessage` 发送 `pluginMessage`。宿主不需要理解 React，只需要加载最终 HTML 并提供 Plugin API。
- **打包与安全**：manifest 使用相对文件路径，发布时加载构建结果。`networkAccess.allowedDomains` 限制正式网络访问，`devAllowedDomains` 可单独允许 `http://localhost:3000` 等开发地址；未列出的请求会触发 CSP 错误。

一手来源：

- [Plugin basics and UI](https://developers.figma.com/docs/plugins/)
- [Plugin Manifest](https://developers.figma.com/docs/plugins/manifest/)
- [Making network requests](https://developers.figma.com/docs/plugins/making-network-requests/)
- [Official React sample](https://github.com/figma/plugin-samples/tree/main/esbuild-react)
- [React sample package.json](https://github.com/figma/plugin-samples/blob/main/esbuild-react/package.json)
- [React sample Vite config](https://github.com/figma/plugin-samples/blob/main/esbuild-react/vite.config.ts)
- [Plugma: open-source Figma dev CLI with HMR](https://github.com/gavinmcfarland/plugma)

## 4. Raycast Extensions

- **框架自由度**：Raycast 官方文档明确使用 React 声明 UI，并把受支持的 `List`、`Grid`、`Detail`、`Form` 渲染为宿主原生 UI。这换取一致性和较强的宿主控制，但不是通用 HTML 容器，Vue/Svelte 不能直接替换 UI 渲染模型。
- **开发模型**：`npx ray develop` 提供保存自动重载、错误覆盖层、终端日志和构建错误状态；`npx ray build` 生成用于分发的优化构建。宿主没有要求开发者启动一个可被 Raycast iframe 加载的 Web server。
- **宿主与生命周期**：命令 manifest 的 `mode` 决定是否渲染 view；命令返回的 React component 是根组件，Raycast 负责加载和卸载命令，并对运行时间和内存施加约束。
- **打包与信任**：`package.json` 同时是 manifest；`ray publish` 会验证、构建并发布，支持公共 Store 和组织私有 Store。该模型的主要边界是宿主提供的 API 和 Store 分发，而不是浏览器式 iframe/CSP 配置。

一手来源：

- [Raycast UI source documentation](https://github.com/raycast/extensions/blob/main/docs/api-reference/user-interface/README.md)
- [Raycast CLI source documentation](https://github.com/raycast/extensions/blob/main/docs/information/developer-tools/cli.md)
- [Official Todo List extension manifest](https://github.com/raycast/extensions/blob/main/examples/todo-list/package.json)
- [Private extension distribution](https://github.com/raycast/extensions/blob/main/docs/teams/publish-a-private-extension.md)

## 5. Chrome Extensions

- **框架自由度**：popup、options page 和其他 extension pages 都是扩展包中的 HTML 页面，前端框架只需在构建时打包进这些页面。content script、service worker 和页面脚本是不同运行上下文。
- **开发模型**：官方 Hello World 教程使用 `Load unpacked`。它明确列出组件 reload 规则：manifest、service worker、content scripts 需要刷新扩展；popup、options page 和其他 HTML 页面不需要扩展 reload。Chrome 本身不提供通用 HMR 契约，开发者可以自行叠加 Vite/Webpack 等工具。
- **宿主与打包**：manifest 把 action popup 等入口连接到宿主；不同上下文通过 Chrome messaging 通信。开发时加载目录，发布时上传 ZIP 到 Chrome Web Store。
- **安全与信任**：Manifest V3 的 extension pages CSP 禁止 `eval()` 和远程脚本；权限需要在 manifest 中声明并可能产生用户警告。商店上传还经过 Chrome Web Store 的审核流程。

一手来源：

- [Hello World development and reload rules](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Content scripts and isolated contexts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
- [Publish to Chrome Web Store](https://developer.chrome.com/docs/webstore/publish/)
- [Official Hello World sample](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/tutorial.hello-world)

## 对 Infolens 的建议

最小可行的模式是“静态发布 + 预览 dev server”：

1. `ui.entry` 继续指向插件包内的构建产物，保证 `pack`、安装和离线加载不依赖 Node 或远程服务器。
2. 增加可选的 preview-only dev server 配置。Preview 启动开发者命令，等待 loopback URL，然后通过 Runtime 的同源代理转发 Workspace 的 HTTP 请求和 HMR WebSocket；不要直接让 iframe 跨到 Vite/Webpack 端口。
3. Runtime bridge 保持宿主提供的稳定接口，不把 `/runtime/` 或插件权限变成任意远程页面可访问的公共服务。当前 SDK 的 API 边界检查要求 API 与 Workspace 同源，见 [`workspaceApiUrl`](../../packages/plugin-sdk/src/index.js:45)。
4. 没有 dev server 配置的插件继续使用 `build:workspace` 的 watch、重建和 Runtime 重启；这是可靠的 fallback。
5. 打包时拒绝或忽略 dev server 配置，并限制 preview URL 为 loopback/明确的开发域名。

这会同时保留框架自由度和安全的静态发布边界。Grafana/Raycast 的宿主原生 React 模式适合强一致性的 UI 生态，但不适合作为 Infolens 追求 React、Vue、Svelte 等框架自由的默认模型。
