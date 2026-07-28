import {
  INSTALL_ROOT,
  MANAGED_MARKER_PATH,
  PRECHECK_COMMAND,
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
const MARKER_CONTENT = "Managed by n8n-openai-oauth-setup.\n";

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

  await remote.upload(MANAGED_MARKER_PATH, MARKER_CONTENT, 0o644);
  await remote.upload(`${INSTALL_ROOT}/Dockerfile`, dockerfile, 0o644);
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

  const publication = await remote.exec(verification.publicationState);
  if (publication.code !== 0) {
    throw new Error("The published-port safety check failed.");
  }
  if (hasPublishedHostPort(publication.stdout)) {
    throw new Error(
      "Safety check failed: the sidecar unexpectedly published a host port.",
    );
  }

  const models = await runOrThrow(
    remote,
    verification.models,
    "OAuth model check",
  );

  return {
    baseUrl: `http://${SIDECAR_HOSTNAME}:10531/v1`,
    apiKeyPlaceholder: "local-only",
    useResponsesApi: true,
    models: parseModels(models.stdout),
    deploymentMode,
  };
}
