import { randomBytes } from "node:crypto";

import { startWizardServer } from "../src/web/server.js";

const remote = {
  close() {},
};
const previewCredentialUpdatedAt = new Date().toISOString();

const services = {
  async getAuthStatus() {
    return {
      exists: true,
      path: "/preview/auth.json",
      updatedAt: previewCredentialUpdatedAt,
    };
  },
  async startOAuthLogin() {
    const authorizationUrl = new URL(
      "https://auth.openai.com/oauth/authorize",
    );
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "redirect_uri",
      "http://localhost:1455/auth/callback",
    );
    authorizationUrl.searchParams.set("state", "sanitized-preview");
    authorizationUrl.searchParams.set("code_challenge", "sanitized-preview");
    return {
      authorizationUrl: authorizationUrl.toString(),
      completion: Promise.resolve({ success: true }),
      cancel() {},
    };
  },
  async readAuthContents() {
    return Buffer.from('{"preview":true}');
  },
  async scanHostFingerprint() {
    return "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  },
  async connectVerified() {
    return remote;
  },
  async discoverN8n() {
    return {
      dockerVersion: "28.3.2",
      composeVersion: "2.38.2",
      containers: [
        {
          id: "preview",
          image: "docker.n8n.io/n8nio/n8n",
          name: "n8n-n8n-1",
          state: "running",
        },
      ],
    };
  },
  async discoverNetworks() {
    return { networks: ["proxy"], recommended: "proxy" };
  },
  async installSidecar() {
    return {
      baseUrl: "http://n8n-openai-oauth:10531/v1",
      apiKeyPlaceholder: "local-only",
      useResponsesApi: true,
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      deploymentMode: "created",
    };
  },
};

const sessionToken = randomBytes(32).toString("base64url");
const wizard = await startWizardServer({ sessionToken, services });

console.log(`${wizard.origin}/?session=${sessionToken}`);
console.log("Preview data only. Press Control+C to stop.");

process.once("SIGINT", async () => {
  await wizard.close();
});
