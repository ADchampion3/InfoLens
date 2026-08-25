# OpenCLI 插件迁移候选分析

研究日期：2026-08-21
目标人群：开发者、架构师、DevOps/SRE、AI 工程师、安全工程师及其他 IT 从业者

## 结论

第一批最适合进入 Infolens 的候选是 **掘金内容流**，但应基于当前 Bundled OpenCLI 已有的 `juejin hot` 命令，重新实现一个 Infolens Plugin，而不是把 `opencli-plugin-juejin` 原样复制进仓库。

第二候选是以 `opencli-plugin-hot-digest` 为原型的 **IT 技术摘要**。它的用户价值较高，但必须把泛热点收窄为 Juejin、DEV.to、Stack Overflow、V2EX 等技术来源，并重做多来源失败隔离、存储和 Workspace；不建议直接迁移上游实现。

`opencli-plugin-github-trending` 不需要迁移：Infolens 已有更完整的 `github-trending` Bundled Plugin。VK 插件与 X 长文发布插件不适合当前以 IT 信息阅读为主的产品；前者用户价值弱，后者是需要 `UI` 策略和写操作的发布工具。

推荐顺序：

1. **P0：Juejin Plugin（重建）**——IT 内容匹配度高，公共采集，无 Browser Bridge 依赖。
2. **P1：IT 技术摘要 Plugin（从 hot-digest 借鉴）**——价值高，但迁移和产品设计成本高。
3. **P2：开源项目与 AI 生态雷达（新建）**——组合 GitHub Trending、Hugging Face、npm/PyPI/crates、Docker Hub 等内置适配器。
4. **P3：安全与依赖生命周期 Plugin（新建）**——组合 OSV、NVD、End-of-Life、Go Proxy 等内置适配器，面向更专业的安全和平台工程用户。

## 口径：OpenCLI Plugin 不等于 Infolens Plugin

OpenCLI 当前至少有三类可复用能力，迁移判断必须分开：

| 类型 | OpenCLI 位置/能力 | 对 Infolens 的意义 |
| --- | --- | --- |
| 社区 OpenCLI Plugin | 独立 Git 仓库，安装后注册一个或多个 CLI Adapter；官方 README 当前列出 GitHub Trending、Hot Digest、Juejin、VK、X Article Publisher 五个插件 | 只能作为采集实现和产品想法的来源，不能直接当作 Infolens 包 |
| Bundled OpenCLI Adapter | OpenCLI 主仓库的 `clis/` 和适配器清单，覆盖 Juejin、DEV.to、Stack Overflow、V2EX、Hugging Face、npm、OSV 等 | 优先复用。Infolens 只需在自己的 Manifest 中声明 Command Mapping |
| External CLI passthrough | `gh`、`docker`、`vercel`、`obsidian` 等已有本地 CLI 的转发入口 | 适合未来的工具工作台，不适合直接作为当前的订阅式信息 Plugin |

