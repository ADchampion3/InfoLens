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
import { createPreviewSession } from "../src/preview.mjs";

const require = createRequire(import.meta.url);
const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryFallbackRoot = path.resolve(sdkRoot, "../../resources/opencli");
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PLUGIN_VERSION = "0.1.0";
let activePreviewSession;
let previewSignalReason;
let previewSignalStop;
const HELP_TEXT = `Infolens Plugin Author CLI

Usage:
  infolens-plugin <command> [plugin-path] [options]

Commands:
  init <path>                 Create a minimal framework-neutral Plugin package
  validate <path>             Check the package contract without activation
  doctor <path>               Check lifecycle, health, cleanup, and Workspace assets
  dev <path>                  Prepare the development Adapter Scope
  preview <path>              Run an isolated Runtime and serve the Workspace
  adapters list <path>        List bundled and Provided OpenCLI Adapters
  pack <path>                 Validate and publish a staged Plugin package
  publish <path>              Pack and publish an immutable Market release
  help                        Show this help

Options:
  --format <json|text>        Output JSON (default) or a human-readable summary
  --target-host-version <v>  Override only the Minimum Host Version comparison
  --timeout <milliseconds>   Set the doctor phase timeout (default: 10000)
  --out <path>                Output package path for pack
  --registry-root <path>      Local static Registry directory for publish
  --publisher <name>          Publisher name for publish metadata
  --approved-by <name>        Maintainer approval name for publish metadata
  --license <name>            License identifier for publish metadata
  --category <name>           Category for publish metadata
  --description <text>        Description for publish metadata
  --changelog <text>          Changelog for publish metadata
  --platform <name>           Target platform for publish metadata
  --arch <name>               Target architecture for publish metadata
  --index-url <url>           Official Registry index URL for publish metadata

Path defaults:
  Omitted plugin paths default to the current directory
  pack defaults to a sibling <plugin-directory>.infolens-plugin path

JSON contract:
  Stable fields include ok, command, environment, checks, and error identity

Init options:
  --id <id>                   Override the ID inferred from the target directory
  --name <name>               Override the display name inferred from the ID
  --check                     Run doctor after creating the package

Examples:
  infolens-plugin init .\\my-plugin --check --format text
  infolens-plugin doctor . --format text
  infolens-plugin pack . --out ..\\my-plugin.infolens-plugin
  infolens-plugin publish . --registry-root .\\market-registry --approved-by "Infolens Maintainer"

Operational commands return stable JSON by default. Use --format text for a
compact summary with failed check IDs, codes, phases, and next actions.
Preview runs in the foreground, watches package files, and restarts its
isolated Runtime after changes. Press Ctrl+C or type shutdown to stop it.
`;

function codedError(code, message, phase = "bootstrap", checkId) {
  const error = new Error(message);
  error.code = code;
  error.phase = phase;
  if (checkId) error.checkId = checkId;
  return error;
}

