import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildVerifiedConnectionConfig,
  connectVerified,
  formatSha256Fingerprint,
  scanHostFingerprint,
} from "../src/infrastructure/ssh.js";

class FakeClient extends EventEmitter {
  connect(config) {
    this.config = config;
    queueMicrotask(() => this.emit("ready"));
    return this;
  }

  end() {
    this.ended = true;
  }

  sftp(callback) {
    const client = this;
    callback(null, {
      writeFile(path, contents, options, done) {
        client.uploaded = { path, contents: Buffer.from(contents), options };
        done();
      },
      end() {},
    });
  }
}

test("formatSha256Fingerprint presents an OpenSSH-style fingerprint", () => {
  const hex = "ab".repeat(32);
  const expected = Buffer.from(hex, "hex")
    .toString("base64")
    .replace(/=+$/u, "");

  assert.equal(formatSha256Fingerprint(hex), `SHA256:${expected}`);
});

test("verified SSH config rejects a changed host key", () => {
  const expected = formatSha256Fingerprint("ab".repeat(32));
  const config = buildVerifiedConnectionConfig({
    host: "203.0.113.10",
    port: 22,
    username: "root",
    password: "temporary-test-value",
    expectedFingerprint: expected,
  });

  assert.equal(config.hostHash, "sha256");
  assert.equal(config.hostVerifier("ab".repeat(32)), true);
  assert.equal(config.hostVerifier("cd".repeat(32)), false);
  assert.equal(config.tryKeyboard, false);
});

test("connectVerified requires authentication and returns a closable connection", async () => {
  await assert.rejects(
    () =>
      connectVerified({
        host: "203.0.113.10",
        port: 22,
        username: "root",
        expectedFingerprint: formatSha256Fingerprint("ab".repeat(32)),
      }),
    /password|agent/i,
  );

  const client = new FakeClient();
  const connection = await connectVerified(
    {
      host: "203.0.113.10",
      port: 22,
      username: "root",
      password: "temporary-test-value",
      expectedFingerprint: formatSha256Fingerprint("ab".repeat(32)),
    },
    {
      createClient: () => client,
    },
  );

  assert.equal(client.config.host, "203.0.113.10");
  assert.equal(client.config.username, "root");

  connection.close();
  assert.equal(client.ended, true);
});

test("scanHostFingerprint reads the key without authenticating", async () => {
  const client = new FakeClient();
  client.connect = function connect(config) {
    this.config = config;
    queueMicrotask(() => config.hostVerifier("ab".repeat(32)));
    return this;
  };

  const fingerprint = await scanHostFingerprint(
    { host: "203.0.113.10", port: 22 },
    { createClient: () => client },
  );

  assert.equal(fingerprint, formatSha256Fingerprint("ab".repeat(32)));
  assert.equal(client.config.password, undefined);
  assert.equal(client.config.hostHash, "sha256");
});

test("uploads are restricted to the installer-managed directory", async () => {
  const client = new FakeClient();
  const connection = await connectVerified(
    {
      host: "203.0.113.10",
      port: 22,
      username: "root",
      password: "temporary-test-value",
      expectedFingerprint: formatSha256Fingerprint("ab".repeat(32)),
    },
    { createClient: () => client },
  );

  await connection.upload(
    "/docker/n8n-openai-oauth/auth/auth.json",
    Buffer.from("test-data"),
  );

  assert.equal(
    client.uploaded.path,
    "/docker/n8n-openai-oauth/auth/auth.json",
  );
  assert.equal(client.uploaded.options.mode, 0o600);
  assert.throws(
    () => connection.upload("/docker/n8n/docker-compose.yml", "bad"),
    /sidecar directory/i,
  );
});
