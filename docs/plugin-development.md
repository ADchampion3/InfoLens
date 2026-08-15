# Plugin Development

Plugin Contract Version 2 supports standard OpenCLI plugins under an Infolens plugin package:

```text
my-plugin/
  manifest.json
  backend/
  web/
  opencli-adapters/
    source/
      opencli-plugin.json
      package.json
      command.js
```

Adapter JavaScript imports only Node built-ins, relative files, and OpenCLI public exports such as `@jackwener/opencli/registry`. Bundle other production dependencies before validation. Do not include `node_modules`, TypeScript-only commands, lifecycle hooks, or install scripts.

```powershell
infolens-plugin help
infolens-plugin init . --check --format text
infolens-plugin validate .
infolens-plugin doctor . --timeout 10000
infolens-plugin dev .
infolens-plugin preview . --format text
infolens-plugin adapters list .
infolens-plugin pack . --out ..\my-plugin.infolens-plugin
```

Inside the Infolens source workspace, use `npm run plugin -- <command> ...` before the SDK package has been installed as a dependency. An independent project resolves the installed `@infolens/plugin-sdk`, `@infolens/release-metadata`, and `@infolens/bundled-opencli` package boundaries; it does not need the Infolens repository tree.

`validate` is the fast package-contract gate. It checks the Manifest, required files, command mappings, and Provided OpenCLI Adapter Scope without importing or activating the Plugin Backend Module. `doctor` includes those checks, then imports and activates the real Backend in a temporary Plugin Runtime, records routes, tasks, and schedules, checks Plugin Health, runs cleanup, and walks the static Workspace Bundle graph. `pack` filters the exact package contents into a unique staging directory and runs the complete `doctor` gate against that staged directory before writing `adapter-integrity.json` and publishing it by atomic rename. An existing output path is rejected.

The commands are layered: `validate` is the contract subset, `doctor` is the lifecycle and Workspace superset, `preview` is the foreground author loop, and `pack` is a staged `doctor` plus integrity and publication. Warnings and informational findings are included in the JSON result but do not fail a command; error findings produce a nonzero exit status. The stable automation fields are `ok`, `command`, `environment`, `checks`, and `error.code`/`error.phase`/`error.checkId`. Human messages and resolved filesystem paths are diagnostic details.

All author commands report the resolved Plugin Contract Version, target Host version, and Bundled OpenCLI version with their logical source and, where available, a source path. `--target-host-version <semver>` changes only the Minimum Host Version comparison and reports `cli-option` as its source. It cannot change the supported Contract Version or the command capabilities. `--timeout <ms>` applies to each doctor lifecycle phase and defaults to 10 seconds; `pack` passes the same value to its staged doctor.

Doctor uses temporary Plugin, data, Host State, Managed Adapter Store, and Adapter Scope roots and loads only the target package. This is state and lifecycle isolation, not a Node or operating-system security sandbox: trusted Backend code remains ordinary Node code and can use filesystem, network, environment, or subprocess APIs. Doctor never starts Electron, opens a browser, executes Workspace JavaScript, invokes OpenCLI during activation, arms schedules, or runs tasks.

`dev` uses the same environment resolution and creates `.infolens-dev/opencli-adapters` with a linked development Scope (junctions and hard links on Windows). `adapters list` reports the same Bundled OpenCLI inventory and Provided Adapter Scope used by the other commands. The `INFOLENS_BUNDLED_OPENCLI_ROOT` environment variable is available for controlled fixtures and its override path is reported in the result.

## Scaffold a Plugin

Use `init` to create a minimal framework-neutral package. From the Infolens
source workspace, run:

~~~powershell
npm run plugin -- init path\to\my-plugin --check --format text
~~~

The target directory must be empty or absent. The command infers a lowercase
hyphenated Plugin ID from the directory name; use `--id <id>` and
`--name <name>` to override it. It creates `manifest.json`, `package.json`, an
ESM Backend, and a static Workspace Bundle under `web/dist/` with
`index.html`, `workspace.js`, and `styles.css`. The generated package has
empty OpenCLI declarations and includes `validate`, `doctor`, `dev`, `preview`,
and `pack` scripts that call the `infolens-plugin` binary. The binary must be available
from the author environment; `init` does not add an SDK dependency or imply an
external package distribution workflow.

