import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createLocalDockerEnvironment,
  lockDownLocalPath,
  runWindowsAclCommand,
  runLocalProcess,
  validateLocalDockerHost,
} from "../src/infrastructure/local-process.js";

const LOCAL_DOCKER_HOST = "unix:///var/run/docker.sock";
const WINDOWS_DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine";
const RUNNER_DOCKER_HOST =
  process.platform === "win32" ? WINDOWS_DOCKER_HOST : LOCAL_DOCKER_HOST;

function inspectWindowsAcl(path) {
  return new Promise((resolve, reject) => {
    const windowsPowerShell = join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const script = [
      "$path=[Console]::In.ReadToEnd()",
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$item=Get-Item -LiteralPath $path",
      "if($item.PSIsContainer){$acl=[System.IO.DirectoryInfo]::new($path).GetAccessControl()}else{$acl=[System.IO.FileInfo]::new($path).GetAccessControl()}",
      "$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier])",
      "$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
      "$result=[ordered]@{accessRulesProtected=[bool]($acl.AreAccessRulesProtected);ownerIsCurrent=[bool]($owner.Value -eq $sid.Value);rules=@($rules|ForEach-Object{[ordered]@{identity=if($_.IdentityReference.Value -eq $sid.Value){'current-user'}else{'other'};accessType=[int]($_.AccessControlType);rights=[int]($_.FileSystemRights);inheritance=[int]($_.InheritanceFlags);propagation=[int]($_.PropagationFlags);inherited=[bool]($_.IsInherited)}})}",
      "$result|ConvertTo-Json -Compress -Depth 4",
    ].join(";");
    const child = spawn(
      windowsPowerShell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stdin.end(path);
    child.once("error", () => reject(new Error("Independent Windows ACL inspection could not start.")));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error("Independent Windows ACL inspection failed."));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Independent Windows ACL inspection returned an invalid result."));
      }
    });
  });
}

function assertExactOwnerOnlyAcl(actual, expectedInheritance) {
  const diagnostic = JSON.stringify(actual);
  assert.equal(actual.accessRulesProtected, true, diagnostic);
  assert.equal(actual.ownerIsCurrent, true, diagnostic);
  assert.equal(actual.rules.length, 1);
  assert.deepEqual(actual.rules[0], {
    identity: "current-user",
    accessType: 0,
    rights: 2_032_127,
    inheritance: expectedInheritance,
    propagation: 0,
    inherited: false,
  });
}

function createFakeChild(onSpawn = () => {}, { closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.closed = false;
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (closeOnKill && !child.closed) {
      queueMicrotask(() => {
        if (!child.closed) {
          child.closed = true;
          child.emit("close", 143);
        }
      });
    }
    return true;
  };
  queueMicrotask(() => onSpawn(child));
  return child;
}

function closeChild(child, code = 1) {
  if (!child.closed) {
    child.closed = true;
    child.emit("close", code);
  }
}

function createManualTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimer(callback, milliseconds) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { callback, milliseconds });
      return id;
    },
    clearTimer(id) {
      scheduled.delete(id);
    },
    fire(milliseconds) {
      const entry = [...scheduled.entries()].find(
        ([, timer]) => timer.milliseconds === milliseconds,
      );
      assert.ok(entry, `Expected a ${milliseconds}ms timer.`);
      const [id, timer] = entry;
      scheduled.delete(id);
      timer.callback();
    },
    get activeCount() {
      return scheduled.size;
    },
  };
}

async function assertPromisePending(promise) {
  const state = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => queueMicrotask(() => resolve("pending"))),
  ]);
  assert.equal(state, "pending");
}

test("validateLocalDockerHost accepts local Unix sockets and Docker Desktop's Linux engine pipe", () => {
  assert.equal(
    validateLocalDockerHost(LOCAL_DOCKER_HOST, { platform: "linux" }),
    LOCAL_DOCKER_HOST,
  );
  assert.equal(
    validateLocalDockerHost("unix:///Users/test/.docker/run/docker.sock", {
      platform: "darwin",
    }),
    "unix:///Users/test/.docker/run/docker.sock",
  );

  for (const value of [
    "tcp://127.0.0.1:2375",
    "ssh://docker@example.test",
    "http://127.0.0.1:2375",
    "unix://remote.example.test/var/run/docker.sock",
    "unix:///var/run/docker.sock?context=remote",
    "unix:///var/run/docker.sock#remote",
    "unix:///var/run/%64ocker.sock",
    "unix://",
    "relative/docker.sock",
    "unix:///var/run/docker.sock\n--host=tcp://example.test",
  ]) {
    assert.throws(
      () => validateLocalDockerHost(value, { platform: "linux" }),
      /docker host|unix|unsupported/i,
    );
  }
  assert.equal(
    validateLocalDockerHost(WINDOWS_DOCKER_HOST, { platform: "win32" }),
    WINDOWS_DOCKER_HOST,
  );
  assert.throws(
    () => validateLocalDockerHost(LOCAL_DOCKER_HOST, { platform: "win32" }),
    /Windows.*Docker Desktop.*Linux engine pipe/iu,
  );
  assert.throws(() => validateLocalDockerHost("npipe:////./pipe/docker_engine", { platform: "win32" }));
});

