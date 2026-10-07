import {
  createHash,
  randomBytes as createRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import packageManifest from "../../package.json" with { type: "json" };

import { listSiwcModels } from "../gateway/openai-oauth-sidecar.mjs";
import { discoverN8n, discoverNetworks } from "../services/discovery.js";
import {
  changeVpsCodexImages, changeVpsModelChecks, getVpsCodexImagesStatus, getVpsModelDiscovery, getVpsSiwcInstallationStatus,
  inspectStoppedVpsSiwcInstallation, getVpsUsageStatus,
  installSidecar, manageVpsSiwcInstallation, reviewVpsLegacyMigration, reviewVpsSiwcReplacement, reviewVpsSiwcTarget,
  reviewVpsSiwcResume, reconcileVpsSiwcHandoff, reviewVpsSiwcRuntimeUpdate, updateVpsSiwcRuntime,
} from "../services/installer.js";
import { usageView } from "../services/model-discovery.mjs";
import { inspectVpsSuperGrok, reviewVpsSuperGrok, installVpsSuperGrok, changeVpsSuperGrok, getVpsGrokLoginStatus, discoverVpsGrokModels } from "../services/vps-supergrok.js";
import { inspectVpsLocalModel, reviewVpsLocalModel, installVpsLocalModel, changeVpsLocalModel, getVpsLocalModelOperationStatus } from "../services/vps-local-model.js";
import { installAssistant } from "../services/assistant-installer.js";
import { getAuthStatus, listAuthRegistrations, startOAuthLogin } from "../services/oauth.js";
import {
  acknowledgePlanUse, getSelectedRegistration, readRegistration, resolveSiwcStorageRoot,
  selectRegistration, setPlanEnabled, signOut,
} from "../services/siwc-session.mjs";
import { readUiPreferences, writeUiPreferences } from "../services/ui-preferences.js";
import {
  connectVerified,
  scanHostFingerprint,
  getSshCapabilities,
} from "../infrastructure/ssh.js";
import {
  validateHostname,
  validatePort,
  validateUsername,
} from "../domain/validation.js";
import { SIDECAR_HOSTNAME } from "../domain/templates.js";
import {
  ASSISTANT_ROOT,
  validateAssistantSearxngSelection,
} from "../domain/assistant.js";
import { ASSISTANT_COMPANION_IMAGES } from "../domain/assistant-templates.js";
import {
  createLocalDeploymentPlan,
  validateLocalTarget,
} from "../domain/local-endpoints.js";
import {
  LOCAL_N8N_SIDECAR_ENDPOINT,
  LOCAL_N8N_SIDECAR_TARGET,
  createLocalN8nSidecarPlan,
} from "../domain/local-n8n-sidecar.js";
import {
  LOCAL_N8N_ASSISTANT_TARGET,
  createLocalN8nAssistantPlan,
} from "../domain/local-n8n-assistant.js";
import {
  LOCAL_N8N_SUPERGROK_ENDPOINT,
  LOCAL_N8N_SUPERGROK_TARGET,
  createLocalN8nSuperGrokPlan,
} from "../domain/local-n8n-supergrok.js";
import { LOCAL_N8N_MODEL_TARGET, LOCAL_N8N_MODEL_ENDPOINT, LOCAL_MODEL_CATALOG, LOCAL_MODEL_RUNTIME_IMAGE, getLocalModelDefinition, createLocalN8nModelPlan } from "../domain/local-n8n-model.js";
import { LOCAL_MODEL_CATALOG_REVISION } from "../local-model/catalog.mjs";
import { HOSTING_PROVIDERS } from "../domain/hosting-providers.js";
import { createHostingDeploymentPlan, getHostingDeploymentProfiles } from "../domain/hosting-deployment.js";
import {
  LOCAL_N8N_STACK_PUBLIC_CONFIRMATION,
  LOCAL_N8N_STACK_REMOVE_CONFIRMATION,
  LOCAL_N8N_STACK_TARGET,
  createLocalN8nStackPlan,
} from "../domain/local-n8n-stack.js";
import {
  acquireLocalEndpointChangeLock,
  activateLocalClientCredentialRotation,
  getManagedLocalEndpointStatus,
  getLocalDockerStatus,
  installLocalEndpoint,
  reviewLocalCodexLegacyMigration,
  reviewLocalCodexSiwcReplacement,
  inspectStoppedLocalSiwcInstallation,
  manageLocalSiwcInstallation,
  reviewLocalSiwcResume,
  reconcileLocalSiwcHandoff,
  prepareLocalClientCredentialRotation,
} from "../services/local-installer.js";
import { copySiwcAccountView, copySiwcStaging, getLocalDashboardStatus } from "../services/local-dashboard.js";
import {
  discoverLocalN8nSidecarTargets,
  getLocalN8nSidecarStatus,
  getLocalN8nSidecarUsage,
  reviewLocalN8nLegacyMigration,
  reviewLocalN8nSiwcReplacement,
  inspectStoppedLocalN8nSiwcInstallation,
  installLocalN8nSidecar,
  manageLocalN8nSiwcInstallation,
  reviewLocalN8nSiwcResume,
  reconcileLocalN8nSiwcHandoff,
  removeLocalN8nSidecar,
} from "../services/local-n8n-sidecar-installer.js";
import {
  editLocalN8nAssistantSearxng,
  installLocalN8nAssistant,
  prepareLocalN8nAssistantSearxngUpdate,
  removeLocalN8nAssistant,
} from "../services/local-n8n-assistant-installer.js";
import {
  getLocalN8nSuperGrokStatus,
  installLocalN8nSuperGrok,
  removeLocalN8nSuperGrok,
} from "../services/local-n8n-supergrok-installer.js";
import { getLocalN8nModelStatus, installLocalN8nModel, reviewLocalN8nModelAction, applyLocalN8nModelAction, inspectLocalN8nModelResources } from "../services/local-n8n-model-installer.js";
import {
  LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE,
  LOCAL_N8N_STACK_NGROK_SETUP_REJECTED_FAILURE_KIND,
  LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE,
  getLocalN8nStackStatus,
  installLocalN8nStack,
  removeLocalN8nStack,
  resumeLocalN8nStack,
} from "../services/local-n8n-stack-installer.js";
import { validateLocalN8nStackSecrets } from "../templates/local-n8n-stack/index.js";
import { createLocalChatTestService } from "../services/local-chat-test.js";
import { createPrivateBrowserHandoff } from "../services/browser-handoff.js";
import { isPrivateBrowserLaunchUrl } from "../browser.js";

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const OAUTH_SHUTDOWN_WAIT_MS = 2_000;
const VPS_CONNECTION_IDLE_MS = 15 * 60 * 1000;
const LOCAL_ROTATION_STAGE_TTL_MS = 2 * 60 * 1000;
const BROWSER_BOOTSTRAP_TTL_MS = 30 * 1000;
const BROWSER_TRANSFER_TTL_MS = 10 * 1000;
const MAX_PENDING_BROWSER_BOOTSTRAPS = 8;
const MAX_PENDING_BROWSER_TRANSFERS = 8;
const BROWSER_PREPARE_PATH = "/__relmio/browser/prepare";
const BROWSER_BOOTSTRAP_PATH = "/__relmio/browser/bootstrap";
const BROWSER_TRANSFER_PATH = "/__relmio/browser/transfer";
const BROWSER_BOOTSTRAP_ROUTES = new Set(["/", "/assistant", "/local", "/supergrok-vps", "/local-model-vps", "/hosting"]);
const BROWSER_BOOTSTRAP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PACKAGE_VERSION = packageManifest.version;
const OAUTH_VPS_CONFLICT_MESSAGE =
  "ChatGPT sign-in is in progress. Wait for it to finish or cancel it before changing the VPS.";
const VPS_OAUTH_CONFLICT_MESSAGE =
  "A VPS change is already in progress. Wait for it to finish before starting ChatGPT sign-in.";

async function getProjectMeta({ fetchImpl = fetch } = {}) {
  let stars = null;
  try {
    const response = await fetchImpl(
      "https://api.github.com/repos/Demonbane18/relmio",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `relmio/${PACKAGE_VERSION}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.ok) {
      const value = (await response.json())?.stargazers_count;
      if (Number.isSafeInteger(value) && value >= 0) {
        stars = value;
      }
    }
  } catch {
    // The local control keeps a visible fallback when GitHub is unavailable.
  }
  return { stars, version: PACKAGE_VERSION };
}

const defaultServices = {
  getAuthStatus,
  listAuthRegistrations,
  getSelectedRegistration,
  readRegistration,
  selectRegistration,
  acknowledgePlanUse,
  setPlanEnabled,
  signOut,
  startOAuthLogin,
  listSiwcModels,
  scanHostFingerprint,
  connectVerified,
  getSshCapabilities,
  discoverN8n,
  discoverNetworks,
  installSidecar,
  getVpsSiwcInstallationStatus,
  inspectStoppedVpsSiwcInstallation,
  manageVpsSiwcInstallation,
  reviewVpsLegacyMigration,
  reviewVpsSiwcReplacement,
  reviewVpsSiwcTarget,
  reviewVpsSiwcResume,
  reconcileVpsSiwcHandoff,
  reviewVpsSiwcRuntimeUpdate,
  updateVpsSiwcRuntime,
  getVpsCodexImagesStatus,
  changeVpsCodexImages,
  getVpsModelDiscovery,
  changeVpsModelChecks,
  getVpsUsageStatus,
  inspectVpsSuperGrok, reviewVpsSuperGrok, installVpsSuperGrok, changeVpsSuperGrok, getVpsGrokLoginStatus, discoverVpsGrokModels,
  inspectVpsLocalModel, reviewVpsLocalModel, installVpsLocalModel, changeVpsLocalModel, getVpsLocalModelOperationStatus,
  installAssistant,
  getManagedLocalEndpointStatus,
  getLocalDockerStatus,
  getLocalDashboardStatus,
  getLocalN8nStackStatus,
  getLocalN8nSuperGrokStatus,
  discoverLocalN8nSidecarTargets,
  getLocalN8nSidecarStatus,
  getLocalN8nSidecarUsage,
  inspectStoppedLocalN8nSiwcInstallation,
  inspectStoppedLocalSiwcInstallation,
  manageLocalN8nSiwcInstallation,
  manageLocalSiwcInstallation,
  getLocalN8nModelStatus,
  inspectLocalN8nModelResources,
  getProjectMeta,
  readUiPreferences,
  writeUiPreferences,
  reviewLocalCodexLegacyMigration,
  reviewLocalN8nLegacyMigration,
  reviewLocalCodexSiwcReplacement,
  reviewLocalN8nSiwcReplacement,
  reviewLocalSiwcResume,
  reviewLocalN8nSiwcResume,
  reconcileLocalSiwcHandoff,
  reconcileLocalN8nSiwcHandoff,
  installLocalEndpoint,
  installLocalN8nSidecar,
  installLocalN8nAssistant,
  installLocalN8nSuperGrok,
  editLocalN8nAssistantSearxng,
  installLocalN8nModel,
  installLocalN8nStack,
  prepareLocalN8nAssistantSearxngUpdate,
  prepareLocalN8nAssistantPlan: createLocalN8nAssistantPlan,
  prepareLocalN8nSidecarPlan: createLocalN8nSidecarPlan,
  prepareLocalN8nSuperGrokPlan: createLocalN8nSuperGrokPlan,
  prepareLocalN8nModelPlan: createLocalN8nModelPlan,
  prepareLocalN8nStackPlan: createLocalN8nStackPlan,
  prepareHostingDeploymentPlan: createHostingDeploymentPlan,
  removeLocalN8nAssistant,
  removeLocalN8nSidecar,
  removeLocalN8nSuperGrok,
  reviewLocalN8nModelAction,
  applyLocalN8nModelAction,
  removeLocalN8nStack,
  resumeLocalN8nStack,
  acquireLocalEndpointChangeLock,
  activateLocalClientCredentialRotation,
  prepareLocalClientCredentialRotation,
  createLocalChatTestService,
};

function setSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, statusCode, body) {
  const contents = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(contents),
  });
  response.end(contents);
}

function requestAcceptsEventStream(request) {
  const value = request.headers.accept;
  return (
    typeof value === "string" &&
    value
      .split(",")
      .some((entry) => entry.trim().split(";", 1)[0] === "text/event-stream")
  );
}

function startLocalChatTestStream(response) {
  let ended = false;
  response.writeHead(200, {
    "Content-Encoding": "none",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
    "X-Relmio-Stream": "v1",
  });
  const send = (event, data) => {
    if (ended || response.writableEnded || response.destroyed) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const keepalive = setInterval(() => {
    if (!ended && !response.writableEnded && !response.destroyed) {
      response.write(": keepalive\n\n");
    }
  }, 15_000);
  keepalive.unref?.();
  send("start", { requestId: randomUUID() });
  return {
    send(event, data) {
      if (event === "progress" || event === "delta") send(event, data);
    },
    complete(result) {
      if (ended) return;
      send("terminal", {
        outcome: "completed",
        conversationId: result.conversationId,
      });
      ended = true;
      clearInterval(keepalive);
      response.end();
    },
    fail(error) {
      if (ended) return;
      const failure = safeFailure(error);
      const outcome = error?.outcome === "interrupted" ? "interrupted"
        : error?.outcome === "incomplete" ? "incomplete" : "failed";
      send("error", { ...failure, outcome });
      send("terminal", { outcome });
      ended = true;
      clearInterval(keepalive);
      response.end();
    },
    dispose() {
      ended = true;
      clearInterval(keepalive);
    },
  };
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string") {
    return false;
  }
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function exactObjectKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function invalidSiwcRequest() {
  return Object.assign(new Error("Select a valid ChatGPT account and try again."), { statusCode: 400 });
}

function requireSiwcId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/u.test(value)) throw invalidSiwcRequest();
  return value;
}

async function selectedSiwcAccount(state, { requirePlan = false } = {}) {
  const registrationId = await state.services.getSelectedRegistration({ storageRoot: state.storageRoot });
  const accounts = await state.services.listAuthRegistrations({ storageRoot: state.storageRoot });
  const account = accounts.find((item) => item.registrationId === registrationId);
  if (!account || account.identity !== "verified" || account.session !== "connected" ||
      account.ownership !== "owned" ||
      (requirePlan && (account.planEnabled !== true || account.planPermission !== "granted" ||
        account.needsPlanWelcome === true))) {
    throw Object.assign(new Error(requirePlan
      ? "Select a connected account with ChatGPT plan use enabled before reviewing this plan."
      : "Select a connected ChatGPT account before continuing."), { statusCode: 409 });
  }
  const status = await state.services.getAuthStatus({
    storageRoot: state.storageRoot, registrationId, runtimeId: state.runtimeId,
  });
  if (status?.exists !== true || status.generation !== account.generation ||
      status.ownerHostId !== account.ownerHostId || status.ownerRuntimeId !== account.ownerRuntimeId) {
    throw Object.assign(new Error("This ChatGPT account is not owned by this computer. Sign in with a fresh registration."),
      { statusCode: 409, recovery: "review-again" });
  }
  return account;
}

async function siwcBinding(state, account) {
  const record = await state.services.readRegistration({
    storageRoot: state.storageRoot, registrationId: account.registrationId,
  });
  if (!record || record.generation !== account.generation || typeof record.clientId !== "string") {
    throw Object.assign(new Error("The ChatGPT account changed. Review again."), { statusCode: 409 });
  }
  return {
    registrationId: account.registrationId,
    clientId: record.clientId,
    generation: account.generation,
    ownerHostId: account.ownerHostId,
    ownerRuntimeId: account.ownerRuntimeId,
  };
}

async function requireMatchingSiwcBinding(state, binding) {
  const account = await selectedSiwcAccount(state, { requirePlan: true });
  const current = await siwcBinding(state, account);
  if (Object.keys(current).some((key) => current[key] !== binding[key])) {
    throw Object.assign(new Error("The ChatGPT account changed. Review again."), { statusCode: 409 });
  }
  return account;
}

async function recoveryAccount(state, registrationId, { pending = false } = {}) {
  const accounts = await state.services.listAuthRegistrations({ storageRoot: state.storageRoot });
  const account = accounts.find((item) => item.registrationId === requireSiwcId(registrationId));
  if (!account || account.identity !== "verified" ||
      (pending ? account.ownership !== "handoff-pending" : account.ownership === "handoff-pending")) {
    throw Object.assign(new Error(pending
      ? "Choose the account whose transfer is pending."
      : "Reconcile a pending transfer before reviewing its installation resume."),
    { statusCode: 409, recovery: "resolve-handoff" });
  }
  return copySiwcAccountView(account);
}

async function requireRecoveryBinding(state, binding, options) {
  const account = await recoveryAccount(state, binding.registrationId, options);
  const current = await siwcBinding(state, account);
  if (Object.keys(current).some((key) => current[key] !== binding[key])) {
    throw Object.assign(new Error("The recovery account changed. Review again."),
      { statusCode: 409, recovery: "review-again" });
  }
  return account;
}

function invalidateSiwcWork(state) {
  state.sidecarPlan = null;
  state.localPlan = null;
  state.localStoppedOwnerReview = null;
  state.vpsOwnerTargetReview = null;
  state.vpsStoppedOwnerReview = null;
  state.localDashboardGeneration += 1;
  state.siwcRecoveryReview = null;
  state.vpsRuntimeUpdateReview = null;
  state.vpsImagesTarget = null;
  state.vpsModelsTarget = null;
  state.localChatTest.resetAll?.();
}

function browserBootstrapToken(randomBytes) {
  let bytes;
  try { bytes = Buffer.from(randomBytes(32)); } catch {
    throw new Error("Browser launch could not be prepared.");
  }
  if (bytes.length !== 32) throw new Error("Browser launch could not be prepared.");
  return bytes.toString("base64url");
}

function digestBrowserBootstrapSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest();
}

function disposeBrowserBootstrap(state, record) {
  if (!record) return Promise.resolve(false);
  if (record.disposed) return record.disposal ?? Promise.resolve(false);
  record.disposed = true;
  state.clearBrowserBootstrapTimer(record.timer);
  try {
    record.disposal = Promise.resolve(record.handoff.dispose()).catch(() => false);
  } catch {
    record.disposal = Promise.resolve(false);
  }
  return record.disposal;
}

function retireBrowserBootstrap(state, ticketId, record) {
  if (state.browserBootstraps.get(ticketId) !== record) return false;
  state.browserBootstraps.delete(ticketId);
  state.browserBootstrapIds.delete(ticketId);
  disposeBrowserBootstrap(state, record);
  return true;
}

function purgeExpiredBrowserBootstraps(state) {
  const currentTime = state.browserBootstrapNow();
  for (const [ticketId, record] of state.browserBootstraps) {
    if (record.expiresAtMs <= currentTime) retireBrowserBootstrap(state, ticketId, record);
  }
}

function disposeBrowserTransfer(state, record) {
  if (!record || record.disposed) return;
  record.disposed = true;
  state.clearBrowserBootstrapTimer(record.timer);
}

function retireBrowserTransfer(state, transferId, record) {
  if (state.browserTransfers.get(transferId) !== record) return false;
  state.browserTransfers.delete(transferId);
  state.browserTransferIds.delete(transferId);
  disposeBrowserTransfer(state, record);
  return true;
}

function purgeExpiredBrowserTransfers(state) {
  const currentTime = state.browserBootstrapNow();
  for (const [transferId, record] of state.browserTransfers) {
    if (record.expiresAtMs <= currentTime) {
      retireBrowserTransfer(state, transferId, record);
    }
  }
}

function prepareBrowserTransfer(state, route) {
  purgeExpiredBrowserTransfers(state);
  if (state.browserTransfers.size >= state.maxPendingBrowserTransfers) {
    throw Object.assign(new Error("Too many pending browser transfers."), {
      statusCode: 429,
    });
  }

  let transferId;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = browserBootstrapToken(state.browserBootstrapRandomBytes);
    if (!state.browserTransferIds.has(candidate)) {
      transferId = candidate;
      break;
    }
  }
  if (!transferId) throw new Error("Browser launch could not be completed.");
  const secret = browserBootstrapToken(state.browserBootstrapRandomBytes);
  const expiresAtMs = state.browserBootstrapNow() + state.browserTransferTtlMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new Error("Browser launch could not be completed.");
  }

  state.browserTransferIds.add(transferId);
  const record = {
    route,
    digest: digestBrowserBootstrapSecret(secret),
    expiresAtMs,
    disposed: false,
    timer: null,
  };
  try {
    record.timer = state.setBrowserBootstrapTimer(() => {
      retireBrowserTransfer(state, transferId, record);
    }, Math.max(1, expiresAtMs - state.browserBootstrapNow()));
    record.timer?.unref?.();
    state.browserTransfers.set(transferId, record);
    return { transferId, secret };
  } catch (error) {
    state.browserTransferIds.delete(transferId);
    disposeBrowserTransfer(state, record);
    throw error;
  }
}

async function prepareBrowserBootstrap(state, route) {
  if (!BROWSER_BOOTSTRAP_ROUTES.has(route)) {
    throw Object.assign(new Error("Browser launch route is invalid."), { statusCode: 400 });
  }
  purgeExpiredBrowserBootstraps(state);
  if (
    state.browserBootstraps.size + state.browserBootstrapReservations >=
    state.maxPendingBrowserBootstraps
  ) {
    throw Object.assign(new Error("Too many pending browser launches."), { statusCode: 429 });
  }

  let ticketId;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = browserBootstrapToken(state.browserBootstrapRandomBytes);
    if (!state.browserBootstrapIds.has(candidate)) {
      ticketId = candidate;
      break;
    }
  }
  if (!ticketId) throw new Error("Browser launch could not be prepared.");
  const secret = browserBootstrapToken(state.browserBootstrapRandomBytes);
  const expiresAtMs = state.browserBootstrapNow() + state.browserBootstrapTtlMs;
  if (!Number.isSafeInteger(expiresAtMs)) throw new Error("Browser launch could not be prepared.");

  state.browserBootstrapIds.add(ticketId);
  state.browserBootstrapReservations += 1;
  let handoff;
  try {
    handoff = await state.createBrowserHandoff({
      origin: state.origin,
      route,
      ticketId,
      secret,
      privateRoot: state.browserHandoffRoot,
    });
    if (
      state.closing || !handoff || !isPrivateBrowserLaunchUrl(handoff.launchUrl) ||
      typeof handoff.dispose !== "function"
    ) throw new Error("Browser launch could not be prepared.");
    const record = {
      route,
      digest: digestBrowserBootstrapSecret(secret),
      createdAtMs: state.browserBootstrapNow(),
      expiresAtMs,
      handoff,
      disposed: false,
      timer: null,
    };
    record.timer = state.setBrowserBootstrapTimer(() => {
      retireBrowserBootstrap(state, ticketId, record);
    }, Math.max(1, expiresAtMs - state.browserBootstrapNow()));
    record.timer?.unref?.();
    state.browserBootstraps.set(ticketId, record);
    return handoff.launchUrl;
  } catch (error) {
    state.browserBootstrapIds.delete(ticketId);
    if (handoff?.dispose) {
      try { await handoff.dispose(); } catch { /* Preserve the prepare failure. */ }
    }
    throw error;
  } finally {
    state.browserBootstrapReservations -= 1;
  }
}

function genericBrowserBootstrapFailure(state) {
  try { enforceRateLimit(state, "browser-bootstrap"); } catch (error) { return error; }
  return Object.assign(new Error("Browser launch could not be verified."), { statusCode: 401 });
}

function genericBrowserTransferFailure(state) {
  try { enforceRateLimit(state, "browser-transfer"); } catch (error) { return error; }
  return Object.assign(new Error("Browser transfer could not be verified."), {
    statusCode: 401,
  });
}

function consumeBrowserBootstrap(state, body) {
  if (
    !exactObjectKeys(body, ["route", "secret", "ticketId"]) ||
    !BROWSER_BOOTSTRAP_ROUTES.has(body.route) ||
    !BROWSER_BOOTSTRAP_TOKEN_PATTERN.test(body.ticketId) ||
    !BROWSER_BOOTSTRAP_TOKEN_PATTERN.test(body.secret)
  ) throw genericBrowserBootstrapFailure(state);
  const record = state.browserBootstraps.get(body.ticketId);
  if (!record) throw genericBrowserBootstrapFailure(state);
  if (record.expiresAtMs <= state.browserBootstrapNow()) {
    retireBrowserBootstrap(state, body.ticketId, record);
    throw genericBrowserBootstrapFailure(state);
  }
  const actualDigest = digestBrowserBootstrapSecret(body.secret);
  if (
    record.route !== body.route || actualDigest.length !== record.digest.length ||
    !timingSafeEqual(actualDigest, record.digest)
  ) throw genericBrowserBootstrapFailure(state);
  if (!retireBrowserBootstrap(state, body.ticketId, record)) {
    throw genericBrowserBootstrapFailure(state);
  }
  return record.route;
}

function consumeBrowserTransfer(state, body) {
  if (
    !exactObjectKeys(body, ["route", "secret", "transferId"]) ||
    !BROWSER_BOOTSTRAP_ROUTES.has(body.route) ||
    !BROWSER_BOOTSTRAP_TOKEN_PATTERN.test(body.transferId) ||
    !BROWSER_BOOTSTRAP_TOKEN_PATTERN.test(body.secret)
  ) throw genericBrowserTransferFailure(state);
  const record = state.browserTransfers.get(body.transferId);
  if (!record) throw genericBrowserTransferFailure(state);
  if (record.expiresAtMs <= state.browserBootstrapNow()) {
    retireBrowserTransfer(state, body.transferId, record);
    throw genericBrowserTransferFailure(state);
  }
  const actualDigest = digestBrowserBootstrapSecret(body.secret);
  if (
    record.route !== body.route || actualDigest.length !== record.digest.length ||
    !timingSafeEqual(actualDigest, record.digest)
  ) throw genericBrowserTransferFailure(state);
  if (!retireBrowserTransfer(state, body.transferId, record)) {
    throw genericBrowserTransferFailure(state);
  }
  return state.sessionToken;
}

function readFormBody(request) {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";", 1)[0].trim().toLowerCase() !==
      "application/x-www-form-urlencoded"
  ) return Promise.reject(new Error("Browser launch could not be verified."));
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 2_048) chunks.push(Buffer.from(chunk));
    });
    request.once("error", () => rejectBody(new Error("Browser launch could not be verified.")));
    request.once("end", () => {
      if (bytes > 2_048) {
        rejectBody(new Error("Browser launch could not be verified."));
        return;
      }
      try {
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const keys = [...params.keys()].sort();
        if (keys.join("\0") !== ["route", "secret", "ticketId"].sort().join("\0")) {
          throw new TypeError();
        }
        resolveBody({
          route: params.get("route"),
          secret: params.get("secret"),
          ticketId: params.get("ticketId"),
        });
      } catch {
        rejectBody(new Error("Browser launch could not be verified."));
      }
    });
  });
}

function sendBrowserBootstrapHtml(response, state, route) {
  const transfer = prepareBrowserTransfer(state, route);
  const nonce = browserBootstrapToken(state.browserBootstrapRandomBytes);
  const envelope = `relmio-v1.${transfer.transferId}.${transfer.secret}`;
  const script = `window.name = ${JSON.stringify(envelope)}; window.location.replace(${JSON.stringify(route)});`;
  const contents = `<!doctype html><html><head><meta charset="utf-8"><title>Opening Relmio</title></head><body><script nonce="${nonce}">${script}</script></body></html>`;
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  );
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(contents),
    "Cache-Control": "no-store",
  });
  response.end(contents);
}

function requireApiToken(request, state) {
  if (!tokenMatches(request.headers["x-setup-token"], state.sessionToken)) {
    throw Object.assign(new Error("Unauthorized."), { statusCode: 401 });
  }
}

function requireSameOrigin(request, state) {
  if (request.method === "POST" && request.headers.origin !== state.origin) {
    throw Object.assign(new Error("Cross-origin request rejected."), {
      statusCode: 403,
    });
  }
}

function enforceRateLimit(state, key) {
  const now = Date.now();
  const previous = state.rateLimits.get(key) ?? [];
  const recent = previous.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    throw Object.assign(
      new Error("Too many attempts. Wait a few minutes and try again."),
      { statusCode: 429 },
    );
  }
  recent.push(now);
  state.rateLimits.set(key, recent);
}

function waitForBoundedResult(promise, milliseconds) {
  if (!promise) {
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolvePromise(false);
      }
    }, milliseconds);
    Promise.resolve(promise).then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise(true);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise(true);
        }
      },
    );
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once("error", () => {
      reject(new Error("The request body could not be read."));
    });
    request.once("end", () => {
      if (tooLarge) {
        reject(
          Object.assign(new Error("The request body is too large."), {
            statusCode: 413,
          }),
        );
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text === "" ? {} : JSON.parse(text));
      } catch {
        reject(
          Object.assign(new Error("The request body must be valid JSON."), {
            statusCode: 400,
          }),
        );
      }
    });
  });
}

function requireConnection(state) {
  if (!state.connection) {
    throw new Error("Connect to the VPS first.");
  }
  return state.connection;
}

function requireFullVpsScope(connection) {
  if (connection?.scope !== "vps" || connection.identity?.privilege !== "root" ||
    connection.identity?.loginUid !== 0 || connection.identity?.effectiveUid !== 0) {
    throw Object.assign(new Error(
      "This SSH session is local-model-only. OAuth bridge, Assistant and SuperGrok VPS operations require a verified root session. Disconnect and reconnect using a UID 0 account; local ChatGPT sign-in remains available.",
    ), { statusCode: 403 });
  }
}

const VPS_IDENTITY_FIELDS = Object.freeze(["host", "port", "fingerprint", "username", "authentication",
  "privilege", "loginUid", "effectiveUid"]);
const VPS_OWNER_TARGET_FIELDS = Object.freeze([...VPS_IDENTITY_FIELDS, "containerName", "networkName"]);

function requireReviewedVpsOwnerTarget(state, containerName, networkName) {
  const prior = state.vpsOwnerTargetReview;
  const current = { ...state.connectionIdentity, containerName, networkName };
  if (!prior || prior.expiresAt <= Date.now() ||
      !VPS_OWNER_TARGET_FIELDS.every((key) => prior.reviewedTarget[key] === current[key])) {
    throw Object.assign(new Error("Review this VPS owner and destination again."),
      { statusCode: 409, recovery: "review-again" });
  }
  return prior.reviewedTarget;
}

const CODEX_IMAGES_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const VPS_IMAGES_STATES = new Set(["off", "pending", "signed-in", "reauthorize", "unavailable"]);
const VPS_MODEL_STATES = new Set(["verified", "failed", "unchecked"]);
const VPS_MODEL_CATALOG_ERRORS = new Set(["catalog_unavailable", "registration_unavailable"]);
const VPS_MODEL_STOP_REASONS = new Set(["usage_limit", "reauthorize", "probe_rejected", "checks_off", "time_limit",
  "lease_unavailable"]);
const VPS_ADDON_TARGET_MS = 20 * 60_000;

// An add-on target stored by a status check serves only this connection until it expires.
function requireVpsAddonTarget(state, key, message, { pending = false } = {}) {
  const target = state[key];
  if (!target || target.expiresAt <= Date.now() || (pending && !target.pending) ||
      !VPS_IDENTITY_FIELDS.every((field) => target.reviewedTarget[field] === state.connectionIdentity?.[field])) {
    throw Object.assign(new Error(message), { statusCode: 409, recovery: "review-again" });
  }
  return target;
}

function boundedText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isoTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

// Only known add-on fields reach the browser; tokens, device IDs and remote output never do.
function copyVpsImagesStatus(result) {
  const { state, account, pending } = result ?? {};
  if (!VPS_IMAGES_STATES.has(state) || !/^[a-f0-9]{64}$/u.test(result.containerId ?? "") ||
      (account !== undefined && (!/^[A-Za-z0-9_-]{6}$/u.test(account?.accountIdSuffix ?? "") ||
        (account.email !== undefined && !boundedText(account.email, 254)) ||
        (account.planType !== undefined && !boundedText(account.planType, 32)))) ||
      (state === "pending" && (!/^[A-Z0-9]{2,16}(?:-[A-Z0-9]{2,16}){0,3}$/u.test(pending?.userCode ?? "") ||
        pending.verificationUrl !== CODEX_IMAGES_VERIFICATION_URL ||
        !isoTime(pending.expiresAt)))) {
    throw Object.assign(new Error("The VPS returned an invalid image generation status."), { statusCode: 502 });
  }
  return {
    state,
    ...(account === undefined ? {} : { account: {
      ...(account.email === undefined ? {} : { email: account.email }),
      ...(account.planType === undefined ? {} : { planType: account.planType }),
      accountIdSuffix: account.accountIdSuffix,
    } }),
    ...(state === "pending" ? { pending: { userCode: pending.userCode,
      verificationUrl: CODEX_IMAGES_VERIFICATION_URL, expiresAt: pending.expiresAt } } : {}),
    ...(["declined", "expired"].includes(result.outcome) ? { outcome: result.outcome } : {}),
    ...(["confirmed", "unconfirmed", "not-applicable"].includes(result.revocation)
      ? { revocation: result.revocation } : {}),
  };
}

function validVpsModelRow(model) {
  return typeof model?.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(model.id) &&
    boundedText(model.display_name, 256) && VPS_MODEL_STATES.has(model.state) && typeof model.listed === "boolean" &&
    (model.checkedAt === undefined || isoTime(model.checkedAt));
}

function validVpsModelRun(run) {
  const count = (value) => Number.isInteger(value) && value >= 0 && value <= 64;
  return run === undefined || (count(run?.checked) && count(run.verified) && count(run.failed) &&
    (run.stoppedReason === undefined || VPS_MODEL_STOP_REASONS.has(run.stoppedReason)));
}

// Only the validated catalog view reaches the browser; tokens, upstream text and remote output never do.
function copyVpsModelsStatus(result) {
  const { state, catalogError, lastRun, models } = result ?? {};
  if (!["available", "unavailable"].includes(state) || !/^[a-f0-9]{64}$/u.test(result.containerId ?? "") ||
      (state === "available" && (typeof result.checksEnabled !== "boolean" ||
        typeof result.clientVersion !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(result.clientVersion) ||
        (result.catalogCheckedAt !== null && !isoTime(result.catalogCheckedAt)) ||
        (catalogError !== undefined && !VPS_MODEL_CATALOG_ERRORS.has(catalogError)) || !validVpsModelRun(lastRun) ||
        !Array.isArray(models) || models.length > 64 || !models.every(validVpsModelRow)))) {
    throw Object.assign(new Error("The VPS returned an invalid model status."), { statusCode: 502 });
  }
  if (state === "unavailable") return { state };
  return {
    state, checksEnabled: result.checksEnabled, clientVersion: result.clientVersion,
    catalogCheckedAt: result.catalogCheckedAt,
    ...(catalogError === undefined ? {} : { catalogError }),
    ...(lastRun === undefined ? {} : { lastRun: { checked: lastRun.checked, verified: lastRun.verified,
      failed: lastRun.failed, ...(lastRun.stoppedReason === undefined ? {} : { stoppedReason: lastRun.stoppedReason }) } }),
    models: models.map((model) => ({ id: model.id, display_name: model.display_name, state: model.state,
      listed: model.listed, ...(model.checkedAt === undefined ? {} : { checkedAt: model.checkedAt }) })),
  };
}

function credentialBearingVpsRoute(path) {
  return path === "/api/plan" || path === "/api/install" ||
    path === "/api/siwc/vps/status" || path === "/api/siwc/vps/manage" ||
    path === "/api/siwc/vps/inspect-stopped" || path.startsWith("/api/siwc/vps/recovery/") ||
    path === "/api/siwc/vps/runtime-update/review" || path === "/api/siwc/vps/runtime-update/apply" ||
    path.startsWith("/api/siwc/vps/images/") || path.startsWith("/api/siwc/vps/models/") || path === "/api/siwc/vps/usage/status" ||
    path === "/api/assistant/plan" || path === "/api/assistant/install" ||
    path.startsWith("/api/vps/supergrok/");
}

function validatedSshRequest(body) {
  requireExactRequestBody(body, [
    "host", "port", "username", "expectedFingerprint", "useAgent", "privilege",
    ...(body?.useAgent === false ? ["password"] : []),
  ], "The SSH connection request must contain only the selected authentication fields.");
  if (typeof body.useAgent !== "boolean" || !["root", "sudo-n"].includes(body.privilege)) {
    throw new Error("Choose SSH password or local agent authentication and an explicit administrative privilege.");
  }
  if (!body.useAgent && (typeof body.password !== "string" || !body.password || body.password.length > 16384)) {
    throw new Error("Enter the SSH password for the selected account.");
  }
  if (typeof body.expectedFingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(body.expectedFingerprint)) {
    throw new Error("Confirm a valid SSH host fingerprint first.");
  }
  return {
    host: validateHostname(body.host), port: validatePort(body.port),
    username: validateUsername(body.username), expectedFingerprint: body.expectedFingerprint,
    useAgent: body.useAgent, privilege: body.privilege,
    ...(body.useAgent ? {} : { password: body.password }),
  };
}

function verifiedConnectionIdentity(connection, request, generation) {
  const identity = connection?.identity;
  const scope = request.privilege === "root" ? "vps" : "local-model-only";
  if (!identity || connection.scope !== scope ||
    identity.host !== request.host || identity.port !== request.port ||
    identity.fingerprint !== request.expectedFingerprint || identity.username !== request.username ||
    identity.authentication !== (request.useAgent ? "agent" : "password") ||
    identity.privilege !== request.privilege || identity.effectiveUid !== 0 ||
    !Number.isSafeInteger(identity.loginUid) || identity.loginUid < 0 ||
    (request.privilege === "root" && identity.loginUid !== 0)) {
    throw new Error("The authenticated SSH identity does not match the requested administrative session. Reconnect and verify it again.");
  }
  return Object.freeze({
    host: identity.host, port: identity.port, fingerprint: identity.fingerprint,
    username: identity.username, authentication: identity.authentication,
    privilege: identity.privilege, loginUid: identity.loginUid, effectiveUid: 0, scope, generation,
  });
}

function oauthCredentialChangeInFlight(state) {
  return (
    state.oauthLoginStartInFlight ||
    state.oauthCredentialOperation !== null ||
    state.oauthLogin?.status === "pending" ||
    state.oauthRetryBlocked ||
    state.oauthLogin?.retryBlocked === true
  );
}

function oauthCredentialOperationInFlight(state) {
  return Boolean(
    state.oauthLoginStartInFlight ||
    state.oauthCredentialOperation !== null ||
    state.oauthLogin?.status === "pending"
  );
}

function rejectActiveOAuthCredentialChange(state) {
  if (state.oauthRetryBlocked || state.oauthLogin?.retryBlocked === true) {
    throw Object.assign(
      new Error(
        "ChatGPT sign-in could not be confirmed safely. Restart Relmio before changing the VPS.",
      ),
      { retryBlocked: true, statusCode: 409 },
    );
  }
  if (oauthCredentialChangeInFlight(state)) {
    throw Object.assign(new Error(OAUTH_VPS_CONFLICT_MESSAGE), {
      statusCode: 409,
    });
  }
}

function rejectActiveVpsOwner(state) {
  if (state.vpsConnectionOperation !== null) {
    throw Object.assign(
      new Error("A VPS connection change is already in progress. Wait for it to finish before trying another VPS action."),
      { statusCode: 409 },
    );
  }
  if (state.vpsMutationInFlight || state.vpsCredentialOperation !== null) {
    throw Object.assign(
      new Error(
        "A VPS installation is already in progress. Wait for it to finish before trying another installation.",
      ),
      { statusCode: 409 },
    );
  }
}

function rejectActiveVpsMutation(state) {
  if (state.closing) {
    throw Object.assign(new Error("The local wizard is closing."), {
      statusCode: 409,
    });
  }
  rejectActiveVpsOwner(state);
  rejectActiveOAuthCredentialChange(state);
}

function advanceVpsLifecycleGeneration(state) {
  state.vpsLifecycleGeneration += 1;
  return state.vpsLifecycleGeneration;
}

function invalidateVpsPlans(state) {
  state.vpsOwnerTargetReview = null;
  state.siwcRecoveryReview = null;
  state.vpsRuntimeUpdateReview = null;
  state.vpsImagesTarget = null;
  state.vpsModelsTarget = null;
  state.sidecarPlan = null;
  state.assistantPlan = null;
  invalidateSuperGrokPlan(state);
  invalidateLocalModelVpsPlan(state);
}

function invalidateSuperGrokPlan(state) {
  state.supergrokPlan = null;
  state.supergrokPlanGeneration += 1;
}
function invalidateLocalModelVpsPlan(state) {
  state.localModelVpsPlan = null;
  state.localModelVpsPlanGeneration += 1;
}


function beginVpsDiscoveryRefresh(state) {
  invalidateVpsPlans(state);
  state.vpsDiscoveryGeneration += 1;
  return state.vpsDiscoveryGeneration;
}

function beginSuperGrokPlanReview(state) {
  invalidateVpsPlans(state);
  return state.supergrokPlanGeneration;
}
function beginLocalModelVpsReview(state) {
  invalidateVpsPlans(state);
  return state.localModelVpsPlanGeneration;
}


function closeVpsConnectionBestEffort(connection) {
  try {
    connection?.close?.();
  } catch {
    // Shared state is detached first, so a local close failure cannot make the
    // stale connection or its reviewed plans reusable.
  }
}

function clearVpsConnectionIdleExpiry(state, connection = null) {
  const expiry = state.vpsConnectionIdleExpiry;
  if (!expiry || (connection !== null && expiry.connection !== connection)) {
    return;
  }
  clearTimeout(expiry.timer);
  state.vpsConnectionIdleExpiry = null;
}

function vpsConnectionHasActiveUse(state, connection) {
  for (const use of state.vpsConnectionUses) {
    if (use.connection === connection) return true;
  }
  return false;
}

function retireVpsConnectionUses(state, connection) {
  for (const use of state.vpsConnectionUses) {
    if (use.connection === connection) {
      state.vpsConnectionUses.delete(use);
    }
  }
}

function armVpsConnectionIdleExpiry(state, connection = state.connection) {
  if (
    state.closing ||
    !connection ||
    state.connection !== connection ||
    vpsConnectionHasActiveUse(state, connection)
  ) {
    return;
  }
  clearVpsConnectionIdleExpiry(state);
  const expiry = { connection, timer: null };
  expiry.timer = setTimeout(() => {
    if (state.vpsConnectionIdleExpiry !== expiry) return;
    state.vpsConnectionIdleExpiry = null;
    if (state.closing || state.connection !== connection) return;
    if (
      vpsConnectionHasActiveUse(state, connection) ||
      state.vpsFingerprintOperation !== null ||
      state.vpsConnectionOperation !== null ||
      state.vpsMutationInFlight ||
      state.vpsCredentialOperation !== null
    ) {
      armVpsConnectionIdleExpiry(state, connection);
      return;
    }
    detachVpsConnection(state, connection, { clearScannedHost: true });
  }, state.vpsConnectionIdleMs);
  expiry.timer.unref?.();
  state.vpsConnectionIdleExpiry = expiry;
}

function acquireVpsConnectionUse(state) {
  const connection = requireConnection(state);
  const use = { connection, token: Symbol("vps-connection-use") };
  clearVpsConnectionIdleExpiry(state, connection);
  state.vpsConnectionUses.add(use);
  let released = false;
  return {
    connection,
    release() {
      if (released) return;
      released = true;
      state.vpsConnectionUses.delete(use);
      if (state.connection === connection) {
        armVpsConnectionIdleExpiry(state, connection);
      }
    },
  };
}

function detachVpsConnection(
  state,
  connection = state.connection,
  { clearScannedHost = false } = {},
) {
  if (state.connection === connection) {
    clearVpsConnectionIdleExpiry(state, connection);
    retireVpsConnectionUses(state, connection);
    state.connection = null;
    state.connectionIdentity = null;
    advanceVpsLifecycleGeneration(state);
    state.discovery = null;
    state.networksByContainer.clear();
    invalidateVpsPlans(state);
    if (clearScannedHost) {
      state.scannedHost = null;
    }
  }
  closeVpsConnectionBestEffort(connection);
}

function rejectUnsafeVpsDisconnect(state) {
  if (state.closing) {
    throw Object.assign(new Error("The local wizard is closing."), {
      statusCode: 409,
    });
  }
  rejectActiveVpsOwner(state);
  if (state.vpsFingerprintOperation !== null) {
    throw Object.assign(
      new Error("A VPS identity scan is already in progress. Wait for it to finish before disconnecting."),
      { statusCode: 409 },
    );
  }
  if (oauthCredentialOperationInFlight(state)) {
    throw Object.assign(new Error(OAUTH_VPS_CONFLICT_MESSAGE), {
      statusCode: 409,
    });
  }
}

function requireUnchangedVpsSession(
  state,
  snapshot,
  { allowCredentialSnapshot = false } = {},
) {
  if (allowCredentialSnapshot) {
    if (state.closing) {
      throw Object.assign(new Error("The local wizard is closing."), {
        statusCode: 409,
      });
    }
  } else {
    rejectActiveVpsMutation(state);
  }
  if (
    state.connection !== snapshot.connection ||
    state.vpsLifecycleGeneration !== snapshot.lifecycleGeneration ||
    (
      snapshot.discoveryGeneration !== undefined &&
      state.vpsDiscoveryGeneration !== snapshot.discoveryGeneration
    )
  ) {
    throw Object.assign(
      new Error("The VPS session changed while this request was running. Try the VPS action again."),
      { statusCode: 409 },
    );
  }
}

function beginVpsFingerprintScan(state) {
  rejectActiveVpsMutation(state);
  const operation = {
    lifecycleGeneration: state.vpsLifecycleGeneration,
    scanGeneration: state.vpsFingerprintGeneration + 1,
    token: Symbol("vps-fingerprint-scan"),
  };
  state.vpsFingerprintGeneration = operation.scanGeneration;
  state.vpsFingerprintOperation = operation;
  state.scannedHost = null;
  return operation;
}

function requireCurrentVpsFingerprintScan(state, operation) {
  if (
    state.closing ||
    state.vpsFingerprintOperation?.token !== operation.token ||
    state.vpsFingerprintGeneration !== operation.scanGeneration ||
    state.vpsLifecycleGeneration !== operation.lifecycleGeneration
  ) {
    throw Object.assign(
      new Error("The VPS identity scan changed while this request was running. Check the latest identity result."),
      { statusCode: 409 },
    );
  }
  rejectActiveVpsMutation(state);
}

function releaseVpsFingerprintScan(state, operation) {
  if (state.vpsFingerprintOperation?.token === operation.token) {
    state.vpsFingerprintOperation = null;
  }
}

function acquireVpsConnectionOperation(state) {
  rejectActiveVpsMutation(state);
  if (state.vpsFingerprintOperation !== null) {
    throw Object.assign(
      new Error("A VPS identity scan is already in progress. Wait for it to finish before connecting."),
      { statusCode: 409 },
    );
  }
  const operation = {
    lifecycleGeneration: state.vpsLifecycleGeneration,
    token: Symbol("vps-connection-operation"),
  };
  state.vpsConnectionOperation = operation;
  return {
    operation,
    release() {
      if (state.vpsConnectionOperation?.token === operation.token) {
        state.vpsConnectionOperation = null;
      }
    },
  };
}

function requireCurrentVpsConnectionOperation(state, operation) {
  if (state.closing) {
    throw Object.assign(new Error("The local wizard is closing."), {
      statusCode: 409,
    });
  }
  if (
    state.vpsConnectionOperation?.token !== operation.token ||
    state.vpsLifecycleGeneration !== operation.lifecycleGeneration
  ) {
    throw Object.assign(
      new Error("The VPS connection changed while this request was running. Try connecting again."),
      { statusCode: 409 },
    );
  }
}

function beginOAuthCredentialOperation(state) {
  if (state.oauthCredentialOperation !== null) {
    throw Object.assign(
      new Error("A ChatGPT sign-in start is already in progress."),
      { statusCode: 409 },
    );
  }
  const operation = {
    phase: "starting",
    token: Symbol("oauth-credential-operation"),
  };
  state.oauthCredentialOperation = operation;
  return operation;
}

function setOAuthCredentialOperationPhase(state, operation, phase) {
  if (state.oauthCredentialOperation?.token === operation?.token) {
    operation.phase = phase;
  }
}

function releaseOAuthCredentialOperation(state, operation) {
  if (state.oauthCredentialOperation?.token === operation?.token) {
    state.oauthCredentialOperation = null;
  }
}

function acquireVpsCredentialOperation(state, phase) {
  rejectActiveVpsMutation(state);
  const operation = {
    phase,
    token: Symbol("vps-credential-operation"),
  };
  state.vpsCredentialOperation = operation;
  return {
    operation,
    release() {
      if (state.vpsCredentialOperation?.token === operation.token) {
        state.vpsCredentialOperation = null;
      }
    },
  };
}

function requireCurrentVpsCredentialOperation(state, operation) {
  if (
    state.closing ||
    state.vpsCredentialOperation?.token !== operation.token
  ) {
    throw Object.assign(new Error("The local wizard is closing."), {
      statusCode: 409,
    });
  }
}

function acquireVpsMutationLock(state) {
  const credentialOperation = acquireVpsCredentialOperation(
    state,
    "remote-mutation",
  );
  const lock = Symbol("vps-mutation");
  let resolveCompletion;
  state.vpsMutationInFlight = true;
  state.vpsMutationLock = lock;
  advanceVpsLifecycleGeneration(state);
  invalidateVpsPlans(state);
  state.vpsMutationCompletion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  return () => {
    if (state.vpsMutationLock === lock) {
      state.vpsMutationInFlight = false;
      state.vpsMutationLock = null;
      state.vpsMutationCompletion = null;
      resolveCompletion();
    }
    credentialOperation.release();
  };
}

function requireVpsPlanAuthStatus(account, message) {
  if (!account || account.identity !== "verified" || account.session !== "connected" ||
      account.planPermission !== "granted" || account.planEnabled !== true ||
      account.ownership !== "owned") {
    throw Object.assign(new Error(message), { statusCode: 409 });
  }
  return account;
}

function requireReviewedVpsPlan(plan, body, label) {
  if (
    !plan ||
    typeof plan.planId !== "string" ||
    !tokenMatches(body.planId, plan.planId) ||
    plan.containerName !== body.containerName ||
    plan.networkName !== body.networkName
  ) {
    throw new Error(`Review a fresh ${label} plan before installing.`);
  }
}

function requireAssistantSearxngSelection(value) {
  if (typeof value !== "boolean") {
    throw new Error("Choose whether to include optional SearXNG web search.");
  }
  return value;
}

function requireEnabledInstanceAi(state, containerName) {
  const instanceAi = state.networksByContainer.get(containerName)?.instanceAi;
  if (instanceAi?.status === "enabled") return instanceAi;
  if (instanceAi?.status === "missing" || instanceAi?.status === "configured") {
    throw new Error(
      "The selected n8n container needs N8N_ENABLED_MODULES to include instance-ai. Update its existing deployment separately; restart n8n outside this wizard only if you later authorize that action.",
    );
  }
  throw new Error("The selected n8n container's AI Assistant prerequisite could not be verified.");
}

function requireReviewedAssistantPlan(state, plan, body) {
  requireReviewedVpsPlan(plan, body, "AI Assistant");
  if (plan.includeSearxng !== body.includeSearxng) {
    throw new Error("Review a fresh AI Assistant plan for the selected web-search option.");
  }
  const instanceAi = requireEnabledInstanceAi(state, body.containerName);
  if (plan.instanceAi?.status !== instanceAi.status) {
    throw new Error("Review a fresh AI Assistant plan after prerequisite discovery.");
  }
}

function requireFreshAssistantInstallState(plan, networks, body) {
  if (!Array.isArray(networks?.networks) || !networks.networks.includes(body.networkName)) {
    throw new Error(
      "The selected Docker network changed after plan review. Review a fresh AI Assistant plan before installing.",
    );
  }
  const instanceAi = networks.instanceAi;
  if (instanceAi?.status !== "enabled") {
    throw new Error(
      "The selected n8n container needs N8N_ENABLED_MODULES to include instance-ai. Update its existing deployment separately; restart n8n outside this wizard only if you later authorize that action.",
    );
  }
  if (plan.instanceAi?.status !== instanceAi.status) {
    throw new Error("Review a fresh AI Assistant plan after prerequisite discovery.");
  }
}

function requireDiscoveredContainer(state, containerName) {
  const container = state.discovery?.containers.find(
    (candidate) => candidate.name === containerName,
  );
  if (!container) {
    throw new Error("Select an n8n container found by this wizard.");
  }
  return container;
}

function requireDiscoveredNetwork(state, containerName, networkName) {
  requireDiscoveredContainer(state, containerName);
  const networks = state.networksByContainer.get(containerName)?.networks ?? [];
  if (!networks.includes(networkName)) {
    throw new Error("Select a Docker network found by this wizard.");
  }
  return networkName;
}

function safeErrorMessage(error) {
  const message =
    typeof error?.safeMessage === "string"
      ? error.safeMessage
      : typeof error?.message === "string"
        ? error.message
        : "Request failed.";
  if (
    message.length > 240 ||
    /[\r\n]/u.test(message) ||
    /(?:access|refresh)[_-]?token|private[_-]?key|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|\/(?:Users|home|private|tmp|var|opt|docker)\/|[A-Za-z]:\\/iu.test(
      message,
    )
  ) {
    return "The request could not be completed safely.";
  }
  return message;
}

const SIWC_RECOVERY = new Set([
  "none", "retry-later", "reauthorize", "enable-plan", "manage-usage",
  "fix-request", "fix-configuration", "review-again", "resolve-handoff",
]);

function safeFailure(error) {
  const status = [error?.statusCode, error?.status, error?.upstream?.status]
    .find((value) => Number.isInteger(value) && value >= 400 && value <= 599) ?? 400;
  const phase = ["authorize", "refresh", "request", "handoff", "revoke"]
    .includes(error?.phase) ? error.phase : "request";
  const source = error?.upstream?.body?.error ?? error?.error;
  const identifier = (value, pattern = /^[A-Za-z0-9_.:\[\]-]{1,128}$/u) =>
    typeof value === "string" && pattern.test(value) ? value : undefined;
  const code = identifier(error?.code) ?? identifier(source?.code);
  const param = identifier(error?.param) ?? identifier(source?.param);
  const requestId = identifier(error?.requestId ?? error?.upstream?.requestId);
  const recovery = SIWC_RECOVERY.has(error?.recovery) ? error.recovery
    : code === "subscription_sharing_usage_limit_exceeded" ? "manage-usage"
      : status === 503 ? "retry-later"
        : status === 400 ? "fix-request"
          : status === 401 ? "reauthorize" : "none";
  const body = phase === "request" && error?.upstream?.body?.detail !== undefined
    ? { detail: safeErrorMessage({ safeMessage: error.upstream.body.detail }) }
    : phase === "request" && source && typeof source === "object"
      ? { error: {
          message: safeErrorMessage({ safeMessage: source.message }),
          ...(code ? { code } : {}),
          ...(param ? { param } : {}),
          ...(identifier(source.type) ? { type: source.type } : {}),
        } }
      : undefined;
  return {
    error: safeErrorMessage(error), status, phase, recovery,
    ...(code ? { code } : {}), ...(param ? { param } : {}),
    ...(requestId ? { requestId } : {}),
    ...(body ? { upstream: { status, body, ...(requestId ? { requestId } : {}) } } : {}),
    ...(error?.retryBlocked === true ? { retryBlocked: true } : {}),
    ...(error?.remoteOutcomeUnknown === true ? { remoteOutcomeUnknown: true } : {}),
  };
}

function safeInstallFailure(value, phase) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isInteger(value.status) || value.status < 400 || value.status > 599 ||
      typeof value.error !== "string" || value.error.length === 0) {
    throw Object.assign(new Error("The installed runtime failure report is invalid."), { statusCode: 502 });
  }
  return safeFailure({
    message: value.error, status: value.status, phase,
    code: value.code, param: value.param, requestId: value.requestId,
    recovery: value.recovery, upstream: value.upstream,
  });
}

function copySiwcReadiness(result) {
  const runtimeState = result?.runtimeState ?? "running";
  const finalization = result?.finalizationFailure;
  if (!["verified", "unverified"].includes(result?.readiness) ||
      !["running", "unknown", "stopped"].includes(runtimeState) ||
      (finalization && (result.deploymentMode !== "partial" ||
        typeof finalization.error !== "string" || !finalization.error ||
        !SIWC_RECOVERY.has(finalization.recovery))) ||
      (result.readiness === "verified" &&
        (result.catalogFailure || result.runtimeFailure || finalization || runtimeState !== "running")) ||
      (result.readiness === "unverified" && !finalization &&
        (Boolean(result.catalogFailure) === Boolean(result.runtimeFailure) ||
          (runtimeState !== "running") !== Boolean(result.runtimeFailure) ||
          result.models?.length !== 0))) {
    throw Object.assign(new Error("The installed account readiness is invalid."), { statusCode: 502 });
  }
  return {
    readiness: result.readiness, runtimeState,
    ...(finalization ? { finalizationFailure: {
      error: safeErrorMessage({ safeMessage: finalization.error }), recovery: finalization.recovery,
    } } : {}),
    ...(result.catalogFailure ? { catalogFailure: safeInstallFailure(result.catalogFailure, "request") } : {}),
    ...(result.runtimeFailure ? { runtimeFailure: safeInstallFailure(result.runtimeFailure, "handoff") } : {}),
  };
}

async function cancelOAuthLogin(state, login) {
  try {
    await login.attempt.cancel();
  } catch {
    if (state.oauthLogin === login) {
      login.status = "error";
      login.retryBlocked = true;
      login.error =
        "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.";
    }
    state.oauthRetryBlocked = true;
    state.oauthStartupError =
      "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.";
    throw Object.assign(
      new Error(
        "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
      ),
      { retryBlocked: true, statusCode: 409 },
    );
  }

  if (state.oauthLogin === login && login.status === "pending") {
    login.status = "cancelled";
  }
  releaseOAuthCredentialOperation(state, login.credentialOperation);
}

// Wizard pages and assets served from src/ui, keyed by request path. Entries
// without an encoding are binary and stay Buffers. Pages get the package
// version substituted for __RELMIO_PACKAGE_VERSION__.
const UI_FILE_SOURCES = Object.freeze({
  "/": ["../ui/index.html", "utf8"],
  "/local": ["../ui/local.html", "utf8"],
  "/assistant": ["../ui/assistant.html", "utf8"],
  "/supergrok-vps": ["../ui/supergrok-vps.html", "utf8"],
  "/local-model-vps": ["../ui/local-model-vps.html", "utf8"],
  "/hosting": ["../ui/hosting.html", "utf8"],
  "/app.js": ["../ui/app.js", "utf8"],
  "/local.js": ["../ui/local.js", "utf8"],
  "/siwc-controls.js": ["../ui/siwc-controls.js", "utf8"],
  "/assistant.js": ["../ui/assistant.js", "utf8"],
  "/supergrok-vps.js": ["../ui/supergrok-vps.js", "utf8"],
  "/local-model-vps.js": ["../ui/local-model-vps.js", "utf8"],
  "/hosting.js": ["../ui/hosting.js", "utf8"],
  "/chat-tester-feedback.js": ["../ui/chat-tester-feedback.js", "utf8"],
  "/session.js": ["../ui/session.js", "utf8"],
  "/session-bootstrap.js": ["../ui/session-bootstrap.js", "utf8"],
  "/oauth-popup.js": ["../ui/oauth-popup.js", "utf8"],
  "/theme.js": ["../ui/theme.js", "utf8"],
  "/time.js": ["../ui/time.js", "utf8"],
  "/topbar.js": ["../ui/topbar.js", "utf8"],
  "/ssh-form.js": ["../ui/ssh-form.js", "utf8"],
  "/hosting-archive.js": ["../ui/hosting-archive.js", "utf8"],
  "/domain/hosting-providers.js": ["../domain/hosting-providers.js", "utf8"],
  "/guide.js": ["../ui/guide.js", "utf8"],
  "/guide-dock.js": ["../ui/guide-dock.js", "utf8"],
  "/mascot.js": ["../ui/mascot.js", "utf8"],
  "/guide/content-vps.js": ["../ui/guide/content-vps.js", "utf8"],
  "/guide/content-local.js": ["../ui/guide/content-local.js", "utf8"],
  "/guide/content-assistant.js": ["../ui/guide/content-assistant.js", "utf8"],
  "/guide/content-supergrok-vps.js": ["../ui/guide/content-supergrok-vps.js", "utf8"],
  "/guide/content-local-model-vps.js": ["../ui/guide/content-local-model-vps.js", "utf8"],
  "/guide/content-hosting.js": ["../ui/guide/content-hosting.js", "utf8"],
  "/guide/errors.js": ["../ui/guide/errors.js", "utf8"],
  "/usage-panel.js": ["../ui/usage-panel.js", "utf8"],
  "/relmio-ui.css": ["../ui/relmio-ui.css", "utf8"],
  "/styles.css": ["../ui/styles.css", "utf8"],
  "/local.css": ["../ui/local.css", "utf8"],
  "/siwc.css": ["../ui/siwc.css", "utf8"],
  "/assistant.css": ["../ui/assistant.css", "utf8"],
  "/supergrok-vps.css": ["../ui/supergrok-vps.css", "utf8"],
  "/local-model-vps.css": ["../ui/local-model-vps.css", "utf8"],
  "/hosting.css": ["../ui/hosting.css", "utf8"],
  "/guide.css": ["../ui/guide.css", "utf8"],
  "/guide-dock.css": ["../ui/guide-dock.css", "utf8"],
  "/usage-panel.css": ["../ui/usage-panel.css", "utf8"],
  "/relmio-icon-96.png": ["../ui/relmio-icon-96.png"],
  "/relmio-icon-rounded.svg": ["../ui/relmio-icon-rounded.svg", "utf8"],
  "/fonts/geist-latin.woff2": ["../ui/fonts/geist-latin.woff2"],
  "/fonts/bricolage-grotesque-latin.woff2": ["../ui/fonts/bricolage-grotesque-latin.woff2"],
});
const UI_PAGES = new Set(["/", "/local", "/assistant", "/supergrok-vps", "/local-model-vps", "/hosting"]);

async function loadDefaultUiFiles() {
  const entries = await Promise.all(
    Object.entries(UI_FILE_SOURCES).map(async ([route, [path, encoding]]) => {
      const contents = await readFile(new URL(path, import.meta.url), encoding);
      return [
        route,
        UI_PAGES.has(route)
          ? contents.replaceAll("__RELMIO_PACKAGE_VERSION__", PACKAGE_VERSION)
          : contents,
      ];
    }),
  );
  return Object.fromEntries(entries);
}

function createSafeLocalPlan(plan) {
  return {
    target: plan.target,
    label: plan.label,
    bindHost: plan.bindHost,
    port: plan.port,
    endpoint: plan.endpoint,
    protocol: plan.protocol,
    upstreamAuth: plan.upstreamAuth,
    browserClients: plan.browserClients,
    experimental: plan.experimental,
    managedPath: plan.managedPath,
    ...(plan.account ? { account: copySiwcAccountView(plan.account) } : {}),
    ...(plan.resumeRequired ? { resumeRequired: true, staging: copySiwcStaging(plan.staging) } : {}),
    ...(plan.migrationRequired ? { migrationRequired: true, legacyResourcesPreserved: true,
      requiresMigrationConsent: true } : {}),
    ...(plan.replacementRequired ? { replacementRequired: true, oldSessionSignedOut: true,
      oldHistoryRetained: true, requiresReplacementConsent: true } : {}),
  };
}

function createSafeLocalInstallResult(result, plan) {
  const chatgpt = ["codex-chatgpt", "codex-chat"].includes(result?.target);
  const staged = result?.deploymentMode === "staged";
  if (chatgpt && (typeof result.clientCredential !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/u.test(result.clientCredential) ||
      result.credentialShownOnce !== true ||
      !["staged", "installed", "migrated", "replaced", "partial"].includes(result.deploymentMode) ||
      (result.deploymentMode === "migrated" && (result.migratedLegacy !== true || result.legacyRetained !== true)) ||
      (result.deploymentMode === "replaced" && (result.replacedAccount !== true || result.oldHistoryRetained !== true)) ||
      (!staged && (!result.account?.registrationId ||
        (plan?.authBinding && result.account.registrationId !== plan.authBinding.registrationId))) ||
      !Array.isArray(result.models) ||
      result.models.some((model) => typeof model !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,128}$/u.test(model)) ||
      (staged && result.models.length !== 0) ||
      (result.deploymentMode === "partial" && !result.runtimeFailure && !result.finalizationFailure))) {
    throw Object.assign(new Error("The local Codex installation result is invalid."), { statusCode: 502 });
  }
  const readiness = chatgpt && !staged ? copySiwcReadiness(result) : {};
  return {
    target: result.target, endpoint: result.endpoint, protocol: result.protocol,
    clientCredential: result.clientCredential,
    credentialShownOnce: result.credentialShownOnce === true,
    models: Array.isArray(result.models) ? [...result.models] : [],
    deploymentMode: result.deploymentMode,
    experimental: result.experimental === true,
    browserClients: result.browserClients === true,
    ...(result.account ? { account: copySiwcAccountView(result.account) } : {}),
    ...readiness,
    ...(result.migratedLegacy === true ? { migratedLegacy: true, legacyRetained: result.legacyRetained === true } : {}),
    ...(result.replacedAccount === true ? { replacedAccount: true, oldHistoryRetained: result.oldHistoryRetained === true } : {}),
  };
}

function createSafeLocalActivationResult(result) {
  return {
    target: result.target,
    endpoint: result.endpoint,
    protocol: result.protocol,
    models: Array.isArray(result.models) ? [...result.models] : [],
    deploymentMode: result.deploymentMode,
    experimental: result.experimental === true,
    browserClients: result.browserClients === true,
  };
}

function createSafeProjectMeta(result) {
  return {
    stars:
      Number.isSafeInteger(result?.stars) && result.stars >= 0
        ? result.stars
        : null,
    version: PACKAGE_VERSION,
  };
}

function createSafeLocalChatTestKey(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.keyId !== "string" ||
    result.keyId.length === 0 ||
    result.keyId.length > 128 ||
    !result.publicKeyJwk ||
    typeof result.publicKeyJwk !== "object" ||
    Array.isArray(result.publicKeyJwk) ||
    result.publicKeyJwk.kty !== "RSA" ||
    typeof result.publicKeyJwk.n !== "string" ||
    typeof result.publicKeyJwk.e !== "string" ||
    result.publicKeyJwk.n.length === 0 ||
    result.publicKeyJwk.n.length > 1_024 ||
    result.publicKeyJwk.e.length === 0 ||
    result.publicKeyJwk.e.length > 32 ||
    result.algorithm !== "RSA-OAEP-256" ||
    typeof result.expiresAt !== "string" ||
    Number.isNaN(Date.parse(result.expiresAt))
  ) {
    throw Object.assign(new Error("The local tester could not start safely."), {
      statusCode: 502,
    });
  }
  return {
    keyId: result.keyId,
    publicKeyJwk: {
      kty: "RSA",
      n: result.publicKeyJwk.n,
      e: result.publicKeyJwk.e,
    },
    algorithm: result.algorithm,
    expiresAt: result.expiresAt,
  };
}

function createSafeLocalChatTestResponse(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.conversationId !== "string" ||
    result.conversationId.length === 0 ||
    result.conversationId.length > 160 ||
    typeof result.output !== "string" ||
    result.output.length === 0 ||
    result.output.length > 12 * 1_024
  ) {
    throw Object.assign(
      new Error("The local adapter returned an unexpected response."),
      { statusCode: 502 },
    );
  }
  return {
    conversationId: result.conversationId,
    output: result.output,
  };
}

function getPendingLocalCredentialRotation(state) {
  if (
    state.localCredentialRotationPending &&
    state.localCredentialRotationPending.expiresAt <= Date.now()
  ) {
    state.localCredentialRotationPending = null;
  }
  return state.localCredentialRotationPending;
}

const SAFE_LOCAL_N8N_STACK_STATES = new Set([
  "healthy",
  "stopped",
  "partial",
  "unavailable",
]);

const LOCAL_DASHBOARD_SERVICE_DEFINITIONS = Object.freeze({
  "codex-chatgpt": Object.freeze({
    label: "Codex (ChatGPT plan)",
    kind: "endpoint",
    actions: new Set(["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "inspect-stopped-chatgpt", "rotate-local-capability"]),
  }),
  "codex-chat": Object.freeze({
    label: "Codex Chat adapter",
    kind: "endpoint",
    actions: new Set(["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "inspect-stopped-chatgpt", "rotate-local-capability"]),
  }),
  "xai-grok-build": Object.freeze({
    label: "SuperGrok",
    kind: "endpoint",
    actions: new Set(["setup", "sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"]),
  }),
  "local-n8n-stack": Object.freeze({
    label: "n8n + ngrok",
    kind: "n8n-stack",
    actions: new Set(["setup", "resume", "remove"]),
  }),
  "n8n-openai-oauth": Object.freeze({
    label: "ChatGPT plan sidecar",
    kind: "n8n-oauth-bridge",
    actions: new Set(["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "inspect-stopped-chatgpt", "remove"]),
  }),
  "local-n8n-assistant": Object.freeze({
    label: "AI Assistant tools",
    kind: "n8n-assistant",
    actions: new Set(["setup", "remove"]),
  }),
  "n8n-supergrok-oauth": Object.freeze({
    label: "SuperGrok for n8n",
    kind: "n8n-supergrok",
    actions: new Set([
      "setup",
      "sign-in-grok-build",
      "sign-out-grok-build",
      "remove-owned-supergrok",
    ]),
  }),
  "n8n-local-model": Object.freeze({
    label: "Local model for n8n",
    kind: "n8n-local-model",
    actions: new Set(["setup", "retry-model", "remove"]),
  }),
});

const LOCAL_DASHBOARD_PROVIDER_DEFINITIONS = Object.freeze({
  "codex-chatgpt": Object.freeze({
    label: "ChatGPT",
    authentication: "provider-oauth",
  }),
  "codex-chat": Object.freeze({
    label: "ChatGPT",
    authentication: "provider-oauth",
  }),
  "xai-grok-build": Object.freeze({
    label: "SuperGrok",
    authentication: "provider-oauth",
  }),
  "n8n-supergrok-oauth": Object.freeze({
    label: "SuperGrok (n8n)",
    authentication: "provider-oauth",
  }),
});

const LOCAL_DASHBOARD_STATES = new Set([
  "absent",
  "healthy",
  "stopped",
  "staged",
  "partial",
  "legacy",
  "unavailable",
]);

function hasSafeExplicitLoopbackPort(value) {
  const match = /^(?:http|ws):\/\/127\.0\.0\.1:(\d{1,5})(?:\/|$)/u.exec(value);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function requireSafeDashboardUrl(value, kind) {
  if (typeof value !== "string" || value.length > 512) {
    throw new TypeError("The local dashboard endpoint is invalid.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("The local dashboard endpoint is invalid.");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("The local dashboard endpoint is invalid.");
  }
  const loopback = url.hostname === "127.0.0.1";
  const valid =
    (kind === "codex-chatgpt" && loopback && url.protocol === "ws:" && url.pathname === "/") ||
    (["codex-chat", "xai-grok-build"].includes(kind) && loopback && url.protocol === "http:" && url.pathname === "/") ||
    (kind === "n8n-local" && loopback && url.protocol === "http:" && url.pathname === "/") ||
    (kind === "ngrok-inspector" && loopback && url.protocol === "http:" && url.pathname === "/") ||
    (kind === "ngrok-public" && url.protocol === "https:" && url.pathname === "/");
  const hasExpectedPort = kind === "ngrok-public"
    ? url.port === "" && value === url.origin
    : hasSafeExplicitLoopbackPort(value);
  if (!valid || !hasExpectedPort) {
    throw new TypeError("The local dashboard endpoint is invalid.");
  }
  return value;
}

function createSafeDashboardSnapshot(target, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("The local dashboard snapshot is invalid.");
  }
  if (["codex-chatgpt", "codex-chat", "xai-grok-build"].includes(target)) {
    const chatgpt = target !== "xai-grok-build";
    if (snapshot.target !== target || snapshot.auth?.disclosure !== "rotate-only" ||
        typeof snapshot.auth.configured !== "boolean" ||
        snapshot.canRotateCredential !== (chatgpt && snapshot.migrationRequired ? false : true) ||
        (!chatgpt && snapshot.auth.configured !== true)) {
      throw new TypeError("The local dashboard endpoint snapshot is invalid.");
    }
    const account = snapshot.auth.account ? copySiwcAccountView(snapshot.auth.account) : null;
    if (chatgpt && (typeof snapshot.migrationRequired !== "boolean" ||
        (snapshot.migrationRequired && (account || snapshot.registrationId !== undefined)) ||
        (!snapshot.migrationRequired && (!snapshot.registrationId ||
          (account && account.registrationId !== snapshot.registrationId))) ||
        snapshot.auth.configured !== (account?.ownership === "owned" &&
          account?.session === "connected" && account?.planEnabled === true &&
          account?.planPermission === "granted"))) throw new TypeError("The SIWC endpoint ownership is invalid.");
    if (snapshot.migrationState !== undefined &&
        (!chatgpt || snapshot.migrationRequired !== true ||
          !["incomplete", "prepared", "stopped"].includes(snapshot.migrationState) ||
          snapshot.legacyResourcesPreserved !== true)) throw new TypeError("The SIWC migration status is invalid.");
    return {
      target,
      endpoint: requireSafeDashboardUrl(snapshot.endpoint, target),
      auth: { configured: snapshot.auth.configured, disclosure: "rotate-only",
        ...(account ? { account } : {}) },
      ...(chatgpt ? { migrationRequired: snapshot.migrationRequired,
        ...(snapshot.registrationId ? { registrationId: requireSiwcId(snapshot.registrationId) } : {}),
        ...(snapshot.migrationState ? { migrationState: snapshot.migrationState,
          legacyResourcesPreserved: true } : {}) } : {}),
      canRotateCredential: snapshot.canRotateCredential,
    };
  }
  if (target === "n8n-openai-oauth") {
    if (snapshot.target !== target ||
        snapshot.endpoint !== "http://n8n-openai-oauth:10531/v1" ||
        typeof snapshot.auth?.configured !== "boolean" ||
        snapshot.auth.disclosure !== "server-managed" ||
        snapshot.canRefreshCredential !== false || snapshot.canRemove !== true ||
        typeof snapshot.migrationRequired !== "boolean") {
      throw new TypeError("The local dashboard SIWC sidecar snapshot is invalid.");
    }
    const account = snapshot.auth.account ? copySiwcAccountView(snapshot.auth.account) : null;
    if ((snapshot.migrationRequired && (account || snapshot.registrationId !== undefined)) ||
        (!snapshot.migrationRequired && (!snapshot.registrationId ||
          (account && account.registrationId !== snapshot.registrationId))) ||
        snapshot.auth.configured !== (account?.ownership === "owned" &&
          account?.session === "connected" && account?.planEnabled === true &&
          account?.planPermission === "granted")) throw new TypeError("The sidecar owner state is invalid.");
    if (snapshot.migrationState !== undefined &&
        (snapshot.migrationRequired !== true ||
          !["incomplete", "prepared", "stopped"].includes(snapshot.migrationState) ||
          snapshot.legacyResourcesPreserved !== true)) throw new TypeError("The SIWC migration status is invalid.");
    return {
      target, endpoint: snapshot.endpoint,
      auth: { configured: snapshot.auth.configured, disclosure: "server-managed",
        ...(account ? { account } : {}) },
      ...(snapshot.registrationId ? { registrationId: requireSiwcId(snapshot.registrationId) } : {}),
      migrationRequired: snapshot.migrationRequired,
      ...(snapshot.migrationState ? { migrationState: snapshot.migrationState,
        legacyResourcesPreserved: true } : {}),
      canRefreshCredential: false, canRemove: true,
    };
  }
  if (target === "local-n8n-assistant") {
    if (
      snapshot.target !== target ||
      snapshot.components?.codeSandbox !== true ||
      typeof snapshot.components?.searxng !== "boolean" ||
      snapshot.auth?.sandboxConfigured !== true ||
      snapshot.auth?.disclosure !== "one-time" ||
      snapshot.canRemove !== true
    ) {
      throw new TypeError("The local dashboard Assistant snapshot is invalid.");
    }
    return {
      target,
      components: {
        codeSandbox: true,
        searxng: snapshot.components.searxng,
      },
      auth: { sandboxConfigured: true, disclosure: "one-time" },
      canRemove: true,
    };
  }
  if (target === LOCAL_N8N_SUPERGROK_TARGET) {
    if (
      snapshot.target !== LOCAL_N8N_SUPERGROK_TARGET ||
      snapshot.endpoint !== LOCAL_N8N_SUPERGROK_ENDPOINT ||
      snapshot.auth?.configured !== true ||
      snapshot.auth?.disclosure !== "one-time" ||
      snapshot.canRemove !== true
    ) {
      throw new TypeError("The local dashboard SuperGrok snapshot is invalid.");
    }
    return {
      target: LOCAL_N8N_SUPERGROK_TARGET,
      endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT,
      auth: { configured: true, disclosure: "one-time" },
      canRemove: true,
    };
  }
  if (target === "n8n-local-model") {
    if (
      snapshot.target !== target ||
      snapshot.endpoint !== "http://n8n-local-model:11434/v1" ||
      !["missing", "downloading", "ready", "failed", "partial"].includes(snapshot.model?.state) ||
      !["qwen3:0.6b", "qwen3:1.7b", "qwen3.5:2b", "qwen3.5:4b", "qwen3.5:9b"].includes(snapshot.model?.id) ||
      (snapshot.model.digest !== null && !/^[a-f0-9]{64}$/u.test(snapshot.model.digest)) ||
      snapshot.canRetry !== ["missing", "failed"].includes(snapshot.model.state) ||
      snapshot.canRemove !== (snapshot.model.state !== "downloading") ||
      (snapshot.model.state === "ready" && snapshot.model.digest === null)
    ) throw new TypeError("The local dashboard model snapshot is invalid.");
    return {
      target,
      endpoint: snapshot.endpoint,
      model: { state: snapshot.model.state, id: snapshot.model.id, digest: snapshot.model.digest },
      canRetry: snapshot.canRetry,
      canRemove: snapshot.canRemove,
    };
  }
  if (target === "local-n8n-stack") {
    const assistantModes = new Set(["disabled", "sandbox", "sandbox-with-searxng"]);
    if (
      snapshot.target !== target ||
      !assistantModes.has(snapshot.assistantMode) ||
      typeof snapshot.components?.n8n !== "boolean" ||
      typeof snapshot.components?.ngrok !== "boolean" ||
      typeof snapshot.components?.codeSandbox !== "boolean" ||
      typeof snapshot.components?.searxng !== "boolean" ||
      typeof snapshot.canResume !== "boolean" ||
      snapshot.canRemove !== true
    ) {
      throw new TypeError("The local dashboard n8n snapshot is invalid.");
    }
    return {
      target,
      assistantMode: snapshot.assistantMode,
      endpoints: {
        n8nLocal: requireSafeDashboardUrl(snapshot.endpoints?.n8nLocal, "n8n-local"),
        ngrokPublic: requireSafeDashboardUrl(snapshot.endpoints?.ngrokPublic, "ngrok-public"),
        ngrokInspector: requireSafeDashboardUrl(
          snapshot.endpoints?.ngrokInspector,
          "ngrok-inspector",
        ),
      },
      components: {
        n8n: snapshot.components.n8n,
        ngrok: snapshot.components.ngrok,
        codeSandbox: snapshot.components.codeSandbox,
        searxng: snapshot.components.searxng,
      },
      canResume: snapshot.canResume,
      canRemove: true,
    };
  }
  throw new TypeError("The local dashboard snapshot target is invalid.");
}

function createSafeDashboardProvider(target, provider) {
  const definition = LOCAL_DASHBOARD_PROVIDER_DEFINITIONS[target];
  if (
    !definition ||
    !provider ||
    typeof provider !== "object" ||
    Array.isArray(provider) ||
    Object.keys(provider).length !== 4 ||
    provider.target !== target ||
    provider.label !== definition.label ||
    provider.authentication !== "provider-oauth" ||
    provider.readiness !== "runtime-owned"
  ) {
    throw new TypeError("The local dashboard provider status is invalid.");
  }
  return { target, label: definition.label, authentication: "provider-oauth", readiness: "runtime-owned" };
}

function expectedDashboardActions({ definition, state, snapshot }) {
  if (state === "absent" || state === "staged") return ["setup"];
  if (state === "unavailable" || snapshot === null) return [];
  const actions = [];
  if (state === "legacy") return snapshot.migrationRequired === true ? ["setup"] : [];
  if (state === "partial" && snapshot.migrationState) return [];
  if (state === "stopped" && snapshot.registrationId &&
      (["codex-chatgpt", "codex-chat"].includes(snapshot.target) ||
        definition.kind === "n8n-oauth-bridge")) actions.push("inspect-stopped-chatgpt");
  if (
    definition.kind === "n8n-stack" &&
    state === "stopped" &&
    snapshot.canResume === true
  ) {
    actions.push("resume");
  }
  if (
    definition.kind === "endpoint" &&
    state === "healthy" &&
    snapshot.canRotateCredential === true
  ) {
    if (["codex-chatgpt", "codex-chat"].includes(snapshot.target)) {
      actions.push("setup");
      if (snapshot.auth.account?.ownership === "owned") {
        actions.push("sign-out-chatgpt");
        if (snapshot.auth.account.planEnabled) actions.push("disable-chatgpt-plan");
      }
    } else if (snapshot.target === "xai-grok-build") {
      actions.push("sign-in-grok-build", "sign-out-grok-build");
    }
    actions.push("rotate-local-capability");
  }
  if (definition.kind === "n8n-oauth-bridge" && state === "healthy") {
    actions.push("setup");
    if (snapshot.auth.account?.ownership === "owned") {
      actions.push("sign-out-chatgpt");
      if (snapshot.auth.account.planEnabled) actions.push("disable-chatgpt-plan");
    }
  }
  if (definition.kind === "n8n-local-model" && snapshot.canRetry === true) {
    actions.push("retry-model");
  }
  if (definition.kind === "n8n-supergrok") {
    if (state === "healthy") {
      actions.push("sign-in-grok-build", "sign-out-grok-build");
    }
    if (snapshot.canRemove === true) actions.push("remove-owned-supergrok");
  } else if (snapshot.canRemove === true) actions.push("remove");
  return actions;
}

function requireSafeDashboardVersion(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9.+-]{1,64}$/u.test(value)) {
    throw new TypeError(`The local dashboard ${label} is invalid.`);
  }
  return value;
}

function createSafeLocalDashboardStatus(status, previewMode, previewFixture) {
  if (previewMode) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      docker: { available: false, version: null, composeVersion: null },
      auth: { secretsRevealable: false },
      services: Object.entries(LOCAL_DASHBOARD_SERVICE_DEFINITIONS).map(
        ([target, definition]) => ({
          target,
          label: definition.label,
          kind: definition.kind,
          managed: previewFixture === "staged" && target === "codex-chat",
          state: previewFixture === "staged" && target === "codex-chat" ? "staged" : "absent",
          ...(previewFixture === "staged" && target === "codex-chat" ? { staging: {
            installId: "preview_installation_1", registrationId: "preview_registration_1", stage: "prepared",
          } } : {}),
          snapshot: null,
          actions: ["setup"],
        }),
      ),
      providers: Object.entries(LOCAL_DASHBOARD_PROVIDER_DEFINITIONS).map(
        ([target, definition]) => ({
          target,
          label: definition.label,
          authentication: "provider-oauth",
          readiness: "runtime-owned",
        }),
      ),
      previewMode: true,
    };
  }
  if (
    status?.schemaVersion !== 1 ||
    typeof status.generatedAt !== "string" ||
    new Date(status.generatedAt).toISOString() !== status.generatedAt ||
    typeof status.docker?.available !== "boolean" ||
    status.auth?.secretsRevealable !== false ||
    !Array.isArray(status.services) ||
    !Array.isArray(status.providers)
  ) {
    throw new TypeError("The local dashboard status is invalid.");
  }
  const expectedProviders = Object.keys(LOCAL_DASHBOARD_PROVIDER_DEFINITIONS);
  if (status.providers.length !== expectedProviders.length) {
    throw new TypeError("The local dashboard provider set is invalid.");
  }
  const providers = status.providers.map((provider, index) =>
    createSafeDashboardProvider(expectedProviders[index], provider));
  const providersByTarget = new Map(providers.map((provider) => [provider.target, provider]));
  const expectedServices = Object.entries(LOCAL_DASHBOARD_SERVICE_DEFINITIONS);
  if (status.services.length !== expectedServices.length) {
    throw new TypeError("The local dashboard service set is invalid.");
  }
  const services = [];
  for (const [index, [target, definition]] of expectedServices.entries()) {
    const service = status.services[index];
    if (
      service?.target !== target ||
      service.kind !== definition.kind ||
      typeof service.managed !== "boolean" ||
      !LOCAL_DASHBOARD_STATES.has(service.state) ||
      !Array.isArray(service.actions) ||
      (["absent", "unavailable"].includes(service.state)
        ? service.managed !== false
        : service.managed !== true)
    ) {
      throw new TypeError("The local dashboard service status is invalid.");
    }
    const requiresNullSnapshot = ["absent", "unavailable", "staged"].includes(service.state);
    if (service.state === "staged" &&
        !["codex-chatgpt", "codex-chat", "n8n-openai-oauth"].includes(target)) throw new TypeError();
    const allowsUnattestedPartial =
      service.state === "partial" && service.snapshot === null;
    if (requiresNullSnapshot && service.snapshot !== null) {
      throw new TypeError("The local dashboard service snapshot is invalid.");
    }
    const snapshot = requiresNullSnapshot || allowsUnattestedPartial
      ? null
      : createSafeDashboardSnapshot(service.target, service.snapshot);
    const actions = expectedDashboardActions({
      definition,
      state: service.state,
      snapshot,
      provider: providersByTarget.get(target),
    });
    if (
      actions.some((action) => !definition.actions.has(action)) ||
      service.actions.length !== actions.length ||
      service.actions.some((action, actionIndex) => action !== actions[actionIndex])
    ) {
      throw new TypeError("The local dashboard service actions are invalid.");
    }
    services.push({
      target: service.target,
      label: definition.label,
      kind: definition.kind,
      managed: service.managed,
      state: service.state,
      ...(service.state === "staged" ? { staging: copySiwcStaging(service.staging) } : {}),
      snapshot,
      actions,
    });
  }
  if (
    status.docker.available
      ? status.docker.version === null || status.docker.composeVersion === null
      : status.docker.version !== null || status.docker.composeVersion !== null
  ) {
    throw new TypeError("The local dashboard Docker status is invalid.");
  }
  const version = status.docker.available
    ? requireSafeDashboardVersion(status.docker.version, "Docker version")
    : null;
  const composeVersion = status.docker.available
    ? requireSafeDashboardVersion(status.docker.composeVersion, "Compose version")
    : null;
  return {
    schemaVersion: 1,
    generatedAt: status.generatedAt,
    docker: {
      available: status.docker.available,
      version,
      composeVersion,
    },
    auth: { secretsRevealable: false },
    services,
    providers,
  };
}

function createSafeDockerStatus(
  status,
  previewMode,
  localN8nStackState = null,
) {
  if (previewMode || status?.dockerAvailable !== true) {
    return {
      dockerAvailable: false,
      ...(previewMode ? { previewMode: true } : {}),
      ...(!previewMode && status?.unsupportedPlatform === true
        ? { unsupportedPlatform: true }
        : {}),
    };
  }
  return {
    dockerAvailable: true,
    dockerVersion: status.dockerVersion,
    composeVersion: status.composeVersion,
    ...(SAFE_LOCAL_N8N_STACK_STATES.has(localN8nStackState)
      ? { localN8nStackState }
      : {}),
  };
}

function requireSafeDockerIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{12,64}$/u.test(value)) {
    throw Object.assign(new Error(`The discovered ${label} is invalid.`), {
      statusCode: 502,
    });
  }
  return value;
}

function requireSafeDockerName(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)
  ) {
    throw Object.assign(new Error(`The discovered ${label} is invalid.`), {
      statusCode: 502,
    });
  }
  return value;
}

function requireSafeDisplayValue(value, label, maximumLength = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw Object.assign(new Error(`The discovered ${label} is invalid.`), {
      statusCode: 502,
    });
  }
  return value;
}

function createSafeLocalN8nDiscovery(discovery, previewMode) {
  if (previewMode) {
    return {
      dockerAvailable: false,
      previewMode: true,
      containers: [],
    };
  }
  if (discovery?.dockerAvailable !== true) {
    return { dockerAvailable: false, containers: [] };
  }
  if (!Array.isArray(discovery.containers)) {
    throw Object.assign(
      new Error("The local n8n discovery response is invalid."),
      { statusCode: 502 },
    );
  }
  return {
    dockerAvailable: true,
    ...(typeof discovery.dockerVersion === "string"
      ? {
          dockerVersion: requireSafeDisplayValue(
            discovery.dockerVersion,
            "Docker version",
            80,
          ),
        }
      : {}),
    ...(typeof discovery.composeVersion === "string"
      ? {
          composeVersion: requireSafeDisplayValue(
            discovery.composeVersion,
            "Compose version",
            80,
          ),
        }
      : {}),
    containers: discovery.containers.map((container) => {
      if (!Array.isArray(container?.networks)) {
        throw Object.assign(
          new Error("The discovered n8n network list is invalid."),
          { statusCode: 502 },
        );
      }
      return {
        containerId: requireSafeDockerIdentifier(
          container.containerId,
          "n8n container ID",
        ),
        containerName: requireSafeDockerName(
          container.containerName,
          "n8n container name",
        ),
        image: requireSafeDisplayValue(container.image, "n8n image"),
        networks: container.networks.map((network) => ({
          dockerNetworkId: requireSafeDockerIdentifier(
            network?.dockerNetworkId,
            "Docker network ID",
          ),
          networkName: requireSafeDockerName(
            network?.networkName,
            "Docker network name",
          ),
          disposable: network?.disposable === true,
        })),
      };
    }),
  };
}

function createSafeLocalN8nPlan(plan) {
  return {
    kind: plan.kind,
    target: plan.target,
    label: plan.label,
    n8nContainerId: plan.n8nContainerId,
    n8nContainerName: plan.n8nContainerName,
    dockerNetworkId: plan.dockerNetworkId,
    networkName: plan.networkName,
    endpoint: plan.endpoint,
    upstreamAuth: plan.upstreamAuth,
    hostPublication: plan.hostPublication,
    managedPath: plan.managedPath,
    disposableHarnessWarning: plan.disposableHarnessWarning === true,
    ...(plan.account ? { account: copySiwcAccountView(plan.account) } : {}),
    ...(plan.resumeRequired ? { resumeRequired: true, staging: copySiwcStaging(plan.staging) } : {}),
    ...(plan.migrationRequired ? { migrationRequired: true, legacyResourcesPreserved: true,
      requiresMigrationConsent: true } : {}),
    ...(plan.replacementRequired ? { replacementRequired: true, oldSessionSignedOut: true,
      oldHistoryRetained: true, requiresReplacementConsent: true } : {}),
  };
}

function createSafeLocalN8nSuperGrokPlan(plan) {
  if (
    plan?.kind !== "n8n-supergrok" ||
    plan.target !== LOCAL_N8N_SUPERGROK_TARGET ||
    plan.label !== "SuperGrok for n8n" ||
    plan.endpoint !== LOCAL_N8N_SUPERGROK_ENDPOINT ||
    plan.baseUrl !== LOCAL_N8N_SUPERGROK_ENDPOINT ||
    plan.protocol !== "openai-chat-completions" ||
    plan.upstreamAuth !== "provider-owned-oauth" ||
    plan.managedPath !== "~/.relmio/local/n8n-supergrok-oauth" ||
    plan.hostPublication !== "none" ||
    plan.experimental !== true ||
    typeof plan.disposableHarnessWarning !== "boolean"
  ) {
    throw Object.assign(
      new Error("The local n8n SuperGrok plan is invalid."),
      { statusCode: 502 },
    );
  }
  return {
    kind: "n8n-supergrok",
    target: LOCAL_N8N_SUPERGROK_TARGET,
    label: "SuperGrok for n8n",
    endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT,
    baseUrl: LOCAL_N8N_SUPERGROK_ENDPOINT,
    protocol: "openai-chat-completions",
    upstreamAuth: "provider-owned-oauth",
    n8nContainerId: requireSafeDockerIdentifier(
      plan.n8nContainerId,
      "n8n container ID",
    ),
    n8nContainerName: requireSafeDockerName(
      plan.n8nContainerName,
      "n8n container name",
    ),
    dockerNetworkId: requireSafeDockerIdentifier(
      plan.dockerNetworkId,
      "Docker network ID",
    ),
    networkName: requireSafeDockerName(plan.networkName, "Docker network name"),
    managedPath: "~/.relmio/local/n8n-supergrok-oauth",
    hostPublication: "none",
    experimental: true,
    disposableHarnessWarning: plan.disposableHarnessWarning,
  };
}

function requireCatalogModel(value) {
  if (!LOCAL_MODEL_CATALOG.some((model) => model.id === value)) throw new TypeError("Select an allowlisted local model.");
  return value;
}

function safeModelBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("The model resource measurement is invalid.");
  return value;
}

function safeModelBudget(value) {
  if (!value || typeof value !== "object" ||
    !Number.isSafeInteger(value.memoryBytes) || value.memoryBytes <= 0 ||
    typeof value.cpus !== "number" || !Number.isFinite(value.cpus) || value.cpus <= 0 ||
    !Number.isSafeInteger(value.contextTokens) || value.contextTokens <= 0) {
    throw new TypeError("The reviewed model budget is invalid.");
  }
  return { memoryBytes: value.memoryBytes, cpus: value.cpus, contextTokens: value.contextTokens };
}

function createSafeLocalN8nModelPlan(plan) {
  if (plan?.kind !== LOCAL_N8N_MODEL_TARGET || plan.target !== LOCAL_N8N_MODEL_TARGET ||
    plan.endpoint !== LOCAL_N8N_MODEL_ENDPOINT || plan.baseUrl !== LOCAL_N8N_MODEL_ENDPOINT ||
    plan.hostPublication !== "none" || plan.authentication !== "none" ||
    plan.upstreamAuth !== "none" || plan.protocol !== "openai-chat-completions" ||
    plan.apiKeyPlaceholder !== "local-only" || plan.responsesApi !== false ||
    plan.cloudEnabled !== false || plan.experimental !== true ||
    plan.managedPath !== "~/.relmio/local/n8n-local-model" ||
    plan.catalogRevision !== LOCAL_MODEL_CATALOG_REVISION ||
    plan.runtimeImage !== LOCAL_MODEL_RUNTIME_IMAGE ||
    plan.approvedModelDigest !== getLocalModelDefinition(requireCatalogModel(plan.modelId)).manifestDigest ||
    !/^sha256:[a-f0-9]{64}$/u.test(plan.approvedModelDigest) ||
    !Number.isFinite(plan.hostResources?.cpus) || plan.hostResources.cpus <= 0) {
    throw Object.assign(new TypeError("The local model plan is invalid."), { statusCode: 502 });
  }
  return {
    kind: LOCAL_N8N_MODEL_TARGET, target: LOCAL_N8N_MODEL_TARGET,
    label: "Local model for n8n", endpoint: LOCAL_N8N_MODEL_ENDPOINT,
    n8nContainerId: requireSafeDockerIdentifier(plan.n8nContainerId, "n8n container ID"),
    n8nContainerName: requireSafeDockerName(plan.n8nContainerName, "n8n container name"),
    dockerNetworkId: requireSafeDockerIdentifier(plan.dockerNetworkId, "Docker network ID"),
    networkName: requireSafeDockerName(plan.networkName, "Docker network name"),
    modelId: requireCatalogModel(plan.modelId), catalogRevision: LOCAL_MODEL_CATALOG_REVISION,
    runtimeImage: LOCAL_MODEL_RUNTIME_IMAGE, approvedModelDigest: plan.approvedModelDigest,
    contextTokens: safeModelBudget(plan).contextTokens, memoryBytes: plan.memoryBytes,
    cpus: plan.cpus, expectedDownloadBytes: safeModelBytes(plan.expectedDownloadBytes),
    requiredDiskBytes: safeModelBytes(plan.requiredDiskBytes),
    reservedMemoryBytes: safeModelBytes(plan.reservedMemoryBytes),
    hostResources: {
      memoryBytes: safeModelBytes(plan.hostResources?.memoryBytes),
      cpus: plan.hostResources.cpus,
      diskAvailableBytes: safeModelBytes(plan.hostResources.diskAvailableBytes),
    },
    managedPath: plan.managedPath, hostPublication: "none",
    authentication: "none", apiKeyPlaceholder: "local-only",
    responsesApi: false, cloudEnabled: false, experimental: true,
    disposableHarnessWarning: plan.disposableHarnessWarning === true,
  };
}

function createSafeVpsLocalModelPlan(plan) {
  if (!["install", "retry", "remove"].includes(plan?.action) ||
    plan.installDirectory !== "/docker/n8n-openai-oauth/local-model" ||
    plan.operationLockPath !== "/docker/n8n-openai-oauth/.local-model-operation.lock" ||
    plan.temporaryBuildStatePath !== (plan.action === "remove" ? null : "/docker/n8n-openai-oauth/.local-model-operation.lock/buildx") ||
    (plan.action === "install"
      ? !exactObjectKeys(plan.sharedRootBootstrap, [
          "directory", "markerPath", "mayCreateDirectory", "mayCreateMarker", "preservesExistingMode",
        ]) ||
        plan.sharedRootBootstrap.directory !== "/docker/n8n-openai-oauth" ||
        plan.sharedRootBootstrap.markerPath !== "/docker/n8n-openai-oauth/.managed-by-relmio-root" ||
        plan.sharedRootBootstrap.mayCreateDirectory !== true ||
        plan.sharedRootBootstrap.mayCreateMarker !== true ||
        plan.sharedRootBootstrap.preservesExistingMode !== true
      : plan.sharedRootBootstrap !== null) ||
    plan.endpoint !== LOCAL_N8N_MODEL_ENDPOINT ||
    plan.catalogRevision !== LOCAL_MODEL_CATALOG_REVISION ||
    plan.runtimeImage !== LOCAL_MODEL_RUNTIME_IMAGE ||
    plan.approvedModelDigest !== getLocalModelDefinition(requireCatalogModel(plan.modelId)).manifestDigest ||
    !/^sha256:[a-f0-9]{64}$/u.test(plan.approvedModelDigest) ||
    plan.clearModelCache !== (plan.action === "remove") ||
    !Array.isArray(plan.publishedPorts) || plan.publishedPorts.length !== 0 ||
    !Array.isArray(plan.existingN8nChanges) || plan.existingN8nChanges.length !== 0 ||
    plan.existingN8nRestarts !== 0 ||
    !Number.isSafeInteger(plan.hostResources?.memoryBytes) ||
    !Number.isSafeInteger(plan.hostResources?.diskAvailableBytes) ||
    typeof plan.hostResources?.cpus !== "number" || !Number.isFinite(plan.hostResources.cpus) ||
    plan.hostResources.cpus <= 0) {
    throw Object.assign(new TypeError("The reviewed VPS model plan is invalid."), { statusCode: 502 });
  }
  const budget = safeModelBudget(plan);
  return {
    action: plan.action,
    containerName: requireSafeDockerName(plan.containerName, "n8n container name"),
    networkName: requireSafeDockerName(plan.networkName, "Docker network name"),
    containerId: requireSafeDockerIdentifier(plan.containerId, "n8n container ID"),
    networkId: requireSafeDockerIdentifier(plan.networkId, "Docker network ID"),
    installId: plan.installId ?? null,
    installDirectory: plan.installDirectory,
    operationLockPath: "/docker/n8n-openai-oauth/.local-model-operation.lock",
    temporaryBuildStatePath: plan.temporaryBuildStatePath,
    sharedRootBootstrap: plan.action === "install"
      ? {
          directory: "/docker/n8n-openai-oauth",
          markerPath: "/docker/n8n-openai-oauth/.managed-by-relmio-root",
          mayCreateDirectory: true,
          mayCreateMarker: true,
          preservesExistingMode: true,
        }
      : null,
    endpoint: LOCAL_N8N_MODEL_ENDPOINT,
    modelId: requireCatalogModel(plan.modelId),
    catalogRevision: LOCAL_MODEL_CATALOG_REVISION,
    runtimeImage: LOCAL_MODEL_RUNTIME_IMAGE, approvedModelDigest: plan.approvedModelDigest,
    contextTokens: budget.contextTokens, memoryBytes: budget.memoryBytes, cpus: budget.cpus,
    expectedDownloadBytes: safeModelBytes(plan.expectedDownloadBytes),
    requiredDiskBytes: safeModelBytes(plan.requiredDiskBytes),
    reservedMemoryBytes: safeModelBytes(plan.reservedMemoryBytes),
    hostResources: {
      memoryBytes: safeModelBytes(plan.hostResources.memoryBytes),
      cpus: plan.hostResources.cpus,
      diskAvailableBytes: safeModelBytes(plan.hostResources.diskAvailableBytes),
    },
    clearModelCache: plan.clearModelCache,
    publishedPorts: [], existingN8nChanges: [], existingN8nRestarts: 0,
  };
}

function requireVpsSuperGrokBuildBoundary(plan) {
  const mayBuild = ["install", "sign-in", "sign-out"].includes(plan?.action);
  if (plan?.operationLockPath !== "/docker/n8n-openai-oauth/.supergrok-operation.lock" ||
    plan.temporaryBuildStatePath !== (mayBuild ? "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx" : null)) {
    throw Object.assign(new TypeError("The reviewed SuperGrok build boundary is invalid."), { statusCode: 502 });
  }
}

function createSafeLocalN8nAssistantPlan(plan) {
  return {
    kind: plan.kind,
    target: plan.target,
    label: plan.label,
    protocol: plan.protocol,
    n8nContainerId: plan.n8nContainerId,
    n8nContainerName: plan.n8nContainerName,
    dockerNetworkId: plan.dockerNetworkId,
    networkName: plan.networkName,
    codeSandbox: plan.codeSandbox === true,
    includeSearxng: plan.includeSearxng === true,
    privilegedRunner: plan.privilegedRunner === true,
    hostPublication: plan.hostPublication,
    managedPath: plan.managedPath,
    n8nConfigurationRequired: plan.n8nConfigurationRequired === true,
    disposableHarnessWarning: plan.disposableHarnessWarning === true,
  };
}

function createSafeLocalN8nStackPlan(plan) {
  if (
    plan?.target !== LOCAL_N8N_STACK_TARGET ||
    plan.kind !== "local-n8n-stack" ||
    plan.localUrl !== `http://127.0.0.1:${plan.n8nPort}` ||
    plan.ngrokPublicUrl !== `https://${plan.ngrokHostname}` ||
    plan.hostPublication !== "loopback-only" ||
    plan.deploymentMode !== "new-disposable-stack" ||
    plan.managedPath !== "~/.relmio/local/n8n-stack" ||
    !Number.isInteger(plan.n8nPort) ||
    !Number.isInteger(plan.ngrokInspectorPort) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z0-9.-]+$/u.test(plan.ngrokHostname ?? "") ||
    !["disabled", "sandbox", "sandbox-with-searxng"].includes(plan.assistantMode) ||
    typeof plan.timezone !== "string"
  ) {
    throw Object.assign(new Error("The local n8n stack plan is invalid."), {
      statusCode: 502,
    });
  }
  return {
    kind: plan.kind,
    target: plan.target,
    label: plan.label,
    ngrokHostname: plan.ngrokHostname,
    n8nPort: plan.n8nPort,
    ngrokInspectorPort: plan.ngrokInspectorPort,
    timezone: plan.timezone,
    assistantMode: plan.assistantMode,
    localUrl: plan.localUrl,
    ngrokPublicUrl: plan.ngrokPublicUrl,
    hostPublication: plan.hostPublication,
    deploymentMode: plan.deploymentMode,
    managedPath: plan.managedPath,
  };
}

function createSafeLocalN8nStackInstallResult(result, plan) {
  if (
    result?.target !== LOCAL_N8N_STACK_TARGET ||
    result.localUrl !== plan.localUrl ||
    result.ngrokPublicUrl !== plan.ngrokPublicUrl ||
    result.assistantMode !== plan.assistantMode ||
    result.hostPublication !== `n8n http://127.0.0.1:${plan.n8nPort}; ngrok inspector http://127.0.0.1:${plan.ngrokInspectorPort}` ||
    result.deploymentMode !== "new-disposable-stack" ||
    !/^relmio-local-n8n-[a-f0-9]{32}$/u.test(result.projectName ?? "") ||
    !Array.isArray(result.containerServices) ||
    result.containerServices.some((name) => requireSafeDockerName(name, "n8n service name") !== name) ||
    !Array.isArray(result.networks) ||
    result.networks.some((name) => !["edge", "assistant-shared", "assistant-internal"].includes(name))
  ) {
    throw Object.assign(new Error("The local n8n stack returned an invalid result."), {
      statusCode: 502,
    });
  }
  const assistantSettings = result.assistantSettings;
  const expectedAssistantSettings =
    result.assistantMode === "disabled"
      ? null
      : {
          sandboxUrl: "http://relmio-sandbox-api:8080",
          ...(result.assistantMode === "sandbox-with-searxng"
            ? { searxngUrl: "http://relmio-searxng:8080" }
            : {}),
        };
  if (
    JSON.stringify(assistantSettings) !== JSON.stringify(expectedAssistantSettings)
  ) {
    throw Object.assign(new Error("The local n8n stack returned invalid Assistant settings."), {
      statusCode: 502,
    });
  }
  return {
    target: result.target,
    localUrl: result.localUrl,
    ngrokPublicUrl: result.ngrokPublicUrl,
    projectName: result.projectName,
    containerServices: [...result.containerServices],
    networks: [...result.networks],
    assistantMode: result.assistantMode,
    assistantSettings: assistantSettings === null ? null : { ...assistantSettings },
    hostPublication: result.hostPublication,
    deploymentMode: result.deploymentMode,
  };
}

function createSafeLocalN8nStackRemovalResult(result) {
  if (
    result?.target !== LOCAL_N8N_STACK_TARGET ||
    result.removed !== true ||
    result.deploymentMode !== "removed-owned-disposable-stack"
  ) {
    throw Object.assign(new Error("The local n8n stack removal result is invalid."), {
      statusCode: 502,
    });
  }
  return {
    target: LOCAL_N8N_STACK_TARGET,
    removed: true,
    deploymentMode: result.deploymentMode,
  };
}

function invalidAssistantInstallResult(label) {
  return Object.assign(
    new Error(`The ${label} returned an invalid result.`),
    { statusCode: 502 },
  );
}

function requireSafeAssistantUrl(value, prefix, label) {
  if (
    typeof value !== "string" ||
    !new RegExp(
      `^http://${prefix}-[a-f0-9]{32}:8080$`,
      "u",
    ).test(value)
  ) {
    throw invalidAssistantInstallResult(label);
  }
  return value;
}

function requireExactAssistantSettings({
  settings,
  sandboxUrl,
  sandboxApiKey,
  includeSearxng,
  searxngUrl,
  label,
}) {
  const expectedSettings = {
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: ASSISTANT_COMPANION_IMAGES.sandbox,
    N8N_SANDBOX_SERVICE_URL: sandboxUrl,
    ...(sandboxApiKey === null
      ? {}
      : { N8N_SANDBOX_SERVICE_API_KEY: sandboxApiKey }),
    ...(includeSearxng
      ? { N8N_INSTANCE_AI_SEARXNG_URL: searxngUrl }
      : {}),
  };
  const expectedNames = Object.keys(expectedSettings);
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    Object.keys(settings).length !== expectedNames.length ||
    expectedNames.some(
      (name) =>
        !Object.hasOwn(settings, name) ||
        settings[name] !== expectedSettings[name],
    )
  ) {
    throw invalidAssistantInstallResult(label);
  }
  return expectedSettings;
}