`--check` runs the full `doctor` command after writing the files. A failed check
returns a nonzero exit status but leaves the generated package in place for
inspection. `--format text` prints the Plugin identity, resolved environment,
check counts, failed check IDs/codes/phases, warnings, and next actions. JSON
remains the default for automation.

The generated Workspace calls the Plugin API through the Runtime mount. Its
dynamic API URL is reported as a `WORKSPACE_DYNAMIC_REFERENCE` warning by the
static Workspace diagnosis; this is expected because the URL is supplied by
the Host at runtime and does not make the package fail.

## Package Contract

An Infolens plugin is a trusted local package. The Host copies it into its
managed <code>plugins/</code> directory and loads the Backend in the Plugin
Runtime. The plugin owns its Backend behavior, persistent data, OpenCLI
mappings, and static Workspace. The Host owns discovery, lifecycle, task
scheduling, diagnostics, and the Runtime boundary.

The smallest useful package has this shape:

~~~text
my-plugin/
  package.json
  manifest.json
  backend/
    index.js
  web/
    dist/
      index.html
      workspace.js
      styles.css
  opencli-adapters/             # optional
    my-adapter/
      opencli-plugin.json
      package.json
      command.js
~~~

<code>manifest.json</code> must point to the files that will actually ship.
The Host does not compile TypeScript, start a frontend dev server, install
dependencies, or run package lifecycle scripts during installation. The
<code>pack</code> command removes <code>node_modules</code>, so Backend
dependencies must either be provided by the Host SDK or bundled into the
Backend output.

An independent project needs package boundaries for
<code>@infolens/plugin-sdk</code>, <code>@infolens/plugin-runtime</code>,
<code>@infolens/release-metadata</code>, and
<code>@infolens/bundled-opencli</code>. It does not need the Infolens repository
tree. Inside this repository, use <code>npm run plugin -- ...</code>.

### Manifest

Every package must contain a root <code>manifest.json</code>:

~~~json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "icon": "web/dist/icon.png",
  "contractVersion": "2",
  "minHostVersion": "0.2.0",
  "backend": { "entry": "backend/index.js" },
  "ui": { "entry": "web/dist/index.html" },
  "openCliAdapters": {},
  "openCliCommands": {
    "topStories": {
      "site": "hackernews",
      "adapter": "builtin",
      "command": ["hackernews", "top"],
      "strategy": "PUBLIC",
      "access": "read",
      "outputFormat": "json"
    }
  }
}
~~~

The validator requires:

- <code>id</code> to contain only lowercase letters, numbers, and hyphens,
  starting with a letter or number.
- <code>version</code> and <code>minHostVersion</code> to be semantic versions.
- <code>contractVersion</code> to equal the resolved supported Contract Version,
  currently the string <code>"2"</code>.
- <code>backend.entry</code> and <code>ui.entry</code> to be relative paths to
  existing files inside the package.
- <code>openCliAdapters</code> and <code>openCliCommands</code> to be objects,
  including empty objects when the plugin has no adapters or commands.

Each <code>openCliCommands</code> mapping is narrow by design. Its
<code>command</code> is a non-empty array of command path segments and cannot
contain options. <code>site</code> must equal the first command segment.
<code>access</code> must be <code>"read"</code>,
<code>outputFormat</code> must be <code>"json"</code>, and
<code>strategy</code> must be <code>PUBLIC</code>, <code>COOKIE</code>, or
<code>INTERCEPT</code>. <code>UI</code> is not supported by the current
contract.

Use <code>adapter: "builtin"</code> for a command in the bundled OpenCLI
inventory. Use a key from <code>openCliAdapters</code> for a command provided
by the plugin. The Backend calls the mapping by its manifest key, for example
<code>context.opencli.run("topStories")</code>.

A minimal plugin <code>package.json</code> is conventional Node metadata:

~~~json
{
  "name": "@example/infolens-plugin-my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@infolens/plugin-sdk": "0.1.0"
  }
}
~~~

The SDK exports <code>defineManifest</code> and TypeScript declarations for
typed source code, but the final package still needs the JSON manifest at its
root.

## Backend API

The Backend entry must export <code>activate(context)</code>:

