import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const installScript = resolve("web/public/install.cmd");

test("CMD installer keeps a native checksum-verified portable Windows runtime path", async () => {
  const script = await readFile(installScript, "utf8");

  assert.doesNotMatch(script, /powershell|pwsh/iu);
  assert.doesNotMatch(script, /runas|executionpolicy|uac/iu);
  assert.doesNotMatch(script, /RELMIO_TEST_SYSTEM32/u);
  assert.match(script, /set "RELMIO_SYSTEM32=%SystemRoot%\\System32"/u);
  assert.match(script, /set "RELMIO_CURL=%RELMIO_SYSTEM32%\\curl\.exe"/u);
  assert.match(script, /set "RELMIO_CERTUTIL=%RELMIO_SYSTEM32%\\certutil\.exe"/u);
  assert.match(script, /set "RELMIO_TAR=%RELMIO_SYSTEM32%\\tar\.exe"/u);
  assert.match(script, /RELMIO_NODE_VERSION=v22\.23\.2/u);
  assert.match(script, /1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97/u);
  assert.match(script, /fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3/u);
  assert.doesNotMatch(script, /SHASUMS256|MANIFEST_MATCH/u);
  assert.match(script, /:checksum/u);
  assert.match(script, /Node\.js download checksum did not match; nothing was executed/u);
  assert.match(script, /rmdir \/s \/q "%RELMIO_TEMPORARY_DIRECTORY%"/u);
  assert.match(script, /--yes --ignore-scripts relmio@latest/u);
  assert.match(script, /Installing a temporary Node\.js 22 runtime\. Please wait/u);
  assert.match(script, /Extracting the verified temporary Node\.js 22 runtime\. Please wait/u);
});

