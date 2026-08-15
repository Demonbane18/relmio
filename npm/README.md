# Relmio

This package starts Relmio's local setup wizard for a private n8n sidecar or a
loopback-only local endpoint. It supports Node.js 22 or newer.

## Quick install

```bash
npx --yes --ignore-scripts relmio@latest
```

The wizard opens a private `127.0.0.1` page, verifies Docker, and requires a
final confirmation before it writes files or deploys a VPS sidecar.

## What it can install

| Option | Contract | Credential boundary |
| --- | --- | --- |
| Local OpenAI gateway | OpenAI-compatible `/v1` | Your OpenAI Platform API key |
| Codex App Server | Experimental JSON-RPC/WebSocket | ChatGPT sign-in and a high-trust local capability |
| Codex Chat Adapter | Experimental `POST /chat` | ChatGPT sign-in and a bearer for trusted local backends |
| n8n sidecar | Private Docker-network `/v1` bridge | A local ChatGPT sign-in file, never a host port |

ChatGPT sign-in does not become an OpenAI Platform API key. Codex transports
are not generic `/v1` services and should never be exposed on a LAN or public
network.

## Common problems

1. **Docker is not running:** start Docker Desktop or Docker Engine with
   Compose, then open a fresh wizard. See
   https://relmio.vercel.app/docs/troubleshooting#docker-is-not-running.
2. **Authentication fails:** close stale sign-in tabs and use only the newest
   local wizard URL printed by the active terminal. See
   https://relmio.vercel.app/docs/troubleshooting#authentication-fails.
3. **Local image build failed:** check Docker, disk space, and registry
   connectivity; the browser intentionally does not reveal Docker stderr or
   local paths.

Full guides use absolute HTTPS links:

- https://relmio.vercel.app/docs/getting-started
- https://relmio.vercel.app/docs/local-endpoints
- https://relmio.vercel.app/docs/vps-and-n8n
- https://relmio.vercel.app/docs/troubleshooting#local-image-build-failed
- https://relmio.vercel.app/docs/security
- https://relmio.vercel.app/docs/reference

Source and issues: https://github.com/Demonbane18/relmio

License: Apache-2.0
