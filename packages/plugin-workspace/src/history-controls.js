const historyStates = new WeakMap();

const copy = {
  "zh-CN": {
    history: "\u5386\u53f2",
    calendar: "\u5386\u53f2\u65e5\u5386",
    loading: "\u6b63\u5728\u8bfb\u53d6\u5feb\u7167...",
    empty: "\u5f53\u524d\u4fdd\u7559\u671f\u5185\u6ca1\u6709\u53ef\u7528\u5feb\u7167",
    unavailable: "\u5feb\u7167\u4e0d\u53ef\u7528",
    records: (count) => `${count} \u6761`,
    viewing: "\u6b63\u5728\u67e5\u770b\u5386\u53f2",
    latest: "\u8fd4\u56de\u6700\u65b0",
    newer: "\u8f83\u65b0\u7684\u5feb\u7167",
    older: "\u8f83\u65e9\u7684\u5feb\u7167",
    previousMonth: "\u4e0a\u4e2a\u6708",
    nextMonth: "\u4e0b\u4e2a\u6708",
    historyFailed: (message) => `\u65e0\u6cd5\u8bfb\u53d6\u5386\u53f2\uff1a${message}`,
    ok: "\u77e5\u9053\u4e86",
    close: "\u5173\u95ed",
  },
  en: {
    history: "History",
    calendar: "History calendar",
    loading: "Loading snapshots...",
    empty: "No snapshots are available in the current retention period",
    unavailable: "Snapshot unavailable",
    records: (count) => `${count} records`,
    viewing: "Viewing history",
    latest: "Return to latest",
    newer: "Newer snapshot",
    older: "Older snapshot",
    previousMonth: "Previous month",
    nextMonth: "Next month",
    historyFailed: (message) => `Unable to load history: ${message}`,
    ok: "OK",
    close: "Close",
  },
};

function icon(path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
}

function dateKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKey(date) {
  return date.getFullYear() * 12 + date.getMonth();
}

function ensureConfirmDialog(document) {
  let dialog = document.querySelector("#infolens-confirm-dialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "infolens-confirm-dialog";
  dialog.innerHTML = '<form method="dialog"><p class="confirm-message"></p><div class="confirm-actions"><button type="button" data-confirm-cancel></button><button type="submit" data-confirm-ok value="ok"></button></div></form>';
  dialog.querySelector("[data-confirm-cancel]").onclick = () => dialog.close("cancel");
  document.body.append(dialog);
  return dialog;
}

export async function confirmQuestion(message, okLabel = "\u7ee7\u7eed", cancelLabel = "\u53d6\u6d88") {
  const dialog = ensureConfirmDialog(document);
  dialog.querySelector(".confirm-message").textContent = message;
  dialog.querySelector("[data-confirm-ok]").textContent = okLabel;
  dialog.querySelector("[data-confirm-cancel]").textContent = cancelLabel;
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

function makeState(document) {
  const popover = document.createElement("section");
  popover.id = "collection-history-calendar";
  popover.className = "history-calendar";
  popover.setAttribute("popover", "auto");
  popover.setAttribute("aria-label", copy["zh-CN"].calendar);
  popover.innerHTML = `
    <header class="history-calendar-head">
      <button type="button" data-month-previous>${icon("m15 18-6-6 6-6")}</button>
      <strong data-month-label></strong>
      <button type="button" data-month-next>${icon("m9 18 6-6-6-6")}</button>
    </header>
    <div class="history-weekdays" aria-hidden="true"></div>
    <div class="history-calendar-grid" role="group"></div>
    <p class="history-calendar-status" role="status"></p>`;
  document.body.append(popover);
  const state = {
    document,
    popover,
    snapshots: [],
    selectedIndex: -1,
    cursor: new Date(),
    config: undefined,
    trigger: undefined,
    loading: false,
  };
  popover.addEventListener("toggle", (event) => {
    state.trigger?.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "closed" && popover.contains(document.activeElement)) state.trigger?.focus();
  });
  popover.querySelector(".history-calendar-grid").addEventListener("keydown", (event) => moveCalendarFocus(state, event));
  popover.querySelector("[data-month-previous]").onclick = () => changeMonth(state, -1);
  popover.querySelector("[data-month-next]").onclick = () => changeMonth(state, 1);
  return state;
}

function labels(state) {
  return copy[state.config?.locale === "en" ? "en" : "zh-CN"];
}

function renderCalendar(state) {
  const strings = labels(state);
  const { popover, cursor, snapshots } = state;
  const locale = state.config?.locale === "en" ? "en" : "zh-CN";
  popover.setAttribute("aria-label", strings.calendar);
  popover.querySelector("[data-month-label]").textContent = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(cursor);
  const weekdays = popover.querySelector(".history-weekdays");
  const weekStart = locale === "en" ? 0 : 1;
  weekdays.replaceChildren(...Array.from({ length: 7 }, (_, index) => {
    const day = state.document.createElement("span");
    const value = new Date(2026, 1, 1 + ((index + weekStart) % 7));
    day.textContent = new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(value);
    return day;
  }));

  const byDay = new Map();
  snapshots.forEach((snapshot, index) => {
    const key = dateKey(snapshot.collectedAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ snapshot, index });
  });
  const grid = popover.querySelector(".history-calendar-grid");
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const leading = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - leading);
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const entries = byDay.get(dateKey(day)) ?? [];
    const available = entries.find(({ snapshot }) => snapshot.available);
    const button = state.document.createElement("button");
    button.type = "button";
    button.className = "history-day";
    button.textContent = String(day.getDate());
    button.dataset.outsideMonth = String(day.getMonth() !== cursor.getMonth());
    button.setAttribute("aria-label", new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(day));
    if (entries.length) button.dataset.hasSnapshot = "true";
    if (entries.some(({ index: snapshotIndex }) => snapshotIndex === state.selectedIndex)) button.setAttribute("aria-current", "date");
    if (entries.length && !available) {
      button.dataset.unavailable = "true";
      button.disabled = true;
      button.title = strings.unavailable;
    } else if (available) {
      button.title = `${new Date(available.snapshot.collectedAt).toLocaleString(locale)} - ${strings.records(available.snapshot.recordCount)}`;
      button.onclick = () => selectSnapshot(state, available.index);
    } else {
      button.disabled = true;
    }
    cells.push(button);
  }
  grid.replaceChildren(...cells);

  const months = snapshots.map((snapshot) => monthKey(new Date(snapshot.collectedAt)));
  const current = monthKey(cursor);
  popover.querySelector("[data-month-previous]").disabled = !months.some((month) => month < current);
  popover.querySelector("[data-month-next]").disabled = !months.some((month) => month > current);
  if (!state.loading) popover.querySelector(".history-calendar-status").textContent = snapshots.length ? "" : strings.empty;
}

