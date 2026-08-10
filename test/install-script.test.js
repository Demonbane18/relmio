import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const installScript = "web/public/install.sh";
const supportsPortableFixture =
  ["darwin", "linux"].includes(process.platform) &&
  ["arm64", "x64"].includes(process.arch);
const gitBashShell =
  process.platform === "win32"
    ? process.env.RELMIO_TEST_POSIX_SHELL
    : "/bin/sh";
const pseudoTerminal =
  process.platform === "darwin" || process.platform === "linux"
    ? "python3"
    : null;
const pipedInstallerCommand =
  "curl -fsSL https://relmio.vercel.app/install.sh | sh";
const pseudoTerminalProgram = String.raw`
import errno
import os
import pty
import sys

child_process, terminal = pty.fork()
if child_process == 0:
    os.execvpe(sys.argv[1], [sys.argv[1], "-c", sys.argv[2]], os.environ)

while True:
    try:
        output = os.read(terminal, 1024)
        if not output:
            break
        os.write(1, output)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise

_, status = os.waitpid(child_process, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
const noControllingTerminalProgram = String.raw`
import os
import sys

os.setsid()
os.execvpe("/bin/sh", ["/bin/sh", sys.argv[1]], os.environ)
`;

async function runCommandInPseudoTerminal(
  command,
  env,
  shell = "/bin/sh",
) {
  return execFileAsync(
    pseudoTerminal,
    ["-c", pseudoTerminalProgram, shell, command],
    { env },
  );
}

function runPipedInstallerInPseudoTerminal(env) {
  return runCommandInPseudoTerminal(pipedInstallerCommand, env);
}

function runInstallerWithoutControllingTerminal(env) {
  return execFileAsync(
    pseudoTerminal,
    ["-c", noControllingTerminalProgram, installScript],
    { env },
  );
}

async function waitForCompletion(path, timeout = 60_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw new Error("Timed out waiting for the Git Bash installer fixture.");
}

async function runGitBashInstallerInTerminal(
  shell,
  env,
  completionLog = null,
) {
  if (process.platform !== "win32") {
    return runCommandInPseudoTerminal(pipedInstallerCommand, env, shell);
  }

  await execFileAsync(
    process.env.ComSpec || "cmd.exe",
    [
      "/d",
      "/s",
      "/c",
      `start "" "${shell}" "${env.RELMIO_TEST_LAUNCHER}"`,
    ],
    { env, timeout: 10_000 },
  );

  const exitCode = (await waitForCompletion(completionLog)).trim();
  if (exitCode !== "0") {
    throw new Error(`Git Bash installer fixture exited with ${exitCode}.`);
  }
  return { stderr: "", stdout: "" };
}

async function resolveGitBashShell() {
  if (
    process.platform !== "win32" ||
    !gitBashShell ||
    isAbsolute(gitBashShell)
  ) {
    return gitBashShell;
  }

  const { stdout } = await execFileAsync("git", ["--exec-path"]);
  const gitRoot = resolve(stdout.trim(), "..", "..", "..");
  const shellPath = join(gitRoot, "bin", `${gitBashShell}.exe`);
  await access(shellPath);
  return shellPath;
}

function toGitBashPath(value) {
  if (process.platform !== "win32") {
    return value;
  }

  const normalized = value.replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\/?(.*)$/u);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

function toGitBashPathList(value) {
  if (process.platform !== "win32") {
    return value;
  }

  return value.split(delimiter).map(toGitBashPath).join(":");
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}

async function createPortableNodeFixture(
  root,
  { captureStdin = false, validChecksum = true } = {},
) {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const version = "v22.23.2";
  const basename = `node-${version}-${platform}-${architecture}`;
  const fixtureRoot = join(root, "fixture");
  const archiveRoot = join(fixtureRoot, basename);
  const nodePath = join(archiveRoot, "bin", "node");
  const npmCli = join(archiveRoot, "lib", "node_modules", "npm", "bin");
  const archive = join(root, `${basename}.tar.gz`);
  const manifest = join(root, "SHASUMS256.txt");

  await mkdir(npmCli, { recursive: true });
  await mkdir(join(archiveRoot, "bin"), { recursive: true });
  await writeExecutable(
    nodePath,
    captureStdin
      ? `#!/bin/sh
printf "%s\\n" "$@" > "$RELMIO_TEST_LOG"
if [ -t 0 ]; then
  printf "stdin-is-a-tty\\n" >> "$RELMIO_TEST_LOG"
else
  printf "stdin-is-not-a-tty\\n" >> "$RELMIO_TEST_LOG"
