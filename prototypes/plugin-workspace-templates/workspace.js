/*
 * PROTOTYPE — Plugin Workspace Templates
 * Question: which three Workspace structures should developers start from?
 * Switch with ?variant=ledger|board|reader and ?state=ready|loading|empty|refreshing|failed|stale.
 * The fixture below stands in for a Plugin API summary; no production data or business logic lives here.
 */

const VARIANTS = ["ledger", "board", "reader"];
const STATES = ["ready", "loading", "empty", "refreshing", "failed", "stale"];
const root = document.querySelector("#app");

const variantMeta = {
  ledger: {
    label: "Signal Ledger",
    short: "密集扫描",
    structure: "Workbench",
    description: "把来源快照压成一条可筛选、可标记的扫描路径。",
    action: "扫描与分诊",
  },
  board: {
    label: "Source Board",
    short: "发现对比",
    structure: "Bento Grid",
    description: "用不等尺寸的内容块组织发现、对比和下一步动作。",
    action: "对比信号",
  },
  reader: {
    label: "Reading Desk",
    short: "深度阅读",
    structure: "Long Document",
    description: "把来源列表和单条内容放进一张连续、可导出的阅读桌。",
    action: "阅读与导出",
  },
};

const fixture = {
  pluginId: "plugin-template-fixture",
  source: "Hacker News",
  collection: "Top stories",
  collectedAt: "示例快照 · 接入后替换为 /summary",
  dependencyState: "connected",
  settings: { policy: "manual", interval: "—" },
  items: [
    {
      id: "signal-01",
      rank: 1,
      title: "The small interface is the product",
      summary: "A short source summary belongs here. Keep it close to the action it explains.",
      domain: "news.ycombinator.com",
      category: "design",
      metricLabel: "points",
      metricValue: "—",
      secondaryLabel: "comments",
      secondaryValue: "—",
      read: false,
    },
    {
      id: "signal-02",
      rank: 2,
      title: "A field guide to durable local software",
      summary: "Use this slot for the source excerpt, a normalized description, or a short note.",
      domain: "example.source",
      category: "systems",
      metricLabel: "signal",
      metricValue: "—",
      secondaryLabel: "age",
      secondaryValue: "—",
      read: false,
    },
    {
      id: "signal-03",
      rank: 3,
      title: "What changes when the cache is yours",
      summary: "The template does not decide which fields matter. Map them into the view model.",
      domain: "example.source",
      category: "infrastructure",
      metricLabel: "field",
      metricValue: "to map",
      secondaryLabel: "read",
      secondaryValue: "no",
      read: true,
    },
    {
      id: "signal-04",
      rank: 4,
      title: "Notes on building a quiet command surface",
      summary: "A long title tests wrapping, density, and the mobile collapse behavior.",
      domain: "example.source",
      category: "tools",
      metricLabel: "source",
      metricValue: "linked",
      secondaryLabel: "read",
      secondaryValue: "no",
      read: false,
    },
    {
      id: "signal-05",
      rank: 5,
      title: "The value of one decisive filter",
      summary: "Use filter slots for the source's real dimensions: period, language, status, or tag.",
      domain: "example.source",
      category: "workflow",
      metricLabel: "filter",
      metricValue: "ready",
      secondaryLabel: "read",
      secondaryValue: "yes",
      read: true,
    },
    {
      id: "signal-06",
      rank: 6,
      title: "A source snapshot should stay inspectable",
      summary: "History and export are extension points, not hidden host behavior.",
      domain: "example.source",
      category: "history",
      metricLabel: "snapshot",
      metricValue: "available",
      secondaryLabel: "read",
      secondaryValue: "no",
      read: false,
    },
  ],
};

let activeVariant = readParam("variant", VARIANTS.includes) ? readParam("variant") : "ledger";
let activeState = readParam("state", STATES.includes) ? readParam("state") : "ready";
const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true;
let activeTheme = readParam("theme", (value) => value === "dark" || value === "light") || (prefersDark ? "dark" : "light");
let activeFilter = "all";
let selectedId = fixture.items[0].id;
let historyOpen = false;
let notice = "示例数据 · 接入后替换为插件 API";
let refreshTimer;

