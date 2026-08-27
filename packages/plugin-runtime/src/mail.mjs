import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import tls from "node:tls";

export const SMTP_SECURITY = Object.freeze(["starttls", "tls"]);
export const MAIL_SECRET_VERSION = 1;
export const SMTP_TIMEOUTS = Object.freeze({ connectMs: 10_000, commandMs: 30_000 });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function mailError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function safeHeader(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.includes("\r") || normalized.includes("\n") || normalized.length > 998) {
    throw mailError("INVALID_MAIL", field + " is invalid");
  }
  return normalized;
}

function email(value, field) {
  const normalized = safeHeader(value, field);
  if (!EMAIL_RE.test(normalized)) throw mailError("INVALID_MAIL", field + " must be an email address");
  return normalized;
}

export function normalizeMailSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw mailError("INVALID_MAIL", "Mail settings must be an object");
  const host = safeHeader(input.host ?? input.smtpHost, "SMTP host");
  if (host.length > 253 || host.includes("/") || host.includes(" ")) throw mailError("INVALID_MAIL", "SMTP host is invalid");
  const security = input.security ?? input.encryption ?? "starttls";
  if (!SMTP_SECURITY.includes(security)) throw mailError("INVALID_MAIL", "SMTP security must be starttls or tls");
  const defaultPort = security === "tls" ? 465 : 587;
  const port = Number(input.port ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw mailError("INVALID_MAIL", "SMTP port is invalid");
  const username = safeHeader(input.username, "SMTP username");
  const from = email(input.from ?? input.sender, "sender");
  return { host, port, security, username, from };
}

export function normalizeMailRecipients(values) {
  const list = Array.isArray(values) ? values : String(values ?? "").split(/[\s,;]+/u);
  const normalized = [...new Set(list.map((value) => String(value).trim()).filter(Boolean))];
  if (!normalized.length || normalized.length > 20 || normalized.some((value) => !EMAIL_RE.test(value))) {
    throw mailError("INVALID_MAIL", "Mail recipients must contain 1 to 20 email addresses");
  }
  return normalized;
}

export class MailSecretStore {
  constructor(filename) {
    if (typeof filename !== "string" || !filename) throw new TypeError("Mail secret filename is required");
    this.filename = filename;
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.filename, "utf8"));
      return value?.version === MAIL_SECRET_VERSION && typeof value.password === "string" && value.password
        ? value.password
        : undefined;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async hasSecret() {
    return Boolean(await this.read());
  }

  async save(password) {
    if (typeof password !== "string" || !password) throw mailError("INVALID_MAIL_SECRET", "SMTP password must not be empty");
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = this.filename + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify({ version: MAIL_SECRET_VERSION, password }) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filename);
      await chmod(this.filename, 0o600).catch(() => {});
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async clear() {
    await rm(this.filename, { force: true });
  }
}

export function publicMailSettings(settings, hasPassword = false) {
  if (!settings?.config) {
    return { configured: false, version: Number(settings?.version ?? 0), hasPassword: Boolean(hasPassword) };
  }
  return {
    configured: true,
    version: Number(settings.version ?? 0),
    updatedAt: settings.updatedAt,
    hasPassword: Boolean(hasPassword),
    host: settings.config.host,
    port: settings.config.port,
    security: settings.config.security,
    username: settings.config.username,
    from: settings.config.from,
  };
}

class SmtpConnection {
  constructor(socket, { commandMs }) {
    this.socket = socket;
    this.commandTimeoutMs = commandMs;
    this.buffer = "";
    this.waiters = [];
    this.closed = false;
    this.dataSubmitted = false;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on("error", (error) => {
      const failure = mailError("SMTP_CONNECTION_FAILED", "SMTP connection failed", {
        retryable: true,
        uncertain: this.dataSubmitted,
        cause: error,
      });
      for (const waiter of this.waiters.splice(0)) waiter.reject(failure);
    });
    socket.on("close", () => {
      this.closed = true;
      const failure = mailError("SMTP_CONNECTION_CLOSED", "SMTP connection closed unexpectedly", {
        retryable: true,
        uncertain: this.dataSubmitted,
      });
      for (const waiter of this.waiters.splice(0)) waiter.reject(failure);
    });
  }

