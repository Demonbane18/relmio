#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const packageIdentifier = "Demonbane18.Relmio";
const packagePublisher = "Demonbane18";
const packageName = "Relmio";
const repositoryUrl = "https://github.com/Demonbane18/relmio";
const manifestVersion = "1.12.0";
const supportedArchitectures = new Set(["x64", "arm64"]);
const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertSha256(value, label = "SHA-256") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw new Error(`${label} must be a 64-character hexadecimal digest.`);
  }
  return value.toLowerCase();
}

export function validateReleasePackage(packageJson) {
  if (packageJson?.name !== "relmio") {
    throw new Error('package.json name must be "relmio".');
  }
  if (typeof packageJson?.version !== "string" || !semver.test(packageJson.version)) {
    throw new Error("package.json must contain a valid semantic version.");
  }
  if (packageJson.license !== "Apache-2.0") {
    throw new Error("package.json license must be Apache-2.0.");
  }
  if (packageJson?.repository?.url !== `git+${repositoryUrl}.git`) {
    throw new Error("package.json repository URL does not match the release source.");
  }

  return { version: packageJson.version };
}

export function registryTarballUrl(version) {
  if (typeof version !== "string" || !semver.test(version)) {
    throw new Error("A valid semantic version is required for the npm tarball URL.");
  }
  return `https://registry.npmjs.org/relmio/-/relmio-${version}.tgz`;
}

export function wingetInstallerUrl({ architecture, version }) {
  if (!supportedArchitectures.has(architecture)) {
    throw new Error(`Unsupported WinGet architecture: ${architecture}.`);
  }
  if (typeof version !== "string" || !semver.test(version)) {
    throw new Error("A valid semantic version is required for the WinGet installer URL.");
  }
  return `${repositoryUrl}/releases/download/v${version}/relmio-${version}-windows-${architecture}.zip`;
}

export function createHomebrewFormula({ sha256, version }) {
  const digest = assertSha256(sha256, "Homebrew tarball SHA-256");
  const tarballUrl = registryTarballUrl(version);

  return `class Relmio < Formula
  desc "Set up a private OpenAI-compatible endpoint for self-hosted n8n"
  homepage "${repositoryUrl}"
  url "${tarballUrl}"
  sha256 "${digest}"
  license "Apache-2.0"

  depends_on "node"
  depends_on "python" => :build

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_predicate bin/"relmio", :executable?
    system bin/"relmio", "--version"
  end
end
`;
}

function normalizeWingetInstaller({ architecture, sha256, url }) {
  if (!supportedArchitectures.has(architecture)) {
    throw new Error(`Unsupported WinGet architecture: ${architecture}.`);
  }
  return {
    architecture,
    sha256: assertSha256(sha256, `WinGet ${architecture} installer SHA-256`).toUpperCase(),
    url: assertString(url, `WinGet ${architecture} installer URL`),
  };
}

export function createWingetManifestFiles({ installers, version }) {
  if (typeof version !== "string" || !semver.test(version)) {
    throw new Error("A valid semantic version is required for WinGet manifests.");
  }
  if (!Array.isArray(installers) || installers.length === 0) {
    throw new Error("At least one WinGet installer is required.");
  }

  const normalizedInstallers = installers
    .map(normalizeWingetInstaller)
    .sort((left, right) => left.architecture.localeCompare(right.architecture));
  const duplicateArchitecture = normalizedInstallers.find(
    (installer, index) =>
      index > 0 && installer.architecture === normalizedInstallers[index - 1].architecture,
  );
  if (duplicateArchitecture) {
    throw new Error(
      `WinGet installer architecture ${duplicateArchitecture.architecture} was supplied more than once.`,
    );
  }

  const schemaPrefix = "https://aka.ms/winget-manifest";
  const header = (type) =>
    `# yaml-language-server: $schema=${schemaPrefix}.${type}.${manifestVersion}.schema.json\n`;
  const installerEntries = normalizedInstallers
    .map(
      ({ architecture, sha256, url }) => `- Architecture: ${architecture}
  NestedInstallerFiles:
    - RelativeFilePath: relmio.exe
      PortableCommandAlias: relmio
  InstallerUrl: ${url}
  InstallerSha256: ${sha256}`,
    )
    .join("\n");

  return new Map([
    [
      `${packageIdentifier}.yaml`,
      `${header("version")}
PackageIdentifier: ${packageIdentifier}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${manifestVersion}
`,
    ],
    [
      `${packageIdentifier}.locale.en-US.yaml`,
      `${header("defaultLocale")}
PackageIdentifier: ${packageIdentifier}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${packagePublisher}
PublisherUrl: ${repositoryUrl}
PublisherSupportUrl: ${repositoryUrl}/issues
PackageName: ${packageName}
PackageUrl: ${repositoryUrl}
License: Apache-2.0
LicenseUrl: ${repositoryUrl}/blob/main/LICENSE
ShortDescription: Create a private OpenAI-compatible endpoint beside self-hosted n8n.
Tags:
  - n8n
  - oauth
  - openai
ManifestType: defaultLocale
ManifestVersion: ${manifestVersion}
`,
    ],
    [
      `${packageIdentifier}.installer.yaml`,
      `${header("installer")}
PackageIdentifier: ${packageIdentifier}
PackageVersion: ${version}
InstallerType: zip
NestedInstallerType: portable
ArchiveBinariesDependOnPath: true
Commands:
  - relmio
Installers:
${installerEntries}
ManifestType: installer
ManifestVersion: ${manifestVersion}
`,
    ],
  ]);
}

