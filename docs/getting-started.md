# Getting started

Relmio keeps each provider and network boundary as an intentionally separate
path:

| Need | Use | Credential |
| --- | --- | --- |
| An OpenAI-compatible local endpoint | Local OpenAI API gateway (`/v1`) | Your OpenAI Platform API key |
| A trusted native Codex integration | Codex App Server (JSON-RPC over WebSocket) | ChatGPT sign-in and a local capability |
| A small local chat backend | Codex Chat Adapter (`POST /chat`) | ChatGPT sign-in and a local bearer credential |
| An n8n bridge on local Docker or a VPS | The separate private n8n sidecar | Your locally created ChatGPT sign-in file |
| Local n8n AI Assistant tools | Private Code Sandbox plus optional SearXNG | Generated sandbox key; model-provider credential configured directly in n8n |

ChatGPT sign-in is never converted into an OpenAI Platform API key. The Codex
options are experimental and are not generic `/v1` services.

## Install

On macOS, Linux, WSL, or Git Bash, start the local wizard with:

```bash
npx --yes --ignore-scripts relmio@latest
```

The wizard prints a private loopback setup URL, verifies Docker before it
changes anything, and asks for final confirmation before local or remote
writes. Local endpoints bind to `127.0.0.1`, never to a LAN interface. The
local n8n bridge and Assistant tools instead publish no host port and stay on
one selected private Docker network. SearXNG web search is off by default.

For installation options and prerequisites, see the [package
README](https://www.npmjs.com/package/relmio). For a VPS/n8n walkthrough, see
[VPS and n8n](./vps-and-n8n.md).

## Choose the next guide

- [Local endpoints](./local-endpoints.md) for the local gateway, Codex App
  Server, Chat Adapter, self-hosted n8n bridge, or local n8n Assistant tools.
- [n8n AI Assistant companion](./ai-assistant.md) for the local-Docker and
  SSH-host sandbox paths.
- [Troubleshooting](./troubleshooting.md) when Docker, authentication, or a
  local image build stops the flow.
- [Security](./security.md) for credential and trust boundaries.
- [Reference](./reference.md) for test commands and protocol notes.