  flush() {
    for (;;) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd < 0) return;
      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 2);
      const match = line.match(/^(\d{3})([ -])(.*)$/u);
      if (!match) continue;
      const waiter = this.waiters[0];
      if (!waiter) continue;
      waiter.lines.push(line);
      if (match[2] === "-") continue;
      this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve({ code: Number(match[1]), lines: waiter.lines, message: match[3] });
    }
  }

  readResponse() {
    if (this.closed) return Promise.reject(mailError("SMTP_CONNECTION_CLOSED", "SMTP connection is closed", { retryable: true, uncertain: this.dataSubmitted }));
    return new Promise((resolve, reject) => {
      const waiter = {
        lines: [],
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          this.destroy();
          reject(mailError("SMTP_TIMEOUT", "SMTP server response timed out", { retryable: true, uncertain: this.dataSubmitted }));
        }, this.commandTimeoutMs),
      };
      this.waiters.push(waiter);
      this.flush();
    });
  }

  async command(value, expected = []) {
    if (this.closed) throw mailError("SMTP_CONNECTION_CLOSED", "SMTP connection is closed", { retryable: true, uncertain: this.dataSubmitted });
    this.socket.write(String(value) + "\r\n");
    const response = await this.readResponse();
    if (expected.length && !expected.includes(response.code)) {
      throw mailError("SMTP_RESPONSE_ERROR", "SMTP server rejected a command", {
        smtpCode: response.code,
        retryable: response.code >= 400 && response.code < 500,
        uncertain: this.dataSubmitted,
      });
    }
    return response;
  }

  async upgradeToTls(host) {
    const previous = this.socket;
    previous.removeAllListeners("data");
    previous.removeAllListeners("error");
    previous.removeAllListeners("close");
    const secure = tls.connect({ socket: previous, servername: host, rejectUnauthorized: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        secure.destroy();
        reject(mailError("SMTP_TIMEOUT", "SMTP TLS handshake timed out", { retryable: true }));
      }, this.commandTimeoutMs);
      const onSecure = () => { clearTimeout(timer); secure.removeListener("error", onError); resolve(); };
      const onError = (error) => { clearTimeout(timer); secure.removeListener("secureConnect", onSecure); reject(mailError("SMTP_TLS_FAILED", "SMTP TLS handshake failed", { retryable: false, cause: error })); };
      secure.once("secureConnect", onSecure);
      secure.once("error", onError);
    });
    this.buffer = "";
    this.closed = false;
    this.attach(secure);
  }

  destroy() {
    this.closed = true;
    this.socket.destroy();
  }

  close() {
    if (!this.closed) this.socket.destroy();
  }
}

function connectSocket(settings, timeouts) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = settings.security === "tls"
      ? tls.connect({ host: settings.host, port: settings.port, servername: settings.host, rejectUnauthorized: true })
      : net.createConnection({ host: settings.host, port: settings.port });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(mailError("SMTP_TIMEOUT", "SMTP connection timed out", { retryable: true }));
    }, timeouts.connectMs);
    const onError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(mailError("SMTP_CONNECTION_FAILED", "SMTP connection failed", { retryable: true, cause: error }));
    };
    socket.once("error", onError);
    const connectedEvent = settings.security === "tls" ? "secureConnect" : "connect";
    socket.once(connectedEvent, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeListener("error", onError);
      resolve(new SmtpConnection(socket, timeouts));
    });
  });
}

function responseCapabilities(response) {
  const capabilities = new Set();
  for (const line of response.lines) {
    const value = line.slice(4).trim();
    const name = value.split(/\s+/u, 1)[0].toUpperCase();
    if (name) capabilities.add(name);
    if (name === "AUTH") {
      for (const mechanism of value.slice(4).split(/\s+/u)) if (mechanism) capabilities.add("AUTH:" + mechanism.toUpperCase());
    }
  }
  return capabilities;
}

function base64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

async function authenticate(connection, settings, password, capabilities) {
  if (capabilities.has("AUTH:PLAIN") || !capabilities.has("AUTH:LOGIN")) {
    const response = await connection.command("AUTH PLAIN " + base64("\0" + settings.username + "\0" + password), [235, 503]);
    if (response.code === 503) return;
    return;
  }
  let response = await connection.command("AUTH LOGIN", [334]);
  if (response.code !== 334) return;
  response = await connection.command(base64(settings.username), [334]);
  if (response.code !== 334) return;
  await connection.command(base64(password), [235]);
}

