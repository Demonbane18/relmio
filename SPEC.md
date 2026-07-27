# Spec: n8n OpenAI OAuth Setup

## Objective

Build a beginner-friendly, local setup wizard and a correct manual guide for connecting a self-hosted n8n Docker deployment to the unofficial `openai-oauth` bridge.

The primary user is a non-technical Hostinger VPS owner. Success means they can sign in locally, install a separate Docker sidecar, verify it, and configure n8n without editing, rebuilding, recreating, stopping, or restarting their existing n8n deployment.

The project is personal and experimental. It must explain that ChatGPT and OpenAI API billing are separate, that this bridge is unofficial, and that OAuth credentials must be protected like passwords.

## Tech stack

- Node.js `>=22`
- npm `10.9.8`
- ECMAScript modules
- Node built-in HTTP server, test runner, crypto, child process, and file APIs
- `ssh2` `1.17.0`
- `openai-oauth` `2.0.0` inside the generated sidecar image
- Docker Compose v2 on the target VPS

The first release is an `npx`-ready local browser wizard. A signed native desktop wrapper is intentionally deferred until the workflow is stable.

## Commands

- Install: `npm ci --ignore-scripts`
- Run wizard: `npm start`
- Run tests: `npm test`
- Check JavaScript syntax: `npm run lint`
- Audit dependencies: `npm audit --audit-level=high`
- Preview published files: `npm pack --dry-run`

## Project structure

```text
src/
  cli.js                 Local entry point and browser launcher
  domain/                Pure validation and deployment-plan logic
  infrastructure/        SSH/SFTP and local process boundaries
  services/              OAuth, discovery, installation orchestration
  web/                   Localhost HTTP server
  ui/                    Static browser wizard
test/                    Node test-runner unit and integration tests
docs/                    Manual guide, troubleshooting, security, architecture
tasks/                   Implementation plan and task checklist
scripts/                 Cross-platform project checks
```

## Code style

Use small named functions, explicit return objects, and dependency injection at side-effect boundaries:

```js
export function createDeploymentPlan({ networkName }) {
  const safeNetwork = validateDockerName(networkName);

  return {
    projectName: "n8n-openai-oauth",
    networkName: safeNetwork,
    mutatesN8n: false,
  };
}
```

## Testing strategy

- Write failing unit tests first for validation, generated Docker files, and the forbidden-command safety boundary.
- Use fake SSH transports for discovery and installation orchestration.
- Use localhost-only integration tests for the HTTP server.
- Do not connect tests to the user's VPS or ChatGPT account.
- Treat a real Hostinger/n8n run as a separately confirmed manual acceptance test.

## Threat model

### Assets

- ChatGPT OAuth credential file
- VPS root password or SSH agent session
- SSH host identity
- Existing n8n deployment and workflows

### Trust boundaries

- Browser to localhost wizard server
- Wizard process to target SSH server
- Local auth file to SFTP upload
- n8n Docker network to sidecar

### Required controls

- Bind only to `127.0.0.1` and require an unguessable session token.
- Enforce same-origin requests and small request bodies.
- Hold SSH passwords only in request memory and never log them.
- Confirm the SSH host fingerprint before authentication.
- Validate Docker names and container names with allowlists.
- Upload files through SFTP; do not interpolate file contents into shell commands.
- Show a dry-run plan and require confirmation before remote writes.
- Generate a sidecar with no `ports`, no Traefik labels, dropped capabilities, and `no-new-privileges`.

## Boundaries

### Always

- Discover n8n through read-only Docker commands.
- Create a separate Compose project under `/docker/n8n-openai-oauth`.
- Attach only the sidecar to an existing n8n network.
- Run tests and secret scans before commits.
- Preserve a documented uninstall and rollback path.

### Ask first

- Overwriting an existing installer-managed directory.
- Selecting among multiple n8n containers or networks.
- Performing any remote write.
- Publishing the npm package or making the repository public.

### Never

- Edit the existing n8n Compose file.
- Build or modify the n8n image.
- Restart, stop, recreate, or remove n8n.
- Publish the bridge port on the VPS.
- Store or log passwords, tokens, or private keys.
- Share, pool, or redistribute ChatGPT credentials.

## Success criteria

- The wizard starts through one command and opens a local browser.
- It detects a local OAuth credential or starts a fresh local login.
- It confirms the SSH host key and connects using a password or SSH agent.
- It detects the running n8n container and its Docker networks using read-only commands.
- It displays an exact deployment plan before any write.
- It deploys only the separate sidecar and validates `/health` plus `/v1/models`.
- It shows `http://n8n-openai-oauth:10531/v1` and a placeholder API key for
  n8n.
- Automated tests prove no generated install command can modify or restart n8n.
- Documentation covers the successful path, security limits, uninstall, and observed troubleshooting cases.

## Open questions

- npm publication is planned as the primary non-technical distribution path; native desktop packaging remains deferred.
