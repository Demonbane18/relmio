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
const wizard = await startWizardServer({
  sessionToken,
  services,
  previewMode: true,
});

console.log(`${wizard.origin}/?session=${sessionToken}`);
console.log(
  "Sanitized preview data only; live ChatGPT sign-in is disabled. Press Control+C to stop.",
);

process.once("SIGINT", async () => {
  await wizard.close();
});
