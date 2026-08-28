import assert from "node:assert/strict";
import test from "node:test";

import {
  createInspectN8nEnabledModulesCommand,
  createInspectNetworksCommand,
  discoverN8n,
  discoverNetworks,
  parseN8nEnabledModulesOutput,
  parseDockerPsOutput,
} from "../src/services/discovery.js";

const dockerPsOutput = [
  JSON.stringify({
    ID: "traefik-id",
    Image: "traefik",
    Names: "n8n-traefik-1",
    State: "running",
  }),
  JSON.stringify({
    ID: "n8n-id",
    Image: "docker.n8n.io/n8nio/n8n",
    Names: "n8n-n8n-1",
    State: "running",
  }),
  JSON.stringify({
    ID: "other-id",
    Image: "ghcr.io/example/worker:latest",
    Names: "worker-1",
    State: "running",
  }),
].join("\n");

function createFakeRemote(outputs) {
  const commands = [];

  return {
    commands,
    async exec(command) {
      commands.push(command);
      if (!(command in outputs)) {
        throw new Error(`Unexpected command: ${command}`);
      }
      return { stdout: outputs[command], stderr: "", code: 0 };
    },
  };
}

test("parseDockerPsOutput finds only running official n8n images", () => {
  const containers = parseDockerPsOutput(dockerPsOutput);

  assert.deepEqual(containers, [
    {
      id: "n8n-id",
      image: "docker.n8n.io/n8nio/n8n",
      name: "n8n-n8n-1",
      state: "running",
    },
  ]);
});

test("discoverN8n uses read-only Docker commands", async () => {
  const remote = createFakeRemote({
    "docker version --format '{{.Server.Version}}'": "28.3.2\n",
    "docker compose version --short": "2.38.2\n",
    "docker ps --filter status=running --format '{{json .}}'": dockerPsOutput,
  });

  const result = await discoverN8n(remote);

  assert.equal(result.dockerVersion, "28.3.2");
  assert.equal(result.composeVersion, "2.38.2");
  assert.equal(result.containers[0].name, "n8n-n8n-1");
  assert.ok(remote.commands.every((command) => !/\b(stop|restart|rm)\b/.test(command)));
});

test("discoverNetworks validates the container name and prefers proxy", async () => {
  const command = createInspectNetworksCommand("n8n-n8n-1");
  const enabledModulesCommand = createInspectN8nEnabledModulesCommand("n8n-n8n-1");
  const remote = createFakeRemote({
    [command]: "n8n_default\nproxy\n",
    [enabledModulesCommand]: "configured|core, instance-ai, queue\n",
  });

  const result = await discoverNetworks(remote, "n8n-n8n-1");

  assert.deepEqual(result.networks, ["n8n_default", "proxy"]);
  assert.equal(result.recommended, "proxy");
  assert.deepEqual(result.instanceAi, { status: "enabled" });
  assert.ok(remote.commands.every((command) => !/\bdocker exec\b/i.test(command)));
  assert.ok(remote.commands.some((command) => command.startsWith("docker inspect n8n-n8n-1 --format")));
  assert.ok(remote.commands.every((command) => !/json \.Config\.Env/i.test(command)));
  assert.throws(
    () => createInspectNetworksCommand("n8n-n8n-1; docker stop n8n"),
    /invalid/i,
  );
});

test("N8N_ENABLED_MODULES parsing returns an allowlisted prerequisite status only", () => {
  assert.deepEqual(parseN8nEnabledModulesOutput(""), { status: "missing" });
  assert.deepEqual(
    parseN8nEnabledModulesOutput("configured|community-nodes, queue\n"),
    { status: "configured" },
  );
  assert.deepEqual(
    parseN8nEnabledModulesOutput("configured|community-nodes,  instance-ai  , queue\n"),
    { status: "enabled" },
  );
  for (const modules of [
    "core instance-ai",
    "community-nodes, instance-ai queue",
    "instance-ai-preview, queue",
    "queue, instance-ai-extra",
  ]) {
    assert.deepEqual(
      parseN8nEnabledModulesOutput(`configured|${modules}\n`),
      { status: "configured" },
    );
  }
  const status = parseN8nEnabledModulesOutput("configured|instance-ai, unexpected-secret-value\n");
  assert.deepEqual(status, { status: "enabled" });
  assert.equal(JSON.stringify(status).includes("unexpected-secret-value"), false);
  assert.throws(
    () => parseN8nEnabledModulesOutput("configured|instance-ai\nconfigured|queue\n"),
    /could not be verified/i,
  );
});

test("discovery reports malformed Docker output without exposing raw data", () => {
  assert.throws(
    () => parseDockerPsOutput("{not-json}"),
    /could not understand Docker/i,
  );
});
