import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalN8nModelPlan, LOCAL_MODEL_RUNTIME_IMAGE } from "../src/domain/local-n8n-model.js";
import {
  getLocalN8nModelStatus,
  inspectLocalN8nModelResources,
  installLocalN8nModel,
  reviewLocalN8nModelAction,
  applyLocalN8nModelAction,
  resolveLocalN8nModelInstallRoot,
} from "../src/services/local-n8n-model-installer.js";
import { withTestLocalSecurity } from "./helpers/local-security.js";

const HOST = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
const DRIFTED_UNIX_HOST = "unix:///another/docker.sock";
const N8N = "a".repeat(64), NETWORK = "b".repeat(64), RUNTIME = "c".repeat(64), HELPER = "d".repeat(64);
const IMAGE = `sha256:${"e".repeat(64)}`, HELPER_IMAGE = `sha256:${"f".repeat(64)}`;
const INSTALL = "1".repeat(32), OPERATION = "2".repeat(32), RETRY = "3".repeat(32);
const PROJECT = `relmio-n8n-local-model-${INSTALL}`;
const VOLUME = `${PROJECT}_model-cache`;
const RESOURCE = { memoryBytes: 8 * 1024 ** 3, cpus: 4, diskAvailableBytes: 50 * 1024 ** 3 };
const MODEL = "qwen3:0.6b";
const DIGEST = "sha256:7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435";
const safe = (extra = {}) => withTestLocalSecurity({ env: {}, randomBytes: () => Buffer.from(extra.nextOperation ? RETRY : INSTALL, "hex"), ...extra });
const plan = (overrides = {}) => createLocalN8nModelPlan({ dockerHost: HOST, n8nContainerId: N8N, n8nContainerName: "fixture-n8n", dockerNetworkId: NETWORK, networkName: "fixture-net", modelId: MODEL, hostResources: RESOURCE, ...overrides });
async function home(t) { const root = await fs.mkdtemp(join(tmpdir(), "relmio-model-test-")); t.after(() => fs.rm(root, { recursive: true, force: true })); return fs.realpath(root); }
function status(operation, state, changes = {}) {
  return JSON.stringify({ schema: 1, operationId: operation, modelId: MODEL, state,
    phase: { downloading: "download", verifying: "inference", "model-ready": "complete", "model-error": "error" }[state],
    completedBytes: null, totalBytes: null, blobDigest: null,
    modelDigest: state === "model-ready" ? DIGEST : null,
    inferenceVerified: state === "model-ready", errorCode: state === "model-error" ? "download-failed" : null,
    writerMayBeActive: state === "downloading", updatedAt: "2026-09-26T00:00:00.000Z", ...changes }) + "\n";
}
function runner({ networkOptions = {}, networkFlags = {}, aliasCollision = false, foreignVolume = false, published = false, imageDrift = false, failStart = false, failImagePull = false, failHelperBuild = false, failHelperRun = false, failHelperStop = false, changedContext = false, pruneEnvironment = "1", dockerHost = HOST, diskAvailableBytes = RESOURCE.diskAvailableBytes } = {}) {
  const calls = [];
  let runtime = false, volume = false, helper = false, helperRunning = false, helperState = "downloading", operation = OPERATION, helperExpectedDigest = null, helperImage = false, runtimeImage = false, logChanges = {}, n8nAvailable = true, logsVisible = true, logsFail = false, restartHealthChecks = 0, pendingHealthChecks = 0, runtimeBudgetDrift = {}, helperBudgetDrift = {};
  const projectLabels = { "com.docker.compose.project": PROJECT, "io.relmio.managed": "true", "io.relmio.target": "n8n-local-model", "io.relmio.install": INSTALL };
  const result = async spec => {
    calls.push(spec);
    assert.equal(spec.file, "docker");
    const args = spec.args;
    const at = args.at(-1);
    const ok = (value = "") => ({ code: 0, stdout: typeof value === "string" ? value : `${JSON.stringify(value)}\n`, stderr: "" });
    const absent = () => ({ code: 1, stdout: "", stderr: "not found" });
    if (args[0] === "context" && args[1] === "show") return ok("desktop-linux\n");
    // win32 validateLocalDockerHost accepts only the Linux engine pipe, and it
    // runs before the plan comparison. A drifted inspect must return that pipe.
    if (args[0] === "context") {
      const inspectedHost = changedContext
        ? (process.platform === "win32" ? HOST : DRIFTED_UNIX_HOST)
        : dockerHost;
      return ok(JSON.stringify(inspectedHost));
    }
    assert.equal(spec.dockerHost, dockerHost);
    if (args[0] === "version") return ok("29.0.0\n");
    if (args[0] === "info") return ok({ MemTotal: RESOURCE.memoryBytes, NCPU: RESOURCE.cpus });
    if (args[0] === "run") return ok({ bytes: diskAvailableBytes });
    if (args[0] === "ps" && args.includes("status=running")) return ok({ ID: N8N, Image: "docker.n8n.io/n8nio/n8n:latest" });
    if (args[0] === "ps" && args.includes(`label=com.docker.compose.project=${PROJECT}`)) return ok([...(runtime ? [{ ID: RUNTIME }] : []), ...(helper ? [{ ID: HELPER }] : [])].map(JSON.stringify).join("\n"));
    if (args[0] === "volume" && args[1] === "ls") return ok(volume ? { Name: VOLUME } : "");
    if (args[0] === "container" && args[1] === "inspect") {
      if (at === N8N) return n8nAvailable ? ok({ Id: N8N, Image: IMAGE, Name: "/fixture-n8n", Config: { Image: "docker.n8n.io/n8nio/n8n:latest" }, State: { Running: true }, NetworkSettings: { Networks: { "fixture-net": { NetworkID: NETWORK, Aliases: ["fixture-n8n"] } } } }) : absent();
      if (at === "8".repeat(64)) return ok({ Id: at, Name: "/foreign-model", Config: { Labels: {} }, NetworkSettings: { Networks: { "fixture-net": { NetworkID: NETWORK, Aliases: ["n8n-local-model"] } } } });
      if ((at === RUNTIME || at === `${PROJECT}-local-model-1`) && runtime) return ok({
        Id: RUNTIME, Image: imageDrift ? HELPER_IMAGE : IMAGE, Name: `/${PROJECT}-local-model-1`,
        Config: {
          Image: LOCAL_MODEL_RUNTIME_IMAGE,
          Labels: { ...projectLabels, "com.docker.compose.service": "local-model" },
          Env: [
            "OLLAMA_HOST=0.0.0.0:11434", "OLLAMA_NO_CLOUD=1",
            ...(pruneEnvironment === null ? [] : [`OLLAMA_NOPRUNE=${pruneEnvironment}`]),
            "OLLAMA_MODELS=/root/.ollama/models", `OLLAMA_CONTEXT_LENGTH=${plan().contextTokens}`,
            "OLLAMA_NUM_PARALLEL=1", "OLLAMA_MAX_LOADED_MODELS=1",
            "NVIDIA_VISIBLE_DEVICES=void", "CUDA_VISIBLE_DEVICES=-1",
          ],
        },
        State: { Running: runtime === "running", Status: runtime === "running" ? "running" : "exited", Health: { Status: pendingHealthChecks-- > 0 ? "starting" : "healthy" } },
        HostConfig: {
          PortBindings: published ? { "11434/tcp": [{ HostPort: "11434" }] } : {},
          Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, RestartPolicy: { Name: "unless-stopped" }, PidsLimit: 256,
          Memory: plan().memoryBytes, MemorySwap: plan().memoryBytes, NanoCpus: Math.round(plan().cpus * 1e9), ...runtimeBudgetDrift,
        },
        Mounts: [{ Type: "volume", Name: VOLUME, Destination: "/root/.ollama", RW: true }],
        NetworkSettings: {
          Networks: { "fixture-net": { NetworkID: NETWORK, Aliases: ["n8n-local-model", "local-model"] } },
          Ports: { "11434/tcp": published ? [{ HostIp: "0.0.0.0", HostPort: "11434" }] : null },
        },
      });
      if ((at === HELPER || at === `${PROJECT}-model-pull-${operation}`) && helper) return ok({ Id: HELPER, Image: HELPER_IMAGE, Name: `/${PROJECT}-model-pull-${operation}`, Config: { Image: `relmio-n8n-local-model-acquisition-${INSTALL}:local`, Cmd: [MODEL, operation, ...(helperExpectedDigest ? [helperExpectedDigest] : [])], Labels: { ...projectLabels, "com.docker.compose.service": "acquisition", "com.docker.compose.oneoff": "True", "io.relmio.operation": operation } }, State: { Running: helperRunning, Status: helperRunning ? "running" : "exited", ExitCode: helperState === "model-ready" ? 0 : 1 }, HostConfig: { PortBindings: {}, Privileged: false, ReadonlyRootfs: true, RestartPolicy: { Name: "no" }, PidsLimit: 64, Memory: 268_435_456, MemorySwap: 268_435_456, NanoCpus: 500_000_000, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], ...helperBudgetDrift }, Mounts: [], NetworkSettings: { Networks: { "fixture-net": { NetworkID: NETWORK, Aliases: [] } }, Ports: {} } });
      return absent();
    }
    if (args[0] === "network") return ok({ Id: NETWORK, Name: "fixture-net", Driver: "bridge", Scope: "local", Internal: false, Options: networkOptions, ...networkFlags, Containers: { ...(n8nAvailable ? { [N8N]: { Name: "fixture-n8n" } } : {}), ...(runtime ? { [RUNTIME]: { Name: `${PROJECT}-local-model-1` } } : {}), ...(aliasCollision ? { ["8".repeat(64)]: { Name: "n8n-local-model" } } : {}) } });
    if (args[0] === "volume" && args[1] === "inspect") {
      if (!volume && at === VOLUME) return foreignVolume ? ok({ Name: VOLUME, Labels: {} }) : absent();
      return ok({ Name: VOLUME, Labels: { ...projectLabels } });
    }
    if (args[0] === "image" && args[1] === "pull") { runtimeImage = !failImagePull; return failImagePull ? absent() : ok(); }
    if (args[0] === "image" && args[1] === "inspect") {
      if (at === LOCAL_MODEL_RUNTIME_IMAGE) return runtimeImage ? ok({ Id: IMAGE }) : absent();
      if (at === `relmio-n8n-local-model-acquisition-${INSTALL}:local`) return helperImage ? ok({ Id: HELPER_IMAGE, Config: { Labels: { "io.relmio.managed": "true", "io.relmio.target": "n8n-local-model", "io.relmio.install": INSTALL } } }) : absent();
      return absent();
    }
    if (args[0] === "image" && args[1] === "rm") { helperImage = false; return ok(); }
    if (args[0] === "logs") return logsFail ? absent() : ok(logsVisible ? status(operation, helperState, { ...(helperState === "downloading" ? { completedBytes: 1024, totalBytes: 2048 } : {}), ...logChanges }) : "");
    if (args[0] === "container" && args[1] === "stop") { if (args.includes(HELPER)) { if (failHelperStop) return absent(); helperRunning = false; } else runtime = "stopped"; return ok(at); }
    if (args[0] === "container" && args[1] === "start") { runtime = "running"; pendingHealthChecks = restartHealthChecks; return ok(RUNTIME); }
    if (args[0] === "container" && args[1] === "rm") { if (args.includes(HELPER)) helper = false; else if (args.includes(RUNTIME)) runtime = false; return ok(); }
    if (args[0] === "volume" && args[1] === "rm") { volume = false; return ok(); }
    if (args[0] === "exec" && args[1] === RUNTIME && args[2] === "/bin/ollama" && args[3] === "list") return ok("NAME\n");
    if (args[0] === "compose") {
      if (args.includes("version")) return ok("2.31.0\n");
      if (args.includes("config")) return ok();
      if (args.includes("build")) { if (failHelperBuild) return absent(); helperImage = true; return ok(); }
      if (args.includes("up")) { if (failStart) return absent(); runtime = "running"; volume = true; return ok(); }
      if (args.includes("run")) {
        if (failHelperRun) return absent();
        const serviceIndex = args.lastIndexOf("acquisition");
        helper = true; helperRunning = true; helperState = "downloading"; logChanges = {};
        operation = args[serviceIndex + 2]; helperExpectedDigest = args[serviceIndex + 3] ?? null;
        return ok(HELPER);
      }
    }
    throw new Error(`Unexpected fake Docker call ${args.join(" ")}`);
  };
  result.calls = calls;
  result.complete = (phase = "model-ready", changes = {}) => { helperRunning = false; helperState = phase; logChanges = changes; };
  result.state = () => ({ runtime, volume, helper, helperImage });
  result.setN8nAvailable = value => { n8nAvailable = value; };
  result.setLogsVisible = value => { logsVisible = value; };
  result.setLogsFail = value => { logsFail = value; };
  result.setFailImagePull = value => { failImagePull = value; };
  result.setFailHelperBuild = value => { failHelperBuild = value; };
  result.setFailStart = value => { failStart = value; };
  result.setFailHelperRun = value => { failHelperRun = value; };
  result.setFailHelperStop = value => { failHelperStop = value; };
  result.setRuntimeStopped = () => { runtime = "stopped"; };
  result.setRestartHealthChecks = value => { restartHealthChecks = value; };
  result.setRuntimeBudgetDrift = value => { runtimeBudgetDrift = value; };
  result.setHelperBudgetDrift = value => { helperBudgetDrift = value; };
  return result;
}

