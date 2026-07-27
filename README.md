# n8n OpenAI OAuth Setup

A local browser wizard that installs
[EvanZhouDev/openai-oauth](https://github.com/EvanZhouDev/openai-oauth)
as a separate Docker sidecar beside a self-hosted n8n instance.

The goal is simple: let a non-technical VPS owner complete the setup without
editing Docker files or typing commands on the VPS.

> [!IMPORTANT]
> This does **not** create a real OpenAI API key. It creates a private,
> OpenAI-compatible endpoint that uses a ChatGPT OAuth session. The `local-only`
> value entered in n8n is only a placeholder because n8n requires the API-key
> field.

> [!WARNING]
> `openai-oauth` is an unofficial, community-maintained project. It is not
> affiliated with or endorsed by OpenAI. ChatGPT subscriptions and OpenAI API
> billing are normally separate products. Use this only for your own
> experimental workflows, protect the OAuth file like a password, and follow
> [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/) and usage
> policies.

## What makes this safe for the existing n8n

The wizard:

- reads the n8n container and network with read-only Docker commands;
- creates a separate Compose project named `n8n-openai-oauth`;
- writes only under `/docker/n8n-openai-oauth`;
- builds and starts only the `openai-oauth` service;
- joins an existing Docker network so n8n can reach it by service name;
- publishes no VPS port and creates no Traefik route;
- verifies afterward that port `10531` is not published.

It never edits the n8n Compose file or image and never builds, restarts, stops,
recreates, or removes the n8n container. Automated tests enforce that command
boundary.

## Fastest setup

### What you need

- A Mac or Windows computer with
  [Node.js 22 or newer](https://nodejs.org/en/download)
- A ChatGPT account that can use Codex models
- A self-hosted n8n Docker container on a VPS
- The VPS address and root SSH password
- Docker Compose v2 on the VPS

### Fastest setup: run the local wizard

After the package is published, the simplest method is to open Terminal
(macOS/Linux) or PowerShell (Windows) on your own computer and run:

```bash
npx --yes n8n-openai-oauth-setup
```

The wizard runs on your computer, opens a browser, and connects to the VPS
over SSH. It does not install Node, npm, or this wizard on the VPS. The VPS
only receives the separate sidecar files after you review and approve the
plan.

### Private-repository fallback: double-click

1. Clone this private repository with GitHub Desktop.
2. Open the repository folder.
3. On macOS, double-click **Start Wizard.command**.
4. On Windows, double-click **Start Wizard.bat**.
5. Follow the five screens in the browser.

The launcher installs the one pinned local dependency when needed, opens the
wizard on `127.0.0.1`, and leaves the Terminal window open only while the
wizard is running.

If you are using the private GitHub repository instead of npm:

```bash
npm ci --ignore-scripts
npm start
```

## The five wizard screens

1. **Sign in locally.** The OAuth callback stays on your computer.
2. **Confirm the VPS.** Check the SSH fingerprint before the password field
   unlocks.
3. **Choose n8n.** The wizard detects the running official n8n container and
   its networks.
4. **Review.** Nothing is written until you approve the exact sidecar-only
   plan.
5. **Copy the n8n settings.** The wizard verifies the sidecar and model list
   first.

## Values to enter in n8n

Create or edit an **OpenAI** credential:

| Field | Value |
|---|---|
| API Key | `local-only` |
| Organization ID | Leave empty |
| Base URL | `http://openai-oauth:10531/v1` |
| Add Custom Header | Off |

For an **OpenAI Chat Model**:

- select one of the models returned by the bridge;
- keep **Use Responses API** on;
- start with no built-in tools, then add tools after a simple prompt succeeds.

For an **HTTP Request** node, call an endpoint such as:

```text
POST http://openai-oauth:10531/v1/responses
```

No real API key is required by the bridge. n8n may still send
`Authorization: Bearer local-only`; the placeholder is not a secret.

## Documentation

- [Beginner manual installation](docs/manual-install.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security and limitations](docs/security.md)
- [Architecture and n8n safety boundary](docs/architecture.md)
- [Refresh, upgrade, rollback, and uninstall](docs/maintenance.md)
- [npm maintainer publishing guide](docs/npm-publish.md)

## Supported bridge endpoints

The pinned bridge release supports:

- `/v1/models`
- `/v1/responses`
- `/v1/chat/completions`
- streaming and tool calls

Available models depend on the ChatGPT account and may change. The Responses
API is stateless in the bridge, so the caller must send the conversation
history it needs.

## Project status

This is a local wizard for a separate sidecar. A native signed desktop build
is intentionally deferred; `npx` is the supported non-technical distribution
path. See [SPEC.md](SPEC.md) for the approved scope.

## Sources

- [openai-oauth upstream README](https://github.com/EvanZhouDev/openai-oauth)
- [Docker Compose external networking](https://docs.docker.com/compose/how-tos/networking/#use-an-existing-network)
- [n8n OpenAI credential implementation](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/credentials/OpenAiApi.credentials.ts)
- [OpenAI: ChatGPT subscription and API billing are separate](https://help.openai.com/en/articles/8156019-i-want-to-move-my-chatgpt-subscription-to-the-api)