fi
`
      : '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELMIO_TEST_LOG"\n',
  );
  await writeFile(join(npmCli, "npx-cli.js"), "// fixture\n", "utf8");
  await execFileAsync("tar", ["-czf", archive, "-C", fixtureRoot, basename]);

  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  const checksum = validChecksum ? digest : "0".repeat(64);
  await writeFile(manifest, `${checksum}  ${basename}.tar.gz\n`, "utf8");

  return { archive, basename, manifest };
}

async function createWindowsNodeFixture(root) {
  const version = "v22.23.2";
  const basename = `node-${version}-win-x64`;
  const fixtureRoot = join(root, "windows-fixture", basename);
  const npmCli = join(fixtureRoot, "node_modules", "npm", "bin");
  const archive = join(root, `${basename}.zip`);
  const manifest = join(root, "windows-SHASUMS256.txt");

  await mkdir(npmCli, { recursive: true });
  const nodePath = join(fixtureRoot, "node.exe");
  await copyFile(process.execPath, nodePath);
  await chmod(nodePath, 0o755);
  await writeFile(
    join(npmCli, "npx-cli.js"),
    `const { appendFileSync, realpathSync, writeFileSync } = require("node:fs");
const { delimiter, dirname } = require("node:path");

const log = process.env.RELMIO_TEST_LOG;
writeFileSync(log, [process.argv[1], ...process.argv.slice(2)].join("\\n") + "\\n");

const runtimeDirectory = dirname(process.execPath);
const firstPathEntry = (process.env.PATH || "").split(delimiter)[0];
if (realpathSync(firstPathEntry) !== realpathSync(runtimeDirectory)) {
  console.error('\"node\" is not recognized as an internal or external command.');
  process.exit(127);
}

appendFileSync(log, "child-node-ok\\n");
appendFileSync(log, process.stdin.isTTY ? "stdin-is-a-tty\\n" : "stdin-is-not-a-tty\\n");
process.exit(0);
`,
    "utf8",
  );
  await writeFile(archive, "portable Windows Node fixture\n", "utf8");

  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(manifest, `${digest}  ${basename}.zip\n`, "utf8");

  return { archive, basename, fixtureRoot, manifest };
}

async function createGitBashBootstrapEnvironment() {
  const root = await mkdtemp(join(tmpdir(), "relmio-git-bash-test-"));
  const fakeBin = join(root, "bin");
  const bootstrapTemp = join(root, "tmp");
  const log = join(root, "invocation.log");
  const pipeLog = join(root, "pipe.log");
  const completionLog = join(root, "completion.log");
  const launcher = join(root, "launch.sh");
  const bashEnvironment = join(root, "bash-environment");
  const fixture = await createWindowsNodeFixture(root);

  await mkdir(fakeBin);
  await mkdir(bootstrapTemp);
  if (process.platform === "win32") {
    await writeFile(
      bashEnvironment,
      `PATH="${toGitBashPath(fakeBin)}:$PATH"\nexport PATH\n`,
      "utf8",
    );
  }
  await writeExecutable(join(fakeBin, "node"), '#!/bin/sh\nprintf "18\\n"\n');
  await writeExecutable(
    launcher,
    `#!/bin/sh
${pipedInstallerCommand}
status=$?
echo "$status" > "$RELMIO_TEST_COMPLETION_LOG"
exit "$status"
`,
  );
  await writeExecutable(
    join(fakeBin, "uname"),
    `#!/bin/sh
case "$1" in
  -s) printf "MINGW64_NT-10.0\\n" ;;
  -m) printf "x86_64\\n" ;;
  *) exit 94 ;;
esac
`,
  );
  await writeExecutable(
    join(fakeBin, "curl"),
    `#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    --proto | --proto-redir | --connect-timeout | --max-time | --retry | --retry-delay)
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
case "$url" in
  https://relmio.vercel.app/install.sh)
    printf "installer-script-piped\\n" > "$RELMIO_TEST_PIPE_LOG"
    cat "$RELMIO_TEST_INSTALLER"
    ;;
  https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt)
    cp "$RELMIO_TEST_MANIFEST" "$output"
    ;;
  https://nodejs.org/download/release/v22.23.2/node-v22.23.2-win-x64.zip)
    cp "$RELMIO_TEST_ARCHIVE" "$output"
    ;;
  *)
    exit 95
    ;;
esac
`,
  );
  await writeExecutable(
    join(fakeBin, "unzip"),
    `#!/bin/sh
destination=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d)
      destination="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cp -R "$RELMIO_TEST_WINDOWS_ROOT" "$destination/"