function createSafeAssistantInstallResult(result, reviewedPlan) {
  const label = "VPS AI Assistant";
  const sandboxUrl = requireSafeAssistantUrl(
    result?.sandboxUrl,
    "relmio-ai-sandbox",
    label,
  );
  const includeSearxng = result?.includeSearxng;
  const deploymentMode = result?.deploymentMode;
  const sandboxApiKey = result?.sandboxApiKey;
  if (
    typeof includeSearxng !== "boolean" ||
    includeSearxng !== reviewedPlan?.includeSearxng ||
    !["installed", "updated"].includes(deploymentMode) ||
    (sandboxApiKey !== null &&
      (typeof sandboxApiKey !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(sandboxApiKey))) ||
    (deploymentMode === "installed" && sandboxApiKey === null)
  ) {
    throw invalidAssistantInstallResult(label);
  }
  const searxngUrl = includeSearxng
    ? requireSafeAssistantUrl(
        result?.searxngUrl,
        "relmio-ai-searxng",
        label,
      )
    : undefined;
  if (!includeSearxng && Object.hasOwn(result, "searxngUrl")) {
    throw invalidAssistantInstallResult(label);
  }
  const n8nSettings = requireExactAssistantSettings({
    settings: result?.n8nSettings,
    sandboxUrl,
    sandboxApiKey,
    includeSearxng,
    searxngUrl,
    label,
  });
  return {
    sandboxUrl,
    sandboxApiKey,
    includeSearxng,
    ...(includeSearxng ? { searxngUrl } : {}),
    n8nSettings,
    deploymentMode,
  };
}

