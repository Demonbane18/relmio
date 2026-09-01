import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  getLocalProcessIdentity,
  runIdentityCommand,
} from "../src/infrastructure/process-identity.js";

function createIdentityChild(onStart = () => {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    queueMicrotask(() => child.emit("close", 143));
    return true;
  };
  queueMicrotask(() => onStart(child));
  return child;
}

test("the current process has a stable active identity", async () => {
  const identity = await getLocalProcessIdentity(process.pid);
  assert.equal(identity.state, "active");
  assert.match(identity.startIdentity, /^(?:linux|darwin|win32):/u);
});

test("Linux identity combines boot ID and field 22 without trusting the process name", async () => {
  const startTicks = "987654";
  const stat = `42 (worker ) name) R ${Array(18).fill("0").join(" ")} ${startTicks}`;
  const identity = await getLocalProcessIdentity(42, {
    platform: "linux",
    fileSystem: {
      async readFile(path) {
        if (path === "/proc/42/stat") return stat;
        if (path === "/proc/sys/kernel/random/boot_id") {
          return "12345678-1234-1234-1234-123456789abc\n";
        }
        throw new Error("unexpected path");
      },
    },
    runCommand: async () => { throw new Error("not used"); },
  });
  assert.deepEqual(identity, {
    state: "active",
    startIdentity: `linux:12345678-1234-1234-1234-123456789abc:${startTicks}`,
  });
});

test("Linux identity distinguishes a missing process from ambiguous metadata", async () => {
  const dead = await getLocalProcessIdentity(7, {
    platform: "linux",
    fileSystem: {
      async readFile() {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    },
    runCommand: async () => { throw new Error("not used"); },
  });
  assert.deepEqual(dead, { state: "dead" });

  const ambiguous = await getLocalProcessIdentity(7, {
    platform: "linux",
    fileSystem: {
      async readFile(path) {
        return path.endsWith("/stat")
          ? `7 (worker) R ${Array(18).fill("0").join(" ")} 123`
          : "invalid-boot-id";
      },
    },
    runCommand: async () => { throw new Error("not used"); },
  });
  assert.deepEqual(ambiguous, { state: "ambiguous" });
});

test("macOS identity parses only the fixed C-locale lstart format", async () => {
  const active = await getLocalProcessIdentity(9, {
    platform: "darwin",
    fileSystem: null,
    runCommand: async (file, args) => {
      assert.equal(file, "/bin/ps");
      assert.deepEqual(args, ["-p", "9", "-o", "lstart="]);
      return { code: 0, stdout: "Tue Sep  1 12:34:56 2026\n" };
    },
  });
  assert.deepEqual(active, {
    state: "active",
    startIdentity: "darwin:Tue Sep  1 12:34:56 2026",
  });

  const ambiguous = await getLocalProcessIdentity(9, {
    platform: "darwin",
    fileSystem: null,
    runCommand: async () => ({ code: 0, stdout: "localized value" }),
  });
  assert.deepEqual(ambiguous, { state: "ambiguous" });
});

test("Windows identity uses only the validated system PowerShell and PID stdin", async () => {
  const active = await getLocalProcessIdentity(11, {
    platform: "win32",
    fileSystem: null,
    systemRoot: "C:\\Windows",
    runCommand: async (file, args, options) => {
      assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.equal(args.includes("-NonInteractive"), true);
      assert.deepEqual(options, { input: "11" });
      return { code: 0, stdout: "active:638923456789012345" };
    },
  });
  assert.deepEqual(active, {
    state: "active",
    startIdentity: "win32:638923456789012345",
  });

  const dead = await getLocalProcessIdentity(11, {
    platform: "win32",
    fileSystem: null,
    systemRoot: "C:\\Windows",
    probeProcess: () => "dead",
    runCommand: async () => ({ code: 0, stdout: "missing" }),
  });
  assert.deepEqual(dead, { state: "dead" });
});

test("macOS and Windows require a separate ESRCH proof before reporting dead", async () => {
  const macFailure = await getLocalProcessIdentity(17, {
    platform: "darwin",
    fileSystem: null,
    probeProcess: () => "present",
    runCommand: async () => ({ code: 1, stdout: "" }),
  });
  assert.deepEqual(macFailure, { state: "ambiguous" });

  const windowsFailure = await getLocalProcessIdentity(17, {
    platform: "win32",
    fileSystem: null,
    probeProcess: () => "present",
    systemRoot: "C:\\Windows",
    runCommand: async () => ({ code: 0, stdout: "missing" }),
  });
  assert.deepEqual(windowsFailure, { state: "ambiguous" });

  const macDead = await getLocalProcessIdentity(17, {
    platform: "darwin",
    fileSystem: null,
    probeProcess: () => "dead",
    runCommand: async () => ({ code: 1, stdout: "" }),
  });
  assert.deepEqual(macDead, { state: "dead" });
});

test("process identity fails closed for invalid adapters, paths, output, and PIDs", async () => {
  await assert.rejects(() => getLocalProcessIdentity(0), /process ID is invalid/u);
  await assert.rejects(
    () => getLocalProcessIdentity(1, { platform: "linux", fileSystem: null }),
    /adapter is invalid/u,
  );

  let invoked = false;
  const unsafeWindowsRoot = await getLocalProcessIdentity(1, {
    platform: "win32",
    fileSystem: null,
    systemRoot: "C:\\Windows\\Temp",
    runCommand: async () => { invoked = true; },
  });
  assert.deepEqual(unsafeWindowsRoot, { state: "ambiguous" });
  assert.equal(invoked, false);

  const oversized = await getLocalProcessIdentity(1, {
    platform: "win32",
    fileSystem: null,
    systemRoot: "C:\\Windows",
    runCommand: async () => ({ code: 0, stdout: `active:${"1".repeat(21)}` }),
  });
  assert.deepEqual(oversized, { state: "ambiguous" });
  assert.deepEqual(
    await getLocalProcessIdentity(1, {
      platform: "unknown",
      fileSystem: null,
      runCommand: async () => ({ code: 0, stdout: "active:1" }),
    }),
    { state: "ambiguous" },
  );
});

test("the default identity subprocess runner bounds timeout, output, and stream failures", async (t) => {
  await t.test("timeout", async () => {
    const child = createIdentityChild();
    await assert.rejects(
      runIdentityCommand("identity-probe", [], {
        spawnProcess: () => child,
        timeoutMs: 5,
      }),
      /could not be inspected/u,
    );
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });

  await t.test("output overflow", async () => {
    let child;
    await assert.rejects(
      runIdentityCommand("identity-probe", [], {
        spawnProcess() {
          child = createIdentityChild((started) => started.stdout.write(Buffer.alloc(9)));
          return child;
        },
        maxOutputBytes: 8,
        timeoutMs: 1_000,
      }),
      /could not be inspected/u,
    );
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });

  await t.test("stdin and child errors settle once", async () => {
    const stdinChild = createIdentityChild((started) => {
      started.stdin.emit("error", new Error("private stdin detail"));
    });
    await assert.rejects(
      runIdentityCommand("identity-probe", [], {
        spawnProcess: () => stdinChild,
        timeoutMs: 1_000,
      }),
      /could not be inspected/u,
    );
    assert.deepEqual(stdinChild.killCalls, ["SIGKILL"]);

    const childError = createIdentityChild((started) => {
      started.emit("error", new Error("private child detail"));
      started.emit("close", 1);
    });
    await assert.rejects(
      runIdentityCommand("identity-probe", [], {
        spawnProcess: () => childError,
        timeoutMs: 1_000,
      }),
      /could not be inspected/u,
    );
  });
});