test("local process runner pins Docker to the validated local host and sanitizes its environment", async () => {
  let invocation;
  const result = await runLocalProcess(
    {
      file: "docker",
      args: ["compose", "version", "--short"],
      cwd: "/tmp/relmio-test",
      dockerHost: RUNNER_DOCKER_HOST,
    },
    {
      environment: {
        PATH: "/usr/bin",
        LANG: "C",
        DOCKER_HOST: "tcp://attacker.example.test:2375",
        docker_context: "remote",
        DOCKER_CONFIG: "/tmp/remote-docker-config",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/tmp/remote-certificates",
        BUILDKIT_HOST: "tcp://attacker.example.test:1234",
        NGROK_AUTHTOKEN: "stale-shell-token",
        compose_file: "/tmp/unreviewed-compose.yml",
      },
      spawnProcess(file, args, options) {
        invocation = { file, args, options };
        return createFakeChild((child) => {
          child.stdout.end("2.29.0\n");
          child.stderr.end();
          closeChild(child, 0);
        });
      },
    },
  );

  assert.deepEqual(result, { stdout: "2.29.0\n", stderr: "", code: 0 });
  assert.equal(invocation.file, "docker");
  assert.deepEqual(invocation.args, [
    "--host",
    RUNNER_DOCKER_HOST,
    "compose",
    "version",
    "--short",
  ]);
  assert.deepEqual(invocation.options, {
    cwd: "/tmp/relmio-test",
    env: { PATH: "/usr/bin", LANG: "C" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
});

test("local Docker environments remove managed interpolation and Compose controls case-insensitively", () => {
  const managedNames = [
    "NGROK_AUTHTOKEN",
    "N8N_ENCRYPTION_KEY",
    "NGROK_DOMAIN",
    "N8N_LOCAL_PORT",
    "NGROK_INSPECTOR_PORT",
    "GENERIC_TIMEZONE",
    "SANDBOX_API_KEYS",
    "SANDBOX_API_RUNNER_REGISTRATION_TOKEN",
    "SANDBOX_API_RUNNER_API_KEY",
    "SEARXNG_SECRET",
  ];
  const environment = {
    PATH: "/usr/bin",
    RELMIO_UNRELATED: "preserved",
    COMPOSER_TOKEN: "also-preserved",
    Compose_Project_Name: "unreviewed-project",
    compose_profiles: "unreviewed-profile",
  };
  for (const name of managedNames) {
    environment[
      [...name]
        .map((character, index) =>
          index % 2 === 0 ? character.toLowerCase() : character,
        )
        .join("")
    ] = `stale-${name}`;
  }

  assert.deepEqual(createLocalDockerEnvironment(environment), {
    PATH: "/usr/bin",
    RELMIO_UNRELATED: "preserved",
    COMPOSER_TOKEN: "also-preserved",
  });
});

test("local process runner permits an unpinned initial Docker context inspection", async () => {
  let invocation;
  await runLocalProcess(
    {
      file: "docker",
      args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      cwd: "/tmp/relmio-test",
    },
    {
      environment: { PATH: "/usr/bin", DOCKER_CONTEXT: "remote" },
      spawnProcess(file, args, options) {
        invocation = { file, args, options };
        return createFakeChild((child) => closeChild(child, 0));
      },
    },
  );

  assert.deepEqual(invocation.args, [
    "context",
    "inspect",
    "--format",
    "{{json .Endpoints.docker.Host}}",
  ]);
  assert.deepEqual(invocation.options.env, { PATH: "/usr/bin" });
});

test("Windows managed paths are ACL-locked to the current account before use", async () => {
  const calls = [];
  await lockDownLocalPath("C:\\Users\\test\\.relmio", {
    platform: "win32",
    systemRoot: "C:\\Windows",
    async runAclCommand(file, args, options) {
      calls.push({ file, args, options });
      return { stdout: "" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].file,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.doesNotMatch(calls[0].file, /^powershell(?:\.exe)?$/iu);
  assert.deepEqual(calls[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(calls[0].options.input, "C:\\Users\\test\\.relmio");
  assert.match(calls[0].args[4], /\$identity=\[System\.Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)/u);
  assert.match(calls[0].args[4], /\$beforeOwner=\$before\.GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)/u);
  assert.match(calls[0].args[4], /BuiltinAdministratorsSid/u);
  assert.match(calls[0].args[4], /WindowsBuiltInRole\]::Administrator/u);
  assert.match(calls[0].args[4], /\$beforeOwner\.Value -ne \$sid\.Value -and \(-not \(\$beforeOwner\.Value -eq \$administratorsSid\.Value/u);
  assert.match(calls[0].args[4], /if\(\$normalizeOwner\)\{\$acl\.SetOwner\(\$sid\)\}/u);
  assert.match(calls[0].args[4], /SetAccessRuleProtection\(\$true,\$false\)/u);
  assert.match(calls[0].args[4], /ContainerInherit[^;]*ObjectInherit/u);
  assert.match(calls[0].args[4], /\$rules\.Count -ne 1/u);
  assert.match(calls[0].args[4], /FileSystemRights -ne \[System\.Security\.AccessControl\.FileSystemRights\]::FullControl/u);
  assert.match(calls[0].args[4], /PropagationFlags -ne \[System\.Security\.AccessControl\.PropagationFlags\]::None/u);
  assert.match(calls[0].args[4], /\.IsInherited/u);
  assert.match(calls[0].args[4], /\$actual\.GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)/u);
  assert.match(calls[0].args[4], /\$owner\.Value -ne \$sid\.Value/u);
});

test("Windows managed paths can verify an exact ACL without rewriting it", async () => {
  let script = "";
  await lockDownLocalPath("C:\\Users\\test\\.relmio", {
    platform: "win32",
    systemRoot: "C:\\Windows",
    verifyOnly: true,
    async runAclCommand(_file, args) {
      script = args[4];
    },
  });
  assert.match(script, /\$actual=\$before/u);
  assert.doesNotMatch(script, /SetAccessControl|SetAccessRuleProtection|SetOwner|New-Object/u);
  assert.match(script, /\$rules\.Count -ne 1/u);
  assert.match(script, /AreAccessRulesProtected/u);
  await assert.rejects(
    () => lockDownLocalPath("C:\\Users\\test\\.relmio", {
      platform: "win32",
      systemRoot: "C:\\Windows",
      verifyOnly: "yes",
      async runAclCommand() {},
    }),
    /verification mode is invalid/u,
  );
});

test("Windows ACL lockdown rejects malformed system roots before invoking a process", async () => {
  const invalidSystemRoots = [
    null,
    "",
    "Windows",
    "C:\\NotWindows",
    "C:\\Windows\\System32",
    "C:\\other\\..\\Windows",
    "\\\\server\\share\\Windows",
    "C:\\Windows\0untrusted",
  ];
  for (const systemRoot of invalidSystemRoots) {
    let invoked = false;
    await assert.rejects(
      () =>
        lockDownLocalPath("C:\\Users\\test\\.relmio", {
          platform: "win32",
          systemRoot,
          async runAclCommand() {
            invoked = true;
          },
        }),
      /built-in security tool/iu,
    );
    assert.equal(invoked, false);
  }
});

test("Windows ACL lockdown sanitizes PowerShell launch and proof failures", async () => {
  const privateDetail = "private-upstream-detail";
  await assert.rejects(
    () =>
      lockDownLocalPath("C:\\Users\\test\\.relmio", {
        platform: "win32",
        systemRoot: "D:\\Windows",
        async runAclCommand() {
          throw new Error(privateDetail);
        },
      }),
    (error) => {
      assert.match(error.message, /owner-only protection/iu);
      assert.doesNotMatch(error.message, new RegExp(privateDetail, "u"));
      assert.doesNotMatch(error.message, /powershell|D:\\\\Windows/iu);
      return true;
    },
  );
});

test("Windows ACL runner bounds stalled and overlong security subprocesses", async (t) => {
  await t.test("timeout", async () => {
    const child = createFakeChild(() => {}, { closeOnKill: false });
    await assert.rejects(
      runWindowsAclCommand("C:\\Windows\\powershell.exe", [], {
        input: "C:\\Users\\test\\.relmio",
        spawnProcess: () => child,
        timeoutMs: 5,
        terminationGraceMs: 5,
      }),
      /timed out/u,
    );
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });

  await t.test("output limit", async () => {
    let child;
    await assert.rejects(
      runWindowsAclCommand("C:\\Windows\\powershell.exe", [], {
        spawnProcess() {
          child = createFakeChild((spawned) => {
            spawned.stdout.write(Buffer.alloc(9));
          });
          return child;
        },
        maxOutputBytes: 8,
        timeoutMs: 1_000,
        terminationGraceMs: 5,
      }),
      /too much output/u,
    );
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });
});

test(
  "Windows ACL lockdown succeeds against real NTFS directories and files",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "relmio-acl-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await lockDownLocalPath(directory, { platform: "win32" });
    const credentialPath = join(directory, "auth.json");
    await writeFile(credentialPath, "{}", "utf8");
    await lockDownLocalPath(credentialPath, { platform: "win32", kind: "file" });
    await lockDownLocalPath(directory, { platform: "win32", verifyOnly: true });
    await lockDownLocalPath(credentialPath, {
      platform: "win32",
      kind: "file",
      verifyOnly: true,
    });
    assertExactOwnerOnlyAcl(await inspectWindowsAcl(directory), 3);
    assertExactOwnerOnlyAcl(await inspectWindowsAcl(credentialPath), 0);
  },
);

test("local process runner rejects executable, argument, and Docker host injection", async () => {
  for (const input of [
    { file: "sh", args: ["-c", "id"], cwd: "/tmp" },
    { file: "docker", args: ["compose\nrun", "id"], cwd: "/tmp" },
    { file: "docker", args: ["compose", "\0bad"], cwd: "/tmp" },
    { file: "docker", args: ["compose"], cwd: "relative/path" },
    {
      file: "docker",
      args: ["version"],
      cwd: "/tmp",
      dockerHost: "tcp://attacker.example.test:2375",
    },
  ]) {
    await assert.rejects(
      () => runLocalProcess(input),
      /process|docker|argument|directory|host/i,
    );
  }
});

test("local process runner waits for close after output overflow and clears its kill timer", async () => {
  let child;
  const timers = createManualTimers();
  const processPromise = runLocalProcess(
    {
      file: "docker",
      args: ["version"],
      cwd: "/tmp",
      maxOutputBytes: 8,
    },
    {
      spawnProcess() {
        child = createFakeChild(
          (fake) => fake.stdout.write("123456789"),
          { closeOnKill: false },
        );
        return child;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      terminationGraceMs: 25,
    },
  );

  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  await assertPromisePending(processPromise);

  closeChild(child);
  await assert.rejects(processPromise, /output|limit/i);
  assert.equal(timers.activeCount, 0);
});

test("local process runner settles after an ignored SIGKILL without waiting forever", async () => {
  let child;
  const timers = createManualTimers();
  const processPromise = runLocalProcess(
    {
      file: "docker",
      args: ["version"],
      cwd: "/tmp",
      timeoutMs: 100,
    },
    {
      spawnProcess() {
        child = createFakeChild(() => {}, { closeOnKill: false });
        return child;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      terminationGraceMs: 25,
    },
  );

  timers.fire(100);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  await assertPromisePending(processPromise);

  timers.fire(25);
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  await assertPromisePending(processPromise);
  assert.equal(timers.activeCount, 1);

  timers.fire(25);
  await assert.rejects(processPromise, /timed out/i);
  assert.equal(timers.activeCount, 0);

  // Late process events after terminal settlement are idempotent.
  closeChild(child);
});

test("local process runner terminates before settling an stdin failure", async () => {
  let child;
  const timers = createManualTimers();
  const processPromise = runLocalProcess(
    {
      file: "docker",
      args: ["compose", "up"],
      cwd: "/tmp",
    },
    {
      spawnProcess() {
        child = createFakeChild(() => {}, { closeOnKill: false });
        return child;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      terminationGraceMs: 25,
    },
  );

  child.stdin.emit("error", new Error("write failed"));
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  await assertPromisePending(processPromise);

  closeChild(child);
  await assert.rejects(processPromise, /could not start/i);
  assert.equal(timers.activeCount, 0);
});

test("local process runner never includes child stderr in startup errors", async () => {
  await assert.rejects(
    () =>
      runLocalProcess(
        {
          file: "docker",
          args: ["version"],
          cwd: "/tmp",
        },
        {
          spawnProcess() {
            return createFakeChild((child) => {
              child.stderr.write("sk-super-secret-upstream-value");
              child.emit("error", new Error("spawn included secret"));
            });
          },
        },
      ),
    (error) => {
      assert.doesNotMatch(error.message, /secret|sk-/i);
      return true;
    },
  );
});
