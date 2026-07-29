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

  cancelPlugin(pluginId) {
    const retained = [];
    for (const entry of this.queued) {
      if (entry.pluginId === pluginId) entry.reject(new TaskCancelledError(`Plugin '${pluginId}' queued task was cancelled`, "not-started"));
      else retained.push(entry);
    }
    this.queued = retained;
    for (const entry of this.running) if (entry.pluginId === pluginId) entry.controller.abort();
  }

  stop() {
    this.stopped = true;
    for (const entry of this.queued) entry.reject(new TaskCancelledError("Runtime stopped before task started", "not-started"));
    this.queued = [];
    for (const entry of this.running) entry.controller.abort();
  }

  snapshot() {
    return {
      queued: this.queued.map(({ pluginId, resource }) => ({ pluginId, resource })),
      active: { ...this.active },
      activePlugins: [...this.activePlugins],
    };
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
  constructor(pluginId, resource, queue, onEvent) {
    this.pluginId = pluginId;
    this.resource = resource;
    this.queue = queue;
    this.onEvent = onEvent;
    this.handlers = new Map();
    this.pending = new Map();
    this.schedules = new Set();
    this.stopped = false;
  }

  register(name, handler) {
    if (this.handlers.has(name)) throw new Error(`Task '${name}' is already registered`);
    if (typeof handler !== "function") throw new TypeError(`Task '${name}' handler must be a function`);
    this.handlers.set(name, handler);
  }

  enqueue(name, input, options = {}) {
    if (this.stopped) return Promise.reject(new TaskCancelledError(`Plugin '${this.pluginId}' task manager is stopped`, "not-started"));
    const handler = this.handlers.get(name);
    if (!handler) return Promise.reject(new Error(`Task '${name}' is not registered`));
    const key = `${name}:${options.coalesceKey ?? "default"}`;
    if (this.pending.has(key)) {
      this.onEvent("task-coalesced", { task: name, reason: options.reason ?? "manual", resource: this.resource });
      return this.pending.get(key);
    }

    const reason = options.reason ?? "manual";
    this.onEvent("task-queued", { task: name, reason, resource: this.resource });
    const promise = this.queue.submit({ pluginId: this.pluginId, resource: this.resource, run: async (signal) => {
      this.onEvent("task-started", { task: name, reason, resource: this.resource });
      return handler(input, { signal, reason });
    } });
    this.pending.set(key, promise);
    promise.then(
      () => this.onEvent("task-completed", { task: name, resource: this.resource }),
      (error) => this.onEvent(error?.code === "TASK_CANCELLED" ? "task-cancelled" : "task-failed", { task: name, resource: this.resource, error, outcome: error?.outcome }),
    ).finally(() => this.pending.delete(key));
    return promise;
  }

  schedule(name, options) {
    if (!Number.isFinite(options?.intervalMs) || options.intervalMs < 100) throw new Error("Schedule intervalMs must be at least 100");
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
    await Promise.allSettled(this.pending.values());
  }
}
