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

The wizard prints a private setup URL, checks Docker, shows the plan, and asks
before it writes files or starts Docker. Local endpoints use `127.0.0.1`.
The n8n bridge and Assistant tools use one selected Docker network and publish
no host port. SearXNG is off by default.

## Choose a guide

- [Local endpoints](./local-endpoints.md) for the gateway, Codex, the Chat
  Adapter, the n8n bridge, and local Assistant tools.
- [New local n8n + ngrok](./local-n8n-stack.md) if you do not already run n8n.
- [AI Assistant companion](./ai-assistant.md) for Assistant setup and its
  limits.
- [VPS and n8n](./vps-and-n8n.md) for the remote sidecar route.
- [Troubleshooting](./troubleshooting.md) when setup stops.
- [Security](./security.md) for account, network, and credential rules.
