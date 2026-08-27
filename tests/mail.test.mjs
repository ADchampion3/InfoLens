import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MailSecretStore,
  normalizeMailRecipients,
  normalizeMailSettings,
  publicMailSettings,
  sendSmtpMail,
} from "../packages/plugin-runtime/src/mail.mjs";

test("mail settings and secrets expose only redacted configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-mail-"));
  try {
    const secret = new MailSecretStore(path.join(root, "mail-secrets.json"));
    await secret.save("super-secret");
    assert.equal(await secret.read(), "super-secret");
    assert.match(await readFile(path.join(root, "mail-secrets.json"), "utf8"), /super-secret/u);
    const settings = {
      version: 2,
      updatedAt: "2026-08-27T00:00:00.000Z",
      config: normalizeMailSettings({
        host: "smtp.example.com",
        username: "sender@example.com",
        from: "sender@example.com",
      }),
    };
    const publicValue = publicMailSettings(settings, await secret.hasSecret());
    assert.equal(publicValue.hasPassword, true);
    assert.doesNotMatch(JSON.stringify(publicValue), /super-secret/u);
    assert.deepEqual(normalizeMailRecipients("reader@example.com, second@example.com"), ["reader@example.com", "second@example.com"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("SMTP refuses a server that does not offer STARTTLS", async () => {
  const server = createServer((socket) => {
    socket.write("220 fake.smtp.test ESMTP\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const index = buffer.indexOf("\r\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line.startsWith("EHLO")) socket.write("250-fake.smtp.test\r\n250 AUTH PLAIN\r\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await assert.rejects(() => sendSmtpMail({
      host: "127.0.0.1",
      port,
      security: "starttls",
      username: "sender@example.com",
      from: "sender@example.com",
    }, "secret", {
      recipients: ["reader@example.com"],
      subject: "test",
      textBody: "test",
      htmlBody: "<p>test</p>",
    }), (error) => error.code === "SMTP_STARTTLS_UNAVAILABLE" && error.retryable === false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