function createSafeLocalN8nStackResumeResult(result) {
  if (
    result?.target !== LOCAL_N8N_STACK_TARGET ||
    result.resumed !== true ||
    result.deploymentMode !== "resumed-owned-disposable-stack"
  ) {
    throw Object.assign(new Error("The local n8n stack resume result is invalid."), {
      statusCode: 502,
    });
  }
  return {
    target: LOCAL_N8N_STACK_TARGET,
    resumed: true,
    deploymentMode: result.deploymentMode,
  };
}

function createSafeLocalN8nAssistantInstallResult(result, reviewedPlan) {
  const label = "local n8n Assistant";
  const sandboxUrl = requireSafeAssistantUrl(
    result?.sandboxUrl,
    "relmio-ai-sandbox",
    label,
  );
  const includeSearxng = result?.includeSearxng;
  const searxngUrl = includeSearxng
    ? requireSafeAssistantUrl(
        result?.searxngUrl,
        "relmio-ai-searxng",
        label,
      )
    : undefined;
  const sandboxApiKey = result?.sandboxApiKey;
  if (
    result?.target !== LOCAL_N8N_ASSISTANT_TARGET ||
    result.protocol !== "n8n-instance-ai-companion" ||
    result.endpoint !== sandboxUrl ||
    typeof includeSearxng !== "boolean" ||
    includeSearxng !== reviewedPlan?.includeSearxng ||
    (!includeSearxng && Object.hasOwn(result, "searxngUrl")) ||
    typeof sandboxApiKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(sandboxApiKey) ||
    result.deploymentMode !== "installed" ||
    result.hostPublication !== "none" ||
    result.privilegedRunner !== true ||
    result.n8nConfigurationRequired !== true ||
    result.credentialShownOnce !== true
  ) {
    throw invalidAssistantInstallResult(label);
  }
  const networkName = requireSafeDockerName(
    result.networkName,
    "Assistant network name",
  );
  const n8nContainerName = requireSafeDockerName(
    result.n8nContainerName,
    "n8n container name",
  );
  if (
    networkName !== reviewedPlan?.networkName ||
    n8nContainerName !== reviewedPlan?.n8nContainerName
  ) {
    throw invalidAssistantInstallResult(label);
  }
  const n8nSettings = requireExactAssistantSettings({
    settings: result.n8nSettings,
    sandboxUrl,
    sandboxApiKey,
    includeSearxng,
    searxngUrl,
    label,
  });
  return {
    target: result.target,
    endpoint: sandboxUrl,
    sandboxUrl,
    sandboxApiKey,
    ...(includeSearxng ? { searxngUrl } : {}),
    protocol: result.protocol,
    includeSearxng,
    networkName,
    n8nContainerName,
    hostPublication: "none",
    privilegedRunner: true,
    n8nConfigurationRequired: true,
    n8nSettings,
    deploymentMode: "installed",
    credentialShownOnce: true,
  };
}

