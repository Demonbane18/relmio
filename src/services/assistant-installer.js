import { randomBytes as cryptoRandomBytes } from "node:crypto";

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
  getAssistantContainerNames,
  getAssistantManagedResourceNames,
  getAssistantServiceNames,
  parseAssistantPrecheck,
  serializeAssistantMarker,
  validateAssistantSearxngSelection,
} from "../domain/assistant.js";
import { SHARED_ROOT_MARKER_CONTENT } from "../domain/safety.js";
import {
  ASSISTANT_COMPANION_IMAGES,
  createAssistantComposeFile,
  createAssistantEnv,
  createAssistantSecrets,
  createSearxngSettings,
} from "../domain/assistant-templates.js";

const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/iu;

function createN8nSettings({ installation, secrets }) {
  const settings = {
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: ASSISTANT_COMPANION_IMAGES.sandbox,
    N8N_SANDBOX_SERVICE_URL: `http://${installation.sandboxAlias}:8080`,
    ...(secrets
      ? { N8N_SANDBOX_SERVICE_API_KEY: secrets.sandboxApiKey }
      : {}),
  };
  if (installation.includeSearxng) {
    settings.N8N_INSTANCE_AI_SEARXNG_URL =
      `http://${installation.searxngAlias}:8080`;
  }
  return settings;
}

function getExpectedRunningServices(installation) {
  return new Set(
    getAssistantServiceNames(installation).filter(
      (service) => service !== "relmio-sandbox-certs",
    ),
  );
}

function parseJsonLines(output, label) {
  if (typeof output !== "string" || output.trim() === "") {
    throw new Error(label + " could not be verified.");
  }
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      return output.trim().split("\n").map((line) => JSON.parse(line));
    } catch {
      throw new Error(label + " could not be verified.");
    }
  }
}

function parseSandboxHealth(output) {
  const values = parseJsonLines(output, "The sandbox API health");
  if (values.length !== 1 || values[0]?.status !== "ok") {
    throw new Error("The sandbox API health could not be verified.");
  }
}

function verifyRunningServices(output, installation) {
  if (typeof output !== "string") {
    throw new Error("The companion service status could not be verified.");
  }
  const expectedRunningServices = getExpectedRunningServices(installation);
  const running = new Set(output.split("\n").map((value) => value.trim()).filter(Boolean));
  if (
    running.size !== expectedRunningServices.size ||
    [...expectedRunningServices].some((service) => !running.has(service))
  ) {
    throw new Error("The expected AI Assistant companion services are not running.");
  }
}

function hasPublishedHostPort(output, installation) {
  const services = parseJsonLines(output, "The published-port state");
  const expectedRunningServices = getExpectedRunningServices(installation);
  if (services.length !== expectedRunningServices.size) {
    throw new Error("The published-port state could not be verified.");
  }
  const seen = new Set();
  for (const service of services) {
    if (
      !service ||
      typeof service.Service !== "string" ||
      !expectedRunningServices.has(service.Service) ||
      seen.has(service.Service) ||
      (service.Publishers !== null && !Array.isArray(service.Publishers))
    ) {
      throw new Error("The published-port state could not be verified.");
    }
    seen.add(service.Service);
    for (const publisher of service.Publishers ?? []) {
      if (
        !publisher ||
        !Number.isInteger(publisher.PublishedPort) ||
        publisher.PublishedPort < 0 ||
        typeof publisher.URL !== "string"
      ) {
        throw new Error("The published-port state could not be verified.");
      }
      if (publisher.PublishedPort > 0 || publisher.URL.trim() !== "") {
        return true;
      }
    }
  }
  return false;
}

async function runOrThrow(remote, command, label) {
  const result = await remote.exec(command);
  if (result.code !== 0) {
    throw new Error(label + " failed. The existing n8n deployment was not changed.");
  }
  return result;
}

function attestOutput(output, installation, label) {
  if (typeof output !== "string" || output.length > 16 * 1024) {
    throw new Error("The AI Assistant " + label + " ownership could not be verified.");
  }
  let count = 0;
  for (const line of output.split("\n").map((value) => value.trim()).filter(Boolean)) {
    if (line !== installation.installId + "|true") {
      throw new Error("The AI Assistant " + label + " ownership could not be verified.");
    }
    count += 1;
  }
  return count;
}

