#!/usr/bin/env node
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import semver from "semver";

const require = createRequire(import.meta.url);
const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryFallbackRoot = path.resolve(sdkRoot, "../../resources/opencli");
const DEFAULT_TIMEOUT_MS = 10_000;

function codedError(code, message, phase = "bootstrap", checkId) {
  const error = new Error(message);
  error.code = code;
  error.phase = phase;
  if (checkId) error.checkId = checkId;
  return error;
}

function sourceValue(value, source, sourcePath, expectedSource) {
  return {
    value: value ?? null,
    source,
    ...(sourcePath ? { sourcePath, path: sourcePath } : {}),
    ...(expectedSource ? { expectedSource } : {}),
  };
}

function nullEnvironment() {
  const contract = sourceValue(null, "release-metadata-package", undefined, "release-metadata-package");
  const host = sourceValue(null, "release-metadata-package", undefined, "release-metadata-package");
  const opencli = sourceValue(null, "bundled-opencli-package", undefined, "bundled-opencli-package");
  return {
    contract,
    contractVersion: contract,
    host,
    targetHost: host,
    targetHostVersion: host,
    opencli,
    openCli: opencli,
  };
}

function environmentFrom(metadata, runtime, targetHost, targetSource, targetPath) {
  const contract = sourceValue(metadata?.contractVersion, metadata?.source ?? "release-metadata-package", metadata?.sourcePath, "release-metadata-package");
  const host = sourceValue(targetHost, targetSource ?? metadata?.source ?? "release-metadata-package", targetPath ?? (targetSource === "cli-option" ? undefined : metadata?.sourcePath), "release-metadata-package");
  const opencli = sourceValue(runtime?.version, runtime?.source ?? "bundled-opencli-package", runtime?.sourcePath ?? runtime?.distributionRoot, "bundled-opencli-package");
  return {
    contract,
    contractVersion: contract,
    host,
    targetHost: host,
    targetHostVersion: host,
    opencli,
    openCli: opencli,
  };
}

function pluginIdentity(manifest, packageRoot) {
  if (!manifest || typeof manifest !== "object") return undefined;
  const identity = {
    ...(typeof manifest.id === "string" ? { id: manifest.id } : {}),
    ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
  };
  if (packageRoot) {
    identity.path = packageRoot;
    identity.packagePath = packageRoot;
  }
  return Object.keys(identity).length ? identity : undefined;
}

function baseResult(command, environment = nullEnvironment(), manifest, packageRoot) {
  const result = {
    ok: false,
    command,
    ...(pluginIdentity(manifest, packageRoot) ? { plugin: pluginIdentity(manifest, packageRoot) } : {}),
    environment,
    checks: [],
  };
  return result;
}

function addCheck(result, id, severity, status, details = {}) {
  result.checks.push({ id, severity, status, ...details });
  return result.checks.at(-1);
}

function addEnvironmentChecks(result) {
  for (const [id, value] of [["environment.contract", result.environment.contract], ["environment.target-host", result.environment.targetHost], ["environment.opencli", result.environment.opencli]]) {
    addCheck(result, id, "info", value.value === null ? "unresolved" : "passed", { phase: "bootstrap", details: { value: value.value, source: value.source, ...(value.sourcePath ? { sourcePath: value.sourcePath } : {}) } });
  }
}

