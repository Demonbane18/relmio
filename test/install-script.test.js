import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { delimiter, join } from "node:path";
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

async function createPortableNodeFixture(root, { validChecksum = true } = {}) {
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
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELMIO_TEST_LOG"\n',
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
    fixture,
    log,
    root,
    env: {
      ...process.env,
      PATH: `${toGitBashPath(fakeBin)}:${toGitBashPathList(process.env.PATH)}`,
      TMPDIR: toGitBashPath(bootstrapTemp),
      ...(process.platform === "win32"
        ? { BASH_ENV: toGitBashPath(bashEnvironment) }
        : {}),
      RELMIO_TEST_ARCHIVE: fixture.archive,
      RELMIO_TEST_LOG: log,
      RELMIO_TEST_MANIFEST: fixture.manifest,
      RELMIO_TEST_WINDOWS_ROOT: fixture.fixtureRoot,
    },
  };
}

async function createBootstrapEnvironment({ validChecksum = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "relmio-install-test-"));
  const fakeBin = join(root, "bin");
  const bootstrapTemp = join(root, "tmp");
  const log = join(root, "invocation.log");
  const fixture = await createPortableNodeFixture(root, { validChecksum });

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
    await writeExecutable(join(fakeBin, "curl"), "#!/bin/sh\nexit 97\n");

    const { stdout } = await execFileAsync("/bin/sh", [installScript], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        RELMIO_TEST_LOG: log,
      },
    });

    assert.match(stdout, /Using installed Node\.js 22/u);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "--yes",
      "--ignore-scripts",
      "relmio@latest",
    ]);
  },
);

test(
  "curl installer downloads, verifies, and removes a temporary Node runtime",
  { skip: !supportsPortableFixture },
  async (t) => {
    const setup = await createBootstrapEnvironment();
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    const { stdout } = await execFileAsync("/bin/sh", [installScript], {
      env: setup.env,
    });
    const invocation = (await readFile(setup.log, "utf8")).trim().split("\n");

    assert.match(stdout, /Downloading a temporary Node\.js 22 runtime/u);
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
    t.after(() => rm(setup.root, { recursive: true, force: true }));

    const { stdout } = await execFileAsync(gitBashShell, [installScript], {
      env: setup.env,
    });
    const invocation = (await readFile(setup.log, "utf8")).trim().split("\n");

    assert.match(stdout, /Verified Node\.js download/u);
    assert.match(
      invocation[0].replaceAll("\\", "/"),
      new RegExp(`${setup.fixture.basename}/node_modules/npm/bin/npx-cli\\.js$`, "u"),
    );
    assert.equal(invocation.at(-1), "child-node-ok");
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
      execFileAsync("/bin/sh", [installScript], { env: setup.env }),
      /Node\.js download checksum did not match/u,
    );
    await assert.rejects(readFile(setup.log, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await readdir(setup.bootstrapTemp), []);
  },
);
