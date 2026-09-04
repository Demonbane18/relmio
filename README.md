<p align="center">
  <img src="docs/images/brand/relmio-banner-animated.svg" alt="Animated Relmio mascot carrying a private n8n connection through its doorway" width="1200">
</p>

<h1 align="center">Relmio</h1>

<p align="center"><strong>Use ChatGPT sign-in with n8n. Keep every credential where it belongs.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/relmio"><img alt="npm version" src="https://img.shields.io/npm/v/relmio?logo=npm&amp;color=0f8f83"></a>
  <a href="https://www.npmjs.com/package/relmio"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/relmio?color=0f8f83"></a>
  <a href="https://github.com/Demonbane18/relmio/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Demonbane18/relmio?style=flat&amp;logo=github&amp;color=0f8f83"></a>
  <a href="https://github.com/Demonbane18/relmio/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/Demonbane18/relmio/ci.yml?branch=main&amp;label=CI"></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0f8f83"></a>
</p>

Relmio helps self-hosted n8n use models available through your own
ChatGPT/Codex sign-in. It installs an unofficial `openai-oauth` sidecar on the
same private Docker network as n8n. The bridge has no host port.

Need the supported OpenAI API instead? Relmio can set up a separate local
`/v1` endpoint backed by your OpenAI Platform API key.

ChatGPT sign-in is not an OpenAI Platform API key. Relmio keeps those paths
separate.

## Quick install

With Node.js 22 or newer on macOS, Linux, WSL, Git Bash, Windows PowerShell,
or Command Prompt:

```bash
npx --yes --ignore-scripts relmio@latest
```

The command opens a private dashboard on `127.0.0.1` and rediscovers services
Relmio already manages. Select **Add connection** to open the four-step wizard,
review exactly what it will create, then confirm the install.

No Node.js yet? The hosted guide has native curl, Homebrew, PowerShell, and
Command Prompt options. Homebrew installs the persistent `relmio` command; it
does not launch the browser. The curl, PowerShell, and Command Prompt
launchers open the foreground wizard with the same platform security checks.