// The public seam is the user's reviewed plan/action and status, not a private Docker helper method.
test("selected engine resources are measured without touching n8n and unknown capacity fails closed", async () => {
  const target = plan();
  const runProcess = runner();
  assert.deepEqual(await inspectLocalN8nModelResources(target, safe({ runProcess })), RESOURCE);
  const probe = runProcess.calls.find(item => item.args[0] === "run");
  assert.equal(probe.args.includes("--network") && probe.args.includes("none"), true);
  assert.equal(runProcess.calls.some(item => item.args[0] === "exec" || item.args.includes("-p")), false);
  const insufficient = runner({ diskAvailableBytes: 0 });
  await assert.rejects(() => inspectLocalN8nModelResources(target, safe({ runProcess: insufficient })), /available disk space/u);
});

test("local model resource review rejects unsafe bridge options before starting a disk probe", async () => {
  const unsafeOptions = [
    { "com.docker.network.bridge.gateway_mode_ipv4": "nat-unprotected" },
    { "com.docker.network.bridge.gateway_mode_ipv6": "nat-unprotected" },
    { "com.docker.network.bridge.gateway_mode_ipv4": "unknown-mode" },
    { "com.docker.network.bridge.enable_icc": "false" },
    { "com.docker.network.bridge.default_bridge": "true" },
  ];
  for (const networkOptions of unsafeOptions) {
    const runProcess = runner({ networkOptions });
    await assert.rejects(() => inspectLocalN8nModelResources(plan(), safe({ runProcess })), /network|bridge/u);
    assert.equal(runProcess.calls.some(item => ["run", "exec", "compose"].includes(item.args[0]) && !item.args.includes("version")), false);
  }
});