function createSafeLocalN8nAssistantRemovalResult(result) {
  if (
    result?.target !== LOCAL_N8N_ASSISTANT_TARGET ||
    result.removed !== true
  ) {
    throw Object.assign(
      new Error("The local n8n Assistant removal result is invalid."),
      { statusCode: 502 },
    );
  }
  return { target: LOCAL_N8N_ASSISTANT_TARGET, removed: true };
}



function createSafeLocalN8nAssistantSearxngReview(review, reviewId) {
  const plan = review?.plan;
  const installation = review?.installation;
  const sandboxUrl = `http://${installation?.sandboxAlias}:8080`;
  const searxngUrl = `http://${installation?.searxngAlias}:8080`;
  if (
    !review ||
    typeof review !== "object" ||
    Array.isArray(review) ||
    review.schemaVersion !== 1 ||
    review.kind !== "relmio-local-n8n-assistant-searxng-update" ||
    review.target !== LOCAL_N8N_ASSISTANT_TARGET ||
    review.includeSearxng !== true ||
    review.sandboxApiKeyRotated !== false ||
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    plan.target !== LOCAL_N8N_ASSISTANT_TARGET ||
    plan.includeSearxng !== false ||
    plan.hostPublication !== "none" ||
    plan.n8nConfigurationRequired !== true ||
    !installation ||
    typeof installation !== "object" ||
    Array.isArray(installation) ||
    installation.includeSearxng !== false
  ) {
    throw Object.assign(
      new Error("The local n8n Assistant edit review is invalid."),
      { statusCode: 502 },
    );
  }
  return {
    reviewId: requireSafeDisplayValue(reviewId, "Assistant edit review ID", 128),
    target: LOCAL_N8N_ASSISTANT_TARGET,
    includeSearxng: true,
    sandboxApiKeyRotated: false,
    sandboxUrl: requireSafeAssistantUrl(
      sandboxUrl,
      "relmio-ai-sandbox",
      "local n8n Assistant edit",
    ),
    searxngUrl: requireSafeAssistantUrl(
      searxngUrl,
      "relmio-ai-searxng",
      "local n8n Assistant edit",
    ),
    n8nContainerName: requireSafeDockerName(
      plan.n8nContainerName,
      "n8n container name",
    ),
    networkName: requireSafeDockerName(plan.networkName, "Docker network name"),
    hostPublication: "none",
    n8nConfigurationRequired: true,
  };
}

function createSafeLocalN8nAssistantSearxngEditResult(result) {
  const label = "local n8n Assistant SearXNG edit";
  const sandboxUrl = requireSafeAssistantUrl(
    result?.sandboxUrl,
    "relmio-ai-sandbox",
    label,
  );
  const searxngUrl = requireSafeAssistantUrl(
    result?.searxngUrl,
    "relmio-ai-searxng",
    label,
  );
  const expectedSettings = {
    N8N_INSTANCE_AI_SEARXNG_URL: searxngUrl,
  };
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.target !== LOCAL_N8N_ASSISTANT_TARGET ||
    result.endpoint !== sandboxUrl ||
    result.protocol !== "n8n-instance-ai-companion" ||
    result.includeSearxng !== true ||
    result.hostPublication !== "none" ||
    result.privilegedRunner !== true ||
    result.n8nConfigurationRequired !== true ||
    result.deploymentMode !== "searxng-enabled" ||
    result.sandboxApiKeyRotated !== false ||
    Object.hasOwn(result, "sandboxApiKey") ||
    !result.n8nSettings ||
    typeof result.n8nSettings !== "object" ||
    Array.isArray(result.n8nSettings) ||
    Object.keys(result.n8nSettings).length !== 1 ||
    result.n8nSettings.N8N_INSTANCE_AI_SEARXNG_URL !== searxngUrl
  ) {
    throw Object.assign(
      new Error("The local n8n Assistant SearXNG edit returned an invalid result."),
      { statusCode: 502 },
    );
  }
  return {
    target: LOCAL_N8N_ASSISTANT_TARGET,
    endpoint: sandboxUrl,
    sandboxUrl,
    searxngUrl,
    protocol: "n8n-instance-ai-companion",
    includeSearxng: true,
    networkName: requireSafeDockerName(result.networkName, "Assistant network name"),
    n8nContainerName: requireSafeDockerName(
      result.n8nContainerName,
      "n8n container name",
    ),
    hostPublication: "none",
    privilegedRunner: true,
    n8nConfigurationRequired: true,
    n8nSettings: expectedSettings,
    deploymentMode: "searxng-enabled",
    sandboxApiKeyRotated: false,
  };
}

function createSafeLocalN8nInstallResult(result, plan) {
  const endpoint = result?.endpoint ?? result?.baseUrl;
  const models = result?.models;
  if (
    result?.target !== LOCAL_N8N_SIDECAR_TARGET ||
    endpoint !== LOCAL_N8N_SIDECAR_ENDPOINT ||
    result.protocol !== "openai-v1" ||
    typeof result.clientCredential !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(result.clientCredential) ||
    result.credentialShownOnce !== true ||
    !Array.isArray(models) ||
    models.some((model) => typeof model !== "string" || model.length === 0 ||
      model.length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(model)) ||
    !["installed", "migrated", "replaced", "partial"].includes(result.deploymentMode) ||
    (result.deploymentMode === "migrated" && (result.migratedLegacy !== true || result.legacyRetained !== true)) ||
    (result.deploymentMode === "replaced" && (result.replacedAccount !== true || result.oldHistoryRetained !== true)) ||
    (result.deploymentMode === "partial" && !result.runtimeFailure && !result.finalizationFailure) ||
    typeof result.networkName !== "string" ||
    (result.hostPublication !== "none" &&
      !(result.deploymentMode === "partial" && result.runtimeState === "unknown" &&
        result.hostPublication === "unknown")) ||
    result.account?.registrationId !== plan.authBinding.registrationId
  ) {
    throw Object.assign(new Error("The local n8n sidecar returned an invalid result."), { statusCode: 502 });
  }
  return {
    target: result.target,
    endpoint,
    clientCredential: result.clientCredential,
    credentialShownOnce: true,
    protocol: result.protocol,
    models: [...models],
    deploymentMode: result.deploymentMode,
    networkName: requireSafeDockerName(result.networkName, "sidecar network name"),
    hostPublication: result.hostPublication,
    account: copySiwcAccountView(result.account),
    ...copySiwcReadiness(result),
    ...(result.migratedLegacy === true ? { migratedLegacy: true, legacyRetained: result.legacyRetained === true } : {}),
    ...(result.replacedAccount === true ? { replacedAccount: true, oldHistoryRetained: result.oldHistoryRetained === true } : {}),
  };
}

function createSafeLocalN8nSuperGrokInstallResult(result, reviewedPlan) {
  if (
    result?.target !== LOCAL_N8N_SUPERGROK_TARGET ||
    result.endpoint !== LOCAL_N8N_SUPERGROK_ENDPOINT ||
    result.baseUrl !== LOCAL_N8N_SUPERGROK_ENDPOINT ||
    result.protocol !== "openai-chat-completions" ||
    result.networkName !== reviewedPlan?.networkName ||
    result.n8nContainerName !== reviewedPlan?.n8nContainerName ||
    result.hostPublication !== "none" ||
    typeof result.clientKey !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(result.clientKey) ||
    result.credentialShownOnce !== true ||
    result.deploymentMode !== "installed"
  ) {
    throw Object.assign(
      new Error("The local n8n SuperGrok installer returned an invalid result."),
      { statusCode: 502 },
    );
  }
  return {
    target: LOCAL_N8N_SUPERGROK_TARGET,
    endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT,
    baseUrl: LOCAL_N8N_SUPERGROK_ENDPOINT,
    protocol: "openai-chat-completions",
    networkName: requireSafeDockerName(
      result.networkName,
      "SuperGrok network name",
    ),
    n8nContainerName: requireSafeDockerName(
      result.n8nContainerName,
      "n8n container name",
    ),
    hostPublication: "none",
    clientCredential: result.clientKey,
    credentialShownOnce: true,
    deploymentMode: "installed",
    models: ["grok-build"],
  };
}

function createSafeLocalN8nSuperGrokStatus(result) {
  if (
    result?.target !== LOCAL_N8N_SUPERGROK_TARGET ||
    typeof result.managed !== "boolean" ||
    !["absent", "healthy", "unavailable"].includes(result.state) ||
    (result.state === "healthy" ? result.managed !== true : result.managed !== false)
  ) {
    throw Object.assign(
      new Error("The local n8n SuperGrok status is invalid."),
      { statusCode: 502 },
    );
  }
  if (result.state !== "healthy") {
    return {
      target: LOCAL_N8N_SUPERGROK_TARGET,
      managed: false,
      state: result.state,
      snapshot: null,
    };
  }
  let snapshot;
  try {
    snapshot = createSafeDashboardSnapshot(
      LOCAL_N8N_SUPERGROK_TARGET,
      result.snapshot,
    );
  } catch {
    throw Object.assign(
      new Error("The local n8n SuperGrok status is invalid."),
      { statusCode: 502 },
    );
  }
  return {
    target: LOCAL_N8N_SUPERGROK_TARGET,
    managed: true,
    state: "healthy",
    snapshot,
  };
}

function createSafeLocalN8nSuperGrokRemovalResult(result) {
  if (
    result?.target !== LOCAL_N8N_SUPERGROK_TARGET ||
    result.removed !== true
  ) {
    throw Object.assign(
      new Error("The local n8n SuperGrok removal result is invalid."),
      { statusCode: 502 },
    );
  }
  return { target: LOCAL_N8N_SUPERGROK_TARGET, removed: true };
}

function createSafeLocalN8nRemovalResult(result) {
  if (
    result?.target !== LOCAL_N8N_SIDECAR_TARGET ||
    result.removed !== true
  ) {
    throw Object.assign(
      new Error("The local n8n sidecar removal result is invalid."),
      { statusCode: 502 },
    );
  }
  return {
    target: result.target,
    removed: true,
  };
}

const MODEL_INSTALL_STATES = new Set(["absent", "unavailable", "partial", "runtime-ready", "downloading", "model-ready", "model-error"]);
const MODEL_PROGRESS_STATES = new Set(["downloading", "verifying", "model-ready", "model-error"]);

function createSafeLocalModelStatus(result) {
  if (result?.target !== LOCAL_N8N_MODEL_TARGET || !MODEL_INSTALL_STATES.has(result.status) ||
    typeof result.managed !== "boolean" ||
    (["absent", "unavailable"].includes(result.status) ? result.managed !== false : result.managed !== true)) {
    throw Object.assign(new TypeError("The local model status is invalid."), { statusCode: 502 });
  }
  const base = {
    target: LOCAL_N8N_MODEL_TARGET, managed: result.managed, status: result.status,
    installId: null, modelId: null, modelDigest: null, endpoint: null,
    networkName: null, containerName: null, resourceBudget: null,
    operationId: null, progress: null, reason: null,
  };
  if (result.status === "absent" || result.status === "unavailable") return base;
  if (result.status === "partial") return { ...base, managed: true };
  if (result.endpoint !== LOCAL_N8N_MODEL_ENDPOINT ||
    !/^[a-f0-9-]{16,64}$/iu.test(result.installId) ||
    (result.modelDigest !== null && !/^[a-f0-9]{64}$/u.test(result.modelDigest)) ||
    (result.status === "model-ready" && !result.modelDigest)) {
    throw Object.assign(new TypeError("The installed model identity is invalid."), { statusCode: 502 });
  }
  const budget = safeModelBudget(result.resourceBudget);
  let progress = null;
  if (result.progress !== null) {
    if (!MODEL_PROGRESS_STATES.has(result.progress?.status) ||
      (result.progress.completed !== null && (!Number.isSafeInteger(result.progress.completed) || result.progress.completed < 0)) ||
      (result.progress.total !== null && (!Number.isSafeInteger(result.progress.total) || result.progress.total < 0)) ||
      (result.progress.total !== null && result.progress.completed !== null && result.progress.completed > result.progress.total)) {
      throw Object.assign(new TypeError("The model transfer status is invalid."), { statusCode: 502 });
    }
    progress = { status: result.progress.status, completed: result.progress.completed, total: result.progress.total };
  }
  if (result.operationId !== null && !/^[a-f0-9]{32}$/u.test(result.operationId)) {
    throw Object.assign(new TypeError("The model operation identity is invalid."), { statusCode: 502 });
  }
  return {
    ...base, installId: result.installId, modelId: requireCatalogModel(result.modelId),
    modelDigest: result.modelDigest, endpoint: LOCAL_N8N_MODEL_ENDPOINT,
    networkName: requireSafeDockerName(result.networkName, "model network name"),
    containerName: requireSafeDockerName(result.containerName, "n8n container name"),
    resourceBudget: budget, operationId: result.operationId, progress,
  };
}

function createSafeVpsLocalModelStatus(result) {
  if (!MODEL_INSTALL_STATES.has(result?.state)) {
    throw Object.assign(new TypeError("The VPS model status is invalid."), { statusCode: 502 });
  }
  if (result.state === "absent" || result.state === "unavailable") {
    return { state: result.state, installId: null, modelId: null, endpoint: null, operation: null,
      ...(result.removed === true && result.modelCacheDeleted === true ? { removed: true, modelCacheDeleted: true } : {}) };
  }
  if (!/^[a-f0-9-]{16,64}$/iu.test(result.installId) ||
    result.endpoint !== LOCAL_N8N_MODEL_ENDPOINT ||
    !["string", "undefined"].includes(typeof result.containerId) ||
    !["string", "undefined"].includes(typeof result.networkId)) {
    throw Object.assign(new TypeError("The VPS model identity is invalid."), { statusCode: 502 });
  }
  const operation = result.operation;
  let safeOperation = null;
  if (operation !== null && operation !== undefined) {
    if (!["downloading", "verifying", "model-ready", "model-error", "partial"].includes(operation.state) ||
      !["download", "inference", "complete", "error", "unknown"].includes(operation.phase) ||
      typeof operation.writerMayBeActive !== "boolean" ||
      (operation.completedBytes !== null && (!Number.isSafeInteger(operation.completedBytes) || operation.completedBytes < 0)) ||
      (operation.totalBytes !== null && (!Number.isSafeInteger(operation.totalBytes) || operation.totalBytes < 0)) ||
      (operation.totalBytes !== null && operation.completedBytes !== null && operation.completedBytes > operation.totalBytes) ||
      (operation.modelDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(operation.modelDigest)) ||
      (operation.errorCode !== null && !/^[a-z][a-z0-9_-]{0,63}$/u.test(operation.errorCode))) {
      throw Object.assign(new TypeError("The VPS model progress is invalid."), { statusCode: 502 });
    }
    safeOperation = {
      state: operation.state, phase: operation.phase, completedBytes: operation.completedBytes,
      totalBytes: operation.totalBytes, modelDigest: operation.modelDigest,
      errorCode: operation.errorCode, writerMayBeActive: operation.writerMayBeActive,
    };
  }
  if (result.state === "model-ready" && safeOperation?.state !== "model-ready") {
    throw Object.assign(new TypeError("The VPS model inference is not verified."), { statusCode: 502 });
  }
  return {
    state: result.state, installId: result.installId, modelId: requireCatalogModel(result.modelId),
    endpoint: LOCAL_N8N_MODEL_ENDPOINT, operation: safeOperation,
  };
}