const items = fixture.items.map((item) => ({ ...item }));

function readParam(name, predicate) {
  const value = new URLSearchParams(window.location.search).get(name);
  if (!value) return undefined;
  if (typeof predicate === "function" && !predicate(value)) return undefined;
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setUrl(updates) {
  const url = new URL(window.location.href);
  Object.entries(updates).forEach(([key, value]) => {
    if (value === undefined || value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  });
  window.history.replaceState({}, "", url);
}

function filteredItems() {
  if (activeFilter === "unread") return items.filter((item) => !item.read);
  if (activeFilter === "design") return items.filter((item) => item.category === "design");
  return items;
}

function currentItem() {
  return items.find((item) => item.id === selectedId) ?? items[0];
}

function stateLabel(state) {
  return {
    ready: "就绪",
    loading: "加载中",
    empty: "空",
    refreshing: "刷新中",
    failed: "失败",
    stale: "旧快照",
  }[state] ?? state;
}

function stateBanner() {
  if (activeState === "failed") {
    return `<div class="status-banner status-banner--error" role="alert">
      <div><strong>插件 API 不可用。</strong>仍可观看上次成功快照。</div>
      <button class="button button--quiet" data-action="retry" type="button">重试</button>
    </div>`;
  }
  if (activeState === "stale") {
    return `<div class="status-banner status-banner--warning" role="status">
      <div><strong>正在显示上次成功快照。</strong>来源可达时请刷新。</div>
      <button class="button button--quiet" data-action="refresh" type="button">刷新</button>
    </div>`;
  }
  if (activeState === "refreshing") {
    return `<div class="status-banner status-banner--info" role="status" aria-live="polite">
      <div><strong>正在刷新集合。</strong>现有内容保持可用。</div>
      <span class="status-progress" aria-hidden="true"></span>
    </div>`;
  }
  return "";
}

function pageHeader() {
  const meta = variantMeta[activeVariant];
  return `<header class="workspace-header">
    <div class="header-inner">
      <div class="brand-lockup">
        <span class="source-mark" aria-hidden="true">IN</span>
        <div class="brand-copy">
          <strong>插件工作区模板</strong>
          <span>三个面向信息源的起点结构</span>
        </div>
      </div>
      <div class="header-actions">
        <label class="state-control">
          <span>状态</span>
          <select data-action="state" aria-label="Prototype state">
            ${STATES.map((state) => `<option value="${state}" ${state === activeState ? "selected" : ""}>${stateLabel(state)}</option>`).join("")}
          </select>
        </label>
        <button class="button button--quiet" data-action="theme" type="button">${activeTheme === "dark" ? "浅色" : "深色"}主题</button>
      </div>
    </div>
  </header>`;
}

function intro() {
  const meta = variantMeta[activeVariant];
  return `<section class="intro-row">
    <div>
      <p class="prototype-label">原型 · ${escapeHtml(meta.structure)}</p>
      <h1>${escapeHtml(meta.label)}</h1>
      <p class="intro-copy">${escapeHtml(meta.description)}</p>
    </div>
    <div class="intro-aside">
      <div class="view-model-note">
        <span class="note-label">视图模型</span>
        <strong>${escapeHtml(fixture.source)} · ${escapeHtml(fixture.collection)}</strong>
        <span>${escapeHtml(fixture.collectedAt)}</span>
      </div>
      <div class="intro-actions">
        <button class="button button--primary" data-action="refresh" type="button" ${activeState === "refreshing" ? "disabled" : ""}>刷新</button>
        <button class="button button--secondary" data-action="export" type="button">导出</button>
      </div>
    </div>
  </section>`;
}

function filterRail() {
  return `<aside class="filter-rail surface">
    <div class="rail-section">
      <span class="rail-label">视图</span>
      <div class="filter-list" role="group" aria-label="View filters">
        ${filterButton("all", "全部信号")}
        ${filterButton("unread", "仅未读")}
        ${filterButton("design", "设计")}
      </div>
    </div>
    <div class="rail-section rail-section--lower">
      <span class="rail-label">扩展点</span>
      <p class="rail-copy">Replace these filters with the source's real dimensions: period, language, status, or tag.</p>
      <button class="text-button" data-action="settings" type="button">打开设置 <span aria-hidden="true">→</span></button>
    </div>
  </aside>`;
}

function filterButton(value, label) {
  return `<button class="filter-button ${activeFilter === value ? "is-active" : ""}" data-action="filter" data-filter="${value}" type="button" aria-pressed="${activeFilter === value}">${label}</button>`;
}

function itemMeta(item) {
  return `<div class="item-meta">
    <span>${escapeHtml(item.domain)}</span>
    <span>${escapeHtml(item.category)}</span>
    <span>${item.read ? "已读" : "未读"}</span>
  </div>`;
}

function rowActions(item) {
  return `<div class="row-actions">
    <span class="field-value"><small>${escapeHtml(item.metricLabel)}</small>${escapeHtml(item.metricValue)}</span>
    <button class="text-button" data-action="read" data-id="${item.id}" type="button">${item.read ? "重新打开" : "标记已读"}</button>
  </div>`;
}

function renderLedger() {
  const list = filteredItems();
  return `<section class="ledger-layout">
    ${filterRail()}
    <div class="ledger-main">
      <div class="section-head">
        <div>
          <h2>${escapeHtml(fixture.collection)}</h2>
          <p>${list.length} 行视图模型 · 主动作：${escapeHtml(variantMeta.ledger.action)}</p>
        </div>
        <span class="density-note">默认密集</span>
      </div>
      <div class="ledger-list" aria-live="polite">
        ${list.length ? list.map((item) => `<article class="ledger-row ${item.read ? "is-read" : ""}">
          <span class="rank" aria-label="Rank ${item.rank}">${String(item.rank).padStart(2, "0")}</span>
          <div class="row-content">
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.summary)}</p>
            ${itemMeta(item)}
          </div>
          ${rowActions(item)}
        </article>`).join("") : emptyState()}
      </div>
    </div>
  </section>`;
}