~~~js
export async function activate(context) {
  // Register routes and tasks, load plugin-owned state, and set initial health.
  context.setHealth({ state: "ready" });
}
~~~

The activation context is:

| API | Contract |
| --- | --- |
| <code>pluginId</code> | The manifest plugin ID. |
| <code>dataDir</code> | The plugin's private persistent data directory. |
| <code>resolveDataPath(relativePath)</code> | Resolves a non-empty relative path below <code>dataDir</code>; absolute and escaping paths are rejected. |
| <code>route(method, path, handler)</code> | Registers a unique API route. <code>path</code> must start with <code>/</code>. |
| <code>task(name, handler)</code> | Registers a task. Names use letters, numbers, <code>.</code>, <code>_</code>, and <code>-</code>, and must be unique. |
| <code>enqueue(name, input, options)</code> | Queues a registered task and returns its result. <code>reason</code> and <code>coalesceKey</code> are supported. |
| <code>schedule(name, options)</code> | Runs a registered task periodically. Returns a cancellation function. |
| <code>setHealth(health)</code> | Publishes health state, badge, message, or refresh timestamp. |
| <code>setRefreshOptions(provider)</code> | Publishes validated refresh controls to the Host Workspace. |
| <code>logger</code> | Async <code>debug</code>, <code>info</code>, <code>warn</code>, and <code>error</code> methods. |
| <code>opencli.run(key, args, signal)</code> | Runs a manifest-declared OpenCLI command and returns JSON. |

Route handlers receive <code>{ method, url, headers, signal }</code>. The
current Plugin API does not expose a parsed request body. Use query parameters
or headers for route input, or add a parser in the Backend if the package
needs one. A normal return value is serialized as JSON. An unhandled route
error is logged, changes the plugin to a failed state, and returns HTTP 500.

Pass the request or task signal to long-running work and OpenCLI:

~~~js
export async function activate(context) {
  context.task("refresh", async (input, task) => {
    context.setHealth({ state: "refreshing" });
    try {
      const rows = await context.opencli.run(
        "topStories",
        ["--limit=30"],
        task.signal,
      );

      await saveRows(context.resolveDataPath("state.json"), rows);
      const completedAt = new Date().toISOString();
      context.setHealth({ state: "ready", lastSuccessfulRefresh: completedAt });
      return { ok: true, lastSuccessfulRefresh: completedAt };
    } catch (error) {
      context.setHealth({ state: "failed", message: String(error) });
      return { ok: false, code: "SOURCE_REFRESH_FAILED" };
    }
  });

  context.route("GET", "/summary", async () => {
    return readSummary(context.resolveDataPath("state.json"));
  });

  context.route("POST", "/refresh", () => {
    return context.enqueue("refresh", undefined, {
      reason: "manual",
      coalesceKey: "collection",
    });
  });
}
~~~

<code>saveRows</code> and <code>readSummary</code> are plugin functions, not
Host APIs. Validate external results before storing them and keep source schema
and migrations in the plugin-owned data directory.

### Tasks, schedules, and cleanup

There is one active task execution per plugin. Repeated enqueue requests with
the same task name and <code>coalesceKey</code> share the pending operation.
Tasks receive <code>{ signal, reason }</code> and should stop promptly when the
signal is aborted.

Schedules reference an already registered task and require
<code>intervalMs</code> of at least 100 milliseconds. Keep the cancellation
function and call it when settings change and from <code>deactivate</code>:

~~~js
let cancelSchedule;

function configureSchedule(context, intervalMs) {
  cancelSchedule?.();
  cancelSchedule = context.schedule("refresh", {
    intervalMs,
    reason: "schedule",
    coalesceKey: "collection",
  });
}

return {
  async deactivate() {
    cancelSchedule?.();
    await closePluginStore();
  },
};
~~~

The diagnostic <code>doctor</code> command records schedules but does not arm
timers, execute tasks, or call OpenCLI. This permits lifecycle checks without
contacting a source or changing plugin data.

Use <code>setHealth</code> during startup, refresh, and failure transitions.
The SDK health states are <code>ready</code>, <code>starting</code>,
<code>refreshing</code>, <code>failed</code>, <code>unavailable</code>, and
<code>disabled</code>. For a task named <code>refresh</code>, return
<code>{ ok: true }</code> for success and
<code>{ ok: false, code, message }</code> for an expected source failure.
An ordinary result without <code>ok</code> is treated as a completed refresh.
Preserve usable previous data when a source refresh fails.

