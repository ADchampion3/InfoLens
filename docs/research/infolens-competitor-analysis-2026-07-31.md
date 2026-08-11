# Infolens 同类产品对比分析

研究日期：2026-07-31

## 结论摘要

Infolens 不是传统 RSS 阅读器，也不是文档 RAG/知识库。它是一个 `local-first information-plugin host`：Host Shell 只负责导航、生命周期与诊断，每个 Plugin 自己拥有采集、持久化、刷新规则和完整 Plugin Workspace。[项目术语表](../../CONTEXT.md) [ADR-0006](../adr/0006-trusted-plugin-owned-workspaces.md)

它与 Inoreader、FreshRSS、Folo、Fluent Reader 争夺的是同一件事：帮助用户持续跟踪外部信息。但 Infolens 没有把所有来源压成统一 feed，而是允许 Hacker News、GitHub Trending、知乎热榜、Product Hunt 各自保留合适的数据结构与交互，并通过 OpenCLI 覆盖公开接口、浏览器 Cookie 和网络拦截三种采集方式。[MVP 策略映射](../../CONTEXT.md) [ADR-0002](../adr/0002-opencli-as-the-collection-runtime.md)

这带来清晰的优劣势：

- **优势**：非 RSS 来源覆盖、登录态/动态页面采集、来源原生工作区、本地持久化、采集失败诊断和受约束的插件供应链。
- **缺点**：目前只有四个来源；没有统一搜索、规则、标签、收藏、导入导出、移动端、同步或 AI；第三方插件信任模型和发行成熟度仍处于 MVP 水平。

最合理的定位不是“另一个更漂亮的 RSS 阅读器”，而是：**面向技术信息消费者的本地、可扩展、多站点观察台，尤其擅长传统 feed 覆盖不到的登录态和动态来源。**

## 范围与方法

本报告只采用仓库内设计文档、产品官网、官方文档和官方源代码仓库。没有进行 UI 测试，也没有把营销文案当作独立验证过的质量结论。仓库 stars、版本和更新时间是 2026-07-31 的快照。

直接产品对标选取：

- **Inoreader**：成熟商业信息监控产品，代表统一收件箱、规则、搜索、自动化与 AI 的上限。
- **FreshRSS**：成熟自托管聚合器，代表数据主权、标准协议、扩展与多用户。
- **Folo**：新一代开源 AI RSS 阅读器，代表现代跨端体验、多媒体信息流和 AI 辅助。
- **Fluent Reader**：本地 Electron RSS 阅读器，代表轻量桌面、本地搜索和服务同步基线。

RSSHub 与 OpenCLI 放在单独的“采集基础设施层”。它们负责把网站能力变成结构化输出，不是拥有阅读、已读状态和长期工作流的终端产品，不能与上述四项放在同一产品成熟度矩阵。

## Infolens 产品基线

当前 MVP 包含 Hacker News、GitHub Trending、知乎热榜和 Product Hunt 四个 Bundled Plugin。Hacker News 与 GitHub Trending 使用 `PUBLIC`，知乎使用 `COOKIE`，Product Hunt 使用 `INTERCEPT`。每个 Plugin 有独立后端、SQLite Plugin Store、刷新设置和完整工作区。[MVP 来源与策略](../../CONTEXT.md) [四个策略代表](../adr/0035-four-real-opencli-strategy-representatives.md) [独立 SQLite](../adr/0024-independent-sqlite-plugin-stores.md)

产品的基本取舍是“来源原生”而非“统一阅读投影”。这使 GitHub Trending 可以展示语言、星标增长和 README，知乎可以展示热度和回答数；代价是 Host Shell 不天然拥有跨来源搜索、标签和收藏。[ADR-0005](../adr/0005-rebuildable-reading-projection.md) [ADR-0006](../adr/0006-trusted-plugin-owned-workspaces.md)

## 横向对比

