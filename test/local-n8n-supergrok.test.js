import assert from "node:assert/strict";
import test from "node:test";
import { createLocalN8nSuperGrokPlan, normalizeLocalN8nSuperGrokPlan, createLocalN8nSuperGrokComposeFile, createLocalN8nSuperGrokDockerfile, createLocalN8nSuperGrokDockerignore } from "../src/domain/local-n8n-supergrok.js";

const selection = {
  dockerHost: "unix:///var/run/docker.sock", n8nContainerId: "a".repeat(64),
  n8nContainerName: "existing-n8n", dockerNetworkId: "b".repeat(64), networkName: "existing_network",
};
const installId = "c".repeat(32);

test("private SuperGrok plan binds exact n8n and network identities without credential inputs", () => {
  const plan = createLocalN8nSuperGrokPlan(selection);
  assert.equal(plan.target, "n8n-supergrok-oauth");
  assert.equal(plan.endpoint, "http://n8n-supergrok:14502/v1");
  assert.equal(plan.hostPublication, "none");
  assert.equal(plan.upstreamAuth, "provider-owned-oauth");
  assert.equal(plan.n8nContainerId, selection.n8nContainerId);
  assert.equal(plan.dockerNetworkId, selection.dockerNetworkId);
  assert.deepEqual(normalizeLocalN8nSuperGrokPlan({ ...plan, disposableHarnessWarning: true }), plan);
  for (const extra of [{ apiKey: "rejected" }, { oauthToken: "rejected" }, { hostPublication: "14502" }, { endpoint: "https://example.test" }, { disposableHarnessWarning: "true" }]) {
    assert.throws(() => normalizeLocalN8nSuperGrokPlan({ ...plan, ...extra }), /invalid/u);
  }
  for (const invalid of [{ n8nContainerId: "n8n" }, { dockerNetworkId: "network" }, { networkName: "network\nports: [14502]" }, { dockerHost: "tcp://example.test:2375" }]) {
    assert.throws(() => createLocalN8nSuperGrokPlan({ ...selection, ...invalid }));
  }
});

test("private compose creates only an OAuth companion on the selected external network", () => {
  const compose = createLocalN8nSuperGrokComposeFile({ installId, networkName: selection.networkName, tokenSha256: "d".repeat(64) });
  assert.match(compose, /^services:\n  supergrok-oauth:/u);
  assert.match(compose, /external: true\n    name: existing_network/u);
  assert.match(compose, /aliases:\n          - n8n-supergrok/u);
  assert.match(compose, /RELMIO_GATEWAY_PRIVATE_HOST: "n8n-supergrok:14502"/u);
  assert.match(compose, /grok-home:\/home\/node\/\.grok/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.match(compose, /cap_drop:\n      - ALL/u);
  assert.doesNotMatch(compose, /(?:^|\n)\s*(?:ports|expose|container_name|privileged|network_mode):/u);
  assert.doesNotMatch(compose, /credential-seed|oauth-auth|auth\.json|docker\.sock|traefik|ngrok|existing-n8n/u);
  assert.throws(() => createLocalN8nSuperGrokComposeFile({ installId, networkName: "network\nports:", tokenSha256: "d".repeat(64) }));
});

test("private image packages the same pinned direct runtime and declares its own ownership", () => {
  const dockerfile = createLocalN8nSuperGrokDockerfile({ installId });
  assert.match(dockerfile, /@xai-official\/grok@1\.0\.13/u);
  assert.match(dockerfile, /COPY --chown=node:node gateway\.js chat\.js session\.js \/app\//u);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/gateway\.js"\]/u);
  assert.match(dockerfile, /io\.relmio\.target="n8n-supergrok-oauth"/u);
  assert.ok(dockerfile.includes(`io.relmio.install="${installId}"`));
  assert.equal(createLocalN8nSuperGrokDockerignore(), "**\n!Dockerfile\n!gateway.js\n!chat.js\n!session.js\n");
});
