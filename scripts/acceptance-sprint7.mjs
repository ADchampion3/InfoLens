import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const profile = path.join(root, ".infolens-acceptance", "sprint7");
const stateFile = path.join(profile, "opencli-state.json");
const executable = path.join(root, "release", "infolens-win32-x64", "Infolens.exe");
await mkdir(profile, { recursive: true });
await writeFile(stateFile, `${JSON.stringify({ producthunt: "success" }, null, 2)}\n`, "utf8");

const child = spawn(executable, [], {
  cwd: path.dirname(executable),
  env: {
    ...process.env,
    INFOLENS_USER_DATA_ROOT: profile,
    INFOLENS_BUNDLED_OPENCLI_ROOT: path.join(root, "tests", "fixtures", "sprint5", "opencli"),
    INFOLENS_TEST_OPENCLI_STATE: stateFile,
  },
  stdio: "inherit",
  windowsHide: false,
});
process.stdout.write(`Sprint 7 release candidate started.\nProfile: ${profile}\nInstall fixture: ${path.join(root, "tests", "fixtures", "sprint6", "installable-plugin")}\n`);
child.once("exit", (code) => { process.exitCode = code ?? 0; });