<code>setRefreshOptions</code> can expose Host controls:

~~~js
context.setRefreshOptions(() => ({
  title: "Collection settings",
  fields: [
    {
      key: "limit",
      label: "Result limit",
      type: "number",
      min: 1,
      max: 50,
      default: 30,
    },
    {
      key: "includeRead",
      label: "Include read items",
      type: "boolean",
      default: false,
    },
  ],
}));
~~~

The current sanitizer accepts at most 8 fields. Field keys start with a
lowercase letter and may contain letters, numbers, <code>_</code>, or
<code>-</code>. Supported types are <code>select</code>, <code>text</code>,
<code>number</code>, and <code>boolean</code>.

## Static Workspace

<code>ui.entry</code> must point to a built static HTML file. The Host serves
that file and its local assets below:

~~~text
/plugins/&lt;plugin-id&gt;/workspace/
/plugins/&lt;plugin-id&gt;/api/
/plugins/&lt;plugin-id&gt;/health
~~~

The Workspace receives query parameters <code>pluginId</code>,
<code>apiBaseUrl</code>, and <code>theme</code>. Import the browser SDK from
the Runtime mount:

~~~js
import {
  observeWorkspaceTheme,
  workspaceRuntimeConfig,
  workspaceTheme,
} from "/runtime/plugin-sdk.js";

const { apiBaseUrl } = workspaceRuntimeConfig();
const request = (route, options) =>
  fetch(new URL(route.replace(/^\/+/, ""), apiBaseUrl), options).then((response) => {
    if (!response.ok) throw new Error("Plugin API returned " + response.status);
    return response.json();
  });

document.documentElement.dataset.theme = workspaceTheme();
observeWorkspaceTheme((theme) => {
  document.documentElement.dataset.theme = theme;
});

const summary = await request("summary");
document.querySelector("#app").textContent = JSON.stringify(summary);
~~~

The SDK also provides <code>pluginApiUrl</code>, <code>pluginHealthUrl</code>, and
<code>pluginWorkspaceUrl</code>. <code>downloadExport(route)</code> starts a
download from the current plugin API. <code>copyDownloadable(route)</code>
copies a text export from the same response after an explicit user action.
Allowed export formats are <code>json</code>, <code>csv</code>,
<code>markdown</code>, and <code>text</code>.

Every Workspace reference should be relative and local. Static diagnosis
follows HTML, JavaScript, and CSS references, handles cycles, and:

- fails on missing local files, absolute local paths, and references escaping
  the Workspace directory;
- reports external URLs and dynamic/computed references as warnings without
  fetching or executing them;
- reports <code>/runtime/</code> mounts as Host Runtime resources; and
- ignores source map references.

The Workspace is not executed by <code>doctor</code>. A passing static check
proves the staged asset graph is present, not that browser code renders
correctly.

## OpenCLI Integration

### Built-in commands

The manifest declares every command the Backend may use. The current bundled
inventory includes <code>hackernews top</code>,
<code>github-trending repos</code>, <code>zhihu whoami</code>, and
<code>zhihu hot</code>; the exact inventory is release-specific. Run
<code>adapters list</code> before selecting a built-in command.

~~~js
const result = await context.opencli.run(
  "topStories",
  ["--limit=30"],
  task.signal,
);
~~~

The Runtime appends <code>-f json</code> and disables user-global OpenCLI
discovery. Do not pass <code>--format</code>, <code>-f</code>, or another
format option. The command key must exist in <code>openCliCommands</code>.

<code>PUBLIC</code> commands use the public request pool. <code>COOKIE</code> and
<code>INTERCEPT</code> commands use the browser-dependent path and may require
a logged-in browser bridge during live use. The current contract does not
accept <code>UI</code> strategy.

### Plugin-provided adapters

A Provided Adapter is ready-to-run JavaScript shipped inside the plugin. Declare
it in the manifest:

~~~json
{
  "openCliAdapters": {
    "myAdapter": {
      "id": "io.example.my-source",
      "version": "1.0.0",
      "path": "opencli-adapters/my-adapter"
    }
  }
}
~~~

