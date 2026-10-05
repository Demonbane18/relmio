import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWizardServer } from "../../src/web/server.js";

export const siwcAccount = Object.freeze({
  registrationId: "fixture_registration_1", label: "Test ChatGPT account",
  email: "account@example.test", identity: "verified", session: "connected",
  planPermission: "granted", planEnabled: true, ownership: "owned",
  generation: "68f572d8-2b56-4ef2-a6c2-7791078a1161",
  ownerHostId: "urn:uuid:38031c97-8e16-402b-85f8-6c7eb17e72bb",
  ownerRuntimeId: "local", needsPlanWelcome: false,
});

export function siwcInstallResult(overrides = {}) {
  return {
    baseUrl: "http://n8n-openai-oauth:10531/v1",
    clientCredential: "k".repeat(43), credentialShownOnce: true,
    models: ["listed-model"], deploymentMode: "installed",
    readiness: "verified", runtimeState: "running", hostPublication: "none",
    account: { ...siwcAccount, ownerRuntimeId: "installed-runtime" },
    ...overrides,
  };
}

export function installedChatStatus() {
  return { managed: true, state: "healthy", snapshot: {
    target: "codex-chat", endpoint: "http://127.0.0.1:14501",
    registrationId: siwcAccount.registrationId, migrationRequired: false,
    auth: { configured: true, disclosure: "rotate-only", account: siwcAccount },
    canRotateCredential: true,
  } };
}

export async function startIsolatedWizard(options = {}) {
  const storageRoot = options.storageRoot ?? await mkdtemp(join(tmpdir(), "relmio-wizard-siwc-"));
  return startWizardServer({ ...options, storageRoot, services: {
    async listAuthRegistrations() { return [siwcAccount]; },
    async getSelectedRegistration() { return siwcAccount.registrationId; },
    async getAuthStatus() { return { ...siwcAccount, exists: true }; },
    async readRegistration() { return { ...siwcAccount, clientId: "fixture-client" }; },
    async selectRegistration() {},
    async listSiwcModels() { return [{ slug: "listed-model", display_name: "Listed model" }]; },
    async reviewVpsSiwcTarget() { return { n8nContainerId: "a".repeat(64), networkId: "b".repeat(64) }; },
    async getVpsSiwcInstallationStatus() { return { state: "absent" }; },
    async getLocalN8nSidecarStatus() { return { managed: false, state: "absent" }; },
    async getManagedLocalEndpointStatus() { return { managed: false, state: "absent" }; },
    ...options.services,
  } });
}
