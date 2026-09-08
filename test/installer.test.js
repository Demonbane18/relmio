import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MANAGED_MARKER_PATH,
  PRECHECK_COMMAND,
  SHARED_ROOT_MARKER_PATH,
  createDeploymentCommands,
  createVerificationCommands,
} from "../src/domain/safety.js";
import { installSidecar } from "../src/services/installer.js";

function createFakeRemote({
  managedDirectory = false,
  unmanagedDirectory = false,
  unsafeUploadTarget = false,
  models = [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }],
  modelCheckResult = null,
  modelCheckError = null,
  publicationStateResult = {
    stdout: JSON.stringify({
      Publishers: [
        {
          URL: "",
          TargetPort: 10531,
          PublishedPort: 0,
          Protocol: "tcp",
        },
      ],
    }),
    stderr: "",
    code: 0,
  },
  cleanupResult = { stdout: "", stderr: "", code: 0 },
  publicationStateError = null,
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
      if (command === PRECHECK_COMMAND && unsafeUploadTarget) {
        return { stdout: "", stderr: "", code: 43 };
      }
      if (command === PRECHECK_COMMAND) {
        return {
          stdout: managedDirectory ? "managed\n" : "new\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === verification.models) {
        if (modelCheckError) throw modelCheckError;
        return modelCheckResult ?? {
          stdout: JSON.stringify({ data: models }),
          stderr: "",
          code: 0,
        };
      }
      if (command === verification.runningService) {
        return { stdout: "openai-oauth\n", stderr: "", code: 0 };
      }
      if (command === verification.publicationState) {
        if (publicationStateError) {
          throw publicationStateError;
        }
        return publicationStateResult;
      }
      if (command === verification.cleanup) {
        return cleanupResult;
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

test("installSidecar refuses unsafe existing upload targets before writing", async () => {
  const remote = createFakeRemote({ unsafeUploadTarget: true });

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents,
        confirmed: true,
      }),
    /install-directory check failed/i,
  );

  assert.deepEqual(remote.uploads, []);
  assert.deepEqual(remote.commands, [PRECHECK_COMMAND]);
  for (const path of [
    "/docker/n8n-openai-oauth/auth",
    "/docker/n8n-openai-oauth/Dockerfile",
    "/docker/n8n-openai-oauth/openai-oauth-sidecar.mjs",
    "/docker/n8n-openai-oauth/docker-compose.yml",
    "/docker/n8n-openai-oauth/auth/auth.json",
  ]) {
    assert.ok(PRECHECK_COMMAND.includes(`[ -L ${path} ]`));
  }
});

test("sidecar precheck accepts the Relmio shared root so assistant-first installs remain compatible", () => {
  assert.match(PRECHECK_COMMAND, new RegExp(SHARED_ROOT_MARKER_PATH.replaceAll("/", "\\/")));
  assert.match(PRECHECK_COMMAND, /\.managed-by-n8n-openai-oauth/);
  assert.match(PRECHECK_COMMAND, /\[ -L \/docker\/n8n-openai-oauth \]/);
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

  const runtime = remote.uploads.find(
    (upload) =>
      upload.path ===
      "/docker/n8n-openai-oauth/openai-oauth-sidecar.mjs",
  );
  assert.equal(runtime.mode, 0o644);
  assert.deepEqual(
    runtime.contents,
    await readFile(
      new URL("../src/gateway/openai-oauth-sidecar.mjs", import.meta.url),
    ),
  );

  assert.ok(remote.uploads.some((upload) => upload.path === MANAGED_MARKER_PATH));
  assert.ok(
    remote.uploads.some(
      (upload) => upload.path === SHARED_ROOT_MARKER_PATH && upload.mode === 0o600,
    ),
  );
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

test("installSidecar updates an existing managed deployment with the packaged adapter and only rebuilds its sidecar", async () => {
  const remote = createFakeRemote({ managedDirectory: true });
  const packagedRuntime = await readFile(
    new URL("../src/gateway/openai-oauth-sidecar.mjs", import.meta.url),
  );

  const result = await installSidecar({
    remote,
    networkName: "proxy",
    authContents,
    confirmed: true,
  });

  assert.equal(result.deploymentMode, "updated");
  const runtimeUploads = remote.uploads.filter(
    (upload) =>
      upload.path ===
      "/docker/n8n-openai-oauth/openai-oauth-sidecar.mjs",
  );
  assert.equal(runtimeUploads.length, 1);
  assert.equal(runtimeUploads[0].mode, 0o644);
  assert.deepEqual(runtimeUploads[0].contents, packagedRuntime);
  assert.ok(
    remote.uploads.some(
      (upload) =>
        upload.path === "/docker/n8n-openai-oauth/auth/auth.json" &&
        upload.mode === 0o600,
    ),
  );
  const deploymentCommands = createDeploymentCommands();
  assert.ok(remote.commands.includes(deploymentCommands.at(-2)));
  assert.ok(remote.commands.includes(deploymentCommands.at(-1)));
  assert.match(deploymentCommands.at(-2), /build openai-oauth$/u);
  assert.match(
    deploymentCommands.at(-1),
    /up -d --wait --wait-timeout 60 --no-deps openai-oauth$/u,
  );
  assert.ok(
    remote.commands.every(
      (command) =>
        !command.includes("/docker/n8n/docker-compose") &&
        !/\bdocker (?:restart|stop|rm)\s+n8n\b/u.test(command),
    ),
  );
});

test("installSidecar requires confirmation before updating a managed deployment", async () => {
  const remote = createFakeRemote({ managedDirectory: true });

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
    publicationStateResult: {
      stdout: "",
      stderr: "docker failed",
      code: 125,
    },
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
  assert.ok(remote.commands.includes(createVerificationCommands().cleanup));
});

test("installSidecar rejects a positive published host port", async () => {
  const remote = createFakeRemote({
    publicationStateResult: {
      stdout: JSON.stringify({
        Publishers: [
          {
            URL: "0.0.0.0",
            TargetPort: 10531,
            PublishedPort: 10531,
            Protocol: "tcp",
          },
        ],
      }),
      stderr: "",
      code: 0,
    },
  });
  const verification = createVerificationCommands();

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents,
        confirmed: true,
      }),
    /published|host port|safety/i,
  );
  assert.ok(remote.commands.includes(verification.cleanup));
});

