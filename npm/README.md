<div align="center">
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/brand/relmio-mark.svg" alt="Relmio logo" width="88">
  <h1>Relmio</h1>
  <p>Set up private n8n relays, Platform-key OpenAI-compatible local endpoints, and experimental Codex App Server sessions.</p>
  <p>
    <a href="https://github.com/Demonbane18/relmio">Full guide</a>
    &nbsp;·&nbsp;
    <a href="https://relmio.vercel.app/">Hosted ChatGPT site</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Demonbane18/relmio/issues/new">Report an issue</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Demonbane18/relmio/blob/main/docs/roadmap.md">Roadmap</a>
  </p>
  <p>
    <a href="https://ko-fi.com/paldogies"><img src="https://img.shields.io/badge/Ko--fi-support-ff5e5b.svg?logo=ko-fi&logoColor=white" alt="Support Relmio on Ko-fi"></a>
  </p>
</div>

## See it working first

This documented example follows a tested n8n OpenAI credential through a
published Telegram-triggered workflow. It is a product-operation record, not
an endorsement, sponsorship, or affiliation by OpenAI, n8n, Hostinger,
Telegram, or AppBuildersPH.

<figure>
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/examples/n8n-openai-credential-connected.png" alt="n8n OpenAI credential dialog showing that the connection test succeeded" width="960">
  <figcaption>The n8n OpenAI credential connection test succeeded; the credential value itself is obscured.</figcaption>
</figure>

<figure>
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/examples/gpt-56-model-selector.png" alt="n8n model selector with gpt-5.6-terra selected and an account-specific model list" width="500">
  <figcaption>This signed-in account's n8n model list includes <code>gpt-5.6-terra</code>; model availability is account-dependent and can change.</figcaption>
</figure>

<figure>
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/examples/telegram-n8n-workflow-execution.png" alt="Successful n8n execution of a Telegram-triggered workflow with HTTP Request, Basic LLM Chain, and AI Agent branches" width="960">
  <figcaption>The published Telegram-triggered n8n workflow completed successfully across its HTTP Request, Basic LLM Chain, and AI Agent branches.</figcaption>
</figure>

<figure>
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/examples/telegram-model-results.png" alt="Telegram conversation receiving HTTP Request, Basic LLM Chain, and AI Agent outputs" width="682">
  <figcaption>Telegram received the HTTP Request, Basic LLM Chain, and AI Agent outputs sent by that workflow.</figcaption>
</figure>

