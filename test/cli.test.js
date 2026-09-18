import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  cliMode,
  hasInteractiveTerminal,
  isCliEntryPath,
  runCli,
} from "../src/cli.js";

const execFileAsync = promisify(execFile);
const privateLaunchUrl =
  "file:///private/tmp/relmio-browser-Ab3dE9/launch-0123456789abcdef01234567.html";

test("CLI recognizes version and explicit wizard routes", () => {
  assert.equal(cliMode(["--version"]), "version");
  assert.equal(cliMode(["-v"]), "version");
  assert.equal(cliMode(["--help"]), "help");
  assert.equal(cliMode(["-h"]), "help");
  assert.equal(cliMode([]), "wizard");
  assert.equal(
    cliMode([], { commandName: "n8n-openai-oauth-setup" }),
    "wizard",
  );
  assert.equal(cliMode([], { commandName: "planrelay" }), "wizard");
  assert.equal(cliMode(["local"]), "local");
  assert.equal(cliMode(["vps"]), "wizard");
  assert.equal(cliMode(["assistant"]), "assistant");
  assert.equal(cliMode(["start"]), "start");
  assert.equal(cliMode(["status"]), "status");
  assert.equal(cliMode(["open"]), "open");
  assert.equal(cliMode(["gui"]), "open");
  assert.equal(cliMode(["stop"]), "stop");
  assert.equal(cliMode(["grok", "login"]), "grok-login");
  assert.equal(cliMode(["grok", "logout"]), "grok-logout");
  assert.equal(cliMode(["__relmio-dashboard-daemon"]), "daemon");
  assert.throws(() => cliMode(["grok"]), /Unknown Relmio command/u);
  assert.throws(() => cliMode(["grok", "login", "extra"]), /Unknown Relmio command/u);
  assert.throws(() => cliMode(["local", "extra"]), /Unknown Relmio command/u);
  assert.throws(() => cliMode(["--version", "extra"]), /Unknown Relmio command/u);
  assert.throws(() => cliMode(["unknown"]), /Unknown Relmio command/u);
});

test("interactive terminal detection requires both standard streams", () => {
  assert.equal(
    hasInteractiveTerminal({
      input: { isTTY: true },
      output: { isTTY: true },
    }),
    true,
  );
  assert.equal(
    hasInteractiveTerminal({
      input: { isTTY: true },
      output: { isTTY: false },
    }),
    false,
  );
});

test("version mode prints package metadata without starting the wizard", async () => {
  const output = [];
  await runCli({
    argumentsList: ["--version"],
    log: (line) => output.push(line),
    readPackage: async () => '{"version":"1.2.3"}',
  });
  assert.deepEqual(output, ["1.2.3"]);
});

test("help mode prints the supported routes without starting the wizard", async () => {
  const output = [];
  let serverStarted = false;
  await runCli({
    argumentsList: ["--help"],
    log: (line) => output.push(line),
    startServer: async () => {
      serverStarted = true;
    },
  });
  assert.equal(serverStarted, false);
  assert.deepEqual(output, [
    "Usage: relmio [local|vps|assistant|start|status|open|stop|grok login|grok logout|--version]",
    "  (no command) Open the ChatGPT-on-VPS setup wizard without persistent local state",
    "  local      Open the persistent local services dashboard",
    "  vps        Open the separate VPS setup wizard",
    "  assistant  Open the dedicated AI Assistant companion wizard",
    "  start      Start the local dashboard without opening a browser",
    "  status     Report whether the exact local dashboard is running",
    "  open       Start when needed and open the local dashboard",
    "  stop       Stop only the Relmio dashboard process",
    "  grok login  Start the official SuperGrok device sign-in",
    "  grok logout Sign out of the managed local SuperGrok endpoint",
    "  Add --n8n to grok login/logout for the private n8n SuperGrok companion",
  ]);
  assert.doesNotMatch(output.join("\n"), /__relmio-dashboard-daemon/u);
});

