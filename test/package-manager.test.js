import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWingetPortablePackage,
  createDeterministicZip,
  crc32,
  peMachine,
  validatePeArchitecture,
} from "../scripts/build-winget-portable-package.js";
import {
  createHomebrewFormula,
  createPackageManagerCandidates,
  createWingetManifestFiles,
  registryTarballUrl,
  validateReleasePackage,
  wingetInstallerUrl,
} from "../scripts/generate-package-manager-manifests.js";

const packageJson = {
  license: "Apache-2.0",
  name: "relmio",
  repository: { url: "git+https://github.com/Demonbane18/relmio.git" },
  version: "1.2.3",
};
const repositoryVersion = JSON.parse(
  await readFile("package.json", "utf8"),
).version;
const digest = "a".repeat(64);

function createPe(machine) {
  const executable = Buffer.alloc(0x100);
  executable.write("MZ", 0, "ascii");
  executable.writeUInt32LE(0x80, 0x3c);
  executable.write("PE\0\0", 0x80, "ascii");
  executable.writeUInt16LE(machine, 0x84);
  return executable;
}

function extractZipEntries(archive) {
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = archive.readUInt32LE(offset + 18);
    const filenameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentsStart = nameStart + filenameLength + extraLength;
    const name = archive.toString("utf8", nameStart, nameStart + filenameLength);
    const compressed = archive.subarray(contentsStart, contentsStart + compressedSize);
    entries.set(name, inflateRawSync(compressed));
    offset = contentsStart + compressedSize;
  }
  return entries;
}

async function writeFixture(path, contents) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

test("release package metadata and immutable release URLs are validated", () => {
  assert.deepEqual(validateReleasePackage(packageJson), { version: "1.2.3" });
  assert.equal(
    registryTarballUrl("1.2.3"),
    "https://registry.npmjs.org/relmio/-/relmio-1.2.3.tgz",
  );
  assert.equal(
    wingetInstallerUrl({ architecture: "arm64", version: "1.2.3" }),
    "https://github.com/Demonbane18/relmio/releases/download/v1.2.3/relmio-1.2.3-windows-arm64.zip",
  );
  assert.throws(
    () => validateReleasePackage({ ...packageJson, license: "MIT" }),
    /license must be Apache-2\.0/u,
  );
  assert.throws(
    () => wingetInstallerUrl({ architecture: "x86", version: "1.2.3" }),
    /Unsupported WinGet architecture/u,
  );
});

test("Homebrew candidate follows the standard Node formula layout", () => {
  const formula = createHomebrewFormula({ sha256: digest, version: "1.2.3" });

  assert.match(formula, /^class Relmio < Formula$/mu);
  assert.match(formula, /url "https:\/\/registry\.npmjs\.org\/relmio\/-\/relmio-1\.2\.3\.tgz"/u);
  assert.match(formula, /depends_on "node"/u);
  assert.match(formula, /depends_on "python" => :build/u);
  assert.match(formula, /system "npm", "install", \*std_npm_args/u);
  assert.match(formula, /bin\.install_symlink libexec\.glob\("bin\/\*"\)/u);
  assert.match(formula, /assert_predicate bin\/"relmio", :executable\?/u);
  assert.match(formula, /system bin\/"relmio", "--version"/u);
  assert.doesNotMatch(formula, /browserCommand/u);
  assert.doesNotMatch(formula, /npm install -g/u);
});

test("WinGet candidates use current multi-file portable ZIP manifests", () => {
  const manifests = createWingetManifestFiles({
    installers: [
      {
        architecture: "arm64",
        sha256: "b".repeat(64),
        url: wingetInstallerUrl({ architecture: "arm64", version: "1.2.3" }),
      },
      {
        architecture: "x64",
        sha256: digest,
        url: wingetInstallerUrl({ architecture: "x64", version: "1.2.3" }),
      },
    ],
    version: "1.2.3",
  });
  const installer = manifests.get("Demonbane18.Relmio.installer.yaml");
  const locale = manifests.get("Demonbane18.Relmio.locale.en-US.yaml");

  assert.match(installer, /ManifestVersion: 1\.12\.0/u);
  assert.match(installer, /InstallerType: zip/u);
  assert.match(installer, /NestedInstallerType: portable/u);
  assert.match(installer, /ArchiveBinariesDependOnPath: true/u);
  assert.match(installer, /PortableCommandAlias: relmio/u);
  assert.match(installer, /Architecture: arm64/u);
  assert.match(installer, /Architecture: x64/u);
  assert.match(installer, new RegExp(`InstallerSha256: ${digest.toUpperCase()}`, "u"));
  assert.match(locale, /PackageLocale: en-US/u);
  assert.match(locale, /License: Apache-2\.0/u);
  assert.throws(
    () =>
      createWingetManifestFiles({
        installers: [
          { architecture: "x64", sha256: digest, url: "https://example.test/a.zip" },
          { architecture: "x64", sha256: digest, url: "https://example.test/b.zip" },
        ],
        version: "1.2.3",
      }),
    /supplied more than once/u,
  );
});