function attestExactResourceOutput(
  output,
  installation,
  label,
  policy,
  { legacyOwnedContainerCount = 0 } = {},
) {
  if (typeof output !== "string" || output.length > 16 * 1024) {
    throw new Error("The AI Assistant exact " + label + " ownership could not be verified.");
  }
  const names = getAssistantManagedResourceNames(installation);
  const expectedNames = new Set(
    label === "containers" ? names.containers : [names[label]],
  );
  const seen = new Set();
  const enablingSearxng = policy === "enable-searxng";
  const searxngContainer = getAssistantContainerNames(installation).searxng;
  for (const line of output.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const [name, installId, managed, ...extra] = line.split("|");
    if (
      extra.length > 0 ||
      !expectedNames.has(name) ||
      seen.has(name) ||
      typeof installId !== "string" ||
      typeof managed !== "string"
    ) {
      throw new Error("The AI Assistant exact " + label + " ownership could not be verified.");
    }
    seen.add(name);
    if (policy === "absent") {
      throw new Error("A predictable AI Assistant " + label + " resource name is already occupied.");
    }
    if (enablingSearxng && label === "containers" && name === searxngContainer) {
      throw new Error("The optional AI Assistant SearXNG container is already occupied.");
    }
    if (installId !== installation.installId || managed !== "true") {
      throw new Error("The AI Assistant exact " + label + " ownership could not be verified.");
    }
  }
  if (enablingSearxng) {
    if (
      label === "containers" &&
      seen.size === 0 &&
      legacyOwnedContainerCount >= getAssistantServiceNames({
        ...installation,
        includeSearxng: false,
      }).length
    ) {
      return;
    }
    const requiredOwnedNames = label === "containers"
      ? names.containers.filter((name) => name !== searxngContainer)
      : [names[label]];
    if (requiredOwnedNames.some((name) => !seen.has(name))) {
      throw new Error("The AI Assistant exact " + label + " ownership could not be verified.");
    }
  }
}

async function attestAssistantOwnership(remote, installation, { exactResourcePolicy = "owned" } = {}) {
  const commands = createAssistantOwnershipAttestationCommands({ installation });
  const ownershipCounts = {};
  for (const [label, command] of Object.entries(commands)) {
    const result = await remote.exec(command);
    if (result.code !== 0) {
      throw new Error("The AI Assistant " + label + " ownership could not be verified.");
    }
    ownershipCounts[label] = attestOutput(result.stdout, installation, label);
  }
  const exactCommands = createAssistantExactResourceAttestationCommands({ installation });
  for (const [label, command] of Object.entries(exactCommands)) {
    const result = await remote.exec(command);
    if (result.code !== 0) {
      throw new Error("The AI Assistant exact " + label + " ownership could not be verified.");
    }
    attestExactResourceOutput(result.stdout, installation, label, exactResourcePolicy, {
      legacyOwnedContainerCount: ownershipCounts.containers,
    });
  }
}

function parseNetworkAliases(output, installation) {
  if (typeof output !== "string" || output.length > 64 * 1024) {
    throw new Error("The selected network alias state could not be verified.");
  }
  const requestedAliases = new Set([
    installation.sandboxAlias,
    ...(installation.includeSearxng ? [installation.searxngAlias] : []),
  ]);
  for (const line of output.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const [containerId, installId, aliases, ...extra] = line.split("|");
    if (
      extra.length > 0 ||
      !CONTAINER_ID_PATTERN.test(containerId ?? "") ||
      typeof installId !== "string" ||
      typeof aliases !== "string"
    ) {
      throw new Error("The selected network alias state could not be verified.");
    }
    const collidingAlias = aliases.split(",").some((alias) => requestedAliases.has(alias));
    if (collidingAlias && installId !== installation.installId) {
      throw new Error("A requested AI Assistant network alias is already attached to a foreign container.");
    }
  }
}

async function verifyNetworkAliases(remote, networkName, installation) {
  const command = createAssistantNetworkCollisionCommand({
    networkName,
    installation,
  });
  const result = await remote.exec(command);
  if (result.code !== 0) {
    throw new Error("The selected network alias state could not be verified.");
  }
  parseNetworkAliases(result.stdout, installation);
}

