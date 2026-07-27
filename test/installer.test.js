import assert from "node:assert/strict";
import test from "node:test";

import {
  MANAGED_MARKER_PATH,
  PRECHECK_COMMAND,
  createVerificationCommands,
} from "../src/domain/safety.js";
import { installSidecar } from "../src/services/installer.js";

function createFakeRemote({
  managedDirectory = false,
  unmanagedDirectory = false,
  publishedPortResult = { stdout: "", stderr: "", code: 1 },
} = {}) {
  const commands = [];
  const uploads = [];
  const verification = createVerificationCommands();

  return {
    commands,
    uploads,
    async exec(command) {
      commands.push(command);

      if (command === PRECHECK_COMMAND && unmanagedDirectory) {
        return { stdout: "", stderr: "", code: 42 };
      }
      if (command === PRECHECK_COMMAND) {
        return {
          stdout: managedDirectory ? "managed\n" : "new\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === verification.models) {
        return {
          stdout: JSON.stringify({
            data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === verification.runningService) {
        return { stdout: "openai-oauth\n", stderr: "", code: 0 };
      }
      if (command === verification.publishedPort) {
        return publishedPortResult;
      }

      return { stdout: "", stderr: "", code: 0 };
    },
    async upload(path, contents, mode) {
      uploads.push({ path, contents: Buffer.from(contents), mode });
    },
  };
}

const authContents = Buffer.from(
  JSON.stringify({
    testFixture: true,
  }),
);

test("installSidecar requires confirmation before any remote action", async () => {
  const remote = createFakeRemote();

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents,
        confirmed: false,
      }),
    /confirm/i,
  );

  assert.deepEqual(remote.commands, []);
  assert.deepEqual(remote.uploads, []);
});

test("installSidecar refuses to overwrite an unmanaged directory", async () => {
  const remote = createFakeRemote({ unmanagedDirectory: true });

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents,
        confirmed: true,
      }),
    /already exists|unmanaged/i,
  );

  assert.deepEqual(remote.uploads, []);
});

test("installSidecar uploads secrets separately and starts only the sidecar", async () => {
  const remote = createFakeRemote();

  const result = await installSidecar({
    remote,
    networkName: "proxy",
    authContents,
    confirmed: true,
  });

  assert.equal(result.baseUrl, "http://n8n-openai-oauth:10531/v1");
  assert.equal(result.apiKeyPlaceholder, "local-only");
  assert.equal(result.useResponsesApi, true);
  assert.equal(result.deploymentMode, "installed");
  assert.deepEqual(result.models, ["gpt-5.6-sol", "gpt-5.6-terra"]);

  assert.ok(remote.uploads.some((upload) => upload.path === MANAGED_MARKER_PATH));
  assert.ok(
    remote.uploads.some(
      (upload) =>
        upload.path === "/docker/n8n-openai-oauth/auth/auth.json" &&
        upload.mode === 0o600,
    ),
  );
  assert.ok(
    remote.commands.every(
      (command) =>
        !command.includes("/docker/n8n/docker-compose") &&
        !/\bdocker (?:restart|stop|rm)\s+n8n/.test(command),
    ),
  );
});

test("installSidecar refreshes OAuth for an existing managed deployment", async () => {
  const remote = createFakeRemote({ managedDirectory: true });

  const result = await installSidecar({
    remote,
    networkName: "proxy",
    authContents,
    confirmed: true,
  });

  assert.equal(result.deploymentMode, "updated");
  assert.ok(
    remote.uploads.some(
      (upload) =>
        upload.path === "/docker/n8n-openai-oauth/auth/auth.json" &&
        upload.mode === 0o600,
    ),
  );
});

test("installSidecar validates auth JSON before connecting to Docker", async () => {
  const remote = createFakeRemote();

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents: Buffer.from("not-json"),
        confirmed: true,
      }),
    /credential file/i,
  );

  assert.deepEqual(remote.commands, []);
});

test("installSidecar does not ignore a failed published-port safety check", async () => {
  const remote = createFakeRemote({
    publishedPortResult: { stdout: "", stderr: "docker failed", code: 125 },
  });

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents,
        confirmed: true,
      }),
    /port|safety/i,
  );
});
