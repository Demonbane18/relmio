import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { createHostingDeploymentPlan } from "../src/domain/hosting-deployment.js";

// start.sh is the Linux container entrypoint (set -eu, ${#SEARXNG_SECRET}).
// Native Windows has no sh, and this child PATH cannot locate one. An absolute
// RELMIO_TEST_POSIX_SHELL is the existing opt-in; content checks stay enabled.
const posixShell = process.platform === "win32"
  ? (process.env.RELMIO_TEST_POSIX_SHELL && isAbsolute(process.env.RELMIO_TEST_POSIX_SHELL)
    ? process.env.RELMIO_TEST_POSIX_SHELL
    : null)
  : "sh";
const posixExecutionSkip = posixShell
  ? false
  : "start.sh is a Linux container POSIX script; native Windows has no sh unless absolute RELMIO_TEST_POSIX_SHELL is set.";

const base = { providerId: "render", component: "model", deploymentId: "abcdef012345", modelId: "qwen3:0.6b", inputs: { region: "frankfurt", plan: "2c-4g", diskGB: 20 } };

function rejectsWithoutEcho(request, secret = "credential-secret-sentinel") {
  assert.throws(() => createHostingDeploymentPlan(request), error => {
    assert.equal(error instanceof TypeError || error instanceof RangeError, true);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
}

test("planning rejects unknown identities, unapproved model tags and malformed request boundaries", () => {
  rejectsWithoutEcho({ ...base, providerId: "not-a-provider" });
  rejectsWithoutEcho({ ...base, component: "openai" });
  rejectsWithoutEcho({ ...base, deploymentId: "ABCDEF012345" });
  rejectsWithoutEcho({ ...base, deploymentId: "abc/../../123" });
  rejectsWithoutEcho({ ...base, modelId: "credential-secret-sentinel" });
  rejectsWithoutEcho({ ...base, extra: "credential-secret-sentinel" });
  rejectsWithoutEcho({ ...base, inputs: { ...base.inputs, command: "credential-secret-sentinel" } });
  rejectsWithoutEcho({ ...base, inputs: { ...base.inputs, region: "frankfurt\nSECRET=x" } });
  rejectsWithoutEcho({ ...base, inputs: { ...base.inputs, diskGB: "20" } });
  rejectsWithoutEcho({ ...base, inputs: Object.assign(Object.create(null), base.inputs, { secret: "credential-secret-sentinel" }) });
  rejectsWithoutEcho({ ...base, modelId: undefined });
  rejectsWithoutEcho({ ...base, inputs: [base.inputs] });
  rejectsWithoutEcho({ ...base, inputs: { ...base.inputs, diskGB: 1 } });
  rejectsWithoutEcho({ providerId: "digitalocean-app", component: "model", deploymentId: base.deploymentId, modelId: base.modelId, inputs: {} });
  rejectsWithoutEcho({ providerId: "render", component: "searxng", deploymentId: base.deploymentId, modelId: base.modelId, inputs: {} });
});

test("selected service memory, storage and region choices reject impossible plans", () => {
  rejectsWithoutEcho({ ...base, inputs: { ...base.inputs, diskGB: 11 } });
  rejectsWithoutEcho({ ...base, inputs: { ...base.inputs, plan: "starter" } });
  rejectsWithoutEcho({ ...base, modelId: "qwen3.5:9b" });
  rejectsWithoutEcho({ providerId: "railway", component: "model", deploymentId: base.deploymentId, modelId: "qwen3.5:9b", inputs: { memoryGB: 4, volumeGB: 10 } });
  rejectsWithoutEcho({ providerId: "fly", component: "model", deploymentId: base.deploymentId, modelId: "qwen3.5:4b", inputs: { region: "fra", cpuKind: "shared", cpus: 2, memoryMB: 4096, volumeGB: 20 } });
  rejectsWithoutEcho({ providerId: "fly", component: "model", deploymentId: base.deploymentId, modelId: base.modelId, inputs: { region: "fra", cpuKind: "shared", cpus: 1, memoryMB: 4096, volumeGB: 20 } });
  rejectsWithoutEcho({ providerId: "fly", component: "model", deploymentId: base.deploymentId, modelId: base.modelId, inputs: { region: "fra", cpuKind: "shared", cpus: 2, memoryMB: 8192, volumeGB: 20 } });
  rejectsWithoutEcho({ providerId: "fly", component: "model", deploymentId: base.deploymentId, modelId: base.modelId, inputs: { region: "fra", cpuKind: "shared", cpus: 3, memoryMB: 4096, volumeGB: 20 } });
  rejectsWithoutEcho({ providerId: "fly", component: "model", deploymentId: base.deploymentId, modelId: base.modelId, inputs: { region: "fra", cpuKind: "shared", cpus: 16, memoryMB: 32768, volumeGB: 20 } });
  rejectsWithoutEcho({ providerId: "fly", component: "searxng", deploymentId: base.deploymentId, inputs: { region: "fra", memoryMB: 4096 } });
});

test("validated manual plan names only new private resources and includes self-contained operating guidance", () => {
  const plan = createHostingDeploymentPlan(base);
  assert.equal(plan.resourceName, "relmio-model-abcdef012345");
  assert.equal(plan.verification, "not-live-tested");
  assert.match(plan.files.find(file => file.name === "INSTRUCTIONS.md").content, /\/api\/pull/u);
  const artifact = plan.files.map(file => file.content).join("\n");
  assert.match(artifact, /ollama\/ollama:0\.34\.4@sha256:/u);
  assert.doesNotMatch(artifact, /(^|\s)(?:10531|privileged:|docker\.sock)(?:\s|$)/u);
  assert.doesNotMatch(artifact, /type:\s*web/u);
  assert.doesNotMatch(artifact, /RENDER_CONNECT_INTERNAL_ADDRESS/u);
  assert.ok(plan.steps.some(step => step.includes("/api/pull")));
  assert.ok(plan.limitations.some(limit => limit.includes("NOT-RUN")));
});

test("Fly creates a valid private volume name for its persistent model cache", () => {
  const plan = createHostingDeploymentPlan({ providerId: "fly", component: "model", deploymentId: base.deploymentId, modelId: base.modelId, inputs: { region: "fra", cpuKind: "shared", cpus: 2, memoryMB: 4096, volumeGB: 20 } });
  const config = plan.files.find(file => file.name === "fly.toml").content;
  assert.match(config, /source = "relmio_model_abcdef012345_data"/u);
  assert.doesNotMatch(config, /\[\[services\]\]|\[http_service\]/u);
});

test("private search startup requires runtime secret and accepts JSON search only on private lane", async (t) => {
  const plan = createHostingDeploymentPlan({ providerId: "fly", component: "searxng", deploymentId: base.deploymentId, inputs: { region: "fra", memoryMB: 1024 } });
  const files = Object.fromEntries(plan.files.map(file => [file.name, file.content]));
  await t.test("startup script exits 1 without echoing a short secret", { skip: posixExecutionSkip }, () => {
    for (const secret of [undefined, "short"]) {
      const result = spawnSync(posixShell, ["-c", files["start.sh"]], {
        env: secret === undefined ? { PATH: "/usr/bin:/bin" } : { PATH: "/usr/bin:/bin", SEARXNG_SECRET: secret },
        encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, /short/u);
    }
  });
  assert.match(files["settings.yml"], /- json/u);
  assert.match(files["Dockerfile"], /USER 977:977/u);
  assert.doesNotMatch(files["fly.toml"], /\[http_service\]|\[\[services\]\]|\[\[mounts\]\]/u);
  assert.doesNotMatch(JSON.stringify(plan), /SEARXNG_SECRET=[^\s"']+/u);
});

test("external Daytona Assistant handoff never serializes an API key or restarts existing n8n", () => {
  const plan = createHostingDeploymentPlan({ providerId: "railway", component: "assistant", deploymentId: base.deploymentId, inputs: {} });
  const text = JSON.stringify(plan);
  assert.match(text, /DAYTONA_API_KEY/u);
  assert.match(text, /instance-ai/u);
  assert.doesNotMatch(text, /DAYTONA_API_KEY=/u);
  assert.equal(plan.files.some(file => file.name === "INSTRUCTIONS.md"), true);
  assert.equal(plan.kind, "manual");
  assert.equal(plan.settings.some(setting => setting.name === "DAYTONA_API_KEY"), false);
});