test("local installation rechecks bridge options before creating managed model files", async t => {
  const directory = await home(t);
  const runProcess = runner({ networkOptions: { "com.docker.network.bridge.gateway_mode_ipv4": "nat-unprotected" } });
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true },
    safe({ homeDirectory: directory, runProcess })), /network|bridge/u);
  await assert.rejects(() => fs.stat(join(directory, ".relmio")), { code: "ENOENT" });
  assert.equal(runProcess.calls.some(item => ["run", "exec", "compose"].includes(item.args[0]) ||
    item.args[0] === "image" && item.args[1] === "pull"), false);
});

test("local models retain filtered routed bridge support without publishing ports", async () => {
  const runProcess = runner({ networkFlags: { EnableIPv6: false }, networkOptions: {
    "com.docker.network.bridge.gateway_mode_ipv4": "routed",
    "com.docker.network.bridge.gateway_mode_ipv6": "nat-unprotected",
    "com.docker.network.bridge.trusted_host_interfaces": "eth0",
  } });
  assert.deepEqual(await inspectLocalN8nModelResources(plan(), safe({ runProcess })), RESOURCE);
});

test("builder selectors and saved remote selections reject installation before any Docker mutation", async t => {
  const directory = await home(t);
  for (const name of ["BUILDX_BUILDER", "BUILDX_CONFIG", "BUILDKIT_HOST", "COMPOSE_BAKE", "DOCKER_BUILDKIT"]) {
    const runProcess = runner();
    await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true },
      safe({ homeDirectory: directory, env: { [name]: name === "DOCKER_BUILDKIT" ? "0" : "remote" }, runProcess })), /override|builder|BuildKit/u);
    assert.equal(runProcess.calls.length, 0);
  }
  const config = join(directory, ".docker", "buildx");
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(join(config, "current"), JSON.stringify({ Key: HOST, Name: "remote-ci", Global: false }));
  const runProcess = runner();
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true },
    safe({ homeDirectory: directory, runProcess })), /builder|selection/u);
  assert.equal(runProcess.calls.some(call => call.args[0] === "image" || call.args[0] === "compose"), false);
  assert.equal(await fs.readFile(join(config, "current"), "utf8"), JSON.stringify({ Key: HOST, Name: "remote-ci", Global: false }));
  await assert.rejects(() => fs.stat(join(directory, ".relmio")), { code: "ENOENT" });
});