function boardCard(item, size) {
  return `<article class="board-card board-card--${size} ${item.read ? "is-read" : ""}">
    <div class="card-topline"><span>${String(item.rank).padStart(2, "0")}</span><span>${escapeHtml(item.category)}</span></div>
    <h2>${escapeHtml(item.title)}</h2>
    <p>${escapeHtml(item.summary)}</p>
    <div class="card-footer">
      <span>${escapeHtml(item.domain)}</span>
      <button class="text-button" data-action="open" data-id="${item.id}" type="button">打开来源 <span aria-hidden="true">↗</span></button>
    </div>
  </article>`;
}

function renderBoard() {
  const list = filteredItems();
  return `<section class="board-layout">
    <aside class="board-rail surface">
      <div class="rail-section">
        <span class="rail-label">来源地图</span>
        <h2>${escapeHtml(fixture.source)}</h2>
        <p class="rail-copy">One source, several entry points. Let the plugin decide the grouping.</p>
      </div>
      <div class="board-index">
        ${list.slice(0, 4).map((item) => `<button class="index-row" data-action="select" data-id="${item.id}" type="button"><span>${String(item.rank).padStart(2, "0")}</span><strong>${escapeHtml(item.category)}</strong></button>`).join("")}
      </div>
      <button class="text-button" data-action="history" type="button">${historyOpen ? "关闭历史" : "浏览历史"} <span aria-hidden="true">→</span></button>
    </aside>
    <div class="board-main">
      <div class="section-head section-head--board">
        <div>
          <h2>找到信号的形状。</h2>
          <p>Irregular spans make the important item visible before the user reads every card.</p>
        </div>
        <span class="density-note">非对称入口</span>
      </div>
      <div class="board-grid">
        ${list.length ? list.slice(0, 6).map((item, index) => boardCard(item, ["lead", "tall", "wide", "small", "small", "wide"][index] ?? "small")).join("") : emptyState()}
      </div>
      ${historyOpen ? historyPanel() : ""}
    </div>
  </section>`;
}