`,
  );

  return {
    bootstrapTemp,
    completionLog,
    fixture,
    log,
    pipeLog,
    root,
    env: {
      ...process.env,
      PATH: `${toGitBashPath(fakeBin)}:${toGitBashPathList(process.env.PATH)}`,
      TMPDIR: toGitBashPath(bootstrapTemp),
      ...(process.platform === "win32"
        ? { BASH_ENV: toGitBashPath(bashEnvironment) }
        : {}),
      RELMIO_TEST_ARCHIVE: fixture.archive,
      RELMIO_TEST_COMPLETION_LOG: toGitBashPath(completionLog),
      RELMIO_TEST_LOG: log,
      RELMIO_TEST_LAUNCHER: toGitBashPath(launcher),
      RELMIO_TEST_MANIFEST: fixture.manifest,
      RELMIO_TEST_PIPE_LOG: pipeLog,
      RELMIO_TEST_INSTALLER: toGitBashPath(resolve(installScript)),
      RELMIO_TEST_WINDOWS_ROOT: fixture.fixtureRoot,
    },
  };
}

async function createBootstrapEnvironment(
  { captureStdin = false, validChecksum = true } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "relmio-install-test-"));
  const fakeBin = join(root, "bin");
  const bootstrapTemp = join(root, "tmp");
  const log = join(root, "invocation.log");
  const fixture = await createPortableNodeFixture(root, {
    captureStdin,
    validChecksum,
  });

  await mkdir(fakeBin);
  await mkdir(bootstrapTemp);
  await writeExecutable(
    join(fakeBin, "node"),
    '#!/bin/sh\nprintf "18\\n"\n',
  );
  await writeExecutable(join(fakeBin, "npx"), "#!/bin/sh\nexit 96\n");
  await writeExecutable(
    join(fakeBin, "curl"),
    `#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    --proto | --proto-redir | --connect-timeout | --max-time | --retry | --retry-delay)
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
case "$url" in
  https://relmio.vercel.app/install.sh)
    cat "$RELMIO_TEST_INSTALLER"
    ;;
  https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt)
    cp "$RELMIO_TEST_MANIFEST" "$output"
    ;;
  https://nodejs.org/download/release/v22.23.2/node-v22.23.2-*.tar.gz)
    cp "$RELMIO_TEST_ARCHIVE" "$output"
    ;;
  *)
    exit 95
    ;;
esac
`,
  );

  return {
    bootstrapTemp,
    fixture,
    log,
    root,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TMPDIR: bootstrapTemp,
      RELMIO_TEST_ARCHIVE: fixture.archive,
      RELMIO_TEST_LOG: log,
      RELMIO_TEST_MANIFEST: fixture.manifest,
    },
  };
}

test(
  "curl installer reuses an installed Node 22 runtime",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "relmio-installed-node-test-"));
    const fakeBin = join(root, "bin");
    const downloadLog = join(root, "unexpected-download.log");
    const log = join(root, "invocation.log");
    t.after(() => rm(root, { recursive: true, force: true }));

    await mkdir(fakeBin);
    await writeExecutable(
      join(fakeBin, "node"),
      '#!/bin/sh\nprintf "22\\n"\n',
    );
    await writeExecutable(
      join(fakeBin, "npx"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELMIO_TEST_LOG"\n',
    );
    await writeExecutable(
      join(fakeBin, "curl"),
      '#!/bin/sh\nprintf "curl\\n" >> "$RELMIO_TEST_DOWNLOAD_LOG"\nexit 97\n',
    );

    const { stdout } = await runCommandInPseudoTerminal(installScript, {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RELMIO_TEST_DOWNLOAD_LOG: downloadLog,
      RELMIO_TEST_LOG: log,
    });

    assert.match(stdout, /Using installed Node\.js 22/u);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "--yes",
      "--ignore-scripts",
      "relmio@latest",
    ]);
    await assert.rejects(readFile(downloadLog, "utf8"), { code: "ENOENT" });
  },
);

test(
  "curl installer explains when no controlling terminal is available",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "relmio-no-tty-test-"));
    const fakeBin = join(root, "bin");
    const log = join(root, "invocation.log");
    t.after(() => rm(root, { recursive: true, force: true }));

    await mkdir(fakeBin);
    await writeExecutable(
      join(fakeBin, "node"),
      '#!/bin/sh\nprintf "22\\n"\n',
    );
    await writeExecutable(
      join(fakeBin, "npx"),
      '#!/bin/sh\nprintf "unexpected invocation\\n" > "$RELMIO_TEST_LOG"\n',
    );

    await assert.rejects(
      runInstallerWithoutControllingTerminal({
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        RELMIO_TEST_LOG: log,
      }),
      /An interactive terminal is required to start Relmio/u,
    );
    await assert.rejects(readFile(log, "utf8"), { code: "ENOENT" });
  },
);

test(
  "curl installer gives an installed runtime its controlling terminal after a piped shell handoff",
  { skip: !pseudoTerminal },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "relmio-installed-node-tty-test-"));
    const fakeBin = join(root, "bin");
    const log = join(root, "invocation.log");
    t.after(() => rm(root, { recursive: true, force: true }));

    await mkdir(fakeBin);
    await writeExecutable(
      join(fakeBin, "node"),
      '#!/bin/sh\nprintf "22\\n"\n',
    );
    await writeExecutable(
      join(fakeBin, "npx"),
      `#!/bin/sh