test("candidate generation uses local immutable artifacts and never overwrites staging", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relmio-package-manager-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const tarball = join(directory, "relmio-1.2.3.tgz");
  const x64Archive = join(directory, "relmio-1.2.3-windows-x64.zip");
  const outputDirectory = join(directory, "candidates");
  await Promise.all([
    writeFile(tarball, "npm candidate"),
    writeFile(x64Archive, "portable candidate"),
  ]);

  const result = await createPackageManagerCandidates({
    npmTarballPath: tarball,
    outputDirectory,
    packageJson,
    wingetInstallers: [{ architecture: "x64", path: x64Archive }],
  });

  assert.equal(result.version, "1.2.3");
  assert.equal(result.generatedPaths.length, 4);
  const formula = await readFile(
    join(outputDirectory, "homebrew-tap", "Formula", "relmio.rb"),
    "utf8",
  );
  assert.match(formula, new RegExp(createHashForTest("npm candidate"), "u"));
  const installer = await readFile(
    join(
      outputDirectory,
      "winget-pkgs",
      "manifests",
      "d",
      "Demonbane18",
      "Relmio",
      "1.2.3",
      "Demonbane18.Relmio.installer.yaml",
    ),
    "utf8",
  );
  assert.match(installer, new RegExp(createHashForTest("portable candidate").toUpperCase(), "u"));
  await assert.rejects(
    createPackageManagerCandidates({
      npmTarballPath: tarball,
      outputDirectory,
      packageJson,
      wingetInstallers: [],
    }),
    /Output directory already exists/u,
  );
});

test("WinGet candidates do not require or generate a Homebrew tarball", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relmio-winget-candidates-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const x64Archive = join(directory, "relmio-1.2.3-windows-x64.zip");
  const outputDirectory = join(directory, "candidates");
  await writeFile(x64Archive, "portable candidate");

  const result = await createPackageManagerCandidates({
    outputDirectory,
    packageJson,
    wingetInstallers: [{ architecture: "x64", path: x64Archive }],
  });

  assert.equal(result.generatedPaths.length, 3);
  await assert.rejects(
    readFile(join(outputDirectory, "homebrew-tap", "Formula", "relmio.rb")),
    /ENOENT/u,
  );
});

function createHashForTest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

test("portable ZIP writer is deterministic and round-trips data", () => {
  const files = [
    { contents: Buffer.from("second"), path: "z/second.txt" },
    { contents: Buffer.from("first"), path: "a/first.txt" },
  ];
  const first = createDeterministicZip(files);
  const second = createDeterministicZip([...files].reverse());

  assert.deepEqual(first, second);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.deepEqual(extractZipEntries(first), new Map([
    ["a/first.txt", Buffer.from("first")],
    ["z/second.txt", Buffer.from("second")],
  ]));
  assert.equal(deflateRawSync(Buffer.from("first")).length > 0, true);
});

test("portable package bundles its runtime, launcher, package tree, and npx", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relmio-portable-package-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const runtimeDirectory = join(directory, "node-v22.14.0-win-x64");
  const launcherPath = join(directory, "relmio.exe");
  const productionModules = join(directory, "production-node-modules");
  const firstOutput = join(
    directory,
    "first",
    `relmio-${repositoryVersion}-windows-x64.zip`,
  );
  const secondOutput = join(
    directory,
    "second",
    `relmio-${repositoryVersion}-windows-x64.zip`,
  );
  await Promise.all([
    writeFixture(join(runtimeDirectory, "node.exe"), createPe(0x8664)),
    writeFixture(
      join(runtimeDirectory, "node_modules", "npm", "bin", "npx-cli.js"),
      "export {};",
    ),
    writeFixture(launcherPath, createPe(0x8664)),
    writeFixture(join(productionModules, "ssh2", "index.js"), "export class Client {}"),
    writeFixture(join(productionModules, ".cache", "should-not-ship"), "cache"),
  ]);
  const stageFixturePackage = async (target) => {
    await writeFixture(join(target, "src", "cli.js"), "console.log('fixture');");
  };

  const first = await buildWingetPortablePackage({
    architecture: "x64",
    launcherPath,
    nodeRuntimeDirectory: runtimeDirectory,
    outputPath: firstOutput,
    productionNodeModulesDirectory: productionModules,
    stagePackage: stageFixturePackage,
  });
  const second = await buildWingetPortablePackage({
    architecture: "x64",
    launcherPath,
    nodeRuntimeDirectory: runtimeDirectory,
    outputPath: secondOutput,
    productionNodeModulesDirectory: productionModules,
    stagePackage: stageFixturePackage,
  });

  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await readFile(firstOutput), await readFile(secondOutput));
  const entries = extractZipEntries(await readFile(firstOutput));
  assert.deepEqual(entries.get("relmio.exe"), createPe(0x8664));
  assert.equal(entries.get("runtime/node.exe")?.subarray(0, 2).toString(), "MZ");
  assert.equal(
    entries.has("runtime/node_modules/npm/bin/npx-cli.js"),
    true,
  );
  assert.equal(entries.has("app/node_modules/relmio/src/cli.js"), true);
  assert.equal(entries.has("app/node_modules/ssh2/index.js"), true);
  assert.equal(entries.has("app/node_modules/.cache/should-not-ship"), false);
});

test("portable packaging rejects a mismatched Windows executable architecture", () => {
  assert.equal(peMachine(createPe(0x8664)), 0x8664);
  assert.throws(
    () =>
      validatePeArchitecture({
        architecture: "arm64",
        contents: createPe(0x8664),
        label: "fixture launcher",
      }),
    /not built for arm64/u,
  );
});

test("the Windows launcher uses the bundled Node runtime and app tree", async () => {
  const launcher = await readFile("packaging/winget/relmio-launcher.c", "utf8");

  assert.match(launcher, /runtime\\\\node\.exe/u);
  assert.match(launcher, /app\\\\node_modules\\\\relmio\\\\src\\\\cli\.js/u);
  assert.match(launcher, /CreateProcessW\(runtime_path/u);
  assert.match(launcher, /CommandLineToArgvW/u);
});