function renderReader() {
  const item = currentItem();
  return `<section class="reader-layout">
    <aside class="reader-rail surface">
      <div class="reader-rail-head">
        <span class="rail-label">来源列表</span>
        <strong>${escapeHtml(fixture.collection)}</strong>
      </div>
      <div class="reader-list">
        ${items.map((entry) => `<button class="reader-list-item ${entry.id === item.id ? "is-selected" : ""}" data-action="select" data-id="${entry.id}" type="button">
          <span class="reader-rank">${String(entry.rank).padStart(2, "0")}</span>
          <span><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.category)} · ${entry.read ? "已读" : "未读"}</small></span>
        </button>`).join("")}
      </div>
    </aside>
    <article class="reader-content">
      <p class="reader-kicker">${escapeHtml(item.domain)} · 第 ${String(item.rank).padStart(2, "0")} 条</p>
      <h2>${escapeHtml(item.title)}</h2>
      <p class="reader-lede">${escapeHtml(item.summary)}</p>
      <div class="reader-rule" aria-hidden="true"></div>
      <p class="reader-body">This is the reading surface. The Plugin supplies the source content, the fields below, and the export route. The template supplies measure, hierarchy, and a quiet place for the user to stay with one item.</p>
      <dl class="field-grid">
        <div><dt>category</dt><dd>${escapeHtml(item.category)}</dd></div>
        <div><dt>${escapeHtml(item.metricLabel)}</dt><dd>${escapeHtml(item.metricValue)}</dd></div>
        <div><dt>${escapeHtml(item.secondaryLabel)}</dt><dd>${escapeHtml(item.secondaryValue)}</dd></div>
      </dl>
      <div class="reader-actions">
        <button class="button button--primary" data-action="read" data-id="${item.id}" type="button">${item.read ? "标记未读" : "标记已读"}</button>
        <button class="button button--secondary" data-action="open" data-id="${item.id}" type="button">打开来源</button>
        <button class="text-button" data-action="history" type="button">${historyOpen ? "关闭历史" : "历史"}</button>
      </div>
      ${historyOpen ? historyPanel() : ""}
    </article>
  </section>`;
}

function historyPanel() {
  return `<aside class="history-panel" aria-label="History slot">
    <div><span class="rail-label">历史插槽</span><strong>快照列表由插件提供。</strong></div>
    <p>Render `/history` here, keep the selection local, and use `/history/snapshot` for the detail view.</p>
    <button class="text-button" data-action="export" type="button">导出快照 <span aria-hidden="true">→</span></button>
  </aside>`;
}

function emptyState() {
  return `<div class="state-panel state-panel--empty">
    <span class="state-mark">—</span>
    <h2>还没有集合快照。</h2>
    <p>空状态要具体：告诉用户缺什么，并给出一个直接动作。</p>
    <button class="button button--primary" data-action="load" type="button">加载示例数据</button>
  </div>`;
}

function loadingState() {
  return `<div class="state-panel state-panel--loading" aria-live="polite">
    <span class="skeleton skeleton--label"></span>
    <span class="skeleton skeleton--title"></span>
    <span class="skeleton skeleton--line"></span>
    <span class="skeleton skeleton--line skeleton--short"></span>
    <span class="loading-caption">正在读取插件 API…</span>
  </div>`;
}

function bodyContent() {
  if (activeState === "loading") return loadingState();
  if (activeState === "empty") return emptyState();
  if (activeVariant === "board") return renderBoard();
  if (activeVariant === "reader") return renderReader();
  return renderLedger();
}

function switcher() {
  const meta = variantMeta[activeVariant];
  return `<nav class="prototype-switcher" aria-label="Prototype variants">
    <button class="switcher-arrow" data-action="previous" type="button" aria-label="Previous variant">←</button>
    <span class="switcher-label"><strong>${escapeHtml(meta.label)}</strong><small>${escapeHtml(meta.short)} · ${escapeHtml(meta.structure)}</small></span>
    <button class="switcher-arrow" data-action="next" type="button" aria-label="Next variant">→</button>
  </nav>`;
}