[Open the hosted install guide](https://relmio.vercel.app/install)

## Keep the local dashboard available

For a persistent command, install Relmio with Node.js 22 or newer, then manage
its owner-scoped loopback dashboard explicitly:

```bash
npm install --global --ignore-scripts relmio@latest
relmio start
relmio status
relmio open
relmio stop
```

Without a global install, repeat the full NPX command for each lifecycle
action:

```bash
npx --yes --ignore-scripts relmio@latest start
npx --yes --ignore-scripts relmio@latest status
npx --yes --ignore-scripts relmio@latest open
npx --yes --ignore-scripts relmio@latest stop
```

`relmio start` runs the dashboard in the background without opening a browser.
`relmio open` starts it when needed and opens its private local page.
`relmio status` checks only the verified dashboard process without printing a
session value. `relmio stop` stops only that process; it does not stop or
restart n8n, ngrok, model endpoints, bridges, Assistant companions, or
unrelated containers.

After an upgrade, a dashboard from another Relmio version is never reused.
Run `relmio stop`, then `relmio start` or `relmio open` to replace it
explicitly.

The hosted curl, PowerShell, and Command Prompt launchers can use a verified
temporary Node.js runtime. In that mode Relmio remains a foreground, one-shot
process for that terminal and leaves no persistent command behind.

**Refresh status** rediscovers the same six supported local services without
changing them. It shows only verified connection URLs and state, never stored
secrets. Select **Add connection** to use the existing four-step setup flow.
Use `relmio vps` when you want to open the separate VPS setup directly.

[Learn how to use the local dashboard](docs/local-dashboard.md)

## Pick a path

### I already run n8n

Choose **Existing n8n model bridge**.

1. Sign in with your own ChatGPT/Codex account.
2. Select the running n8n container and its private Docker network.
3. Review and install the sidecar.
4. In n8n, use `http://n8n-openai-oauth:10531/v1` with the placeholder API key
   `local-only`.

Relmio does not edit, restart, rebuild, or expose n8n. The bridge is unofficial,
private, experimental, and policy-uncertain. Check the rules that apply to your
account before using it.

[Read the existing n8n guide](https://relmio.vercel.app/docs/local-endpoints#self-hosted-n8n-bridge)

### I do not have n8n yet

Choose **New local n8n + ngrok**. Relmio creates a separate n8n stack and walks
you through the ngrok domain, token, and Basic Auth fields. Only the new n8n
route is public. Its model bridge, Code Sandbox, and optional SearXNG stay off
the host network.

[Read the new n8n guide](https://relmio.vercel.app/docs/local-n8n-stack)

### I need the supported OpenAI API

Choose **OpenAI API** and enter your own Platform API key. Platform usage is
billed separately from ChatGPT. Relmio stores the key in its private local
service and gives your app a different local credential.

[Read the local endpoint guide](https://relmio.vercel.app/docs/local-endpoints)

## n8n AI Assistant tools

Choose **n8n AI Assistant tools** in the local browser wizard to add Code
Sandbox beside an existing n8n container. SearXNG web search is optional and
off by default. Relmio shows the sandbox key and n8n settings once. It does not
change or restart n8n.

The Assistant model provider still needs its own supported credential. Enter
your Platform API key directly in n8n. The privileged local runner is for
development and testing; n8n recommends Daytona for production.

[Read the AI Assistant guide](https://relmio.vercel.app/docs/ai-assistant)

## Codex device sign-in

The **Codex App Server** and **Codex Chat Adapter** options use the official
Codex device-code sign-in. The ChatGPT credential stays inside the isolated
Codex container. These experimental routes are for trusted local apps and
development backends, not browsers or public servers.

## Provider account policy

Relmio's Codex targets use the official Codex App Server. Codex owns the
ChatGPT OAuth flow, credential storage, and refresh. Each target has one active
ChatGPT account; changing it requires an explicit sign-out and new sign-in.

xAI/Grok authentication is API-key only. Relmio does not ship an xAI target in
this release or implement third-party Grok OAuth, pool accounts, or automatically rotate accounts or keys after a
401, 403, or 429, rate-limit, or quota response. Future provider authentication
is denied by default until the provider documents a supported method and
Relmio adds a reviewed implementation. The dashboard may report that a
credential is configured, but it never returns or re-shows a stored secret.

## Sign-in lifetime

ChatGPT/Codex sign-in tokens expire. The official Codex client refreshes them
automatically during active use before they expire, so active sessions usually
continue without another browser login. Official OpenAI documentation does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Common problems

- **Docker is not running.** Start Docker Desktop or Docker Engine, then open a
  fresh wizard session.
- **Authentication fails.** Close old sign-in tabs, run `relmio open`, and use
  the private page opened by the active dashboard process.
- **Local image build failed.** Check Docker, disk space, and registry access.

[Open troubleshooting](https://relmio.vercel.app/docs/troubleshooting)

## Guides

- [Getting started](https://relmio.vercel.app/docs/getting-started)
- [Local endpoints and n8n bridge](https://relmio.vercel.app/docs/local-endpoints)
- [New local n8n + ngrok](https://relmio.vercel.app/docs/local-n8n-stack)
- [VPS and n8n](https://relmio.vercel.app/docs/vps-and-n8n)
- [n8n AI Assistant](https://relmio.vercel.app/docs/ai-assistant)
- [Security and policy notes](https://relmio.vercel.app/docs/security)
- [Reference](https://relmio.vercel.app/docs/reference)
- [Changelog](https://relmio.vercel.app/changelog)

## Support

Relmio is free to use. If it helped you, you can buy me a coffee.

<a href="https://ko-fi.com/paldogies" target="_blank" rel="noopener noreferrer"><img height="36" src="https://storage.ko-fi.com/cdn/kofi6.png?v=6" alt="Support Relmio on Ko-fi"></a>

## Legal

Relmio is an unofficial, community-maintained project. It is not affiliated
with, endorsed by, or sponsored by OpenAI.

Treat ChatGPT/Codex credentials like passwords. Use only your own account. Do
not pool, share, forward, or sell access tokens. Any request made with those
credentials must be authorized by the account owner.

You are responsible for following OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/),
[Usage Policies](https://openai.com/policies/usage-policies/), and any other
agreement that applies to your account.

> [!WARNING]
> **Do not bypass rate limits, restrictions, or safeguards.**

Relmio is provided as-is without warranties. OpenAI or an upstream service may
change or discontinue access at any time. You accept the risks of using this
experimental community project.
