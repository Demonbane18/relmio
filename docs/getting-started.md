# Getting started

Relmio gives you two intentionally separate paths:

| Need | Use | Credential |
| --- | --- | --- |
| An OpenAI-compatible local endpoint | Local OpenAI API gateway (`/v1`) | Your OpenAI Platform API key |
| A trusted native Codex integration | Codex App Server (JSON-RPC over WebSocket) | ChatGPT sign-in and a local capability |
| A small local chat backend | Codex Chat Adapter (`POST /chat`) | ChatGPT sign-in and a local bearer credential |
| An n8n bridge on a VPS | The separate n8n sidecar | Your locally created ChatGPT sign-in file |

ChatGPT sign-in is never converted into an OpenAI Platform API key. The Codex
options are experimental and are not generic `/v1` services.

## Install

On macOS, Linux, WSL, or Git Bash, start the local wizard with:

```bash
npx --yes --ignore-scripts relmio@latest
```

The wizard prints a private loopback URL, verifies Docker before it changes
anything, and asks for final confirmation before remote VPS writes. It binds
local endpoints to `127.0.0.1`, never to a LAN interface.

For installation options and prerequisites, see the [package
README](https://www.npmjs.com/package/relmio). For a VPS/n8n walkthrough, see
[VPS and n8n](./vps-and-n8n.md).

## Choose the next guide

- [Local endpoints](./local-endpoints.md) for the local gateway, Codex App
  Server, or Chat Adapter.
- [Troubleshooting](./troubleshooting.md) when Docker, authentication, or a
  local image build stops the flow.
- [Security](./security.md) for credential and trust boundaries.
- [Reference](./reference.md) for test commands and protocol notes.
