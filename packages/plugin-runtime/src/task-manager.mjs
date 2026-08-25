import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "./redaction.mjs";

export class TaskCancelledError extends Error {
  constructor(message, outcome = "uncertain") {
    super(message);
    this.name = "TaskCancelledError";
    this.code = "TASK_CANCELLED";
    this.outcome = outcome;
  }
}

export class SharedTaskQueue {
  constructor({ publicLimit = 3, browserLimit = 1 } = {}) {
    this.limits = { PUBLIC: publicLimit, BROWSER: browserLimit };
    this.active = { PUBLIC: 0, BROWSER: 0 };
    this.activePlugins = new Set();
    this.queued = [];
    this.running = new Set();
    this.taskQueued = [];
    this.taskRunning = new Map();
    this.stopped = false;
  }

  submit({ pluginId, resource, run }) {
    if (this.stopped) return Promise.reject(new TaskCancelledError("Runtime task queue is stopped", "not-started"));
    if (!this.limits[resource]) return Promise.reject(new Error(`Unknown task resource '${resource}'`));
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    this.queued.push({ pluginId, resource, run, resolve: resolvePromise, reject: rejectPromise });
    this.drain();
    return promise;
  }

  submitTask({ pluginId, run }) {
    if (this.stopped) return Promise.reject(new TaskCancelledError("Runtime task queue is stopped", "not-started"));
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    this.taskQueued.push({ pluginId, run, resolve: resolvePromise, reject: rejectPromise });
    this.drainTasks();
    return promise;
  }

  withPermit({ pluginId, resource }, run) {
    return this.submit({ pluginId, resource, run });
  }

  cancelPlugin(pluginId) {
    const retained = [];
    for (const entry of this.queued) {
      if (entry.pluginId === pluginId) entry.reject(new TaskCancelledError(`Plugin '${pluginId}' queued task was cancelled`, "not-started"));
      else retained.push(entry);
    }
    this.queued = retained;
    for (const entry of this.running) if (entry.pluginId === pluginId) entry.controller.abort();
    const retainedTasks = [];
    for (const entry of this.taskQueued) {
      if (entry.pluginId === pluginId) entry.reject(new TaskCancelledError(`Plugin '${pluginId}' queued task was cancelled`, "not-started"));
      else retainedTasks.push(entry);
    }
    this.taskQueued = retainedTasks;
    this.taskRunning.get(pluginId)?.controller.abort();
  }

  stop() {
    this.stopped = true;
    for (const entry of this.queued) entry.reject(new TaskCancelledError("Runtime stopped before task started", "not-started"));
    this.queued = [];
    for (const entry of this.running) entry.controller.abort();
    for (const entry of this.taskQueued) entry.reject(new TaskCancelledError("Runtime stopped before task started", "not-started"));
    this.taskQueued = [];
    for (const entry of this.taskRunning.values()) entry.controller.abort();
  }

  snapshot() {
    return {
      queued: this.queued.map(({ pluginId, resource }) => ({ pluginId, resource })),
      active: { ...this.active },
      activePlugins: [...this.activePlugins],
      tasks: {
        queued: this.taskQueued.map(({ pluginId }) => ({ pluginId })),
        activePlugins: [...this.taskRunning.keys()],
      },
    };
  }

  drainTasks() {
    if (this.stopped) return;
    for (let index = 0; index < this.taskQueued.length;) {
      const entry = this.taskQueued[index];
      if (this.taskRunning.has(entry.pluginId)) { index += 1; continue; }
      this.taskQueued.splice(index, 1);
      this.startTask(entry);
    }
  }

  async startTask(entry) {
    entry.controller = new AbortController();
    this.taskRunning.set(entry.pluginId, entry);
    try {
      const result = await entry.run(entry.controller.signal);
      if (entry.controller.signal.aborted) throw new TaskCancelledError(`Plugin '${entry.pluginId}' active task was cancelled`);
      entry.resolve(result);
    } catch (error) {
      if (entry.controller.signal.aborted && error?.code !== "TASK_CANCELLED") entry.reject(new TaskCancelledError(`Plugin '${entry.pluginId}' active task was cancelled`));
      else entry.reject(error);
    } finally {
      this.taskRunning.delete(entry.pluginId);
      this.drainTasks();
    }
  }

  drain() {
    if (this.stopped) return;
    for (let index = 0; index < this.queued.length;) {
      const entry = this.queued[index];
      if (this.activePlugins.has(entry.pluginId) || this.active[entry.resource] >= this.limits[entry.resource]) {
        index += 1;
        continue;
      }
      this.queued.splice(index, 1);
      this.start(entry);
    }
  }

