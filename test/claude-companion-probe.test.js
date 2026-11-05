import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { startClaudeChatGateway } from "../src/gateway/claude-chat.js";
import { LOCAL_CLAUDE_HEALTH_PROBE, LOCAL_CLAUDE_MODELS_PROBE } from "../src/services/local-n8n-claude-installer.js";
import { VPS_CLAUDE_MODELS_PROBE } from "../src/services/vps-claude.js";
import { createFixtureRuntime } from "./fixtures/claude-child.mjs";

const key = "k".repeat(43);
const wrong = "z".repeat(43);

function runProbe(script, bearer) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`probe timed out\n${stderr}`));
    }, 8000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(bearer);
  });
}

test("in-container Claude probes use Host relmio-claude:14502 against the companion gateway", async (t) => {
  if (process.platform === "win32") { t.skip("Claude gateway requires Unix process groups"); return; }
  const fixture = await createFixtureRuntime();
  const gateway = await startClaudeChatGateway({
    runtime: fixture.runtime,
    tokenVerifier: createHash("sha256").update(key).digest(),
    port: 14502,
    companionHost: "relmio-claude",
    spawnProcess() { throw new Error("a probe must not launch Claude"); },
  });
  t.after(async () => {
    await gateway.close();
    await fixture.dispose();
  });

  const models = await runProbe(LOCAL_CLAUDE_MODELS_PROBE, key);
  assert.equal(models.code, 0, models.stderr);
  assert.deepEqual(JSON.parse(models.stdout), fixture.runtime.models);

  const health = await runProbe(LOCAL_CLAUDE_HEALTH_PROBE, key);
  assert.equal(health.code, 0, health.stderr);
  assert.equal(health.stdout, "ok");

  const denied = await runProbe(LOCAL_CLAUDE_MODELS_PROBE, wrong);
  assert.notEqual(denied.code, 0);

  const vps = await runProbe(VPS_CLAUDE_MODELS_PROBE, key);
  assert.equal(vps.code, 0, vps.stderr);
  assert.deepEqual(JSON.parse(vps.stdout), { status: 200, models: fixture.runtime.models });

  const vpsDenied = await runProbe(VPS_CLAUDE_MODELS_PROBE, wrong);
  assert.equal(JSON.parse(vpsDenied.stdout).status, 401);
});
