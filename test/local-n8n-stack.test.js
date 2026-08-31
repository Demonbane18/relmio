import assert from "node:assert/strict";
import test from "node:test";
import * as nodeFileSystem from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_N8N_STACK_TARGET,
  createLocalN8nStackInstallation,
  createLocalN8nStackPlan,
  normalizeLocalN8nStackPlan,
} from "../src/domain/local-n8n-stack.js";
import {
  createLocalN8nStackComposeFile,
  createNgrokTrafficPolicy,
  LOCAL_N8N_STACK_IMAGES,
} from "../src/templates/local-n8n-stack/index.js";
import {
  installLocalN8nStack,
  removeLocalN8nStack,
} from "../src/services/local-n8n-stack-installer.js";

const DOCKER_HOST = "unix:///var/run/docker.sock";

function plan(overrides = {}) {
  return createLocalN8nStackPlan({
    dockerHost: DOCKER_HOST,
    ngrokHostname: "relmio-demo.ngrok.app",
    n8nPort: 5678,
    ngrokInspectorPort: 4040,
    timezone: "Asia/Manila",
    assistantMode: "disabled",
    ...overrides,
  });
}

test("local n8n plan accepts only public choices and rejects unsafe bindings", () => {
  const value = plan();
  assert.equal(value.target, LOCAL_N8N_STACK_TARGET);
  assert.equal(value.localUrl, "http://127.0.0.1:5678");
  assert.equal(value.ngrokPublicUrl, "https://relmio-demo.ngrok.app");
  assert.equal(value.hostPublication, "loopback-only");
  assert.deepEqual(normalizeLocalN8nStackPlan(value), value);

  for (const override of [
    { ngrokHostname: "https://relmio-demo.ngrok.app" },
    { ngrokHostname: "127.0.0.1" },
    { ngrokHostname: "relmio-demo.local" },
    { n8nPort: 10531 },
    { ngrokInspectorPort: 10531 },
    { n8nPort: 4040 },
    { timezone: "not/a-timezone" },
    { assistantMode: "anything" },
    { dockerHost: "tcp://remote.example:2376" },
  ]) {
    assert.throws(() => plan(override));
  }
});

test("install identity is collision resistant and carries a strict ownership marker", () => {
  let byte = 0;
  const installation = createLocalN8nStackInstallation({
    plan: plan({ assistantMode: "sandbox-with-searxng" }),
    randomBytes(length) {
      return Buffer.alloc(length, ++byte);
    },
  });
  assert.match(installation.installId, /^[a-f0-9]{32}$/);
  assert.match(installation.projectName, /^relmio-local-n8n-[a-f0-9]{32}$/);
  assert.equal(installation.projectName.slice(-32), installation.installId);
  assert.equal(installation.marker.kind, "relmio-local-n8n-stack");
  assert.equal(installation.marker.assistantMode, "sandbox-with-searxng");
  assert.throws(() => createLocalN8nStackInstallation({
    plan: plan(),
    randomBytes: () => Buffer.alloc(1),
  }));
});

test("generated compose keeps n8n and ngrok loopback-only and isolates assistants from edge", () => {
  const installation = createLocalN8nStackInstallation({
    plan: plan({ assistantMode: "sandbox-with-searxng" }),
    randomBytes: (() => {
      let byte = 6;
      return (length) => Buffer.alloc(length, ++byte);
    })(),
  });
  const compose = createLocalN8nStackComposeFile({ installation });
  assert.match(compose, /127\.0\.0\.1:5678:5678/);
  assert.match(compose, /127\.0\.0\.1:4040:4040/);
  assert.match(compose, /http:\/\/n8n:5678/);
  assert.match(compose, /ngrok:\n[\s\S]*networks:\n      - edge/);
  assert.match(compose, /relmio-sandbox-api:[\s\S]*?networks: \[assistant-internal, assistant-shared\]/);
  assert.match(compose, /relmio-searxng:[\s\S]*?networks: \[assistant-shared\]/);
  assert.doesNotMatch(compose, /10531/);
  assert.match(compose, /io\.relmio\.target: "local-n8n-stack"/);
  assert.match(compose, /N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true"/);
  assert.match(compose, /--traffic-policy-file=\/run\/secrets\/ngrok-traffic-policy\.yml/u);
  assert.match(compose, /ngrok-traffic-policy:\n    file: \.\/\.runtime\/traffic-policy\.yml/u);
  assert.doesNotMatch(compose, /\.runtime\/traffic-policy\.yml:\/etc\/ngrok/u);
  for (const service of ["relmio-sandbox-certs", "relmio-sandbox-api", "relmio-sandbox-runner-1", "relmio-searxng"]) {
    assert.match(compose, new RegExp(`${service}:[\\s\\S]*?restart: "no"`));
  }
});

test("every local n8n production image is pinned by immutable digest", () => {
  for (const image of Object.values(LOCAL_N8N_STACK_IMAGES)) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/u);
  }
});