| 维度 | Infolens | Inoreader | FreshRSS | Folo | Fluent Reader |
| --- | --- | --- | --- | --- | --- |
| 目标用户 | 需要本地观察异构网站的技术用户 | 个人研究者、媒体与专业信息监控用户 | 重视数据主权的个人、小团队和自托管用户 | 希望用现代跨端时间线消费多媒体信息的个人 | 偏好本地桌面 RSS 的个人 |
| 核心工作流 | 选 Plugin -> 刷新 -> 在来源原生工作区消费 | 订阅/监控 -> 规则过滤 -> 搜索/标注/自动化 -> AI 辅助 | 自托管 -> 订阅 -> 后台抓取 -> Web/第三方客户端阅读 | 订阅 feed/列表 -> 统一时间线 -> AI 辅助浏览 | 添加/同步 RSS -> 文件夹和规则 -> 本地阅读 |
| 数据源 | 当前 4 个；公开、Cookie、拦截三类站点采集 | RSS、网站变化、Newsletter、社交与其他可监控来源 | RSS/Atom、JSON、WebSub；基础 XPath 抓取非 feed 网站 | feed 与策展列表；文章、视频、图片、音频 | RSS/Atom 与 Fever/Google Reader 类服务 |
| 部署与隐私 | Electron 本地运行；业务数据按 Plugin 本地保存 | 商业云服务，Web 与移动应用 | AGPL 自托管，多用户，可用 SQLite/PostgreSQL/MySQL | Web、桌面、移动端；客户端 AGPL，官方服务会处理账户与订阅数据 | BSD 桌面端；可纯本地或连接同步服务 |
| AI/检索 | 无统一 AI 或跨 Plugin 检索 | 全文搜索、规则、过滤与 Inoreader Intelligence | 搜索、标签、用户查询；无官方内建生成式 AI | 翻译、摘要、推荐等 AI 功能 | 正则搜索、已读过滤和自动规则；无内建 AI |
| 扩展性 | 完整 Plugin Workspace + Backend + OpenCLI Adapter | 开发者 API、自动化和外部集成；闭源产品能力由厂商控制 | Extensions、CLI、Google Reader/Fever API、OPML | AGPL 客户端与 RSS/RSSHub 生态 | BSD 源码、OPML、备份恢复与多种同步协议 |
| 成熟度 | `0.1.0`、无 tag/根许可证；真实来源发布验证仍需人工 | 2013 年起的商业产品，多端、订阅和支持体系完整 | 2012 年起；约 15.7k stars，`1.29.1` | 活跃开发；约 38.7k stars，桌面 `1.12.0` | 2020 年起；约 9.6k stars，`1.2.2` |

## 逐项分析

### Inoreader