async function failAfterStart({
  remote,
  installation,
  cleanupCommand,
  cleanupScope,
  reason,
  cleanupState,
}) {
  const searxngOnly = cleanupScope === "searxng";
  if (cleanupState.attempted) {
    throw new Error(
      reason + (searxngOnly
        ? " Optional SearXNG cleanup was already attempted; do not use the AI Assistant companion."
        : " Cleanup was already attempted; do not use the AI Assistant companion."),
    );
  }
  cleanupState.attempted = true;
  try {
    await attestAssistantOwnership(remote, installation);
  } catch {
    throw new Error(
      reason + (searxngOnly
        ? " Optional SearXNG ownership could not be confirmed, so cleanup was not attempted. Do not use the AI Assistant companion until an administrator verifies its state."
        : " Companion ownership could not be confirmed, so cleanup was not attempted. Do not use the AI Assistant companion until its ownership is inspected."),
    );
  }

  let cleanupSucceeded = false;
  try {
    cleanupSucceeded = (await remote.exec(cleanupCommand)).code === 0;
  } catch {
    cleanupSucceeded = false;
  }
  if (!cleanupSucceeded) {
    const cleanupMessage = searxngOnly
      ? "Automatic optional SearXNG cleanup could not be confirmed. Do not use the AI Assistant companion until an administrator verifies its state."
      : "Automatic cleanup could not be confirmed. Do not use the AI Assistant companion until an administrator confirms its removal.";
    throw Object.assign(
      new Error(
        reason + " " + cleanupMessage,
      ),
      {
        safeMessage: cleanupMessage,
      },
    );
  }
  if (searxngOnly) {
    throw new Error(
      reason + " The optional SearXNG service was removed. The existing sandbox remains; do not use the AI Assistant companion until an administrator verifies its state.",
    );
  }
  throw new Error(
    reason + " The ownership-attested AI Assistant companion project was removed; the existing n8n deployment was not changed.",
  );
}