function render() {
  document.documentElement.dataset.theme = activeTheme;
  const meta = variantMeta[activeVariant];
  document.title = `${meta.label} · Plugin Workspace Templates`;
  root.innerHTML = `<div class="prototype-shell">
    ${pageHeader()}
    <main class="workspace-main">
      ${stateBanner()}
      ${intro()}
      <div class="prototype-status" role="status" aria-live="polite"><span class="state-dot state-dot--${activeState}"></span><span>原型状态：<strong>${stateLabel(activeState)}</strong></span><span class="status-divider">·</span><span>${escapeHtml(notice)}</span></div>
      ${bodyContent()}
    </main>
    ${switcher()}
  </div>`;
}

function updateState(nextState) {
  if (!STATES.includes(nextState)) return;
  activeState = nextState;
  setUrl({ state: activeState });
  notice = nextState === "ready" ? "示例数据 · 接入后替换为插件 API" : `示例状态 · ${stateLabel(nextState)}`;
  render();
}

function simulateRefresh() {
  if (refreshTimer) return;
  activeState = "refreshing";
  setUrl({ state: activeState });
  notice = "刷新任务已排队 · 保留现有快照";
  render();
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    activeState = "ready";
    setUrl({ state: activeState });
    notice = "刷新完成 · 静默成功";
    render();
  }, 900);
}

function toggleRead(id) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  item.read = !item.read;
  selectedId = id;
  notice = item.read ? "已标记已读 · 无确认提示" : "已重新打开";
  render();
}

function cycleVariant(direction) {
  const index = VARIANTS.indexOf(activeVariant);
  activeVariant = VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length];
  historyOpen = false;
  setUrl({ variant: activeVariant });
  notice = "模板已切换 · 对比各自主动作";
  render();
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "previous") return cycleVariant(-1);
  if (action === "next") return cycleVariant(1);
  if (action === "theme") {
    activeTheme = activeTheme === "dark" ? "light" : "dark";
    setUrl({ theme: activeTheme });
    notice = "主题已更新 · 与宿主外观联动";
    return render();
  }
  if (action === "refresh" || action === "retry") return simulateRefresh();
  if (action === "load") return updateState("ready");
  if (action === "read") return toggleRead(target.dataset.id);
  if (action === "select") {
    selectedId = target.dataset.id;
    notice = "选择已变更 · 详情仍由插件持有";
    return render();
  }
  if (action === "filter") {
    activeFilter = target.dataset.filter ?? "all";
    notice = `筛选插槽 · ${activeFilter}`;
    return render();
  }
  if (action === "history") {
    historyOpen = !historyOpen;
    notice = historyOpen ? "历史插槽已打开" : "历史插槽已关闭";
    return render();
  }
  if (action === "export") {
    notice = "导出插槽 · 在此调用 downloadExport('/export?format=markdown')";
    return render();
  }
  if (action === "settings") {
    notice = "设置插槽 · 在此接入宿主提供的刷新控件";
    return render();
  }
  if (action === "open") {
    notice = "来源动作 · 替换为插件的来源地址";
    return render();
  }
});

root.addEventListener("change", (event) => {
  if (event.target.matches('[data-action="state"]')) updateState(event.target.value);
});

window.addEventListener("keydown", (event) => {
  const tagName = document.activeElement?.tagName?.toLowerCase();
  if (["input", "textarea", "select"].includes(tagName) || document.activeElement?.isContentEditable) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    cycleVariant(-1);
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    cycleVariant(1);
  }
});

window.addEventListener("popstate", () => {
  activeVariant = readParam("variant", VARIANTS.includes) || "ledger";
  activeState = readParam("state", STATES.includes) || "ready";
  activeTheme = readParam("theme", (value) => value === "dark" || value === "light") || "light";
  render();
});

render();