function requestPreviewStop(reason) {
  previewSignalReason ??= reason;
  if (!activePreviewSession) return;
  previewSignalStop ??= activePreviewSession.stop(reason).catch(() => {});
  return previewSignalStop;
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

function environmentSummary(environment) {
  return [
    ["Contract", environment?.contractVersion?.value],
    ["Host", environment?.targetHost?.value],
    ["OpenCLI", environment?.opencli?.value],
  ].map(([label, value]) => `${label} ${value ?? "unresolved"}`).join(" / ");
}

function checkLabel(check) {
  const identity = [check.id ?? check.checkId, check.code, check.phase].filter(Boolean).join(" / ");
  return identity || "unknown check";
}

function checkAdvice(check) {
  if (check.phase === "workspace" || String(check.code ?? "").startsWith("WORKSPACE_")) return "Inspect the referenced local Workspace asset and rerun doctor.";
  if (check.phase === "adapter-probe" || check.id === "plugin.adapters") return "Run adapters list and check the declared Adapter Scope.";
  if (check.phase === "activation" || check.phase === "health" || check.phase === "cleanup") return "Inspect Backend activation and cleanup, then rerun doctor.";
  if (check.phase === "bootstrap") return "Check the resolved Host, Contract, and Bundled OpenCLI environment.";
  return "Inspect the check details in JSON output and rerun the command.";
}

function defaultNextActions(result) {
  const packagePath = result.plugin?.path ?? ".";
  if (!result.ok) return [];
  if (result.command === "validate") return [`npm run plugin -- doctor ${packagePath} --format text`];
  if (result.command === "doctor") return [`npm run plugin -- pack ${packagePath} --out ${path.join(path.dirname(packagePath), `${result.plugin?.id ?? "my-plugin"}.infolens-plugin`)}`];
  if (result.command === "adapters list") return [`npm run plugin -- doctor ${packagePath} --format text`];
  return [];
}

function formatText(result) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const passed = checks.filter((check) => check.status === "passed").length;
  const warnings = checks.filter((check) => check.severity === "warning").length;
  const failures = checks.filter((check) => check.severity === "error" && check.status === "failed");
  const lines = [`${result.command}: ${result.ok ? "passed" : "failed"}`];

  if (result.plugin) lines.push(`Plugin: ${result.plugin.name ?? result.plugin.id ?? "unknown"} (${result.plugin.id ?? "unknown"})`);
  lines.push(`Environment: ${environmentSummary(result.environment)}`);
  if (result.preview) {
    lines.push(`Workspace: ${result.preview.workspaceUrl}`);
    lines.push(`API: ${result.preview.apiBaseUrl}`);
    lines.push(`Health: ${result.preview.healthUrl}`);
    lines.push(`Watch: ${result.preview.watch ? "enabled" : "unavailable"}`);
  }
  if (result.created?.length) lines.push(`Created: ${result.created.join(", ")}`);
  if (result.output) lines.push(`Output: ${result.output}`);
  lines.push(`Checks: ${passed} passed, ${warnings} warning(s), ${failures.length} error(s)`);

  for (const check of failures) {
    lines.push(`ERROR ${checkLabel(check)}: ${check.message ?? result.error?.message ?? "check failed"}`);
    lines.push(`  Next: ${checkAdvice(check)}`);
  }
  for (const check of checks.filter((entry) => entry.severity === "warning")) {
    lines.push(`WARN ${checkLabel(check)}: ${check.message ?? "warning reported"}`);
  }
  if (!failures.length && result.error) {
    lines.push(`ERROR ${checkLabel(result.error)}: ${result.error.message}`);
    lines.push(`  Next: Inspect the command error and rerun it after fixing the reported input.`);
  }
  for (const next of result.next?.length ? result.next : defaultNextActions(result)) lines.push(`Next: ${next}`);
  return `${lines.join("\n")}\n`;
}