export async function installAssistant({
  remote,
  networkName,
  confirmed,
  includeSearxng,
  randomBytes = cryptoRandomBytes,
}) {
  if (confirmed !== true) {
    throw new Error("Confirm the AI Assistant companion deployment before installing.");
  }
  const selectedSearxng = validateAssistantSearxngSelection(includeSearxng);

  const precheck = await remote.exec(ASSISTANT_PRECHECK_COMMAND);
  if (precheck.code === 42) {
    throw new Error("The AI Assistant directory or shared root already exists and is unmanaged. Nothing was overwritten.");
  }
  if (precheck.code === 43) {
    throw new Error("The AI Assistant directory or shared root is unsafe or symlinked. Nothing was overwritten.");
  }
  if (precheck.code !== 0) {
    throw new Error("The VPS AI Assistant install-directory check failed.");
  }

  const precheckResult = parseAssistantPrecheck(precheck.stdout);
  const previousInstallation = precheckResult.installation;
  if (
    previousInstallation?.includeSearxng === true &&
    selectedSearxng === false
  ) {
    throw new Error(
      "Disabling previously managed SearXNG would remove a companion service. Use a separately authorized cleanup path instead.",
    );
  }
  const enablingSearxng =
    previousInstallation?.includeSearxng === false && selectedSearxng === true;
  const installation = previousInstallation
    ? { ...previousInstallation, includeSearxng: selectedSearxng }
    : createAssistantInstallation({ randomBytes, includeSearxng: selectedSearxng });
  const deploymentMode = precheckResult.state === "managed" ? "updated" : "installed";
  const startupScope = enablingSearxng ? "searxng" : "all";
  const cleanupScope = enablingSearxng ? "searxng" : "project";
  const deploymentCommands = createAssistantDeploymentCommands({ installation, startupScope });
  const verification = createAssistantVerificationCommands({ installation, cleanupScope });
  const exactResourcePolicy = deploymentMode === "installed"
    ? "absent"
    : enablingSearxng
      ? "enable-searxng"
      : "owned";
  const collisionCommand = createAssistantNetworkCollisionCommand({
    networkName,
    installation,
  });
  assertAssistantOnlyCommands({
    commands: [
      ASSISTANT_PRECHECK_COMMAND,
      collisionCommand,
      ...Object.values(createAssistantOwnershipAttestationCommands({ installation })),
      ...Object.values(createAssistantExactResourceAttestationCommands({ installation })),
      ...deploymentCommands,
      ...Object.values(verification),
    ],
    installation,
    networkName,
    startupScope,
    cleanupScope,
  });

  await verifyNetworkAliases(remote, networkName, installation);
  await attestAssistantOwnership(remote, installation, { exactResourcePolicy });

  const composeFile = createAssistantComposeFile({ networkName, installation });
  const settingsFile = installation.includeSearxng ? createSearxngSettings() : null;
  const secrets = enablingSearxng
    ? null
    : createAssistantSecrets({ randomBytes, includeSearxng: installation.includeSearxng });
  const envFile = secrets
    ? createAssistantEnv(secrets, { includeSearxng: installation.includeSearxng })
    : null;

  await runOrThrow(remote, deploymentCommands[0], "AI Assistant shared root creation");
  await runOrThrow(remote, deploymentCommands[1], "AI Assistant directory creation");
  await remote.upload(ASSISTANT_ROOT_MARKER_PATH, SHARED_ROOT_MARKER_CONTENT, 0o600);
  if (!enablingSearxng) {
    await remote.upload(ASSISTANT_MARKER_PATH, serializeAssistantMarker(installation), 0o600);
  }
  await remote.upload(ASSISTANT_ROOT + "/docker-compose.yml", composeFile, 0o644);
  if (settingsFile) {
    await remote.upload(ASSISTANT_ROOT + "/searxng-settings.yml", settingsFile, 0o644);
  }
  if (envFile) {
    await remote.upload(ASSISTANT_ROOT + "/.env", envFile, 0o600);
  }
  await runOrThrow(remote, deploymentCommands[2], "AI Assistant private file permissions");
  await runOrThrow(remote, deploymentCommands[3], "AI Assistant public file permissions");
  await runOrThrow(remote, deploymentCommands[4], "AI Assistant private file mode verification");
  await runOrThrow(remote, deploymentCommands[5], "AI Assistant public file mode verification");
  await runOrThrow(remote, deploymentCommands[6], "AI Assistant Compose validation");
  await attestAssistantOwnership(remote, installation, { exactResourcePolicy });

  const cleanupState = { attempted: false };
  try {
    await runOrThrow(remote, deploymentCommands[7], "AI Assistant companion startup");
  } catch {
    await failAfterStart({
      remote,
      installation,
      cleanupCommand: verification.cleanup,
      cleanupScope,
      reason: "The AI Assistant companion startup failed.",
      cleanupState,
    });
  }

  try {
    const health = await runOrThrow(
      remote,
      verification.health,
      "Sandbox API health check",
    );
    parseSandboxHealth(health.stdout);
  } catch {
    await failAfterStart({
      remote,
      installation,
      cleanupCommand: verification.cleanup,
      cleanupScope,
      reason: "The sandbox API health check failed.",
      cleanupState,
    });
  }

  try {
    const running = await runOrThrow(
      remote,
      verification.runningServices,
      "AI Assistant companion status check",
    );
    verifyRunningServices(running.stdout, installation);
  } catch {
    await failAfterStart({
      remote,
      installation,
      cleanupCommand: verification.cleanup,
      cleanupScope,
      reason: "The AI Assistant companion service check failed.",
      cleanupState,
    });
  }

  let publishedHostPort;
  try {
    const publication = await remote.exec(verification.publicationState);
    if (publication.code !== 0) {
      throw new Error("The published-port safety check failed.");
    }
    publishedHostPort = hasPublishedHostPort(publication.stdout, installation);
  } catch {
    await failAfterStart({
      remote,
      installation,
      cleanupCommand: verification.cleanup,
      cleanupScope,
      reason: "The published-port safety check failed.",
      cleanupState,
    });
  }
  if (publishedHostPort) {
    await failAfterStart({
      remote,
      installation,
      cleanupCommand: verification.cleanup,
      cleanupScope,
      reason: "Safety check failed: the AI Assistant companion unexpectedly published a host port.",
      cleanupState,
    });
  }

  if (enablingSearxng) {
    try {
      await remote.upload(ASSISTANT_MARKER_PATH, serializeAssistantMarker(installation), 0o600);
      await runOrThrow(remote, deploymentCommands[2], "AI Assistant private file permissions");
      await runOrThrow(remote, deploymentCommands[4], "AI Assistant private file mode verification");
    } catch {
      await failAfterStart({
        remote,
        installation,
        cleanupCommand: verification.cleanup,
        cleanupScope,
        reason: "The AI Assistant SearXNG marker update failed.",
        cleanupState,
      });
    }
  }

  const n8nSettings = createN8nSettings({ installation, secrets });
  return {
    sandboxUrl: n8nSettings.N8N_SANDBOX_SERVICE_URL,
    sandboxApiKey: secrets?.sandboxApiKey ?? null,
    includeSearxng: installation.includeSearxng,
    webSearch: installation.includeSearxng ? "enabled" : "disabled",
    ...(installation.includeSearxng
      ? { searxngUrl: n8nSettings.N8N_INSTANCE_AI_SEARXNG_URL }
      : {}),
    n8nSettings,
    modelProvider: "OpenAI",
    modelRecommendation: "preserve-current-supported-selection",
    deploymentMode,
  };
}