test("traffic policy requires basic authentication without disclosing it in errors", () => {
  const policy = createNgrokTrafficPolicy({
    username: "operator",
    password: "very-secret-password",
  });
  assert.match(policy, /basic-auth/);
  assert.match(policy, /operator:very-secret-password/);
  assert.throws(
    () => createNgrokTrafficPolicy({ username: "operator", password: "" }),
    /Basic Auth credentials are invalid/,
  );
});

async function testHome(t) {
  const value = await realpath(await mkdtemp(join(tmpdir(), "relmio-local-stack-")));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

function createStackRunner({
  malformedPublisher = false,
  assistantMode = "disabled",
  assistantPublishers = [],
  partialUpFailure = false,
  partialResources = false,
  foreignProjectResource = false,
  resourcesRemainAfterDown = false,
} = {}) {
  const calls = [];
  let up = false;
  let resourcesExist = false;
  const services = [
    "n8n",
    "ngrok",
    ...(assistantMode === "disabled"
      ? []
      : ["relmio-sandbox-certs", "relmio-sandbox-api", "relmio-sandbox-runner-1"]),
    ...(assistantMode === "sandbox-with-searxng" ? ["relmio-searxng"] : []),
  ];
  const runningServices = services.filter((service) => service !== "relmio-sandbox-certs");
  const runner = async (spec) => {
    calls.push(spec);
    const joined = spec.args.join(" ");
    if (joined === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return { code: 0, stdout: JSON.stringify(DOCKER_HOST), stderr: "" };
    }
    if (joined.includes("config --quiet")) return { code: 0, stdout: "", stderr: "" };
    if (joined.includes("up -d --wait")) {
      up = true;
      resourcesExist = true;
      return partialUpFailure
        ? { code: 1, stdout: "", stderr: "creation interrupted" }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("down --volumes --remove-orphans")) {
      up = false;
      if (!resourcesRemainAfterDown) resourcesExist = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("ps --status running --services")) {
      return { code: 0, stdout: up ? `${runningServices.join("\n")}\n` : "", stderr: "" };
    }
    if (joined.includes("ps --format json")) {
      const service = spec.args.at(-1);
      const expected = service === "n8n" ? 5678 : 4040;
      const isAssistant = !["n8n", "ngrok"].includes(service);
      return {
        code: 0,
        stdout: JSON.stringify({
          Service: service,
          State: "running",
          Health: "healthy",
          Publishers: isAssistant
            ? assistantPublishers
            : [{
              URL: malformedPublisher && service === "ngrok" ? "0.0.0.0" : "127.0.0.1",
              PublishedPort: expected,
              TargetPort: expected,
              Protocol: "tcp",
            }],
        }),
        stderr: "",
      };
    }
    const project = spec.args.find((value) => value.startsWith("label=com.docker.compose.project="))?.split("=").at(-1);
    const installId = project?.slice(-32);
    const labels = `com.docker.compose.project=${project},io.relmio.managed=true,io.relmio.target=${LOCAL_N8N_STACK_TARGET},io.relmio.install=${installId},io.relmio.project=${project}`;
    if (spec.args[0] === "ps" && project) {
      if (!resourcesExist) return { code: 0, stdout: "", stderr: "" };
      const listedServices = partialResources ? ["n8n"] : services;
      const rows = listedServices.map((service) => JSON.stringify({
        ID: `${service}-id`,
        Names: `${project}-${service}-1`,
        Labels: `${labels},com.docker.compose.service=${service}`,
      }));
      if (foreignProjectResource) {
        rows.push(JSON.stringify({
          ID: "foreign-id",
          Names: `${project}-foreign-1`,
          Labels: `com.docker.compose.project=${project},io.relmio.managed=true,io.relmio.target=${LOCAL_N8N_STACK_TARGET},io.relmio.install=${"f".repeat(32)},io.relmio.project=${project},com.docker.compose.service=foreign`,
        }));
      }
      return {
        code: 0,
        stdout: rows.join("\n"),
        stderr: "",
      };
    }
    if ((spec.args[0] === "volume" || spec.args[0] === "network") && project) {
      if (!resourcesExist) return { code: 0, stdout: "", stderr: "" };
      const names = spec.args[0] === "volume"
        ? [`${project}_n8n-data`, ...(assistantMode === "disabled" ? [] : [`${project}_sandbox-tls`])]
        : [`${project}_edge`, ...(assistantMode === "disabled" ? [] : [`${project}_assistant-shared`, `${project}_assistant-internal`])];
      return {
        code: 0,
        stdout: (partialResources ? [] : names).map((Name) => JSON.stringify({ Name, Labels: labels })).join("\n"),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

test("installer creates only the new owned project and returns a redacted result", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner();
  const result = await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
    randomBytes: (() => { let value = 10; return (length) => Buffer.alloc(length, ++value); })(),
  });
  assert.equal(result.target, LOCAL_N8N_STACK_TARGET);
  assert.equal(result.localUrl, "http://127.0.0.1:5678");
  assert.equal(result.ngrokPublicUrl, "https://relmio-demo.ngrok.app");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("container inspect")), false);
  assert.equal(calls.some((entry) => /\b(restart|recreate|exec)\b/u.test(entry.args.join(" "))), false);
  const installRoot = join(homeDirectory, ".relmio", "local", "n8n-stack");
  assert.equal((await stat(installRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(join(installRoot, ".env"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(installRoot, ".managed-by-relmio.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(installRoot, "docker-compose.yml"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(installRoot, "ngrok.yml"))).mode & 0o777, 0o644);
  assert.equal((await stat(join(installRoot, ".runtime", "traffic-policy.yml"))).mode & 0o777, 0o600);
  const removed = await removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "REMOVE_LOCAL_N8N_STACK",
  });
  assert.deepEqual(removed, {
    target: LOCAL_N8N_STACK_TARGET,
    removed: true,
    deploymentMode: "removed-owned-disposable-stack",
  });
  await assert.rejects(() => stat(installRoot));
});

test("malformed host publication fails closed, rolls back only an attested project, and removal needs confirmation", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({ malformedPublisher: true });
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  }));
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), true);
  await assert.rejects(() => removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "wrong",
  }));
});

