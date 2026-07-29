import path from "node:path";
import { createOpenCliAdapter } from "../../../packages/plugin-runtime/src/opencli-adapter.mjs";

const executablePath = path.join(import.meta.dirname, "electron-command-cli.mjs");
const adapter = createOpenCliAdapter({ executablePath });
const result = await adapter.run({ command: ["fixture"] }, ["read"]);
process.stdout.write(JSON.stringify(result));
