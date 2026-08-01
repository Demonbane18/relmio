import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const installScript = "web/public/install.sh";
const supportsPortableFixture =
  ["darwin", "linux"].includes(process.platform) &&
  ["arm64", "x64"].includes(process.arch);

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
