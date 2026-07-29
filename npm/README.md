<div align="center">
  <img src="https://raw.githubusercontent.com/Demonbane18/n8n-openai-oauth-setup/main/docs/images/brand/relmio-mark.svg" alt="Relmio logo" width="88">
  <h1>Relmio</h1>
  <p>Relay a supported ChatGPT/Codex sign-in to OpenAI-compatible clients, starting with self-hosted n8n.</p>
  <p>
    <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup">Full guide</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup/issues/new">Report an issue</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup/blob/main/docs/roadmap.md">Roadmap</a>
  </p>
</div>

Relmio is a local browser wizard that installs a private
[openai-oauth](https://github.com/EvanZhouDev/openai-oauth) Docker sidecar
beside an existing self-hosted n8n instance. It guides you through local
ChatGPT/Codex sign-in, SSH host verification, read-only n8n discovery, an
exact change plan, and the final n8n credential settings.

The existing n8n image, Compose file, container, and workflows stay untouched.

## Quick start

Run this on your own macOS, Windows, or Linux computer—not on the VPS:

```bash
npx --yes --ignore-scripts relmio@latest
```

Requirements:

- Node.js 22 or newer
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
[provider roadmap](https://github.com/Demonbane18/n8n-openai-oauth-setup/blob/main/docs/roadmap.md);
it is not currently advertised as supported.

## Visual walkthrough

All images below are sanitized previews with reserved addresses, fake server
data, and no real credential or session information.

### 1. Confirm the local ChatGPT/Codex sign-in

<img src="https://raw.githubusercontent.com/Demonbane18/n8n-openai-oauth-setup/main/docs/images/setup/01-local-sign-in-ready.png" alt="Sanitized local sign-in ready screen" width="720">

### 2. Verify the VPS identity

<img src="https://raw.githubusercontent.com/Demonbane18/n8n-openai-oauth-setup/main/docs/images/setup/02-vps-identity-confirmed.png" alt="Sanitized VPS fingerprint confirmation screen" width="720">

### 3. Choose the detected n8n container and network

<img src="https://raw.githubusercontent.com/Demonbane18/n8n-openai-oauth-setup/main/docs/images/setup/03-n8n-detected.png" alt="Sanitized n8n discovery screen" width="720">

### 4. Review the exact sidecar-only plan

<img src="https://raw.githubusercontent.com/Demonbane18/n8n-openai-oauth-setup/main/docs/images/setup/04-install-plan.png" alt="Sanitized installation plan screen" width="720">

### 5. Copy the verified n8n settings

<img src="https://raw.githubusercontent.com/Demonbane18/n8n-openai-oauth-setup/main/docs/images/setup/05-bridge-ready.png" alt="Sanitized verified bridge screen" width="720">

Use these values in an n8n OpenAI credential:

```text
API Key: local-only
Base URL: http://n8n-openai-oauth:10531/v1
Organization ID: leave empty
Add Custom Header: Off
```

The `local-only` value is a placeholder required by n8n. It is not an OpenAI
Platform API key.

## Important boundaries

- Relmio does not create an OpenAI Platform API key.
- The OAuth file is a password-equivalent secret; never commit or share it.
- The sidecar endpoint stays inside the Docker network. Port `10531` must not
  be published on the VPS host.
- Relmio never edits, rebuilds, recreates, stops, or restarts the existing n8n
  container.
- This is an unofficial community project, not affiliated with or endorsed by
  OpenAI, xAI, or n8n. Provider access, models, limits, and policies can change.
- Use it only where your account, subscription, provider terms, and applicable
  policies allow.

## Documentation

- [Complete GitHub README and manual fallback](https://github.com/Demonbane18/n8n-openai-oauth-setup#readme)
- [Configure n8n AI and HTTP nodes](https://github.com/Demonbane18/n8n-openai-oauth-setup/blob/main/docs/n8n-configuration.md)
- [Troubleshooting](https://github.com/Demonbane18/n8n-openai-oauth-setup/blob/main/docs/troubleshooting.md)
- [Security and limitations](https://github.com/Demonbane18/n8n-openai-oauth-setup/blob/main/docs/security.md)
- [Refresh, upgrade, rollback, and uninstall](https://github.com/Demonbane18/n8n-openai-oauth-setup/blob/main/docs/maintenance.md)
- [Changelog](https://github.com/Demonbane18/n8n-openai-oauth-setup/blob/main/CHANGELOG.md)

## License

[MIT](https://github.com/Demonbane18/n8n-openai-oauth-setup/blob/main/LICENSE)