test("Grok CLI commands resolve the canonical local installation and dispatch only the credential action", async (t) => {
  for (const scenario of [
    { argumentsList: ["grok", "login"], action: "device-auth", isTTY: true, message: "Grok Build sign-in completed." },
    { argumentsList: ["grok", "logout"], action: "logout", isTTY: false, message: "Grok Build sign-out completed." },
  ]) {
    await t.test(scenario.argumentsList.join(" "), async () => {
      const output = [];
      const environment = { RELMIO_HOME: "/private/relmio/.relmio" };
      let resolved = 0;
      let dispatched = 0;
      const forbidden = () => { throw new Error("Grok command started a dashboard or browser"); };
      const exitCode = await runCli({
        argumentsList: scenario.argumentsList,
        env: environment,
        isInteractive: () => scenario.isTTY,
        log: line => output.push(line),
        resolveInstallRoot: async options => {
          resolved += 1;
          assert.deepEqual(options, { target: "xai-grok-build", env: environment });
          return "/private/relmio/.relmio/local/xai-grok-build";
        },
        runGrokLogin: async options => {
          dispatched += 1;
          assert.deepEqual(options, {
            action: scenario.action,
            installDirectory: "/private/relmio/.relmio/local/xai-grok-build",
            isTTY: scenario.isTTY,
            environment,
          });
          return { action: scenario.action, success: true };
        },
        startServer: forbidden,
        startControlPlane: forbidden,
        open: forbidden,
      });
      assert.equal(exitCode, 0);
      assert.equal(resolved, 1);
      assert.equal(dispatched, 1);
      assert.deepEqual(output, [scenario.message]);
    });
  }
});

test("Grok login refuses a non-interactive terminal before resolving files or starting credential work", async () => {
  const output = [];
  let effects = 0;
  const exitCode = await runCli({
    argumentsList: ["grok", "login"],
    isInteractive: () => false,
    log: line => output.push(line),
    resolveInstallRoot: async () => { effects += 1; },
    runGrokLogin: async () => { effects += 1; },
  });
  assert.equal(exitCode, 1);
  assert.equal(effects, 0);
  assert.deepEqual(output, ["Grok Build sign-in requires an interactive terminal."]);
});

test("Grok command failures do not print completion", async () => {
  const output = [];
  await assert.rejects(runCli({
    argumentsList: ["grok", "logout"],
    isInteractive: () => false,
    log: line => output.push(line),
    resolveInstallRoot: async () => "/private/relmio/.relmio/local/xai-grok-build",
    runGrokLogin: async () => { throw new Error("credential action failed"); },
  }), /credential action failed/u);
  assert.deepEqual(output, []);

  await assert.rejects(runCli({
    argumentsList: ["grok", "logout"],
    isInteractive: () => false,
    log: line => output.push(line),
    resolveInstallRoot: async () => "/private/relmio/.relmio/local/xai-grok-build",
    runGrokLogin: async () => ({ action: "logout", success: false }),
  }), /credential action was not completed/u);
  assert.deepEqual(output, []);
});

