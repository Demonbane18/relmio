import { readFile } from "node:fs/promises";

import {
  INSTALL_ROOT,
  MANAGED_MARKER_PATH,
  PRECHECK_COMMAND,
  SHARED_ROOT_MARKER_CONTENT,
  SHARED_ROOT_MARKER_PATH,
  SIDECAR_MARKER_CONTENT,
  assertSidecarOnlyCommands,
  createDeploymentCommands,
  createVerificationCommands,
} from "../domain/safety.js";
import {
  SIDECAR_HOSTNAME,
  createComposeFile,
  createDockerfile,
} from "../domain/templates.js";

const MAX_AUTH_FILE_BYTES = 128 * 1024;
function validateAuthContents(contents) {
  if (!Buffer.isBuffer(contents)) {
    throw new TypeError("The OAuth credential file is invalid.");
  }
  if (contents.length === 0 || contents.length > MAX_AUTH_FILE_BYTES) {
    throw new TypeError("The OAuth credential file is invalid.");
  }

  try {
    const parsed = JSON.parse(contents.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError("The OAuth credential file is invalid.");
  }

  return contents;
}

async function runOrThrow(remote, command, label) {
  const result = await remote.exec(command);
  if (result.code !== 0) {
    throw new Error(
      `${label} failed. The existing n8n deployment was not changed.`,
    );
  }
  return result;
}

const MODEL_CHECK_UNREACHABLE = "RELMIO_MODEL_CHECK_UNREACHABLE";
const MAX_MODEL_CHECK_EVIDENCE_BYTES = 4 * 1024;
const UNSAFE_MODEL_CHECK_EVIDENCE =
  /(?:access|refresh)[_-]?token["']?\s*[:=]\s*["']?(?!reused\b)[A-Za-z0-9._-]{8,}|private[_-]?key|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+/iu;

function modelCheckFailureCategory(output) {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    Buffer.byteLength(output, "utf8") > MAX_MODEL_CHECK_EVIDENCE_BYTES ||
    UNSAFE_MODEL_CHECK_EVIDENCE.test(output)
  ) {
    return "unclassified";
  }
  if (output.trim() === MODEL_CHECK_UNREACHABLE) return "bridge";

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return "unclassified";
  }
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    !parsed.error || typeof parsed.error !== "object" ||
    Array.isArray(parsed.error) ||
    typeof parsed.error.message !== "string"
  ) {
    return "unclassified";
  }
  const message = parsed.error.message.toLowerCase();
  if (
    /^openai oauth token request failed with http 40[01]\b/u.test(message) ||
    /\b(?:refresh_token_reused|invalid_grant)\b/u.test(message)
  ) {
    return "refresh-rejected";
  }
  if (
    /^openai oauth token request failed with http (?:4\d\d|5\d\d)\b/u.test(message)
  ) {
    return "refresh";
  }
  if (
    /\b(?:401|unauthorized|invalid[_ -]?token|oauth session not found|authentication required|not authenticated|sign[ -]?in required|access token (?:expired|invalid))\b/u.test(message)
  ) {
    return "auth";
  }
  if (
    /\b(?:403|forbidden|not permitted|subscription (?:does not|is not|is required)|plan (?:does not|is not)|account does not (?:have access|permit)|insufficient[_ -](?:permissions|scope))\b/u.test(message)
  ) {
    return "permission";
  }
  if (
    /\b(?:econnrefused|econnreset|enotfound|etimedout|network|fetch failed|socket|dns|unreachable|timed out)\b/u.test(message)
  ) {
    return "network";
  }
  return "unclassified";
}

function modelCheckFailure(result) {
  const category = modelCheckFailureCategory(result?.stdout);
  const detail = {
    auth: "The saved ChatGPT sign-in was rejected or is no longer valid.",
    "refresh-rejected": "The saved ChatGPT sign-in could not be refreshed.",
    refresh: "The saved ChatGPT sign-in could not be refreshed.",
    permission: "The model service denied the bridge request.",
    network: "The bridge could not reach the model service.",
    bridge: "The bridge endpoint could not be reached for verification.",
    unclassified: "The bridge model check failed for an unclassified reason.",
  }[category];
  const message = `${detail} The existing n8n deployment was not changed.`;
  return Object.assign(new Error(message), {
    safeMessage: message,
    ...(["auth", "refresh-rejected"].includes(category)
      ? { recoveryAction: "refresh-chatgpt-sign-in" }
      : {}),
  });
}

function parseModels(output) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed.data)) {
      throw new TypeError();
    }

    const models = parsed.data
      .map((model) => model?.id)
      .filter(
        (id) =>
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= 128 &&
          /^[a-zA-Z0-9_.:-]+$/.test(id),
      );
    if (models.length === 0) {
      throw new TypeError();
    }
    return models;
  } catch {
    throw new Error(
      "The sidecar started, but its model response could not be verified.",
    );
  }
}

