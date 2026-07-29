# Publish and synchronize the npm package

This guide is for the package maintainer. Run every command on the local
computer in this repository, not on the VPS.

The repository is the release source of truth. The initial package is prepared
in Git, validated by CI, published to npm from that exact commit, and then
tagged with the same version. Later releases are tagged first and published
from that exact tag by the trusted workflow. npm does not automatically edit
`package.json`, `CHANGELOG.md`, or the Git repository after a publish.

The first `relmio` publication is a one-time bootstrap with a narrowly scoped
local access token because npm requires the package to exist before a trusted
publisher can be attached. After that bootstrap, releases use the
repository's `.github/workflows/publish.yml` OIDC workflow and no long-lived
npm token.

## Version contract

Every release must use one semantic version in all of these places:

- `package.json`;
- the top-level and root-package entries in `package-lock.json`;
- the newest numbered release in `CHANGELOG.md`;
- the Git tag `v<version>`;
- the version published to npm.

Check the local files at any time:

```bash
npm run release:check
```

On a tag build, CI also checks that the tag matches the files. The npm badge
in the README is only an informational, potentially cached view of the
registry's current `latest` version. The post-publish commands below perform
the authoritative equality check.

## One-time npm account setup

1. Sign in at <https://www.npmjs.com/>.
2. Configure an npm-supported second factor for package publishing. Depending
   on the account, npm may approve with a passkey/security key or request an
   authenticator one-time code.
3. Create one granular access token that can create and publish only the new
   package. Keep it in the ignored local `NPM_CREATE_ACCESS_TOKEN` environment
   variable and revoke it after trusted publishing is configured.

Never paste an npm password, passkey recovery material, 2FA code, or access
token into chat, an issue, a shell-history example, or the repository.

## Prepare a release

Start from a release branch. Do not retag or reuse an already published
version.

### 1. Check the current state

```bash
git status --short --branch
npm view relmio version \
  --registry=https://registry.npmjs.org
```

The worktree should contain only the changes intended for the release.
Before the first Relmio publish, npm returns `E404` because the new package
name has no published version yet. Confirm the exact package name is still
available, then continue only from the reviewed rebrand commit.

### 2. Bump the files without creating a tag

For a backward-compatible bug or documentation release:

```bash
npm version patch --no-git-tag-version
```

Use `minor` for a backward-compatible feature and `major` for a breaking
change. The command updates both `package.json` and `package-lock.json`.

Add a matching release heading and user-visible changes to `CHANGELOG.md`.
Then run:

```bash
npm run release:check
```

