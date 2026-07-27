import assert from "node:assert/strict";
import test from "node:test";

import {
  validateDockerName,
  validateHostname,
  validatePort,
  validateUsername,
} from "../src/domain/validation.js";
import {
  assertSidecarOnlyCommands,
  createDeploymentCommands,
} from "../src/domain/safety.js";
import {
  createComposeFile,
  createDockerfile,
} from "../src/domain/templates.js";

test("validation accepts ordinary Hostinger and Docker values", () => {
  assert.equal(validateHostname("203.0.113.10"), "203.0.113.10");
  assert.equal(validateHostname("n8n.example.com"), "n8n.example.com");
  assert.equal(validatePort("22"), 22);
  assert.equal(validateUsername("root"), "root");
  assert.equal(validateDockerName("proxy"), "proxy");
  assert.equal(validateDockerName("n8n-n8n-1"), "n8n-n8n-1");
});

test("validation rejects values that could become remote shell syntax", () => {
  const invalidValues = [
    "proxy; docker stop n8n",
    "$(id)",
    "network name",
    "name\nsecond-command",
    "--help",
  ];

  for (const value of invalidValues) {
    assert.throws(() => validateDockerName(value), /invalid/i);
  }

  assert.throws(() => validateHostname("example.com;id"), /invalid/i);
  assert.throws(() => validateHostname("148.230.103.999"), /invalid/i);
  assert.throws(() => validatePort("22abc"), /invalid/i);
  assert.throws(() => validatePort("70000"), /invalid/i);
  assert.throws(() => validateUsername("root;id"), /invalid/i);
});

test("generated commands operate only on the sidecar project", () => {
  const commands = createDeploymentCommands();

  assert.doesNotThrow(() => assertSidecarOnlyCommands(commands));
  assert.ok(
    commands.every((command) => !command.includes("/docker/n8n/docker-compose")),
  );
  assert.ok(commands.every((command) => !command.includes("n8nio/n8n")));
  assert.ok(commands.every((command) => !/\bdocker restart\b/.test(command)));
  assert.ok(commands.every((command) => !/\bdocker stop\b/.test(command)));
  assert.ok(
    commands.some(
      (command) =>
        command.includes("up -d --wait --wait-timeout 60 --no-deps openai-oauth"),
    ),
  );
});

test("the safety policy rejects attempts to mutate n8n", () => {
  const forbidden = [
    "docker restart n8n-n8n-1",
    "docker stop n8n-n8n-1",
    "docker compose -f /docker/n8n/docker-compose.yml up -d",
    "docker rmi docker.n8n.io/n8nio/n8n",
  ];

  for (const command of forbidden) {
    assert.throws(() => assertSidecarOnlyCommands([command]), /n8n|sidecar/i);
  }
});

test("the generated Compose file is internal-only and uses an external network", () => {
  const compose = createComposeFile({ networkName: "proxy" });

  assert.match(compose, /external: true/);
  assert.match(compose, /name: proxy/);
  assert.match(compose, /expose:\n\s+- "10531"/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.doesNotMatch(compose, /traefik/i);
  assert.doesNotMatch(compose, /n8nio\/n8n/);
});

test("the generated Dockerfile pins openai-oauth and runs as a non-root user", () => {
  const dockerfile = createDockerfile();

  assert.match(dockerfile, /openai-oauth@2\.0\.0/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(
    dockerfile,
    /CMD \["--host", "0\.0\.0\.0", "--port", "10531", "--oauth-file", "\/home\/node\/\.codex\/auth\.json"\]/,
  );
});
