import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForTarget(port, processOutput) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const target = targets.find((entry) => entry.type === "page" && entry.url.startsWith("file:"));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await delay(100);
  }
  throw new Error(`Packaged renderer did not expose a DevTools target:\n${processOutput()}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  command(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(expression, sessionId) {
    const result = await this.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  async evaluateTarget(urlPart, expression) {
    const targets = await this.command("Target.getTargets");
    const target = targets.targetInfos.find((entry) => entry.url.includes(urlPart));
    if (!target) return undefined;
    const { sessionId } = await this.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    try { return await this.evaluate(expression, sessionId); }
    finally { await this.command("Target.detachFromTarget", { sessionId }).catch(() => {}); }
  }

  close() { this.socket.close(); }
}

export async function launchPackagedApp(root, environment = {}) {
  const executable = path.join(root, "release", "infolens-win32-x64", "Infolens.exe");
  const port = await availablePort();
  const child = spawn(executable, [`--remote-debugging-port=${port}`, "--no-first-run"], {
    cwd: path.dirname(executable),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const target = await waitForTarget(port, () => output);
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();

  async function stop() {
    try { await cdp.evaluate("window.close(); true"); } catch {}
    cdp.close();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      await Promise.race([exited, delay(5_000)]);
    }
    if (child.exitCode === null) child.kill();
  }
  return { child, cdp, output: () => output, stop };
}

export async function waitFor(check, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}