### 3. Run the complete release gate

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
npm run package:build -- .release
```

The package builder stages the concise npm README as the tarball's root
`README.md`; it never changes the full GitHub README or its Mermaid diagrams.
Review the emitted tarball file list. It must not contain:

- `.env` or local-context files;
- OAuth files or tokens;
- SSH keys, passwords, or real VPS details;
- browser session URLs;
- test recordings or unredacted screenshots;
- unrelated local build artifacts.

Documentation images must be sanitized previews. Remember that `docs/**` is
part of the npm package.

Before changing a private repository to public, audit the complete Git
history as well as the current worktree. Deleting a VPS address, email,
credential, or token from the latest commit does not remove it from earlier
commits. If history contains sensitive data, keep the repository private and
perform a reviewed, coordinated history rewrite before the first public
release.

### 4. Commit and run CI

Stage every intended change, then review the exact staged release:

```bash
RELEASE_VERSION="$(node -p "require('./package.json').version")"
git add --all
git status --short
git diff --cached --check
git diff --cached --stat
git commit -m "release: v${RELEASE_VERSION}"
git push
```

Merge the release commit into the repository's default branch according to
the project workflow and wait for the default-branch CI run to pass. The
remaining commands assume that branch is named `main`; substitute the actual
default branch if it differs.

## Publish the exact commit

Check out the CI-approved default branch, update it without a merge commit,
and record the exact clean commit:

```bash
git switch main
git pull --ff-only
test -z "$(git status --porcelain)"
RELEASE_COMMIT="$(git rev-parse HEAD)"
npm run release:check
```

Review the package from that commit. Immediately before publishing, fail if
either the commit or worktree changed:

```bash
npm run package:build -- .release
test "$RELEASE_COMMIT" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
```

For the first `relmio` publication only, place the already-created token in
the environment without echoing it, write an owner-only temporary npm config,
and publish the reviewed tarball:

```bash
umask 077
NPM_CONFIG_USERCONFIG="$(mktemp)"
trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT
printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_CREATE_ACCESS_TOKEN}' \
  > "$NPM_CONFIG_USERCONFIG"
export NPM_CONFIG_USERCONFIG NPM_CREATE_ACCESS_TOKEN
npm whoami --registry=https://registry.npmjs.org
LOCAL_VERSION="$(node -p "require('./package.json').version")"
npm publish ".release/relmio-${LOCAL_VERSION}.tgz" \
  --ignore-scripts \
  --access public \
  --registry=https://registry.npmjs.org
```

Do not place the real token value in `.npmrc`, the workflow, a command-line
argument, or Git. npm may still require its configured publishing second
factor.

Verify the immutable registry result:

```bash
LOCAL_VERSION="$(node -p "require('./package.json').version")"
PUBLISHED_VERSION="$(npm view relmio version \
  --registry=https://registry.npmjs.org)"
test "$LOCAL_VERSION" = "$PUBLISHED_VERSION"
npm view "relmio@${LOCAL_VERSION}" dist.integrity \
  --registry=https://registry.npmjs.org
```

The equality check must succeed before tagging.

## Switch future releases to trusted publishing

Do this only after the first `relmio` version exists on npm and the
`publish.yml` workflow is present on the GitHub default branch.

On the npm package's **Trusted Publisher** form, use:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `Demonbane18` |
| Repository | `n8n-openai-oauth-setup` |
| Workflow filename | `publish.yml` |
| Environment name | `npm` |
| Allowed action | Allow npm publish |

The environment must match `environment: npm` in the workflow. Add approval
rules to the GitHub `npm` environment if a maintainer should explicitly
approve each registry write.

The workflow uses a GitHub-hosted runner, `id-token: write`, Node.js `22.14.0`,
and npm `11.13.0`, which is separate from the application's reviewed npm
`10.9.8` development runtime. npm exchanges the GitHub OIDC identity for a
short-lived publishing credential and automatically generates provenance for
public packages.

After one trusted publish is verified:

1. change package publishing access to require 2FA and disallow tokens;
2. revoke `NPM_CREATE_ACCESS_TOKEN` and any older automation tokens;
3. keep normal development on npm `10.9.8`;
4. create future GitHub releases from reviewed `v<version>` tags to trigger
   the trusted workflow.

The workflow safely skips a version already present on npm. This lets the
GitHub release for the token-bootstrapped `v0.2.0` tag be created without a
duplicate publish attempt.

## Tag the published release

For the initial token-bootstrap release, create the tag on the exact published
commit:

```bash
RELEASE_VERSION="$(node -p "require('./package.json').version")"
: "${RELEASE_COMMIT:?Run the publish steps above in this terminal first}"
test "$RELEASE_COMMIT" = "$(git rev-parse HEAD)"
git tag -a "v${RELEASE_VERSION}" "$RELEASE_COMMIT" -m "v${RELEASE_VERSION}"
git push origin "v${RELEASE_VERSION}"
```

The tag CI run validates that `v<version>` matches the package, lockfile, and
changelog. For later OIDC releases, push the reviewed tag first and create the
GitHub release from it; publishing the GitHub release triggers the trusted
workflow. Copy the matching changelog entry into the release notes.

## Verify as a package user

In a separate terminal, check the version and launch the exact release:

```bash
npm view relmio version
npx --yes --ignore-scripts relmio@PUBLISHED_VERSION
```

Replace `PUBLISHED_VERSION` with the number just published. Confirm that the
local wizard opens, then press Control+C before entering real credentials if
this is only a smoke test.

The CLI currently has no `--help` argument parser. Do not use a `--help`
invocation as a release check; it starts the wizard like any other argument.

## If something goes wrong

- `ENEEDAUTH`: run `npm login`, complete npm's browser approval, and retry
  `npm whoami`.
- `E403`: confirm the intended npm account owns the package and complete the
  configured publishing second factor.
- `EPUBLISHCONFLICT`: the version is immutable and already exists. Bump to a
  new patch version; never delete or overwrite it.
- Registry version differs from `package.json`: stop before tagging. Determine
  whether the publish succeeded and prepare a new release if necessary.
- The Git commit was pushed but npm publish failed: fix npm authentication or
  policy, rerun the gates on the same clean commit, and publish that version.
- npm publish succeeded but the tag push failed: do not republish. Push the
  tag for the exact already-published commit.
- `npx` cannot see a just-published version: verify the exact registry version
  and wait briefly for registry/CDN propagation.

Do not publish from the VPS. Never put an npm access token in the GitHub
Actions workflow; the trusted workflow authenticates only through OIDC.