function changeMonth(state, delta) {
  state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + delta, 1);
  renderCalendar(state);
}

function moveCalendarFocus(state, event) {
  const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (!(event.key in steps)) return;
  const days = [...state.popover.querySelectorAll(".history-day")];
  let index = days.indexOf(state.document.activeElement);
  do index += steps[event.key]; while (days[index]?.disabled);
  if (!days[index]) return;
  event.preventDefault();
  days[index].focus();
}

async function loadSnapshots(state) {
  const result = [];
  let offset = 0;
  let total = 1;
  while (offset < total) {
    const response = await fetch(new URL(`history?limit=100&offset=${offset}`, state.config.api));
    if (!response.ok) throw new Error(`Plugin API returned ${response.status}`);
    const page = await response.json();
    result.push(...page.items);
    offset += page.items.length;
    total = page.total;
    if (!page.items.length) break;
  }
  state.snapshots = result;
  const firstAvailable = result.find((snapshot) => snapshot.available) ?? result[0];
  if (firstAvailable) {
    const date = new Date(firstAvailable.collectedAt);
    state.cursor = new Date(date.getFullYear(), date.getMonth(), 1);
  }
}

function positionPopover(state) {
  const rect = state.trigger.getBoundingClientRect();
  const view = state.document.defaultView;
  state.popover.style.setProperty("--history-anchor-top", `${Math.max(8, Math.min(rect.bottom + 8, view.innerHeight - 420))}px`);
  state.popover.style.setProperty("--history-anchor-right", `${Math.max(8, view.innerWidth - rect.right)}px`);
}

async function openCalendar(state) {
  if (state.loading) return;
  positionPopover(state);
  state.popover.showPopover();
  state.loading = true;
  state.trigger.disabled = true;
  state.trigger.setAttribute("aria-busy", "true");
  state.popover.querySelector(".history-calendar-status").textContent = labels(state).loading;
  try {
    await loadSnapshots(state);
    state.loading = false;
    renderCalendar(state);
    state.popover.querySelector('.history-day[data-has-snapshot="true"]:not(:disabled)')?.focus();
  } catch (error) {
    state.popover.querySelector(".history-calendar-status").textContent = labels(state).historyFailed(error.message);
  } finally {
    state.loading = false;
    state.trigger.disabled = false;
    state.trigger.removeAttribute("aria-busy");
  }
}