function writeNativeToolWrapper() {
  return `using System;
using System.IO;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

public static class Program {
  private static void Log(string variable, string value) {
    var path = Environment.GetEnvironmentVariable(variable);
    if (!String.IsNullOrEmpty(path)) File.AppendAllText(path, value + Environment.NewLine);
  }

  private static void CopyDirectory(string source, string destination) {
    Directory.CreateDirectory(destination);
    foreach (var file in Directory.GetFiles(source)) {
      File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
    }
    foreach (var directory in Directory.GetDirectories(source)) {
      CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }
  }

  private static int FindStr(string[] args) {
    var patternArgument = args.FirstOrDefault(value => value.StartsWith("/c:", StringComparison.OrdinalIgnoreCase));
    var pattern = patternArgument == null ? "" : patternArgument.Substring(3);
    var values = args.Where(value => !value.StartsWith("/")).ToArray();
    var input = values.Length > 0 ? File.ReadAllText(values[values.Length - 1]) : Console.In.ReadToEnd();
    var lines = input.Split((char)10).Select(line => line.TrimEnd((char)13)).Where(line => line.Length > 0);
    if (pattern.Contains("node-v22")) {
      var architecture = pattern.Contains("arm64") ? "arm64" : "x64";
      lines = lines.Where(line => line.Length > 64 && line.Substring(0, 64).All(Uri.IsHexDigit) && line.Contains("  node-v22.") && line.EndsWith("-win-" + architecture + ".zip"));
    } else if (pattern.StartsWith("v")) {
      lines = lines.Where(line => line.StartsWith("v") && line.Substring(1).Split('.').Length == 3 && line.Substring(1).Split('.').All(part => part.Length > 0 && part.All(Char.IsDigit)));
    } else {
      lines = lines.Where(line => line.Length == 64 && line.All(Uri.IsHexDigit));
    }
    var matches = lines.ToArray();
    foreach (var match in matches) Console.WriteLine(match);
    return matches.Length == 0 ? 1 : 0;
  }

  public static int Main(string[] args) {
    var tool = Path.GetFileName(Process.GetCurrentProcess().MainModule.FileName).ToLowerInvariant();
    if ((tool == "node.exe" || tool == "installed-node.exe") && args.Length == 1 && args[0] == "--version") {
      Console.WriteLine(Environment.GetEnvironmentVariable("RELMIO_TEST_NODE_VERSION"));
      return 0;
    }
    if (tool == "where.exe") {
      Log("RELMIO_TEST_TOOL_LOG", "where " + String.Join(" ", args));
      if (args.Length == 1 && args[0] == "node.exe") Console.WriteLine(Environment.GetEnvironmentVariable("RELMIO_TEST_PORTABLE_OLD_NODE"));
      if (args.Length == 1 && args[0] == "npx.cmd") Console.WriteLine(Environment.GetEnvironmentVariable("RELMIO_TEST_PORTABLE_NPX"));
      return 0;
    }
    if (tool == "findstr.exe") return FindStr(args);
    if (tool == "curl.exe") {
      Log("RELMIO_TEST_NETWORK_TOOL_LOG", "curl");
      var outputIndex = Array.IndexOf(args, "-o");
      if (outputIndex < 1 || outputIndex + 1 >= args.Length) return 91;
      var url = args[outputIndex - 1];
      var source = url == "https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt"
        ? Environment.GetEnvironmentVariable("RELMIO_TEST_MANIFEST")
        : url == Environment.GetEnvironmentVariable("RELMIO_TEST_ARCHIVE_URL")
          ? Environment.GetEnvironmentVariable("RELMIO_TEST_ARCHIVE")
          : null;
      if (String.IsNullOrEmpty(source)) return 92;
      File.Copy(source, args[outputIndex + 1], true);
      return 0;
    }
    if (tool == "certutil.exe") {
      Log("RELMIO_TEST_NETWORK_TOOL_LOG", "certutil");
      if (args.Length != 3 || args[0] != "-hashfile" || args[2] != "SHA256") return 93;
      using (var hash = SHA256.Create()) {
        var digest = BitConverter.ToString(hash.ComputeHash(File.ReadAllBytes(args[1]))).Replace("-", "");
        Console.WriteLine("SHA256 hash of file:");
        Console.WriteLine(digest);
        Console.WriteLine("CertUtil: -hashfile command completed successfully.");
      }
      return 0;
    }
    if (tool == "tar.exe") {
      Log("RELMIO_TEST_NETWORK_TOOL_LOG", "tar " + String.Join(" ", args));
      var destinationIndex = Array.IndexOf(args, "-C");
      if (args.Length < 4 || args[0] != "-xf" || destinationIndex < 0 || destinationIndex + 1 >= args.Length) return 94;
      CopyDirectory(Environment.GetEnvironmentVariable("RELMIO_TEST_RUNTIME_DIRECTORY"), args[destinationIndex + 1]);
      return 0;
    }
    return 90;
  }
}
`;
}

async function buildNativeToolWrapper(root) {
  const compiler = join(
    process.env.SystemRoot,
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  await access(compiler);
  const source = join(root, "node-version-wrapper.cs");
  const executable = join(root, "node-version-wrapper.exe");
  await writeFile(source, writeNativeToolWrapper(), "utf8");
  await execFileAsync(compiler, ["/nologo", `/out:${executable}`, source]);
  return executable;
}

async function createInstalledNodeEnvironment({ npxExitCode = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "relmio-install-cmd-test-"));
  const fakeBin = join(root, "bin");
  const temporaryDirectory = join(root, "tmp");
  const log = join(root, "invocation.log");
  const wrapper = await buildNativeToolWrapper(root);

  await mkdir(fakeBin);
  await mkdir(temporaryDirectory);
  await copyFile(wrapper, join(fakeBin, "node.exe"));
  await writeFile(
    join(fakeBin, "npx.cmd"),
    [
      "@echo off",
      '> "%RELMIO_TEST_LOG%" echo %~1',
      '>> "%RELMIO_TEST_LOG%" echo %~2',
      '>> "%RELMIO_TEST_LOG%" echo %~3',
      `exit /b ${npxExitCode}`,
      "",
    ].join("\r\n"),
    "utf8",
  );

  return {
    fakeBin,
    log,
    root,
    temporaryDirectory,
    env: {
      ...process.env,
      PATH: `${fakeBin};${process.env.PATH}`,
      RELMIO_TEST_LOG: log,
      RELMIO_TEST_NODE_VERSION: "v22.16.0",
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
    },
  };
}