test("a context-only saved Key may change between install guards without rewriting selection", async t => {
  const directory = await home(t);
  const buildx = join(directory, ".docker", "buildx");
  await fs.mkdir(buildx, { recursive: true });
  const current = join(buildx, "current");
  await fs.writeFile(current, JSON.stringify({ Key: HOST, Name: "", Global: false }));
  const ignoredKey = "ssh://unreviewed.example.test";
  const saved = JSON.stringify({ Key: ignoredKey, Name: "", Global: false });
  const runProcess = runner();
  let changed = false;
  const transition = async spec => {
    const result = await runProcess(spec);
    if (!changed && spec.args[0] === "image" && spec.args[1] === "inspect" &&
        spec.args.at(-1) === `relmio-n8n-local-model-acquisition-${INSTALL}:local`) {
      changed = true;
      await fs.writeFile(current, saved);
    }
    return result;
  };
  const installed = await installLocalN8nModel({ plan: plan(), confirmed: true },
    safe({ homeDirectory: directory, runProcess: transition }));
  assert.equal(changed, true);
  assert.equal(installed.status, "downloading");
  assert.equal(runProcess.calls.some(call => call.args[0] === "compose" && call.args.includes("build")), true);
  assert.equal(runProcess.calls.some(call => call.args[0] === "compose" && call.args.includes("run")), true);
  assert.equal(await fs.readFile(current, "utf8"), saved);
  assert.equal(JSON.stringify(runProcess.calls).includes(ignoredKey), false);
  assert.equal(JSON.stringify(installed).includes(ignoredKey), false);
});

test("fallback and default shadows appearing before the second install guard stop the helper build", async t => {
  for (const kind of ["fallback", "shadow"]) {
    const directory = await home(t);
    const buildx = join(directory, ".docker", "buildx");
    await fs.mkdir(buildx, { recursive: true });
    const current = join(buildx, "current");
    const saved = JSON.stringify({ Key: "desktop-linux", Name: "", Global: true });
    await fs.writeFile(current, saved);
    const runProcess = runner();
    let changed = false;
    const transition = async spec => {
      const result = await runProcess(spec);
      if (!changed && spec.args[0] === "image" && spec.args[1] === "inspect" &&
          spec.args.at(-1) === `relmio-n8n-local-model-acquisition-${INSTALL}:local`) {
        changed = true;
        if (kind === "shadow") {
          await fs.mkdir(join(buildx, "instances"), { recursive: true });
          await fs.writeFile(join(buildx, "instances", "default"), "{}");
        } else {
          const hash = createHash("sha256").update(HOST).digest("hex").slice(0, 20);
          await fs.mkdir(join(buildx, "defaults"), { recursive: true });
          await fs.writeFile(join(buildx, "defaults", hash), "remote-ci");
        }
      }
      return result;
    };
    await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true },
      safe({ homeDirectory: directory, runProcess: transition })));
    assert.equal(changed, true);
    assert.equal(runProcess.calls.some(call => call.args[0] === "compose" && call.args.includes("build")), false);
    assert.equal(runProcess.calls.some(call => call.args[0] === "compose" && call.args.includes("run")), false);
    assert.equal(await fs.readFile(current, "utf8"), saved);
  }
});

test("a fallback appearing after helper build prevents acquisition from starting", async t => {
  const directory = await home(t), runProcess = runner();
  const buildx = join(directory, ".docker", "buildx");
  await fs.mkdir(buildx, { recursive: true });
  await fs.writeFile(join(buildx, "current"), JSON.stringify({ Key: "desktop-linux", Name: "", Global: false }));
  let changed = false;
  const transition = async spec => {
    const result = await runProcess(spec);
    if (!changed && result.code === 0 && spec.args[0] === "image" && spec.args[1] === "inspect" &&
        spec.args.at(-1) === `relmio-n8n-local-model-acquisition-${INSTALL}:local`) {
      changed = true;
      const hash = createHash("sha256").update(HOST).digest("hex").slice(0, 20);
      await fs.mkdir(join(buildx, "defaults"), { recursive: true });
      await fs.writeFile(join(buildx, "defaults", hash), "remote-ci");
    }
    return result;
  };
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true },
    safe({ homeDirectory: directory, runProcess: transition })));
  assert.equal(changed, true);
  assert.equal(runProcess.calls.some(call => call.args[0] === "compose" && call.args.includes("build")), true);
  assert.equal(runProcess.calls.some(call => call.args[0] === "compose" && call.args.includes("run")), false);
});

test("retry rejects a default shadow after an ignored Key appears without stopping the owned writer", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete("model-error");
  const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  const buildx = join(directory, ".docker", "buildx");
  await fs.mkdir(join(buildx, "instances"), { recursive: true });
  await fs.writeFile(join(buildx, "current"), JSON.stringify({ Key: "other-context", Name: "", Global: true }));
  await fs.writeFile(join(buildx, "instances", "default"), "{}");
  const before = runProcess.calls.length;
  await assert.rejects(() => applyLocalN8nModelAction({ review, confirmed: true },
    safe({ homeDirectory: directory, runProcess })));
  assert.equal(runProcess.calls.slice(before).some(call => call.args[0] === "container" &&
    ["stop", "rm", "start"].includes(call.args[1])), false);
  assert.equal(runProcess.state().helper, true);
});