if [ -t 0 ]; then
  printf "stdin-is-a-tty\\n" > "$RELMIO_TEST_LOG"
else
  printf "stdin-is-not-a-tty\\n" > "$RELMIO_TEST_LOG"
fi
`,
    );
    await writeExecutable(
      join(fakeBin, "curl"),
      '#!/bin/sh\ncat "$RELMIO_TEST_INSTALLER"\n',
    );

    await runPipedInstallerInPseudoTerminal({
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RELMIO_TEST_INSTALLER: resolve(installScript),
      RELMIO_TEST_LOG: log,
    });

    assert.equal(await readFile(log, "utf8"), "stdin-is-a-tty\n");
  },
);

test(
  "curl installer gives a portable runtime its controlling terminal after a piped shell handoff",
  { skip: !pseudoTerminal || !supportsPortableFixture },
  async (t) => {
    const setup = await createBootstrapEnvironment({ captureStdin: true });
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    await runPipedInstallerInPseudoTerminal({
      ...setup.env,
      RELMIO_TEST_INSTALLER: resolve(installScript),
    });

    const invocation = (await readFile(setup.log, "utf8")).trim().split("\n");
    assert.equal(invocation.at(-1), "stdin-is-a-tty");
    assert.deepEqual(await readdir(setup.bootstrapTemp), []);
  },
);

test(
  "curl installer downloads, verifies, and removes a temporary Node runtime",
  { skip: !supportsPortableFixture },
  async (t) => {
    const setup = await createBootstrapEnvironment();
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    const { stdout } = await runCommandInPseudoTerminal(installScript, setup.env);
    const invocation = (await readFile(setup.log, "utf8")).trim().split("\n");

    assert.match(stdout, /Installing a temporary Node\.js 22 runtime\. Please wait/u);
    assert.match(stdout, /Verifying the Node\.js SHA-256 checksum\. Please wait/u);
    assert.match(stdout, /Extracting the verified temporary Node\.js 22 runtime\. Please wait/u);
    assert.match(stdout, /Verified Node\.js download/u);
    assert.match(
      invocation[0],
      new RegExp(`${setup.fixture.basename}/lib/node_modules/npm/bin/npx-cli\\.js$`, "u"),
    );
    assert.deepEqual(invocation.slice(1), [
      "--yes",
      "--ignore-scripts",
      "relmio@latest",
    ]);
    assert.deepEqual(await readdir(setup.bootstrapTemp), []);
  },
);

test(
  "curl installer exposes its temporary Windows Node runtime to Git Bash child shims",
  { skip: !gitBashShell },
  async (t) => {
    const setup = await createGitBashBootstrapEnvironment();
    const shell = await resolveGitBashShell();
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    const { stdout } = await runGitBashInstallerInTerminal(
      shell,
      setup.env,
      setup.completionLog,
    );
    const invocation = (await readFile(setup.log, "utf8")).trim().split("\n");
    assert.equal(await readFile(setup.pipeLog, "utf8"), "installer-script-piped\n");

    if (process.platform !== "win32") {
      assert.match(stdout, /Verified Node\.js download/u);
    }
    assert.match(
      invocation[0].replaceAll("\\", "/"),
      new RegExp(`${setup.fixture.basename}/node_modules/npm/bin/npx-cli\\.js$`, "u"),
    );
    assert.equal(invocation.at(-2), "child-node-ok");
    assert.equal(invocation.at(-1), "stdin-is-a-tty");
    assert.deepEqual(await readdir(setup.bootstrapTemp), []);
  },
);

test(
  "curl installer refuses a temporary Node runtime with the wrong checksum",
  { skip: !supportsPortableFixture },
  async (t) => {
    const setup = await createBootstrapEnvironment({ validChecksum: false });
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    await assert.rejects(
      runCommandInPseudoTerminal(installScript, setup.env),
      (error) => {
        assert.match(
          error.stdout,
          /Node\.js download checksum did not match/u,
        );
        return true;
      },
    );
    await assert.rejects(readFile(setup.log, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await readdir(setup.bootstrapTemp), []);
  },
);