function createSafeLocalModelActionReview(review, reviewId) {
  if (!["retry", "remove"].includes(review?.action) ||
    !/^[a-f0-9-]{16,64}$/iu.test(review.installId) ||
    review.endpoint !== LOCAL_N8N_MODEL_ENDPOINT ||
    review.removeModelData !== (review.action === "remove") ||
    (review.modelDigest !== null && !/^[a-f0-9]{64}$/u.test(review.modelDigest)) ||
    (review.operationId !== null && !/^[a-f0-9]{32}$/u.test(review.operationId))) {
    throw Object.assign(new TypeError("The reviewed model action is invalid."), { statusCode: 502 });
  }
  return {
    reviewId, action: review.action, installId: review.installId,
    modelId: requireCatalogModel(review.modelId), endpoint: LOCAL_N8N_MODEL_ENDPOINT,
    modelDigest: review.modelDigest,
    networkName: requireSafeDockerName(review.networkName, "model network name"),
    containerName: requireSafeDockerName(review.containerName, "n8n container name"),
    resourceBudget: safeModelBudget(review.resourceBudget),
    removeModelData: review.removeModelData,
  };
}

function requireLiveLocalAction(state, action) {
  if (state.previewMode) {
    throw Object.assign(
      new Error(`${action} is disabled in sanitized preview mode.`),
      { statusCode: 403 },
    );
  }
}

function localOAuthChangeInFlight(state) {
  return oauthCredentialChangeInFlight(state);
}

function requireCurrentLocalDashboardGeneration(state, generation) {
  if (state.localDashboardGeneration !== generation) {
    throw Object.assign(
      new Error(
        "The local dashboard changed while this request was in progress. Try again.",
      ),
      { statusCode: 409 },
    );
  }
}

function requireExactRequestBody(body, names, message) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== names.length ||
    names.some((name) => !Object.hasOwn(body, name))
  ) {
    throw new Error(message);
  }
}

function requireOAuthLocalEndpointPlanBody(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((name) => !["target", "port"].includes(name))
  ) {
    throw new Error("The OAuth local endpoint plan request is invalid.");
  }
}

function requireExactLocalPlanBody(body, names, message) {
  requireExactRequestBody(body, names, message);
}

function requireLocalInstallBody(plan, body) {
  if (plan?.kind === "local-n8n-stack") {
    requireExactRequestBody(
      body,
      [
        "planId",
        "confirmed",
        "ngrokAuthtoken",
        "basicAuthUsername",
        "basicAuthPassword",
      ],
      "The local n8n + ngrok install request is invalid.",
    );
    return;
  }
  requireExactRequestBody(
    body,
    plan?.kind === "n8n-sidecar"
      ? ["planId", "confirmed", "backgroundConsent",
          ...(plan.migrationRequired ? ["migrationConsent"] : []),
          ...(plan.replacementRequired ? ["replacementConsent"] : [])]
      : ["planId", "confirmed",
          ...(plan?.migrationRequired ? ["migrationConsent"] : []),
          ...(plan?.replacementRequired ? ["replacementConsent"] : [])],
    plan?.kind === "n8n-sidecar"
      ? "The local n8n SIWC install request is invalid."
      : plan?.kind === "n8n-assistant"
        ? "The local n8n Assistant install request is invalid."
        : plan?.kind === "n8n-supergrok"
          ? "The local n8n SuperGrok install request is invalid."
          : plan?.kind === LOCAL_N8N_MODEL_TARGET
            ? "The local model install request is invalid."
            : "The OAuth local endpoint install request is invalid.",
  );
}

async function requireReadyLocalChatTester(state) {
  let status;
  try {
    status = await state.services.getManagedLocalEndpointStatus({ target: "codex-chat" });
  } catch {
    // An ambiguous installation cannot own a browser test session.
  }
  const account = status?.snapshot?.auth?.account;
  if (status?.managed === true && status.state === "healthy" &&
      status.snapshot?.target === "codex-chat" &&
      status.snapshot?.migrationRequired === false &&
      status.snapshot.auth.configured === true &&
      account?.registrationId === status.snapshot.registrationId &&
      account.ownership === "owned" && account.session === "connected" &&
      account.planPermission === "granted" && account.planEnabled === true) {
    return copySiwcAccountView(account);
  }
  throw Object.assign(new Error("Connect an owned ChatGPT plan to the Codex Chat Adapter before testing."),
    { statusCode: 409, recovery: "review-again" });
}