test("installSidecar fails closed when unsafe-port cleanup cannot be confirmed", async () => {
  const remote = createFakeRemote({
    publicationStateResult: {
      stdout: JSON.stringify({
        Publishers: [
          {
            URL: "0.0.0.0",
            TargetPort: 10531,
            PublishedPort: 10531,
            Protocol: "tcp",
          },
        ],
      }),
      stderr: "",
      code: 0,
    },
    cleanupResult: { stdout: "", stderr: "cleanup failed", code: 1 },
  });

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents,
        confirmed: true,
      }),
    /cleanup could not be confirmed/i,
  );
});

test("installSidecar fails closed on malformed publication metadata", async () => {
  const remote = createFakeRemote({
    publicationStateResult: {
      stdout: "not-json",
      stderr: "",
      code: 0,
    },
  });

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents,
        confirmed: true,
      }),
    /published-port safety check/i,
  );
  assert.ok(remote.commands.includes(createVerificationCommands().cleanup));
});

test("installSidecar cleans up when publication inspection cannot start", async () => {
  const remote = createFakeRemote({
    publicationStateError: new Error("SSH stream failed"),
  });

  await assert.rejects(
    () =>
      installSidecar({
        remote,
        networkName: "proxy",
        authContents,
        confirmed: true,
      }),
    /published-port safety check could not be completed|cleanup/i,
  );
  assert.ok(remote.commands.includes(createVerificationCommands().cleanup));
});

test("installSidecar rejects a model response with no usable IDs", async () => {
  for (const models of [[], [{ id: "" }], [{ id: "invalid/model" }]]) {
    const remote = createFakeRemote({ models });

    await assert.rejects(
      () =>
        installSidecar({
          remote,
          networkName: "proxy",
          authContents,
          confirmed: true,
        }),
      /model response could not be verified/i,
    );
  }
});