  async start(entry) {
    entry.controller = new AbortController();
    this.active[entry.resource] += 1;
    this.activePlugins.add(entry.pluginId);
    this.running.add(entry);
    try {
      const result = await entry.run(entry.controller.signal);
      if (entry.controller.signal.aborted) throw new TaskCancelledError(`Plugin '${entry.pluginId}' active task was cancelled`);
      entry.resolve(result);
    } catch (error) {
      if (entry.controller.signal.aborted && error?.code !== "TASK_CANCELLED") entry.reject(new TaskCancelledError(`Plugin '${entry.pluginId}' active task was cancelled`));
      else entry.reject(error);
    } finally {
      this.running.delete(entry);
      this.activePlugins.delete(entry.pluginId);
      this.active[entry.resource] -= 1;
      this.drain();
    }
  }
}

export class PluginTaskManager {
  constructor(pluginId, queue, onEvent, { diagnostic = false, registrations = { tasks: [], schedules: [] }, statePath } = {}) {
    this.pluginId = pluginId;
    this.queue = queue;
    this.onEvent = onEvent;
    this.diagnostic = diagnostic;
    this.registrations = registrations;
    this.diagnosticViolations = [];
    this.handlers = new Map();
    this.pending = new Map();
    this.schedules = new Set();
    this.records = [];
    this.interruptedOperations = new Set();
    this.statePath = statePath;
    this.writes = Promise.resolve();
    this.stopped = false;
  }