- **目标用户**：官方把产品描述为一个用于发现、消费和监控内容的平台，并单独提供面向专业用户与团队的能力。它不只是读文章，也强调研究、媒体监控和把高价值信息从噪音中筛出来。[官方产品页](https://www.inoreader.com/) [About](https://www.inoreader.com/about/)
- **核心工作流**：把订阅和监控内容放进统一账户，用文件夹、标签、全文搜索、规则、过滤和高亮持续整理，再通过自动化把结果送往其他服务。[Features](https://www.inoreader.com/features/) [Pricing 功能矩阵](https://www.inoreader.com/pricing)
- **数据源**：除 RSS 外，官方功能页还覆盖 Web feeds、Newsletter、社交/页面监控等入口。相较 Infolens，它强调把异构入口规范化进统一阅读模型，而不是为每个来源提供独立工作区。[Features](https://www.inoreader.com/features/)
- **部署与隐私**：商业托管服务，提供 Web、iOS 和 Android 使用路径，不提供官方自托管版本。用户获得跨端同步和持续后台抓取，但数据边界不如 Infolens/FreshRSS 本地可控。[官网](https://www.inoreader.com/) [Privacy Policy](https://www.inoreader.com/privacy_policy)
- **AI/检索**：官方的 Inoreader Intelligence 提供摘要、翻译、报告等 AI 辅助；传统能力还包括全文搜索、规则和过滤。它的优势是 AI 建立在成熟的信息整理工作流上，而不是孤立的聊天框。[Features](https://www.inoreader.com/features/) [Pricing 功能矩阵](https://www.inoreader.com/pricing)
- **扩展性**：官方开发者门户提供基于 OAuth 的 API，允许客户端访问订阅、stream 等账户数据；但采集和主产品扩展由云端产品控制，不是本地插件宿主。[Developer Portal](https://www.inoreader.com/developers/)
- **成熟度**：官方 About 页面记载产品自 2013 年开始；多端应用、免费/付费层、开发者 API、知识库和商业支持均已形成。[About](https://www.inoreader.com/about/) [Pricing](https://www.inoreader.com/pricing)

**对 Infolens 的含义**：Inoreader 是“统一信息工作流”的最强对标。Infolens 在来源表达与本地边界上更灵活，但在搜索、规则、自动化、跨端和持续后台刷新上差距最大。

### FreshRSS

- **目标用户**：官方定位是轻量、强大、可定制的 self-hosted RSS feed aggregator；支持多用户和匿名阅读，适合自己掌控服务的个人或团队。[官方 README](https://github.com/FreshRSS/FreshRSS#readme)
- **核心工作流**：安装服务、导入或添加订阅、按标签和 user queries 阅读；WebSub 兼容来源可推送更新，其他来源由服务端持续抓取。[README](https://github.com/FreshRSS/FreshRSS#readme) [用户文档](https://freshrss.github.io/FreshRSS/en/users/02_First_steps.html)
- **数据源**：原生处理 RSS/Atom，并支持 JSON 文档、WebSub 和基于 XPath 的基础网页抓取；还能把文章选择重新分享为 HTML、RSS 或 OPML。[网页抓取](https://freshrss.github.io/FreshRSS/en/users/11_website_scraping.html) [User queries](https://freshrss.github.io/FreshRSS/en/users/user_queries.html)
- **部署与隐私**：AGPL-3.0，自托管于 Linux/Windows 服务端，支持 SQLite、PostgreSQL、MariaDB/MySQL；官方提供 Docker 和多种托管入口。数据主权强，但部署和运维成本高于本地桌面 Infolens。[安装](https://freshrss.github.io/FreshRSS/en/admins/03_Installation.html) [官方 README - Requirements](https://github.com/FreshRSS/FreshRSS#requirements)
- **AI/检索**：官方核心强调搜索、标签、user queries 和确定性抓取，没有内建生成式 AI。这说明长期信息工具的基本价值仍来自可靠更新、过滤和可迁移性。[用户文档](https://freshrss.github.io/FreshRSS/en/users/02_First_steps.html)
- **扩展性**：有 Extensions、CLI、Google Reader API 与 Fever API，可连接多种原生/移动客户端；OPML 和导出能力保证迁移性。[Extensions](https://github.com/FreshRSS/Extensions) [API 与客户端](https://github.com/FreshRSS/FreshRSS#apis--native-apps) [CLI](https://github.com/FreshRSS/FreshRSS/tree/edge/cli)
- **成熟度**：官方仓库始于 2012 年，2026-07-31 约 15.7k stars；最新稳定版 `1.29.1`，README 说明通常每两到三个月发布新版。[仓库](https://github.com/FreshRSS/FreshRSS) [Releases](https://github.com/FreshRSS/FreshRSS/releases)

**对 Infolens 的含义**：FreshRSS 在自托管、标准协议、多用户、备份迁移和扩展生态上成熟得多；Infolens 的反击点是不用部署服务器，并能比 XPath/feed 更自然地处理登录态网站和来源特有数据。

### Folo

- **目标用户**：官方把 Folo 描述为把内容组织到一个时间线、分享列表和探索集合的开放信息空间，面向希望减少噪音并追踪多媒体内容的个人用户。[官方 README](https://github.com/RSSNext/Folo#readme)
- **核心工作流**：订阅 feed 与策展列表，在统一时间线浏览和探索。相较 Infolens 的“每个来源一个完整工作区”，Folo 更强调统一聚合和发现。[Customized Information Hub](https://github.com/RSSNext/Folo#-features)
- **数据源**：官方明确覆盖文章、视频、图片和音频，并与 RSSHub 配合。它的优势是 feed 网络广度，官方产品材料没有展示 Infolens 这种由宿主执行登录态或拦截命令的插件合同。[Dynamic Content Support](https://github.com/RSSNext/Folo#-features) [RSSHub 与 Folo](https://github.com/DIYgod/RSSHub#related-projects)
- **部署与隐私**：提供 Web、iOS、Android、macOS、Windows 和 Linux 客户端，代码使用 AGPL-3.0；但官方隐私政策说明服务会收集账号、订阅、使用与设备数据，并可能由托管、分析等服务商处理。因此客户端开源不等于默认数据本地。[支持平台](https://github.com/RSSNext/Folo#-getting-started--join-our-community) [隐私政策源码](https://github.com/RSSNext/Folo/blob/dev/apps/landing/src/legal/privacy.md)
- **AI/检索**：官方列出翻译、摘要等 AI 功能；隐私政策还提到推荐和分类，并声明未经明确同意不会用个人数据训练或改进 AI 模型。[AI 功能](https://github.com/RSSNext/Folo#ai-at-your-fingertips) [AI 数据使用](https://github.com/RSSNext/Folo/blob/dev/apps/landing/src/legal/privacy.md#ai-features-and-data-use)
- **扩展性**：AGPL 仓库和 RSS/RSSHub 生态使 feed 扩展门槛较低，但没有终端用户级的“插件拥有独立后端、存储和 UI”合同。[贡献指南](https://github.com/RSSNext/Folo/blob/dev/CONTRIBUTING.md)
- **成熟度**：项目仍自称 active development；2026-07-31 约 38.7k stars，最新稳定桌面 release 为 `desktop/v1.12.0`。[仓库](https://github.com/RSSNext/Folo) [Releases](https://github.com/RSSNext/Folo/releases)

**对 Infolens 的含义**：Folo 已占据“现代、跨端、AI 增强的统一信息流”。Infolens 不宜以统一时间线正面对抗，应强调 Folo 难表达的来源原生结构和浏览器登录态采集。

### Fluent Reader

- **目标用户**：官方定位是现代桌面 RSS 阅读器，适合在 Windows、macOS、Linux 本地阅读，或连接既有 RSS 服务的个人用户。[官方 README](https://github.com/yang991178/fluent-reader#readme)
- **核心工作流**：导入 OPML 或添加订阅，以文件夹组织，使用内建文章视图或原网页阅读，并用已读/星标和正则规则处理新文章。[功能列表](https://github.com/yang991178/fluent-reader#features)
- **数据源**：以 RSS 为中心，也可同步 Fever、Google Reader API 兼容自托管服务，以及 Inoreader、Feedbin、The Old Reader、BazQux 等服务。[功能列表](https://github.com/yang991178/fluent-reader#features)
- **部署与隐私**：BSD 授权 Electron 桌面应用，可纯本地阅读；是否把数据交给第三方取决于是否配置外部同步。官方提供商店、GitHub 安装包和源码构建步骤。[下载与构建](https://github.com/yang991178/fluent-reader#download) [许可证](https://github.com/yang991178/fluent-reader#license)
- **AI/检索**：支持正则搜索、已读过滤和自动规则，没有官方内建 AI。它证明桌面信息工具即使没有 AI，也必须先把可靠搜索和规则做扎实。[功能列表](https://github.com/yang991178/fluent-reader#features)
- **扩展性**：OPML、完整备份/恢复和同步协议保证可迁移性，但没有产品级插件 API；新增服务支持仍由项目代码承担。[功能列表](https://github.com/yang991178/fluent-reader#features)
- **成熟度**：仓库创建于 2020 年，BSD-3-Clause；2026-07-31 约 9.6k stars，最新 release 为 `v1.2.2`。[仓库](https://github.com/yang991178/fluent-reader) [Releases](https://github.com/yang991178/fluent-reader/releases)

**对 Infolens 的含义**：Fluent Reader 架构较浅，但 OPML、备份恢复、搜索、规则、通知和后台抓取构成长期桌面使用的基本预期。Infolens 的平台能力领先，日常信息管理完整度落后。

## 采集基础设施层：RSSHub 与 OpenCLI

### 为什么不把它们当终端竞品

RSSHub 和 OpenCLI 都解决“如何从网站拿到结构化数据”，但不负责一个成熟阅读产品的账户、已读状态、信息组织和长期消费体验。Infolens 则在 OpenCLI 之上拥有 Plugin 生命周期、Plugin Store、刷新策略、工作区和诊断。因此它们既是替代采集方案，也是 Infolens 的上游能力来源，不应与 Inoreader/Folo 等同权比较。

### RSSHub

RSSHub 自称拥有 5,000+ 全球实例，目标是把各类来源转换为 RSS；其生态还包括用于发现当前网站 feed/route 的 RSSHub Radar。它可自托管，路由社区广、输出标准，天然能被任意阅读器复用。[官方 README](https://github.com/DIYgod/RSSHub#readme) [部署文档](https://docs.rsshub.app/deploy/) [RSSHub Radar](https://github.com/DIYgod/RSSHub-Radar)

相较之下，Infolens + OpenCLI 的优势是：

- 可直接使用用户已登录的 Chrome 会话，而不是要求把身份信息配置进共享 feed 服务；
- 支持 `PUBLIC`、`COOKIE`、`INTERCEPT`，并保留来源的结构化字段；
- Plugin 可以为来源设计完整工作区，而不是把输出限制成 RSS item。

RSSHub 的优势是路线数量、标准协议、服务端持续更新和“一条 route 可供所有阅读器使用”。Infolens 不应复制 RSSHub 的长尾 route 竞赛；对于能稳定变成 feed 的来源，集成或复用 RSSHub 比重写专用 Plugin 更合理。

### OpenCLI

OpenCLI 的官方定位是把网站、登录后的浏览器会话、Electron 应用和本地工具变成确定性 CLI。它提供内建 adapter、Browser Bridge、结构化 DOM/网络提取、`PUBLIC`/`COOKIE`/`INTERCEPT`/`UI`/`LOCAL` 鉴权/执行模式以及第三方 plugin。[官方 README](https://github.com/jackwener/opencli#readme) [扩展指南](https://github.com/jackwener/opencli/blob/main/docs/guide/extending-opencli.md)

Infolens 不 fork OpenCLI，而是捆绑固定版本作为采集运行时；Host 只允许 Plugin 调用 manifest 声明过的 command key，并对 adapter 版本、哈希、命令和策略进行校验。[ADR-0002](../adr/0002-opencli-as-the-collection-runtime.md) [ADR-0049](../adr/0049-plugin-provided-opencli-adapters.md)

这说明 Infolens 的真正产品价值不应是“另一个 OpenCLI GUI”，而是 OpenCLI 没有负责的部分：持续保留、可恢复刷新、来源工作区、已读状态、插件生命周期和日常信息消费。OpenCLI adapter 数量增长会直接降低 Infolens 新增来源的成本，但也构成上游版本与 Browser Bridge 依赖风险。

## Infolens 的优势

### 1. RSS 覆盖不到的来源是明确差异化

四个 MVP Plugin 已验证公开源、Chrome Cookie 登录态和网络响应拦截。知乎与 Product Hunt 不是简单 feed URL，而是通过 OpenCLI Strategy Mapping 执行。[知乎清单](../../plugins/zhihu-hot/manifest.json) [Product Hunt 清单](../../plugins/product-hunt/manifest.json)

这使 Infolens 有机会覆盖个性化信息流、登录后榜单、动态前端和结构化站点状态。四个终端竞品都能扩充 feed 来源，但没有同时提供“本地登录会话 + 来源专用工作区 + 插件合同”。

### 2. 来源原生工作区比统一文章模型更适合榜单和状态

Plugin 不只返回数据，还拥有完整 Workspace、Backend、Store 和刷新行为。GitHub Trending 能展示语言、星标增长和 README，知乎能展示热度和回答数，而不必被压成标题/摘要/日期。[GitHub Trending 后端](../../plugins/github-trending/backend/index.js) [知乎工作区](../../plugins/zhihu-hot/web/dist/workspace.js)

这适合榜单、价格、issue、论坛、发布记录、监控状态等信息，也是 Infolens 最值得维护的产品边界。

### 3. 本地优先且业务数据按 Plugin 分离

每个 Plugin 以独立 SQLite 保存自己的业务数据，Host State 与业务数据分离；应用不是必须注册账户的云服务。[ADR-0024](../adr/0024-independent-sqlite-plugin-stores.md) [ADR-0028](../adr/0028-lightweight-json-host-state.md)

相较 Inoreader 与 Folo 官方服务，本地边界更直接；相较 FreshRSS，不需要用户维护服务器和数据库。

### 4. 插件采集供应链边界严谨

Plugin Contract Version 2 对 host/OpenCLI 版本、策略、命令和 adapter 内容做发现期校验；Provided OpenCLI Adapter 使用哈希、不可变 Managed Adapter Store 和精确 Scope Lock，安装时不执行脚本、编译或联网拉依赖。[ADR-0048](../adr/0048-discovery-time-package-compatibility.md) [ADR-0049](../adr/0049-plugin-provided-opencli-adapters.md)

这比让用户随意粘贴抓取脚本更可诊断，也能减少插件安装顺序和全局依赖污染。

### 5. 把采集失败当作产品状态

Infolens 明确定义 Plugin Health、Plugin Status Snapshot 和 Plugin Diagnostic Report；真实来源发布验证要求采集、SQLite 持久化与工作区渲染形成端到端证据。[诊断术语](../../CONTEXT.md) [ADR-0038](../adr/0038-local-real-strategy-release-verification.md) [ADR-0050](../adr/0050-host-owned-global-operational-diagnostics.md)

依赖站点结构和浏览器会话时，可见的陈旧数据与明确错误通常优于刷新失败后清空。

## Infolens 的缺点

### 1. 平台能力还没有转化成来源覆盖

MVP 只有四个 Bundled Plugin；Plugin Directory 是固定本地目录，当前 Plugin Manager 只负责列出和删除，不是 marketplace 或远程 registry。[MVP 来源](../../CONTEXT.md) [Plugin Directory 与 Plugin Manager](../../CONTEXT.md)

用户首先看能否覆盖自己的来源。Folo 可借 RSS/RSSHub 获得广度，FreshRSS 有标准 feed、网页抓取和 Extensions，Inoreader 有厂商维护的监控入口；Infolens 当前明显不足。

### 2. 缺少跨来源的基本信息管理

架构取消了 host-owned unified reading projection，各 Plugin 自己维护已读、筛选和存储。这保护了来源差异，却意味着没有统一搜索、统一收藏、标签、批量已读或全局规则。[ADR-0005](../adr/0005-rebuildable-reading-projection.md) [ADR-0006](../adr/0006-trusted-plugin-owned-workspaces.md)

Inoreader 的规则/过滤/搜索、FreshRSS 的标签与 user queries、Fluent Reader 的正则规则已经成为成熟产品的日常底线。Infolens 容易退化成四个并排的小应用。

### 3. AI 和“Lens”能力仍为空白

仓库没有统一摘要、翻译、语义检索、变化比较或推荐。Folo 已把摘要和翻译放入浏览，Inoreader Intelligence 建立在规则和监控工作流之上。[Folo AI](https://github.com/RSSNext/Folo#ai-at-your-fingertips) [Inoreader Features](https://www.inoreader.com/features/)

问题不在于缺一个聊天框，而在于 Infolens 负责采集信息后，还没有帮助用户压缩、比较和发现变化。

### 4. 没有跨端、同步和远程后台刷新

当前是 Electron 桌面应用；Application Session 在主窗口关闭时结束 Plugin Runtime，不是常驻后台服务。[Application Session](../../CONTEXT.md) [Electron Host](../adr/0008-electron-desktop-host.md)

Inoreader/Folo 有跨端与云端刷新，FreshRSS 作为服务持续运行，Fluent Reader 也能连接同步服务。Infolens 关闭后停止刷新，换设备也没有连续性。

### 5. 本地优先不等于零信任

Plugin 是 trusted local package，可运行 Backend Module；浏览器型 Plugin 还会使用现有浏览器登录态。OpenCLI command 虽被约束，Plugin Backend 本身不是完整安全沙箱。[默认信任模型](../adr/0007-simplified-trusted-plugin-package.md) [Plugin Backend](../adr/0042-plugin-backend-module-interface.md)

一旦开放第三方分发，用户需要清楚知道插件访问哪个域名、哪类登录状态、哪些本地数据和计划任务。当前更像供应链完整性机制，还不是面向用户的权限模型。

### 6. 数据可携带性和自动化出口不足

FreshRSS 有 OPML、CLI、API 和客户端协议；Fluent Reader 有 OPML 与完整备份恢复；Inoreader 有开发者 API。Infolens 强调插件自有数据库，却没有统一导出、备份、Webhook 或只读 API 合同。[FreshRSS API](https://github.com/FreshRSS/FreshRSS#apis--native-apps) [Fluent Reader 功能](https://github.com/yang991178/fluent-reader#features) [Inoreader Developer Portal](https://www.inoreader.com/developers/)

“数据在本地”只能回答数据在哪里，不能回答用户能否带走和复用。

### 7. 产品成熟度仍是早期工程项目

根 `package.json` 是 `0.1.0` 且 `private: true`；截至研究日仓库没有 tag，也没有根许可证文件。已有 52 个 Node 测试，但真实来源验证仍依赖开发者机器、Browser Bridge 和登录会话，不属于普通 CI。[package.json](../../package.json) [真实来源验证](../adr/0038-local-real-strategy-release-verification.md)

与四个已有版本发布、迁移、文档和用户支持体系的竞品相比，Infolens 尚未形成可供外部用户长期信赖的安装、升级、兼容和支持承诺。

## 建议优先级

### 1. 扩大“非 RSS 高价值来源”，而不是复制 RSSHub

将 Bundled Plugin 从四个验证样本扩展为有连续使用价值的来源组合，优先选择来源原生结构或登录态采集确有优势的场景。普通博客、播客和已有稳定 feed 的来源应优先接 RSSHub 或标准 feed 生态，而不是逐个编写重量级 Plugin。

### 2. 补齐长期使用底线

优先提供全量备份/恢复、每 Plugin 导出、全局未读入口和最低限度的跨 Plugin 查找。现有 ADR 拒绝统一业务投影，因此跨 Plugin 能力应只索引 Plugin 明确公开的最小元数据，或通过新合同实现，不能悄悄把业务所有权收回 Host。

### 3. 把插件声明变成用户可理解的信任信息

在 marketplace 之前，展示来源域名、OpenCLI Strategy、是否读取浏览器会话、计划任务、数据目录、Provided Adapter 及版本/哈希。默认信任适合 MVP，不足以支撑开放生态。

### 4. AI 应优先解释“变化”

如果引入 AI，优先解释榜单为何变化、比较两次 Collection Snapshot、聚合同一项目的跨来源信号、生成带原始链接的每日变化摘要。不要从通用聊天开始，那会进入 Inoreader/Folo 以及大量 AI 壳产品的强势区间。

AI 应可选、明确数据去向，并允许本地模型或用户自带 provider，不破坏 Plugin Store 所有权边界。

### 5. 建立发行承诺

补齐根许可证、用户 README、版本 tag、安装包发布、升级/回滚说明和兼容矩阵；将四个真实来源的人工验证结果沉淀为可审阅的 release evidence。没有这些，架构严谨无法转化成用户信任。

## 最终判断

从长期使用者角度，Infolens 目前是一个**方向有辨识度、工程边界认真，但产品闭环尚未成立**的项目。

它胜过同类的地方，是不把所有信息误装成 RSS 文章，并认真处理动态站点、浏览器登录态、本地持久化、来源特有 UI 与采集失败；它落后的地方，是来源覆盖、跨源搜索整理、跨端连续性、数据出口、AI 辅助和发布成熟度。

最值得坚持的是“来源原生、本地、可审计采集”。最应该避免的是把它改造成统一 feed 阅读器或通用 AI 聊天壳。只要插件目录和长期信息管理能力补起来，Infolens 可以占据一个比普通 RSS 阅读器更窄、但也更难被替代的位置。

<!---->
目前只有四个来源，插件生态尚未形成。
  - 没有全局搜索、收藏、标签、稍后读、批量已读和跨来源规则。
  - 缺少备份恢复、数据导出、API、Webhook 和跨设备同步。
  - 应用关闭后不再刷新，无法形成持续的信息收集服务。
  - Plugin 默认拥有较高信任，当前完整性机制还不是面向第三方生态的权限沙箱。
  - 当前列表会删除下榜条目，完整快照却持续保存且没有历史入口或清理策略。
  - 仅发布 Windows x64 便携目录，缺少安装器、升级机制、根 README、许可证和正式版本体系。
  - 与成熟产品相比，AI、摘要、翻译、变化分析等“Lens”能力仍为空白。

  产品路线不应直接复制 Folo 的统一时间线，也不应先加通用 AI 聊天框。更合理的优先顺序是：

  1. 扩充真正需要登录态或来源原生结构的高价值 Plugin。
  2. 增加备份、导出、历史保留策略、全局未读和最小跨插件搜索。
  3. 建立用户可理解的 Plugin 权限与信任说明。
  4. 再利用 Collection Snapshot 做榜单变化解释、跨来源信号和每日摘要。
  5. 完善安装、升级、许可证和跨平台发布。