test("confirmed install retains a private cache during download, then verifies real model readiness", async t => {
  const directory = await home(t), runProcess = runner();
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: false }, safe({ homeDirectory: directory, runProcess })), /Confirm/u);
  assert.equal(runProcess.calls.length, 0);
  const installed = await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  const build = runProcess.calls.find(item => item.args[0] === "compose" && item.args.includes("build"));
  assert.equal(build.args[build.args.indexOf("--builder") + 1], "default");
  assert.equal(build.attestedDockerConfig, join(directory, ".docker"));
  const acquisition = runProcess.calls.find(item => item.args[0] === "compose" && item.args.includes("run"));
  assert.equal(acquisition.attestedDockerConfig, join(directory, ".docker"));
  assert.equal(runProcess.calls.some(item => item.args[0] === "buildx"), false);
  assert.equal(installed.status, "downloading");
  assert.equal(installed.modelId, MODEL);
  assert.deepEqual(installed.progress, { status: "downloading", completed: 1024, total: 2048 });
  assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "downloading");
  runProcess.complete();
  const ready = await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }));
  assert.equal(ready.status, "model-ready");
  assert.equal(ready.modelDigest, DIGEST.slice(7));
  assert.equal(ready.endpoint, "http://n8n-local-model:11434/v1");
  assert.equal(runProcess.calls.every(item => item.args[0] !== "exec"), true);
});

test("local model status accepts Docker's enabled security-option forms for runtime and helper", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete();
  for (const resource of ["runtime", "helper"]) {
    for (const securityOpt of ["no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"]) {
      const setPolicy = resource === "runtime" ? runProcess.setRuntimeBudgetDrift : runProcess.setHelperBudgetDrift;
      setPolicy({ SecurityOpt: [securityOpt] });
      const current = await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }));
      assert.equal(current.status, "model-ready", `${resource}: ${securityOpt}`);
      assert.equal(current.modelDigest, DIGEST.slice(7));
      setPolicy({});
    }
  }
});

test("local model status and retry reject absent, disabled, conflicting and malformed security options", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete();
  const unsafe = [
    [],
    ["no-new-privileges:false"],
    ["no-new-privileges=false"],
    ["no-new-privileges", "no-new-privileges:false"],
    ["no-new-privileges:false", "no-new-privileges"],
    ["no-new-privileges:true", "no-new-privileges=false"],
    ["no-new-privileges=false", "no-new-privileges:true"],
    ["no-new-privileges=true", "no-new-privileges=false"],
    ["no-new-privileges=false", "no-new-privileges=true"],
    ["no-new-privileges:maybe"],
    ["no-new-privileges:true:extra"],
    ["no-new-privileges", "no-new-privileges:maybe"],
    ["no-new-privileges:maybe", "no-new-privileges"],
    "no-new-privileges:true",
  ];
  for (const resource of ["runtime", "helper"]) {
    for (const securityOpt of unsafe) {
      const setPolicy = resource === "runtime" ? runProcess.setRuntimeBudgetDrift : runProcess.setHelperBudgetDrift;
      setPolicy({ SecurityOpt: securityOpt });
      const current = await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }));
      assert.equal(current.status, "partial", `${resource}: ${JSON.stringify(securityOpt)}`);
      assert.equal(current.modelDigest, null);
      await assert.rejects(() => reviewLocalN8nModelAction({ action: "retry" },
        safe({ homeDirectory: directory, runProcess })));
      setPolicy({});
    }
  }
});

test("failed pull retains cache; retry is reviewed, shuts down its own writer, and never touches n8n", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete("model-error");
  const error = await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }));
  assert.equal(error.status, "model-error");
  assert.equal(runProcess.state().volume, true);
  const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  await assert.rejects(() => applyLocalN8nModelAction({ review, confirmed: false }, safe({ homeDirectory: directory, runProcess })), /Confirm/u);
  const before = runProcess.calls.length;
  const retry = await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(RETRY, "hex") }));
  assert.equal(retry.status, "downloading");
  assert.equal(runProcess.state().volume, true);
  const changes = runProcess.calls.slice(before);
  const stopped = changes.findIndex(item => item.args[0] === "container" && item.args[1] === "stop");
  const removedHelper = changes.findIndex(item => item.args[0] === "container" && item.args[1] === "rm" && item.args.includes(HELPER));
  const restarted = changes.findIndex(item => item.args[0] === "container" && item.args[1] === "start");
  assert.equal(stopped >= 0 && removedHelper > stopped && restarted > stopped, true);
  assert.equal(changes.find(item => item.args[0] === "compose" && item.args.includes("run")).attestedDockerConfig,
    join(directory, ".docker"));
  assert.equal(changes.some(item => item.args.includes(N8N) && ["stop", "rm", "start", "exec"].includes(item.args[1])), false);
});

test("partial bootstrap retry reattests and pins the default builder before rebuilding", async t => {
  const directory = await home(t), runProcess = runner({ failHelperBuild: true });
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true },
    safe({ homeDirectory: directory, runProcess })), /Acquisition image build/u);
  const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  runProcess.setFailHelperBuild(false);
  const before = runProcess.calls.length;
  const resumed = await applyLocalN8nModelAction({ review, confirmed: true },
    safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(RETRY, "hex") }));
  assert.equal(resumed.status, "downloading");
  const calls = runProcess.calls.slice(before);
  const build = calls.find(item => item.args[0] === "compose" && item.args.includes("build"));
  assert.equal(build.args[build.args.indexOf("--builder") + 1], "default");
  assert.equal(build.attestedDockerConfig, join(directory, ".docker"));
  assert.equal(calls.find(item => item.args[0] === "compose" && item.args.includes("run")).attestedDockerConfig,
    join(directory, ".docker"));
  assert.equal(calls.some(item => item.args[0] === "buildx"), false);
});