export async function sha256File(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

async function assertFile(path, label) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`${label} must be a non-empty regular file: ${path}`);
  }
}

export async function createPackageManagerCandidates({
  npmTarballPath,
  outputDirectory,
  packageJson,
  wingetInstallers = [],
}) {
  const { version } = validateReleasePackage(packageJson);
  const resolvedOutputDirectory = resolve(outputDirectory);
  if (npmTarballPath === undefined && wingetInstallers.length === 0) {
    throw new Error("A published npm tarball or at least one WinGet installer is required.");
  }

  let resolvedNpmTarballPath;
  if (npmTarballPath !== undefined) {
    resolvedNpmTarballPath = resolve(npmTarballPath);
    const expectedNpmTarball = `relmio-${version}.tgz`;
    if (basename(resolvedNpmTarballPath) !== expectedNpmTarball) {
      throw new Error(
        `npm tarball must be named ${expectedNpmTarball}; received ${basename(resolvedNpmTarballPath)}.`,
      );
    }
    await assertFile(resolvedNpmTarballPath, "npm tarball");
  }

  for (const installer of wingetInstallers) {
    if (!supportedArchitectures.has(installer.architecture)) {
      throw new Error(`Unsupported WinGet architecture: ${installer.architecture}.`);
    }
    const path = resolve(installer.path);
    const expectedName = `relmio-${version}-windows-${installer.architecture}.zip`;
    if (basename(path) !== expectedName) {
      throw new Error(
        `WinGet ${installer.architecture} archive must be named ${expectedName}; received ${basename(path)}.`,
      );
    }
    await assertFile(path, `WinGet ${installer.architecture} archive`);
  }

  try {
    await access(resolvedOutputDirectory);
    throw new Error(
      `Output directory already exists: ${resolvedOutputDirectory}. Choose a new empty staging directory.`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const generatedPaths = [];
  if (resolvedNpmTarballPath !== undefined) {
    const formulaPath = join(
      resolvedOutputDirectory,
      "homebrew-tap",
      "Formula",
      "relmio.rb",
    );
    const formula = createHomebrewFormula({
      sha256: await sha256File(resolvedNpmTarballPath),
      version,
    });

    await mkdir(dirname(formulaPath), { recursive: true });
    await writeFile(formulaPath, formula, { encoding: "utf8", flag: "wx" });
    generatedPaths.push(formulaPath);
  }

  if (wingetInstallers.length > 0) {
    const wingetDirectory = join(
      resolvedOutputDirectory,
      "winget-pkgs",
      "manifests",
      "d",
      packagePublisher,
      packageName,
      version,
    );
    const installerMetadata = await Promise.all(
      wingetInstallers.map(async ({ architecture, path }) => ({
        architecture,
        sha256: await sha256File(resolve(path)),
        url: wingetInstallerUrl({ architecture, version }),
      })),
    );
    const manifests = createWingetManifestFiles({
      installers: installerMetadata,
      version,
    });

    await mkdir(wingetDirectory, { recursive: true });
    for (const [name, contents] of manifests) {
      const path = join(wingetDirectory, name);
      await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
      generatedPaths.push(path);
    }
  }

  return { generatedPaths, outputDirectory: resolvedOutputDirectory, version };
}

function parseArguments(argumentsList) {
  const options = {};
  const accepted = new Set([
    "--npm-tarball",
    "--output-dir",
    "--winget-arm64",
    "--winget-x64",
  ]);

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!accepted.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (options[argument] !== undefined) {
      throw new Error(`Argument supplied more than once: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    options[argument] = value;
    index += 1;
  }

  for (const required of ["--output-dir"]) {
    if (options[required] === undefined) {
      throw new Error(`${required} is required.`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  const wingetInstallers = [
    ["x64", options["--winget-x64"]],
    ["arm64", options["--winget-arm64"]],
  ]
    .filter(([, path]) => path !== undefined)
    .map(([architecture, path]) => ({ architecture, path }));
  const result = await createPackageManagerCandidates({
    npmTarballPath: options["--npm-tarball"],
    outputDirectory: options["--output-dir"],
    packageJson,
    wingetInstallers,
  });

  console.log(`Generated package-manager candidates for v${result.version}.`);
  for (const path of result.generatedPaths) {
    console.log(path);
  }
  console.log("No Homebrew tap, GitHub Release asset, or WinGet manifest was published.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
