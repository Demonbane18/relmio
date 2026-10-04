# Publish and synchronize the npm package

This guide is for the package maintainer. Run commands on a clean local
release worktree, never on the VPS. The repository and its reviewed release
commit are the source of truth.

Relmio is already configured as an npm trusted-publishing package. Every npm
release must come from the repository's `.github/workflows/publish.yml`
workflow using GitHub OIDC. Do not create, store, request, or use a local npm
access token for a Relmio release.

## Version contract

Every release uses one semantic version in all of these places:

- `package.json`;
- the top-level and root-package entries in `package-lock.json`;
- the newest numbered release in `CHANGELOG.md`;
- the Git tag `v<version>`;
- the GitHub release;
- the version published to npm.

Check local metadata with:

```bash
npm run release:check
```

The README badge can be cached. Post-release registry queries are the
authoritative publication check.

## Stable and experimental release channels

Relmio 0.18.6 is the current stable release and the npm `latest` version.
Hosted installers also use `latest`.

For a future prerelease such as `0.x.y-experimental.N`, use that exact version
in package metadata, the Git tag, and GitHub Release. Mark the GitHub Release
as a prerelease; the flag must agree with the SemVer version. Publishing the
GitHub Release triggers `.github/workflows/publish.yml`, which uses the
configured GitHub OIDC trusted publisher identity and the configured `npm`
environment.

Publish a prerelease only with the `experimental` dist-tag. Users can opt in
with `npx --yes --ignore-scripts relmio@experimental` or its exact version.
Do not move `latest` or hosted installer defaults to a prerelease.

The prerelease workflow attaches versioned Windows x64 and arm64 ZIP candidates
to the GitHub Release, but skips Homebrew and WinGet candidates. Homebrew is
generated only for a stable version from its exact published npm tarball; the
package-manager generator rejects prerelease formula and WinGet manifests.
Hosted installers continue to invoke `relmio@latest`.

## Trusted publisher contract

The npm package's **Trusted Publisher** configuration must remain:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `Demonbane18` |
| Repository | `relmio` |
| Workflow filename | `publish.yml` |
| Environment name | `npm` |
| Allowed action | Allow npm publish |

The workflow runs on a GitHub-hosted runner with `id-token: write` and uses
the configured `npm` environment. npm exchanges that workload identity for a
short-lived publishing credential and generates provenance for the public
package. The workflow contains no long-lived npm secret.

The GitHub `npm` environment's settings were inspected on 2026-09-27; no
additional required reviewers or deployment-branch restrictions were observed.
Do not assume that this environment prompts for human approval. Keep the
reviewed main-branch pull-request and branch-protection flow, and recheck the
environment policy before a release.

If this trusted-publisher configuration is missing or differs, stop. Repair it
through npm's package settings and review the repository environment policy
before attempting a release. Never substitute `npm login`, an `.npmrc` token,
an environment token, or a personal automation token.

## Prepare a release

Start from an isolated release branch and a clean worktree. Do not retag or
reuse an already published version.

### 1. Check the current state

```bash
git status --short --branch
git tag --sort=-version:refname | head
npm view relmio version --registry=https://registry.npmjs.org
```

Inspect the complete diff since the previous published tag. The worktree must
contain only reviewed release changes.

### 2. Update version metadata without creating a tag

For a compatible patch:

```bash
npm version patch --no-git-tag-version
```

For Relmio's pre-1.0 series, use a minor bump for a meaningful new capability
or workflow. Update the dated `CHANGELOG.md` entry, keep `## Unreleased` above
it, and run:

```bash
npm run release:check
```

