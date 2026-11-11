import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RELEASE_HEADING = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/mu;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
// Where readers are told which release is stable: "stable 1.2.3", "stable Relmio 1.2.3" or
// "Relmio 1.2.3 is the current stable release" in the READMEs, and the website's fallback constant.
const README_STABLE_VERSION =
  /\bstable\s+(?:Relmio\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?)|\bRelmio\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?)\s+is\s+the\s+current\s+stable\b/gu;
const STABLE_VERSION_SOURCES = Object.freeze({
  "README.md": README_STABLE_VERSION,
  "npm/README.md": README_STABLE_VERSION,
  "web/app/project-version.ts": /\bpreparedReleaseVersion\s*=\s*"([^"]*)"/gu,
});

export function validateReleaseMetadata({
  packageJson,
  packageLock,
  changelog,
  tag,
  requirePackageLock = true,
  stableVersionSources = {},
  requireStableVersionSources = false,
}) {
  const version = packageJson?.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error("package.json must contain a valid semantic version.");
  }

  if (packageLock || requirePackageLock) {
    if (packageLock?.version !== version) {
      throw new Error(
        `package-lock.json version ${packageLock?.version ?? "missing"} does not match ${version}.`,
      );
    }
    if (packageLock?.packages?.[""]?.version !== version) {
      throw new Error(
        `package-lock.json root package version ${packageLock?.packages?.[""]?.version ?? "missing"} does not match ${version}.`,
      );
    }
  }

  const changelogVersion = changelog.match(RELEASE_HEADING)?.[1];
  if (changelogVersion !== version) {
    throw new Error(
      `newest CHANGELOG.md version ${changelogVersion ?? "missing"} does not match ${version}.`,
    );
  }

  if (tag && tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match v${version}.`);
  }

  // A prerelease keeps naming the last stable release, so only a stable version is compared.
  if (!version.split("+", 1)[0].includes("-")) {
    for (const [file, pattern] of Object.entries(STABLE_VERSION_SOURCES)) {
      const contents = stableVersionSources[file];
      if (contents === undefined) {
        if (requireStableVersionSources) {
          throw new Error(`${file} is missing; it must name stable version ${version}.`);
        }
        continue;
      }
      const named = [...contents.matchAll(pattern)].map((match) => match[1] ?? match[2]);
      if (named.length === 0) {
        throw new Error(`${file} does not name stable version ${version}.`);
      }
      const stale = named.find((candidate) => candidate !== version);
      if (stale !== undefined) {
        throw new Error(`${file} names stable version ${stale} instead of ${version}.`);
      }
    }
  }

  return { version };
}

export function npmReleaseTag({ version, tag, prerelease }) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error("package.json must contain a valid semantic version.");
  }
  if (tag !== `v${version}`) {
    throw new Error(`release tag ${tag ?? "missing"} does not match v${version}.`);
  }
  if (typeof prerelease !== "boolean") {
    throw new Error("GitHub release prerelease flag must be a boolean.");
  }
  const versionIsPrerelease = version.split("+", 1)[0].includes("-");
  if (prerelease !== versionIsPrerelease) {
    throw new Error("GitHub release prerelease flag does not match the package version.");
  }
  return prerelease ? "experimental" : "latest";
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function main() {
  const stableVersionFiles = Object.keys(STABLE_VERSION_SOURCES);
  const [packageJsonContents, packageLockContents, changelog, isGitCheckout, ...stableVersionContents] =
    await Promise.all([
      readFile("package.json", "utf8"),
      readOptionalFile("package-lock.json"),
      readFile("CHANGELOG.md", "utf8"),
      pathExists(".git"),
      ...stableVersionFiles.map(readOptionalFile),
    ]);
  const selectingNpmTag = process.argv[2] === "--npm-dist-tag";
  const tag = selectingNpmTag
    ? process.env.RELEASE_TAG
    : process.env.GITHUB_REF_TYPE === "tag"
      ? process.env.GITHUB_REF_NAME
      : undefined;
  const result = validateReleaseMetadata({
    packageJson: JSON.parse(packageJsonContents),
    packageLock:
      packageLockContents === undefined
        ? undefined
        : JSON.parse(packageLockContents),
    changelog,
    tag,
    requirePackageLock: isGitCheckout,
    // A packed install has only its own README; a Git checkout must have all three sources.
    stableVersionSources: Object.fromEntries(
      stableVersionFiles.map((file, index) => [file, stableVersionContents[index]]),
    ),
    requireStableVersionSources: isGitCheckout,
  });
  if (selectingNpmTag) {
    const flag = process.env.RELEASE_PRERELEASE;
    if (flag !== "true" && flag !== "false") {
      throw new Error("GitHub release prerelease flag must be true or false.");
    }
    console.log(npmReleaseTag({
      version: result.version,
      tag,
      prerelease: flag === "true",
    }));
    return;
  }
  console.log(`Release metadata is synchronized at v${result.version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