async function createPortableRuntime(
  root,
  { hostileManifest = false, validChecksum = true } = {},
) {
  const version = "v22.23.2";
  const archiveName = `node-${version}-win-x64.zip`;
  const runtimeParent = join(root, "portable-runtime");
  const runtimeDirectory = join(runtimeParent, archiveName.slice(0, -4));
  const npmDirectory = join(runtimeDirectory, "node_modules", "npm", "bin");
  const archive = join(root, archiveName);
  const manifest = join(root, "SHASUMS256.txt");
  const hostileMarker = join(root, "manifest-command-executed.txt");
  const log = join(root, "portable-invocation.log");

  await mkdir(npmDirectory, { recursive: true });
  await copyFile(process.execPath, join(runtimeDirectory, "node.exe"));
  await writeFile(
    join(npmDirectory, "npx-cli.js"),
    `const { appendFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const log = process.env.RELMIO_TEST_LOG;
writeFileSync(log, [process.argv[1], ...process.argv.slice(2)].join("\\n") + "\\n");
const child = spawnSync("node", ["--version"], { encoding: "utf8" });
if (child.status !== 0) process.exit(child.status || 1);
appendFileSync(log, "child-node-ok\\n");
`,
    "utf8",
  );
  await writeFile(archive, "portable Windows Node fixture\n", "utf8");
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(
    manifest,
    [
      hostileManifest
        ? `abc&echo(compromised>${hostileMarker}  ${archiveName}`
        : null,
      `${validChecksum ? digest : "0".repeat(64)}  ${archiveName}`,
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
    "utf8",
  );

  return {
    archive,
    archiveUrl: `https://nodejs.org/download/release/${version}/${archiveName}`,
    hostileMarker,
    expectedChecksum: validChecksum ? digest : "0".repeat(64),
    log,
    manifest,
    runtimeParent,
  };
}

async function createPortableEnvironment(
  { hostileManifest = false, validChecksum = true } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "relmio-install-cmd-portable-test-"));
  const system32 = join(root, "System32");
  const temporaryDirectory = join(root, "tmp");
  const networkToolLog = join(root, "network-tools.log");
  const fixture = await createPortableRuntime(root, {
    hostileManifest,
    validChecksum,
  });
  const wrapper = await buildNativeToolWrapper(root);
  const oldNode = join(root, "installed-node.exe");

  await mkdir(system32);
  await mkdir(temporaryDirectory);
  await Promise.all(
    ["curl.exe", "certutil.exe", "tar.exe", "where.exe"].map(
      (tool) => copyFile(wrapper, join(system32, tool)),
    ),
  );
  await copyFile(wrapper, oldNode);
  const fixtureInstallScript = join(root, "install.cmd");
  const productionInstallScript = await readFile(installScript, "utf8");
  const system32Assignment = 'set "RELMIO_SYSTEM32=%SystemRoot%\\System32"';
  const findstrAssignment =
    'set "RELMIO_FINDSTR=%RELMIO_SYSTEM32%\\findstr.exe"';
  const expectedChecksumAssignment =
    'set "RELMIO_EXPECTED_CHECKSUM=1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"';
  assert.ok(productionInstallScript.includes(system32Assignment));
  await writeFile(
    fixtureInstallScript,
    productionInstallScript
      .replace(/\r?\n/gu, "\r\n")
      .replace(system32Assignment, `set "RELMIO_SYSTEM32=${system32}"`)
      .replace(
        findstrAssignment,
        `set "RELMIO_FINDSTR=${join(process.env.SystemRoot, "System32", "findstr.exe")}"`,
      )
      .replace(
        expectedChecksumAssignment,
        `set "RELMIO_EXPECTED_CHECKSUM=${fixture.expectedChecksum}"`,
      ),
    "utf8",
  );
  assert.match(
    await readFile(fixtureInstallScript, "utf8"),
    /RELMIO_FINDSTR=C:\\Windows\\System32\\findstr\.exe/iu,
  );

  return {
    fixture,
    fixtureInstallScript,
    networkToolLog,
    root,
    temporaryDirectory,
    env: {
      ...process.env,
      RELMIO_TEST_ARCHIVE: fixture.archive,
      RELMIO_TEST_ARCHIVE_URL: fixture.archiveUrl,
      RELMIO_TEST_LOG: fixture.log,
      RELMIO_TEST_MANIFEST: fixture.manifest,
      RELMIO_TEST_NETWORK_TOOL_LOG: networkToolLog,
      RELMIO_TEST_NODE_VERSION: "v18.20.0",
      RELMIO_TEST_PORTABLE_OLD_NODE: oldNode,
      RELMIO_TEST_PORTABLE_NPX: "",
      RELMIO_TEST_RUNTIME_DIRECTORY: fixture.runtimeParent,
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
    },
  };
}