function headerSubject(value) {
  const normalized = safeHeader(value, "subject");
  if (/^[\x20-\x7e]*$/u.test(normalized)) return normalized;
  return "=?UTF-8?B?" + Buffer.from(normalized, "utf8").toString("base64") + "?=";
}

function messagePayload({ from, recipients, subject, textBody, htmlBody }) {
  const boundary = "----=_Infolens_" + randomUUID();
  const text = String(textBody);
  const html = String(htmlBody);
  const payload = [
    "From: " + safeHeader(from, "from"),
    "To: " + recipients.map((value) => safeHeader(value, "recipient")).join(", "),
    "Subject: " + headerSubject(subject),
    "Date: " + new Date().toUTCString(),
    "Message-ID: <" + randomUUID() + "@infolens.local>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=\"" + boundary + "\"",
    "",
    "--" + boundary,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "--" + boundary,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "--" + boundary + "--",
    "",
  ].join("\r\n");
  if (Buffer.byteLength(payload, "utf8") > 1_024 * 1_024) throw mailError("MAIL_TOO_LARGE", "Mail body exceeds the 1 MB limit");
  return payload;
}

function dotStuff(value) {
  return value.split(/\r\n/u).map((line) => line.startsWith(".") ? "." + line : line).join("\r\n");
}

export async function sendSmtpMail(settingsInput, password, message, { timeouts = SMTP_TIMEOUTS } = {}) {
  const settings = normalizeMailSettings(settingsInput);
  if (typeof password !== "string" || !password) throw mailError("MAIL_SECRET_MISSING", "SMTP password is not configured");
  const recipients = normalizeMailRecipients(message?.recipients ?? message?.to);
  const from = email(message?.from ?? settings.from, "from");
  const subject = safeHeader(message?.subject, "subject");
  const textBody = String(message?.textBody ?? message?.text ?? "");
  const htmlBody = String(message?.htmlBody ?? message?.html ?? "");
  if (!textBody || !htmlBody) throw mailError("INVALID_MAIL", "Mail text and HTML bodies are required");
  const payload = messagePayload({ from, recipients, subject, textBody, htmlBody });
  const connection = await connectSocket(settings, timeouts);
  try {
    await connection.readResponse().then((response) => {
      if (response.code !== 220) throw mailError("SMTP_RESPONSE_ERROR", "SMTP greeting was rejected", { smtpCode: response.code, retryable: response.code >= 400 && response.code < 500 });
    });
    let ehlo = await connection.command("EHLO infolens.local", [250]);
    let capabilities = responseCapabilities(ehlo);
    if (settings.security === "starttls") {
      if (!capabilities.has("STARTTLS")) throw mailError("SMTP_STARTTLS_UNAVAILABLE", "SMTP server does not offer STARTTLS", { retryable: false });
      await connection.command("STARTTLS", [220]);
      await connection.upgradeToTls(settings.host);
      ehlo = await connection.command("EHLO infolens.local", [250]);
      capabilities = responseCapabilities(ehlo);
    }
    await authenticate(connection, settings, password, capabilities);
    await connection.command("MAIL FROM:<" + from + ">", [250]);
    for (const recipient of recipients) await connection.command("RCPT TO:<" + recipient + ">", [250, 251]);
    await connection.command("DATA", [354]);
    connection.dataSubmitted = true;
    connection.socket.write(dotStuff(payload) + "\r\n.\r\n");
    const accepted = await connection.readResponse();
    connection.dataSubmitted = false;
    if (accepted.code !== 250) throw mailError("SMTP_RESPONSE_ERROR", "SMTP server did not accept the message", {
      smtpCode: accepted.code,
      retryable: accepted.code >= 400 && accepted.code < 500,
    });
    await connection.command("QUIT", [221, 250]).catch(() => {});
    return { ok: true, recipients };
  } catch (error) {
    if (error?.code === "SMTP_RESPONSE_ERROR" && error.uncertain === undefined) error.uncertain = connection.dataSubmitted;
    throw error;
  } finally {
    connection.close();
  }
}
