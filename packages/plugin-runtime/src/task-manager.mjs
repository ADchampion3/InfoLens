export class PluginTaskManager {
  constructor(pluginId, onEvent) {
    this.pluginId = pluginId;
    this.onEvent = onEvent;
    this.handlers = new Map();
    this.pending = new Map();
    this.controllers = new Set();
    this.schedules = new Set();
    this.tail = Promise.resolve();
    this.stopped = false;
  }

  register(name, handler) {
    if (this.handlers.has(name)) throw new Error(`Task '${name}' is already registered`);
    if (typeof handler !== "function") throw new TypeError(`Task '${name}' handler must be a function`);
    this.handlers.set(name, handler);
  }

  enqueue(name, input, options = {}) {
    if (this.stopped) return Promise.reject(new Error(`Plugin '${this.pluginId}' task manager is stopped`));
    const handler = this.handlers.get(name);
    if (!handler) return Promise.reject(new Error(`Task '${name}' is not registered`));
    const key = `${name}:${options.coalesceKey ?? "default"}`;
    if (this.pending.has(key)) {
      this.onEvent("task-coalesced", { task: name, reason: options.reason ?? "manual" });
      return this.pending.get(key);
    }

    const run = async () => {
      const controller = new AbortController();
      this.controllers.add(controller);
      this.onEvent("task-started", { task: name, reason: options.reason ?? "manual" });
      try {
        const result = await handler(input, { signal: controller.signal, reason: options.reason ?? "manual" });
        this.onEvent("task-completed", { task: name });
        return result;
      } catch (error) {
        this.onEvent("task-failed", { task: name, error });
        throw error;
      } finally {
        this.controllers.delete(controller);
        this.pending.delete(key);
      }
    };
    const promise = this.tail.then(run, run);
    this.tail = promise.catch(() => {});
    this.pending.set(key, promise);
    return promise;
  }

  schedule(name, options) {
    if (!Number.isFinite(options?.intervalMs) || options.intervalMs < 100) throw new Error("Schedule intervalMs must be at least 100");
    const enqueue = () => this.enqueue(name, options.input, { reason: options.reason ?? "schedule" }).catch(() => {});
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
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.pending.values());
  }
}
