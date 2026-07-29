# Publish and synchronize the npm package

This guide is for the package maintainer. Run every command on the local
computer in this repository, not on the VPS.

The repository is the release source of truth. A release is prepared in Git,
validated by CI, published to npm from that exact commit, and then tagged with
the same version. npm does not automatically edit `package.json`,
`CHANGELOG.md`, or the Git repository after a publish.

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
3. In this project folder, run:

   ```bash
   npm login --registry=https://registry.npmjs.org
   ```

4. Complete npm's browser approval.
5. Confirm the account without printing a credential:

   ```bash
   npm whoami --registry=https://registry.npmjs.org
   ```

Never paste an npm password, passkey recovery material, 2FA code, or access
token into chat, an issue, a shell-history example, or the repository.

## Prepare a release

Start from a release branch. Do not retag or reuse an already published
version.

### 1. Check the current state

```bash
git status --short --branch
npm view planrelay version \
  --registry=https://registry.npmjs.org
```

The worktree should contain only the changes intended for the release.
Before the first PlanRelay publish, npm returns `E404` because the new package
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
npm pack --dry-run
```

Review the dry-run file list. It must not contain:

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
npm pack --dry-run
test "$RELEASE_COMMIT" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
npm publish --registry=https://registry.npmjs.org
```

npm may open a browser passkey prompt or request a one-time password. Complete
that step only through npm's own prompt.

Verify the immutable registry result:

```bash
LOCAL_VERSION="$(node -p "require('./package.json').version")"
PUBLISHED_VERSION="$(npm view planrelay version \
  --registry=https://registry.npmjs.org)"
test "$LOCAL_VERSION" = "$PUBLISHED_VERSION"
npm view "planrelay@${LOCAL_VERSION}" dist.integrity \
  --registry=https://registry.npmjs.org
```

The equality check must succeed before tagging.

## Tag the published release

Create the tag on the exact published commit:

```bash
RELEASE_VERSION="$(node -p "require('./package.json').version")"
: "${RELEASE_COMMIT:?Run the publish steps above in this terminal first}"
test "$RELEASE_COMMIT" = "$(git rev-parse HEAD)"
git tag -a "v${RELEASE_VERSION}" "$RELEASE_COMMIT" -m "v${RELEASE_VERSION}"
git push origin "v${RELEASE_VERSION}"
```

The tag CI run validates that `v<version>` matches the package, lockfile, and
changelog. Create the GitHub release from that tag and copy the matching
changelog entry into its notes.

## Verify as a package user

In a separate terminal, check the version and launch the exact release:

```bash
npm view planrelay version
npx --yes --ignore-scripts planrelay@PUBLISHED_VERSION
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

Do not publish from the VPS. Do not put npm credentials in a GitHub Actions
workflow unless the project deliberately migrates to npm Trusted Publishing
and reviews its current runtime requirements.
