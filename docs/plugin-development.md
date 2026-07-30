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
infolens-plugin validate .
infolens-plugin dev .
infolens-plugin adapters list .
infolens-plugin pack . --out ..\my-plugin.infolens-plugin
```

Inside the Infolens source workspace, use `npm run plugin -- <command> ...` before the SDK package has been installed as a dependency.

`validate` runs an isolated registration probe. `dev` creates `.infolens-dev/opencli-adapters` with a linked development Scope (junctions and hard links on Windows). `pack` validates again, copies a self-contained package, and writes `adapter-integrity.json`. The output path must not already exist.