### 3. Run the complete release gate

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
npm run package:build -- .release
npm pack --dry-run
```

Review the emitted tarball file list. It must not contain credentials, local
environment files, SSH material, real infrastructure details, browser session
URLs, unredacted recordings, or unrelated build artifacts. The package builder
must stage `npm/README.md` as the tarball's root `README.md` without modifying
the full GitHub guide.

When `web/**` changed, also run the web lint, typecheck, tests, production
Vercel build, and the approved browser QA. When installer or package-manager
surfaces changed, run their platform-focused tests and artifact checks.

### 4. Open the release pull request

Commit only the intended release files and push the release branch. The pull
request must record:

- the previous release tag and intended version;
- the provider/security boundary for changed behavior;
- root, web, installer, package, audit, and browser results as applicable;
- npm, Vercel, Homebrew, WinGet, and installer applicability;
- every known skip or unresolved risk.

Wait for required review, CI, package-manager validation, and Vercel preview
checks. Do not bypass branch protection. Merge only the reviewed head commit.

## Tag and publish the exact merged commit

After the default-branch CI and production deployment are green, resolve the
exact merged commit:

```bash
git fetch origin
RELEASE_COMMIT="$(git rev-parse origin/main)"
git show -s --format='%H%n%s' "$RELEASE_COMMIT"
```

Confirm that commit contains the reviewed package version and changelog. Create
an annotated tag on that exact commit, push it, and verify the remote tag
target before creating the GitHub release:

```bash
RELEASE_VERSION="$(node -p "require('./package.json').version")"
git tag -a "v${RELEASE_VERSION}" "$RELEASE_COMMIT" -m "v${RELEASE_VERSION}"
git push origin "v${RELEASE_VERSION}"
git ls-remote origin "refs/tags/v${RELEASE_VERSION}^{}"
```

Create the GitHub release from that tag with curated notes copied from the
matching changelog entry. Set its prerelease flag to match the SemVer version.
The release triggers `.github/workflows/publish.yml`, which checks out the
immutable tag, runs the release gate and audit, builds the reviewed tarball,
skips if the immutable npm version already exists, and publishes through the
configured OIDC trusted publisher identity.

For a stable release, the workflow publishes to npm `latest`, attaches verified
Windows release artifacts, and generates a Homebrew formula candidate from the
published npm tarball. For a prerelease, it publishes to `experimental`,
attaches versioned Windows x64 and arm64 ZIP candidates, and skips Homebrew and
WinGet candidate generation. Keep hosted installer scripts on `relmio@latest`.

Never run `npm publish` locally. Never recreate or move a published tag.

## Verify delivered surfaces

After the workflow succeeds:

For a stable release, check that `latest` points to the stable version. For a
future prerelease, also check its exact version and `experimental` dist-tag.
`npm view relmio version` reports the `latest` version:

```bash
LOCAL_VERSION="$(node -p "require('./package.json').version")"
npm view "relmio@${LOCAL_VERSION}" \
  version dist.integrity dist.tarball \
  --registry=https://registry.npmjs.org
test "$(npm view relmio dist-tags.latest \
  --registry=https://registry.npmjs.org)" = "$LOCAL_VERSION"
# For a future prerelease only:
test "$(npm view relmio dist-tags.experimental \
  --registry=https://registry.npmjs.org)" = "$LOCAL_VERSION"
```

Also verify:

- the GitHub release tag targets the reviewed merged commit and is marked
  prerelease;
- npm renders the registry-safe README and the package has provenance;
- the Vercel production deployment corresponds to the merged commit;
- hosted `install.sh`, `install.ps1`, and `install.cmd` still byte-match their
  tested repository sources and invoke `relmio@latest`;
- versioned Windows assets are attached to the GitHub prerelease;
- no Homebrew or WinGet prerelease candidate was generated.

Run the repository's distribution audit for the exact release version and do
not call the release synchronized while a required surface is red.

## If something goes wrong

- Trusted-publisher or OIDC failure: stop and inspect the GitHub environment,
  workflow identity, npm trusted-publisher settings, and workflow logs. Do not
  fall back to a token.
- `EPUBLISHCONFLICT`: the version is immutable and already exists. Verify
  whether it is the intended artifact; otherwise prepare a new version.
- Registry version differs from repository metadata: stop. Do not move the tag
  or overwrite npm.
- Tag push failed before the GitHub release: confirm whether the exact tag
  exists remotely before retrying. Never force-update a release tag.
- GitHub release exists but publish failed: leave the tag immutable, fix the
  trusted workflow or policy, rerun the reviewed automation, and preserve the
  failure evidence.
- Vercel or package-manager delivery failed: keep the release status explicit
  and repair only the affected reviewed surface.

Do not publish from the VPS. Do not put an npm token in local config, CI, chat,
issues, logs, or shell examples. Relmio publishing authenticates only through
the repository's short-lived GitHub OIDC identity.