test("installSidecar reports fixed safe categories for evidenced model-check failures", async () => {
  const cases = [
    [
      { code: 1, stdout: JSON.stringify({ error: { message: "OpenAI OAuth session not found.", type: "upstream_error" } }), stderr: "" },
      /saved ChatGPT sign-in was rejected or is no longer valid/i,
    ],
    [
      { code: 1, stdout: JSON.stringify({ error: { message: "HTTP 403: account does not have permission", type: "upstream_error" } }), stderr: "" },
      /model service denied the bridge request/i,
    ],
    [
      { code: 1, stdout: JSON.stringify({ error: { message: "fetch failed: ECONNREFUSED", type: "upstream_error" } }), stderr: "" },
      /could not reach the model service/i,
    ],
    [
      { code: 1, stdout: "RELMIO_MODEL_CHECK_UNREACHABLE\n", stderr: "" },
      /bridge endpoint could not be reached for verification/i,
    ],
    [
      { code: 1, stdout: JSON.stringify({ error: { message: 'OpenAI OAuth token request failed with HTTP 400: {"error":{"code":"refresh_token_reused"}}', type: "upstream_error" } }), stderr: "" },
      /saved ChatGPT sign-in could not be refreshed/i,
    ],
    [
      { code: 1, stdout: JSON.stringify({ error: { message: "OpenAI OAuth token request failed with HTTP 401.", type: "upstream_error" } }), stderr: "" },
      /saved ChatGPT sign-in could not be refreshed/i,
    ],
    [
      { code: 1, stdout: JSON.stringify({ error: { message: "unexpected upstream condition", type: "upstream_error" } }), stderr: "" },
      /failed for an unclassified reason/i,
    ],
    [
      { code: 1, stdout: JSON.stringify({ error: { message: "Proxy observed an OpenAI OAuth token request failed with HTTP 401.", type: "upstream_error" } }), stderr: "" },
      /saved ChatGPT sign-in was rejected or is no longer valid/i,
    ],
    [
      { code: 1, stdout: JSON.stringify({ error: { message: "EACCES: permission denied, open /home/node/.codex/auth.json", type: "upstream_error" } }), stderr: "" },
      /failed for an unclassified reason/i,
    ],
  ];

  for (const [modelCheckResult, expected] of cases) {
    const remote = createFakeRemote({ modelCheckResult });
    await assert.rejects(
      () => installSidecar({ remote, networkName: "proxy", authContents, confirmed: true }),
      (error) => {
        assert.match(error.message, expected);
        assert.match(error.message, /existing n8n deployment was not changed/i);
        assert.doesNotMatch(error.message, /ECONNREFUSED|unexpected upstream condition|OAuth session not found|refresh_token_reused|HTTP 40[01]|OAuth token request/i);
        assert.equal(error.safeMessage, error.message);
        return true;
      },
    );
  }
});

test("model-check diagnostics fail closed on malformed, oversized, or secret-bearing evidence", async () => {
  const unsafeResults = [
    { code: 1, stdout: "not-json", stderr: "" },
    { code: 1, stdout: JSON.stringify({ error: { message: `Bearer ${"x".repeat(40)}`, type: "upstream_error" } }), stderr: "" },
    { code: 1, stdout: JSON.stringify({ error: { message: "401 " + "x".repeat(5000), type: "upstream_error" } }), stderr: "" },
  ];
  for (const modelCheckResult of unsafeResults) {
    const remote = createFakeRemote({ modelCheckResult });
    await assert.rejects(
      () => installSidecar({ remote, networkName: "proxy", authContents, confirmed: true }),
      (error) => {
        assert.match(error.message, /failed for an unclassified reason/i);
        assert.doesNotMatch(error.message, /Bearer|x{20}/u);
        return true;
      },
    );
  }
});

test("model-check transport failures return only the fixed VPS verification category", async () => {
  const remote = createFakeRemote({
    modelCheckError: new Error("SSH failed with Bearer secret-value"),
  });
  await assert.rejects(
    () => installSidecar({ remote, networkName: "proxy", authContents, confirmed: true }),
    (error) => {
      assert.match(error.message, /could not complete model verification over the VPS connection/i);
      assert.doesNotMatch(error.message, /SSH|Bearer|secret-value/u);
      assert.equal(error.safeMessage, error.message);
      return true;
    },
  );
});

test("only rejected ChatGPT credentials offer sign-in recovery after install or update", async () => {
  const cases = [
    ["OpenAI OAuth token request failed with HTTP 401.", true],
    ["OpenAI OAuth token request failed with HTTP 400. invalid_grant", true],
    ["OpenAI OAuth session not found.", true],
    ["HTTP 401: unauthorized", true],
    ["OpenAI OAuth token request failed with HTTP 429.", false],
    ["OpenAI OAuth token request failed with HTTP 503.", false],
    ["OpenAI OAuth token request failed with HTTP 403.", false],
    ["HTTP 403: forbidden", false],
    ["fetch failed", false],
    ["EACCES: permission denied, open /home/node/.codex/auth.json", false],
    ["unknown failure", false],
  ];
  for (const managedDirectory of [false, true]) {
    for (const [message, recoverable] of cases) {
      const remote = createFakeRemote({ managedDirectory, modelCheckResult: {
        code: 1,
        stdout: JSON.stringify({ error: { message, type: "upstream_error" } }),
        stderr: "",
      } });
      await assert.rejects(
        () => installSidecar({ remote, networkName: "proxy", authContents, confirmed: true }),
        (error) => {
          assert.equal(error.recoveryAction, recoverable ? "refresh-chatgpt-sign-in" : undefined, message);
          return true;
        },
      );
    }
  }
});
