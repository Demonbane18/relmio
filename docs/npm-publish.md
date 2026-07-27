# Publish the npm package

This guide is for the package maintainer. Run every command on the local
computer in this repository, not on the VPS. The wizard itself later connects
to the VPS over SSH.

## One-time account setup

1. Create or sign in to an account at <https://www.npmjs.com/>.
2. Enable two-factor authentication for publishing.
3. In this project folder, run:

   ```bash
   npm login --registry=https://registry.npmjs.org
   ```

4. Finish the browser sign-in or prompts. Never paste an npm password, 2FA
   code, or access token into chat.
5. Confirm the login without printing any secret:

   ```bash
   npm whoami --registry=https://registry.npmjs.org
   ```

## Release checks

Run these commands before publishing:

```bash
npm run check
npm audit --audit-level=high
npm pack --dry-run
npm view n8n-openai-oauth-setup version --registry=https://registry.npmjs.org
```

The last command should report a 404 for the first release. If it reports a
version, the name is already taken and the package name must be changed before
publishing.

Review the dry-run file list. It must not contain `.env` files, OAuth files,
SSH keys, passwords, VPS addresses, or local test artifacts.

## Publish the first release

Confirm the version in `package.json`, then run:

```bash
npm publish --registry=https://registry.npmjs.org
```

npm may ask for a 2FA one-time password. Enter it only into npm. A published
unscoped package is public even when the GitHub repository remains private.

Verify the release:

```bash
npm view n8n-openai-oauth-setup version --registry=https://registry.npmjs.org
npx --yes n8n-openai-oauth-setup --help
```

## Later releases

Never reuse a published version. Update the version with npm's semver command,
run the release checks again, and publish the new version:

```bash
npm version patch
npm publish --registry=https://registry.npmjs.org
```

For a feature release use `npm version minor`; for a breaking release use
`npm version major`.

## If something goes wrong

- `ENEEDAUTH`: run `npm login --registry=https://registry.npmjs.org`, then
  retry `npm whoami`.
- `E403`: check that you are logged into the intended npm account and that
  2FA is enabled for publishing.
- `EPUBLISHCONFLICT`: that version already exists; run `npm version patch` and
  publish again.
- `403 Package name too similar`: choose a different package name; do not try
  to claim a name that belongs to somebody else.
- `npx` cannot find the package after publishing: wait briefly for registry
  replication, then retry with the exact package name.

Do not publish from the VPS. Do not put npm credentials in the repository,
Docker Compose files, or the wizard's generated sidecar directory.