test("partial bootstrap retry rejects a fallback appearing before its helper rebuild", async t => {
  const directory = await home(t), runProcess = runner({ failHelperBuild: true });
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true },
    safe({ homeDirectory: directory, runProcess })));
  const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  const buildx = join(directory, ".docker", "buildx");
  await fs.mkdir(buildx, { recursive: true });
  await fs.writeFile(join(buildx, "current"), JSON.stringify({ Key: "desktop-linux", Name: "", Global: true }));
  runProcess.setFailHelperBuild(false);
  let changed = false;
  const transition = async spec => {
    const result = await runProcess(spec);
    if (!changed && spec.args[0] === "image" && spec.args[1] === "inspect" &&
        spec.args.at(-1) === `relmio-n8n-local-model-acquisition-${INSTALL}:local`) {
      changed = true;
      const hash = createHash("sha256").update(HOST).digest("hex").slice(0, 20);
      await fs.mkdir(join(buildx, "defaults"), { recursive: true });
      await fs.writeFile(join(buildx, "defaults", hash), "remote-ci");
    }
    return result;
  };
  const before = runProcess.calls.length;
  await assert.rejects(() => applyLocalN8nModelAction({ review, confirmed: true },
    safe({ homeDirectory: directory, runProcess: transition, randomBytes: () => Buffer.from(RETRY, "hex") })));
  assert.equal(changed, true);
  assert.equal(runProcess.calls.slice(before).some(call => call.args[0] === "compose" && call.args.includes("build")), false);
  assert.equal(runProcess.calls.slice(before).some(call => call.args[0] === "compose" && call.args.includes("run")), false);
  assert.equal(runProcess.state().volume, false);
});

test("an inference-only retry binds the installed digest and refuses a mutable model tag change", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete("model-error", { modelDigest: DIGEST, writerMayBeActive: false, errorCode: "inference-failed" });
  const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  assert.equal(review.modelDigest, DIGEST.slice(7));
  await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(RETRY, "hex") }));
  const operation = runProcess.calls.findLast(item => item.args[0] === "compose" && item.args.includes("run"));
  assert.deepEqual(operation.args.slice(-3), [MODEL, RETRY, DIGEST]);
});

test("full removal needs cache-specific review, rejects stale identity and removes only attested owned resources", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete();
  await assert.rejects(() => reviewLocalN8nModelAction({ action: "remove" }, safe({ homeDirectory: directory, runProcess })), /cache deletion/u);
  const review = await reviewLocalN8nModelAction({ action: "remove", removeModelData: true }, safe({ homeDirectory: directory, runProcess }));
  await assert.rejects(() => applyLocalN8nModelAction({ review: { ...review, installId: "4".repeat(32) }, confirmed: true }, safe({ homeDirectory: directory, runProcess })), /changed/u);
  assert.equal(runProcess.state().volume, true);
  const outcome = await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  assert.deepEqual(outcome, { target: "n8n-local-model", removed: true, cacheRetained: false });
  assert.equal(runProcess.state().volume, false);
  assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "absent");
  assert.equal(runProcess.calls.some(item => item.args[0] === "container" && item.args[1] === "rm" && item.args.includes(N8N)), false);
});

test("alias collision, ownership drift and published ports fail closed without guessed resource removal", async t => {
  for (const options of [{ aliasCollision: true }, { foreignVolume: true }]) {
    const directory = await home(t), runProcess = runner(options);
    await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess })), /alias|available/u);
    assert.equal(runProcess.calls.some(item => item.args[0] === "image" && item.args[1] === "pull"), false);
  }
  const directory = await home(t), runProcess = runner({ published: true });
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess })), /attested private/u);
  assert.equal(runProcess.state().volume, true);
  const root = await resolveLocalN8nModelInstallRoot({ homeDirectory: directory, env: {} });
  assert.equal((await fs.stat(root)).isDirectory(), true);
  const compose = await fs.readFile(join(root, "compose.yaml"), "utf8");
  await fs.writeFile(join(root, "compose.yaml"), `${compose}\n# changed`);
  assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "unavailable");
  await assert.rejects(() => reviewLocalN8nModelAction({ action: "remove", removeModelData: true }, safe({ homeDirectory: directory, runProcess })), /not safe/u);
});

test("a failed large image download leaves an inspectable owned partial deployment, not an orphan or deleted cache", async t => {
  const directory = await home(t), runProcess = runner({ failImagePull: true });
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess })), /Pinned Ollama image download/u);
  const root = await resolveLocalN8nModelInstallRoot({ homeDirectory: directory, env: {} });
  assert.equal((await fs.stat(join(root, ".managed-by-relmio.json"))).isFile(), true);
  const partial = await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }));
  assert.equal(partial.status, "partial");
  assert.equal(partial.managed, true);
  assert.equal(runProcess.calls.some(item => item.args[0] === "container" && item.args[1] === "rm"), false);
  const review = await reviewLocalN8nModelAction({ action: "remove", removeModelData: true }, safe({ homeDirectory: directory, runProcess }));
  assert.deepEqual(await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess })), { target: "n8n-local-model", removed: true, cacheRetained: false });
  assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "absent");
});

test("changed Docker context, unsafe ancestors, and altered image identities cannot authorize a write", async t => {
  // Plan creation validates dockerHost with platform omitted, so a Unix socket
  // is accepted. On Windows the inspect fixture returns the Linux engine pipe
  // first; the mismatch is then rejected as context drift, not an invalid pipe.
  const plannedHost = process.platform === "win32" ? DRIFTED_UNIX_HOST : HOST;
  const directory = await home(t), runProcess = runner({ changedContext: true, dockerHost: plannedHost });
  await assert.rejects(() => installLocalN8nModel({ plan: plan({ dockerHost: plannedHost }), confirmed: true }, safe({ homeDirectory: directory, runProcess })), /context changed/u);
  assert.equal(runProcess.calls.some(item => item.args[0] === "image" && item.args[1] === "pull"), false);
  const linkedHome = await home(t);
  await fs.mkdir(join(linkedHome, ".relmio"));
  await fs.writeFile(join(linkedHome, ".relmio", ".managed-by-relmio-root.json"), `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`);
  await fs.symlink(directory, join(linkedHome, ".relmio", "local"), process.platform === "win32" ? "junction" : "dir");
  const clean = runner();
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: linkedHome, runProcess: clean })), /Unsafe managed directory/u);
  assert.equal(clean.calls.length, 0);
  const driftHome = await home(t), drift = runner({ imageDrift: true });
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: driftHome, runProcess: drift })), /attested private/u);
  assert.equal(drift.state().volume, true);
  assert.equal(drift.calls.some(item => item.args[0] === "volume" && item.args[1] === "rm"), false);
});

