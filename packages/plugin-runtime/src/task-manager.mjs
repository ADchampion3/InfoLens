import { randomUUID } from "node:crypto";

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
  constructor(pluginId, queue, onEvent, { diagnostic = false, registrations = { tasks: [], schedules: [] } } = {}) {
    this.pluginId = pluginId;
    this.queue = queue;
    this.onEvent = onEvent;
    this.diagnostic = diagnostic;
    this.registrations = registrations;
    this.diagnosticViolations = [];
    this.handlers = new Map();
    this.pending = new Map();
    this.schedules = new Set();
    this.stopped = false;
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
    void this.onEvent("task-queued", queuedDetails);
    const execution = this.queue.submitTask({ pluginId: this.pluginId, run: async (signal) => {
      await this.onEvent("task-started", queuedDetails);
      return handler(input, { signal, reason });
    } });
    const promise = execution.then(
      async (result) => { await this.onEvent("task-completed", { ...correlation, result }); return result; },
      async (error) => {
        await this.onEvent(error?.code === "TASK_CANCELLED" ? "task-cancelled" : "task-failed", { ...correlation, error, outcome: error?.outcome });
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
    const enqueue = () => this.enqueue(name, options.input, { reason: options.reason ?? "schedule", coalesceKey: options.coalesceKey }).catch(() => {});
    const timer = setInterval(enqueue, options.intervalMs);
    timer.unref?.();
    this.schedules.add(timer);
    if (options.runImmediately) enqueue();
    return () => { clearInterval(timer); this.schedules.delete(timer); };
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.schedules) clearInterval(timer);
    this.schedules.clear();
    this.queue.cancelPlugin(this.pluginId);
    await Promise.allSettled([...this.pending.values()].map(({ promise }) => promise));
  }

  diagnosticSnapshot() {
    return { registrations: this.registrations, violations: [...this.diagnosticViolations] };
  }
}