function syncHistoryBar(state) {
  state.document.querySelector(".history-view-bar")?.remove();
  if (state.selectedIndex < 0) return;
  const snapshot = state.snapshots[state.selectedIndex];
  const strings = labels(state);
  const locale = state.config.locale === "en" ? "en" : "zh-CN";
  const workspace = state.trigger?.closest(".workspace");
  const header = workspace?.querySelector(":scope > header");
  if (!workspace || !header) return;
  const bar = state.document.createElement("div");
  bar.className = "history-view-bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", strings.viewing);
  bar.innerHTML = `<div><strong>${strings.viewing}</strong><span></span></div><div class="history-view-actions"><button type="button" data-history-newer title="${strings.newer}" aria-label="${strings.newer}">${icon("m15 18-6-6 6-6")}</button><button type="button" data-history-older title="${strings.older}" aria-label="${strings.older}">${icon("m9 18 6-6-6-6")}</button><button type="button" class="history-latest">${strings.latest}</button></div>`;
  bar.querySelector("span").textContent = `${new Date(snapshot.collectedAt).toLocaleString(locale)} - ${strings.records(snapshot.recordCount)}`;
  const newer = bar.querySelector("[data-history-newer]");
  const older = bar.querySelector("[data-history-older]");
  const newerIndex = adjacentAvailableIndex(state, -1);
  const olderIndex = adjacentAvailableIndex(state, 1);
  newer.disabled = newerIndex < 0;
  older.disabled = olderIndex < 0;
  newer.onclick = () => selectSnapshot(state, newerIndex);
  older.onclick = () => selectSnapshot(state, olderIndex);
  bar.querySelector(".history-latest").onclick = () => clearSelection(state, true);
  header.after(bar);
}

function adjacentAvailableIndex(state, direction) {
  for (let index = state.selectedIndex + direction; index >= 0 && index < state.snapshots.length; index += direction) {
    if (state.snapshots[index].available) return index;
  }
  return -1;
}

async function selectSnapshot(state, index) {
  const snapshot = state.snapshots[index];
  if (!snapshot?.available) return;
  state.popover.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(new URL(`history/snapshot?id=${encodeURIComponent(snapshot.id)}`, state.config.api));
    if (!response.ok) throw new Error(`Plugin API returned ${response.status}`);
    const detail = await response.json();
    if (!detail.available) throw new Error(labels(state).unavailable);
    state.selectedIndex = index;
    await state.config.onSnapshot(detail, snapshot);
    syncHistoryBar(state);
    state.popover.hidePopover();
  } catch (error) {
    state.popover.querySelector(".history-calendar-status").textContent = labels(state).historyFailed(error.message);
  } finally {
    state.popover.removeAttribute("aria-busy");
  }
}

function clearSelection(state, notify) {
  state.selectedIndex = -1;
  state.document.querySelector(".history-view-bar")?.remove();
  if (notify) state.config.onCurrent();
}

export function installHistoryControls({ api, actions, onSnapshot, onCurrent, locale = "zh-CN" }) {
  if (!api || !actions || typeof onSnapshot !== "function" || typeof onCurrent !== "function") return undefined;
  const document = actions.ownerDocument;
  let state = historyStates.get(document);
  if (!state) {
    state = makeState(document);
    historyStates.set(document, state);
  }
  state.config = { api, actions, onSnapshot, onCurrent, locale };
  let history = actions.querySelector("[data-history-control=calendar]");
  if (!history) {
    const className = actions.firstElementChild?.classList.contains("icon") ? "icon" : "icon-button";
    const strings = labels(state);
    history = document.createElement("button");
    history.type = "button";
    history.dataset.historyControl = "calendar";
    history.className = className;
    history.title = strings.history;
    history.setAttribute("aria-label", strings.calendar);
    history.setAttribute("aria-expanded", "false");
    history.innerHTML = icon("M8 2v3m8-3v3M3 9h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Zm3 9h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01");
    history.onclick = () => openCalendar(state);
    actions.prepend(history);
  }
  state.trigger = history;
  syncHistoryBar(state);
  return {
    clear: ({ notify = false } = {}) => clearSelection(state, notify),
    isViewingHistory: () => state.selectedIndex >= 0,
  };
}
