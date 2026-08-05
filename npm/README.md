<div align="center">
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/brand/relmio-mark.svg" alt="Relmio logo" width="88">
  <h1>Relmio</h1>
  <p>Relay a supported ChatGPT/Codex sign-in to OpenAI-compatible clients, starting with self-hosted n8n.</p>
  <p>
    <a href="https://github.com/Demonbane18/relmio">Full guide</a>
    &nbsp;·&nbsp;
    <a href="https://relmio.vercel.app/">Hosted ChatGPT site</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Demonbane18/relmio/issues/new">Report an issue</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Demonbane18/relmio/blob/main/docs/roadmap.md">Roadmap</a>
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

Relmio is a local browser wizard that installs a private
[openai-oauth](https://github.com/EvanZhouDev/openai-oauth) Docker sidecar
beside an existing self-hosted n8n instance. It guides you through local
ChatGPT/Codex sign-in, SSH host verification, read-only n8n discovery, an
exact change plan, and the final n8n credential settings.

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
installing the private n8n sidecar.

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
The local wizard keeps its horizontal five-step Signal Spine at the top of the
flow, and the hosted site keeps the live GitHub star/version control visible.
Both surfaces collapse their controls for narrow phone screens without
turning the setup flow into a side rail or requiring a separate mobile app.

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

Relmio currently provides tested setup instructions for:

- OpenAI Chat Model
- AI Agent
- Basic LLM Chain
- HTTP Request

The broader direction is to support local chatbots, custom applications,
OpenAI-compatible clients, and provider adapters without tying the public
product name to n8n. SuperGrok/xAI OAuth is a gated feasibility item on the
[provider roadmap](https://github.com/Demonbane18/relmio/blob/main/docs/roadmap.md);
it is not currently advertised as supported.

## Visual walkthrough

These current product screenshots omit or redact sensitive values. The VPS
identity screen redacts the address and SSH fingerprint; none of the images
includes an OAuth token, password, private key, or live wizard session URL.

### 1. Choose a hosted installation method

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/00-install-methods.png" alt="Hosted Relmio installation page with macOS/Linux, Homebrew, PowerShell, Command Prompt, and NPX choices" width="720">

The hosted page starts with the installation-method selector. Run the selected
command locally, not on the VPS.

### 2. Complete the local ChatGPT/Codex sign-in

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/01-local-sign-in-ready.png" alt="OpenAI OAuth browser page confirming that local ChatGPT credentials were saved" width="626">

The browser confirmation states that the ChatGPT credentials were saved locally.

### 3. Verify the VPS identity

<img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/setup/02-vps-identity-confirmed.png" alt="VPS identity confirmation with the address and SSH fingerprint redacted" width="720">

Confirm the SSH host fingerprint before authentication. The screenshot redacts
the address and fingerprint and obscures the password field.

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