async function readManifest(packageRoot) {
  try { return JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8")); }
  catch { return undefined; }
}

async function loadDependencies() {
  const [release, contract, opencli, scope, workspace, market] = await Promise.all([
    import("@infolens/release-metadata"),
    import("@infolens/plugin-runtime/contract"),
    import("@infolens/plugin-runtime/opencli-adapter"),
    import("@infolens/plugin-runtime/adapter-scope"),
    import("@infolens/plugin-runtime/workspace-diagnostics"),
    import("@infolens/plugin-market"),
  ]);
  return { release, contract, opencli, scope, workspace, market };
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

function initPluginId(value, packageRoot) {
  const inferred = path.basename(packageRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const id = value === undefined ? inferred : String(value).trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw codedError("INVALID_INIT_ID", `Plugin ID '${id}' must contain lowercase letters, numbers, and hyphens`, "init", "init.identity");
  }
  return id;
}

function initPluginName(value, id) {
  const name = value === undefined
    ? id.split("-").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ")
    : String(value).trim();
  if (!name) throw codedError("INVALID_INIT_NAME", "Plugin name must not be empty", "init", "init.identity");
  return name;
}

async function ensureEmptyInitDirectory(packageRoot) {
  try {
    const entries = await readdir(packageRoot);
    if (entries.length) throw codedError("INIT_DIRECTORY_NOT_EMPTY", `Init target is not empty: ${packageRoot}`, "init", "init.directory");
  } catch (error) {
    if (error.code === "ENOENT") {
      await mkdir(packageRoot, { recursive: true });
      return;
    }
    if (error.code === "INIT_DIRECTORY_NOT_EMPTY") throw error;
    if (error.code === "ENOTDIR") throw codedError("INIT_TARGET_NOT_DIRECTORY", `Init target is not a directory: ${packageRoot}`, "init", "init.directory");
    throw error;
  }
}

function initFiles({ id, name, contractVersion, minHostVersion }) {
  const manifest = {
    id,
    name,
    version: DEFAULT_PLUGIN_VERSION,
    contractVersion: String(contractVersion),
    minHostVersion,
    backend: { entry: "backend/index.mjs" },
    ui: { entry: "web/dist/index.html" },
    openCliAdapters: {},
    openCliCommands: {},
  };
  const packageManifest = {
    name: `infolens-plugin-${id}`,
    version: DEFAULT_PLUGIN_VERSION,
    private: true,
    type: "module",
    scripts: {
      validate: "infolens-plugin validate . --format text",
      doctor: "infolens-plugin doctor . --format text",
      dev: "infolens-plugin dev . --format text",
      preview: "infolens-plugin preview . --format text",
      pack: "infolens-plugin pack . --format text",
    },
  };
  const backend = `export async function activate(context) {
  context.setHealth({ state: "ready" });
  context.route("GET", "/summary", () => ({
    pluginId: context.pluginId,
    message: "Plugin scaffold is ready",
  }));
}
`;
  const workspace = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${name}</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <main id="app" aria-live="polite">
      <h1>${name}</h1>
      <p>Loading Plugin API...</p>
    </main>
    <script type="module" src="./workspace.js"></script>
  </body>
</html>
`;
  const workspaceScript = `import { workspaceRuntimeConfig } from "/runtime/plugin-sdk.js";

const app = document.querySelector("#app");
const { apiBaseUrl } = workspaceRuntimeConfig();

try {
  const response = await fetch(new URL("summary", apiBaseUrl));
  if (!response.ok) throw new Error("Plugin API returned " + response.status);
  const summary = await response.json();
  app.querySelector("p").textContent = summary.message ?? "Plugin API is ready";
} catch (error) {
  app.querySelector("p").textContent = String(error);
}
`;
  const styles = `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
  background: #f6f7f9;
  color: #1f2933;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
}

main {
  width: min(32rem, calc(100% - 3rem));
  padding: 2rem;
  border: 1px solid #cbd5e1;
  background: #ffffff;
}

p {
  color: #52606d;
}
`;
  return [
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["package.json", `${JSON.stringify(packageManifest, null, 2)}\n`],
    ["backend/index.mjs", backend],
    ["web/dist/index.html", workspace],
    ["web/dist/workspace.js", workspaceScript],
    ["web/dist/styles.css", styles],
  ];
}

async function writeInitFiles(packageRoot, files) {
  for (const [relative, contents] of files) {
    const filename = path.join(packageRoot, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents, { encoding: "utf8", flag: "wx" });
  }
}

async function runInit(packageRoot, deps, context, { id: requestedId, name: requestedName, check = false, timeoutMs }) {
  const result = baseResult("init", context.environment, undefined, packageRoot);
  addEnvironmentChecks(result);
  if (context.bootstrapError) return { result: setFailure(result, context.bootstrapError, { id: "environment.bootstrap" }) };
  if (context.targetError) return { result: setFailure(result, context.targetError, { phase: "arguments", checkId: "environment.target-host", id: "environment.target-host" }) };

  try {
    const id = initPluginId(requestedId, packageRoot);
    const name = initPluginName(requestedName, id);
    const files = initFiles({ id, name, contractVersion: context.metadata.contractVersion, minHostVersion: context.metadata.hostVersion });
    await ensureEmptyInitDirectory(packageRoot);
    await writeInitFiles(packageRoot, files);

    const manifest = JSON.parse(files.find(([relative]) => relative === "manifest.json")[1]);
    result.plugin = pluginIdentity(manifest, packageRoot);
    result.created = files.map(([relative]) => relative);
    result.next = [
      `npm run plugin -- doctor ${packageRoot} --format text`,
      `npm run plugin -- pack ${packageRoot} --out ${path.join(path.dirname(packageRoot), `${id}.infolens-plugin`)}`,
    ];
    const scaffoldCheck = { id: "init.scaffold", severity: "info", status: "passed", phase: "init", details: { files: result.created } };
    if (check) {
      const diagnosis = await runDoctor(packageRoot, deps, context, timeoutMs);
      result.checked = true;
      result.checks = [...diagnosis.result.checks, scaffoldCheck];
      for (const key of ["health", "registrations", "cleanup", "workspace"]) {
        if (diagnosis.result[key] !== undefined) result[key] = diagnosis.result[key];
      }
      result.ok = diagnosis.result.ok;
      if (diagnosis.result.error) result.error = diagnosis.result.error;
    } else {
      result.checks.push(scaffoldCheck);
      result.ok = true;
    }
    return { result };
  } catch (error) {
    return { result: setFailure(result, error, { phase: error.phase ?? "init", checkId: error.checkId ?? "init.scaffold", id: error.checkId ?? "init.scaffold" }) };
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

async function runPreview(packageRoot, deps, context, timeoutMs) {
  const validation = await validatePackage(packageRoot, deps, context, { command: "preview" });
  const result = validation.result;
  if (!validation.validated || !result.ok) return { result };

  const session = createPreviewSession({
    packageRoot,
    pluginId: validation.validated.manifest.id,
    sdkRoot,
    runtimePackageRoot: runtimePackageRoot(),
    bundledOpenCliRoot: context.runtime.distributionRoot,
    timeoutMs,
  });
  activePreviewSession = session;
  if (previewSignalReason) {
    await requestPreviewStop(previewSignalReason);
    return { result, session };
  }
  try {
    result.preview = await session.start();
    addCheck(result, "preview.runtime", "info", "passed", { phase: "runtime-start", details: { origin: result.preview.origin } });
    addCheck(result, "preview.workspace", "info", "passed", { phase: "runtime-start", details: { workspaceUrl: result.preview.workspaceUrl } });
    result.ok = true;
    return { result, session };
  } catch (error) {
    if (error.code === "PREVIEW_STOPPED" && previewSignalReason) return { result, session };
    activePreviewSession = undefined;
    return { result: setFailure(result, error, { phase: error.phase ?? "preview", checkId: "preview.runtime", id: "preview.runtime" }) };
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

async function runPublish(packageRoot, deps, context, options, timeoutMs) {
  const manifest = await readManifest(packageRoot);
  const result = baseResult("publish", context.environment, manifest, packageRoot);
  addEnvironmentChecks(result);
  if (context.bootstrapError) return { result: setFailure(result, context.bootstrapError, { id: "environment.bootstrap" }) };
  if (context.targetError) return { result: setFailure(result, context.targetError, { phase: "arguments", checkId: "environment.target-host", id: "environment.target-host" }) };
  if (!manifest?.id || !manifest.version) return { result: setFailure(result, codedError("INVALID_PACKAGE", "publish requires a readable Plugin manifest", "publish", "plugin.manifest"), { phase: "publish", checkId: "plugin.manifest", id: "plugin.manifest" }) };
  const registryRoot = path.resolve(options.registry_root ?? path.join(process.cwd(), "market-registry"));
  const stagingParent = await mkdtemp(path.join(os.tmpdir(), "infolens-market-publish-"));
  const stagedPackage = path.join(stagingParent, `${manifest.id}.infolens-plugin`);
  try {
    const packed = await runPack(packageRoot, deps, context, stagedPackage, timeoutMs);
    result.checks = packed.result.checks;
    for (const key of ["plugin", "registrations", "health", "cleanup", "workspace", "integrity"]) if (packed.result[key] !== undefined) result[key] = packed.result[key];
    if (!packed.result.ok) {
      result.error = packed.result.error;
      return { result };
    }
    const publisher = options.publisher ?? "Infolens Maintainer";
    const release = await deps.market.publishMarketRelease({
      packageRoot: stagedPackage,
      registryRoot,
      manifest: packed.result.plugin ? { ...manifest, ...packed.result.plugin } : manifest,
      indexUrl: options.index_url,
      metadata: {
        description: options.description ?? manifest.description ?? `${manifest.name} Plugin`,
        publisher,
        approval: {
          approvedBy: options.approved_by,
          approvedAt: new Date().toISOString(),
          publisher,
        },
        license: options.license ?? "UNLICENSED",
        categories: [options.category ?? "General"],
        changelog: options.changelog ?? "Initial stable release",
        platforms: [options.platform ?? (process.platform === "win32" ? "windows" : process.platform)],
        architectures: [options.arch ?? (process.arch === "x64" ? "x64" : process.arch)],
      },
    });
    result.release = release.release;
    result.artifact = { path: release.artifactPath, size: release.release.artifact.size, sha256: release.release.artifact.sha256 };
    result.registryRoot = registryRoot;
    result.ok = true;
    addCheck(result, "market.archive", "info", "passed", { phase: "publication", details: { size: release.release.artifact.size, sha256: release.release.artifact.sha256 } });
    addCheck(result, "market.registry", "info", "passed", { phase: "publication", details: { registryRoot } });
    return { result };
  } catch (error) {
    return { result: setFailure(result, error, { phase: error.phase ?? "publish", checkId: error.checkId ?? "market.registry", id: error.checkId ?? "market.registry" }) };
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

function parseOptions(argv) {
  const options = {};
  const positional = [];
  const valueOptions = new Set(["target-host-version", "timeout", "out", "format", "id", "name", "registry-root", "publisher", "approved-by", "license", "category", "description", "changelog", "platform", "arch", "index-url"]);
  const flagOptions = new Set(["check"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const optionName = value.startsWith("--") ? value.slice(2).split("=", 1)[0] : undefined;
    if (optionName && valueOptions.has(optionName) && !value.includes("=")) {
      if (index + 1 >= argv.length) throw codedError("INVALID_ARGUMENTS", `${value} requires a value`, "arguments");
      options[optionName.replaceAll("-", "_")] = argv[++index];
    } else if (optionName && valueOptions.has(optionName) && value.includes("=")) {
      options[optionName.replaceAll("-", "_")] = value.slice(value.indexOf("=") + 1);
    } else if (optionName && flagOptions.has(optionName)) {
      options[optionName.replaceAll("-", "_")] = true;
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

function parseFormat(value) {
  if (value === undefined || value === "json") return "json";
  if (value === "text") return "text";
  throw codedError("INVALID_FORMAT", `Format must be 'json' or 'text', received '${value}'`, "arguments");
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv.includes("--help")) return { help: true };
  const command = argv[0];
  let parsed;
  try { parsed = parseOptions(argv.slice(1)); }
  catch (error) { const result = baseResult(command ?? "unknown"); setFailure(result, error, { phase: "arguments", id: "arguments" }); return { result, format: "json" }; }
  const { options, positional } = parsed;
  let outputFormat;
  try { outputFormat = parseFormat(options.format); }
  catch (error) { const result = baseResult(command ?? "unknown"); setFailure(result, error, { phase: "arguments", id: "arguments" }); return { result, format: "json" }; }
  let timeoutMs;
  try { timeoutMs = parseTimeout(options.timeout); }
  catch (error) { const result = baseResult(command ?? "unknown"); setFailure(result, error, { phase: "arguments", id: "arguments" }); return { result, format: outputFormat }; }

  if (command !== "init" && (options.id !== undefined || options.name !== undefined || options.check)) {
    const result = baseResult(command ?? "unknown");
    setFailure(result, codedError("INVALID_ARGUMENTS", "--id, --name, and --check are only valid for init", "arguments"), { phase: "arguments", id: "arguments" });
    return { result, format: outputFormat };
  }
  if (command === "init" && positional.length !== 1) {
    const result = baseResult(command);
    setFailure(result, codedError("INVALID_ARGUMENTS", "Usage: infolens-plugin init <path> [--id <id>] [--name <name>] [--check] [--format <json|text>]", "arguments"), { phase: "arguments", id: "arguments" });
    return { result, format: outputFormat };
  }

  const packagePosition = command === "adapters" ? positional[1] : positional[0];
  const packageRoot = path.resolve(packagePosition ?? process.cwd());
  const targetOption = options.target_host_version;
  let deps;
  try { deps = await loadDependencies(); }
  catch (error) {
    const result = baseResult(command ?? "unknown");
    return { result: setFailure(result, error, { phase: "bootstrap", id: "environment.bootstrap" }), format: outputFormat };
  }
  const context = await resolveContext(deps, targetOption);
  let outcome;
  try {
    if (command === "init") outcome = await runInit(packageRoot, deps, context, { id: options.id, name: options.name, check: options.check, timeoutMs });
    else if (command === "validate") outcome = await runValidate(packageRoot, deps, context);
    else if (command === "doctor") outcome = await runDoctor(packageRoot, deps, context, timeoutMs);
    else if (command === "pack") outcome = await runPack(packageRoot, deps, context, path.resolve(options.out ?? path.join(path.dirname(packageRoot), `${path.basename(packageRoot)}.infolens-plugin`)), timeoutMs);
    else if (command === "publish") outcome = await runPublish(packageRoot, deps, context, options, timeoutMs);
    else if (command === "dev") outcome = await runDev(packageRoot, deps, context);
    else if (command === "preview") outcome = await runPreview(packageRoot, deps, context, timeoutMs);
    else if (command === "adapters" && positional[0] === "list") outcome = await runListAdapters(packageRoot, deps, context);
    else {
      const result = baseResult(command ?? "unknown", context.environment);
      outcome = { result: setFailure(result, codedError("INVALID_ARGUMENTS", "Usage: infolens-plugin <init|validate|doctor|dev|preview|pack|publish|adapters list> [plugin-path]", "arguments"), { phase: "arguments", id: "arguments" }) };
    }
  } catch (error) {
    const result = baseResult(command ?? "unknown", context.environment, await readManifest(packageRoot), packageRoot);
    outcome = { result: setFailure(result, error, { phase: error.phase ?? "command", id: error.checkId ?? "command.failure" }) };
  }
  return { result: outcome.result, format: outputFormat, session: outcome.session };
}

const previewCommand = process.argv[2] === "preview";
const onPreviewSignal = () => { void requestPreviewStop("signal"); };
const onPreviewInput = (chunk) => {
  if (String(chunk).split(/\r?\n/).some((line) => line.trim() === "shutdown")) requestPreviewStop("input");
};
if (previewCommand) {
  process.once("SIGINT", onPreviewSignal);
  process.once("SIGTERM", onPreviewSignal);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onPreviewInput);
}
const outcome = await main(process.argv.slice(2));
if (outcome.help) {
  process.stdout.write(HELP_TEXT);
} else {
  const result = outcome.result;
  process.stdout.write(outcome.format === "text" ? formatText(result) : `${JSON.stringify(result, null, 2)}\n`);
  if (outcome.session) {
    const stopped = await outcome.session.wait();
    activePreviewSession = undefined;
    if (stopped.code !== 0) {
      if (stopped.error) process.stderr.write(`[preview] ${stopped.error.message}\n`);
      process.exitCode = stopped.code ?? 1;
    }
  } else if (!result.ok) process.exitCode = 1;
}
if (previewCommand) {
  process.stdin.off("data", onPreviewInput);
  process.off("SIGINT", onPreviewSignal);
  process.off("SIGTERM", onPreviewSignal);
  if (previewSignalReason && !outcome.session && !outcome.result?.error) process.exitCode = 130;
}
