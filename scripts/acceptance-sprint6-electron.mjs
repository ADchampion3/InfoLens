import { spawn } from "node:child_process";
import path from "node:path";
import { prepareSprint6Profile, root, sprint6Environment } from "./sprint6-profile.mjs";

await prepareSprint6Profile();
const executable = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");
const child = spawn(executable, [root], { cwd: root, env: sprint6Environment(), stdio: "inherit", windowsHide: false });
child.on("exit", (code) => process.exit(code ?? 0));
