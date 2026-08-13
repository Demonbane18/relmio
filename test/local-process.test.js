import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  runLocalProcess,
  validateLocalDockerHost,
} from "../src/infrastructure/local-process.js";

const LOCAL_DOCKER_HOST = "unix:///var/run/docker.sock";

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

test("validateLocalDockerHost accepts only local POSIX Unix socket URIs", () => {
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
  assert.throws(
    () => validateLocalDockerHost(LOCAL_DOCKER_HOST, { platform: "win32" }),
    /unsupported|docker host/i,
  );
});

test("local process runner pins Docker to the validated local host and sanitizes its environment", async () => {
  let invocation;
  const result = await runLocalProcess(
    {
      file: "docker",
      args: ["compose", "version", "--short"],
      cwd: "/tmp/relmio-test",
      dockerHost: LOCAL_DOCKER_HOST,
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
    LOCAL_DOCKER_HOST,
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
