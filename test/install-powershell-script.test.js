import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const installScript = "web/public/install.ps1";

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
        'function Invoke-WebRequest { throw "The test refused an unexpected download." }',
        'Invoke-Expression (Get-Content -LiteralPath $env:RELMIO_INSTALL_SCRIPT -Raw)',
        'Write-Output "PREFERENCES:$ErrorActionPreference/$ProgressPreference"',
        "",
      ].join("\n"),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      powershell,
      ["-NoLogo", "-NoProfile", "-File", wrapper],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
          RELMIO_INSTALL_SCRIPT: resolve(installScript),
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
  },
);