test("Assistant services accept only empty or Compose placeholder unpublished publishers", async (t) => {
  for (const publishers of [
    [],
    [{ URL: "", PublishedPort: 0, TargetPort: 8080, Protocol: "tcp" }],
  ]) {
    const homeDirectory = await testHome(t);
    const { runner } = createStackRunner({
      assistantMode: "sandbox-with-searxng",
      assistantPublishers: publishers,
    });
    const result = await installLocalN8nStack({
      plan: plan({ assistantMode: "sandbox-with-searxng" }),
      secrets: {
        ngrokAuthtoken: "ngrok-private-token",
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
      homeDirectory,
      runProcess: runner,
    });
    assert.equal(result.assistantMode, "sandbox-with-searxng");
    assert.equal(
      (await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".runtime", "searxng-settings.yml"))).mode & 0o777,
      0o644,
    );
  }

  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    assistantMode: "sandbox",
    assistantPublishers: [{ URL: "", PublishedPort: 0, TargetPort: 8080, Protocol: "udp" }],
  });
  await assert.rejects(() => installLocalN8nStack({
    plan: plan({ assistantMode: "sandbox" }),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  }));
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), true);
});

test("project-wide ownership attestation exposes foreign project resources and refuses cleanup", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({ foreignProjectResource: true });
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  }));
  const ownershipCalls = calls.filter((entry) => entry.args[0] === "ps" && entry.args.includes("--all"));
  assert.equal(ownershipCalls.length > 0, true);
  assert.equal(ownershipCalls.every((entry) => !entry.args.some((value) => value.startsWith("label=io.relmio.install="))), true);
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), false);
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack"));
});