The adapter directory must contain an <code>opencli-plugin.json</code> whose
identity and version exactly match the declaration:

~~~json
{
  "name": "io.example.my-source",
  "version": "1.0.0",
  "description": "My source OpenCLI adapter",
  "opencli": ">=1.8.6 <2.0.0"
}
~~~

The adapter ID must use reverse-domain form. Its OpenCLI range must include
the bundled OpenCLI version. A <code>package.json</code> may document the API
as a peer dependency:

~~~json
{
  "name": "@example/opencli-my-source",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "peerDependencies": {
    "@jackwener/opencli": ">=1.8.6 <2.0.0"
  }
}
~~~

Adapter validation requires ready-to-run <code>.js</code> or <code>.mjs</code>
files, rejects <code>node_modules</code>, and rejects declared
<code>dependencies</code> or <code>optionalDependencies</code>. Bundle all
non-OpenCLI production dependencies into the JavaScript output. Use OpenCLI
public exports such as <code>@jackwener/opencli/registry</code>; do not
register <code>onStartup</code>, <code>onBeforeExecute</code>, or
<code>onAfterExecute</code> hooks.

Validation probes actual OpenCLI registration and rejects command collisions,
undeclared commands, strategy/access mismatches, and collisions with the
bundled inventory. <code>pack</code> writes
<code>adapter-integrity.json</code> with plugin identity and adapter hashes.
Do not edit that file by hand; installation checks it again.

## Author Workflow

Operational author commands print a JSON result by default and set a nonzero
exit code when <code>ok</code> is false. <code>help</code> prints human-readable
usage text. Add <code>--format text</code> to an operational command for a
compact author summary; JSON remains the automation contract. Automation should rely on <code>ok</code>,
<code>command</code>, <code>environment</code>, <code>checks</code>, and
<code>error.code</code>/<code>error.phase</code>/<code>error.checkId</code>.
Human messages and resolved paths are diagnostic details.

From this repository:

~~~powershell
npm run plugin -- help
npm run plugin -- init . --check --format text
npm run plugin -- validate .
npm run plugin -- doctor . --timeout 10000
npm run plugin -- adapters list .
npm run plugin -- dev .
npm run plugin -- pack . --out ..\my-plugin.infolens-plugin
~~~

From a project with the SDK installed, use the equivalent
<code>infolens-plugin</code> binary:

~~~powershell
infolens-plugin help
infolens-plugin init . --check --format text
infolens-plugin validate .
infolens-plugin doctor . --timeout 10000
infolens-plugin adapters list .
infolens-plugin dev .
infolens-plugin pack . --out ..\my-plugin.infolens-plugin
~~~

The generated package provides a short local workflow after the author CLI is
available:

~~~powershell
infolens-plugin init .\my-plugin
cd .\my-plugin
npm run doctor
npm run pack
~~~

### init

`init <path>` creates a new package without overwriting an existing file. The
default ID is derived from the target directory, the default display name is
derived from that ID, and the generated version is `0.1.0`. The command uses
the resolved Contract and Minimum Host versions from release metadata. A
`--target-host-version` override changes only the validation comparison; it
does not change the generated `minHostVersion`.

`init` is a repository-root author workflow in the current release. It does
not install dependencies, publish SDK packages, start Plugin Runtime, serve a
Workspace, or create a development link.

### validate

<code>validate</code> checks the manifest, entry files, Host and Contract
compatibility, built-in command availability, and Provided Adapter Scope. It
does not import or activate the Backend, execute routes, run tasks, or inspect
the Workspace graph.

### doctor

<code>doctor</code> runs <code>validate</code> and then starts a child Plugin
Runtime with temporary Plugin, data, Host State, Adapter Store, and Adapter
Scope roots. It imports and activates the real Backend, records route/task/
schedule registrations, checks Plugin Health, runs <code>deactivate</code>, and
diagnoses the static Workspace graph.

Diagnostic mode does not start Electron, open a browser, execute Workspace
JavaScript, arm schedules, run tasks, or invoke OpenCLI during activation. It is
lifecycle and state isolation, not a Node or operating-system security sandbox.
Backend code remains trusted ordinary Node code.