  async load() {
    if (!this.statePath) return;
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8"));
      this.records = (Array.isArray(value.records) ? value.records.map((record) => normalizeTaskRecord(record, this.pluginId)).filter(Boolean) : []).slice(-200);
      let changed = false;
      for (const record of this.records) {
        if (!["queued", "running"].includes(record.state)) continue;
        const timestamp = new Date().toISOString();
        record.state = "interrupted";
        record.completedAt = timestamp;
        record.updatedAt = timestamp;
        record.outcome = { status: "interrupted", code: "RUNTIME_RESTARTED", message: "Plugin Runtime restarted before the task completed", timestamp };
        this.interruptedOperations.add(record.operationId);
        changed = true;
      }
      if (changed) await this.persist();
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  async persist() {
    if (!this.statePath) return;
    const value = JSON.stringify({ version: 1, pluginId: this.pluginId, records: this.records.slice(-200) }, null, 2);
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${value}\n`, "utf8");
      try { await rename(temporary, this.statePath); }
      finally { await rm(temporary, { force: true }); }
    });
    await this.writes;
  }

  recordEvent(type, details = {}) {
    const operationId = details.operationId;
    if (!operationId) return;
    const current = this.records.find((record) => record.operationId === operationId);
    if (!current) return;
    const timestamp = new Date().toISOString();
    if (this.interruptedOperations.has(operationId) && !["task-interrupted"].includes(type)) {
      current.updatedAt = timestamp;
      void this.persist();
      return;
    }
    if (type === "task-started") { current.state = "running"; current.startedAt ??= timestamp; current.attempts = current.attempts ?? 1; }
    if (type === "task-retrying") { current.state = "running"; current.attempts = (current.attempts ?? 1) + 1; current.lastRetryAt = timestamp; }
    if (type === "task-completed") {
      const failed = details.result?.ok === false;
      current.state = failed ? "failed" : "succeeded";
      current.completedAt = timestamp;
      if (failed) current.failure = {
        code: typeof details.result?.code === "string" ? details.result.code : "REFRESH_FAILED",
        message: redactSensitiveText(String(details.result?.message ?? details.result?.lastError ?? "Plugin task returned ok:false")),
      };
    }
    if (type === "task-failed") { current.state = "failed"; current.completedAt = timestamp; current.failure = errorDetails(details.error); }
    if (type === "task-cancelled") { current.state = "canceled"; current.completedAt = timestamp; current.outcome = details.outcome ?? "uncertain"; }
    if (type === "task-interrupted") { current.state = "interrupted"; current.completedAt = timestamp; current.outcome = { status: "interrupted", code: "RUNTIME_RESTARTED", message: "Plugin Runtime restarted before the task completed", timestamp }; }
    if (type === "task-coalesced") current.coalesced = true;
    current.updatedAt = timestamp;
    this.records = this.records.slice(-200);
    void this.persist();
  }

  register(name, handler) {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      const error = new Error(`Task '${String(name)}' is invalid`);
      error.code = "INVALID_TASK_REGISTRATION";
      throw error;
    }
    if (this.handlers.has(name)) {
      const error = new Error(`Task '${name}' is already registered`);
      error.code = "DUPLICATE_TASK_REGISTRATION";
      throw error;
    }
    if (typeof handler !== "function") {
      const error = new TypeError(`Task '${name}' handler must be a function`);
      error.code = "INVALID_TASK_REGISTRATION";
      throw error;
    }
    this.handlers.set(name, handler);
    this.registrations.tasks.push({ name });
  }

  enqueue(name, input, options = {}) {
    return this.enqueueDetailed(name, input, options).promise;
  }

  enqueueDetailed(name, input, options = {}) {
    if (this.stopped) return { promise: Promise.reject(new TaskCancelledError(`Plugin '${this.pluginId}' task manager is stopped`, "not-started")), operationId: undefined, coalesced: false };
    if (this.diagnostic) {
      const error = new Error(`Diagnostic mode blocked task '${name}' execution`);
      error.code = "DIAGNOSTIC_TASK_EXECUTION";
      error.phase = "activation";
      this.diagnosticViolations.push({ type: "task", name, code: error.code });
      return { promise: Promise.reject(error), operationId: undefined, coalesced: false };
    }
    const handler = this.handlers.get(name);
    if (!handler) return { promise: Promise.reject(new Error(`Task '${name}' is not registered`)), operationId: undefined, coalesced: false };
    const key = `${name}:${options.coalesceKey ?? "default"}`;
    if (this.pending.has(key)) {
      const pending = this.pending.get(key);
      const record = this.records.find((entry) => entry.operationId === pending.operationId);
      if (record) record.coalesced = true;
      void this.persist();
      void this.onEvent("task-coalesced", {
        task: name,
        reason: options.reason ?? "manual",
        operationId: pending.operationId,
        ...(options.batchId ? { batchId: options.batchId } : {}),
      });
      return { promise: pending.promise, operationId: pending.operationId, coalesced: true };
    }

    const reason = options.reason ?? "manual";
    const operationId = options.operationId ?? randomUUID();
    const correlation = { task: name, operationId, ...(options.batchId ? { batchId: options.batchId } : {}) };
    const queuedDetails = { ...correlation, reason };
    this.records.push({ pluginId: this.pluginId, task: name, operationId, state: "queued", reason, createdAt: new Date().toISOString(), ...(options.batchId ? { batchId: options.batchId } : {}) });
    void this.persist();
    void this.onEvent("task-queued", queuedDetails);
    const retry = normalizeRetryOptions(options.retry);
    const execution = this.queue.submitTask({ pluginId: this.pluginId, run: async (signal) => {
      this.recordEvent("task-started", queuedDetails);
      await this.onEvent("task-started", queuedDetails);
      for (let attempt = 1; ; attempt += 1) {
        try {
          const result = await handler(input, { signal, reason, attempt });
          if (!retry || result?.retryable !== true || attempt >= retry.maxAttempts) return result;
          await this.retryDelay(retry, attempt, signal, queuedDetails);
        } catch (error) {
          if (!retry || error?.retryable !== true || attempt >= retry.maxAttempts) throw error;
          await this.retryDelay(retry, attempt, signal, queuedDetails);
        }
      }
    } });
    const promise = execution.then(
      async (result) => { this.recordEvent("task-completed", { ...correlation, result }); await this.onEvent("task-completed", { ...correlation, result }); return result; },
      async (error) => {
        const event = this.interruptedOperations.has(operationId)
          ? "task-interrupted"
          : error?.code === "TASK_CANCELLED" ? "task-cancelled" : "task-failed";
        this.recordEvent(event, { ...correlation, error, outcome: error?.outcome });
        await this.onEvent(event, { ...correlation, error, outcome: error?.outcome });
        throw error;
      },
    ).finally(() => this.pending.delete(key));
    this.pending.set(key, { promise, operationId, task: name });
    return { promise, operationId, coalesced: false };
  }

  isPending(name, coalesceKey = "default") {
    return this.pending.has(`${name}:${coalesceKey}`);
  }

  schedule(name, options) {
    if (!this.handlers.has(name) || typeof name !== "string") {
      const error = new Error(`Schedule '${String(name)}' references an unregistered task`);
      error.code = "INVALID_SCHEDULE_REGISTRATION";
      throw error;
    }
    if (!Number.isFinite(options?.intervalMs) || options.intervalMs < 100) {
      const error = new Error("Schedule intervalMs must be at least 100");
      error.code = "INVALID_SCHEDULE_REGISTRATION";
      throw error;
    }
    this.registrations.schedules.push({
      task: name,
      intervalMs: options.intervalMs,
      runImmediately: Boolean(options.runImmediately),
      ...(options.reason ? { reason: options.reason } : {}),
    });
    if (this.diagnostic) return () => {};
    const enqueue = () => this.enqueue(name, options.input, { reason: options.reason ?? "schedule", coalesceKey: options.coalesceKey, retry: options.retry }).catch(() => {});
    const timer = setInterval(enqueue, options.intervalMs);
    timer.unref?.();
    this.schedules.add(timer);
    if (options.runImmediately) enqueue();
    return () => { clearInterval(timer); this.schedules.delete(timer); };
  }

  markInterrupted() {
    const timestamp = new Date().toISOString();
    for (const record of this.records) {
      if (!(["queued", "running"].includes(record.state))) continue;
      record.state = "interrupted";
      record.completedAt = timestamp;
      record.updatedAt = timestamp;
      record.outcome = { status: "interrupted", code: "RUNTIME_RESTARTED", message: "Plugin Runtime stopped before the task completed", timestamp };
      this.interruptedOperations.add(record.operationId);
    }
  }

  async stop({ preserveInterrupted = false } = {}) {
    this.stopped = true;
    for (const timer of this.schedules) clearInterval(timer);
    this.schedules.clear();
    if (preserveInterrupted) this.markInterrupted();
    this.queue.cancelPlugin(this.pluginId);
    await Promise.allSettled([...this.pending.values()].map(({ promise }) => promise));
    if (preserveInterrupted) this.markInterrupted();
    await this.persist();
  }

  async retryDelay(retry, attempt, signal, details) {
    const delay = Math.min(retry.maxBackoffMs, retry.backoffMs * (retry.backoffMultiplier ** (attempt - 1)));
    this.recordEvent("task-retrying", details);
    await this.onEvent("task-retrying", { ...details, attempt, delayMs: delay });
    if (!delay) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        signal.removeEventListener("abort", cancel);
        clearTimeout(timer);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new TaskCancelledError("Plugin task retry was cancelled"));
      };
      const complete = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      timer = setTimeout(complete, delay);
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }

  diagnosticSnapshot() {
    return { registrations: this.registrations, violations: [...this.diagnosticViolations] };
  }

  snapshot() {
    return this.records.map((record) => structuredClone(record)).reverse();
  }
}

function normalizeRetryOptions(value) {
  if (!value || typeof value !== "object") return undefined;
  const maxAttempts = Math.min(8, Math.max(1, Number(value.maxAttempts) || 1));
  if (maxAttempts <= 1) return undefined;
  return {
    maxAttempts,
    backoffMs: Math.max(0, Number(value.backoffMs) || 0),
    maxBackoffMs: Math.max(0, Number(value.maxBackoffMs) || 30_000),
    backoffMultiplier: Math.min(10, Math.max(1, Number(value.backoffMultiplier) || 2)),
  };
}

function errorDetails(error) {
  if (!error) return undefined;
  return {
    code: typeof error.code === "string" ? error.code : "PLUGIN_ERROR",
    message: redactSensitiveText(String(error.message ?? error)),
  };
}

function normalizeTaskRecord(value, pluginId) {
  if (!value || typeof value !== "object" || value.pluginId !== pluginId || typeof value.task !== "string" || typeof value.operationId !== "string") return undefined;
  const states = new Set(["queued", "running", "succeeded", "failed", "canceled", "interrupted"]);
  if (!states.has(value.state)) return undefined;
  return {
    pluginId,
    task: value.task,
    operationId: value.operationId,
    state: value.state,
    ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 120) } : {}),
    ...(typeof value.batchId === "string" ? { batchId: value.batchId } : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : { createdAt: new Date().toISOString() }),
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    ...(Number.isInteger(value.attempts) && value.attempts > 0 ? { attempts: value.attempts } : {}),
    ...(value.coalesced === true ? { coalesced: true } : {}),
    ...(value.failure && typeof value.failure === "object" ? { failure: errorDetails(value.failure) } : {}),
    ...(value.outcome !== undefined ? { outcome: value.outcome } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}