Relmio is a local browser wizard with separate setup paths. Its existing
VPS/n8n path installs a private
[openai-oauth](https://github.com/EvanZhouDev/openai-oauth) Docker sidecar
beside an existing self-hosted n8n instance. Its local Docker path can install
either an OpenAI-compatible gateway backed by a Platform API key or the
official Codex App Server backed by ChatGPT sign-in.

The existing n8n image, Compose file, container, and workflows stay untouched.

A sidecar is a small helper program that runs beside a larger program. Relmio's
private sidecar adds ChatGPT/Codex sign-in and request translation while your
existing n8n stays unchanged. This follows the sidecar pattern described in
[Justin Rice's beginner-friendly overview](https://medium.com/@justinricedev/what-is-a-software-sidecar-8f89feff09f9).

Think of it like a motorcycle gaining a sidecar: together they become a
tricycle with extra seats. n8n is the motorcycle; Relmio is the sidecar that
adds the missing capability without changing n8n.

Try the hosted browser demo at
[relmio.vercel.app](https://relmio.vercel.app/). It is a separate
request-bound ChatGPT experience; the npm package remains the local wizard for
the private VPS/n8n sidecar and the separate local Docker endpoint paths.

> **Warning — Hosted chat requires the browser extension.** Install the
> open-source [Sign in with ChatGPT extension for
> Chrome](https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna)
> or [Firefox](https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/)
> before connecting. If the hosted chat stays disconnected, confirm the
> extension is installed and enabled, reload the page, and select **Connect
> ChatGPT** again.

> The local npm wizard uses its own `localhost:1455` callback instead. If an
> OAuth extension captures that callback, temporarily disable it during local sign-in,
> complete the wizard sign-in, and then re-enable it.

While a fresh local login is pending, **Stop sign-in** terminates the helper
Relmio started before allowing another attempt. Results from older tabs are
rejected after a replacement starts. If cleanup cannot be confirmed, retry
remains disabled; close the wizard and OAuth helper, then restart Relmio.

<figure>
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/examples/hosted-chat-connected.png" alt="Relmio hosted chat showing a connected ChatGPT session and a ready prompt field" width="720">
  <figcaption>Successful hosted-chat state: the browser extension completed the OAuth handoff and Relmio shows the ChatGPT session as connected.</figcaption>
</figure>

Use the site's [Install wizard](https://relmio.vercel.app/install) page for a
clickable macOS/Linux, Homebrew, PowerShell, Command Prompt, and NPX command switcher
tailored to the current self-hosted n8n and Hostinger VPS setup path.

### Browser interface and theme modes

The hosted site and local wizard keep the original Relmio relay layout while
adding a compact **System / Light / Dark** appearance control. System follows
the computer's preference; Light and Dark are remembered on that browser only.
On desktop, the local wizard keeps progress and sidecar-only safety notes in a
persistent rail beside the active task; its compact fixed-screen shell avoids
document scrolling on common laptop screens. On narrow phones, it switches to
a horizontal progress strip and keeps task scrolling inside the active panel.
Both the hosted site and local wizard keep Ko-fi support, GitHub stars, and the
current Relmio version visible beside the appearance control.

## Local Docker endpoints

Choose **Local endpoints** in the browser wizard to install one of these
Docker services on the same computer as your app:

This local Docker path supports macOS, Linux, and Linux under WSL2. Native
Windows is not supported in this release because its filesystem permissions do
not provide the owner-only POSIX mode guarantees used for local credentials.
The existing VPS/n8n wizard remains available from native Windows.

| Option | Local endpoint | Provider credential | Client type |
|---|---|---|---|
| **OpenAI API: compatible clients** | `http://127.0.0.1:12435/v1` by default | Server-side OpenAI Platform API key only | Private local app, SDK, or same-owner development web app |
| **Codex with ChatGPT: agent clients** | `ws://127.0.0.1:14500` by default | ChatGPT sign-in through Codex | Trusted native Codex/App Server client |

The OpenAI-compatible `/v1` endpoint is powered only by a Platform API key,
which the wizard seeds over stdin into a private, labeled Docker volume; it
does not create a host key file. Your app uses a
separate Relmio capability that the wizard displays once.
The bearer remains valid until it is rotated. After installation, use
**Rotate client credential** on the Ready screen to replace only that local
capability. Relmio shows the new one-time credential before activation, verifies
the replacement endpoint, and preserves the upstream Platform API key or Codex
credential/workspace volumes. If replacement cannot be verified, Relmio attempts
to restore the previous verifier and re-attest service readiness. It does not
retain the previous raw client credential to replay it during rollback. If
rollback cannot be confirmed, it targets only the exact managed service for
shutdown and reports whether that stopped state could be verified. Browser requests
must come from an exact origin entered during setup; wildcards are not allowed,
and the capability must never be embedded in a public frontend bundle. Platform
requests use that API project's billing, credits, limits, and permissions, not
a ChatGPT subscription.

ChatGPT sign-in powers only the official experimental Codex App Server JSON-RPC
protocol. It does not expose `/v1`, and Relmio never translates a ChatGPT
OAuth/session token into a general API credential. OpenAI documents the WebSocket transport as
experimental and unsupported for production, and it rejects browser-origin
connections. Use it only with a trusted native client owned by the same person.
Its capability is high-trust because it can operate the signed-in
Codex session and files inside the isolated container workspace.

Both services bind exactly to `127.0.0.1`, require the generated capability,
and mount no host directory or Docker socket. The Codex service gets private
named credential and workspace volumes. This local path does not connect to a
VPS or modify n8n.

Read the complete [Local Docker endpoints
guide](https://github.com/Demonbane18/relmio/blob/main/docs/local-endpoints.md)
before installing. It includes the wizard steps, client settings, exact-origin
rules, billing boundary, container isolation, and official OpenAI documentation
links. The design is documentation-backed engineering guidance, not legal
advice or an OpenAI approval. Codex for Open Source membership is not treated
as permission to broaden credential scope or bypass another agreement.

## Quick start

Choose the terminal already on your own computer. Do not run these commands on
the VPS.

### macOS, Linux, WSL, or Git Bash

```bash
curl -fsSL https://relmio.vercel.app/install.sh | sh
```

### Homebrew (macOS or Linux)

```bash
brew tap Demonbane18/relmio && brew install relmio
```

### Windows PowerShell

```powershell
irm https://relmio.vercel.app/install.ps1 | iex
```

### Windows Command Prompt

```bat
for /f "delims=" %F in ("%TEMP%\relmio-install-%RANDOM%-%RANDOM%-%RANDOM%.cmd") do @if exist "%~F" (exit /b 80) else curl -fsSL --remove-on-error https://relmio.vercel.app/install.cmd -o "%~F" && set "RELMIO_SELF_DELETE=%~F" && call "%~F"
```

No Node.js or Git Bash installation is required first. The
[POSIX](https://github.com/Demonbane18/relmio/blob/main/web/public/install.sh)
and [Windows PowerShell](https://github.com/Demonbane18/relmio/blob/main/web/public/install.ps1)
bootstraps, plus the PowerShell-free [Command Prompt](https://github.com/Demonbane18/relmio/blob/main/web/public/install.cmd)
bootstrap, reuse Node.js 22 or newer when available. Otherwise they show
staged **Please wait** messages while they download the matching current
official Node.js 22 runtime to a private temporary directory, verify its
SHA-256 checksum, run Relmio with npm lifecycle scripts disabled, and remove
the temporary runtime when the wizard closes. The Command Prompt path runs as
the current user and does not request administrator access or change Windows
security policy.

Homebrew is available from the public `Demonbane18/relmio` tap. The WinGet
command stays hidden until Microsoft accepts its catalog pull request and the
catalog updates. Until then, use Homebrew or a direct installer above.

Users who already have Node.js 22 or newer can run the npm package directly:

### NPX (requires Node.js 22+)

```bash
npx --yes --ignore-scripts relmio@latest
```

Keep the active setup terminal open while using the wizard. If the page says
the wizard link is incomplete, close that tab and open the full `Local wizard:`
URL printed by the current terminal instead of refreshing the stripped page.

If the browser does not open automatically, press Enter in an interactive
terminal to open it again. The printed `Local wizard:` URL remains the fallback
for a terminal that cannot accept input or when the launcher still cannot open
a browser.

### Requirements

These requirements are for the VPS/n8n path. For a local Docker endpoint, see
the [local endpoint
requirements](https://github.com/Demonbane18/relmio/blob/main/docs/local-endpoints.md#requirements).

- On macOS/Linux/WSL/Git Bash: `curl`, `awk`, `tar`, and either `sha256sum` or
  `shasum`; Git Bash also needs `unzip`
- On native Windows: Command Prompt uses its built-in `curl`, `certutil`, and
  `tar` tools; Windows PowerShell 5.1 or PowerShell 7 remains an alternative
  bootstrap
- A browser and an eligible ChatGPT/Codex account
- A self-hosted n8n Docker deployment on a VPS
- Docker Compose v2, SSH access, and a Docker network shared with n8n

Back up your n8n workflows before granting any tool VPS access.

## What you get

```text
n8n AI node or HTTP Request
  -> private Docker endpoint: http://n8n-openai-oauth:10531/v1
    -> protected ChatGPT/Codex OAuth session
      -> upstream OpenAI service
```

Relmio's existing VPS/n8n path provides tested setup instructions for:

- OpenAI Chat Model
- AI Agent
- Basic LLM Chain
- HTTP Request

The local endpoint path described above now supports compatible private apps
through a Platform-backed gateway and trusted native clients through Codex App
Server. The broader direction is to add providers and client adapters without
weakening their authentication boundaries or tying the public product name to
n8n. SuperGrok/xAI OAuth is a gated feasibility item on the
[provider roadmap](https://github.com/Demonbane18/relmio/blob/main/docs/roadmap.md);
it is not currently advertised as supported.

## Visual walkthrough

These current product screenshots use sanitized sample values wherever a setup
field might otherwise identify an environment. The VPS identity screen shows a
reserved sample address and sample SSH fingerprint; none of the images includes
an OAuth token, password, private key, or live wizard session URL.

### 1. Choose a hosted installation method

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/00-install-methods.png" alt="Hosted Relmio installation page with macOS/Linux, Homebrew, PowerShell, Command Prompt, and NPX choices" width="720">

The hosted page starts with the installation-method selector. Run the selected
command locally, not on the VPS.

### 2. Complete the local ChatGPT/Codex sign-in

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/01-local-sign-in-ready.png" alt="Sanitized preview-mode sample credential state, not a real saved-login confirmation" width="626">

This image shows a sanitized preview-mode sample credential state; it does not
confirm that a real local ChatGPT login was saved. During a real fresh login,
the browser confirmation states that the credentials were saved locally.

### 3. Verify the VPS identity

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/02-vps-identity-confirmed.png" alt="VPS identity confirmation with a sanitized sample address and SSH fingerprint" width="720">

Confirm the SSH host fingerprint before authentication. The screenshot uses the
reserved sample host `vps.example.test`, a sample fingerprint, and a blank
password field.

### 4. Choose the detected n8n container and network

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/03-n8n-detected.png" alt="Detected n8n container and shared Docker network" width="720">

Discovery is read-only; choose the existing n8n container and shared Docker
network.

### 5. Review the exact sidecar-only plan

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/04-install-plan.png" alt="Exact sidecar-only installation plan, including forbidden actions" width="720">

The plan names the allowed sidecar work and explicitly excludes edits or
restarts of n8n, a published host port, and a Traefik route.

### 6. Copy the verified n8n settings

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/05-bridge-ready.png" alt="Private bridge ready screen with n8n OpenAI credential settings" width="720">

Use these values in an n8n OpenAI credential:

```text
API Key: local-only
Base URL: http://n8n-openai-oauth:10531/v1
Organization ID: leave empty
Add Custom Header: Off
```

The `local-only` value is a placeholder required by n8n. It is not an OpenAI
Platform API key.

For an n8n **HTTP Request** node, use **Generic Credential Type** → **Bearer
Auth**, name the credential `openai-oauth`, and enter `local-only` as the
bearer token. Enable **Send Headers** with `Content-Type: application/json`,
then enable **Send Body** → **JSON** → **Using JSON** and paste:

```json
{
  "model": "gpt-5.6-sol",
  "messages": [
    {
      "role": "user",
      "content": "What is a robot?"
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "answer",
      "schema": {
        "type": "object",
        "properties": {
          "content": { "type": "string" }
        },
        "required": ["content"],
        "additionalProperties": false
      },
      "strict": true
    }
  }
}
```

Use `POST http://n8n-openai-oauth:10531/v1/chat/completions` as the URL. The
local wizard's **Copy HTTP request recipe** action supplies the same fields.
Replace the model only if the wizard reports a different ID. The full guide
has the importable cURL version.

## Important boundaries

- Relmio does not create an OpenAI Platform API key.
- The OAuth file is a password-equivalent secret; never commit or share it.
- The sidecar endpoint stays inside the Docker network. Port `10531` must not
  be published on the VPS host.
- Relmio never edits, rebuilds, recreates, stops, or restarts the existing n8n
  container.
- This is an unofficial community project, not affiliated with or endorsed by
  OpenAI, xAI, n8n, Hostinger, Telegram, or AppBuildersPH. Provider access,
  models, limits, and policies can change.
- Use it only where your account, subscription, provider terms, and applicable
  policies allow.

## How it works

OpenAI's Codex CLI uses authenticated endpoints at
`chatgpt.com/backend-api/codex` to run models with a ChatGPT account. Relmio
uses the same OAuth credential shape through the upstream
[`openai-oauth`](https://github.com/EvanZhouDev/openai-oauth) helper to expose
an OpenAI-compatible path without creating an OpenAI Platform API key or
requiring separate API credits. The upstream service and its access rules may
change.

### Foundation and attribution

Relmio is built on [`openai-oauth`](https://github.com/EvanZhouDev/openai-oauth)
by Evan Zhou Dev. That upstream SDK/helper provides the foundation for ChatGPT
login in local apps and Sign in with ChatGPT flows; Relmio wraps it with n8n
discovery, verified SSH/SFTP deployment, Docker networking, and
OpenAI-compatible configuration. Review the upstream project for its own
license, notices, and supported behavior.

## Known limitations

- Only models supported by Codex are available. The list changes over time and
  depends on your ChatGPT plan.
- The CLI `/v1/responses` endpoint is stateless. Callers must send the full
  conversation history; stateful replay is not provided.
- Hosted browser sign-in currently supports Chrome and Firefox. Safari is not
  yet supported by the upstream Sign in with ChatGPT flow.

## Legal

Relmio and `openai-oauth` are unofficial, community-maintained projects and
are not affiliated with, endorsed by, or sponsored by OpenAI.

ChatGPT OAuth credentials should be treated like passwords. Use your own
account, keep credentials private, and never pool, share, or redistribute
access tokens. Do not bypass rate limits, restrictions, or safeguards.

You are responsible for complying with OpenAI's [Terms of
Use](https://openai.com/policies/terms-of-use/), [Usage
Policies](https://openai.com/policies/usage-policies/), and any agreement that
applies to your account. This project is provided as-is without warranties;
OpenAI may change or disable the underlying services at any time.

## Documentation

- [Complete GitHub README and manual fallback](https://github.com/Demonbane18/relmio#readme)
- [Local Docker endpoints](https://github.com/Demonbane18/relmio/blob/main/docs/local-endpoints.md)
- [Configure n8n AI and HTTP nodes](https://github.com/Demonbane18/relmio/blob/main/docs/n8n-configuration.md)
- [Troubleshooting](https://github.com/Demonbane18/relmio/blob/main/docs/troubleshooting.md)
- [Security and limitations](https://github.com/Demonbane18/relmio/blob/main/docs/security.md)
- [Refresh, upgrade, rollback, and uninstall](https://github.com/Demonbane18/relmio/blob/main/docs/maintenance.md)
- [Changelog](https://github.com/Demonbane18/relmio/blob/main/CHANGELOG.md)

## License

[Apache License 2.0](https://github.com/Demonbane18/relmio/blob/main/LICENSE).
See the package
[NOTICE](https://github.com/Demonbane18/relmio/blob/main/NOTICE) for the
upstream `openai-oauth` attribution.