test("a prior package's intact hashed files remain removable even if generated Compose text changed", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete();
  const root = await resolveLocalN8nModelInstallRoot({ homeDirectory: directory, env: {} });
  const composeFile = join(root, "compose.yaml");
  const compose = `${await fs.readFile(composeFile, "utf8")}\n# generated by a previous package\n`;
  const markerFile = join(root, ".managed-by-relmio.json");
  const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
  marker.fileHashes["compose.yaml"] = createHash("sha256").update(compose).digest("hex");
  await fs.writeFile(composeFile, compose);
  await fs.writeFile(markerFile, `${JSON.stringify(marker)}\n`);
  assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "model-ready");
  const review = await reviewLocalN8nModelAction({ action: "remove", removeModelData: true }, safe({ homeDirectory: directory, runProcess }));
  assert.equal((await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess }))).removed, true);
});

test("a runtime that can prune partial download blobs is not accepted as an owned cache-preserving install", async t => {
  for (const pruneEnvironment of [null, "0"]) {
    const directory = await home(t), runProcess = runner({ pruneEnvironment });
    await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess })), /attested private/u);
    assert.equal(runProcess.state().volume, true);
    assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "partial");
    assert.equal(runProcess.calls.some(item => item.args[0] === "volume" && item.args[1] === "rm"), false);
  }
});

test("Windows managed files receive owner-only ACLs and status verifies them without changing ACLs", { skip: process.platform !== "win32" }, async t => {
  const directory = await home(t);
  const dockerHost = "npipe:////./pipe/dockerDesktopLinuxEngine";
  const runProcess = runner({ dockerHost });
  const acl = [];
  const lockDownPath = async (path, options) => { acl.push({ path, ...options }); };
  const dependencies = safe({ homeDirectory: directory, runProcess, platform: "win32", lockDownPath });
  await installLocalN8nModel({ plan: plan({ dockerHost }), confirmed: true }, dependencies);
  const root = await resolveLocalN8nModelInstallRoot({ homeDirectory: directory, env: {}, platform: "win32" });
  const managedFiles = ["compose.yaml", "Dockerfile.acquisition", ".dockerignore", "catalog.mjs", "acquisition.mjs", ".managed-by-relmio.json"];
  for (const filename of managedFiles) assert.equal(acl.some(item => item.path === join(root, filename) && item.kind === "file" && !item.verifyOnly), true);
  acl.length = 0;
  assert.equal((await getLocalN8nModelStatus(dependencies)).status, "downloading");
  assert.equal(acl.some(item => !item.verifyOnly), false);
  for (const filename of managedFiles) assert.equal(acl.some(item => item.path === join(root, filename) && item.verifyOnly && item.verifyEffectiveOwnerOnly), true);
});

test("a completed helper with an unapproved model manifest cannot mark the model ready or authorize retry", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete("model-ready", { modelDigest: `sha256:${"8".repeat(64)}` });
  const current = await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }));
  assert.equal(current.status, "partial");
  assert.equal(current.modelDigest, null);
  await assert.rejects(() => reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess })), /not safe/u);
});

test("a changed disk estimate is accepted if the reviewed model still fits, but rejects insufficient space before writes", async t => {
  const directory = await home(t), runProcess = runner({ diskAvailableBytes: RESOURCE.diskAvailableBytes - 1024 ** 3 });
  const installed = await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  assert.equal(installed.status, "downloading");
  const insufficientDirectory = await home(t), insufficient = runner({ diskAvailableBytes: plan().requiredDiskBytes - 1 });
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: insufficientDirectory, runProcess: insufficient })), /disk|space|budget/iu);
  assert.equal(insufficient.calls.some(item => item.args[0] === "image" && item.args[1] === "pull"), false);
  assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: insufficientDirectory, runProcess: insufficient }))).status, "absent");
});

test("retry reattests selected n8n; owned removal still works after n8n disappears", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete("model-error");
  const retry = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  runProcess.setN8nAvailable(false);
  const before = runProcess.calls.length;
  await assert.rejects(() => applyLocalN8nModelAction({ review: retry, confirmed: true }, safe({ homeDirectory: directory, runProcess })), /inspection failed|n8n container changed/u);
  assert.equal(runProcess.calls.slice(before).some(item => item.args[0] === "container" && item.args[1] === "stop"), false);
  const remove = await reviewLocalN8nModelAction({ action: "remove", removeModelData: true }, safe({ homeDirectory: directory, runProcess }));
  assert.equal((await applyLocalN8nModelAction({ review: remove, confirmed: true }, safe({ homeDirectory: directory, runProcess }))).removed, true);
});

test("a newly detached helper without its first progress event is downloading, not falsely ready", async t => {
  const directory = await home(t), runProcess = runner();
  runProcess.setLogsVisible(false);
  const installed = await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  assert.equal(installed.status, "downloading");
  assert.equal(installed.progress, null);
  runProcess.complete("model-error");
  const error = await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }));
  assert.equal(error.status, "model-error");
  assert.equal(error.modelDigest, null);
});

test("an interrupted bootstrap retries the same owned installation without deleting its cache", async t => {
  for (const failure of ["image-pull", "helper-build", "runtime-start"]) {
    const directory = await home(t), runProcess = runner({ failImagePull: failure === "image-pull", failHelperBuild: failure === "helper-build", failStart: failure === "runtime-start" });
    await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess })));
    assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "partial");
    const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
    runProcess.setFailImagePull(false);
    runProcess.setFailHelperBuild(false);
    runProcess.setFailStart(false);
    const resumed = await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(RETRY, "hex") }));
    assert.equal(resumed.status, "downloading");
    assert.equal(resumed.installId, INSTALL);
    assert.equal(runProcess.state().volume, true);
    assert.equal(runProcess.calls.some(item => item.args[0] === "volume" && item.args[1] === "rm"), false);
  }
});