test("a nonzero partial Compose up is ownership-attested, rolled back, and removes managed files", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    partialUpFailure: true,
    partialResources: true,
  });
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  }));
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), true);
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
});

test("removal preserves ownership evidence when Docker resources remain after Compose down", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner({ resourcesRemainAfterDown: true });
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
  await assert.rejects(() => removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "REMOVE_LOCAL_N8N_STACK",
  }));
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
});

test("managed-file creation failures leave the install retryable", async (t) => {
  for (const failAt of [1, 2, 3, 4, 5, 6, 7]) {
    const homeDirectory = await testHome(t);
    const { runner } = createStackRunner();
    let writes = 0;
    const fileSystem = {
      ...nodeFileSystem,
      async writeFile(...args) {
        writes += 1;
        if (writes === failAt) throw Object.assign(new Error("injected write failure"), { code: "EIO" });
        return nodeFileSystem.writeFile(...args);
      },
    };
    await assert.rejects(() => installLocalN8nStack({
      plan: plan(),
      secrets: {
        ngrokAuthtoken: "ngrok-private-token",
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
      homeDirectory,
      runProcess: runner,
      fileSystem,
    }));
    await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
    await installLocalN8nStack({
      plan: plan(),
      secrets: {
        ngrokAuthtoken: "ngrok-private-token",
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
      homeDirectory,
      runProcess: runner,
    });
  }
});

test("an install-directory chmod failure leaves the install retryable", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  const installRoot = join(homeDirectory, ".relmio", "local", "n8n-stack");
  let failed = false;
  const fileSystem = {
    ...nodeFileSystem,
    async chmod(path, mode) {
      if (!failed && path === installRoot) {
        failed = true;
        throw Object.assign(new Error("injected chmod failure"), { code: "EIO" });
      }
      return nodeFileSystem.chmod(path, mode);
    },
  };
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
    fileSystem,
  }));
  await assert.rejects(() => stat(installRoot));
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
});

test("installation identity failure releases its lifecycle lock for retry", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
    randomBytes: () => Buffer.alloc(1),
  }));
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack.lock")));
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
});

test("an older operation cannot remove a replacement lifecycle lock", async (t) => {
  const homeDirectory = await testHome(t);
  const lockPath = join(homeDirectory, ".relmio", "local", "n8n-stack.lock");
  const { runner: baseRunner } = createStackRunner();
  let replaced = false;
  const runner = async (spec) => {
    const result = await baseRunner(spec);
    if (!replaced && spec.args.join(" ").includes("up -d --wait")) {
      replaced = true;
      await rm(lockPath, { recursive: true, force: false });
      await mkdir(lockPath, { mode: 0o700 });
      await nodeFileSystem.writeFile(join(lockPath, ".owner.json"), `${JSON.stringify({ token: "replacement" })}\n`, { mode: 0o600 });
    }
    return result;
  };
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  }));
  await stat(join(lockPath, ".owner.json"));
});

test("an active lifecycle lock blocks destructive stack removal", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
  await mkdir(join(homeDirectory, ".relmio", "local", "n8n-stack.lock"), { mode: 0o700 });
  await assert.rejects(() => removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "REMOVE_LOCAL_N8N_STACK",
  }));
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
});