async function runCmdInstaller(env, script = installScript) {
  const commandProcessor = process.env.ComSpec || join(process.env.SystemRoot, "System32", "cmd.exe");
  return execFileAsync(commandProcessor, ["/d", "/c", script], { env });
}

async function runCommandPrompt({ command, cwd, env }) {
  const commandProcessor =
    process.env.ComSpec || join(process.env.SystemRoot, "System32", "cmd.exe");
  return new Promise((resolve, reject) => {
    const child = spawn(commandProcessor, ["/d", "/q"], { cwd, env });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stderr, stdout });
      } else {
        reject(new Error(`Command Prompt exited with ${code}: ${stderr || stdout}`));
      }
    });
    child.stdin.end(`${command}\r\nexit /b %errorlevel%\r\n`);
  });
}

async function documentedCmdInstallCommand() {
  const troubleshooting = await readFile("docs/troubleshooting.md", "utf8");
  const match = troubleshooting.match(
    /Windows Command Prompt:\s+```bat\r?\n(?<command>[^\r\n]+)\r?\n```/u,
  );
  assert.ok(match?.groups?.command);
  return match.groups.command;
}

test(
  "CMD installer reuses Node 22 with npx without creating a portable runtime",
  { skip: process.platform !== "win32" },
  async (t) => {
    const setup = await createInstalledNodeEnvironment();
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    const { stdout } = await runCmdInstaller(setup.env);

    assert.match(stdout, /Using installed Node\.js 22 runtime/u);
    assert.deepEqual((await readFile(setup.log, "utf8")).trim().split(/\r?\n/u), [
      "--yes",
      "--ignore-scripts",
      "relmio@latest",
    ]);
    assert.deepEqual(await readdir(setup.temporaryDirectory), []);
  },
);

test(
  "CMD installer preserves the npx failure status from an installed Node runtime",
  { skip: process.platform !== "win32" },
  async (t) => {
    const setup = await createInstalledNodeEnvironment({ npxExitCode: 23 });
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    await assert.rejects(runCmdInstaller(setup.env), { code: 23 });
    assert.deepEqual((await readFile(setup.log, "utf8")).trim().split(/\r?\n/u), [
      "--yes",
      "--ignore-scripts",
      "relmio@latest",
    ]);
    assert.deepEqual(await readdir(setup.temporaryDirectory), []);
  },
);

test("canonical troubleshooting exposes the tested CMD bootstrap command", async () => {
  const command = await documentedCmdInstallCommand();
  assert.match(command, /^for \/f "delims=" %F in /u);
  assert.match(command, /https:\/\/relmio\.vercel\.app\/install\.cmd/u);
});