test("non-interactive default launch exits without starting the wizard", async () => {
  const output = [];
  const exitCode = await runCli({
    log: (line) => output.push(line),
    isInteractive: () => false,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(output, [
    "Relmio needs an interactive terminal to open the setup wizard. Run relmio from Command Prompt, PowerShell, or another terminal.",
  ]);
});

test("non-interactive hosted and explicit browser launches fail instead of reporting success", async (t) => {
  for (const scenario of [
    { name: "hosted default", argumentsList: [], env: { RELMIO_FOREGROUND_WIZARD: "1" } },
    { name: "local", argumentsList: ["local"], env: {} },
    { name: "vps", argumentsList: ["vps"], env: {} },
    { name: "assistant", argumentsList: ["assistant"], env: {} },
    { name: "open", argumentsList: ["open"], env: {} },
  ]) {
    await t.test(scenario.name, async () => {
      const output = [];
      const exitCode = await runCli({
        argumentsList: scenario.argumentsList,
        env: scenario.env,
        log: (line) => output.push(line),
        isInteractive: () => false,
      });
      assert.equal(exitCode, 1);
      assert.match(output.join("\n"), /needs an interactive terminal/iu);
    });
  }
});

test("foreground Assistant opens only a private handoff and wires fresh reopen preparation", async () => {
  const opened = [];
  const preparedRoutes = [];
  const reopenFactories = [];
  await runCli({
    argumentsList: ["assistant"],
    env: { RELMIO_FOREGROUND_WIZARD: "1" },
    isInteractive: () => true,
    log: () => {},
    createBrowserLaunchRoot: async () => ({
      path: "/private/relmio/browser-launches",
      async dispose() {},
    }),
    startServer: async (options) => {
      assert.equal(options.browserHandoffRoot, "/private/relmio/browser-launches");
      return {
        origin: "http://127.0.0.1:4567",
        async prepareBrowserLaunch(route) {
          preparedRoutes.push(route);
          return privateLaunchUrl;
        },
        async close() {},
      };
    },
    open: (url) => opened.push(url),
    attachReopen: ({ prepareLaunch }) => {
      reopenFactories.push(prepareLaunch);
      return () => {};
    },
  });

  assert.deepEqual(opened, [privateLaunchUrl]);
  assert.deepEqual(preparedRoutes, ["/assistant"]);
  assert.equal(reopenFactories.length, 1);
  await reopenFactories[0]();
  assert.deepEqual(preparedRoutes, ["/assistant", "/assistant"]);
});

test("bare default launch opens the ChatGPT VPS wizard without persistent local state", async () => {
  const opened = [];
  const output = [];
  const preparedRoutes = [];
  await runCli({
    argumentsList: [],
    env: {},
    isInteractive: () => true,
    log: (line) => output.push(line),
    startControlPlane: async () => {
      throw new Error("bare default launch must not initialize persistent local state");
    },
    createBrowserLaunchRoot: async () => ({
      path: "/private/relmio/browser-launches",
      async dispose() {},
    }),
    startServer: async () => ({
      origin: "http://127.0.0.1:4567",
      async prepareBrowserLaunch(route) {
        preparedRoutes.push(route);
        return privateLaunchUrl;
      },
      async close() {},
    }),
    open: (url) => opened.push(url),
    attachReopen: () => () => {},
  });

  assert.deepEqual(opened, [privateLaunchUrl]);
  assert.deepEqual(preparedRoutes, ["/"]);
  assert.doesNotMatch(output.join("\n"), /session=|[A-Za-z0-9_-]{43}/u);
  assert.ok(output.includes("VPS wizard: private browser handoff ready"));
  assert.ok(output.includes("This creates a separate sidecar and never restarts n8n."));
  assert.doesNotMatch(output.join("\n"), /Local wizard|dashboard reads local service status/u);
});

test("explicit VPS CLI mode preserves the original remote setup URL", async () => {
  const opened = [];
  const preparedRoutes = [];
  await runCli({
    argumentsList: ["vps"],
    env: { RELMIO_FOREGROUND_WIZARD: "1" },
    isInteractive: () => true,
    log: () => {},
    createBrowserLaunchRoot: async () => ({
      path: "/private/relmio/browser-launches",
      async dispose() {},
    }),
    startServer: async () => ({
      origin: "http://127.0.0.1:4567",
      async prepareBrowserLaunch(route) {
        preparedRoutes.push(route);
        return privateLaunchUrl;
      },
      async close() {},
    }),
    open: (url) => opened.push(url),
    attachReopen: () => () => {},
  });

  assert.deepEqual(opened, [privateLaunchUrl]);
  assert.deepEqual(preparedRoutes, ["/"]);
});

test("foreground startup releases its temporary browser root when the server cannot start", async () => {
  let disposed = 0;
  await assert.rejects(
    runCli({
      argumentsList: [],
      env: { RELMIO_FOREGROUND_WIZARD: "1" },
      isInteractive: () => true,
      log: () => {},
      createBrowserLaunchRoot: async () => ({
        path: "/private/relmio/browser-launches",
        async dispose() {
          disposed += 1;
        },
      }),
      startServer: async () => {
        throw new Error("port unavailable");
      },
    }),
    /port unavailable/u,
  );
  assert.equal(disposed, 1);
});

test("foreground startup fails actionably and cleans up when Windows cannot open the browser", async () => {
  let serverClosed = 0;
  let rootDisposed = 0;
  await assert.rejects(
    runCli({
      argumentsList: [],
      env: { RELMIO_FOREGROUND_WIZARD: "1" },
      isInteractive: () => true,
      log: () => {},
      createBrowserLaunchRoot: async () => ({
        path: "/private/relmio/browser-launches",
        async dispose() {
          rootDisposed += 1;
        },
      }),
      startServer: async () => ({
        async prepareBrowserLaunch() {
          return privateLaunchUrl;
        },
        async close() {
          serverClosed += 1;
        },
      }),
      open: () => false,
      attachReopen: () => {
        throw new Error("reopen handling must not attach after browser failure");
      },
    }),
    /check the Windows default browser/iu,
  );
  assert.equal(serverClosed, 1);
  assert.equal(rootDisposed, 1);
});

test("legacy executable aliases keep their historical default VPS route", async (t) => {
  for (const commandName of ["n8n-openai-oauth-setup", "planrelay"]) {
    await t.test(commandName, async () => {
      const opened = [];
      const preparedRoutes = [];
      await runCli({
        argumentsList: [],
        commandName,
        isInteractive: () => true,
        log: () => {},
        startControlPlane: async () => {
          throw new Error("legacy aliases must not initialize persistent local state");
        },
        createBrowserLaunchRoot: async () => ({
          path: "/private/relmio/browser-launches",
          async dispose() {},
        }),
        startServer: async () => ({
          async prepareBrowserLaunch(route) {
            preparedRoutes.push(route);
            return privateLaunchUrl;
          },
          async close() {},
        }),
        open: (url) => {
          opened.push(url);
          return true;
        },
        attachReopen: () => () => {},
      });
      assert.deepEqual(opened, [privateLaunchUrl]);
      assert.deepEqual(preparedRoutes, ["/"]);
    });
  }
});

test("persistent dashboard routes reuse one daemon and open only a route-bound handoff", async (t) => {
  for (const scenario of [
    { name: "local", argumentsList: ["local"], pathname: "/local" },
    { name: "open", argumentsList: ["open"], pathname: "/local" },
    { name: "gui", argumentsList: ["gui"], pathname: "/local" },
    { name: "vps", argumentsList: ["vps"], pathname: "/" },
    { name: "assistant", argumentsList: ["assistant"], pathname: "/assistant" },
  ]) {
    await t.test(scenario.name, async () => {
      const output = [];
      const opened = [];
      let starts = 0;
      let reads = 0;
      const env = { RELMIO_FOREGROUND_WIZARD: "true" };
      const exitCode = await runCli({
        argumentsList: scenario.argumentsList,
        env,
        isInteractive: () => true,
        log: (line) => output.push(line),
        startControlPlane: async (options) => {
          starts += 1;
          assert.equal(options.env, env);
          return { state: "existing" };
        },
        readBrowserUrl: async (options) => {
          reads += 1;
          assert.equal(options.env, env);
          assert.equal(options.route, scenario.pathname);
          return privateLaunchUrl;
        },
        open: (url) => {
          opened.push(url);
          return true;
        },
        startServer: async () => {
          throw new Error("persistent launch must not start a foreground server");
        },
        attachReopen: () => {
          throw new Error("persistent launch must not attach terminal reopen handling");
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(starts, 1);
      assert.equal(reads, 1);
      assert.deepEqual(opened, [privateLaunchUrl]);
      assert.doesNotMatch(output.join("\n"), /session=/u);
    });
  }
});

test("persistent open failure reports a secret-free retry command", async () => {
  const output = [];
  const exitCode = await runCli({
    argumentsList: ["open"],
    isInteractive: () => true,
    log: (line) => output.push(line),
    startControlPlane: async () => ({ state: "started" }),
    readBrowserUrl: async () => privateLaunchUrl,
    open: () => false,
  });

  assert.equal(exitCode, 1);
  assert.match(output.join("\n"), /run relmio open again/iu);
  assert.doesNotMatch(output.join("\n"), /session=/u);
});

test("start, status, and stop are non-interactive and never open a browser", async () => {
  const forbidden = () => {
    throw new Error("lifecycle command crossed into browser or foreground mode");
  };

  const startOutput = [];
  assert.equal(await runCli({
    argumentsList: ["start"],
    isInteractive: () => false,
    log: (line) => startOutput.push(line),
    startControlPlane: async () => ({ state: "started" }),
    open: forbidden,
    startServer: forbidden,
  }), 0);
  assert.deepEqual(startOutput, ["Relmio dashboard started."]);

  const statusOutput = [];
  assert.equal(await runCli({
    argumentsList: ["status"],
    isInteractive: () => false,
    log: (line) => statusOutput.push(line),
    inspectControlPlane: async () => ({ state: "healthy" }),
    open: forbidden,
    startServer: forbidden,
  }), 0);
  assert.deepEqual(statusOutput, ["Relmio dashboard is running."]);

  const stopOutput = [];
  assert.equal(await runCli({
    argumentsList: ["stop"],
    isInteractive: () => false,
    log: (line) => stopOutput.push(line),
    stopControlPlane: async () => ({ state: "stopped" }),
    open: forbidden,
    startServer: forbidden,
  }), 0);
  assert.deepEqual(stopOutput, ["Relmio dashboard stopped."]);
});

test("status is nonzero for every non-healthy secret-free state", async (t) => {
  for (const state of ["absent", "dead", "pid-reused", "ambiguous", "unresponsive"]) {
    await t.test(state, async () => {
      const output = [];
      const exitCode = await runCli({
        argumentsList: ["status"],
        isInteractive: () => false,
        log: (line) => output.push(line),
        inspectControlPlane: async () => ({
          state,
          pid: 123,
          origin: "http://127.0.0.1:4567",
        }),
      });
      assert.equal(exitCode, 1);
      assert.equal(output.join("\n").includes("session="), false);
      assert.match(output.join("\n"), /not running|not healthy/iu);
    });
  }
});

test("status reports a version mismatch with an explicit secret-free restart sequence", async () => {
  const output = [];
  const secret = `w${"q".repeat(42)}`;
  const exitCode = await runCli({
    argumentsList: ["status"],
    isInteractive: () => false,
    log: (line) => output.push(line),
    inspectControlPlane: async () => ({
      state: "version-mismatch",
      packageVersion: "0.12.2",
      origin: `http://127.0.0.1:4567/local?session=${secret}`,
    }),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(output, [
    "A dashboard from another Relmio version is running. Run relmio stop, then relmio start.",
  ]);
  assert.equal(output.join("\n").includes(secret), false);
  assert.equal(output.join("\n").includes("127.0.0.1"), false);
});

test("start reports reuse and stop is idempotent when the dashboard is absent", async () => {
  const startOutput = [];
  assert.equal(await runCli({
    argumentsList: ["start"],
    log: (line) => startOutput.push(line),
    startControlPlane: async () => ({ state: "existing" }),
  }), 0);
  assert.deepEqual(startOutput, ["Relmio dashboard is already running."]);

  const stopOutput = [];
  assert.equal(await runCli({
    argumentsList: ["stop"],
    log: (line) => stopOutput.push(line),
    stopControlPlane: async () => ({ state: "absent" }),
  }), 0);
  assert.deepEqual(stopOutput, ["Relmio dashboard is not running."]);
});

test("hidden daemon mode waits for completion without logging or opening", async () => {
  let runOptions;
  let opened = false;
  const output = [];
  const env = { RELMIO_HOME: "/tmp/example/.relmio" };
  const exitCode = await runCli({
    argumentsList: ["__relmio-dashboard-daemon"],
    env,
    log: (line) => output.push(line),
    open: () => {
      opened = true;
      return true;
    },
    runDaemon: async (options) => {
      runOptions = options;
      return { completion: Promise.resolve() };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(runOptions.env, env);
  assert.equal(typeof runOptions.startServer, "function");
  assert.deepEqual(output, []);
  assert.equal(opened, false);
});

test("CLI entry detection resolves package-manager symlinks", () => {
  const sourcePath = resolve("src/cli.js");
  const aliases = new Map([
    ["/package-manager/bin/relmio", sourcePath],
    [sourcePath, sourcePath],
  ]);
  assert.equal(isCliEntryPath("/package-manager/bin/relmio", (path) => aliases.get(path)), true);
  assert.equal(isCliEntryPath("/other/command", (path) => aliases.get(path) ?? path), false);
});

test("legacy package aliases use a dedicated VPS compatibility entry", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.bin.relmio, "src/cli.js");
  assert.equal(packageJson.bin.planrelay, "src/legacy-vps-cli.js");
  assert.equal(
    packageJson.bin["n8n-openai-oauth-setup"],
    "src/legacy-vps-cli.js",
  );

  const wrapper = await readFile("src/legacy-vps-cli.js", "utf8");
  assert.match(wrapper, /^#!\/usr\/bin\/env node/mu);
  assert.match(wrapper, /runCliEntrypoint/u);
  assert.match(wrapper, /commandName: "planrelay"/u);

  const { stderr, stdout } = await execFileAsync(
    process.execPath,
    ["src/legacy-vps-cli.js", "--help"],
    { cwd: process.cwd() },
  );
  assert.equal(stderr, "");
  assert.match(stdout, /Usage: relmio/u);
});

test("the installed CLI version command exits with the repository version", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const { stderr, stdout } = await execFileAsync(
    process.execPath,
    ["src/cli.js", "--version"],
    { cwd: process.cwd() },
  );

  assert.equal(stderr, "");
  assert.equal(stdout.trim(), packageJson.version);
});

test(
  "a symlinked installed CLI runs the version command",
  { skip: process.platform === "win32" },
  async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const directory = await mkdtemp(join(tmpdir(), "relmio-cli-"));
    const commandPath = join(directory, "relmio");
    try {
      await symlink(resolve("src/cli.js"), commandPath, "file");
      const { stderr, stdout } = await execFileAsync(commandPath, ["--version"]);
      assert.equal(stderr, "");
      assert.equal(stdout.trim(), packageJson.version);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test("grok --n8n selects only the private companion with exact argument handling", async () => {
  for (const verb of ["login", "logout"]) {
    const calls = [];
    assert.equal(cliMode(["grok", verb, "--n8n"]), `grok-${verb}`);
    const env = { RELMIO_HOME: "/private/fixture/.relmio" };
    assert.equal(await runCli({
      argumentsList: ["grok", verb, "--n8n"], env, isInteractive: () => true, log: () => {},
      resolveInstallRoot: () => { throw new Error("Local endpoint must not be selected"); },
      resolveN8nSuperGrokInstallRoot: async (options) => { assert.equal(options.env, env); return "/private/fixture/.relmio/local/n8n-supergrok-oauth"; },
      runGrokLogin: async (options) => { calls.push(options); return { action: options.action, success: true }; },
    }), 0);
    assert.equal(calls[0].target, "n8n-supergrok-oauth");
    assert.equal(calls[0].action, verb === "login" ? "device-auth" : "logout");
  }
  for (const args of [["grok", "login", "--n8n", "extra"], ["grok", "login", "--host"], ["grok", "--n8n", "login"]]) {
    assert.throws(() => cliMode(args), /Unknown/u);
  }
  assert.equal(await runCli({
    argumentsList: ["grok", "login", "--n8n"], isInteractive: () => false, log: () => {},
    resolveN8nSuperGrokInstallRoot: () => { throw new Error("Must refuse before filesystem access"); },
  }), 1);
});
