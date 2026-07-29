import { pathToFileURL } from "node:url";

const entryPath = process.argv[2];
if (!entryPath) throw new Error("Electron Node launcher requires a module entry path");

process.argv.splice(1, 1);
delete process.versions.electron;
await import(pathToFileURL(entryPath).href);