async function handleApi(request, response, path, state) {
  requireApiToken(request, state);
  requireSameOrigin(request, state);

  if (path === "/api/ui/preferences" && request.method === "GET") {
    sendJson(response, 200, await state.services.readUiPreferences({ storageRoot: state.storageRoot }));
    return;
  }
  if (path === "/api/ui/preferences" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!exactObjectKeys(body, ["guide"]) || !["on", "off"].includes(body.guide)) {
      throw Object.assign(new Error("Guide preference is invalid."), { statusCode: 400 });
    }
    await state.services.writeUiPreferences({ storageRoot: state.storageRoot, preferences: body });
    sendJson(response, 200, { guide: body.guide });
    return;
  }

  if (request.method === "GET" && path === "/api/hosting/providers") {
    sendJson(response, 200, {
      providers: HOSTING_PROVIDERS,
      profiles: getHostingDeploymentProfiles(),
      models: LOCAL_MODEL_CATALOG,
    });
    return;
  }
  if (request.method === "GET" && path === "/api/ssh/capabilities") {
    const capability = await state.services.getSshCapabilities();
    const agent = capability?.agent;
    sendJson(response, 200, { agent: {
      status: agent?.status === "configured" ? "configured" : "unavailable",
      transport: ["unix-socket", "windows-openssh-pipe"].includes(agent?.transport) ? agent.transport : null,
      verification: "untested",
    } });
    return;
  }
  if (request.method === "GET" && path === "/api/ssh/connection") {
    // No session is an expected state on every route load, not a failure.
    if (!state.connection) {
      sendJson(response, 200, { connected: false });
      return;
    }
    if (!state.connectionIdentity) throw new Error("Reconnect to verify the VPS identity.");
    sendJson(response, 200, state.connectionIdentity);
    return;
  }
  if (credentialBearingVpsRoute(path)) {
    rejectActiveVpsMutation(state);
    requireFullVpsScope(requireConnection(state));
  }

  if (request.method === "GET" && path === "/api/siwc/accounts") {
    const registrations = await state.services.listAuthRegistrations({ storageRoot: state.storageRoot });
    const accounts = await Promise.all(registrations.filter((item) => item.identity === "verified")
      .map(async (item) => {
        const account = copySiwcAccountView(item);
        if (account.ownership !== "owned" || account.session !== "connected") return account;
        let hostReady = false;
        try {
          const status = await state.services.getAuthStatus({
            storageRoot: state.storageRoot, registrationId: account.registrationId, runtimeId: state.runtimeId,
          });
          hostReady = status?.exists === true && status.generation === account.generation &&
            status.ownerHostId === account.ownerHostId && status.ownerRuntimeId === account.ownerRuntimeId;
        } catch {
          // Invalid or foreign protected records remain visible, never usable.
        }
        return { ...account, hostReady };
      }));
    const pendingRegistrations = registrations.filter((item) => item.identity === "unverified")
      .map((item) => ({ registrationId: requireSiwcId(item.registrationId),
        label: typeof item.label === "string" && item.label.length <= 160 ? item.label : "ChatGPT sign-in pending" }));
    const selected = await state.services.getSelectedRegistration({ storageRoot: state.storageRoot });
    sendJson(response, 200, {
      accounts, pendingRegistrations,
      selectedRegistrationId: accounts.some((account) => account.registrationId === selected) ? selected : null,
      ...(state.previewMode ? { previewMode: true } : {}),
      ...(state.previewFixture ? { previewFixture: state.previewFixture } : {}),
    });
    return;
  }

  if (request.method === "GET" && path === "/api/oauth/status") {
    const login = state.oauthLogin;
    const { status: failureStatus, ...failure } = login?.failure ?? {};
    sendJson(response, 200, {
      status: login?.status ?? (state.oauthStartupError ? "error" : "idle"),
      ...(login ? { attemptId: login.attemptId } : {}),
      ...(login?.status === "error"
        ? { ...failure, ...(failureStatus ? { upstreamStatus: failureStatus } : {}) }
        : state.oauthStartupError
          ? { error: state.oauthStartupError }
          : {}),
      ...(login?.status === "success" ? { account: copySiwcAccountView(login.account) } : {}),
      ...(state.oauthRetryBlocked || login?.retryBlocked === true
        ? { retryBlocked: true }
        : {}),
    });
    return;
  }

  if (request.method === "GET" && path === "/api/local/dashboard") {
    const localDashboardGeneration = state.localDashboardGeneration;
    const status = state.previewMode
      ? null
      : await state.services.getLocalDashboardStatus({
          inspectLocalN8nStack: state.services.getLocalN8nStackStatus,
          inspectLocalN8nSuperGrok: state.services.getLocalN8nSuperGrokStatus,
          inspectLocalN8nModel: state.services.getLocalN8nModelStatus,
        });
    requireCurrentLocalDashboardGeneration(state, localDashboardGeneration);
    sendJson(
      response,
      200,
      createSafeLocalDashboardStatus(status, state.previewMode, state.previewFixture),
    );
    return;
  }

  if (request.method === "GET" && path === "/api/local/supergrok/status") {
    const localDashboardGeneration = state.localDashboardGeneration;
    const status = state.previewMode
      ? {
          target: LOCAL_N8N_SUPERGROK_TARGET,
          managed: false,
          state: "absent",
        }
      : await state.services.getLocalN8nSuperGrokStatus();
    requireCurrentLocalDashboardGeneration(state, localDashboardGeneration);
    sendJson(response, 200, createSafeLocalN8nSuperGrokStatus(status));
    return;
  }

  if (request.method === "GET" && (path === "/api/local/model/status" || path === "/api/local/model/operation")) {
    const generation = state.localDashboardGeneration;
    const result = state.previewMode
      ? { target: LOCAL_N8N_MODEL_TARGET, managed: false, status: "absent" }
      : await state.services.getLocalN8nModelStatus();
    requireCurrentLocalDashboardGeneration(state, generation);
    sendJson(response, 200, createSafeLocalModelStatus(result));
    return;
  }

  if (request.method === "GET" && path === "/api/local/usage/status") {
    const generation = state.localDashboardGeneration;
    // Read-only. Sanitized preview shows no counts; the sidecar's record becomes the bounded view here.
    const record = state.previewMode ? null : await state.services.getLocalN8nSidecarUsage();
    requireCurrentLocalDashboardGeneration(state, generation);
    sendJson(response, 200, usageView(record));
    return;
  }

  if (request.method === "GET" && path === "/api/siwc/models") {
    requireLiveLocalAction(state, "ChatGPT model discovery");
    if (oauthCredentialChangeInFlight(state)) {
      throw Object.assign(new Error("Wait for ChatGPT sign-in to finish."), { statusCode: 409 });
    }
    const account = await selectedSiwcAccount(state, { requirePlan: true });
    const models = await state.services.listSiwcModels({
      storageRoot: state.storageRoot, registrationId: account.registrationId, runtimeId: state.runtimeId,
    });
    // Token refresh inside listSiwcModels rotates `generation`; the re-read below
    // still re-validates ownership, connection and plan use for this registration.
    const latest = await selectedSiwcAccount(state, { requirePlan: true });
    if (latest.registrationId !== account.registrationId) {
      throw Object.assign(new Error("The selected ChatGPT account changed. Refresh it."), { statusCode: 409 });
    }
    if (!Array.isArray(models) ||
        models.some((model) => typeof model?.slug !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(model.slug) ||
          typeof model.display_name !== "string" || model.display_name.length > 256)) {
      throw Object.assign(new Error("The account model catalog could not be verified."), { statusCode: 409 });
    }
    sendJson(response, 200, { models, account: latest });
    return;
  }

  if (request.method === "GET" && path === "/api/local/docker/status") {
    const status = state.previewMode
      ? null
      : await state.services.getLocalDockerStatus();
    let localN8nStackState = null;
    if (!state.previewMode && status?.dockerAvailable === true) {
      try {
        const managedStatus = await state.services.getLocalN8nStackStatus();
        if (
          managedStatus?.managed === true &&
          ["healthy", "stopped", "partial"].includes(managedStatus.state)
        ) {
          localN8nStackState = managedStatus.state;
        } else if (
          managedStatus?.managed === false &&
          managedStatus.state === "unavailable"
        ) {
          localN8nStackState = "unavailable";
        }
      } catch {
        // Docker readiness remains useful when managed-stack detection fails closed.
      }
    }
    sendJson(
      response,
      200,
      createSafeDockerStatus(
        status,
        state.previewMode,
        localN8nStackState,
      ),
    );
    return;
  }

  if (request.method === "GET" && path === "/api/local/n8n/discover") {
    const localDashboardGeneration = state.localDashboardGeneration;
    const discovery = state.previewMode
      ? null
      : await state.services.discoverLocalN8nSidecarTargets();
    requireCurrentLocalDashboardGeneration(state, localDashboardGeneration);
    state.localPlan = null;
    sendJson(
      response,
      200,
      createSafeLocalN8nDiscovery(discovery, state.previewMode),
    );
    return;
  }

  if (request.method === "GET" && path === "/api/local/project-meta") {
    sendJson(
      response,
      200,
      createSafeProjectMeta(await state.services.getProjectMeta()),
    );
    return;
  }


  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (path === "/api/oauth/login") {
    const loginBody = await readJsonBody(request);
    if (!loginBody || typeof loginBody !== "object" || Array.isArray(loginBody) ||
        Object.keys(loginBody).some((key) => !["purpose", "registrationId"].includes(key)) ||
        !["sign-in", "enable-plan"].includes(loginBody.purpose) ||
        (loginBody.registrationId !== undefined && typeof loginBody.registrationId !== "string")) {
      throw invalidSiwcRequest();
    }
    const registrationId = loginBody.registrationId === undefined
      ? undefined : requireSiwcId(loginBody.registrationId);
    if (loginBody.purpose === "enable-plan") {
      const selected = await selectedSiwcAccount(state);
      if (registrationId !== selected.registrationId) throw invalidSiwcRequest();
    } else if (registrationId !== undefined) {
      const accounts = await state.services.listAuthRegistrations({ storageRoot: state.storageRoot });
      if (!accounts.some((account) => account.registrationId === registrationId &&
          account.ownership === "owned")) throw invalidSiwcRequest();
    }
    if (state.previewMode) {
      throw Object.assign(
        new Error(
          "Live ChatGPT sign-in is disabled in sanitized preview mode.",
        ),
        { statusCode: 403 },
      );
    }
    if (state.closing) {
      throw Object.assign(new Error("The local wizard is closing."), {
        statusCode: 409,
      });
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    if (
      state.vpsMutationInFlight ||
      state.vpsCredentialOperation !== null ||
      state.vpsConnectionOperation !== null
    ) {
      throw Object.assign(new Error(VPS_OAUTH_CONFLICT_MESSAGE), {
        statusCode: 409,
      });
    }
    if (state.oauthRetryBlocked || state.oauthLogin?.retryBlocked === true) {
      throw Object.assign(
        new Error(
          "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
        ),
        { retryBlocked: true, statusCode: 409 },
      );
    }
    if (state.oauthLoginStartInFlight) {
      throw Object.assign(
        new Error("A ChatGPT sign-in start is already in progress."),
        { statusCode: 409 },
      );
    }
    enforceRateLimit(state, path);
    state.oauthLoginStartInFlight = true;
    state.oauthStartupError = null;
    let startAttempted = false;
    let startPromise;
    let credentialOperation;
    let operationTransferred = false;
    try {
      const previousLogin = state.oauthLogin;
      if (previousLogin?.status === "pending") {
        setOAuthCredentialOperationPhase(
          state,
          previousLogin.credentialOperation,
          "cancelling-for-replacement",
        );
        await cancelOAuthLogin(state, previousLogin);
      }

      if (state.closing) {
        throw Object.assign(new Error("The local wizard is closing."), {
          statusCode: 409,
        });
      }
      if (
        state.oauthLogin === previousLogin &&
        previousLogin?.status !== "pending" &&
        previousLogin?.retryBlocked !== true
      ) {
        state.oauthLogin = null;
      }
      credentialOperation = beginOAuthCredentialOperation(state);
      startAttempted = true;
      startPromise = Promise.resolve(state.services.startOAuthLogin({
        storageRoot: state.storageRoot, registrationId, purpose: loginBody.purpose,
        runtimeId: state.runtimeId,
      }));
      state.oauthLoginStartPromise = startPromise;
      const attempt = await startPromise;
      if (
        attempt?.launchMode !== "system-browser" ||
        typeof attempt?.completion?.then !== "function" ||
        typeof attempt?.cancel !== "function"
      ) {
        try {
          await attempt?.cancel?.();
        } catch {
          // The invalid helper result is already unusable; keep its details private.
        }
        throw Object.assign(
          new Error("The ChatGPT sign-in helper returned an invalid result."),
          { statusCode: 500 },
        );
      }
      const login = {
        attempt,
        attemptId: randomUUID(),
        error: null,
        retryBlocked: false,
        status: "pending",
        credentialOperation,
      };
      state.oauthLogin = login;
      operationTransferred = true;
      setOAuthCredentialOperationPhase(
        state,
        credentialOperation,
        "pending-or-committing",
      );
      void Promise.resolve(attempt.completion)
        .then(
          async (account) => {
            if (state.oauthLogin !== login || login.status !== "pending" || state.closing) return;
            if (account?.identity !== "verified" || typeof account.registrationId !== "string" ||
                (registrationId !== undefined && account.registrationId !== registrationId)) {
              throw new Error("ChatGPT identity could not be verified.");
            }
            await state.services.selectRegistration({
              storageRoot: state.storageRoot, registrationId: account.registrationId,
            });
            if (state.oauthLogin === login && login.status === "pending" && !state.closing) {
              invalidateSiwcWork(state);
              login.account = account;
              login.status = "success";
            }
          },
        )
        .catch((error) => {
          if (state.oauthLogin === login && login.status === "pending" && !state.closing) {
            login.status = "error";
            login.failure = { ...safeFailure(error), phase: "authorize",
              ...(typeof error?.registrationId === "string" &&
                /^[A-Za-z0-9_-]{8,128}$/u.test(error.registrationId)
                ? { registrationId: error.registrationId } : {}) };
            login.error = login.failure.error;
            if (error?.retryBlocked === true) {
              login.retryBlocked = true;
              state.oauthRetryBlocked = true;
              state.oauthStartupError = login.error;
            }
          }
        })
        .finally(() => {
          releaseOAuthCredentialOperation(state, credentialOperation);
        });
      if (state.closing) {
        try {
          await cancelOAuthLogin(state, login);
        } catch {
          // The server is already closing and must not restart this helper.
        }
        throw Object.assign(new Error("The local wizard is closing."), {
          statusCode: 409,
        });
      }
      sendJson(response, 200, {
        launchMode: attempt.launchMode,
        attemptId: login.attemptId,
      });
      return;
    } catch (error) {
      const message = safeErrorMessage(error);
      if (startAttempted) {
        state.oauthStartupError = message;
      }
      if (error?.retryBlocked === true) {
        state.oauthRetryBlocked = true;
        state.oauthStartupError = message;
      }
      if (!operationTransferred) {
        releaseOAuthCredentialOperation(state, credentialOperation);
      }
      throw error;
    } finally {
      if (state.oauthLoginStartPromise === startPromise) {
        state.oauthLoginStartPromise = null;
      }
      state.oauthLoginStartInFlight = false;
    }
  }

  const body = await readJsonBody(request);
  // Body parsing yields: a different authenticated connection may now own the session.
  if (credentialBearingVpsRoute(path)) {
    rejectActiveVpsMutation(state);
    requireFullVpsScope(requireConnection(state));
  }

  if (["/api/siwc/select", "/api/siwc/plan", "/api/siwc/ack", "/api/siwc/logout"].includes(path)) {
    requireLiveLocalAction(state, "ChatGPT account changes");
    enforceRateLimit(state, path);
    if (oauthCredentialChangeInFlight(state) || state.localInstallInFlight ||
        state.localCredentialRotationInFlight || state.vpsMutationInFlight ||
        state.vpsCredentialOperation !== null || state.vpsConnectionOperation !== null) {
      throw Object.assign(new Error("Wait for the current ChatGPT or installation action to finish."), { statusCode: 409 });
    }
    const registrationId = requireSiwcId(body?.registrationId);
    const registration = { storageRoot: state.storageRoot, registrationId };
    const accounts = await state.services.listAuthRegistrations({ storageRoot: state.storageRoot });
    const account = accounts.find((item) => item.registrationId === registrationId);
    if (!account || account.identity !== "verified" || account.ownership !== "owned") throw invalidSiwcRequest();
    if (path === "/api/siwc/select") {
      requireExactRequestBody(body, ["registrationId"], "Select one ChatGPT account.");
      if (account.session === "connected" && account.ownership === "owned") {
        const owned = await state.services.getAuthStatus({
          storageRoot: state.storageRoot, registrationId, runtimeId: state.runtimeId,
        });
        if (owned?.exists !== true || owned.generation !== account.generation) {
          throw Object.assign(new Error("This account is not owned by this computer."), { statusCode: 409 });
        }
      }
      await state.services.selectRegistration(registration);
      invalidateSiwcWork(state);
      sendJson(response, 200, { account: copySiwcAccountView(account), selectedRegistrationId: registrationId });
      return;
    }
    if (path === "/api/siwc/plan") {
      requireExactRequestBody(body, ["registrationId", "enabled", "expectedGeneration"], "The plan preference request is invalid.");
      if (typeof body.enabled !== "boolean" || body.expectedGeneration !== account.generation ||
          account.ownership !== "owned" || account.session !== "connected" ||
          await state.services.getSelectedRegistration({ storageRoot: state.storageRoot }) !== registrationId) {
        throw Object.assign(new Error("The selected account changed. Choose it again."), { statusCode: 409 });
      }
      const updated = await state.services.setPlanEnabled(registration, {
        enabled: body.enabled, expectedGeneration: body.expectedGeneration,
      });
      invalidateSiwcWork(state);
      sendJson(response, 200, { account: copySiwcAccountView(updated) });
      return;
    }
    if (path === "/api/siwc/ack") {
      requireExactRequestBody(body, ["registrationId", "expectedGeneration"], "The plan confirmation request is invalid.");
      if (account.generation !== body.expectedGeneration || account.planEnabled !== true ||
          account.planPermission !== "granted" || account.session !== "connected" ||
          account.ownership !== "owned" ||
          await state.services.getSelectedRegistration({ storageRoot: state.storageRoot }) !== registrationId) {
        throw Object.assign(new Error("The selected plan changed. Check it again."), { statusCode: 409 });
      }
      const updated = await state.services.acknowledgePlanUse(registration, {
        expectedGeneration: body.expectedGeneration,
      });
      invalidateSiwcWork(state);
      sendJson(response, 200, { account: copySiwcAccountView(updated) });
      return;
    }
    if (path === "/api/siwc/logout") {
      requireExactRequestBody(body, ["registrationId", "expectedGeneration"], "The sign-out request is invalid.");
      if (account.generation !== body.expectedGeneration ||
          await state.services.getSelectedRegistration({ storageRoot: state.storageRoot }) !== registrationId) {
        throw Object.assign(new Error("The selected account changed. Choose it again."), { statusCode: 409 });
      }
      const result = await state.services.signOut(registration, { runtimeId: state.runtimeId });
      invalidateSiwcWork(state);
      if (!["confirmed", "unconfirmed", "not-applicable"].includes(result?.revocation)) {
        throw Object.assign(new Error("Provider revocation could not be verified."), { statusCode: 502 });
      }
      sendJson(response, 200, {
        account: copySiwcAccountView(result.account), revocation: result.revocation,
        ...(result.revocation === "unconfirmed"
          ? { cleanup: "Local credentials cleared. Revocation could not be confirmed. Disconnect Relmio in ChatGPT settings." }
          : {}),
      });
      return;
    }
  }

  if (path === "/api/hosting/plan") {
    try {
      sendJson(response, 200, state.services.prepareHostingDeploymentPlan(body));
    } catch {
      throw Object.assign(new Error("The hosting plan request is invalid."), { statusCode: 400 });
    }
    return;
  }

  if (["/api/local/siwc/recovery/review", "/api/local/siwc/recovery/reconcile",
      "/api/siwc/vps/recovery/review", "/api/siwc/vps/recovery/reconcile"].includes(path)) {
    requireLiveLocalAction(state, "ChatGPT installation recovery");
    enforceRateLimit(state, path);
    const vps = path.startsWith("/api/siwc/vps/");
    const reviewing = path.endsWith("/review");
    const freshN8nTarget = reviewing && !vps && body?.target === LOCAL_N8N_SIDECAR_TARGET &&
      body.action === "resume" && (body.n8nContainerId !== undefined || body.dockerNetworkId !== undefined);
    requireExactRequestBody(body, reviewing
      ? vps ? ["containerName", "networkName", "registrationId", "action"]
        : ["target", "registrationId", "action", ...(freshN8nTarget ? ["n8nContainerId", "dockerNetworkId"] : [])]
      : ["reviewId", "confirmed"], "Review this exact installation before confirming recovery.");
    if (freshN8nTarget && (!/^[a-f0-9]{64}$/u.test(body.n8nContainerId ?? "") ||
        !/^[a-f0-9]{64}$/u.test(body.dockerNetworkId ?? ""))) throw invalidSiwcRequest();
    if (state.localInstallInFlight || state.localCredentialRotationInFlight ||
        getPendingLocalCredentialRotation(state) || oauthCredentialChangeInFlight(state) ||
        state.vpsMutationInFlight || state.vpsCredentialOperation || state.vpsConnectionOperation) {
      throw Object.assign(new Error("An account or installation change is in progress."), { statusCode: 409 });
    }
    const pending = state.siwcRecoveryReview;
    if (!reviewing && (body.confirmed !== true || !pending || pending.vps !== vps ||
        pending.expiresAt <= Date.now() || !tokenMatches(body.reviewId, pending.reviewId))) {
      throw Object.assign(new Error("Review and confirm this transfer recovery again."), { statusCode: 409 });
    }
    const target = vps ? LOCAL_N8N_SIDECAR_TARGET : reviewing ? body.target : pending.target;
    if (!["codex-chatgpt", "codex-chat", LOCAL_N8N_SIDECAR_TARGET].includes(target) ||
        (reviewing && !["resume", "reconcile"].includes(body.action))) throw invalidSiwcRequest();
    const connectionUse = vps ? acquireVpsConnectionUse(state) : null;
    let operation;
    let releaseMutation;
    if (!vps) state.localInstallInFlight = true;
    try {
      let reviewedTarget;
      if (vps) {
        requireFullVpsScope(connectionUse.connection);
        if (reviewing) {
          requireDiscoveredNetwork(state, body.containerName, body.networkName);
          operation = acquireVpsCredentialOperation(state, "recovery-review");
          reviewedTarget = Object.freeze({ ...state.connectionIdentity,
            containerName: body.containerName, networkName: body.networkName,
            ...await state.services.reviewVpsSiwcTarget({
              remote: connectionUse.connection, containerName: body.containerName, networkName: body.networkName,
            }) });
        } else {
          reviewedTarget = pending.reviewedTarget;
          if (!["host", "port", "fingerprint", "username", "authentication", "privilege",
            "loginUid", "effectiveUid"].every((key) => reviewedTarget[key] === state.connectionIdentity[key])) {
            throw Object.assign(new Error("Reconnect to the reviewed VPS identity."), { statusCode: 409 });
          }
          releaseMutation = acquireVpsMutationLock(state);
        }
      }
      if (reviewing) {
        state.siwcRecoveryReview = null;
        const account = await recoveryAccount(state, body.registrationId, { pending: body.action === "reconcile" });
        const sourceBinding = await siwcBinding(state, account);
        if (body.action === "reconcile") {
          const reviewId = randomUUID();
          state.siwcRecoveryReview = { reviewId, vps, target, sourceBinding, reviewedTarget,
            expiresAt: Date.now() + 5 * 60_000 };
          sendJson(response, 200, { reviewId, action: "reconcile", target, account,
            ...(vps ? { destination: { n8nContainerId: reviewedTarget.n8nContainerId,
              networkId: reviewedTarget.networkId } } : {}) });
        } else {
          let freshPlan;
          if (freshN8nTarget) {
            const discovery = await state.services.discoverLocalN8nSidecarTargets();
            const container = discovery?.dockerAvailable === true && discovery.containers?.find(
              (item) => item.containerId === body.n8nContainerId);
            const network = container && container.networks?.find(
              (item) => item.dockerNetworkId === body.dockerNetworkId);
            if (!container || !network) {
              throw Object.assign(new Error("Refresh n8n discovery and select its attached network before reviewing resume."),
                { statusCode: 409, recovery: "review-again" });
            }
            freshPlan = state.services.prepareLocalN8nSidecarPlan({
              dockerHost: discovery.dockerHost, n8nContainerId: container.containerId,
              n8nContainerName: container.containerName, dockerNetworkId: network.dockerNetworkId,
              networkName: network.networkName, authBinding: sourceBinding,
            });
          }
          const resume = vps
            ? await state.services.reviewVpsSiwcResume({ remote: connectionUse.connection,
                networkName: reviewedTarget.networkName, reviewedTarget, registrationId: account.registrationId })
            : target === LOCAL_N8N_SIDECAR_TARGET
              ? await state.services.reviewLocalN8nSiwcResume({ registration: {
                  storageRoot: state.storageRoot, registrationId: account.registrationId },
                  ...(freshPlan ? { plan: freshPlan } : {}) })
              : await state.services.reviewLocalSiwcResume({ target, registration: {
                  storageRoot: state.storageRoot, registrationId: account.registrationId } });
          const staging = copySiwcStaging(resume);
          if (staging.registrationId !== account.registrationId) throw invalidSiwcRequest();
          const planId = randomUUID();
          if (vps) {
            if (!["installed", "migrated", "replaced"].includes(resume.deploymentMode)) {
              throw Object.assign(new Error("The reviewed resume deployment mode is invalid."), { statusCode: 502 });
            }
            state.sidecarPlan = { planId, containerName: reviewedTarget.containerName,
              networkName: reviewedTarget.networkName, reviewedTarget, authBinding: sourceBinding,
              account, resume, sourceBinding };
            sendJson(response, 200, { planId, installDirectory: "/docker/n8n-openai-oauth",
              operationLockPath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock",
              temporaryBuildStatePath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx",
              endpointHostname: SIDECAR_HOSTNAME, containerName: reviewedTarget.containerName,
              networkName: reviewedTarget.networkName, n8nContainerId: reviewedTarget.n8nContainerId,
              networkId: reviewedTarget.networkId, account, resumeRequired: true, staging });
          } else {
            if (resume.plan?.target !== target ||
                resume.plan.authBinding?.registrationId !== account.registrationId) throw invalidSiwcRequest();
            const plan = { ...resume.plan, account, resumeRequired: true, staging };
            state.localPlan = { planId, plan, resume, sourceBinding };
            sendJson(response, 200, { planId, plan: target === LOCAL_N8N_SIDECAR_TARGET
              ? createSafeLocalN8nPlan(plan) : createSafeLocalPlan(plan) });
          }
        }
      } else {
        state.siwcRecoveryReview = null;
        await requireRecoveryBinding(state, pending.sourceBinding, { pending: true });
        const registration = { storageRoot: state.storageRoot, registrationId: pending.sourceBinding.registrationId };
        const result = vps
          ? await state.services.reconcileVpsSiwcHandoff({ remote: connectionUse.connection,
              networkName: reviewedTarget.networkName, reviewedTarget, registration, confirmed: true })
          : target === LOCAL_N8N_SIDECAR_TARGET
            ? await state.services.reconcileLocalN8nSiwcHandoff({ registration, confirmed: true })
            : await state.services.reconcileLocalSiwcHandoff({ target, registration, confirmed: true });
        const account = copySiwcAccountView(result?.account);
        if (!["finished", "not-accepted"].includes(result?.outcome) ||
            account.registrationId !== registration.registrationId ||
            account.ownership !== (result.outcome === "finished" ? "transferred" : "handoff-pending")) {
          throw Object.assign(new Error("Transfer recovery was not confirmed."), { statusCode: 502 });
        }
        invalidateSiwcWork(state);
        sendJson(response, 200, { outcome: result.outcome, account });
      }
    } finally {
      operation?.release();
      if (releaseMutation) {
        detachVpsConnection(state, connectionUse.connection);
        releaseMutation();
      }
      connectionUse?.release();
      if (!vps) state.localInstallInFlight = false;
    }
    return;
  }
  if (path === "/api/local/discard") {
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    state.localDashboardGeneration += 1;
    state.localPlan = null;
    state.localAssistantSearxngReview = null;
    state.localModelActionReview = null;
    state.localCredentialRotationPending = null;
    state.localInstalledTarget = null;
    state.localChatTest.resetAll?.();
    sendJson(response, 200, { discarded: true });
    return;
  }

  if (["/api/local/siwc/manage", "/api/local/n8n/siwc/manage",
      "/api/local/siwc/inspect-stopped", "/api/local/n8n/siwc/inspect-stopped"].includes(path)) {
    requireLiveLocalAction(state, "Installed ChatGPT account management");
    enforceRateLimit(state, path);
    const sidecar = path.startsWith("/api/local/n8n/");
    const inspecting = path.endsWith("/inspect-stopped");
    requireExactRequestBody(body, inspecting
      ? sidecar ? ["registrationId", "confirmed"] : ["target", "registrationId", "confirmed"]
      : sidecar
        ? ["registrationId", "expectedGeneration", "action", "confirmed",
            ...(body?.action === "enable-plan" ? ["backgroundConsent"] : [])]
        : ["target", "registrationId", "expectedGeneration", "action", "confirmed"],
    "Choose the installed account and confirm this owner action.");
    const registrationId = requireSiwcId(body.registrationId);
    const target = sidecar ? "n8n-openai-oauth" : body.target;
    if (body.confirmed !== true ||
        (!sidecar && !["codex-chatgpt", "codex-chat"].includes(target)) ||
        (!inspecting && !["sign-out", "disable-plan", "enable-plan"].includes(body.action)) ||
        (sidecar && body.action === "enable-plan" && body.backgroundConsent !== true)) throw invalidSiwcRequest();
    if (state.localInstallInFlight || state.localCredentialRotationInFlight ||
        oauthCredentialChangeInFlight(state) || getPendingLocalCredentialRotation(state)) {
      throw Object.assign(new Error("An installation or account change is in progress."), { statusCode: 409 });
    }
    state.localInstallInFlight = true;
    try {
      const status = sidecar
        ? await state.services.getLocalN8nSidecarStatus()
        : await state.services.getManagedLocalEndpointStatus({ target });
      if (status?.managed !== true || status.snapshot?.migrationRequired !== false ||
          status.snapshot.registrationId !== registrationId) {
        throw Object.assign(new Error("The installed account changed. Refresh its status."), { statusCode: 409 });
      }
      if (inspecting) {
        if (status.state !== "stopped" || status.snapshot.auth?.account) {
          throw Object.assign(new Error("This owner is not stopped. Refresh its status."), { statusCode: 409 });
        }
        const result = sidecar
          ? await state.services.inspectStoppedLocalN8nSiwcInstallation({ registrationId, confirmed: true })
          : await state.services.inspectStoppedLocalSiwcInstallation({ target, registrationId, confirmed: true });
        const account = copySiwcAccountView(result.account);
        state.localStoppedOwnerReview = { target, account, expiresAt: Date.now() + 5 * 60_000 };
        state.localPlan = null;
        state.localDashboardGeneration += 1;
        state.localChatTest.resetAll?.();
        sendJson(response, 200, { account });
        return;
      }
      const account = status.snapshot.auth?.account;
      const live = status.state === "healthy" && account?.registrationId === registrationId &&
        account.generation === body.expectedGeneration && account.ownership === "owned";
      const review = state.localStoppedOwnerReview;
      const stopped = status.state === "stopped" && !account && review?.target === target &&
        review.account.registrationId === registrationId &&
        review.account.generation === body.expectedGeneration && review.expiresAt > Date.now();
      if (!live && !stopped) {
        throw Object.assign(new Error("The installed session changed. Inspect its owner again."),
          { statusCode: 409, recovery: "review-again" });
      }
      state.localStoppedOwnerReview = null;
      const result = sidecar
        ? await state.services.manageLocalN8nSiwcInstallation({
            registrationId, expectedGeneration: body.expectedGeneration, action: body.action, confirmed: true,
            ...(body.action === "enable-plan" ? { backgroundConsent: true } : {}),
          })
        : await state.services.manageLocalSiwcInstallation({
            target, registrationId, expectedGeneration: body.expectedGeneration,
            action: body.action, confirmed: true,
          });
      invalidateSiwcWork(state);
      if (result.runtimeStopped !== (body.action !== "enable-plan") ||
          !["confirmed", "unconfirmed", "not-applicable"].includes(result.revocation)) {
        throw Object.assign(new Error("The installed owner result was not confirmed."), { statusCode: 502 });
      }
      const updated = copySiwcAccountView(result.account);
      if (body.action === "sign-out" && updated.session === "signed-out" &&
          updated.planEnabled === false) {
        state.localStoppedOwnerReview = { target, account: updated, expiresAt: Date.now() + 5 * 60_000 };
      }
      sendJson(response, 200, {
        account: updated, revocation: result.revocation, runtimeStopped: result.runtimeStopped,
      });
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/chat-test/key") {
    const localDashboardGeneration = state.localDashboardGeneration;
    requireLiveLocalAction(state, "Local chat testing");
    const account = await requireReadyLocalChatTester(state);
    requireCurrentLocalDashboardGeneration(
      state,
      localDashboardGeneration,
    );
    enforceRateLimit(state, path);
    const issued = await state.localChatTest.issueKey({ accountBinding: account });
    try {
      requireCurrentLocalDashboardGeneration(
        state,
        localDashboardGeneration,
      );
    } catch (error) {
      try {
        await state.localChatTest.reset({ keyId: issued?.keyId });
      } catch {
        // Revoke only this stale issuance; never clear newer tester sessions.
      }
      throw error;
    }
    sendJson(response, 200, createSafeLocalChatTestKey(issued));
    return;
  }

  if (path === "/api/local/chat-test/models") {
    const localDashboardGeneration = state.localDashboardGeneration;
    requireLiveLocalAction(state, "Local ChatGPT model discovery");
    const account = await requireReadyLocalChatTester(state);
    requireCurrentLocalDashboardGeneration(state, localDashboardGeneration);
    enforceRateLimit(state, path);
    try {
      const models = await state.localChatTest.models(body, { accountBinding: account });
      const current = await requireReadyLocalChatTester(state);
      requireCurrentLocalDashboardGeneration(state, localDashboardGeneration);
      if (current.registrationId !== account.registrationId ||
          current.generation !== account.generation) {
        throw Object.assign(new Error("The installed ChatGPT account changed. Secure the tester again."),
          { statusCode: 409, recovery: "review-again" });
      }
      sendJson(response, 200, { models, account: current });
    } finally {
      if (body && typeof body === "object") body.encryptedCredential = undefined;
    }
    return;
  }

  if (path === "/api/local/chat-test/message") {
    const localDashboardGeneration = state.localDashboardGeneration;
    requireLiveLocalAction(state, "Local chat testing");
    const account = await requireReadyLocalChatTester(state);
    requireCurrentLocalDashboardGeneration(
      state,
      localDashboardGeneration,
    );
    enforceRateLimit(state, path);
    const wantsStream = requestAcceptsEventStream(request);
    const stream = wantsStream ? startLocalChatTestStream(response) : null;
    const requestController = wantsStream ? new AbortController() : null;
    const abortOnClose = () => {
      if (!response.writableEnded) requestController?.abort();
    };
    response.once("close", abortOnClose);
    try {
      const rawResult = await state.localChatTest.message(body, {
        accountBinding: account,
        ...(stream
          ? {
              onEvent: (event, data) => {
                requireCurrentLocalDashboardGeneration(
                  state,
                  localDashboardGeneration,
                );
                stream.send(event, data);
              },
              signal: requestController.signal,
            }
          : {}),
      });
      requireCurrentLocalDashboardGeneration(
        state,
        localDashboardGeneration,
      );
      const result = createSafeLocalChatTestResponse(rawResult);
      if (stream) stream.complete(result);
      else sendJson(response, 200, result);
    } catch (error) {
      if (stream) {
        stream.fail(error);
      } else {
        throw error;
      }
    } finally {
      response.off("close", abortOnClose);
      stream?.dispose();
      if (body && typeof body === "object") {
        body.encryptedCredential = undefined;
        body.input = undefined;
      }
    }
    return;
  }

  if (path === "/api/local/chat-test/reset") {
    const localDashboardGeneration = state.localDashboardGeneration;
    requireLiveLocalAction(state, "Local chat testing");
    requireCurrentLocalDashboardGeneration(
      state,
      localDashboardGeneration,
    );
    enforceRateLimit(state, path);
    await state.localChatTest.reset(body);
    requireCurrentLocalDashboardGeneration(
      state,
      localDashboardGeneration,
    );
    sendJson(response, 200, { forgotten: true });
    return;
  }

  if (path === "/api/oauth/cancel") {
    requireLiveLocalAction(state, "Live ChatGPT sign-in");
    const login = state.oauthLogin;
    if (
      !login ||
      login.status !== "pending" ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.attemptId !== "string" ||
      body.attemptId !== login.attemptId
    ) {
      throw Object.assign(
        new Error("The ChatGPT sign-in attempt has already changed. Start again."),
        { statusCode: 409 },
      );
    }
    await cancelOAuthLogin(state, login);
    sendJson(response, 200, {
      status: login.status,
      attemptId: login.attemptId,
    });
    return;
  }

  if (path === "/api/local/plan") {
    const localDashboardGeneration = state.localDashboardGeneration;
    let plan;
    let legacyBinding = null;
    let existingBinding = null;
    let disposableHarnessWarning = false;
    state.localModelActionReview = null;
    if (body?.target === LOCAL_N8N_STACK_TARGET) {
      requireExactLocalPlanBody(
        body,
        [
          "target",
          "ngrokHostname",
          "n8nPort",
          "ngrokInspectorPort",
          "timezone",
          "assistantMode",
        ],
        "The local n8n + ngrok plan request is invalid.",
      );
      requireLiveLocalAction(state, "Local n8n + ngrok planning");
      if (localOAuthChangeInFlight(state)) {
        throw Object.assign(new Error("A local endpoint change is already in progress."), {
          statusCode: 409,
        });
      }
      const docker = await state.services.getLocalDockerStatus();
      if (docker?.dockerAvailable !== true || typeof docker.dockerHost !== "string") {
        throw new Error("Docker is unavailable for local n8n + ngrok planning.");
      }
      plan = state.services.prepareLocalN8nStackPlan({
        dockerHost: docker.dockerHost,
        ngrokHostname: body.ngrokHostname,
        n8nPort: body.n8nPort,
        ngrokInspectorPort: body.ngrokInspectorPort,
        timezone: body.timezone,
        assistantMode: body.assistantMode,
      });
    } else if (
      body?.target === LOCAL_N8N_SIDECAR_TARGET ||
      body?.target === LOCAL_N8N_ASSISTANT_TARGET ||
      body?.target === LOCAL_N8N_SUPERGROK_TARGET ||
      body?.target === LOCAL_N8N_MODEL_TARGET
    ) {
      const assistantTarget = body.target === LOCAL_N8N_ASSISTANT_TARGET;
      const superGrokTarget = body.target === LOCAL_N8N_SUPERGROK_TARGET;
      const modelTarget = body.target === LOCAL_N8N_MODEL_TARGET;
      requireExactLocalPlanBody(
        body,
        assistantTarget
          ? ["target", "n8nContainerId", "dockerNetworkId", "includeSearxng"]
          : modelTarget
            ? ["target", "n8nContainerId", "dockerNetworkId", "modelId"]
            : ["target", "n8nContainerId", "dockerNetworkId"],
        assistantTarget
          ? "The local n8n Assistant plan request is invalid."
          : superGrokTarget
            ? "The local n8n SuperGrok plan request is invalid."
            : modelTarget
              ? "The local model plan request is invalid."
              : "The local n8n OAuth bridge plan request is invalid.",
      );
      requireLiveLocalAction(state, "Local n8n sidecar planning");
      if (!assistantTarget && !superGrokTarget && !modelTarget && localOAuthChangeInFlight(state)) {
        throw Object.assign(
          new Error("ChatGPT sign-in is already in progress."),
          { statusCode: 409 },
        );
      }
      const discovery = await state.services.discoverLocalN8nSidecarTargets();
      if (discovery?.dockerAvailable !== true) {
        throw new Error("Docker is unavailable for local n8n discovery.");
      }
      const container = discovery.containers?.find(
        (candidate) => candidate?.containerId === body.n8nContainerId,
      );
      if (!container) {
        throw new Error("Select a running n8n container found by this wizard.");
      }
      const network = container.networks?.find(
        (candidate) => candidate?.dockerNetworkId === body.dockerNetworkId,
      );
      if (!network) {
        throw new Error("Select a Docker network attached to that n8n container.");
      }
      if (assistantTarget) {
        const includeSearxng = validateAssistantSearxngSelection(
          body.includeSearxng,
        );
        plan = {
          ...state.services.prepareLocalN8nAssistantPlan({
            dockerHost: discovery.dockerHost,
            n8nContainerId: container.containerId,
            n8nContainerName: container.containerName,
            dockerNetworkId: network.dockerNetworkId,
            networkName: network.networkName,
            includeSearxng,
          }),
          disposableHarnessWarning: network.disposable === true,
        };
      } else if (modelTarget) {
        const modelId = requireCatalogModel(body.modelId);
        const selected = {
          dockerHost: discovery.dockerHost,
          n8nContainerId: container.containerId,
          n8nContainerName: container.containerName,
          dockerNetworkId: network.dockerNetworkId,
          networkName: network.networkName,
        };
        const hostResources = await state.services.inspectLocalN8nModelResources(selected);
        plan = {
          ...state.services.prepareLocalN8nModelPlan({ ...selected, modelId, hostResources }),
          disposableHarnessWarning: network.disposable === true,
        };
      } else if (superGrokTarget) {
        plan = {
          ...state.services.prepareLocalN8nSuperGrokPlan({
            dockerHost: discovery.dockerHost,
            n8nContainerId: container.containerId,
            n8nContainerName: container.containerName,
            dockerNetworkId: network.dockerNetworkId,
            networkName: network.networkName,
          }),
          disposableHarnessWarning: network.disposable === true,
        };
      } else {
        const account = await selectedSiwcAccount(state, { requirePlan: true });
        const authBinding = await siwcBinding(state, account);
        plan = {
          ...state.services.prepareLocalN8nSidecarPlan({
            dockerHost: discovery.dockerHost,
            n8nContainerId: container.containerId,
            n8nContainerName: container.containerName,
            dockerNetworkId: network.dockerNetworkId,
            networkName: network.networkName,
            authBinding,
          }),
          account,
          disposableHarnessWarning: network.disposable === true,
        };
        const installed = await state.services.getLocalN8nSidecarStatus();
        if (installed?.state === "legacy" && installed.managed === true) {
          legacyBinding = await state.services.reviewLocalN8nLegacyMigration({ plan });
          plan = { ...plan, migrationRequired: true,
            legacyResourcesPreserved: true, requiresMigrationConsent: true };
        } else if (installed?.state === "stopped" && installed.managed === true) {
          const prior = state.localStoppedOwnerReview;
          if (prior?.target !== LOCAL_N8N_SIDECAR_TARGET ||
              installed.snapshot?.registrationId !== prior.account?.registrationId ||
              prior.account.session !== "signed-out" || prior.account.planEnabled !== false ||
              prior.account.registrationId === account.registrationId || prior.expiresAt <= Date.now()) {
            throw Object.assign(new Error("Inspect the signed-out old sidecar owner before reviewing replacement."),
              { statusCode: 409, recovery: "review-again" });
          }
          const bound = await state.services.reviewLocalN8nSiwcReplacement({ plan });
          if (bound.registrationId !== prior.account.registrationId ||
              bound.ownerHostId !== prior.account.ownerHostId) {
            throw Object.assign(new Error("The old n8n sidecar owner changed."), { statusCode: 409 });
          }
          existingBinding = Object.freeze({ ...bound, expectedGeneration: prior.account.generation });
          plan = { ...plan, replacementRequired: true,
            oldSessionSignedOut: true, oldHistoryRetained: true, requiresReplacementConsent: true };
        } else if (installed?.state !== "absent" || installed.managed !== false) {
          throw Object.assign(new Error("This n8n sidecar is already owned or needs manual migration recovery."),
            { statusCode: 409, recovery: "review-again" });
        }
      }
    } else {
      requireOAuthLocalEndpointPlanBody(body);
      const target = body.target ?? "xai-grok-build";
      const isChatGpt = target === "codex-chatgpt" || target === "codex-chat";
      if (isChatGpt) requireLiveLocalAction(state, "Local ChatGPT endpoint planning");
      const account = isChatGpt ? await selectedSiwcAccount(state, { requirePlan: true }) : null;
      plan = createLocalDeploymentPlan({
        target,
        port: body.port,
        ...(account ? { authBinding: await siwcBinding(state, account) } : {}),
      });
      if (account) plan = { ...plan, account };
      if (isChatGpt) {
        const installed = await state.services.getManagedLocalEndpointStatus({ target });
        if (installed?.state === "legacy" && installed.managed === true) {
          legacyBinding = await state.services.reviewLocalCodexLegacyMigration({ target });
          plan = { ...plan, migrationRequired: true,
            legacyResourcesPreserved: true, requiresMigrationConsent: true };
        } else if (installed?.state === "stopped" && installed.managed === true) {
          const prior = state.localStoppedOwnerReview;
          if (prior?.target !== target ||
              installed.snapshot?.registrationId !== prior.account?.registrationId ||
              prior.account.session !== "signed-out" || prior.account.planEnabled !== false ||
              prior.account.registrationId === account.registrationId || prior.expiresAt <= Date.now()) {
            throw Object.assign(new Error("Inspect the signed-out Codex owner before reviewing replacement."),
              { statusCode: 409, recovery: "review-again" });
          }
          const bound = await state.services.reviewLocalCodexSiwcReplacement({ target });
          if (bound.registrationId !== prior.account.registrationId ||
              bound.ownerHostId !== prior.account.ownerHostId) {
            throw Object.assign(new Error("The old Codex owner changed."), { statusCode: 409 });
          }
          existingBinding = Object.freeze({ ...bound, expectedGeneration: prior.account.generation });
          plan = { ...plan, replacementRequired: true,
            oldSessionSignedOut: true, oldHistoryRetained: true, requiresReplacementConsent: true };
        } else if (installed?.state !== "absent" || installed.managed !== false) {
          throw Object.assign(new Error("This Codex endpoint is already owned or needs manual migration recovery."),
            { statusCode: 409, recovery: "review-again" });
        }
      }
    }
    requireCurrentLocalDashboardGeneration(state, localDashboardGeneration);
    const planId = randomUUID();
    state.localPlan = { planId, plan, legacyBinding, existingBinding };
    sendJson(response, 200, {
      planId,
      plan:
        plan.kind === "local-n8n-stack"
          ? createSafeLocalN8nStackPlan(plan)
          : plan.kind === "n8n-sidecar"
          ? createSafeLocalN8nPlan(plan)
          : plan.kind === "n8n-assistant"
            ? createSafeLocalN8nAssistantPlan(plan)
            : plan.kind === "n8n-supergrok"
              ? createSafeLocalN8nSuperGrokPlan(plan)
            : plan.kind === LOCAL_N8N_MODEL_TARGET
              ? createSafeLocalN8nModelPlan(plan)
              : createSafeLocalPlan(plan),
    });
    return;
  }

  if (path === "/api/local/install") {
    const localDashboardGeneration = state.localDashboardGeneration;
    let acquiredInstallLock = false;
    try {
      requireLiveLocalAction(state, "Local endpoint installation");
      enforceRateLimit(state, path);
      if (
        state.localInstallInFlight ||
        state.localCredentialRotationInFlight ||
        getPendingLocalCredentialRotation(state) ||
        localOAuthChangeInFlight(state)
      ) {
        throw Object.assign(
          new Error("A local endpoint change is already in progress."),
          { statusCode: 409 },
        );
      }
      const pending = state.localPlan;
      if (!pending || !tokenMatches(body.planId, pending.planId)) {
        throw new Error(
          "Review a fresh local endpoint plan before installing.",
        );
      }

      requireLocalInstallBody(pending.plan, body);
      if (pending.plan.migrationRequired &&
          (body.migrationConsent !== true || !pending.legacyBinding)) {
        throw Object.assign(new Error("Confirm the separate legacy-service migration before installation."),
          { statusCode: 400 });
      }
      if (pending.plan.replacementRequired &&
          (body.replacementConsent !== true || !pending.existingBinding)) {
        throw Object.assign(new Error("Confirm replacement of the signed-out installed account."),
          { statusCode: 400 });
      }
      if (pending.plan.authBinding && body.confirmed !== true) {
        throw Object.assign(new Error("Confirm the reviewed ChatGPT installation."), { statusCode: 400 });
      }

      if (pending.plan.kind === "n8n-supergrok" && body.confirmed !== true) {
        throw new Error(
          "Confirm the reviewed local n8n SuperGrok plan before installing.",
        );
      }
      if (pending.plan.kind === LOCAL_N8N_MODEL_TARGET && body.confirmed !== true) {
        throw new Error("Confirm the reviewed local model and download before installing.");
      }

      let localN8nStackSecrets;
      if (pending.plan.kind === "local-n8n-stack") {
        if (body.confirmed !== true) {
          throw Object.assign(
            new Error("Confirm the reviewed local n8n + ngrok plan before installing."),
            { retryablePlan: true },
          );
        }
        try {
          localN8nStackSecrets = validateLocalN8nStackSecrets({
            ngrokAuthtoken: body.ngrokAuthtoken,
            basicAuthUsername: body.basicAuthUsername,
            basicAuthPassword: body.basicAuthPassword,
          });
        } catch (error) {
          throw Object.assign(error, { retryablePlan: true });
        }
      }

      state.localInstallInFlight = true;
      acquiredInstallLock = true;
      state.localPlan = null;
      state.localAssistantSearxngReview = null;
      state.localInstalledTarget = null;
      let result;
      if (pending.plan.kind === "n8n-sidecar") {
        if (pending.resume) await requireRecoveryBinding(state, pending.sourceBinding);
        else await requireMatchingSiwcBinding(state, pending.plan.authBinding);
        if (body.backgroundConsent !== true || body.confirmed !== true) {
          throw new Error("Approve background n8n use for the selected account and confirm the reviewed installation.");
        }
        result = await state.services.installLocalN8nSidecar({
          plan: pending.plan,
          registration: { storageRoot: state.storageRoot, registrationId: pending.plan.authBinding.registrationId },
          confirmed: true,
          ...(pending.resume ? { resume: pending.resume, plan: pending.resume.plan } : {}),
          backgroundConsent: { acceptedAt: new Date().toISOString(), noticeVersion: "siwc-local-2026-10-04" },
          ...(pending.legacyBinding ? { migrationConsent: true,
            legacyBinding: pending.legacyBinding } : {}),
          ...(pending.existingBinding ? { replacementConsent: true,
            existingBinding: pending.existingBinding } : {}),
        });
      } else if (pending.plan.kind === "n8n-assistant") {
        result = await state.services.installLocalN8nAssistant({
          plan: pending.plan,
          confirmed: body.confirmed,
        });
      } else if (pending.plan.kind === "n8n-supergrok") {
        result = await state.services.installLocalN8nSuperGrok({
          plan: pending.plan,
          confirmed: body.confirmed,
        });
      } else if (pending.plan.kind === LOCAL_N8N_MODEL_TARGET) {
        result = await state.services.installLocalN8nModel({ plan: pending.plan, confirmed: true });
      } else if (pending.plan.kind === "local-n8n-stack") {
        try {
          result = await state.services.installLocalN8nStack({
            plan: pending.plan,
            secrets: localN8nStackSecrets,
            publicExposureConfirmation: LOCAL_N8N_STACK_PUBLIC_CONFIRMATION,
          });
        } catch (error) {
          if (error?.code === LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE) {
            // The service only emits this code after ownership-attested
            // cleanup proves that no owned Docker resources remain. Restore
            // the server-side, non-secret reviewed plan so the user can
            // retry the classified startup failure without redoing the form.
            requireCurrentLocalDashboardGeneration(
              state,
              localDashboardGeneration,
            );
            state.localPlan = pending;
            throw Object.assign(error, { retryablePlan: true });
          }
          throw error;
        }
      } else {
        if (pending.resume) await requireRecoveryBinding(state, pending.sourceBinding);
        else if (pending.plan.authBinding) await requireMatchingSiwcBinding(state, pending.plan.authBinding);
        result = await state.services.installLocalEndpoint({
          plan: pending.plan,
          ...(pending.plan.authBinding
            ? { registration: { storageRoot: state.storageRoot, registrationId: pending.plan.authBinding.registrationId } }
            : {}),
          confirmed: body.confirmed,
          ...(pending.resume ? { resume: pending.resume, plan: pending.resume.plan } : {}),
          ...(pending.legacyBinding ? { migrationConsent: true,
            legacyBinding: pending.legacyBinding } : {}),
          ...(pending.existingBinding ? { replacementConsent: true,
            existingBinding: pending.existingBinding } : {}),
        });

      }
      requireCurrentLocalDashboardGeneration(
        state,
        localDashboardGeneration,
      );
      state.localInstalledTarget = pending.plan.target;
      sendJson(
        response,
        200,
        pending.plan.kind === "local-n8n-stack"
          ? createSafeLocalN8nStackInstallResult(result, pending.plan)
          : pending.plan.kind === "n8n-sidecar"
          ? createSafeLocalN8nInstallResult(result, pending.plan)
          : pending.plan.kind === "n8n-assistant"
            ? createSafeLocalN8nAssistantInstallResult(result, pending.plan)
            : pending.plan.kind === "n8n-supergrok"
              ? createSafeLocalN8nSuperGrokInstallResult(result, pending.plan)
            : pending.plan.kind === LOCAL_N8N_MODEL_TARGET
              ? createSafeLocalModelStatus(result)
              : createSafeLocalInstallResult(result, pending.plan),
      );
    } finally {
      if (acquiredInstallLock) {
        state.localInstallInFlight = false;
      }
      body.ngrokAuthtoken = undefined;
      body.basicAuthUsername = undefined;
      body.basicAuthPassword = undefined;
    }
    return;
  }

  if (path === "/api/local/model/plan") {
    requireLiveLocalAction(state, "Local model action review");
    if (body?.action === "remove") {
      requireExactRequestBody(body, ["action", "removeModelData"], "The model removal review is invalid.");
      if (body.removeModelData !== true) throw new Error("Review deletion of the owned model cache.");
    } else {
      requireExactRequestBody(body, ["action"], "The model retry review is invalid.");
      if (body.action !== "retry") throw new Error("The model action is invalid.");
    }
    if (state.localInstallInFlight || state.localCredentialRotationInFlight || localOAuthChangeInFlight(state)) {
      throw Object.assign(new Error("A local change is in progress."), { statusCode: 409 });
    }
    const generation = state.localDashboardGeneration;
    state.localPlan = null;
    state.localModelActionReview = null;
    const review = await state.services.reviewLocalN8nModelAction({
      action: body.action, ...(body.action === "remove" ? { removeModelData: true } : {}),
    });
    requireCurrentLocalDashboardGeneration(state, generation);
    const reviewId = randomUUID();
    const safe = createSafeLocalModelActionReview(review, reviewId);
    state.localModelActionReview = { reviewId, review, generation };
    sendJson(response, 200, safe);
    return;
  }

  if (path === "/api/local/model/apply") {
    requireLiveLocalAction(state, "Local model action");
    enforceRateLimit(state, path);
    const pending = state.localModelActionReview;
    requireExactRequestBody(
      body,
      pending?.review?.action === "remove"
        ? ["reviewId", "confirmed", "removeModelData"]
        : ["reviewId", "confirmed"],
      "The model action confirmation is invalid.",
    );
    if (!pending || !tokenMatches(body.reviewId, pending.reviewId) ||
      pending.generation !== state.localDashboardGeneration || body.confirmed !== true ||
      (pending.review.action === "remove" && body.removeModelData !== true)) {
      throw new Error("Review and explicitly confirm this model action again.");
    }
    if (state.localInstallInFlight || state.localCredentialRotationInFlight || localOAuthChangeInFlight(state)) {
      throw Object.assign(new Error("A local change is in progress."), { statusCode: 409 });
    }
    state.localInstallInFlight = true;
    state.localModelActionReview = null;
    state.localPlan = null;
    try {
      const fresh = await state.services.reviewLocalN8nModelAction({
        action: pending.review.action,
        ...(pending.review.action === "remove" ? { removeModelData: true } : {}),
      });
      requireCurrentLocalDashboardGeneration(state, pending.generation);
      for (const key of ["action", "installId", "modelId", "modelDigest", "endpoint", "removeModelData", "networkName", "containerName", "operationId"]) {
        if (fresh[key] !== pending.review[key]) throw new Error("The model state changed after review. Review again.");
      }
      const result = await state.services.applyLocalN8nModelAction({ review: pending.review, confirmed: true });
      requireCurrentLocalDashboardGeneration(state, pending.generation);
      if (pending.review.action === "remove") {
        if (result?.target !== LOCAL_N8N_MODEL_TARGET || result.removed !== true || result.cacheRetained !== false) {
          throw Object.assign(new TypeError("The model removal result is invalid."), { statusCode: 502 });
        }
        sendJson(response, 200, { target: LOCAL_N8N_MODEL_TARGET, removed: true, cacheRetained: false });
      } else sendJson(response, 200, createSafeLocalModelStatus(result));
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }



  if (path === "/api/local/n8n/assistant/searxng/review") {
    const localDashboardGeneration = state.localDashboardGeneration;
    requireLiveLocalAction(state, "Local n8n Assistant SearXNG review");
    enforceRateLimit(state, path);
    if (body?.includeSearxng !== true) {
      throw new Error("This edit can only enable optional SearXNG web search.");
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state) ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    // Preparing the review performs asynchronous Docker/file attestation. Hold the
    // shared slot for that whole snapshot so another local change cannot make the
    // review stale while it is being assembled.
    state.localInstallInFlight = true;
    state.localAssistantSearxngReview = null;
    try {
      const review = await state.services.prepareLocalN8nAssistantSearxngUpdate({
        includeSearxng: true,
      });
      const reviewId = randomUUID();
      const safeReview = createSafeLocalN8nAssistantSearxngReview(review, reviewId);
      requireCurrentLocalDashboardGeneration(
        state,
        localDashboardGeneration,
      );
      state.localAssistantSearxngReview = { reviewId, review };
      sendJson(response, 200, safeReview);
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/n8n/assistant/searxng/enable") {
    requireLiveLocalAction(state, "Local n8n Assistant SearXNG enablement");
    enforceRateLimit(state, path);
    if (body?.confirmed !== true) {
      throw new Error(
        "Confirm enabling SearXNG web search for the reviewed managed local n8n Assistant tools.",
      );
    }
    const pending = state.localAssistantSearxngReview;
    if (!pending || !tokenMatches(body.reviewId, pending.reviewId)) {
      throw new Error(
        "Review the managed local n8n Assistant SearXNG change before enabling it.",
      );
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state) ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }

    // Claim the same mutation slot used by local install/removal/resume before
    // the first awaited service call. The review is consumed on any attempt.
    state.localInstallInFlight = true;
    state.localPlan = null;
    state.localAssistantSearxngReview = null;
    try {
      const result = await state.services.editLocalN8nAssistantSearxng({
        review: pending.review,
        confirmed: true,
      });
      sendJson(
        response,
        200,
        createSafeLocalN8nAssistantSearxngEditResult(result),
      );
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/n8n/remove") {
    requireLiveLocalAction(state, "Local n8n sidecar removal");
    enforceRateLimit(state, path);
    if (body?.confirmed !== true) {
      throw new Error("Confirm removal of the managed local n8n sidecar.");
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state) ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    state.localInstallInFlight = true;
    state.localPlan = null;
    state.localAssistantSearxngReview = null;
    state.localInstalledTarget = null;
    try {
      const result = await state.services.removeLocalN8nSidecar({
        confirmed: true,
      });
      sendJson(response, 200, createSafeLocalN8nRemovalResult(result));
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/supergrok/remove") {
    const localDashboardGeneration = state.localDashboardGeneration;
    requireLiveLocalAction(state, "Local n8n SuperGrok removal");
    enforceRateLimit(state, path);
    requireExactRequestBody(
      body,
      ["confirmed"],
      "The local n8n SuperGrok removal request is invalid.",
    );
    if (body.confirmed !== true) {
      throw new Error("Confirm removal of the managed local n8n SuperGrok sidecar.");
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state) ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    state.localInstallInFlight = true;
    state.localPlan = null;
    state.localAssistantSearxngReview = null;
    state.localInstalledTarget = null;
    try {
      const result = await state.services.removeLocalN8nSuperGrok({
        confirmed: true,
      });
      requireCurrentLocalDashboardGeneration(state, localDashboardGeneration);
      sendJson(
        response,
        200,
        createSafeLocalN8nSuperGrokRemovalResult(result),
      );
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/n8n/stack/resume") {
    requireLiveLocalAction(state, "Local n8n + ngrok resume");
    enforceRateLimit(state, path);
    if (body?.confirmed !== true) {
      throw new Error("Confirm resuming the managed local n8n + ngrok stack.");
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state) ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(new Error("A local endpoint change is already in progress."), {
        statusCode: 409,
      });
    }
    state.localInstallInFlight = true;
    state.localPlan = null;
    state.localAssistantSearxngReview = null;
    state.localInstalledTarget = null;
    try {
      const result = await state.services.resumeLocalN8nStack({
        confirmed: true,
      });
      sendJson(response, 200, createSafeLocalN8nStackResumeResult(result));
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/n8n/stack/remove") {
    requireLiveLocalAction(state, "Local n8n + ngrok removal");
    enforceRateLimit(state, path);
    if (body?.confirmed !== true) {
      throw new Error("Confirm removal of the managed local n8n + ngrok stack.");
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state) ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(new Error("A local endpoint change is already in progress."), {
        statusCode: 409,
      });
    }
    state.localInstallInFlight = true;
    state.localPlan = null;
    state.localAssistantSearxngReview = null;
    state.localInstalledTarget = null;
    try {
      const result = await state.services.removeLocalN8nStack({
        confirmation: LOCAL_N8N_STACK_REMOVE_CONFIRMATION,
      });
      sendJson(response, 200, createSafeLocalN8nStackRemovalResult(result));
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/n8n/assistant/remove") {
    requireLiveLocalAction(state, "Local n8n Assistant companion removal");
    enforceRateLimit(state, path);
    if (body?.confirmed !== true) {
      throw new Error("Confirm removal of the managed local n8n Assistant tools.");
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state) ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    state.localInstallInFlight = true;
    state.localPlan = null;
    state.localAssistantSearxngReview = null;
    state.localInstalledTarget = null;
    try {
      const result = await state.services.removeLocalN8nAssistant({
        confirmed: true,
      });
      sendJson(
        response,
        200,
        createSafeLocalN8nAssistantRemovalResult(result),
      );
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/client-credential/rotate") {
    const localDashboardGeneration = state.localDashboardGeneration;
    requireLiveLocalAction(state, "Local client credential rotation");
    enforceRateLimit(state, path);
    if (
      state.localCredentialRotationInFlight ||
      state.localInstallInFlight ||
      getPendingLocalCredentialRotation(state) ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Choose the installed local endpoint before rotating its credential.");
    }

    state.localCredentialRotationInFlight = true;
    try {
      state.localChatTest.resetAll?.();
      const result = await state.services.prepareLocalClientCredentialRotation({
        target: validateLocalTarget(body.target),
      });
      const rotationId = randomUUID();
      requireCurrentLocalDashboardGeneration(
        state,
        localDashboardGeneration,
      );
      state.localCredentialRotationPending = {
        rotationId,
        target: result.target,
        tokenSha256: result.tokenSha256,
        ...(["codex-chatgpt", "codex-chat"].includes(result.target)
          ? {
              registrationId: requireSiwcId(result.registrationId),
              expectedGeneration: result.expectedGeneration,
            } : {}),
        expiresAt: Date.now() + LOCAL_ROTATION_STAGE_TTL_MS,
      };
      sendJson(response, 200, {
        ...createSafeLocalInstallResult(result),
        rotationId,
      });
    } finally {
      state.localCredentialRotationInFlight = false;
    }
    return;
  }

  if (path === "/api/local/client-credential/activate") {
    requireLiveLocalAction(state, "Local client credential activation");
    enforceRateLimit(state, path);
    if (
      state.localCredentialRotationInFlight ||
      state.localInstallInFlight ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    const pending = getPendingLocalCredentialRotation(state);
    if (!pending || !tokenMatches(body?.rotationId, pending.rotationId)) {
      throw new Error("Stage a fresh local client credential before activating it.");
    }

    state.localCredentialRotationPending = null;
    state.localCredentialRotationInFlight = true;
    try {
      state.localChatTest.resetAll?.();
      const result = await state.services.activateLocalClientCredentialRotation({
        target: pending.target,
        clientCredential: body.clientCredential,
        tokenSha256: pending.tokenSha256,
        ...(pending.registrationId
          ? { registrationId: pending.registrationId, expectedGeneration: pending.expectedGeneration }
          : {}),
      });
      sendJson(response, 200, createSafeLocalActivationResult(result));
    } finally {
      state.localCredentialRotationInFlight = false;
    }
    return;
  }


  if (path === "/api/ssh/fingerprint") {
    enforceRateLimit(state, path);
    const host = validateHostname(body.host);
    const port = validatePort(body.port);
    const scanOperation = beginVpsFingerprintScan(state);
    try {
      const fingerprint = await state.services.scanHostFingerprint({
        host,
        port,
      });
      requireCurrentVpsFingerprintScan(state, scanOperation);
      state.scannedHost = {
        host,
        port,
        fingerprint,
        scanGeneration: scanOperation.scanGeneration,
      };
      sendJson(response, 200, { fingerprint });
    } finally {
      releaseVpsFingerprintScan(state, scanOperation);
    }
    return;
  }

  if (path === "/api/ssh/connect") {
    let connectionOperation;
    let candidateConnection = null;
    try {
      rejectActiveVpsMutation(state);
      enforceRateLimit(state, path);
      const connectionRequest = validatedSshRequest(body);
      const { host, port } = connectionRequest;
      const scannedHost = state.scannedHost;
      if (
        !scannedHost ||
        scannedHost.host !== host ||
        scannedHost.port !== port ||
        !tokenMatches(body.expectedFingerprint, scannedHost.fingerprint)
      ) {
        throw Object.assign(new Error(
          "This server identity check was already used or no longer matches. Check and confirm the server identity again before connecting."),
        { code: "ssh_identity_review_required", recovery: "review-again" });
      }

      connectionOperation = acquireVpsConnectionOperation(state);
      const previousConnection = state.connection;
      clearVpsConnectionIdleExpiry(state, previousConnection);
      retireVpsConnectionUses(state, previousConnection);
      state.connection = null;
      state.connectionIdentity = null;
      connectionOperation.operation.lifecycleGeneration =
        advanceVpsLifecycleGeneration(state);
      state.discovery = null;
      state.networksByContainer.clear();
      invalidateVpsPlans(state);
      closeVpsConnectionBestEffort(previousConnection);

      candidateConnection = await state.services.connectVerified(connectionRequest);
      requireCurrentVpsConnectionOperation(
        state,
        connectionOperation.operation,
      );
      if (state.scannedHost !== scannedHost) {
        throw Object.assign(
          new Error("The VPS identity scan changed before the connection was ready. Check it again."),
          { statusCode: 409 },
        );
      }
      // Administrative identity belongs to this connection, not to later model mutations.
      const identity = verifiedConnectionIdentity(candidateConnection, connectionRequest, state.vpsLifecycleGeneration);
      state.connection = candidateConnection;
      state.connectionIdentity = identity;
      armVpsConnectionIdleExpiry(state, candidateConnection);
      candidateConnection = null;
      state.scannedHost = null;
      sendJson(response, 200, { connected: true, identity });
    } finally {
      if (body && typeof body === "object") body.password = undefined;
      closeVpsConnectionBestEffort(candidateConnection);
      connectionOperation?.release();
    }
    return;
  }

  if (path === "/api/discover") {
    rejectActiveVpsMutation(state);
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    const sessionSnapshot = {
      connection,
      lifecycleGeneration: state.vpsLifecycleGeneration,
      discoveryGeneration: beginVpsDiscoveryRefresh(state),
    };
    try {
      const discovery = await state.services.discoverN8n(connection);
      requireUnchangedVpsSession(state, sessionSnapshot);
      state.discovery = discovery;
      state.networksByContainer.clear();
      invalidateVpsPlans(state);
      sendJson(response, 200, state.discovery);
    } finally {
      connectionUse.release();
    }
    return;
  }

  if (path === "/api/networks") {
    rejectActiveVpsMutation(state);
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    const sessionSnapshot = {
      connection,
      lifecycleGeneration: state.vpsLifecycleGeneration,
      discoveryGeneration: beginVpsDiscoveryRefresh(state),
    };
    try {
      requireDiscoveredContainer(state, body.containerName);
      const networks = await state.services.discoverNetworks(
        connection,
        body.containerName,
      );
      requireUnchangedVpsSession(state, sessionSnapshot);
      state.networksByContainer.set(body.containerName, networks);
      invalidateVpsPlans(state);
      sendJson(response, 200, networks);
    } finally {
      connectionUse.release();
    }
    return;
  }

  if (path.startsWith("/api/vps/local-model/")) {
    rejectActiveVpsMutation(state);
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    const snapshot = {
      connection,
      lifecycleGeneration: state.vpsLifecycleGeneration,
      discoveryGeneration: state.vpsDiscoveryGeneration,
    };
    let releaseMutation;
    try {
      if (path === "/api/vps/local-model/status") {
        requireExactRequestBody(body, ["containerName", "networkName"], "The model status selection is invalid.");
        requireSafeDockerName(body.containerName, "n8n container name");
        requireSafeDockerName(body.networkName, "Docker network name");
        const result = await state.services.inspectVpsLocalModel({ remote: connection, containerName: body.containerName, networkName: body.networkName });
        requireUnchangedVpsSession(state, snapshot);
        sendJson(response, 200, createSafeVpsLocalModelStatus(result));
      } else if (path === "/api/vps/local-model/plan") {
        if (body?.action === "install") {
          requireExactRequestBody(body, ["containerName", "networkName", "action", "modelId"], "The model install selection is invalid.");
          requireCatalogModel(body.modelId);
        } else if (body?.action === "remove") {
          requireExactRequestBody(body, ["containerName", "networkName", "action", "clearModelCache"], "The model removal selection is invalid.");
          if (body.clearModelCache !== true) throw new Error("Confirm that removal deletes the owned model cache.");
        } else if (body?.action === "retry") {
          requireExactRequestBody(body, ["containerName", "networkName", "action"], "The model retry selection is invalid.");
        } else throw new Error("The model action is invalid.");
        if (body.action !== "remove") requireDiscoveredNetwork(state, body.containerName, body.networkName);
        else {
          requireSafeDockerName(body.containerName, "n8n container name");
          requireSafeDockerName(body.networkName, "Docker network name");
        }
        const generation = beginLocalModelVpsReview(state);
        const reviewed = await state.services.reviewVpsLocalModel({
          remote: connection, containerName: body.containerName, networkName: body.networkName,
          action: body.action, ...(body.action === "install" ? { modelId: body.modelId } : {}),
          ...(body.action === "remove" ? { clearModelCache: true } : {}),
        });
        requireUnchangedVpsSession(state, snapshot);
        if (generation !== state.localModelVpsPlanGeneration) throw Object.assign(new Error("A newer model review replaced this plan."), { statusCode: 409 });
        const plan = createSafeVpsLocalModelPlan(reviewed);
        state.localModelVpsPlan = { ...reviewed, planId: randomUUID() };
        sendJson(response, 200, { ...plan, planId: state.localModelVpsPlan.planId });
      } else if (path === "/api/vps/local-model/apply") {
        enforceRateLimit(state, path);
        const plan = state.localModelVpsPlan;
        requireExactRequestBody(
          body,
          plan?.action === "remove"
            ? ["containerName", "networkName", "planId", "action", "confirmed", "clearModelCache"]
            : ["containerName", "networkName", "planId", "action", "confirmed"],
          "The model apply request is invalid.",
        );
        requireReviewedVpsPlan(plan, body, "local model");
        if (!["install", "retry", "remove"].includes(body.action) || plan.action !== body.action || body.confirmed !== true ||
          (plan.action === "remove" && (plan.clearModelCache !== true || body.clearModelCache !== true))) {
          throw new Error("Confirm the exact reviewed model action and cache deletion.");
        }
        if (plan.action !== "remove") requireDiscoveredNetwork(state, body.containerName, body.networkName);
        state.localModelVpsPlan = null;
        releaseMutation = acquireVpsMutationLock(state);
        snapshot.lifecycleGeneration = state.vpsLifecycleGeneration;
        const fresh = await state.services.reviewVpsLocalModel({
          remote: connection, containerName: plan.containerName, networkName: plan.networkName,
          action: plan.action, ...(plan.action === "install" ? { modelId: plan.modelId } : {}),
          ...(plan.action === "remove" ? { clearModelCache: true } : {}),
        });
        if (state.connection !== connection || state.vpsLifecycleGeneration !== snapshot.lifecycleGeneration ||
          state.vpsDiscoveryGeneration !== snapshot.discoveryGeneration) {
          throw new Error("The VPS session changed after model review. Reconnect and inspect again.");
        }
        createSafeVpsLocalModelPlan(fresh);
        for (const key of ["action", "containerId", "networkId", "installId", "modelId", "approvedModelDigest", "catalogRevision", "runtimeImage", "contextTokens", "memoryBytes", "cpus", "expectedDownloadBytes", "requiredDiskBytes", "reservedMemoryBytes", "clearModelCache"]) {
          if (fresh[key] !== plan[key]) throw new Error("The selected model, resources or Docker boundary changed. Review again.");
        }
        const servicePlan = { ...plan };
        delete servicePlan.planId;
        const result = await (plan.action === "install" ? state.services.installVpsLocalModel : state.services.changeVpsLocalModel)({ remote: connection, plan: servicePlan, confirmed: true });
        if (state.connection !== connection || state.vpsLifecycleGeneration !== snapshot.lifecycleGeneration) throw new Error("VPS connection changed. Reconnect and inspect the owned model status.");
        sendJson(response, 200, createSafeVpsLocalModelStatus(result));
      } else if (path === "/api/vps/local-model/operation-status") {
        requireExactRequestBody(body, ["containerName", "networkName", "installId"], "The model operation selection is invalid.");
        requireSafeDockerName(body.containerName, "n8n container name");
        requireSafeDockerName(body.networkName, "Docker network name");
        const current = await state.services.inspectVpsLocalModel({ remote: connection, containerName: body.containerName, networkName: body.networkName });
        requireUnchangedVpsSession(state, snapshot);
        if (current.installId !== body.installId || !/^[a-f0-9-]{16,64}$/iu.test(body.installId)) throw new Error("The model operation identity changed. Inspect again.");
        const result = await state.services.getVpsLocalModelOperationStatus({ remote: connection, installId: body.installId });
        requireUnchangedVpsSession(state, snapshot);
        sendJson(response, 200, createSafeVpsLocalModelStatus(result));
      } else sendJson(response, 404, { error: "Not found." });
    } finally {
      releaseMutation?.();
      connectionUse.release();
    }
    return;
  }

  if (path.startsWith("/api/vps/supergrok/")) {
    rejectActiveVpsMutation(state);
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    requireFullVpsScope(connection);
    const snapshot = {
      connection,
      lifecycleGeneration: state.vpsLifecycleGeneration,
      discoveryGeneration: state.vpsDiscoveryGeneration,
    };
    let releaseMutation;
    try {
      if (path === "/api/vps/supergrok/status" || path === "/api/vps/supergrok/plan") {
        requireDiscoveredNetwork(state, body.containerName, body.networkName);
        const args = { remote: connection, containerName: body.containerName, networkName: body.networkName, action: body.action };
        const planGeneration = path.endsWith("/plan")
          ? beginSuperGrokPlanReview(state)
          : null;
        const result = path.endsWith("/plan")
          ? await state.services.reviewVpsSuperGrok(args)
          : await state.services.inspectVpsSuperGrok(args);
        requireUnchangedVpsSession(state, snapshot);
        if (path.endsWith("/plan")) {
          if (state.supergrokPlanGeneration !== planGeneration) {
            throw Object.assign(
              new Error("A newer SuperGrok review replaced this plan. Review the current plan before installing."),
              { statusCode: 409 },
            );
          }
          requireVpsSuperGrokBuildBoundary(result);
          state.supergrokPlan = { ...result, planId: randomUUID() };
          sendJson(response, 200, state.supergrokPlan);
        } else sendJson(response, 200, result);
      } else if (path === "/api/vps/supergrok/apply") {
        enforceRateLimit(state, path);
        const plan = state.supergrokPlan;
        requireReviewedVpsPlan(plan, body, "SuperGrok");
        if (body.confirmed !== true || plan.action !== body.action) throw new Error("Confirm the exact reviewed SuperGrok action.");
        requireDiscoveredNetwork(state, body.containerName, body.networkName);
        state.supergrokPlan = null;
        releaseMutation = acquireVpsMutationLock(state);
        snapshot.lifecycleGeneration = state.vpsLifecycleGeneration;
        const fresh = await state.services.reviewVpsSuperGrok({ remote: connection, ...plan });
        requireVpsSuperGrokBuildBoundary(fresh);
        if (["containerId", "networkId", "installId", "action", "operationLockPath", "temporaryBuildStatePath"].some(key => fresh[key] !== plan[key])) throw new Error("The SuperGrok selection changed. Review a fresh plan.");
        const result = await (plan.action === "install" ? state.services.installVpsSuperGrok : state.services.changeVpsSuperGrok)({ remote: connection, plan, confirmed: true });
        if (state.connection !== connection || state.vpsLifecycleGeneration !== snapshot.lifecycleGeneration) {
          throw new Error("The VPS session changed during the companion action. Reconnect and inspect its status.");
        }
        sendJson(response, 200, result);
      } else if (path === "/api/vps/supergrok/login-status") {
        const result = await state.services.getVpsGrokLoginStatus({ remote: connection, installId: body.installId });
        requireUnchangedVpsSession(state, snapshot);
        sendJson(response, 200, result);
      } else if (path === "/api/vps/supergrok/models") {
        try {
          const result = await state.services.discoverVpsGrokModels({ remote: connection, installId: body.installId, clientKey: body.clientKey });
          requireUnchangedVpsSession(state, snapshot);
          sendJson(response, 200, result);
        } finally { body.clientKey = undefined; }
      } else sendJson(response, 404, { error: "Not found." });
    } finally {
      releaseMutation?.();
      connectionUse.release();
    }
    return;
  }

  if (["/api/siwc/vps/status", "/api/siwc/vps/manage", "/api/siwc/vps/inspect-stopped"].includes(path)) {
    requireLiveLocalAction(state, "VPS ChatGPT account management");
    enforceRateLimit(state, path);
    const managing = path.endsWith("/manage");
    const inspecting = path.endsWith("/inspect-stopped");
    requireExactRequestBody(body, managing
      ? ["containerName", "networkName", "registrationId", "expectedGeneration", "action", "confirmed",
          ...(body?.action === "enable-plan" ? ["backgroundConsent"] : [])]
      : inspecting
        ? ["containerName", "networkName", "registrationId", "confirmed"]
        : ["containerName", "networkName"],
    "Choose the verified VPS installation and its exact account.");
    requireDiscoveredNetwork(state, body.containerName, body.networkName);
    if ((managing || inspecting) && (body.confirmed !== true ||
        !requireSiwcId(body.registrationId) ||
        (managing && !["sign-out", "disable-plan", "enable-plan"].includes(body.action)) ||
        (managing && body.action === "enable-plan" && body.backgroundConsent !== true))) throw invalidSiwcRequest();
    rejectActiveVpsMutation(state);
    if (oauthCredentialChangeInFlight(state)) {
      throw Object.assign(new Error("Finish ChatGPT sign-in before managing the VPS."), { statusCode: 409 });
    }
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    let releaseMutation;
    let credentialOperation;
    try {
      requireFullVpsScope(connection);
      const reviewedTarget = managing || inspecting
        ? requireReviewedVpsOwnerTarget(state, body.containerName, body.networkName)
        : Object.freeze({ ...state.connectionIdentity,
          containerName: body.containerName, networkName: body.networkName,
          ...await state.services.reviewVpsSiwcTarget({
            remote: connection, networkName: body.networkName, containerName: body.containerName,
          }) });
      releaseMutation = managing || inspecting ? acquireVpsMutationLock(state) : null;
      credentialOperation = managing || inspecting ? null : acquireVpsCredentialOperation(state, "owner-status");
      const status = await state.services.getVpsSiwcInstallationStatus({
        remote: connection, networkName: body.networkName, reviewedTarget,
      });
      if (!managing && !inspecting) {
        state.vpsOwnerTargetReview = { reviewedTarget, expiresAt: Date.now() + 5 * 60_000 };
        sendJson(response, 200, {
          state: status.state,
          destination: { n8nContainerId: reviewedTarget.n8nContainerId,
            networkId: reviewedTarget.networkId },
          ...(status.account ? { account: copySiwcAccountView(status.account) } : {}),
          ...(status.registrationId ? { registrationId: requireSiwcId(status.registrationId) } : {}),
          ...(["staged", "updating"].includes(status.state) ? { staging: copySiwcStaging(status.staging) } : {}),
          ...(status.state === "owned" && typeof status.runtimeUpdateAvailable === "boolean"
            ? { runtimeUpdateAvailable: status.runtimeUpdateAvailable } : {}),
        });
        return;
      }
      if (inspecting) {
        if (status.state !== "stopped" || status.registrationId !== body.registrationId) {
          throw Object.assign(new Error("This installed account is not stopped. Check its status again."), { statusCode: 409 });
        }
        const result = await state.services.inspectStoppedVpsSiwcInstallation({
          remote: connection, networkName: body.networkName, registrationId: body.registrationId,
          reviewedTarget, confirmed: true,
        });
        const account = copySiwcAccountView(result.account);
        state.vpsStoppedOwnerReview = { account, reviewedTarget, expiresAt: Date.now() + 5 * 60_000 };
        sendJson(response, 200, { account });
        return;
      }
      const stoppedReview = state.vpsStoppedOwnerReview;
      const stopped = status.state === "stopped" && status.registrationId === body.registrationId &&
        stoppedReview?.expiresAt > Date.now() &&
        stoppedReview.account.registrationId === body.registrationId &&
        stoppedReview.account.generation === body.expectedGeneration &&
        ["host", "port", "fingerprint", "username", "authentication", "privilege",
          "loginUid", "effectiveUid", "containerName", "networkName", "n8nContainerId", "networkId"].every(
          (key) => stoppedReview.reviewedTarget[key] === reviewedTarget[key]);
      const live = status.state === "owned" && status.registrationId === body.registrationId &&
        status.account?.registrationId === body.registrationId &&
        status.account.generation === body.expectedGeneration &&
        status.account.ownership === "owned";
      if (!live && !stopped) {
        throw Object.assign(new Error("The VPS owner session changed. Check its status again."), { statusCode: 409 });
      }
      state.vpsStoppedOwnerReview = null;
      const result = await state.services.manageVpsSiwcInstallation({
        remote: connection, networkName: body.networkName,
        registrationId: body.registrationId, expectedGeneration: body.expectedGeneration,
        action: body.action, reviewedTarget, confirmed: true,
        ...(body.action === "enable-plan" ? { backgroundConsent: true } : {}),
      });
      invalidateSiwcWork(state);
      if (result.runtimeStopped !== (body.action !== "enable-plan") ||
          !["confirmed", "unconfirmed", "not-applicable"].includes(result.revocation)) {
        throw Object.assign(new Error("The VPS owner result was not confirmed."), { statusCode: 502 });
      }
      const updated = copySiwcAccountView(result.account);
      if (body.action === "sign-out" && updated.session === "signed-out" && updated.planEnabled === false) {
        state.vpsStoppedOwnerReview = { account: updated, reviewedTarget,
          expiresAt: Date.now() + 5 * 60_000 };
      }
      sendJson(response, 200, {
        account: updated, revocation: result.revocation, runtimeStopped: result.runtimeStopped,
      });
    } finally {
      credentialOperation?.release();
      if (releaseMutation) {
        detachVpsConnection(state, connection);
        releaseMutation();
      }
      connectionUse.release();
    }
    return;
  }

  if (path === "/api/siwc/vps/runtime-update/review" || path === "/api/siwc/vps/runtime-update/apply") {
    requireLiveLocalAction(state, "VPS ChatGPT sidecar update");
    enforceRateLimit(state, path);
    const applying = path.endsWith("/apply");
    requireExactRequestBody(body, applying ? ["reviewId", "confirmed"] : ["containerName", "networkName", "registrationId"],
      "Review this exact installed sidecar before updating it.");
    // Also refuses while a ChatGPT sign-in or credential change is in flight.
    rejectActiveVpsMutation(state);
    const pending = applying ? state.vpsRuntimeUpdateReview : null;
    if (applying) {
      state.vpsRuntimeUpdateReview = null;
      if (body.confirmed !== true || !pending || pending.expiresAt <= Date.now() ||
          !tokenMatches(body.reviewId, pending.reviewId)) {
        throw Object.assign(new Error("Review and confirm this sidecar update again."),
          { statusCode: 409, recovery: "review-again" });
      }
    }
    const containerName = applying ? pending.reviewedTarget.containerName : body.containerName;
    const networkName = applying ? pending.reviewedTarget.networkName : body.networkName;
    requireDiscoveredNetwork(state, containerName, networkName);
    const registrationId = applying ? pending.registrationId : requireSiwcId(body.registrationId);
    const ownerTarget = requireReviewedVpsOwnerTarget(state, containerName, networkName);
    if (applying && ![...VPS_OWNER_TARGET_FIELDS, "n8nContainerId", "networkId"].every(
      (key) => ownerTarget[key] === pending.reviewedTarget[key])) {
      throw Object.assign(new Error("Review this VPS owner and destination again."),
        { statusCode: 409, recovery: "review-again" });
    }
    const reviewedTarget = applying ? pending.reviewedTarget : ownerTarget;
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    let operation;
    let releaseMutation;
    try {
      requireFullVpsScope(connection);
      if (!applying) {
        operation = acquireVpsCredentialOperation(state, "runtime-update-review");
        state.vpsRuntimeUpdateReview = null;
        const review = await state.services.reviewVpsSiwcRuntimeUpdate({
          remote: connection, networkName, reviewedTarget, registrationId,
        });
        if (review?.rebuildRequired === false) {
          sendJson(response, 200, { rebuildRequired: false });
          return;
        }
        if (review?.rebuildRequired !== true || review.registrationId !== registrationId ||
            typeof review.continuing !== "boolean" || !/^[a-z][a-z0-9-]{0,63}$/u.test(review.stage ?? "") ||
            !/^[a-f0-9]{64}$/u.test(review.containerId ?? "") ||
            !/^sha256:[a-f0-9]{64}$/u.test(review.imageId ?? "") ||
            !Array.isArray(review.changedFiles) || review.changedFiles.some((file) => typeof file !== "string" ||
              !/^[A-Za-z0-9._-]{1,128}(?:\/[A-Za-z0-9._-]{1,128}){0,15}$/u.test(file) ||
              file.split("/").some((part) => part === "." || part === ".."))) {
          throw Object.assign(new Error("The sidecar update review is invalid."), { statusCode: 502 });
        }
        const reviewId = randomUUID();
        state.vpsRuntimeUpdateReview = { reviewId, review, reviewedTarget, registrationId,
          expiresAt: Date.now() + 5 * 60_000 };
        sendJson(response, 200, { reviewId, stage: review.stage, continuing: review.continuing,
          changedFiles: [...review.changedFiles], rebuildRequired: true,
          imageId: review.imageId.slice(0, 19), containerId: review.containerId.slice(0, 12) });
        return;
      }
      releaseMutation = acquireVpsMutationLock(state);
      const result = await state.services.updateVpsSiwcRuntime({
        remote: connection, networkName, reviewedTarget, registrationId, review: pending.review, confirmed: true,
      });
      invalidateSiwcWork(state);
      const account = copySiwcAccountView(result?.account);
      if (result.registrationId !== registrationId || account.registrationId !== registrationId ||
          account.ownership !== "owned" || result.runtimeState !== "running" || result.keyChanged !== false) {
        throw Object.assign(new Error("The sidecar update result was not confirmed."), { statusCode: 502 });
      }
      sendJson(response, 200, { account, runtimeState: "running", keyChanged: false });
    } finally {
      operation?.release();
      if (releaseMutation) {
        detachVpsConnection(state, connection);
        releaseMutation();
      }
      connectionUse.release();
    }
    return;
  }

  if (["/api/siwc/vps/images/status", "/api/siwc/vps/images/action", "/api/siwc/vps/images/login-status"].includes(path)) {
    requireLiveLocalAction(state, "VPS image generation");
    const checking = path.endsWith("/images/status");
    const polling = path.endsWith("/login-status");
    const action = checking ? null : polling ? "login-poll" : body?.action;
    // ponytail: 5 s polls over a 15-minute code would exhaust the shared 10-per-15-minute limit.
    // Polls are bounded instead by a stored pending sign-in, single-flight use and the code expiry.
    if (!polling) enforceRateLimit(state, path);
    requireExactRequestBody(body, checking ? ["containerName", "networkName", "registrationId"]
      : polling ? [] : ["action", "confirmed"], "Check this installed account's image generation again.");
    if (!checking && !polling && (!["login-start", "login-cancel", "sign-out"].includes(action) ||
        typeof body.confirmed !== "boolean" || (action !== "login-cancel" && body.confirmed !== true))) {
      throw Object.assign(new Error("Confirm this image sign-in change first."), { statusCode: 400 });
    }
    rejectActiveVpsMutation(state);
    const stored = checking ? null : requireVpsAddonTarget(state, "vpsImagesTarget",
      "Check the installed account's image generation again.", { pending: polling });
    const containerName = stored ? stored.reviewedTarget.containerName : body.containerName;
    const networkName = stored ? stored.reviewedTarget.networkName : body.networkName;
    requireDiscoveredNetwork(state, containerName, networkName);
    const registrationId = stored ? stored.registrationId : requireSiwcId(body.registrationId);
    const reviewedTarget = stored ? stored.reviewedTarget
      : requireReviewedVpsOwnerTarget(state, containerName, networkName);
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    let operation;
    let releaseMutation;
    let detach = action === "sign-out";
    try {
      requireFullVpsScope(connection);
      if (checking || polling) {
        operation = acquireVpsCredentialOperation(state, polling ? "images-login-poll" : "images-status");
      } else releaseMutation = acquireVpsMutationLock(state);
      if (checking) state.vpsImagesTarget = null;
      const result = checking
        ? await state.services.getVpsCodexImagesStatus({ remote: connection, networkName, reviewedTarget, registrationId })
        : await state.services.changeVpsCodexImages({ remote: connection, networkName, reviewedTarget, registrationId,
          action, expectedContainerId: stored.containerId, confirmed: polling ? false : body.confirmed });
      const view = copyVpsImagesStatus(result);
      detach ||= polling && view.state !== "pending";
      state.vpsImagesTarget = detach ? null : { reviewedTarget, registrationId, containerId: result.containerId,
        pending: view.state === "pending", expiresAt: Date.now() + VPS_ADDON_TARGET_MS };
      sendJson(response, 200, view);
    } finally {
      operation?.release();
      if (detach) detachVpsConnection(state, connection);
      releaseMutation?.();
      connectionUse.release();
    }
    return;
  }

  if (path === "/api/siwc/vps/models/status" || path === "/api/siwc/vps/models/checks") {
    requireLiveLocalAction(state, "VPS model discovery");
    enforceRateLimit(state, path);
    const checking = path.endsWith("/status");
    requireExactRequestBody(body, checking ? ["containerName", "networkName", "registrationId"] : ["enabled", "confirmed"],
      "Check this installed account's models again.");
    if (!checking && (typeof body.enabled !== "boolean" || body.confirmed !== true)) {
      throw Object.assign(new Error("Confirm this model check change first."), { statusCode: 400 });
    }
    rejectActiveVpsMutation(state);
    const stored = checking ? null
      : requireVpsAddonTarget(state, "vpsModelsTarget", "Check the installed account's models again.");
    const containerName = stored ? stored.reviewedTarget.containerName : body.containerName;
    const networkName = stored ? stored.reviewedTarget.networkName : body.networkName;
    requireDiscoveredNetwork(state, containerName, networkName);
    const registrationId = stored ? stored.registrationId : requireSiwcId(body.registrationId);
    const reviewedTarget = stored ? stored.reviewedTarget
      : requireReviewedVpsOwnerTarget(state, containerName, networkName);
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    let operation;
    let releaseMutation;
    try {
      requireFullVpsScope(connection);
      if (checking) {
        operation = acquireVpsCredentialOperation(state, "models-status");
        state.vpsModelsTarget = null;
      } else releaseMutation = acquireVpsMutationLock(state);
      const result = checking
        ? await state.services.getVpsModelDiscovery({ remote: connection, networkName, reviewedTarget, registrationId })
        : await state.services.changeVpsModelChecks({ remote: connection, networkName, reviewedTarget, registrationId,
          enabled: body.enabled, expectedContainerId: stored.containerId, confirmed: true });
      const view = copyVpsModelsStatus(result);
      if (!checking && view.checksEnabled !== body.enabled) {
        throw Object.assign(new Error("The model check change was not confirmed."), { statusCode: 502 });
      }
      // An older sidecar cannot change model checks, so its status leaves no target.
      state.vpsModelsTarget = view.state === "available" ? { reviewedTarget, registrationId,
        containerId: result.containerId, expiresAt: Date.now() + VPS_ADDON_TARGET_MS } : null;
      sendJson(response, 200, view);
    } finally {
      operation?.release();
      releaseMutation?.();
      connectionUse.release();
    }
    return;
  }

  if (path === "/api/siwc/vps/usage/status") {
    requireLiveLocalAction(state, "VPS usage status");
    enforceRateLimit(state, path);
    requireExactRequestBody(body, ["containerName", "networkName", "registrationId"],
      "Check this installed account's usage again.");
    rejectActiveVpsMutation(state);
    requireDiscoveredNetwork(state, body.containerName, body.networkName);
    const registrationId = requireSiwcId(body.registrationId);
    const reviewedTarget = requireReviewedVpsOwnerTarget(state, body.containerName, body.networkName);
    const connectionUse = acquireVpsConnectionUse(state);
    let operation;
    try {
      requireFullVpsScope(connectionUse.connection);
      operation = acquireVpsCredentialOperation(state, "usage-status");
      // Read-only: the sidecar's stored record becomes the bounded view here; nothing on the VPS changes.
      const record = await state.services.getVpsUsageStatus({ remote: connectionUse.connection,
        networkName: body.networkName, reviewedTarget, registrationId });
      sendJson(response, 200, usageView(record, { registrationId }));
    } finally {
      operation?.release();
      connectionUse.release();
    }
    return;
  }

  if (path === "/api/plan") {
    rejectActiveVpsMutation(state);
    const connectionUse = acquireVpsConnectionUse(state);
    let credentialOperation;
    try {
      requireFullVpsScope(connectionUse.connection);
      requireDiscoveredNetwork(
        state,
        body.containerName,
        body.networkName,
      );
      credentialOperation = acquireVpsCredentialOperation(
        state,
        "plan-snapshot",
      );
      const sessionSnapshot = {
        connection: connectionUse.connection,
        lifecycleGeneration: state.vpsLifecycleGeneration,
        discoveryGeneration: state.vpsDiscoveryGeneration,
      };
      state.sidecarPlan = null;
      invalidateSuperGrokPlan(state);
      invalidateLocalModelVpsPlan(state);
      const account = requireVpsPlanAuthStatus(
        await selectedSiwcAccount(state, { requirePlan: true }),
        "Enable ChatGPT plan use for the selected account before reviewing this sidecar plan.",
      );
      const authBinding = await siwcBinding(state, account);
      const reviewedTarget = Object.freeze({ ...state.connectionIdentity,
        containerName: body.containerName, networkName: body.networkName,
        ...await state.services.reviewVpsSiwcTarget({
          remote: connectionUse.connection, containerName: body.containerName, networkName: body.networkName,
        }) });
      const installed = await state.services.getVpsSiwcInstallationStatus({
        remote: connectionUse.connection, networkName: body.networkName, reviewedTarget,
      });
      let legacyBinding = null;
      let existingBinding = null;
      if (installed?.state === "legacy") {
        legacyBinding = await state.services.reviewVpsLegacyMigration({
          remote: connectionUse.connection, networkName: body.networkName, reviewedTarget,
        });
      } else if (installed?.state === "stopped") {
        const previous = state.vpsStoppedOwnerReview;
        if (installed.registrationId !== previous?.account?.registrationId ||
            previous.account.session !== "signed-out" || previous.account.planEnabled !== false ||
            previous.expiresAt <= Date.now() ||
            !["host", "port", "fingerprint", "username", "authentication", "privilege",
              "loginUid", "effectiveUid", "containerName", "networkName", "n8nContainerId", "networkId"].every(
              (key) => previous.reviewedTarget[key] === reviewedTarget[key])) {
          throw Object.assign(new Error("Inspect the stopped, signed-out owner before reviewing replacement."),
            { statusCode: 409, recovery: "review-again" });
        }
        const bound = await state.services.reviewVpsSiwcReplacement({
          remote: connectionUse.connection, networkName: body.networkName, reviewedTarget,
        });
        if (bound.registrationId !== previous.account.registrationId ||
            bound.registrationId === account.registrationId) {
          throw Object.assign(new Error("The installed owner or selected new account changed."), { statusCode: 409 });
        }
        existingBinding = Object.freeze({ ...bound, ownerHostId: previous.account.ownerHostId,
          expectedGeneration: previous.account.generation });
      } else if (installed?.state !== "absent") {
        const detail = {
          staged: "An earlier installation on this server was interrupted. Open Recover a transfer or staged installation to resume it.",
          partial: "An earlier migration on this server started but did not finish. Open Recover a transfer or staged installation.",
          owned: "A ChatGPT plan sidecar is already installed and running here. To update it, open Manage the installed ChatGPT session and review the sidecar update.",
          updating: "A sidecar update on this server was interrupted. Open Manage the installed ChatGPT session to finish it.",
        }[installed?.state] ?? "The installed sidecar must be signed out or manually recovered before another write.";
        throw Object.assign(new Error(detail),
          { statusCode: 409, recovery: "review-again", code: `vps_sidecar_${installed?.state ?? "unknown"}` });
      }
      requireCurrentVpsCredentialOperation(
        state,
        credentialOperation.operation,
      );
      requireUnchangedVpsSession(state, sessionSnapshot, {
        allowCredentialSnapshot: true,
      });
      state.sidecarPlan = {
        planId: randomUUID(),
        containerName: body.containerName,
        networkName: body.networkName,
        authBinding,
        account,
        reviewedTarget,
        legacyBinding,
        existingBinding,
      };
      sendJson(response, 200, {
        planId: state.sidecarPlan.planId,
        installDirectory: "/docker/n8n-openai-oauth",
        operationLockPath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock",
        temporaryBuildStatePath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx",
        sidecarProject: "n8n-openai-oauth",
        endpointHostname: SIDECAR_HOSTNAME,
        networkName: body.networkName,
        containerName: body.containerName,
        n8nContainerId: reviewedTarget.n8nContainerId,
        networkId: reviewedTarget.networkId,
        account: copySiwcAccountView(account),
        ...(legacyBinding ? { migrationRequired: true, legacyResourcesPreserved: true,
          requiresMigrationConsent: true } : {}),
        ...(existingBinding ? { replacementRequired: true, oldSessionSignedOut: true,
          oldHistoryRetained: true, requiresReplacementConsent: true } : {}),
        existingN8nChanges: [],
        existingN8nRestarts: 0,
        publishedPorts: [],
      });
    } finally {
      credentialOperation?.release();
      connectionUse.release();
    }
    return;
  }

  if (path === "/api/assistant/plan") {
    rejectActiveVpsMutation(state);
    const connectionUse = acquireVpsConnectionUse(state);
    try {
      requireFullVpsScope(connectionUse.connection);
      const includeSearxng = requireAssistantSearxngSelection(body.includeSearxng);
      requireDiscoveredNetwork(
        state,
        body.containerName,
        body.networkName,
      );
      const instanceAi = requireEnabledInstanceAi(state, body.containerName);
      state.assistantPlan = null;
      invalidateSuperGrokPlan(state);
      invalidateLocalModelVpsPlan(state);
      state.assistantPlan = {
        planId: randomUUID(),
        containerName: body.containerName,
        networkName: body.networkName,
        includeSearxng,
        instanceAi,
      };
      sendJson(response, 200, {
        planId: state.assistantPlan.planId,
        installDirectory: ASSISTANT_ROOT,
        companionProject: "generated ownership-bound project after confirmation",
        sandboxUrl: "generated after verified installation",
        includeSearxng,
        webSearch: includeSearxng ? "enabled" : "disabled",
        ...(includeSearxng ? { searxngUrl: "generated after verified installation" } : {}),
        networkName: body.networkName,
        instanceAi,
        existingN8nChanges: [],
        existingN8nRestarts: 0,
        publishedPorts: [],
        privilegedRunner: true,
        preview: true,
      });
    } finally {
      connectionUse.release();
    }
    return;
  }

  if (path === "/api/assistant/install") {
    rejectActiveVpsMutation(state);
    enforceRateLimit(state, path);
    const includeSearxng = requireAssistantSearxngSelection(body.includeSearxng);
    const reviewedPlan = state.assistantPlan;
    requireReviewedVpsPlan(reviewedPlan, body, "AI Assistant");
    requireDiscoveredNetwork(
      state,
      body.containerName,
      body.networkName,
    );
    requireReviewedAssistantPlan(state, reviewedPlan, body);
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    requireFullVpsScope(connection);
    state.assistantPlan = null;
    const releaseVpsMutationLock = acquireVpsMutationLock(state);
    try {
      const freshNetworks = await state.services.discoverNetworks(
        connection,
        body.containerName,
      );
      requireFreshAssistantInstallState(reviewedPlan, freshNetworks, body);
      const result = await state.services.installAssistant({
        remote: connection,
        networkName: body.networkName,
        confirmed: body.confirmed,
        includeSearxng,
      });
      sendJson(
        response,
        200,
        createSafeAssistantInstallResult(result, reviewedPlan),
      );
    } finally {
      detachVpsConnection(state, connection);
      releaseVpsMutationLock();
      connectionUse.release();
    }
    return;
  }

  if (path === "/api/install") {
    rejectActiveVpsMutation(state);
    enforceRateLimit(state, path);
    const reviewedPlan = state.sidecarPlan;
    requireExactRequestBody(body,
      ["planId", "containerName", "networkName", "confirmed", "backgroundConsent",
        ...(reviewedPlan?.legacyBinding ? ["migrationConsent"] : []),
        ...(reviewedPlan?.existingBinding ? ["replacementConsent"] : [])],
      "Confirm the reviewed ChatGPT account and background n8n use.");
    if (body.confirmed !== true || body.backgroundConsent !== true ||
        (reviewedPlan?.legacyBinding && body.migrationConsent !== true) ||
        (reviewedPlan?.existingBinding && body.replacementConsent !== true)) {
      throw Object.assign(new Error("Approve the reviewed destination, background use, and any separate migration or replacement."), { statusCode: 400 });
    }
    requireReviewedVpsPlan(reviewedPlan, body, "sidecar");
    requireDiscoveredNetwork(
      state,
      body.containerName,
      body.networkName,
    );
    const connectionUse = acquireVpsConnectionUse(state);
    const { connection } = connectionUse;
    requireFullVpsScope(connection);
    state.sidecarPlan = null;
    const releaseVpsMutationLock = acquireVpsMutationLock(state);
    let result;
    try {
      if (reviewedPlan.resume) await requireRecoveryBinding(state, reviewedPlan.sourceBinding);
      else await requireMatchingSiwcBinding(state, reviewedPlan.authBinding);
      result = await state.services.installSidecar({
        remote: connection,
        networkName: body.networkName,
        registration: { storageRoot: state.storageRoot, registrationId: reviewedPlan.authBinding.registrationId },
        authBinding: reviewedPlan.authBinding,
        reviewedTarget: reviewedPlan.reviewedTarget,
        confirmed: true,
        ...(reviewedPlan.resume ? { resume: reviewedPlan.resume } : {}),
        backgroundConsent: { acceptedAt: new Date().toISOString(), noticeVersion: "siwc-vps-2026-10-04" },
        ...(reviewedPlan.legacyBinding ? { migrationConsent: true,
          legacyBinding: reviewedPlan.legacyBinding } : {}),
        ...(reviewedPlan.existingBinding ? { replacementConsent: true,
          existingBinding: reviewedPlan.existingBinding } : {}),
      });
    } finally {
      detachVpsConnection(state, connection);
      releaseVpsMutationLock();
      connectionUse.release();
    }

    if (!result || result.baseUrl !== "http://n8n-openai-oauth:10531/v1" ||
        typeof result.clientCredential !== "string" ||
        !/^[A-Za-z0-9_-]{32,256}$/u.test(result.clientCredential) ||
        result.credentialShownOnce !== true ||
        !["installed", "migrated", "replaced", "partial"].includes(result.deploymentMode) ||
        (result.deploymentMode === "migrated" && (result.migratedLegacy !== true || result.legacyRetained !== true ||
          !(reviewedPlan.resume
            ? reviewedPlan.resume.deploymentMode === result.deploymentMode
            : reviewedPlan.legacyBinding))) ||
        (result.deploymentMode === "replaced" && (result.replacedAccount !== true ||
          !(reviewedPlan.resume
            ? reviewedPlan.resume.deploymentMode === result.deploymentMode
            : reviewedPlan.existingBinding))) ||
        (result.deploymentMode === "partial" && !result.runtimeFailure && !result.finalizationFailure) ||
        (result.hostPublication !== "none" &&
          !(result.deploymentMode === "partial" && result.runtimeState === "unknown" &&
            result.hostPublication === "unknown")) ||
        result.account?.registrationId !== reviewedPlan.authBinding.registrationId ||
        !Array.isArray(result.models) || result.models.some((model) =>
          typeof model !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(model))) {
      throw Object.assign(new Error("The sidecar returned an invalid installation result."), { statusCode: 502 });
    }
    sendJson(response, 200, {
      baseUrl: result.baseUrl, clientCredential: result.clientCredential,
      credentialShownOnce: true, models: result.models, deploymentMode: result.deploymentMode,
      hostPublication: result.hostPublication,
      account: copySiwcAccountView(result.account),
      ...copySiwcReadiness(result),
      ...(result.migratedLegacy === true ? { migratedLegacy: true, legacyRetained: result.legacyRetained === true } : {}),
      ...(result.replacedAccount === true ? { replacedAccount: true } : {}),
    });
    return;
  }

  if (path === "/api/disconnect") {
    rejectUnsafeVpsDisconnect(state);
    detachVpsConnection(state, state.connection, { clearScannedHost: true });
    sendJson(response, 200, { disconnected: true });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function persistentControlBusy(state) {
  return Boolean(
    state.localInstallInFlight ||
    state.localCredentialRotationInFlight ||
    getPendingLocalCredentialRotation(state) ||
    state.vpsFingerprintOperation ||
    state.vpsConnectionOperation ||
    state.vpsConnectionUses.size > 0 ||
    state.vpsMutationInFlight ||
    state.vpsCredentialOperation ||
    oauthCredentialOperationInFlight(state)
  );
}

function requireControlToken(request, state) {
  if (!tokenMatches(request.headers["x-relmio-control"], state.controlToken)) {
    throw Object.assign(new Error("Unauthorized."), { statusCode: 401 });
  }
}

async function handleBrowserBootstrap(request, response, path, state) {
  if (path === BROWSER_PREPARE_PATH) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    requireApiToken(request, state);
    requireSameOrigin(request, state);
    const body = await readJsonBody(request);
    if (!exactObjectKeys(body, ["route"]) || !BROWSER_BOOTSTRAP_ROUTES.has(body.route)) {
      throw Object.assign(new Error("Browser launch route is invalid."), { statusCode: 400 });
    }
    const launchUrl = await prepareBrowserBootstrap(state, body.route);
    sendJson(response, 201, { launchUrl });
    return;
  }

  if (path === BROWSER_BOOTSTRAP_PATH) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (request.headers.origin !== "null") {
      throw Object.assign(new Error("Cross-origin browser launch rejected."), { statusCode: 403 });
    }
    let body;
    try { body = await readFormBody(request); } catch {
      throw genericBrowserBootstrapFailure(state);
    }
    const route = consumeBrowserBootstrap(state, body);
    sendBrowserBootstrapHtml(response, state, route);
    return;
  }

  if (path === BROWSER_TRANSFER_PATH) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (request.headers.origin !== state.origin) {
      throw Object.assign(new Error("Cross-origin browser transfer rejected."), {
        statusCode: 403,
      });
    }
    let body;
    try { body = await readJsonBody(request); } catch {
      throw genericBrowserTransferFailure(state);
    }
    const sessionToken = consumeBrowserTransfer(state, body);
    sendJson(response, 200, { sessionToken });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function handlePersistentControl(request, response, path, state) {
  if (!state.controlToken) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  requireControlToken(request, state);

  if (request.method === "GET" && path === "/__relmio/control/status") {
    sendJson(response, 200, {
      kind: "relmio-dashboard-control",
      protocolVersion: 1,
      packageVersion: PACKAGE_VERSION,
      instanceId: state.controlInstanceId,
      pid: process.pid,
      origin: state.origin,
    });
    return;
  }

  if (request.method === "POST" && path === "/__relmio/control/stop") {
    if (persistentControlBusy(state)) {
      throw Object.assign(
        new Error(
          "Relmio is completing another operation. Wait for it to finish before stopping the dashboard.",
        ),
        { statusCode: 409 },
      );
    }
    sendJson(response, 202, {
      stopping: true,
      instanceId: state.controlInstanceId,
    });
    if (!state.controlStopRequested) {
      state.controlStopRequested = true;
      setImmediate(() => {
        try {
          state.onControlStop();
        } catch {
          // The daemon owns shutdown reporting after this response is sent.
        }
      });
    }
    return;
  }

  if (!["GET", "POST"].includes(request.method)) {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

function createRequestHandler(state) {
  return async (request, response) => {
    setSecurityHeaders(response);
    let path;

    try {
      if (state.closing) {
        sendJson(response, 503, { error: "The local wizard is closing." });
        return;
      }
      const url = new URL(request.url, state.origin);
      path = url.pathname;

      if (path.startsWith("/__relmio/browser/")) {
        await handleBrowserBootstrap(request, response, path, state);
        return;
      }

      if (path.startsWith("/__relmio/control/")) {
        await handlePersistentControl(request, response, path, state);
        return;
      }

      if (path.startsWith("/api/")) {
        await handleApi(request, response, path, state);
        return;
      }

      if (request.method !== "GET" || !(path in state.uiFiles)) {
        if (
          request.method === "GET" &&
          !path.startsWith("/api/") &&
          request.headers.accept?.split(",").some((entry) => entry.trim().split(";", 1)[0] === "text/html")
        ) {
          const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page not found | Relmio</title>
  <link rel="stylesheet" href="/relmio-ui.css">
</head>
<body class="rm-app rm-app--fit">
  <main id="main-content" class="rm-app__main">
    <div class="rm-container rm-split">
      <section class="rm-panel">
        <div class="rm-panel__header">
          <div class="rm-panel__heading">
            <h1 class="rm-h1">Page not found</h1>
            <p class="rm-muted">This address is not part of the Relmio wizard.</p>
          </div>
        </div>
        <div class="rm-panel__body"><p>Wizard pages open only through the private link Relmio gives your browser. Go back to your Relmio tab, or run <code>relmio open</code> in a terminal to start a new session.</p></div>
      </section>
    </div>
  </main>
</body>
</html>`;
          response.writeHead(404, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(html),
          });
          response.end(html);
        } else {
          sendJson(response, 404, { error: "Not found." });
        }
        return;
      }

      const contentType =
        path.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : path.endsWith(".svg")
            ? "image/svg+xml; charset=utf-8"
            : path.endsWith(".png")
              ? "image/png"
              : path.endsWith(".css")
                ? "text/css; charset=utf-8"
                : path.endsWith(".woff2")
                  ? "font/woff2"
                  : "text/html; charset=utf-8";
      const contents = state.uiFiles[path];
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(contents),
      });
      response.end(contents);
    } catch (error) {
      if (!response.headersSent) {
        const managedPartialStack =
          error?.code === LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE;
        const retryableStackStartup =
          error?.code === LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE;
        const retryableNgrokSetup =
          retryableStackStartup &&
          error?.failureKind ===
            LOCAL_N8N_STACK_NGROK_SETUP_REJECTED_FAILURE_KIND;
        const failure = safeFailure(error);
        sendJson(response, failure.status, {
          ...failure,
          error: managedPartialStack
            ? "Relmio confirmed that its owned partial local n8n + ngrok stack remains. Use the explicit removal control to retry cleanup safely."
            : failure.error,
          ...(error.retryablePlan === true ? { retryablePlan: true } : {}),
          ...(retryableNgrokSetup ? { retryableNgrokSetup: true } : {}),
          ...(managedPartialStack ? { managedPartialStack: true } : {}),
        });
      } else {
        response.end();
      }
    }
  };
}

export async function startWizardServer({
  sessionToken,
  storageRoot = resolveSiwcStorageRoot(),
  runtimeId = "local",
  services = defaultServices,
  uiFiles,
  port = 0,
  previewMode = false,
  previewFixture = null,
  oauthShutdownWaitMs = OAUTH_SHUTDOWN_WAIT_MS,
  vpsConnectionIdleMs = VPS_CONNECTION_IDLE_MS,
  controlToken = null,
  controlInstanceId = null,
  onControlStop = null,
  browserHandoffRoot = null,
  browserBootstrapTtlMs = BROWSER_BOOTSTRAP_TTL_MS,
  maxPendingBrowserBootstraps = MAX_PENDING_BROWSER_BOOTSTRAPS,
  browserTransferTtlMs = BROWSER_TRANSFER_TTL_MS,
  maxPendingBrowserTransfers = MAX_PENDING_BROWSER_TRANSFERS,
  createBrowserHandoff = createPrivateBrowserHandoff,
  randomBytes = createRandomBytes,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof sessionToken !== "string" || sessionToken.length < 32) {
    throw new TypeError("A strong wizard session token is required.");
  }
  if (typeof storageRoot !== "string" || !isAbsolute(storageRoot) ||
      typeof runtimeId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(runtimeId)) {
    throw new TypeError("The SIWC host storage and runtime must be trusted.");
  }
  if (previewFixture !== null && (!previewMode ||
      !["signed-out", "connected", "reauthorize", "plan-not-granted", "usage-limit", "handoff-pending", "staged"].includes(previewFixture))) {
    throw new TypeError("Select a valid sanitized preview fixture.");
  }
  if (!Number.isSafeInteger(vpsConnectionIdleMs) || vpsConnectionIdleMs < 1) {
    throw new TypeError("The VPS connection idle timeout must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(browserBootstrapTtlMs) || browserBootstrapTtlMs < 1 ||
    browserBootstrapTtlMs > BROWSER_BOOTSTRAP_TTL_MS ||
    !Number.isSafeInteger(maxPendingBrowserBootstraps) ||
    maxPendingBrowserBootstraps < 1 || maxPendingBrowserBootstraps > 32 ||
    !Number.isSafeInteger(browserTransferTtlMs) || browserTransferTtlMs < 1 ||
    browserTransferTtlMs > BROWSER_TRANSFER_TTL_MS ||
    !Number.isSafeInteger(maxPendingBrowserTransfers) ||
    maxPendingBrowserTransfers < 1 || maxPendingBrowserTransfers > 32 ||
    typeof createBrowserHandoff !== "function" || typeof randomBytes !== "function" ||
    typeof now !== "function" || typeof setTimer !== "function" ||
    typeof clearTimer !== "function" ||
    (browserHandoffRoot !== null && typeof browserHandoffRoot !== "string")
  ) {
    throw new TypeError("The private browser bootstrap adapter is invalid.");
  }
  const controlConfigured =
    controlToken !== null ||
    controlInstanceId !== null ||
    onControlStop !== null;
  if (
    controlConfigured &&
    (
      typeof controlToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(controlToken) ||
      typeof controlInstanceId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(controlInstanceId) ||
      typeof onControlStop !== "function"
    )
  ) {
    throw new TypeError("The persistent dashboard stop handler is invalid.");
  }

  const resolvedServices = { ...defaultServices, ...services };
  const state = {
    sessionToken,
    storageRoot,
    runtimeId,
    services: resolvedServices,
    localChatTest:
      resolvedServices.localChatTest ??
      resolvedServices.createLocalChatTestService(),
    uiFiles: uiFiles ?? (await loadDefaultUiFiles()),
    origin: "http://127.0.0.1",
    connection: null,
    connectionIdentity: null,
    vpsConnectionIdleMs,
    vpsConnectionIdleExpiry: null,
    vpsConnectionUses: new Set(),
    scannedHost: null,
    vpsFingerprintGeneration: 0,
    vpsFingerprintOperation: null,
    vpsConnectionOperation: null,
    vpsLifecycleGeneration: 0,
    vpsDiscoveryGeneration: 0,
    discovery: null,
    networksByContainer: new Map(),
    sidecarPlan: null,
    vpsStoppedOwnerReview: null,
    vpsOwnerTargetReview: null,
    vpsRuntimeUpdateReview: null,
    vpsImagesTarget: null,
    vpsModelsTarget: null,
    assistantPlan: null,
    supergrokPlan: null,
    supergrokPlanGeneration: 0,
    localModelVpsPlan: null,
    localModelVpsPlanGeneration: 0,
    localModelActionReview: null,
    vpsMutationInFlight: false,
    vpsMutationLock: null,
    vpsMutationCompletion: null,
    vpsCredentialOperation: null,
    oauthLogin: null,
    oauthRetryBlocked: false,
    oauthStartupError: null,
    oauthLoginStartInFlight: false,
    oauthLoginStartPromise: null,
    oauthCredentialOperation: null,
    localDashboardGeneration: 0,
    localPlan: null,
    localStoppedOwnerReview: null,
    siwcRecoveryReview: null,
    localAssistantSearxngReview: null,
    localInstalledTarget: null,
    localInstallInFlight: false,
    localCredentialRotationInFlight: false,
    localCredentialRotationPending: null,
    rateLimits: new Map(),
    previewMode: previewMode === true,
    previewFixture,
    controlToken,
    controlInstanceId,
    onControlStop,
    controlStopRequested: false,
    browserHandoffRoot,
    browserBootstrapTtlMs,
    maxPendingBrowserBootstraps,
    browserTransferTtlMs,
    maxPendingBrowserTransfers,
    createBrowserHandoff,
    browserBootstrapRandomBytes: randomBytes,
    browserBootstrapNow: now,
    setBrowserBootstrapTimer: setTimer,
    clearBrowserBootstrapTimer: clearTimer,
    browserBootstrapIds: new Set(),
    browserBootstrapReservations: 0,
    browserBootstraps: new Map(),
    browserTransferIds: new Set(),
    browserTransfers: new Map(),
    oauthShutdownWaitMs,
    closing: false,
  };
  const server = createServer(createRequestHandler(state));
  server.requestTimeout = 330_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  state.origin = `http://127.0.0.1:${address.port}`;

  return {
    origin: state.origin,
    async prepareBrowserLaunch(route) {
      if (state.closing) throw new Error("The local wizard is closing.");
      return await prepareBrowserBootstrap(state, route);
    },
    async close() {
      state.closing = true;
      // Snapshot the mutation before any shutdown await can let its finally
      // block clear the shared state. This exact promise determines whether
      // HTTP close must remain unbounded for this shutdown attempt.
      const vpsMutationCompletion = state.vpsMutationCompletion;
      const browserHandoffDisposals = [];
      for (const [ticketId, record] of state.browserBootstraps) {
        retireBrowserBootstrap(state, ticketId, record);
        browserHandoffDisposals.push(record.disposal);
      }
      for (const [transferId, record] of state.browserTransfers) {
        retireBrowserTransfer(state, transferId, record);
      }
      const serverClose = new Promise((resolve) => server.close(resolve));
      state.localChatTest.dispose?.();
      await waitForBoundedResult(
        Promise.all(browserHandoffDisposals),
        state.oauthShutdownWaitMs,
      );
      await waitForBoundedResult(
        state.oauthLoginStartPromise,
        state.oauthShutdownWaitMs,
      );
      if (state.oauthLogin?.status === "pending") {
        try {
          await cancelOAuthLogin(state, state.oauthLogin);
        } catch {
          // The bounded OAuth cancellation result must not prevent server shutdown.
        }
      }
      if (vpsMutationCompletion) {
        // A signal is not permission to abandon a remote write. Keep the HTTP
        // server, control publication, and daemon lifetime lock owned until
        // the exact in-flight mutation reaches its finally block.
        await vpsMutationCompletion;
      }
      if (!state.vpsMutationCompletion) {
        detachVpsConnection(state, state.connection, {
          clearScannedHost: true,
        });
      }
      if (vpsMutationCompletion) {
        // server.close() settles only after the mutation request has finished.
        // The daemon must not retire its exclusive control state before that
        // point. Other close paths retain their bounded OAuth-startup cleanup.
        await serverClose;
      } else {
        await waitForBoundedResult(serverClose, state.oauthShutdownWaitMs);
      }
    },
  };
}
