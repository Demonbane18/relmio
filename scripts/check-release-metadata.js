import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RELEASE_HEADING = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/mu;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function validateReleaseMetadata({
  packageJson,
  packageLock,
  changelog,
  tag,
  requirePackageLock = true,
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

  return { version };
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
  const [packageJsonContents, packageLockContents, changelog, isGitCheckout] =
    await Promise.all([
      readFile("package.json", "utf8"),
      readOptionalFile("package-lock.json"),
      readFile("CHANGELOG.md", "utf8"),
      pathExists(".git"),
    ]);
  const tag =
    process.env.GITHUB_REF_TYPE === "tag"
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
  });
  console.log(`Release metadata is synchronized at v${result.version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
