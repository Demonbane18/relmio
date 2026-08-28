import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ASSISTANT_MARKER_PATH,
  ASSISTANT_PRECHECK_COMMAND,
  ASSISTANT_ROOT,
  ASSISTANT_ROOT_MARKER_PATH,
  assertAssistantOnlyCommands,
  createAssistantDeploymentCommands,
  createAssistantExactResourceAttestationCommands,
  createAssistantInstallation,
  createAssistantNetworkCollisionCommand,
  createAssistantOwnershipAttestationCommands,
  createAssistantVerificationCommands,
  getAssistantManagedResourceNames,
  parseAssistantMarker,
  serializeAssistantMarker,
} from "../src/domain/assistant.js";
import {
  createAssistantComposeFile,
  createAssistantEnv,
  createAssistantSecrets,
  createSearxngSettings,
} from "../src/domain/assistant-templates.js";
import { installAssistant } from "../src/services/assistant-installer.js";
import { cliMode } from "../src/cli.js";
import { startWizardServer } from "../src/web/server.js";

const sessionToken = "assistant-session-token-that-is-long-enough-123456";

function sequenceRandomBytes() {
  let nextByte = 1;
  return (size) => {
    const value = Buffer.alloc(size, nextByte);
    nextByte += 1;
    return value;
  };
}