test("a missing helper after marker persistence and a stopped owned runtime can retry without discarding partial blobs", async t => {
  const directory = await home(t), runProcess = runner({ failHelperRun: true });
  await assert.rejects(() => installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess })), /acquisition start/u);
  const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  assert.equal(review.operationId, INSTALL);
  runProcess.setFailHelperRun(false);
  const before = runProcess.calls.length;
  const retried = await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(RETRY, "hex"), wait: async () => {} }));
  assert.equal(retried.status, "downloading");
  assert.equal(runProcess.calls.slice(before).some(item => item.args[0] === "volume" && item.args[1] === "rm"), false);
  runProcess.setRuntimeStopped();
  const stoppedReview = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  const again = runProcess.calls.length;
  assert.equal((await applyLocalN8nModelAction({ review: stoppedReview, confirmed: true }, safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(OPERATION, "hex"), wait: async () => {} }))).status, "downloading");
  const calls = runProcess.calls.slice(again);
  const stopHelper = calls.findIndex(item => item.args[0] === "container" && item.args[1] === "stop" && item.args.includes(HELPER));
  const startRuntime = calls.findIndex(item => item.args[0] === "container" && item.args[1] === "start");
  assert.equal(stopHelper >= 0 && startRuntime > stopHelper, true);
  assert.equal(calls.some(item => item.args[0] === "volume" && item.args[1] === "rm"), false);
});

test("retry waits for the same runtime's health before starting a new helper and fails closed on a health timeout", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete("model-error");
  const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  runProcess.setRestartHealthChecks(2);
  let waits = 0;
  const before = runProcess.calls.length;
  assert.equal((await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(RETRY, "hex"), wait: async () => { waits++; } }))).status, "downloading");
  assert.equal(waits, 2);
  const calls = runProcess.calls.slice(before);
  assert.equal(calls.some(item => item.args[0] === "exec"), false);
  assert.equal(calls.findIndex(item => item.args[0] === "container" && item.args[1] === "start") < calls.findIndex(item => item.args[0] === "compose" && item.args.includes("run")), true);
  runProcess.complete("model-error");
  const failureReview = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  runProcess.setRestartHealthChecks(100);
  waits = 0;
  const retryStart = runProcess.calls.length;
  await assert.rejects(() => applyLocalN8nModelAction({ review: failureReview, confirmed: true }, safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(OPERATION, "hex"), wait: async () => { waits++; } })), /did not become healthy/u);
  assert.equal(waits, 29);
  assert.equal(runProcess.calls.slice(retryStart).some(item => item.args[0] === "compose" && item.args.includes("run")), false);
  assert.equal(runProcess.state().volume, true);
});

test("runtime and acquisition resource-policy drift cannot authorize retries or cache deletion", async t => {
  for (const drift of [{ runtime: { MemorySwap: plan().memoryBytes * 2 } }, { runtime: { RestartPolicy: { Name: "always" } } }, { helper: { NanoCpus: 750_000_000 } }]) {
    const directory = await home(t), runProcess = runner();
    await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
    runProcess.complete("model-error");
    if (drift.runtime) runProcess.setRuntimeBudgetDrift(drift.runtime);
    if (drift.helper) runProcess.setHelperBudgetDrift(drift.helper);
    assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "partial");
    await assert.rejects(() => reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess })), /not safe/u);
    const remove = await reviewLocalN8nModelAction({ action: "remove", removeModelData: true }, safe({ homeDirectory: directory, runProcess }));
    const before = runProcess.calls.length;
    await assert.rejects(() => applyLocalN8nModelAction({ review: remove, confirmed: true }, safe({ homeDirectory: directory, runProcess })), /attested/u);
    assert.equal(runProcess.calls.slice(before).some(item => ["stop", "rm"].includes(item.args[1])), false);
    assert.equal(runProcess.state().volume, true);
  }
});

test("a runtime installed before restart-with-Docker still attests", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.complete("model-ready");
  runProcess.setRuntimeBudgetDrift({ RestartPolicy: { Name: "no" } });
  assert.equal((await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }))).status, "model-ready");
});

test("post-context Docker log inspection failures become unavailable status rather than escaping the status read", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.setLogsFail(true);
  const state = await getLocalN8nModelStatus(safe({ homeDirectory: directory, runProcess }));
  assert.equal(state.status, "unavailable");
  assert.equal(state.managed, false);
});

test("stopped runtime recovery retains a verified digest and refuses to replace an active helper before shutdown proof", async t => {
  const directory = await home(t), runProcess = runner();
  await installLocalN8nModel({ plan: plan(), confirmed: true }, safe({ homeDirectory: directory, runProcess }));
  runProcess.setRuntimeStopped();
  runProcess.setFailHelperStop(true);
  const interrupted = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  const before = runProcess.calls.length;
  await assert.rejects(() => applyLocalN8nModelAction({ review: interrupted, confirmed: true }, safe({ homeDirectory: directory, runProcess })), /acquisition shutdown/u);
  assert.equal(runProcess.calls.slice(before).some(item => item.args[0] === "container" && item.args[1] === "rm"), false);
  assert.equal(runProcess.state().volume, true);
  runProcess.setFailHelperStop(false);
  runProcess.complete("model-ready");
  const review = await reviewLocalN8nModelAction({ action: "retry" }, safe({ homeDirectory: directory, runProcess }));
  assert.equal(review.modelDigest, DIGEST.slice(7));
  assert.equal((await applyLocalN8nModelAction({ review, confirmed: true }, safe({ homeDirectory: directory, runProcess, randomBytes: () => Buffer.from(RETRY, "hex"), wait: async () => {} }))).status, "downloading");
  const pull = runProcess.calls.findLast(item => item.args[0] === "compose" && item.args.includes("run"));
  assert.deepEqual(pull.args.slice(-3), [MODEL, RETRY, DIGEST]);
});
