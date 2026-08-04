import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeRefreshOutcome, shortRefreshMessage } from "./refresh-outcome.mjs";
import { normalizeRefreshInput, sanitizeRefreshOptions } from "./refresh-options.mjs";

export const BATCH_ITEM_STATES = Object.freeze(["queued", "running", "succeeded", "failed", "skipped", "interrupted"]);
export const BATCH_TERMINAL_STATES = Object.freeze(["succeeded", "partial", "failed", "skipped", "interrupted"]);
const BATCH_NONTERMINAL_STATES = new Set(["queued", "running"]);

const MAX_HISTORY = 5;

function clone(value) {
  return structuredClone(value);
}

function nowIso(clock) {
  return clock().toISOString();
}

function safeText(value, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text.length > 240 ? `${text.slice(0, 239)}...` : text;
}

function safeTarget(target, pluginId) {
  const refreshOptions = sanitizeRefreshOptions(target?.refreshOptions);
  return {
    pluginId,
    targetId: typeof target?.targetId === "string" ? target.targetId : pluginId,
    name: safeText(target?.name, pluginId),
    version: safeText(target?.version),
    state: safeText(target?.state, "unavailable"),
    enabled: target?.enabled === true,
    eligible: target?.eligible === true,
    ...(target?.reason ? { reason: safeText(target.reason) } : {}),
    browserDependent: target?.browserDependent === true,
    ...(target?.dependencyState ? { dependencyState: safeText(target.dependencyState) } : {}),
    ...(target?.dependencyWarning ? { dependencyWarning: true } : {}),
    ...(refreshOptions ? { refreshOptions } : {}),
    ...(typeof target?.lastSuccessfulRefreshAt === "string" ? { lastSuccessfulRefreshAt: target.lastSuccessfulRefreshAt } : {}),
    ...(target?.failure ? { failure: clone(target.failure) } : {}),
  };
}

function safeItem(item) {
  return {
    pluginId: item.pluginId,
    targetId: item.targetId,
    name: item.name,
    version: item.version,
    state: BATCH_ITEM_STATES.includes(item.state) ? item.state : "interrupted",
    ...(item.reason ? { reason: safeText(item.reason) } : {}),
    ...(item.operationId ? { operationId: String(item.operationId) } : {}),
    ...(item.batchId ? { batchId: String(item.batchId) } : {}),
    ...(item.coalesced ? { coalesced: true } : {}),
    ...(item.refreshInput ? { refreshInput: clone(item.refreshInput) } : {}),
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.completedAt ? { completedAt: item.completedAt } : {}),
    ...(item.outcome ? { outcome: clone(item.outcome) } : {}),
  };
}

function counts(items) {
  const value = Object.fromEntries(BATCH_ITEM_STATES.map((state) => [state, 0]));
  for (const item of items) value[item.state] = (value[item.state] ?? 0) + 1;
  return {
    total: items.length,
    ...value,
    remaining: items.filter((item) => !["succeeded", "failed", "skipped", "interrupted"].includes(item.state)).length,
  };
}

function statusFor(items) {
  const current = counts(items);
  if (current.interrupted && current.remaining === 0 && !current.succeeded && !current.failed && !current.skipped) return "interrupted";
  if (!current.succeeded && !current.failed && !current.interrupted) return "skipped";
  if (current.failed || current.skipped || current.interrupted) return current.succeeded ? "partial" : current.interrupted ? "interrupted" : "failed";
  return "succeeded";
}

