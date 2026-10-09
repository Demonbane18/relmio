import assert from "node:assert/strict";
import test from "node:test";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalN8nStackInstallation, createLocalN8nStackPlan, getLocalN8nStackLabels } from "../src/domain/local-n8n-stack.js";
import { importLocalStackN8nCredential, localStackCredentialId } from "../src/services/local-n8n-stack-credentials.js";
import { withTestLocalSecurity } from "./helpers/local-security.js";

const dockerHost = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";

async function fixture(t) {
  const homeDirectory = await fileSystem.realpath(await fileSystem.mkdtemp(join(tmpdir(), "relmio-credential-")));
  t.after(() => fileSystem.rm(homeDirectory, { recursive: true, force: true }));
  const marker = createLocalN8nStackInstallation({
    plan: createLocalN8nStackPlan({ dockerHost, publicAccess: "none", ngrokHostname: null,
      n8nPort: 5678, ngrokInspectorPort: null, timezone: "Asia/Manila", assistantMode: "disabled" }),
    randomBytes: length => Buffer.alloc(length, 17),
  }).marker;
  const root = join(homeDirectory, ".relmio", "local", "n8n-stack");
  await fileSystem.mkdir(join(root, ".runtime"), { recursive: true, mode: 0o700 });
  await fileSystem.writeFile(join(root, ".managed-by-relmio.json"), JSON.stringify(marker), { mode: 0o600 });
  return { homeDirectory, root, marker };
}

test("credential import targets only running owned n8n, sends key on stdin, then upserts same id", async t => {
  const { homeDirectory, root, marker } = await fixture(t);
  const containerId = "a".repeat(64);
  const specs = [];
  const runProcess = async spec => {
    specs.push(spec);
    if (spec.args[0] === "container") return { code: 0, stdout: JSON.stringify({
      Id: containerId, Name: `/${marker.projectName}-n8n-1`, State: { Running: true },
      Config: { Labels: { ...getLocalN8nStackLabels(marker),
        "com.docker.compose.project": marker.projectName, "com.docker.compose.service": "n8n" } },
    }), stderr: "" };
    return { code: 0, stdout: "Successfully imported 1 credential.", stderr: "" };
  };
  const args = withTestLocalSecurity({ marker, credential: { feature: "chatgpt", apiKey: "private-key" },
    dockerHost, homeDirectory, runProcess });
  const first = await importLocalStackN8nCredential(args);
  const second = await importLocalStackN8nCredential(args);
  assert.deepEqual(specs.map(spec => spec.args[0]), ["container", "exec", "container", "exec"]);
  assert.deepEqual(first, { state: "created", name: "Relmio ChatGPT plan" });
  assert.deepEqual(second, { state: "updated", name: "Relmio ChatGPT plan" });
  const imports = specs.filter(spec => spec.args[0] === "exec");
  assert.equal(imports.length, 2);
  for (const spec of imports) {
    assert.deepEqual(spec.args, ["exec", "-i", containerId, "n8n", "import:credentials", "--input=/dev/stdin"]);
    assert.equal(spec.dockerHost, dockerHost);
    assert.equal(spec.cwd, root);
    assert.equal(spec.timeoutMs, 60_000);
    assert.equal(spec.args.join(" ").includes("private-key"), false);
    assert.deepEqual(JSON.parse(spec.input), [{ id: localStackCredentialId(marker.installId, "chatgpt"),
      name: "Relmio ChatGPT plan", type: "openAiApi",
      data: { apiKey: "private-key", url: "http://n8n-openai-oauth:10531/v1" } }]);
  }
  assert.match(localStackCredentialId(marker.installId, "chatgpt"), /^[A-Za-z0-9]{16}$/u);
  assert.equal(imports[0].input, imports[1].input);
  const record = await fileSystem.readFile(join(root, ".runtime", "credentials.json"), "utf8");
  assert.equal(record.includes("private-key"), false);
  for (const [feature, name, url, apiKey] of [
    ["local-model", "Relmio local model", "http://n8n-local-model:11434/v1", "local-only"],
    ["supergrok", "Relmio SuperGrok", "http://n8n-supergrok:14502/v1", "private-supergrok"],
  ]) {
    assert.deepEqual(await importLocalStackN8nCredential({
      ...args, credential: { feature, apiKey },
    }), { state: "created", name });
    const payload = JSON.parse(specs.at(-1).input)[0];
    assert.deepEqual(payload, { id: localStackCredentialId(marker.installId, feature),
      name, type: "openAiApi", data: { apiKey, url } });
    assert.notEqual(payload.id, localStackCredentialId(marker.installId, "chatgpt"));
  }
  assert.equal((await fileSystem.readFile(join(root, ".runtime", "credentials.json"), "utf8"))
    .includes("private-supergrok"), false);
});

test("failed imports and changed container labels never expose key or break add-on response", async t => {
  const { homeDirectory, marker } = await fixture(t);
  const attempts = [];
  const runProcess = async spec => {
    attempts.push(spec);
    return { code: 0, stdout: JSON.stringify({ Id: "b".repeat(64),
      Name: `/${marker.projectName}-n8n-1`, State: { Running: true },
      Config: { Labels: { "com.docker.compose.project": "other", "com.docker.compose.service": "n8n" } } }), stderr: "" };
  };
  const options = withTestLocalSecurity({ marker, credential: { feature: "supergrok", apiKey: "secret-value" },
    dockerHost, homeDirectory, runProcess });
  assert.deepEqual(await importLocalStackN8nCredential(options), { state: "failed", name: "Relmio SuperGrok" });
  assert.equal(attempts.some(spec => spec.args[0] === "exec"), false);
  assert.deepEqual(await importLocalStackN8nCredential({ ...options, runProcess: async spec =>
    spec.args[0] === "container" ? { code: 0, stdout: JSON.stringify({ Id: "b".repeat(64),
      Name: `/${marker.projectName}-n8n-1`, State: { Running: true },
      Config: { Labels: { ...getLocalN8nStackLabels(marker),
        "com.docker.compose.project": marker.projectName, "com.docker.compose.service": "n8n" } } }), stderr: "" }
      : { code: 1, stdout: "secret-value", stderr: "secret-value" },
  }), { state: "failed", name: "Relmio SuperGrok" });
});