function createFakeRemote({
  precheckCode = 0,
  precheckState = "new\n",
  collisionState = "",
  collisionCode = 0,
  attestationStates = [],
  attestationCodes = [],
  exactAttestationStates = [],
  startResult = { code: 0, stdout: "", stderr: "" },
  healthResult = { code: 0, stdout: '{"status":"ok"}\n', stderr: "" },
  runningResult = {
    code: 0,
    stdout: "relmio-sandbox-api\nrelmio-sandbox-runner-1\nrelmio-searxng\n",
    stderr: "",
  },
  publicationResult = {
    code: 0,
    stdout: JSON.stringify([
      { Service: "relmio-sandbox-api", Publishers: [] },
      { Service: "relmio-sandbox-runner-1", Publishers: [] },
      { Service: "relmio-searxng", Publishers: [] },
    ]),
    stderr: "",
  },
  cleanupResult = { code: 0, stdout: "", stderr: "" },
} = {}) {
  const commands = [];
  const uploads = [];
  const events = [];
  let attestationIndex = 0;
  let exactAttestationIndex = 0;
  return {
    commands,
    uploads,
    events,
    async exec(command) {
      commands.push(command);
      events.push({ type: "command", value: command });
      if (command === ASSISTANT_PRECHECK_COMMAND) {
        return { code: precheckCode, stdout: precheckState, stderr: "" };
      }
      if (command.includes("docker network inspect ")) {
        return { code: collisionCode, stdout: collisionState, stderr: "" };
      }
      if (
        (command.startsWith("docker container ls -a ") && command.includes("--filter \"name=")) ||
        (command.startsWith("docker network ls ") && command.includes("--filter \"name=")) ||
        (command.startsWith("docker volume ls ") && command.includes("--filter \"name="))
      ) {
        const stdout = exactAttestationStates[exactAttestationIndex] ?? "";
        exactAttestationIndex += 1;
        return { code: 0, stdout, stderr: "" };
      }
      if (command.includes("io.relmio.ai-assistant.install-id")) {
        const stdout = attestationStates[attestationIndex] ?? "";
        const code = attestationCodes[attestationIndex] ?? 0;
        attestationIndex += 1;
        return { code, stdout, stderr: "" };
      }
      if (command.includes(" up -d --wait --wait-timeout 90 ")) {
        return startResult;
      }
      if (command.includes(" exec -T relmio-sandbox-api ")) {
        return healthResult;
      }
      if (command.includes(" ps --status running --services")) {
        return runningResult;
      }
      if (command.includes(" ps --format json ")) {
        if (publicationResult instanceof Error) throw publicationResult;
        return publicationResult;
      }
      if (
        command.endsWith(" down --volumes") ||
        command.endsWith(" rm -sf relmio-searxng")
      ) {
        return cleanupResult;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    async upload(path, contents, mode) {
      uploads.push({ path, contents: String(contents), mode });
      events.push({ type: "upload", value: path });
    },
  };
}

function generatedInstallation() {
  return createAssistantInstallation({
    randomBytes: sequenceRandomBytes(),
    includeSearxng: true,
  });
}

function exactOwnedResourceStates(installation) {
  const names = getAssistantManagedResourceNames(installation);
  const labels = `${installation.installId}|true`;
  return [
    names.containers.map((name) => `${name}|${labels}`).join("\n") + "\n",
    `${names.network}|${labels}\n`,
    `${names.volume}|${labels}\n`,
  ];
}

test("AI Assistant deployment refuses any remote action without exact confirmation", async () => {
  const remote = createFakeRemote();

  await assert.rejects(
    () => installAssistant({ remote, networkName: "proxy", confirmed: "true", includeSearxng: true }),
    /confirm/i,
  );

  assert.deepEqual(remote.commands, []);
  assert.deepEqual(remote.uploads, []);
});

test("AI Assistant can claim only a missing shared root and rejects unmanaged or symlink-unsafe paths", async () => {
  const remote = createFakeRemote();
  await installAssistant({
    remote,
    networkName: "proxy",
    confirmed: true,
    includeSearxng: true,
    randomBytes: sequenceRandomBytes(),
  });
  assert.ok(remote.uploads.some((upload) => upload.path === ASSISTANT_ROOT_MARKER_PATH && upload.mode === 0o600));
  assert.ok(remote.commands.includes(`install -d -m 0755 /docker/n8n-openai-oauth`));
  assert.match(ASSISTANT_PRECHECK_COMMAND, /\[ ! -d \/docker\/n8n-openai-oauth \]/);
  assert.match(ASSISTANT_PRECHECK_COMMAND, /\.managed-by-relmio-root/);

  for (const precheckCode of [42, 43]) {
    const unsafeRemote = createFakeRemote({ precheckCode, precheckState: "" });
    await assert.rejects(
      () => installAssistant({ remote: unsafeRemote, networkName: "proxy", confirmed: true, includeSearxng: true }),
      /unmanaged|unsafe|symlink/i,
    );
    assert.deepEqual(unsafeRemote.uploads, []);
  }
});

test("AI Assistant markers bind a random project and independent aliases with strict parsing", () => {
  const installation = generatedInstallation();
  const marker = serializeAssistantMarker(installation);
  assert.deepEqual(parseAssistantMarker(marker), installation);
  assert.match(installation.projectName, /^relmio-ai-[a-f0-9]{32}$/u);
  assert.notEqual(installation.sandboxAlias, installation.searxngAlias);
  assert.doesNotMatch(installation.sandboxAlias, new RegExp(`${installation.installId}$`, "u"));
  const legacyMarker = JSON.parse(marker);
  legacyMarker.version = 1;
  delete legacyMarker.includeSearxng;
  assert.deepEqual(parseAssistantMarker(JSON.stringify(legacyMarker)), installation);
  assert.throws(
    () => parseAssistantMarker(marker.replace("relmio-ai-", "foreign-project-")),
    /marker/i,
  );
  assert.throws(
    () => parseAssistantMarker('{"version":1,"installId":"bad"}'), /marker/i,
  );
});

test("AI Assistant uses compact explicit containers bound to its full installation identity", () => {
  const installation = generatedInstallation();
  const expectedContainers = [
    `relmio-ai-${installation.installId.slice(0, 16)}-certs`,
    `relmio-ai-${installation.installId.slice(0, 16)}-api`,
    `relmio-ai-${installation.installId.slice(0, 16)}-runner`,
    `relmio-ai-${installation.installId.slice(0, 16)}-search`,
  ];
  const names = getAssistantManagedResourceNames(installation);
  const compose = createAssistantComposeFile({ networkName: "proxy", installation });
  const exactCommands = createAssistantExactResourceAttestationCommands({ installation });

  assert.deepEqual(names.containers, expectedContainers);
  assert.equal(new Set(names.containers).size, 4);
  assert.ok(names.containers.every((name) => name.length <= 35));
  assert.ok(names.containers.every((name) => /^relmio-ai-[a-f0-9]{16}-(certs|api|runner|search)$/u.test(name)));
  for (const name of expectedContainers) {
    assert.match(compose, new RegExp(`container_name: ${name}`, "u"));
    assert.match(exactCommands.containers, new RegExp(name, "u"));
  }

  const disabledInstallation = { ...installation, includeSearxng: false };
  const disabledNames = getAssistantManagedResourceNames(disabledInstallation);
  const disabledCompose = createAssistantComposeFile({
    networkName: "proxy",
    installation: disabledInstallation,
  });
  assert.deepEqual(disabledNames.containers, expectedContainers.slice(0, 3));
  assert.doesNotMatch(disabledCompose, /container_name: relmio-ai-[a-f0-9]{16}-search/u);
});

test("AI Assistant reuses only the marker-bound project and aliases on a managed update", async () => {
  const installation = generatedInstallation();
  const remote = createFakeRemote({
    precheckState: `managed\n${serializeAssistantMarker(installation)}`,
  });
  const result = await installAssistant({
    remote,
    networkName: "proxy",
    confirmed: true,
    includeSearxng: true,
    randomBytes: sequenceRandomBytes(),
  });
  assert.equal(result.deploymentMode, "updated");
  assert.equal(result.sandboxUrl, `http://${installation.sandboxAlias}:8080`);
  assert.equal(result.searxngUrl, `http://${installation.searxngAlias}:8080`);
  assert.ok(remote.commands.some((command) => command.includes(installation.projectName)));
  const compose = remote.uploads.find((upload) => upload.path.endsWith("/docker-compose.yml"));
  for (const name of getAssistantManagedResourceNames(installation).containers) {
    assert.match(compose?.contents ?? "", new RegExp(`container_name: ${name}`, "u"));
  }
});

test("AI Assistant enables SearXNG from a legacy named but marker-bound sandbox", async () => {
  const installation = createAssistantInstallation({
    randomBytes: sequenceRandomBytes(),
    includeSearxng: false,
  });
  const names = getAssistantManagedResourceNames(installation);
  const labels = `${installation.installId}|true\n`;
  const remote = createFakeRemote({
    precheckState: `managed\n${serializeAssistantMarker(installation)}`,
    attestationStates: [labels.repeat(3), labels, labels, labels.repeat(3), labels, labels],
    exactAttestationStates: [
      "",
      `${names.network}|${installation.installId}|true\n`,
      `${names.volume}|${installation.installId}|true\n`,
      "",
      `${names.network}|${installation.installId}|true\n`,
      `${names.volume}|${installation.installId}|true\n`,
    ],
  });

  const result = await installAssistant({
    remote,
    networkName: "proxy",
    confirmed: true,
    includeSearxng: true,
    randomBytes: sequenceRandomBytes(),
  });

  assert.equal(result.deploymentMode, "updated");
  assert.equal(result.includeSearxng, true);
  assert.ok(remote.commands.some((command) => / up -d --wait --wait-timeout 90 relmio-searxng$/u.test(command)));
});

test("AI Assistant rejects a colliding or foreign Compose project before writes and cleanup", async () => {
  const remote = createFakeRemote({ attestationStates: ["foreign-install|true\n"] });
  await assert.rejects(
    () => installAssistant({ remote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /ownership/i,
  );
  assert.deepEqual(remote.uploads, []);

  const cleanupRemote = createFakeRemote({
    startResult: { code: 1, stdout: "", stderr: "" },
    attestationStates: ["", "", "", "", "", "", "foreign-install|true\n"],
  });
  await assert.rejects(
    () => installAssistant({ remote: cleanupRemote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /ownership.*cleanup|cleanup.*ownership/i,
  );
  assert.equal(cleanupRemote.commands.filter((command) => command.endsWith(" down --volumes")).length, 0);
});

test("AI Assistant exact resource names reject foreign collisions and permit only attested managed updates", async () => {
  const installation = generatedInstallation();
  const names = getAssistantManagedResourceNames(installation);
  const exactCommands = createAssistantExactResourceAttestationCommands({ installation });
  assert.match(exactCommands.containers, new RegExp(names.containers[0]));
  assert.match(exactCommands.network, new RegExp(names.network));
  assert.match(exactCommands.volume, new RegExp(names.volume));

  const matchingNewResource = `${names.containers[0]}|${installation.installId}|true\n`;
  const newRemote = createFakeRemote({ exactAttestationStates: [matchingNewResource] });
  await assert.rejects(
    () => installAssistant({ remote: newRemote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /exact|resource|ownership/i,
  );
  assert.deepEqual(newRemote.uploads, []);

  const foreignManagedResource = `${names.network}|foreign-install|true\n`;
  const managedRemote = createFakeRemote({
    precheckState: `managed\n${serializeAssistantMarker(installation)}`,
    exactAttestationStates: ["", foreignManagedResource],
  });
  await assert.rejects(
    () => installAssistant({ remote: managedRemote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /exact|resource|ownership/i,
  );
  assert.deepEqual(managedRemote.uploads, []);

  const ownedStates = exactOwnedResourceStates(installation);
  const allowedManagedRemote = createFakeRemote({
    precheckState: `managed\n${serializeAssistantMarker(installation)}`,
    exactAttestationStates: [...ownedStates, ...ownedStates],
  });
  await installAssistant({
    remote: allowedManagedRemote,
    networkName: "proxy",
    confirmed: true,
    includeSearxng: true,
    randomBytes: sequenceRandomBytes(),
  });
  assert.ok(allowedManagedRemote.uploads.length > 0);

  const cleanupRemote = createFakeRemote({
    precheckState: `managed\n${serializeAssistantMarker(installation)}`,
    startResult: { code: 1, stdout: "", stderr: "" },
    exactAttestationStates: [
      ...ownedStates,
      ...ownedStates,
      `${names.containers[0]}|foreign-install|true\n`,
    ],
  });
  await assert.rejects(
    () => installAssistant({ remote: cleanupRemote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /ownership.*cleanup|cleanup.*ownership/i,
  );
  assert.equal(cleanupRemote.commands.filter((command) => command.endsWith(" down --volumes")).length, 0);
});

test("AI Assistant aborts before writes if either stable alias already belongs to a foreign network container", async () => {
  const installation = generatedInstallation();
  const remote = createFakeRemote({
    collisionState: `deadbeefcafe|foreign-install|${installation.sandboxAlias}\n`,
  });
  await assert.rejects(
    () => installAssistant({ remote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /alias|collision/i,
  );
  assert.deepEqual(remote.uploads, []);
});

test("AI Assistant uses four independent local secrets and returns only the sandbox key after verification", async () => {
  const secrets = createAssistantSecrets({ randomBytes: sequenceRandomBytes(), includeSearxng: true });
  assert.equal(new Set(Object.values(secrets)).size, 4);
  assert.ok(Object.values(secrets).every((value) => value.length >= 43));

  const remote = createFakeRemote();
  const result = await installAssistant({
    remote,
    networkName: "proxy",
    confirmed: true,
    includeSearxng: true,
    randomBytes: sequenceRandomBytes(),
  });
  const envUpload = remote.uploads.find((upload) => upload.path.endsWith("/.env"));
  assert.equal(envUpload?.mode, 0o600);
  assert.match(envUpload?.contents ?? "", /SANDBOX_API_KEYS=/);
  assert.match(envUpload?.contents ?? "", /SANDBOX_API_RUNNER_REGISTRATION_TOKEN=/);
  assert.match(envUpload?.contents ?? "", /SANDBOX_API_RUNNER_API_KEY=/);
  assert.match(envUpload?.contents ?? "", /SEARXNG_SECRET=/);
  assert.deepEqual(Object.keys(result).sort(), [
    "deploymentMode",
    "includeSearxng",
    "modelProvider",
    "modelRecommendation",
    "sandboxApiKey",
    "sandboxUrl",
    "searxngUrl",
    "webSearch",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /RUNNER|SEARXNG_SECRET/i);
});

test("AI Assistant makes SearXNG an explicit, marker-bound opt-in", async () => {
  const disabledInstallation = createAssistantInstallation({
    randomBytes: sequenceRandomBytes(),
    includeSearxng: false,
  });
  assert.equal(disabledInstallation.includeSearxng, false);
  assert.equal(parseAssistantMarker(serializeAssistantMarker(disabledInstallation)).includeSearxng, false);
  const markerWithoutSelection = JSON.parse(serializeAssistantMarker(disabledInstallation));
  delete markerWithoutSelection.includeSearxng;
  assert.throws(() => parseAssistantMarker(JSON.stringify(markerWithoutSelection)), /marker/i);

  const disabledRemote = createFakeRemote({
    runningResult: {
      code: 0,
      stdout: "relmio-sandbox-api\nrelmio-sandbox-runner-1\n",
      stderr: "",
    },
    publicationResult: {
      code: 0,
      stdout: JSON.stringify([
        { Service: "relmio-sandbox-api", Publishers: null },
        { Service: "relmio-sandbox-runner-1", Publishers: [{ PublishedPort: 0, URL: "" }] },
      ]),
      stderr: "",
    },
  });
  const disabledResult = await installAssistant({
    remote: disabledRemote,
    networkName: "proxy",
    confirmed: true,
    includeSearxng: false,
    randomBytes: sequenceRandomBytes(),
  });
  assert.equal(disabledResult.includeSearxng, false);
  assert.equal(disabledResult.webSearch, "disabled");
  assert.equal("searxngUrl" in disabledResult, false);
  assert.ok(disabledRemote.commands.every((command) => !command.includes("relmio-searxng")));
  assert.ok(disabledRemote.uploads.every((upload) => !upload.path.endsWith("searxng-settings.yml")));
  assert.doesNotMatch(
    disabledRemote.uploads.find((upload) => upload.path.endsWith("docker-compose.yml"))?.contents ?? "",
    /relmio-searxng|SEARXNG_SECRET/u,
  );
  assert.match(disabledRemote.uploads.find((upload) => upload.path.endsWith("/.env"))?.contents ?? "", /SEARXNG_SECRET=/);
  const disabledVerification = createAssistantVerificationCommands({
    installation: disabledInstallation,
  });
  assert.doesNotMatch(disabledVerification.publicationState, /relmio-sandbox-certs|relmio-searxng/u);

  for (const includeSearxng of [undefined, "true", 1, null]) {
    const remote = createFakeRemote();
    await assert.rejects(
      () => installAssistant({ remote, networkName: "proxy", confirmed: true, includeSearxng }),
      /SearXNG|boolean|web search/i,
    );
    assert.deepEqual(remote.commands, []);
    assert.deepEqual(remote.uploads, []);
  }
});

test("AI Assistant enables SearXNG only from a reviewed disabled marker and never silently disables it", async () => {
  const disabledInstallation = createAssistantInstallation({
    randomBytes: sequenceRandomBytes(),
    includeSearxng: false,
  });
  const currentNames = getAssistantManagedResourceNames(disabledInstallation);
  const currentLabels = `${disabledInstallation.installId}|true`;
  const disabledOwnedResources = [
    currentNames.containers.map((name) => `${name}|${currentLabels}`).join("\n") + "\n",
    `${currentNames.network}|${currentLabels}\n`,
    `${currentNames.volume}|${currentLabels}\n`,
  ];
  const enablingRemote = createFakeRemote({
    precheckState: `managed\n${serializeAssistantMarker(disabledInstallation)}`,
    exactAttestationStates: [...disabledOwnedResources, ...disabledOwnedResources],
  });
  const enabledResult = await installAssistant({
    remote: enablingRemote,
    networkName: "proxy",
    confirmed: true,
    includeSearxng: true,
    randomBytes: sequenceRandomBytes(),
  });
  assert.equal(enabledResult.includeSearxng, true);
  assert.ok(enabledResult.searxngUrl);
  const enabledVerification = createAssistantVerificationCommands({
    installation: { ...disabledInstallation, includeSearxng: true },
  });
  assert.match(enabledVerification.publicationState, /relmio-searxng/u);
  assert.doesNotMatch(enabledVerification.publicationState, /relmio-sandbox-certs/u);
  const enabledMarker = enablingRemote.uploads.find((upload) => upload.path === ASSISTANT_MARKER_PATH);
  assert.match(enabledMarker?.contents ?? "", /"includeSearxng":true/u);
  assert.ok(enablingRemote.commands.some((command) => / up -d --wait --wait-timeout 90 relmio-searxng$/u.test(command)));
  assert.ok(enablingRemote.commands.every((command) => !/ up -d --wait --wait-timeout 90 relmio-sandbox-api/u.test(command)));

  const enabledInstallation = { ...disabledInstallation, includeSearxng: true };
  const disableRemote = createFakeRemote({
    precheckState: `managed\n${serializeAssistantMarker(enabledInstallation)}`,
  });
  await assert.rejects(
    () => installAssistant({
      remote: disableRemote,
      networkName: "proxy",
      confirmed: true,
      includeSearxng: false,
      randomBytes: sequenceRandomBytes(),
    }),
    /disable|cleanup|SearXNG/i,
  );
  assert.equal(disableRemote.uploads.length, 0);
  assert.ok(disableRemote.commands.every((command) => !command.includes(" up -d ")));
});

test("SearXNG enablement rollback reports only the optional-service cleanup scope", async (t) => {
  const disabledInstallation = createAssistantInstallation({
    randomBytes: sequenceRandomBytes(),
    includeSearxng: false,
  });
  const names = getAssistantManagedResourceNames(disabledInstallation);
  const labels = `${disabledInstallation.installId}|true`;
  const ownedExistingResources = [
    names.containers.map((name) => `${name}|${labels}`).join("\n") + "\n",
    `${names.network}|${labels}\n`,
    `${names.volume}|${labels}\n`,
  ];
  const publishedPortState = {
    code: 0,
    stdout: JSON.stringify([
      { Service: "relmio-sandbox-api", Publishers: [] },
      { Service: "relmio-sandbox-runner-1", Publishers: [] },
      { Service: "relmio-searxng", Publishers: [{ PublishedPort: 8080, URL: "0.0.0.0" }] },
    ]),
    stderr: "",
  };
  const cases = [
    {
      label: "health failure",
      options: { healthResult: { code: 1, stdout: "", stderr: "" } },
      expected: /optional SearXNG service was removed.*existing sandbox remains.*do not use/i,
    },
    {
      label: "published-port failure",
      options: { publicationResult: publishedPortState },
      expected: /optional SearXNG service was removed.*existing sandbox remains.*do not use/i,
    },
    {
      label: "cleanup uncertainty",
      options: {
        healthResult: { code: 1, stdout: "", stderr: "" },
        cleanupResult: { code: 1, stdout: "", stderr: "" },
      },
      expected: /automatic optional SearXNG cleanup could not be confirmed/i,
      safeMessage: /automatic optional SearXNG cleanup could not be confirmed/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.label, async () => {
      const remote = createFakeRemote({
        precheckState: `managed\n${serializeAssistantMarker(disabledInstallation)}`,
        exactAttestationStates: [
          ...ownedExistingResources,
          ...ownedExistingResources,
          ...ownedExistingResources,
        ],
        ...scenario.options,
      });
      await assert.rejects(
        () => installAssistant({
          remote,
          networkName: "proxy",
          confirmed: true,
          includeSearxng: true,
          randomBytes: sequenceRandomBytes(),
        }),
        (error) => {
          assert.match(error.message, scenario.expected);
          assert.doesNotMatch(error.message, /companion project was removed/i);
          if (scenario.safeMessage) {
            assert.match(error.safeMessage ?? "", scenario.safeMessage);
            assert.doesNotMatch(error.safeMessage ?? "", /\/docker\//i);
          }
          return true;
        },
      );
      assert.equal(
        remote.commands.filter((command) => command.endsWith(" rm -sf relmio-searxng")).length,
        1,
      );
      assert.equal(
        remote.commands.filter((command) => command.endsWith(" down --volumes")).length,
        0,
      );
    });
  }
});

test("AI Assistant rejects a random source that repeats secrets", () => {
  assert.throws(
    () => createAssistantSecrets({ randomBytes: (size) => Buffer.alloc(size, 7), includeSearxng: true }),
    /independent|secret/i,
  );
});

test("AI Assistant refuses an incomplete generated secret environment", () => {
  assert.throws(() => createAssistantEnv({}, { includeSearxng: true }), /invalid/i);
});

test("AI Assistant reasserts managed file modes after every upload", async () => {
  const remote = createFakeRemote();
  await installAssistant({ remote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() });
  const modeCommand = remote.commands.find((command) => command.startsWith("chmod 600 "));
  assert.match(modeCommand ?? "", /\.managed-by-relmio-ai-assistant/);
  assert.match(modeCommand ?? "", /\.env/);
  assert.ok(remote.commands.some((command) => command.startsWith("chmod 644 ") && command.includes("docker-compose.yml") && command.includes("searxng-settings.yml")));
  assert.ok(remote.commands.some((command) => command.startsWith("test ") && command.includes("stat -c '%a'")));
  assert.ok(remote.events.findIndex((event) => event.type === "command" && event.value === modeCommand) > remote.events.findLastIndex((event) => event.type === "upload"));
});

test("AI Assistant allows only validated companion commands and labels its generated resources", () => {
  const installation = generatedInstallation();
  const commands = [
    ASSISTANT_PRECHECK_COMMAND,
    createAssistantNetworkCollisionCommand({ networkName: "proxy", installation }),
    ...Object.values(createAssistantOwnershipAttestationCommands({ installation })),
    ...createAssistantDeploymentCommands({ installation }),
    ...Object.values(createAssistantVerificationCommands({ installation })),
  ];
  assert.doesNotThrow(() => assertAssistantOnlyCommands({ commands, installation, networkName: "proxy" }));
  assert.ok(commands.every((command) => command.includes("/docker/n8n-openai-oauth") || command.includes(installation.projectName) || command.includes("docker network inspect proxy")));
  assert.match(ASSISTANT_PRECHECK_COMMAND, /\.managed-by-relmio-root/);
  assert.ok(commands.every((command) => !/\bn8n-n8n-\d+\b/i.test(command)));
  assert.throws(
    () => assertAssistantOnlyCommands({ commands: ["docker restart n8n-n8n-1"], installation, networkName: "proxy" }),
    /assistant|n8n/i,
  );

  const compose = createAssistantComposeFile({ networkName: "proxy", installation });
  assert.match(compose, new RegExp(`io\\.relmio\\.ai-assistant\\.install-id: "${installation.installId}"`));
  assert.match(compose, new RegExp(`name: ${installation.projectName}-internal`));
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.doesNotMatch(compose, /internal: true/);
  assert.match(createSearxngSettings(), /- json/);
});

test("AI Assistant Docker ownership and alias probes fail closed when their producers fail", async () => {
  const installation = generatedInstallation();
  const ownership = createAssistantOwnershipAttestationCommands({ installation });
  const collision = createAssistantNetworkCollisionCommand({ networkName: "proxy", installation });
  assert.ok(Object.values(ownership).every((command) => !/\|\s*xargs/u.test(command)));
  assert.match(collision, /ids=\$\(docker network inspect proxy/u);
  assert.match(collision, /\) && if \[ -n "\$ids" \]/u);

  const ownershipFailure = createFakeRemote({ attestationCodes: [1] });
  await assert.rejects(
    () => installAssistant({ remote: ownershipFailure, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /ownership/i,
  );
  assert.deepEqual(ownershipFailure.uploads, []);

  const aliasFailure = createFakeRemote({ collisionCode: 1 });
  await assert.rejects(
    () => installAssistant({ remote: aliasFailure, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /alias state/i,
  );
  assert.deepEqual(aliasFailure.uploads, []);

  const cleanupOwnershipFailure = createFakeRemote({
    startResult: { code: 1, stdout: "", stderr: "" },
    attestationCodes: [0, 0, 0, 0, 0, 0, 1],
  });
  await assert.rejects(
    () => installAssistant({ remote: cleanupOwnershipFailure, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /ownership.*cleanup|cleanup.*ownership/i,
  );
  assert.equal(cleanupOwnershipFailure.commands.filter((command) => command.endsWith(" down --volumes")).length, 0);
});

test("AI Assistant accepts unbound Compose publishers and rejects malformed publisher shapes", async () => {
  const publicationFixtures = [
    JSON.stringify([
      { Service: "relmio-sandbox-api", Publishers: null },
      { Service: "relmio-sandbox-runner-1", Publishers: [{ PublishedPort: 0, URL: "" }] },
      { Service: "relmio-searxng", Publishers: null },
    ]),
    [
      { Service: "relmio-sandbox-api", Publishers: [{ PublishedPort: 0, URL: "" }] },
      { Service: "relmio-sandbox-runner-1", Publishers: null },
      { Service: "relmio-searxng", Publishers: [{ PublishedPort: 0, URL: "" }] },
    ].map((service) => JSON.stringify(service)).join("\n"),
  ];
  for (const stdout of publicationFixtures) {
    const remote = createFakeRemote({ publicationResult: { code: 0, stdout, stderr: "" } });
    await installAssistant({ remote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() });
    assert.equal(remote.commands.filter((command) => command.endsWith(" down --volumes")).length, 0);
  }

  const malformed = createFakeRemote({
    publicationResult: {
      code: 0,
      stdout: JSON.stringify([
        { Service: "relmio-sandbox-api", Publishers: {} },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
        { Service: "relmio-searxng", Publishers: [] },
      ]),
      stderr: "",
    },
  });
  await assert.rejects(
    () => installAssistant({ remote: malformed, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /published-port/i,
  );
  assert.equal(malformed.commands.filter((command) => command.endsWith(" down --volumes")).length, 1);
});

test("AI Assistant makes one ownership-attested cleanup attempt for every post-start safety failure", async () => {
  const failures = [
    { startResult: { code: 1, stdout: "", stderr: "" }, label: "startup" },
    { healthResult: { code: 1, stdout: "", stderr: "" }, label: "health" },
    { runningResult: { code: 0, stdout: "relmio-sandbox-api\n", stderr: "" }, label: "running" },
    { publicationResult: { code: 0, stdout: "not-json", stderr: "" }, label: "malformed publication" },
    {
      publicationResult: {
        code: 0,
        stdout: JSON.stringify([
          { Service: "relmio-sandbox-api", Publishers: [{ PublishedPort: 8080, URL: "0.0.0.0" }] },
          { Service: "relmio-sandbox-runner-1", Publishers: [] },
          { Service: "relmio-searxng", Publishers: [] },
        ]),
        stderr: "",
      },
      label: "published port",
    },
  ];
  for (const failure of failures) {
    const remote = createFakeRemote(failure);
    await assert.rejects(
      () => installAssistant({ remote, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
      /companion|sandbox|published|running/i,
      failure.label,
    );
    assert.equal(remote.commands.filter((command) => command.endsWith(" down --volumes")).length, 1, failure.label);
  }

  const cleanupFailure = createFakeRemote({
    startResult: { code: 1, stdout: "", stderr: "" },
    cleanupResult: { code: 1, stdout: "", stderr: "" },
  });
  await assert.rejects(
    () => installAssistant({ remote: cleanupFailure, networkName: "proxy", confirmed: true, includeSearxng: true, randomBytes: sequenceRandomBytes() }),
    /cleanup could not be confirmed/i,
  );
  assert.equal(cleanupFailure.commands.filter((command) => command.endsWith(" down --volumes")).length, 1);
});

test("assistant route requires a fresh discovered network plan before installation", async (t) => {
  const calls = [];
  const remote = { close() {} };
  const wizard = await startWizardServer({
    sessionToken,
    uiFiles: { "/assistant": "assistant", "/assistant.js": "", "/styles.css": "" },
    services: {
      async scanHostFingerprint() { return "SHA256:fixture"; },
      async connectVerified() { return remote; },
      async discoverN8n() {
        return { dockerVersion: "28", composeVersion: "2", containers: [{ name: "n8n", id: "1", image: "n8nio/n8n", state: "running" }] };
      },
      async discoverNetworks() {
        return { networks: ["proxy"], recommended: "proxy", instanceAi: { status: "enabled" } };
      },
      async installAssistant(input) { calls.push(input); return { sandboxUrl: "http://sandbox:8080", sandboxApiKey: "shown-once", includeSearxng: true, searxngUrl: "http://search:8080", webSearch: "enabled", modelProvider: "OpenAI", modelRecommendation: "preserve-current-supported-selection", deploymentMode: "installed" }; },
    },
  });
  t.after(() => wizard.close());
  const request = (path, body = {}) => fetch(`${wizard.origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": wizard.origin, "X-Setup-Token": sessionToken },
    body: JSON.stringify(body),
  });
  await request("/api/ssh/fingerprint", { host: "vps.example.test", port: 22 });
  await request("/api/ssh/connect", { host: "vps.example.test", port: 22, username: "root", password: "x".repeat(32), expectedFingerprint: "SHA256:fixture" });
  await request("/api/discover");
  await request("/api/networks", { containerName: "n8n" });
  const stale = await request("/api/assistant/install", { containerName: "n8n", networkName: "proxy", includeSearxng: true, confirmed: true });
  assert.equal(stale.status, 400);
  const plan = await request("/api/assistant/plan", { containerName: "n8n", networkName: "proxy", includeSearxng: true });
  assert.equal(plan.status, 200);
  const installed = await request("/api/assistant/install", { containerName: "n8n", networkName: "proxy", includeSearxng: true, confirmed: true });
  assert.equal(installed.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].networkName, "proxy");
  assert.equal(calls[0].includeSearxng, true);
});

test("CLI, assistant UI, and guides keep credential, prerequisite, and abuse boundaries explicit", async () => {
  assert.equal(cliMode(["assistant"]), "assistant");
  const [html, browser, css, sharedCss, readme, npmReadme, guide] = await Promise.all([
    readFile("src/ui/assistant.html", "utf8"),
    readFile("src/ui/assistant.js", "utf8"),
    readFile("src/ui/assistant.css", "utf8"),
    readFile("src/ui/styles.css", "utf8"),
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/ai-assistant.md", "utf8"),
  ]);
  for (const contents of [html, readme, npmReadme, guide]) {
    assert.match(contents, /ChatGPT\/Codex subscription sign-in is not\s+an OpenAI Platform API\s+key/i);
    assert.match(contents, /AI\s+Assistant is Preview/i);
  }
  assert.match(html, /id="instance-ai-status"/i);
  assert.match(html, /id="instance-ai-guidance"/i);
  assert.match(html, /id="review-readiness"/i);
  assert.match(html, /id="review-button"[\s\S]*disabled/i);
  assert.match(html, /N8N_ENABLED_MODULES=instance-ai/u);
  assert.match(
    html,
    /append\s+<code>instance-ai<\/code>\s+as\s+a\s+distinct comma-delimited token[\s\S]*preserving existing module\s+entries/i,
  );
  assert.match(
    html,
    /existing Hostinger\/deployment workflow[\s\S]*redeploy or restart n8n[\s\S]*healthy[\s\S]*reconnect[\s\S]*discovery/i,
  );
  assert.match(
    html,
    /will not edit[^.]*n8n Compose[^.]*image[^.]*environment[^.]*restart[^.]*recreate[^.]*exec into n8n/i,
  );
  assert.match(html, /id="review-instance-ai"/i);
  assert.match(browser, /N8N_ENABLED_MODULES.*instance-ai/i);
  assert.match(browser, /Fresh rediscovery is required after n8n changes/i);
  assert.match(browser, /focus\(\{ preventScroll: true \}\)/u);
  assert.match(browser, /review-button"\)\.disabled = !prerequisiteReady/u);
  assert.doesNotMatch(browser, /instanceAi\.(?:value|raw|environment)/u);
  assert.match(html, /openai\/gpt-5\.6-sol/);
  assert.match(css, /\.assistant-wizard \.safety-note[\s\S]*grid-template-columns:\s*1\.75rem minmax\(0, 1fr\)/u);
  assert.match(css, /\.assistant-wizard \.safety-note > strong,[\s\S]*\.assistant-wizard \.safety-note > span[\s\S]*grid-column:\s*2/u);
  assert.match(html, /Keep your existing supported n8n model selection/i);
  assert.match(css, /\.assistant-wizard \.steps ol[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(sharedCss, /\.steps ol[\s\S]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(html, /Base URL[\s\S]*API key[\s\S]*Model ID/);
  assert.match(html, /Ollama-style custom endpoint/i);
  assert.match(html, /not an OpenAI-issued API key/i);
  assert.match(html, /experimental\/private\/policy-uncertain/i);
  assert.match(html, /No setup can guarantee an account is never flagged/i);
  assert.doesNotMatch(browser, /\.innerHTML\b/);
  assert.match(html, /not auto-selected, enabled, or presented as TOS-approved/i);
  assert.match(html, /URLs are stable generated result values; the sandbox key is shown only/i);
  assert.match(html, /Optional SearXNG JSON web search[\s\S]*Off by default/i);
  assert.match(guide, /Web search is \*\*off by default\*\*[\s\S]*never adds it\s+silently/i);
  assert.match(browser, /includeSearxng: state\.reviewedIncludeSearxng/u);
  assert.match(browser, /Web search disabled/u);
  assert.match(guide, /N8N_ENABLED_MODULES[\s\S]*instance-ai/i);
  assert.match(guide, /N8N_ENABLED_MODULES=instance-ai/u);
  assert.match(
    guide,
    /append\s+`instance-ai`\s+as\s+a\s+distinct comma-delimited token[\s\S]*preserving existing\s+module entries/i,
  );
  assert.match(
    guide,
    /redeploy or restart n8n[\s\S]*healthy[\s\S]*reconnect[\s\S]*discovery/i,
  );
  assert.match(
    guide,
    /will not edit[^.]*n8n Compose[^.]*image[^.]*environment[^.]*restart[^.]*recreate[^.]*exec into n8n/i,
  );
  assert.match(guide, /4 GB RAM[\s\S]*2 vCPU/i);
  assert.match(guide, /dedicated OpenAI Platform project\/key[\s\S]*rate\/spend limits[\s\S]*usage monitoring[\s\S]*least user access[\s\S]*rotation\/revocation[\s\S]*human review[\s\S]*public exposure/i);
  assert.match(guide, /cannot inject per-user safety identifiers or moderation/i);
  assert.match(guide, /may first\s+create\s+`\/docker\/n8n-openai-oauth`[\s\S]*shared mode-0600 Relmio root\s+marker[\s\S]*only the `assistant-sandbox` child[\s\S]*does not write existing n8n project files/i);
  assert.match(guide, /URLs are stable generated result values; only the sandbox API key is\s+one-time-displayed/i);
  assert.doesNotMatch(guide, /generated one-time result URL/i);
});
