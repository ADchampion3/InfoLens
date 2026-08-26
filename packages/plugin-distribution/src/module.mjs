import { randomUUID } from "node:crypto";
import { normalizeDistributionSource } from "./source.mjs";

export const DISTRIBUTION_INTENTS = Object.freeze(["install", "replace", "rollback"]);
export const DISTRIBUTION_OPERATION_STATES = Object.freeze(["queued", "preflight", "committing", "completed", "failed", "cancelled"]);

function copy(value) {
  return structuredClone(value);
}

function operationView(operation) {
  const { source, promise: _promise, controller: _controller, signal: _signal, signature: _signature, ...publicOperation } = operation;
  return {
    ...copy(publicOperation),
    ...(source?.kind ? { source: { kind: source.kind, ...(source.url ? { url: source.url } : {}), ...(source.fileName ? { fileName: source.fileName } : {}), ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}) } } : {}),
  };
}

export class PluginDistributionModule {
  constructor({ execute, now = () => new Date().toISOString(), idFactory = randomUUID, maxOperations = 100, onCreate, onComplete, onFailure } = {}) {
    if (typeof execute !== "function") throw new TypeError("PluginDistributionModule requires an execute callback");
    this.execute = execute;
    this.now = now;
    this.idFactory = idFactory;
    this.maxOperations = maxOperations;
    this.onCreate = onCreate;
    this.onComplete = onComplete;
    this.onFailure = onFailure;
    this.operations = new Map();
    this.controllers = new Map();
  }

  operation(operationId) {
    const operation = this.operations.get(operationId);
    return operation ? operationView(operation) : undefined;
  }

  list() {
    return [...this.operations.values()].map(operationView);
  }

  async submit({ intent = "install", pluginId, source, operationId = this.idFactory(), controls = {}, signature, previousOperationId } = {}) {
    if (!DISTRIBUTION_INTENTS.includes(intent)) {
      const error = new Error(`Unsupported Plugin Distribution intent '${intent}'`);
      error.code = "DISTRIBUTION_INTENT_INVALID";
      throw error;
    }
    if (intent !== "rollback") source = normalizeDistributionSource(source);
    const existing = this.operations.get(operationId);
    if (existing) {
      if (signature && existing.signature && signature !== existing.signature) {
        const error = new Error("Operation ID was already used for a different distribution command");
        error.code = "OPERATION_ID_REUSED";
        throw error;
      }
      return this.operation(operationId);
    }
    const operation = {
      operationId,
      intent,
      ...(pluginId ? { pluginId } : {}),
      ...(source ? { source } : {}),
      state: "queued",
      phase: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
      ...(signature ? { signature } : {}),
      ...(previousOperationId ? { previousOperationId } : {}),
    };
    this.operations.set(operationId, operation);
    while (this.operations.size > this.maxOperations) {
      const oldest = this.operations.keys().next().value;
      if (oldest === operationId) break;
      this.operations.delete(oldest);
    }
    const controller = new AbortController();
    operation.controller = controller;
    operation.signal = controller.signal;
    this.controllers.set(operationId, controller);
    const externalSignal = controls.signal;
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try { await this.onCreate?.(operation); }
    catch (error) {
      this.operations.delete(operationId);
      this.controllers.delete(operationId);
      throw error;
    }
    operation.promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) {
        const error = new Error("Distribution operation was cancelled");
        error.code = "DISTRIBUTION_CANCELLED";
        throw error;
      }
      operation.state = "preflight";
      operation.phase = "preflight";
      operation.updatedAt = this.now();
      const result = await this.execute({
        operation,
        intent,
        pluginId,
        source,
        signal: controller.signal,
        update: (change = {}) => {
          Object.assign(operation, change, { updatedAt: this.now() });
          return operationView(operation);
        },
      });
      operation.state = "completed";
      operation.phase = "completed";
      operation.result = copy(result);
      operation.updatedAt = this.now();
      try { await this.onComplete?.(operation, result); } catch {}
      return result;
    }).catch(async (error) => {
      const cancelled = controller.signal.aborted || error?.code === "DISTRIBUTION_CANCELLED";
      operation.state = cancelled ? "cancelled" : "failed";
      operation.phase = operation.state;
      operation.error = { code: error?.code ?? "DISTRIBUTION_FAILED", message: error instanceof Error ? error.message : String(error) };
      operation.updatedAt = this.now();
      try { await this.onFailure?.(operation, error); } catch {}
      throw error;
    }).finally(() => {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      this.controllers.delete(operationId);
    });
    operation.promise.catch(() => {});
    return operationView(operation);
  }

  async wait(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) return undefined;
    await operation.promise?.catch(() => {});
    return this.operation(operationId);
  }

  cancel(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation || ["completed", "failed", "cancelled"].includes(operation.state)) return false;
    this.controllers.get(operationId)?.abort();
    operation.updatedAt = this.now();
    return true;
  }
}

export function createDistributionModule(options) {
  return new PluginDistributionModule(options);
}
