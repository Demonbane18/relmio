# Getting started

Relmio installs local AI connections. Pick the one that matches your account
and client.

| Need | Choose | Credential |
| --- | --- | --- |
| A local OpenAI-compatible endpoint | OpenAI API gateway | Your OpenAI Platform API key |
| A trusted native Codex client | Codex App Server | ChatGPT sign-in and a local capability |
| A small local backend | Codex Chat Adapter | ChatGPT sign-in and a local bearer |
| A bridge for local Docker n8n or a VPS | n8n OAuth sidecar | A local ChatGPT sign-in file |
| n8n AI Assistant tools | Code Sandbox, with optional SearXNG | A generated sandbox key and a model credential entered in n8n |

ChatGPT sign-in is never converted into an OpenAI Platform API key. The Codex
routes are experimental and are not general `/v1` services. The n8n OAuth
sidecar is unofficial, private, and policy-uncertain.

## Install

On macOS, Linux, WSL, or Git Bash:

```bash
npx --yes --ignore-scripts relmio@latest
```

The command starts an owner-scoped background dashboard and opens its private
page without printing the browser capability. From there, you can inspect
existing Relmio services or select **Add connection** to open the same
four-step setup flow. Relmio checks Docker, shows the plan, and asks before it
writes files or starts Docker. Local endpoints use
`127.0.0.1`. The n8n bridge and Assistant tools use one selected Docker
network and publish no host port. SearXNG is off by default.

## Keep the dashboard available

Install a persistent command with Node.js 22 or newer, then use its explicit
lifecycle commands:

```bash
npm install --global --ignore-scripts relmio@latest
relmio start
relmio status
relmio open
relmio stop
```

`relmio start` runs the owner-scoped dashboard in the background. `relmio
status` verifies only that process without printing its private session value.
`relmio open` starts it when needed and opens its private page. `relmio stop`
stops only that process; it does not stop or restart n8n, ngrok, endpoints,
bridges, Assistant companions, or unrelated containers.

The hosted curl, PowerShell, and Command Prompt launchers can use a verified
temporary runtime. In that case the wizard remains a foreground, one-shot
process and ends with that terminal session. The temporary runtime is removed,
so install Relmio persistently before relying on these lifecycle commands.

## Choose a guide

- [Local dashboard](./local-dashboard.md) for launch commands, service states,
  available actions, and credential boundaries.
- [Local endpoints](./local-endpoints.md) for the gateway, Codex, the Chat
  Adapter, the n8n bridge, and local Assistant tools.
- [New local n8n + ngrok](./local-n8n-stack.md) if you do not already run n8n.
- [AI Assistant companion](./ai-assistant.md) for Assistant setup and its
  limits.
- [VPS and n8n](./vps-and-n8n.md) for the remote sidecar route.
- [Troubleshooting](./troubleshooting.md) when setup stops.
- [Security](./security.md) for account, network, and credential rules.