来源：[OpenCLI README 的 Plugin 清单](https://github.com/jackwener/OpenCLI/blob/main/README.md)、[Plugin 指南](https://github.com/jackwener/OpenCLI/blob/main/docs/guide/plugins.md)、[完整 Adapter 清单](https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/index.md)。

本机 `opencli plugin list -f json` 当前没有安装第三方 OpenCLI Plugin；这不代表官方仓库没有候选，只代表它们没有进入当前用户的全局 OpenCLI 安装。Infolens 自己固定使用 1.8.6，并通过 [Bundled OpenCLI Runtime inventory](../../resources/opencli/runtime.json) 只暴露当前允许的四个 Command。**OpenCLI 安装包中存在某个 Adapter，不等于 Infolens 当前可以调用它。**

## Infolens 的迁移约束

迁移的正确含义是“复用来源采集行为，重建 Infolens 包”，不是复刻上游插件目录。

- Manifest 中的 `openCliCommands` 必须声明明确的 `site`、Command、策略、`access: read` 和 JSON 输出；当前只接受 `PUBLIC`、`COOKIE`、`INTERCEPT`，不接受 `UI`。见 [CONTEXT.md](../../CONTEXT.md) 和 [Plugin 开发指南](../plugin-development.zh-CN.md)。
- Plugin 必须自己拥有 Backend、SQLite Plugin Store、刷新策略和静态 Workspace；Host 不会为 OpenCLI 命令自动生成阅读界面。见 [ADR 0006](../adr/0006-trusted-plugin-owned-workspaces.md)。
- Provided Adapter 必须是可直接运行的 JavaScript，不能带 `node_modules`、未打包的运行时依赖、TypeScript-only Command 或 Install Script。见 [Plugin 开发指南中的 Adapter 约束](../plugin-development.zh-CN.md) 和 [ADR 0049](../adr/0049-plugin-provided-opencli-adapters.md)。
- Infolens 明确要求 Bundled Plugin 按当前契约重新设计，不保留上游 UI、Backend、数据模型或生命周期兼容层。见 [ADR 0021](../adr/0021-redesign-bundled-plugins.md)。
- 新增 Bundled Plugin 不只是增加一个目录，还会影响固定的 OpenCLI inventory、release evidence、真实信息源验证和若干当前写死“四个 MVP Plugin”的测试清单。相关入口包括 [release-evidence.mjs](../../scripts/release-evidence.mjs)、[verify-real-source.mjs](../../scripts/verify-real-source.mjs) 和 [package-release.mjs](../../scripts/package-release.mjs)。

## 社区 Plugin 逐项评估

### 1. `opencli-plugin-juejin`：推荐重建，P0

上游仓库提供三个命令：`juejin hot`、`juejin categories` 和 `juejin articles`。其中热榜和分类通过掘金公共 API 获取，文章流也面向技术文章分类；README 直接列出了后端、前端、Android、iOS、人工智能和开发工具等分类。来源：[仓库 README](https://github.com/Astro-Han/opencli-plugin-juejin)、[`hot.yaml`](https://raw.githubusercontent.com/Astro-Han/opencli-plugin-juejin/main/hot.yaml)、[`categories.yaml`](https://raw.githubusercontent.com/Astro-Han/opencli-plugin-juejin/main/categories.yaml)、[`articles.yaml`](https://raw.githubusercontent.com/Astro-Han/opencli-plugin-juejin/main/articles.yaml)。

**为什么适合 IT 人群**：它提供的是开发者日常需要的文章趋势、分类和技术社区内容，和 Infolens 的“定期采集—保留历史—稍后阅读”模型直接匹配；同时公共 API 路径不需要用户配置登录态。

**为什么不应原样迁移**：上游仓库只有 YAML Adapter；而 Infolens 的 Provided Adapter 要求构建后的 JS。更重要的是，当前 Bundled OpenCLI 1.8.6 已经包含 JS 版 `juejin hot`，官方 Adapter 清单也列出 Juejin 的公共命令，因此再携带一份掘金 Adapter 会增加版本、命令冲突和维护成本。

**建议实现**：

- 新建 `plugins/juejin/`，先只声明 Bundled Command `juejin hot`，不带 Provided Adapter。
- 首版只保留 `PUBLIC` 采集；用 `category` 和 `limit` 作为 Plugin-owned 设置，默认选择后端、前端或 AI 等 IT 分类。
- 保存文章 ID、标题、作者、URL、分类、热度/阅读/点赞/评论指标、采集时间和已读状态；用 SQLite 快照保留趋势变化。
- Workspace 提供当前热榜、分类筛选、历史日期、已读标记和文章详情跳转；文章正文读取可以作为第二阶段，避免首版把浏览器依赖引入进来。
- 需要把 `["juejin","hot"]` 加入 [runtime.json](../../resources/opencli/runtime.json)，并补齐 Plugin 的 release evidence、Plugin Context 和真实公共源验证。

**风险判断**：社区仓库目前是早期实现，GitHub 页面显示 1 个 Commit、3 个 Star、没有 Issue 或 Pull Request。这个信号不否定来源价值，但说明应复用协议和字段思路，不应把上游代码当作稳定依赖。

### 2. `opencli-plugin-hot-digest`：只借鉴，P1

Hot Digest 的目标是把多个平台热榜合并成一个列表。README 提到知乎、哔哩哔哩和微博；源码还包含 V2EX、Stack Overflow、Reddit 和 Linux.do。它通过浏览器页面访问多个站点，使用 `Strategy.COOKIE`，每个来源异常时静默跳过。来源：[仓库 README](https://github.com/ByteYue/opencli-plugin-hot-digest)、[`aggregate.ts`](https://raw.githubusercontent.com/ByteYue/opencli-plugin-hot-digest/master/aggregate.ts)。

**用户价值**：如果将来源从泛热点改成技术来源，它能成为开发者的每日信息入口，尤其适合同时关注中文社区、英文问答和开源讨论的用户。

**直接迁移问题**：

- 上游是 TypeScript 文件；Infolens 不在安装时编译 TypeScript。
- 上游是单个 `COOKIE` 浏览器命令，跨多个域名连续导航；需要 Browser Bridge、多个站点登录态和更复杂的失败诊断。
- “失败就跳过”会让用户误以为摘要完整，不符合 Infolens 对保留内容、失败时间和 dependency state 的要求。
- 当前 Infolens 强调 Plugin-owned Workspace 和 source-specific 数据；一个扁平的 `source/title/heat` 列表不足以支持来源详情、历史比较和可靠的未读状态。

**建议改造成 `tech-digest` 的条件**：

- 第一阶段只选公共来源：Juejin、DEV.to、Stack Overflow、V2EX；Linux.do 作为登录后可选来源，不和公共来源混成一个不可解释的失败状态。
- 每个来源保留 `sourceState`、错误码、采集时间和条数；一处失败不能让其他来源的快照不可读。
- 使用当前 Bundled OpenCLI 的独立 Command Mapping，而不是在一个 Adapter 内自行 `page.goto` 和调用未声明的网络端点。
- 只有在源数据字段、排序语义和阅读状态定义稳定后，才考虑跨来源统一排序；首版可以按来源分组。

**风险判断**：仓库页面显示 2 个 Commit、6 个 Star、没有 Issue 或 Pull Request；适合作为产品原型参考，不适合作为生产运行时依赖。

### 3. `opencli-plugin-github-trending`：不迁移，保留现有实现

上游是一个无依赖、无构建步骤的 YAML Plugin，主要通过 GitHub Trending 页面 DOM 提取仓库、语言和 Star 数据。来源：[上游仓库 README](https://github.com/ByteYue/opencli-plugin-github-trending)。

Infolens 当前已经有 [GitHub Trending Bundled Plugin](../../plugins/github-trending/manifest.json)，版本为 0.3.0；它不仅采集趋势仓库，还维护 SQLite 历史、语言/周期筛选、已读状态、README 缓存和导出。因此迁移上游 Plugin 会造成重复入口和数据模型分叉。推荐继续维护现有实现，把上游仓库仅作为最初字段映射的参考。

### 4. `opencli-plugin-vk`：不迁移

VK Plugin 提供用户/社区墙、个人 Feed 和搜索，需要 Chrome 已登录 VK 的实时浏览器 Session。来源：[仓库 README](https://github.com/flobo3/opencli-plugin-vk)。

它与 IT 信息订阅的关联弱，且会引入 COOKIE 采集、海外站点登录态和社区社交内容噪声。仓库页面显示 3 个 Commit、0 个 Star、没有 Issue 或 Pull Request，当前没有足够的产品或维护信号支撑迁移。

### 5. `opencli-plugin-x-article-publisher`：当前排除，未来另议

该 Plugin 用本地 Markdown 和图片发布 X 长文，要求 X Articles 权限、已登录 Chrome 和同一 Profile 中的 xPoster；命令是 `UI` 类型，默认创建草稿，只有显式 `--execute` 才公开发布。来源：[仓库 README](https://github.com/genoooool/opencli-plugin-x-article-publisher)。

它是写操作和内容发布工作流，不是信息采集/阅读 Plugin；当前 Infolens 只接受 `access: read`，且不接受 `UI` 策略。因此不能通过简单修改 Manifest 迁移。若未来要支持“从每日摘要生成并发布内容”，应单独定义写操作、确认、幂等和发布结果校验，不应混入当前信息源迁移。

### 6. `rubysec`：不作为已确认的当前社区 Plugin

OpenCLI Plugin 指南仍把 `opencli-plugin-rubysec` 放在示例列表中，但当前官方 README 的 Plugin 表没有列出它，也没有给出对应的社区仓库链接。见 [官方 Plugin 指南](https://github.com/jackwener/OpenCLI/blob/main/docs/guide/plugins.md) 和 [当前 README Plugin 表](https://github.com/jackwener/OpenCLI/blob/main/README.md)。

RubySec 领域本身对 IT 安全用户有价值，但在没有确认 Plugin 源码、许可证、字段和维护状态前，不应把它当作可迁移的现成候选。更稳妥的路线是直接使用当前 OpenCLI 的 `osv`、`nvd`、`endoflife` 和 `goproxy` 公共 Adapter，另建安全/依赖生命周期 Plugin。

## 更值得优先利用的内置 Adapter

这些不是“迁移社区 Plugin”，但比继续寻找小型社区仓库更符合 IT 用户需求。OpenCLI 官方适配器清单列出了以下能力：[公共 Adapter 清单](https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/index.md)。

| 用户任务 | 可用内置 Adapter | 建议 |
| --- | --- | --- |
| 每日技术文章 | `juejin hot`、`devto top/latest/tag`、`stackoverflow hot/tag/unanswered` | P0/P1，公共采集，适合历史阅读 |
| 技术社区讨论 | `v2ex hot/latest/topic`、`linux-do feed/topic` | V2EX 先做公共路径；Linux.do 作为 COOKIE 可选源 |
| AI/开源生态 | `hf models/paper/spaces/datasets`、GitHub Trending | P2，按模型、论文、Space 和仓库类型分组 |
| 开发依赖和镜像 | `npm`、`pypi`、`crates`、`dockerhub`、`goproxy` | P2/P3，适合版本、下载量和依赖变更监控 |
| 安全与生命周期 | `osv`、`nvd`、`endoflife` | P3，适合按包名、CVE 或产品建立订阅规则 |

其中，`devto`、`stackoverflow`、`v2ex`、`npm`、`pypi`、`crates`、`dockerhub`、`hf`、`osv`、`nvd` 和 `endoflife` 在当前本地 1.8.6 Distribution 中均有对应 Adapter 文件；但是否能被 Infolens 调用仍取决于是否加入 [runtime.json](../../resources/opencli/runtime.json) 并通过 Plugin Contract 验证。

## 推荐的落地分期

### 现在做：Juejin Plugin

1. 先确认并固定当前 Bundled OpenCLI 的 `juejin hot` Command 输出字段和版本。
2. 增加 `juejin` Plugin 包：Manifest、Backend、独立 SQLite Store、静态 Workspace、刷新设置、历史和导出。
3. 将 `juejin hot` 加入 Bundled OpenCLI inventory，运行 `validate`、`adapters list`、`doctor`、`pack` 和公共源验证。
4. 更新固定四个 MVP Plugin 的 release/test 清单，使新增 Plugin 进入真实发布证据，而不是只在 `plugins/` 目录中存在。

### 后做：技术摘要

先用独立的 Juejin、DEV.to、Stack Overflow 或 V2EX 数据模型验证各自的历史与阅读体验，再决定是否在一个 `tech-digest` Plugin 中聚合。不要从上游的扁平聚合结果直接设计数据库，否则以后无法解释来源失败、重复文章和排序变化。

### 作为产品扩展：安全/依赖雷达

当 IT 用户已经有日常技术内容入口后，再加入 OSV/NVD/End-of-Life 等规则化订阅。这个方向专业价值高，但不是简单热榜；需要包名/CVE/版本范围、严重性、修复版本和重复告警的领域模型，适合单独 Plugin。

## 最终建议

批准 **Juejin 重建** 进入下一轮开发调研；批准 **hot-digest 衍生的 IT 技术摘要** 进入产品原型阶段；暂不迁移 GitHub Trending、VK、X Article Publisher，也不把文档中未确认仓库的 RubySec 示例当作现成 Plugin。所有迁移都应遵循 Infolens 的“采集行为可复用、Plugin 包和数据模型重新设计”的边界。

### 研究来源

- [OpenCLI 官方 README](https://github.com/jackwener/OpenCLI/blob/main/README.md)
- [OpenCLI Plugin 指南](https://github.com/jackwener/OpenCLI/blob/main/docs/guide/plugins.md)
- [OpenCLI 完整 Adapter 清单](https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/index.md)
- [opencli-plugin-github-trending](https://github.com/ByteYue/opencli-plugin-github-trending)
- [opencli-plugin-hot-digest](https://github.com/ByteYue/opencli-plugin-hot-digest)
- [opencli-plugin-juejin](https://github.com/Astro-Han/opencli-plugin-juejin)
- [opencli-plugin-vk](https://github.com/flobo3/opencli-plugin-vk)
- [opencli-plugin-x-article-publisher](https://github.com/genoooool/opencli-plugin-x-article-publisher)