<code>--timeout &lt;milliseconds&gt;</code> applies to each doctor lifecycle phase
and defaults to 10 seconds. <code>pack</code> passes the same value to its
staged doctor.

### adapters list

<code>adapters list</code> performs the same contract and adapter probe as
<code>validate</code> and lists the bundled OpenCLI inventory together with the
plugin's Provided Adapters. Use it when a command is unavailable or an Adapter
range does not match.

### dev

<code>dev</code> validates the package and creates
<code>.infolens-dev/opencli-adapters</code> with a linked development Scope.
On Windows it uses junctions and hard links. It does not start the Plugin
Runtime, serve a Workspace, watch files, or provide hot reload. Remove the
generated directory before packaging; <code>pack</code> filters it automatically.

### preview

<code>preview</code> validates the package, copies a filtered snapshot into
temporary roots, and starts one isolated Plugin Runtime in the foreground. It
reports the same Plugin Workspace, Plugin API, and Plugin Health URL shape used
by the Host. The default command watches the source package and restarts the
Runtime from a fresh snapshot after a debounced change while preserving the
preview session's temporary data and loopback port.

~~~powershell
infolens-plugin preview . --format text
~~~

Press <code>Ctrl+C</code> or write <code>shutdown</code> to stdin to stop the
preview. Preview serves the built static Workspace Bundle; it does not compile
frontend source, execute Workspace JavaScript, render a browser, or verify a
real Browser Bridge session. It does not create a Development Link or change
the managed Plugin Directory, and <code>pack</code> never invokes it.

### pack

<code>pack</code> creates a unique staging directory beside the requested
output, copies the package while excluding <code>node_modules</code>,
<code>.git</code>, <code>.infolens-dev</code>, and any old
<code>adapter-integrity.json</code>, then runs the complete <code>doctor</code>
check against that exact staged content. It writes fresh adapter integrity
metadata and atomically renames the staging directory to the output only
after all error-level checks pass.

The output must be outside the source package and must not already exist. It is
a directory with an <code>.infolens-plugin</code> suffix, not a zip file.
Warnings remain visible but do not prevent publication. Failed staging is
cleaned up and does not publish a partial artifact.

## Install, Replace, and Release Checklist

The current Host supports both local package directories and local ZIP
archives. In the desktop app, choose the directory produced by <code>pack</code>
or use <code>Import ZIP</code> for a deterministic archive. The Host validates
the selected package, copies or safely extracts it into the managed plugin
directory, creates its Adapter Scope, and enables it. Archive imports reuse the
Market archive safety boundary but remain <code>local</code> provenance and do
not imply Registry approval. Installation does not follow the original source
directory after copying.

The package is trusted code, not a security sandbox. An existing plugin ID must
be removed before another package with the same ID is installed. Removal stops
tasks, calls <code>deactivate</code>, removes the managed package and
plugin-owned data, cleans its Adapter Scope, and removes its Host State entry.
Do not assume plugin data survives replacement; provide plugin-owned
export/import if users need data across incompatible versions.

Before handing a package to another user:

1. Build the Backend and static Workspace into the paths referenced by the
   manifest.
2. Ensure the Workspace has no missing or escaping local references.
3. Ensure every OpenCLI command is declared and every Provided Adapter has
   matching identity, version, range, and actual registration.
4. Run <code>validate</code>, <code>doctor</code>, and
   <code>adapters list</code> and inspect all error and warning checks.
5. Run <code>pack</code> to a new output path and inspect
   <code>adapter-integrity.json</code>.
6. Install the packed directory into a clean local Host profile and exercise
   refresh, failure-retention, settings, and cleanup paths.
7. For <code>COOKIE</code> or <code>INTERCEPT</code>, separately verify the real
   browser bridge and login state. Credential-free <code>doctor</code> cannot
   replace that live-source test.

Source-level checks for this repository are:

~~~powershell
npm run typecheck:sdk
npm run verify:release
npm run package:release
~~~

These verify SDK types, release metadata, and package boundaries. They do not
render or interact with a Workspace. See
<code>packages/plugin-sdk/src/index.d.ts</code>,
<code>packages/plugin-runtime/src/contract.mjs</code>, and
<code>packages/plugin-sdk/bin/infolens-plugin.mjs</code> when the guide and an
installed Host disagree.