test(
  "documented CMD bootstrap preserves existing files and cleans its temporary script",
  { skip: process.platform !== "win32" },
  async (t) => {
    const setup = await createInstalledNodeEnvironment();
    t.after(() => rm(setup.root, { recursive: true, force: true }));
    const workingDirectory = join(setup.root, "working");
    const existingScript = join(workingDirectory, "install.cmd");
    await mkdir(workingDirectory);
    await writeFile(existingScript, "existing user file\r\n", "utf8");
    await writeFile(
      join(setup.fakeBin, "curl.cmd"),
      [
        "@echo off",
        'if not "%~4"=="-o" exit /b 91',
        'copy /y "%RELMIO_TEST_INSTALL_SOURCE%" "%~5" >nul',
        "exit /b %errorlevel%",
        "",
      ].join("\r\n"),
      "utf8",
    );

    await runCommandPrompt({
      command: await documentedCmdInstallCommand(),
      cwd: workingDirectory,
      env: {
        ...setup.env,
        RELMIO_TEST_INSTALL_SOURCE: installScript,
      },
    });

    assert.equal(await readFile(existingScript, "utf8"), "existing user file\r\n");
    assert.deepEqual(await readdir(setup.temporaryDirectory), []);
  },
);

test(
  "CMD installer downloads, verifies, extracts, and removes a temporary runtime when Node is old",
  { skip: process.platform !== "win32" },
  async (t) => {
    const setup = await createPortableEnvironment();
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    const { stdout } = await runCmdInstaller(
      setup.env,
      setup.fixtureInstallScript,
    );
    const invocation = (await readFile(setup.fixture.log, "utf8")).trim().split(/\r?\n/u);
    const tools = (await readFile(setup.networkToolLog, "utf8")).trim().split(/\r?\n/u);

    assert.match(stdout, /Installing a temporary Node\.js 22 runtime\. Please wait/u);
    assert.match(stdout, /Verified Node\.js download/u);
    assert.match(stdout, /Extracting the verified temporary Node\.js 22 runtime\. Please wait/u);
    assert.match(invocation[0].replaceAll("\\", "/"), /node-v22\.23\.2-win-x64\/node_modules\/npm\/bin\/npx-cli\.js$/u);
    assert.deepEqual(invocation.slice(1), ["--yes", "--ignore-scripts", "relmio@latest", "child-node-ok"]);
    assert.deepEqual(tools.slice(0, 2), ["curl", "certutil"]);
    assert.equal(tools.length, 3);
    assert.match(tools[2], /^tar -xf .*node-v22\.23\.2-win-x64\.zip -C /u);
    assert.deepEqual(await readdir(setup.temporaryDirectory), []);
  },
);

test(
  "CMD installer rejects a bad checksum before extraction or Relmio execution",
  { skip: process.platform !== "win32" },
  async (t) => {
    const setup = await createPortableEnvironment({ validChecksum: false });
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    await assert.rejects(
      runCmdInstaller(setup.env, setup.fixtureInstallScript),
      /Node\.js download checksum did not match; nothing was executed/u,
    );
    const tools = (await readFile(setup.networkToolLog, "utf8")).trim().split(/\r?\n/u);
    assert.deepEqual(tools.slice(0, 2), ["curl", "certutil"]);
    assert.equal(tools.some((tool) => tool.startsWith("tar ")), false);
    await assert.rejects(readFile(setup.fixture.log, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await readdir(setup.temporaryDirectory), []);
  },
);

test(
  "CMD installer never consumes remote checksum-manifest text",
  { skip: process.platform !== "win32" },
  async (t) => {
    const setup = await createPortableEnvironment({ hostileManifest: true });
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    await runCmdInstaller(setup.env, setup.fixtureInstallScript);

    await assert.rejects(readFile(setup.fixture.hostileMarker, "utf8"), {
      code: "ENOENT",
    });
    assert.deepEqual(await readdir(setup.temporaryDirectory), []);
  },
);