function errorRecord(error, fallbackCode = "PLUGIN_TOOL_FAILED", fallbackPhase = "bootstrap") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    phase: typeof error?.phase === "string" ? error.phase : fallbackPhase,
    ...(typeof error?.checkId === "string" ? { checkId: error.checkId } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

function setFailure(result, error, { phase, checkId, id = checkId ?? "command.failure" } = {}) {
  const record = errorRecord(error, "PLUGIN_TOOL_FAILED", phase ?? "bootstrap");
  if (checkId) record.checkId = checkId;
  result.error = record;
  addCheck(result, id, "error", "failed", { phase: record.phase, code: record.code, message: record.message });
  result.ok = false;
  return result;
}

async function readManifest(packageRoot) {
  try { return JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8")); }
  catch { return undefined; }
}

async function loadDependencies() {
  const [release, contract, opencli, scope, workspace] = await Promise.all([
    import("@infolens/release-metadata"),
    import("@infolens/plugin-runtime/contract"),
    import("@infolens/plugin-runtime/opencli-adapter"),
    import("@infolens/plugin-runtime/adapter-scope"),
    import("@infolens/plugin-runtime/workspace-diagnostics"),
  ]);
  return { release, contract, opencli, scope, workspace };
}

async function resolveContext(deps, targetOption) {
  let metadata;
  let runtime;
  let targetHost;
  let targetError;
  let bootstrapError;
  try {
    metadata = await deps.release.resolveReleaseMetadata();
    if (metadata.contractVersion === null || !semver.valid(metadata.hostVersion)) {
      throw codedError("RELEASE_METADATA_INVALID", "Release metadata does not contain a valid Contract or Host value");
    }
  } catch (error) {
    bootstrapError = errorRecord(error, "RELEASE_METADATA_UNAVAILABLE", "bootstrap");
  }

  const targetSource = targetOption === undefined ? metadata?.source ?? "release-metadata-package" : "cli-option";
  if (targetOption !== undefined && !semver.valid(targetOption)) {
    targetError = codedError("INVALID_TARGET_HOST_VERSION", `Target Host version '${targetOption}' is not semantic versioning`, "arguments", "environment.target-host");
  } else {
    targetHost = targetOption ?? metadata?.hostVersion;
  }

  try {
    runtime = await deps.opencli.resolveBundledOpenCli({ fallbackRoot: repositoryFallbackRoot });
  } catch (error) {
    bootstrapError ??= errorRecord(error, "OPENCLI_RUNTIME_UNAVAILABLE", "bootstrap");
  }

  return {
    metadata,
    runtime,
    targetHost,
    targetSource,
    bootstrapError,
    targetError,
    environment: metadata || runtime
      ? environmentFrom(metadata, runtime, targetHost, targetSource)
      : nullEnvironment(),
  };
}

function validationRuntime(context) {
  return {
    hostVersion: context.targetHost,
    contractVersion: context.metadata?.contractVersion,
    openCliVersion: context.runtime?.version,
    availableCommands: context.runtime?.availableCommands ?? new Set(),
  };
}

function adapterOptions(deps, context, registryRoot, development = false) {
  return {
    prepareAdapterScope: ({ packageRoot, manifest }) => deps.scope.preparePluginAdapterScope({
      packageRoot,
      manifest,
      runtime: context.runtime,
      registryRoot,
      inspect: (paths) => deps.opencli.createOpenCliAdapter(context.runtime).inspect(paths),
      development,
    }),
  };
}

function validationCheckId(error) {
  if (["INCOMPATIBLE_CONTRACT"].includes(error?.code)) return "plugin.contract";
  if (["INCOMPATIBLE_HOST", "INVALID_HOST_VERSION"].includes(error?.code)) return "plugin.host";
  if (["UNAVAILABLE_COMMAND", "INVALID_COMMAND", "UNSUPPORTED_ACCESS", "UNSUPPORTED_OUTPUT", "UNSUPPORTED_STRATEGY", "UNKNOWN_ADAPTER"].includes(error?.code)) return "plugin.commands";
  if (["ADAPTER_SCOPE_UNAVAILABLE", "INVALID_ADAPTERS", "INVALID_ADAPTER", "INVALID_ADAPTER_PATH", "INVALID_ADAPTER_MANIFEST", "ADAPTER_ID_MISMATCH", "ADAPTER_VERSION_MISMATCH", "INVALID_ADAPTER_VERSION", "INVALID_OPENCLI_RANGE", "INCOMPATIBLE_OPENCLI", "ADAPTER_RUNTIME_DEPENDENCIES", "ADAPTER_BUILD_MISSING", "UNSUPPORTED_OPENCLI_HOOK", "OPENCLI_COMMAND_COLLISION", "ADAPTER_COMMAND_MISMATCH", "UNDECLARED_ADAPTER_COMMAND", "ADAPTER_INTEGRITY_MISMATCH"].includes(error?.code)) return "plugin.adapters";
  if (["INVALID_PACKAGE_STRUCTURE", "INVALID_PACKAGE_PATH"].includes(error?.code)) return "plugin.structure";
  if (["INVALID_PLUGIN_ID", "INVALID_PLUGIN_VERSION", "INVALID_MANIFEST", "INVALID_PACKAGE"].includes(error?.code)) return "plugin.manifest";
  return "plugin.validation";
}

async function validatePackage(packageRoot, deps, context, { command = "validate", development = false } = {}) {
  const manifest = await readManifest(packageRoot);
  const result = baseResult(command, context.environment, manifest, packageRoot);
  addEnvironmentChecks(result);
  if (context.bootstrapError) return { result: setFailure(result, context.bootstrapError, { phase: context.bootstrapError.phase, id: "environment.bootstrap" }) };
  if (context.targetError) return { result: setFailure(result, context.targetError, { phase: "arguments", checkId: "environment.target-host", id: "environment.target-host" }) };

  const registryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-author-adapters-"));
  try {
    const validated = await deps.contract.validatePluginPackage(packageRoot, validationRuntime(context), adapterOptions(deps, context, registryRoot, development));
    result.plugin = pluginIdentity(validated.manifest, packageRoot);
    addCheck(result, "plugin.manifest", "info", "passed", { phase: "validate" });
    addCheck(result, "plugin.contract", "info", "passed", { phase: "validate", details: { value: validated.manifest.contractVersion } });
    addCheck(result, "plugin.host", "info", "passed", { phase: "validate", details: { minimum: validated.manifest.minHostVersion, target: context.targetHost } });
    addCheck(result, "plugin.structure", "info", "passed", { phase: "validate" });
    addCheck(result, "plugin.commands", "info", "passed", { phase: "validate", details: { count: Object.keys(validated.manifest.openCliCommands).length } });
    addCheck(result, "plugin.adapters", "info", "passed", { phase: "adapter-probe", details: { count: validated.adapterScope.adapters.length, commands: validated.adapterScope.commands.length } });
    result.ok = true;
    return { result, validated, adapterScope: validated.adapterScope };
  } catch (error) {
    const checkId = validationCheckId(error);
    setFailure(result, error, { phase: error?.phase ?? "validate", checkId, id: checkId });
    return { result, error };
  } finally {
    await rm(registryRoot, { recursive: true, force: true });
  }
}

function withTimeout(promise, timeoutMs, code, phase) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(codedError(code, `${phase} exceeded ${timeoutMs}ms`, phase)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitForMessage(child, messages, predicate, timeoutMs, phase) {
  for (const message of messages) if (predicate(message)) return Promise.resolve(message);
  if (child.exitCode !== null) return Promise.reject(codedError("DIAGNOSTIC_RUNTIME_EXITED", `Diagnostic Runtime exited during ${typeof phase === "function" ? phase() : phase}`, typeof phase === "function" ? phase() : phase, "doctor.runtime"));
  return new Promise((resolve, reject) => {
    const currentPhase = () => typeof phase === "function" ? phase() : phase;
    let timer;
    const onLine = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(codedError("DIAGNOSTIC_RUNTIME_EXITED", `Diagnostic Runtime exited during ${currentPhase()}`, currentPhase(), "doctor.runtime"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.__infolensMessageListeners?.delete(onLine);
      child.off("exit", onExit);
    };
    child.__infolensMessageListeners ??= new Set();
    child.__infolensMessageListeners.add(onLine);
    child.on("exit", onExit);
    timer = setTimeout(() => {
      const activePhase = currentPhase();
      cleanup();
      reject(codedError("DIAGNOSTIC_TIMEOUT", `${activePhase} exceeded ${timeoutMs}ms`, activePhase, `doctor.${activePhase}`));
    }, timeoutMs);
  });
}

function runtimePackageRoot() {
  try { return path.dirname(require.resolve("@infolens/plugin-runtime/package.json")); }
  catch { return path.resolve(sdkRoot, "../plugin-runtime"); }
}

async function copyDirectoryContents(sourceRoot, destinationRoot, filter = () => true) {
  await mkdir(destinationRoot, { recursive: true });
  async function copy(currentSource, currentDestination) {
    for (const entry of await readdir(currentSource, { withFileTypes: true })) {
      const source = path.join(currentSource, entry.name);
      const relative = path.relative(sourceRoot, source);
      if (!filter(source, relative, entry)) continue;
      const destination = path.join(currentDestination, entry.name);
      if (entry.isDirectory()) await copy(source, destination);
      else await cp(source, destination, { recursive: entry.isSymbolicLink() });
    }
  }
  await copy(sourceRoot, destinationRoot);
}

async function startDiagnosticRuntime(packageRoot, context, timeoutMs) {
  let temporaryRoot;
  let child;
  let lines;
  const messages = [];
  const errors = [];
  const diagnosticPhase = { value: "runtime-start" };
  try {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-doctor-"));
    const pluginManifest = await readManifest(packageRoot);
    const pluginId = pluginManifest?.id;
    const pluginsRoot = path.join(temporaryRoot, "plugins");
    const targetRoot = path.join(pluginsRoot, pluginId ?? "target");
    await copyDirectoryContents(packageRoot, targetRoot, packageFilter);
    await copyDirectoryContents(sdkRoot, path.join(temporaryRoot, "node_modules", "@infolens", "plugin-sdk"));
    const dataRoot = path.join(temporaryRoot, "plugin-data");
    const hostStatePath = path.join(temporaryRoot, "host-state.json");
    const adapterRegistryRoot = path.join(temporaryRoot, "managed-adapters");
    child = spawn(process.execPath, [path.join(runtimePackageRoot(), "src", "server.mjs")], {
      cwd: runtimePackageRoot(),
      env: {
        ...process.env,
        INFOLENS_PROJECT_ROOT: temporaryRoot,
        INFOLENS_PLUGINS_ROOT: pluginsRoot,
        INFOLENS_PLUGIN_DATA_ROOT: dataRoot,
        INFOLENS_HOST_STATE_PATH: hostStatePath,
        INFOLENS_ADAPTER_REGISTRY_ROOT: adapterRegistryRoot,
        INFOLENS_BATCH_STATE_PATH: path.join(temporaryRoot, "batches.json"),
        INFOLENS_APPLICATION_SESSION_ID: `doctor-${randomUUID()}`,
        INFOLENS_BUNDLED_OPENCLI_ROOT: context.runtime.distributionRoot,
        INFOLENS_RUNTIME_DIAGNOSTIC: "1",
        INFOLENS_DIAGNOSTIC_PLUGIN_ID: pluginId ?? "",
        INFOLENS_RUNTIME_PORT: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    lines = readline.createInterface({ input: child.stdout });
    const emit = (message) => {
      messages.push(message);
      if (message.type === "diagnostic-phase" && typeof message.phase === "string") diagnosticPhase.value = message.phase;
      for (const listener of child.__infolensMessageListeners ?? []) listener(message);
    };
    lines.on("line", (line) => {
      try { emit(JSON.parse(line)); } catch { errors.push(String(line)); }
    });
    child.stderr.on("data", (chunk) => errors.push(String(chunk)));
    const ready = await waitForMessage(child, messages, (message) => message.type === "runtime-ready", timeoutMs, () => diagnosticPhase.value);
    return { temporaryRoot, targetRoot, pluginId, child, lines, messages, errors, ready, diagnosticPhase };
  } catch (error) {
    if (child?.exitCode === null) child.kill();
    if (child) await waitForChildExit(child, Math.max(250, timeoutMs)).catch(() => {});
    lines?.close();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    if (error.code === "DIAGNOSTIC_TIMEOUT") {
      error.phase = diagnosticPhase.value;
      error.checkId = `doctor.${diagnosticPhase.value}`;
      throw error;
    }
    throw codedError(error.code ?? "DIAGNOSTIC_RUNTIME_START_FAILED", `${error.message}${errors.length ? `: ${errors.join("")}` : ""}`, error.phase ?? "runtime-start", error.checkId ?? "doctor.runtime");
  }
}

async function readDiagnosticHealth(origin, pluginId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/plugins/${encodeURIComponent(pluginId)}/health`, { signal: controller.signal });
    let body;
    try { body = await response.json(); } catch { body = {}; }
    return { response, body };
  } catch (error) {
    if (error.name === "AbortError") throw codedError("DIAGNOSTIC_TIMEOUT", `health exceeded ${timeoutMs}ms`, "health", "doctor.health");
    throw codedError("PLUGIN_HEALTH_UNAVAILABLE", error.message, "health", "doctor.health");
  } finally {
    clearTimeout(timer);
  }
}

async function stopDiagnosticRuntime(runtime, timeoutMs) {
  const { child } = runtime;
  if (child.exitCode !== null) {
    const result = runtime.messages.find((message) => message.type === "diagnostic-result");
    return result
      ? { result, timedOut: false }
      : { result: undefined, timedOut: true, error: codedError("DIAGNOSTIC_RUNTIME_EXITED", "Diagnostic Runtime exited before cleanup completed", "shutdown", "doctor.shutdown") };
  }
  try {
    child.stdin.write("shutdown\n");
    const result = await waitForMessage(child, runtime.messages, (message) => message.type === "diagnostic-result", timeoutMs, "shutdown");
    await waitForChildExit(child, timeoutMs);
    return { result, timedOut: false };
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await waitForChildExit(child, 250).catch(() => {});
    return { result: undefined, timedOut: true, error };
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return withTimeout(new Promise((resolve) => child.once("exit", resolve)), timeoutMs, "DIAGNOSTIC_TIMEOUT", "shutdown");
}

function lifecycleChecks(result, lifecycle) {
  for (const check of lifecycle?.checks ?? []) {
    const existingIndex = result.checks.findIndex((entry) => entry.id === check.id);
    if (existingIndex < 0) result.checks.push(check);
    else if (check.severity === "error" && result.checks[existingIndex].severity !== "error") result.checks[existingIndex] = check;
    if (check.severity === "error" && check.status === "failed") {
      const lifecycleError = { code: check.code ?? "PLUGIN_DOCTOR_FAILED", phase: check.phase ?? "activation", checkId: check.id, message: check.message ?? "Plugin diagnostic failed" };
      if (!result.error || (result.error.checkId === "doctor.health" && check.id !== "doctor.health")) result.error = lifecycleError;
    }
  }
  if (Array.isArray(lifecycle?.registrations)) result.registrations = lifecycle.registrations;
  else if (lifecycle?.registrations) result.registrations = lifecycle.registrations;
  if (lifecycle?.health) result.health = lifecycle.health;
  if (lifecycle?.cleanup) result.cleanup = lifecycle.cleanup;
}

async function runDoctor(packageRoot, deps, context, timeoutMs) {
  const validation = await validatePackage(packageRoot, deps, context, { command: "doctor" });
  const result = validation.result;
  if (!validation.validated || !result.ok) return { result, adapterScope: validation.adapterScope };

  let diagnostic;
  try {
    diagnostic = await startDiagnosticRuntime(packageRoot, context, timeoutMs);
    addCheck(result, "doctor.runtime", "info", "passed", { phase: "runtime-start" });
    const health = await readDiagnosticHealth(diagnostic.ready.origin, diagnostic.pluginId, timeoutMs);
    if (!health.response.ok || !["ready", "running"].includes(health.body.state)) {
      setFailure(result, codedError("PLUGIN_HEALTH_FAILED", "Plugin Health did not report a healthy state", "health", "doctor.health"), { phase: "health", checkId: "doctor.health", id: "doctor.health" });
    } else {
      result.health = health.body;
      addCheck(result, "doctor.health", "info", "passed", { phase: "health", details: { state: health.body.state } });
    }

    const stopped = await stopDiagnosticRuntime(diagnostic, timeoutMs);
    if (stopped.timedOut) {
      setFailure(result, stopped.error ?? codedError("DIAGNOSTIC_TIMEOUT", "shutdown timed out", "shutdown"), { phase: "shutdown", checkId: "doctor.shutdown", id: "doctor.shutdown" });
    } else {
      lifecycleChecks(result, stopped.result);
    }

    const stagedEntry = path.join(diagnostic.targetRoot, path.relative(packageRoot, validation.validated.workspaceEntry));
    const stagedWorkspaceRoot = path.dirname(stagedEntry);
    const workspace = await deps.workspace.diagnoseWorkspaceBundle(stagedEntry, stagedWorkspaceRoot);
    result.workspace = { entry: path.relative(diagnostic.targetRoot, stagedEntry), visited: workspace.visited.map((value) => path.relative(stagedWorkspaceRoot, value)), checks: workspace.checks };
    result.checks.push(...workspace.checks);
    if (workspace.checks.some((check) => check.severity === "error")) result.ok = false;
    else addCheck(result, "workspace.bundle", "info", "passed", { phase: "workspace", details: { visited: workspace.visited.length } });
    result.ok = result.ok && !result.checks.some((check) => check.severity === "error" && check.status === "failed");
    const failedCheck = result.checks.find((check) => check.severity === "error" && check.status === "failed");
    if (failedCheck) result.error ??= { code: failedCheck.code ?? "PLUGIN_DOCTOR_FAILED", phase: failedCheck.phase ?? "doctor", checkId: failedCheck.id, message: failedCheck.message ?? "Plugin doctor failed" };
    return { result, adapterScope: validation.adapterScope };
  } catch (error) {
    setFailure(result, error, { phase: error.phase ?? "doctor", checkId: error.checkId ?? `doctor.${error.phase ?? "lifecycle"}`, id: error.checkId ?? `doctor.${error.phase ?? "lifecycle"}` });
    return { result, adapterScope: validation.adapterScope };
  } finally {
    if (diagnostic) {
      if (diagnostic.child.exitCode === null) diagnostic.child.kill();
      await waitForChildExit(diagnostic.child, 250).catch(() => {});
      diagnostic.lines.close();
      await rm(diagnostic.temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function runValidate(packageRoot, deps, context) {
  return validatePackage(packageRoot, deps, context, { command: "validate" });
}

async function runDev(packageRoot, deps, context) {
  const manifest = await readManifest(packageRoot);
  const result = baseResult("dev", context.environment, manifest, packageRoot);
  addEnvironmentChecks(result);
  if (context.bootstrapError) return { result: setFailure(result, context.bootstrapError, { id: "environment.bootstrap" }) };
  if (context.targetError) return { result: setFailure(result, context.targetError, { phase: "arguments", checkId: "environment.target-host", id: "environment.target-host" }) };
  const registryRoot = path.join(packageRoot, ".infolens-dev", "opencli-adapters");
  try {
    const validated = await deps.contract.validatePluginPackage(packageRoot, validationRuntime(context), adapterOptions(deps, context, registryRoot, true));
    result.plugin = pluginIdentity(validated.manifest, packageRoot);
    addCheck(result, "plugin.manifest", "info", "passed", { phase: "validate" });
    addCheck(result, "plugin.contract", "info", "passed", { phase: "validate" });
    addCheck(result, "plugin.host", "info", "passed", { phase: "validate" });
    addCheck(result, "plugin.adapters", "info", "passed", { phase: "adapter-probe", details: { count: validated.adapterScope.adapters.length } });
    result.scope = path.join(registryRoot, "scopes", validated.manifest.id, "scope.lock.json");
    result.ok = true;
    return { result };
  } catch (error) {
    return { result: setFailure(result, error, { phase: error.phase ?? "validate", checkId: validationCheckId(error), id: validationCheckId(error) }) };
  }
}

async function runListAdapters(packageRoot, deps, context) {
  const manifest = await readManifest(packageRoot);
  const result = baseResult("adapters list", context.environment, manifest, packageRoot);
  addEnvironmentChecks(result);
  if (context.bootstrapError) return { result: setFailure(result, context.bootstrapError, { id: "environment.bootstrap" }) };
  if (context.targetError) return { result: setFailure(result, context.targetError, { phase: "arguments", checkId: "environment.target-host", id: "environment.target-host" }) };
  try {
    const validation = await validatePackage(packageRoot, deps, context, { command: "adapters list" });
    if (!validation.validated) {
      result.checks.push(...validation.result.checks.filter((check) => !result.checks.some((existing) => existing.id === check.id)));
      result.error = validation.result.error;
      return { result };
    }
    result.plugin = pluginIdentity(validation.validated.manifest, packageRoot);
    result.adapters = [...(context.runtime.inventory ?? [...context.runtime.availableCommands].map((command) => command.split(" ")))].map((command) => ({ command: command.join(" "), source: "builtin", version: context.runtime.version }));
    result.adapters.push(...validation.validated.adapterScope.adapters.map(({ id, version, path: adapterPath }) => ({ adapter: id, source: "provided", version, path: adapterPath })));
    addCheck(result, "opencli.inventory", "info", "passed", { phase: "adapter-probe", details: { count: result.adapters.length } });
    result.ok = validation.result.ok;
    result.checks.push(...validation.result.checks.filter((check) => !result.checks.some((existing) => existing.id === check.id)));
    if (!result.ok) result.error = validation.result.error;
    return { result };
  } catch (error) {
    return { result: setFailure(result, error, { phase: error.phase ?? "adapter-probe", id: "opencli.inventory" }) };
  }
}

function packageFilter(source, relative) {
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.some((part) => ["node_modules", ".git", ".infolens-dev"].includes(part))) return false;
  if (relative === "adapter-integrity.json") return false;
  return true;
}

async function outputExists(filename) {
  try { await stat(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function runPack(packageRoot, deps, context, output, timeoutMs) {
  const manifest = await readManifest(packageRoot);
  const result = baseResult("pack", context.environment, manifest, packageRoot);
  addEnvironmentChecks(result);
  if (context.bootstrapError) return { result: setFailure(result, context.bootstrapError, { id: "environment.bootstrap" }) };
  if (context.targetError) return { result: setFailure(result, context.targetError, { phase: "arguments", checkId: "environment.target-host", id: "environment.target-host" }) };
  if (await outputExists(output)) return { result: setFailure(result, codedError("PACK_OUTPUT_EXISTS", `Pack output already exists: ${output}`, "pack", "pack.output"), { phase: "pack", checkId: "pack.output", id: "pack.output" }) };
  const relativeOutput = path.relative(packageRoot, output);
  if (!relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput)) return { result: setFailure(result, codedError("PACK_OUTPUT_INSIDE_SOURCE", "Pack output must be outside the source Plugin directory", "pack", "pack.output"), { phase: "pack", checkId: "pack.output", id: "pack.output" }) };

  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  let staging;
  let published = false;
  try {
    staging = await mkdtemp(path.join(parent, `.${path.basename(output)}.stage-`));
    await copyDirectoryContents(packageRoot, staging, packageFilter);
    const diagnosis = await runDoctor(staging, deps, context, timeoutMs);
    result.checks = diagnosis.result.checks;
    if (diagnosis.result.plugin) result.plugin = { ...diagnosis.result.plugin, sourcePath: packageRoot };
    for (const key of ["registrations", "health", "cleanup", "workspace"]) if (diagnosis.result[key] !== undefined) result[key] = diagnosis.result[key];
    if (!diagnosis.result.ok) {
      result.error = diagnosis.result.error;
      result.ok = false;
      return { result };
    }
    const integrity = {
      pluginId: diagnosis.result.plugin?.id ?? manifest?.id,
      version: diagnosis.result.plugin?.version ?? manifest?.version,
      adapters: (diagnosis.adapterScope?.adapters ?? []).map(({ id, version, sha256 }) => ({ id, version, sha256 })),
    };
    await writeFile(path.join(staging, "adapter-integrity.json"), `${JSON.stringify(integrity, null, 2)}\n`, "utf8");
    addCheck(result, "pack.integrity", "info", "passed", { phase: "integrity", details: { adapters: integrity.adapters.length } });
    await rename(staging, output);
    published = true;
    result.output = output;
    result.integrity = integrity;
    result.ok = true;
    addCheck(result, "pack.publish", "info", "passed", { phase: "publication" });
    return { result };
  } catch (error) {
    return { result: setFailure(result, error, { phase: error.phase ?? "pack", checkId: error.checkId ?? "pack.publish", id: error.checkId ?? "pack.publish" }) };
  } finally {
    if (!published && staging) await rm(staging, { recursive: true, force: true });
  }
}

function parseOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target-host-version" || value === "--timeout" || value === "--out") {
      if (index + 1 >= argv.length) throw codedError("INVALID_ARGUMENTS", `${value} requires a value`, "arguments");
      options[value.slice(2).replaceAll("-", "_")] = argv[++index];
    } else if (value.startsWith("--target-host-version=") || value.startsWith("--timeout=") || value.startsWith("--out=")) {
      const [name, ...rest] = value.slice(2).split("=");
      options[name.replaceAll("-", "_")] = rest.join("=");
    } else if (value.startsWith("--")) throw codedError("INVALID_ARGUMENTS", `Unknown option '${value}'`, "arguments");
    else positional.push(value);
  }
  return { options, positional };
}

function parseTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw codedError("INVALID_TIMEOUT", "Timeout must be a positive integer in milliseconds", "arguments");
  return Number(value);
}

async function main(argv) {
  const command = argv[0];
  let parsed;
  try { parsed = parseOptions(argv.slice(1)); }
  catch (error) { const result = baseResult(command ?? "unknown"); setFailure(result, error, { phase: "arguments", id: "arguments" }); return result; }
  const { options, positional } = parsed;
  let timeoutMs;
  try { timeoutMs = parseTimeout(options.timeout); }
  catch (error) { const result = baseResult(command ?? "unknown"); setFailure(result, error, { phase: "arguments", id: "arguments" }); return result; }

  const packagePosition = command === "adapters" ? positional[1] : positional[0];
  const packageRoot = path.resolve(packagePosition ?? process.cwd());
  const targetOption = options.target_host_version;
  let deps;
  try { deps = await loadDependencies(); }
  catch (error) {
    const result = baseResult(command ?? "unknown");
    return setFailure(result, error, { phase: "bootstrap", id: "environment.bootstrap" });
  }
  const context = await resolveContext(deps, targetOption);
  let outcome;
  try {
    if (command === "validate") outcome = await runValidate(packageRoot, deps, context);
    else if (command === "doctor") outcome = await runDoctor(packageRoot, deps, context, timeoutMs);
    else if (command === "pack") outcome = await runPack(packageRoot, deps, context, path.resolve(options.out ?? path.join(path.dirname(packageRoot), `${path.basename(packageRoot)}.infolens-plugin`)), timeoutMs);
    else if (command === "dev") outcome = await runDev(packageRoot, deps, context);
    else if (command === "adapters" && positional[0] === "list") outcome = await runListAdapters(packageRoot, deps, context);
    else {
      const result = baseResult(command ?? "unknown", context.environment);
      outcome = { result: setFailure(result, codedError("INVALID_ARGUMENTS", "Usage: infolens-plugin <validate|doctor|dev|pack|adapters list> [plugin-path]", "arguments"), { phase: "arguments", id: "arguments" }) };
    }
  } catch (error) {
    const result = baseResult(command ?? "unknown", context.environment, await readManifest(packageRoot), packageRoot);
    outcome = { result: setFailure(result, error, { phase: error.phase ?? "command", id: error.checkId ?? "command.failure" }) };
  }
  return outcome.result;
}

const result = await main(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
