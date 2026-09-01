import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const installScript = "web/public/install.ps1";

function nativeWindowsPowerShell() {
  if (process.platform !== "win32" || !process.env.SystemRoot) return null;
  return join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function findPowerShell() {
  for (const command of ["pwsh", "powershell"]) {
    try {
      const { stdout } = await execFileAsync(command, [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "(Get-Process -Id $PID).Path",
      ]);
      return stdout.trim();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}

test("PowerShell installer validates the official Windows runtime before execution", async () => {
  const script = await readFile(installScript, "utf8");

  assert.match(
    script,
    /https:\/\/nodejs\.org\/download\/release\/latest-v22\.x\/SHASUMS256\.txt/u,
  );
  assert.match(script, /node-\(\?<version>v22\\\.\\d\+\\\.\\d\+\)-win-/u);
  assert.match(script, /\(\?<architecture>x64\|arm64\)\\\.zip/u);
  assert.match(script, /Get-FileHash[^\n]+-Algorithm SHA256/u);
  assert.match(script, /Node\.js download checksum did not match/u);
  assert.match(script, /-MaximumRedirection 0/u);
  assert.match(script, /SecurityProtocol[^\n]+Tls12/u);
  assert.match(script, /Expand-Archive/u);
  assert.match(script, /--ignore-scripts/u);
  assert.match(script, /relmio@latest/u);
  assert.match(script, /Installing a temporary Node\.js 22 runtime\. Please wait/u);
  assert.match(script, /Verifying the Node\.js SHA-256 checksum\. Please wait/u);
  assert.match(script, /Extracting the verified temporary Node\.js 22 runtime\. Please wait/u);
  assert.doesNotMatch(script, /\bexit\b/iu);
});

test("PowerShell installer avoids the Node eval probe that surfaces [eval]:1 on Windows", async () => {
  const script = await readFile(installScript, "utf8");

  assert.doesNotMatch(
    script,
    /& \$nodeCommand\.Source -p ['"]process\.versions\.node/u,
  );
  assert.match(script, /& \$nodeCommand\.Source --version 2>\$null/u);
  assert.match(
    script,
    /\^v\(\?<major>\\d\+\)\\\.\\d\+\\\.\\d\+\$/u,
  );
});

test(
  "PowerShell installer reuses an installed Node 22 runtime",
  async (t) => {
    const powershell = await findPowerShell();
    if (!powershell) {
      t.skip("PowerShell is not installed");
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "relmio-powershell-test-"));
    const fakeBin = join(root, "bin");
    const downloadLog = join(root, "unexpected-download.log");
    const log = join(root, "invocation.log");
    const wrapper = join(root, "invoke-installer.ps1");
    t.after(() => rm(root, { recursive: true, force: true }));

    await mkdir(fakeBin);
    if (process.platform === "win32") {
      await writeFile(
        join(fakeBin, "node.cmd"),
        [
          "@echo off",
          'if "%~1"=="--version" (',
          "  echo v22.16.0",
          "  exit /b 0",
          ")",
          "echo [eval]:1 1>&2",
          "exit /b 1",
          "",
        ].join("\r\n"),
        "utf8",
      );
      await writeFile(
        join(fakeBin, "npx.cmd"),
        [
          "@echo off",
          '> "%RELMIO_TEST_LOG%" echo %~1',
          '>> "%RELMIO_TEST_LOG%" echo %~2',
          '>> "%RELMIO_TEST_LOG%" echo %~3',
          "",
        ].join("\r\n"),
        "utf8",
      );
    } else {
      await writeExecutable(
        join(fakeBin, "node"),
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          '  printf "v22.16.0\\n"',
          "  exit 0",
          "fi",
          'printf "[eval]:1\\n" >&2',
          "exit 1",
          "",
        ].join("\n"),
      );
      await writeExecutable(
        join(fakeBin, "npx"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELMIO_TEST_LOG"\n',
      );
    }

    await writeFile(
      wrapper,
      [
        '$ErrorActionPreference = "Continue"',
        '$ProgressPreference = "Continue"',
        'function Invoke-WebRequest { Add-Content -LiteralPath $env:RELMIO_DOWNLOAD_LOG -Value "called"; throw "The test refused an unexpected download." }',
        'Invoke-Expression (Get-Content -LiteralPath $env:RELMIO_INSTALL_SCRIPT -Raw)',
        'Write-Output "PREFERENCES:$ErrorActionPreference/$ProgressPreference"',
        "",
      ].join("\n"),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      powershell,
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
          RELMIO_INSTALL_SCRIPT: resolve(installScript),
          RELMIO_DOWNLOAD_LOG: downloadLog,
          RELMIO_TEST_LOG: log,
        },
      },
    );

    assert.match(stdout, /Using installed Node\.js 22 runtime/u);
    assert.match(stdout, /PREFERENCES:Continue\/Continue/u);
    assert.deepEqual((await readFile(log, "utf8")).trim().split(/\r?\n/u), [
      "--yes",
      "--ignore-scripts",
      "relmio@latest",
    ]);
    await assert.rejects(readFile(downloadLog, "utf8"), { code: "ENOENT" });
  },
);

test(
  "Windows PowerShell 5 executes the verified portable runtime fallback",
  { skip: process.platform !== "win32" },
  async (t) => {
    const powershell = nativeWindowsPowerShell();
    assert.ok(powershell);
    const nodeArchitecture = process.arch === "arm64" ? "arm64" : "x64";

    for (const validChecksum of [true, false]) {
      await t.test(validChecksum ? "verified archive" : "checksum rejection", async (subtest) => {
        const root = await mkdtemp(join(tmpdir(), "relmio-windows-powershell-fallback-"));
        subtest.after(() => rm(root, { recursive: true, force: true }));
        const archive = join(root, "node.zip");
        const manifest = join(root, "SHASUMS256.txt");
        const invocationLog = join(root, "npx-invocation.json");
        const temporaryPathLog = join(root, "temporary-path.txt");
        const wrapper = join(root, "invoke-portable-installer.ps1");
        const filename = `node-v22.99.0-win-${nodeArchitecture}.zip`;
        const archiveContents = Buffer.from("relmio verified portable fixture\n");
        await writeFile(archive, archiveContents);
        const digest = createHash("sha256").update(archiveContents).digest("hex");
        await writeFile(
          manifest,
          `${validChecksum ? digest : "0".repeat(64)}  ${filename}\n`,
          "utf8",
        );
        const npxFixture = [
          'const fs = require("node:fs");',
          "fs.writeFileSync(process.env.RELMIO_TEST_LOG, JSON.stringify({ args: process.argv.slice(2), execPath: process.execPath }));",
          "",
        ].join("\n");
        await writeFile(
          wrapper,
          [
            'function Get-Command {',
            '  param([string]$Name,[object]$CommandType,[object]$ErrorAction)',
            '  if ($Name -in @("node", "npx", "npx.cmd")) { return $null }',
            '  Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters',
            '}',
            'function Get-FileHash {',
            '  param([string]$LiteralPath,[string]$Algorithm)',
            '  $stream = [IO.File]::OpenRead($LiteralPath)',
            '  $sha256 = [Security.Cryptography.SHA256]::Create()',
            '  try { $bytes = $sha256.ComputeHash($stream) } finally { $sha256.Dispose(); $stream.Dispose() }',
            '  [PSCustomObject]@{ Hash = (($bytes | ForEach-Object { $_.ToString("x2") }) -join "") }',
            '}',
            'function Invoke-WebRequest {',
            '  param([string]$Uri,[string]$OutFile,[switch]$UseBasicParsing,[int]$MaximumRedirection,[int]$TimeoutSec,[object]$ErrorAction)',
            '  if ($Uri.EndsWith("/SHASUMS256.txt")) {',
            '    Copy-Item -LiteralPath $env:RELMIO_MANIFEST -Destination $OutFile',
            '    Set-Content -LiteralPath $env:RELMIO_TEMP_PATH_LOG -Value $OutFile',
            '    return',
            '  }',
            '  if ($Uri.EndsWith(".zip")) { Copy-Item -LiteralPath $env:RELMIO_ARCHIVE -Destination $OutFile; return }',
            '  throw "Unexpected download URL"',
            '}',
            'function Expand-Archive {',
            '  param([string]$LiteralPath,[string]$DestinationPath,[switch]$Force)',
            '  $runtimeRoot = Join-Path $DestinationPath $env:RELMIO_ARCHIVE_ROOT',
            '  $npxDirectory = Join-Path $runtimeRoot "node_modules\\npm\\bin"',
            '  New-Item -ItemType Directory -Path $npxDirectory -Force | Out-Null',
            '  Copy-Item -LiteralPath $env:RELMIO_NODE_EXE -Destination (Join-Path $runtimeRoot "node.exe")',
            '  Set-Content -LiteralPath (Join-Path $npxDirectory "npx-cli.js") -Value $env:RELMIO_NPX_FIXTURE -Encoding UTF8',
            '}',
            '& $env:RELMIO_INSTALL_SCRIPT',
            "",
          ].join("\r\n"),
          "utf8",
        );

        const options = {
          env: {
            ...process.env,
            RELMIO_ARCHIVE: archive,
            RELMIO_ARCHIVE_ROOT: filename.slice(0, -4),
            RELMIO_INSTALL_SCRIPT: resolve(installScript),
            RELMIO_MANIFEST: manifest,
            RELMIO_NODE_EXE: process.execPath,
            RELMIO_NPX_FIXTURE: npxFixture,
            RELMIO_TEMP_PATH_LOG: temporaryPathLog,
            RELMIO_TEST_LOG: invocationLog,
          },
        };

        if (validChecksum) {
          const { stdout } = await execFileAsync(
            powershell,
            ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper],
            options,
          );
          assert.match(stdout, /Verified Node\.js download/u);
          assert.match(stdout, /Starting the newest Relmio wizard/u);
          const invocation = JSON.parse(await readFile(invocationLog, "utf8"));
          assert.deepEqual(invocation.args, ["--yes", "--ignore-scripts", "relmio@latest"]);
          assert.match(invocation.execPath, /relmio-[a-f0-9]+[\\/]node-v22\.99\.0-win-(?:x64|arm64)[\\/]node\.exe$/iu);
        } else {
          await assert.rejects(
            execFileAsync(
              powershell,
              ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper],
              options,
            ),
            (error) => {
              const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
              assert.match(output, /checksum did not match/u);
              return true;
            },
          );
          await assert.rejects(() => readFile(invocationLog, "utf8"), { code: "ENOENT" });
        }

        const manifestDestination = (await readFile(temporaryPathLog, "utf8")).trim();
        await assert.rejects(() => lstat(resolve(manifestDestination, "..")), { code: "ENOENT" });
      });
    }
  },
);