function hasPublishedHostPort(output) {
  try {
    const parsed = JSON.parse(output);
    const services = Array.isArray(parsed) ? parsed : [parsed];
    if (services.length === 0) {
      throw new TypeError();
    }

    for (const service of services) {
      if (!service || !Array.isArray(service.Publishers)) {
        throw new TypeError();
      }
      for (const publisher of service.Publishers) {
        if (
          !publisher ||
          !Number.isInteger(publisher.PublishedPort) ||
          publisher.PublishedPort < 0 ||
          typeof publisher.URL !== "string"
        ) {
          throw new TypeError();
        }
        if (publisher.PublishedPort > 0 || publisher.URL.trim() !== "") {
          return true;
        }
      }
    }
    return false;
  } catch {
    throw new Error("The published-port safety check failed.");
  }
}

async function failPublicationSafetyCheck(remote, cleanupCommand, reason) {
  let cleanupSucceeded = false;
  try {
    cleanupSucceeded = (await remote.exec(cleanupCommand)).code === 0;
  } catch {
    cleanupSucceeded = false;
  }
  if (!cleanupSucceeded) {
    throw Object.assign(
      new Error(
        `${reason} Automatic cleanup could not be confirmed. Do not use the sidecar until it is removed from /docker/n8n-openai-oauth.`,
      ),
      {
        safeMessage:
          "Automatic cleanup could not be confirmed. Do not use the sidecar until an administrator confirms its removal.",
      },
    );
  }
  throw new Error(
    `${reason} The sidecar was removed; the existing n8n deployment was not changed.`,
  );
}

export async function installSidecar({
  remote,
  networkName,
  authContents,
  confirmed,
}) {
  if (confirmed !== true) {
    throw new Error("Confirm the sidecar-only deployment before installing.");
  }

  const safeAuthContents = validateAuthContents(authContents);
  const dockerfile = createDockerfile();
  const sidecarRuntime = await readFile(
    new URL("../gateway/openai-oauth-sidecar.mjs", import.meta.url),
  );
  const composeFile = createComposeFile({ networkName });
  const deploymentCommands = createDeploymentCommands();
  const verification = createVerificationCommands();

  assertSidecarOnlyCommands([
    PRECHECK_COMMAND,
    ...deploymentCommands,
    ...Object.values(verification),
  ]);

  const precheck = await remote.exec(PRECHECK_COMMAND);
  if (precheck.code === 42) {
    throw new Error(
      "The install directory already exists and is unmanaged. Nothing was overwritten.",
    );
  }
  if (precheck.code !== 0) {
    throw new Error("The VPS install-directory check failed.");
  }
  const precheckState = precheck.stdout.trim();
  if (!["managed", "new"].includes(precheckState)) {
    throw new Error("The VPS install-directory check returned an invalid state.");
  }
  const deploymentMode =
    precheckState === "managed" ? "updated" : "installed";

  await runOrThrow(remote, deploymentCommands[0], "Sidecar directory creation");
  await runOrThrow(remote, deploymentCommands[1], "Auth directory creation");

  await remote.upload(SHARED_ROOT_MARKER_PATH, SHARED_ROOT_MARKER_CONTENT, 0o600);
  await remote.upload(MANAGED_MARKER_PATH, SIDECAR_MARKER_CONTENT, 0o644);
  await remote.upload(`${INSTALL_ROOT}/Dockerfile`, dockerfile, 0o644);
  await remote.upload(`${INSTALL_ROOT}/openai-oauth-sidecar.mjs`, sidecarRuntime, 0o644);
  await remote.upload(
    `${INSTALL_ROOT}/docker-compose.yml`,
    composeFile,
    0o644,
  );
  await remote.upload(
    `${INSTALL_ROOT}/auth/auth.json`,
    safeAuthContents,
    0o600,
  );

  for (const command of deploymentCommands.slice(2)) {
    await runOrThrow(remote, command, "Sidecar deployment");
  }

  const running = await runOrThrow(
    remote,
    verification.runningService,
    "Sidecar status check",
  );
  if (!running.stdout.split(/\s+/u).includes("openai-oauth")) {
    throw new Error("The sidecar did not reach the running state.");
  }

  let publication;
  try {
    publication = await remote.exec(verification.publicationState);
  } catch {
    await failPublicationSafetyCheck(
      remote,
      verification.cleanup,
      "The published-port safety check could not be completed.",
    );
  }
  if (publication.code !== 0) {
    await failPublicationSafetyCheck(
      remote,
      verification.cleanup,
      "The published-port safety check failed.",
    );
  }
  let publishedHostPort;
  try {
    publishedHostPort = hasPublishedHostPort(publication.stdout);
  } catch {
    await failPublicationSafetyCheck(
      remote,
      verification.cleanup,
      "The published-port safety check failed.",
    );
  }
  if (publishedHostPort) {
    await failPublicationSafetyCheck(
      remote,
      verification.cleanup,
      "Safety check failed: the sidecar unexpectedly published a host port.",
    );
  }

  let models;
  try {
    models = await remote.exec(verification.models);
  } catch {
    const message = "Relmio could not complete model verification over the VPS connection. The existing n8n deployment was not changed.";
    throw Object.assign(new Error(message), { safeMessage: message });
  }
  if (models.code !== 0) throw modelCheckFailure(models);

  return {
    baseUrl: `http://${SIDECAR_HOSTNAME}:10531/v1`,
    apiKeyPlaceholder: "local-only",
    useResponsesApi: true,
    models: parseModels(models.stdout),
    deploymentMode,
  };
}