function cleanBatch(value) {
  if (!value || typeof value !== "object" || typeof value.batchId !== "string" || !Array.isArray(value.items)) return undefined;
  const items = value.items.filter((item) => item && typeof item.pluginId === "string").map(safeItem);
  const status = [...BATCH_TERMINAL_STATES, ...BATCH_NONTERMINAL_STATES].includes(value.status) ? value.status : "interrupted";
  return {
    batchId: value.batchId,
    ...(value.parentBatchId ? { parentBatchId: String(value.parentBatchId) } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    status,
    state: status,
    targets: Array.isArray(value.targets) ? value.targets.filter((target) => target && typeof target.pluginId === "string").map((target) => safeTarget(target, target.pluginId)) : [],
    items,
    counts: counts(items),
  };
}

export class BatchManager {
  constructor({ getTarget, enqueueTarget, onEvent = () => {}, statePath, sessionId, clock = () => new Date(), maxHistory = MAX_HISTORY }) {
    this.getTarget = getTarget;
    this.enqueueTarget = enqueueTarget;
    this.onEvent = onEvent;
    this.statePath = statePath;
    this.sessionId = sessionId;
    this.clock = clock;
    this.maxHistory = maxHistory;
    this.records = [];
    this.activeBatchId = undefined;
    this.createLock = Promise.resolve();
    this.writes = Promise.resolve();
    this.stopping = false;
  }

  async load() {
    if (!this.statePath) return;
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8"));
      if (this.sessionId && state.sessionId && state.sessionId !== this.sessionId) return;
      this.records = Array.isArray(state.batches) ? state.batches.map(cleanBatch).filter(Boolean).slice(-this.maxHistory) : [];
      const active = this.records.find((batch) => !BATCH_TERMINAL_STATES.includes(batch.status));
      if (active) {
        const interruptedItems = [];
        for (const item of active.items) {
          const details = this.interruptItem(active, item, {
            code: "RUNTIME_RESTARTED",
            reason: "Plugin Runtime restarted before the item completed",
            completedAt: nowIso(this.clock),
          });
          if (details) interruptedItems.push(details);
        }
        active.status = "interrupted";
        active.state = "interrupted";
        active.completedAt = nowIso(this.clock);
        active.counts = counts(active.items);
        for (const details of interruptedItems) this.emit("target-interrupted", active, details);
        this.emit("interrupted", active, { reason: "RUNTIME_RESTARTED" });
      }
      this.activeBatchId = undefined;
      await this.persist();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  list() {
    return clone(this.records).reverse();
  }

  get(batchId) {
    const batch = this.records.find((entry) => entry.batchId === String(batchId));
    return batch ? clone(batch) : undefined;
  }

  active() {
    const batch = this.records.find((entry) => entry.batchId === this.activeBatchId);
    return batch && !BATCH_TERMINAL_STATES.includes(batch.status) ? clone(batch) : undefined;
  }

  async create(selections, { parentBatchId } = {}) {
    const previousCreate = this.createLock;
    let releaseCreate;
    this.createLock = new Promise((resolve) => { releaseCreate = resolve; });
    await previousCreate;
    try {
      if (this.stopping) throw Object.assign(new Error("Plugin Runtime is stopping"), { code: "RUNTIME_STOPPING" });
      const active = this.records.find((entry) => entry.batchId === this.activeBatchId && !BATCH_TERMINAL_STATES.includes(entry.status));
      if (active) return { batch: clone(active), reused: true };
      if (!Array.isArray(selections) || !selections.length) throw Object.assign(new Error("Select at least one Plugin Workspace"), { code: "BATCH_NO_TARGETS" });
      const normalizedSelections = selections.map((selection) => {
        if (typeof selection === "string") return { pluginId: selection.trim() };
        if (!selection || typeof selection !== "object" || typeof selection.pluginId !== "string") return undefined;
        return { pluginId: selection.pluginId.trim(), refreshInput: selection.refreshInput };
      }).filter((selection) => selection?.pluginId);
      const uniqueSelections = [...new Map(normalizedSelections.map((selection) => [selection.pluginId, selection])).values()];
      if (!uniqueSelections.length) throw Object.assign(new Error("Select at least one Plugin Workspace"), { code: "BATCH_NO_TARGETS" });
      const selectionByPlugin = new Map(uniqueSelections.map((selection) => [selection.pluginId, selection]));
      const targets = await Promise.all(uniqueSelections.map(async ({ pluginId }) => safeTarget(await this.getTarget(pluginId), pluginId)));
      const items = targets.map((target) => {
        const refreshInput = normalizeRefreshInput(target.refreshOptions, selectionByPlugin.get(target.pluginId)?.refreshInput);
        return {
          batchId: undefined,
          pluginId: target.pluginId,
          targetId: target.targetId,
          name: target.name,
          version: target.version,
          state: "queued",
          ...(refreshInput ? { refreshInput } : {}),
        };
      });
      const batch = {
        batchId: randomUUID(),
        ...(parentBatchId ? { parentBatchId: String(parentBatchId) } : {}),
        createdAt: nowIso(this.clock),
        status: "queued",
        state: "queued",
        targets,
        items,
        counts: counts(targets.map((target) => ({ ...target, state: "queued" }))),
      };
      batch.items.forEach((item) => { item.batchId = batch.batchId; });
      this.records.push(batch);
      this.records = this.records.slice(-this.maxHistory);
      this.activeBatchId = batch.batchId;
      this.emit("started", batch, { targetCount: targets.length });
      await this.persist();
      void this.execute(batch);
      return { batch: clone(batch), reused: false };
    } finally {
      releaseCreate();
    }
  }

  async retry(batchId) {
    const original = this.records.find((entry) => entry.batchId === String(batchId));
    if (!original) throw Object.assign(new Error("Batch not found"), { code: "BATCH_NOT_FOUND" });
    if (!BATCH_TERMINAL_STATES.includes(original.status)) throw Object.assign(new Error("Only a completed Batch can be retried"), { code: "BATCH_ACTIVE" });
    const failed = original.items.filter((item) => item.state === "failed").map((item) => ({ pluginId: item.pluginId, refreshInput: item.refreshInput }));
    if (!failed.length) throw Object.assign(new Error("Batch has no failed targets"), { code: "BATCH_NO_FAILED_TARGETS" });
    return this.create(failed, { parentBatchId: original.batchId });
  }

  interruptItem(batch, item, { code, reason, completedAt }) {
    if (["succeeded", "failed", "skipped", "interrupted"].includes(item.state)) return undefined;
    item.state = "interrupted";
    item.reason = safeText(reason, "Plugin refresh was interrupted");
    item.completedAt = completedAt;
    item.outcome = normalizeRefreshOutcome(undefined, {
      completedAt,
      error: Object.assign(new Error(item.reason), { code: code ?? "BATCH_INTERRUPTED", outcome: "uncertain" }),
    });
    return {
      pluginId: item.pluginId,
      ...(item.operationId ? { operationId: item.operationId } : {}),
      code: item.outcome.code,
      reason: item.reason,
    };
  }

  onTaskEvent(pluginId, type, details = {}) {
    const batchId = details.batchId;
    const operationId = details.operationId;
    for (const batch of this.records) {
      if (batchId && batch.batchId !== batchId) continue;
      const item = batch.items.find((entry) => entry.pluginId === pluginId && (
        (batchId && batch.batchId === batchId && (!entry.operationId || !operationId || entry.operationId === operationId))
        || (!batchId && operationId && entry.operationId === operationId)
      ));
      if (!item) continue;
      if (operationId && !item.operationId) item.operationId = operationId;
      if (type === "task-started" && item.state === "queued") {
        item.state = "running";
        item.startedAt = item.startedAt ?? nowIso(this.clock);
        this.touch(batch);
      }
      if (type === "task-coalesced") {
        item.coalesced = true;
        if (item.state === "queued") item.state = "running";
        this.touch(batch);
      }
    }
  }

  async interruptActive(reason = "RUNTIME_RESTARTED") {
    this.stopping = true;
    const batch = this.records.find((entry) => entry.batchId === this.activeBatchId && !BATCH_TERMINAL_STATES.includes(entry.status));
    if (!batch) return;
    const completedAt = nowIso(this.clock);
    const interruptedItems = [];
    for (const item of batch.items) {
      const details = this.interruptItem(batch, item, {
        code: reason,
        reason: reason === "APPLICATION_EXIT" ? "Application Session ended before the item completed" : "Plugin Runtime restarted before the item completed",
        completedAt,
      });
      if (details) interruptedItems.push(details);
    }
    batch.status = "interrupted";
    batch.state = "interrupted";
    batch.completedAt = completedAt;
    batch.counts = counts(batch.items);
    this.activeBatchId = undefined;
    for (const details of interruptedItems) this.emit("target-interrupted", batch, details);
    this.emit("interrupted", batch, { reason });
    await this.persist();
  }

  async execute(batch) {
    this.setStatus(batch, "running");
    this.emit("running", batch);
    await this.persist();
    const jobs = [];
    for (const item of batch.items) {
      if (this.stopping || batch.status === "interrupted") break;
      const target = await this.getTarget(item.pluginId);
      if (this.stopping || batch.status === "interrupted") break;
      if (!target?.eligible) {
        this.skip(batch, item, target?.reason ?? "Plugin Workspace is no longer executable");
        continue;
      }
      if (target.targetId && item.targetId && target.targetId !== item.targetId) {
        this.skip(batch, item, "Plugin Workspace changed since this Batch was selected");
        continue;
      }
      item.state = "queued";
      item.startedAt = undefined;
      this.touch(batch);
      try {
        const execution = await this.enqueueTarget(item.pluginId, { batchId: batch.batchId, refreshInput: item.refreshInput });
        item.operationId = execution.operationId;
        item.coalesced = Boolean(execution.coalesced);
        if (item.coalesced && item.state === "queued") item.state = "running";
        this.emit(execution.coalesced ? "coalesced" : "submitted", batch, { pluginId: item.pluginId, operationId: item.operationId, ...(execution.coalesced ? { coalesced: true } : {}) });
        jobs.push(this.follow(batch, item, execution.promise));
      } catch (error) {
        this.fail(batch, item, normalizeRefreshOutcome(undefined, { error }), "BATCH_ENQUEUE_FAILED");
      }
    }
    await Promise.allSettled(jobs);
    if (batch.status === "interrupted" || this.stopping) return;
    this.setStatus(batch, statusFor(batch.items));
    batch.completedAt = nowIso(this.clock);
    batch.counts = counts(batch.items);
    if (this.activeBatchId === batch.batchId) this.activeBatchId = undefined;
    this.emit("completed", batch, { status: batch.status, counts: batch.counts });
    await this.persist();
  }

  async follow(batch, item, promise) {
    try {
      const result = await promise;
      if (batch.status === "interrupted" || item.state === "interrupted") return;
      const outcome = normalizeRefreshOutcome(result);
      if (outcome.status === "succeeded") {
        item.state = "succeeded";
        item.outcome = outcome;
        item.completedAt = nowIso(this.clock);
        this.emit("target-completed", batch, { pluginId: item.pluginId, operationId: item.operationId, outcome: "succeeded" });
      } else if (outcome.status === "cancelled") {
        const details = this.interruptItem(batch, item, { code: outcome.code, reason: outcome.message, completedAt: nowIso(this.clock) });
        if (details) {
          item.outcome = outcome;
          this.emit("target-interrupted", batch, details);
        }
      } else {
        this.fail(batch, item, outcome);
      }
    } catch (error) {
      if (batch.status === "interrupted" || item.state === "interrupted") return;
      const outcome = normalizeRefreshOutcome(undefined, { error });
      if (outcome.status === "cancelled") {
        const details = this.interruptItem(batch, item, { code: outcome.code, reason: outcome.message, completedAt: nowIso(this.clock) });
        if (details) {
          item.outcome = outcome;
          this.emit("target-interrupted", batch, details);
        }
      } else this.fail(batch, item, outcome);
    }
    this.touch(batch);
  }

  skip(batch, item, reason) {
    item.state = "skipped";
    item.reason = safeText(reason, "Plugin Workspace is not executable");
    item.completedAt = nowIso(this.clock);
    item.outcome = { status: "skipped", code: "BATCH_TARGET_UNAVAILABLE", message: item.reason, timestamp: item.completedAt };
    this.touch(batch);
    this.emit("target-skipped", batch, { pluginId: item.pluginId, code: "BATCH_TARGET_UNAVAILABLE", reason: item.reason });
  }

  fail(batch, item, outcome, fallbackCode) {
    item.state = "failed";
    item.completedAt = nowIso(this.clock);
    item.outcome = {
      status: "failed",
      code: fallbackCode ?? outcome.code ?? "PLUGIN_ERROR",
      message: shortRefreshMessage(outcome.message),
      timestamp: outcome.timestamp ?? item.completedAt,
    };
    this.touch(batch);
    this.emit("target-failed", batch, { pluginId: item.pluginId, operationId: item.operationId, code: item.outcome.code, message: item.outcome.message });
  }

  setStatus(batch, status) {
    batch.status = status;
    batch.state = status;
    batch.counts = counts(batch.items);
    this.touch(batch);
  }

  touch(batch) {
    batch.counts = counts(batch.items);
    void this.persist();
  }

  emit(event, batch, details = {}) {
    void Promise.resolve(this.onEvent(event, { batchId: batch.batchId, ...details, status: batch.status, counts: counts(batch.items) })).catch(() => {});
  }

  async persist() {
    if (!this.statePath) return;
    const value = JSON.stringify({ version: 1, ...(this.sessionId ? { sessionId: this.sessionId } : {}), batches: this.records.map((batch) => ({ ...batch, targets: batch.targets?.map((target) => safeTarget(target, target.pluginId)) })) }, null, 2);
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${value}\n`, "utf8");
      try {
        await rename(temporary, this.statePath);
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
        await rm(this.statePath, { force: true });
        await rename(temporary, this.statePath);
      }
    });
    await this.writes;
  }

  async flush() {
    await this.writes;
  }
}
