# Manual installation

Relmio's current ChatGPT plan connection is installed through the local browser
wizard. This page no longer provides a manual Dockerfile, copied credential
file, or shell-based VPS deployment. Do not use commands from an older guide to
copy Codex credentials into a sidecar.

## Supported setup path

Start the local wizard on the computer that will manage the installation:

```bash
npx --yes --ignore-scripts relmio@latest
```

The foreground wizard opens on `127.0.0.1` without requiring an existing
`.relmio` directory or local n8n stack. Choose **ChatGPT on my server**, then
sign in using the system browser. Relmio creates a protected SIWC registration
for the verified identity. It does not import a personal Codex login.

Identity sign-in and ChatGPT plan use are separate. If the grant is missing,
choose **Allow ChatGPT plan use** and complete the separate ChatGPT consent.
Confirm the first-use notice before making model requests. A listed model or
connected account does not prove model entitlement or successful inference.

## Install for n8n

Choose a running n8n container and one of its existing Docker networks. Review
the exact target and explicitly approve both the installation and the selected
account's background workflow use.

For a local Docker installation, Relmio creates a separate sidecar on the
selected network. For VPS, it confirms the SSH fingerprint before
authentication and requires a separate final confirmation before remote
writes. The destination receives its own host ID, and the selected registration
is frozen during transfer. It becomes the only refresh owner after the
installer verifies the destination receipt. If the outcome is uncertain, the
registration stays frozen until you inspect the destination.

The sidecar publishes no host port and does not edit n8n's Compose file,
credentials, container, image, or lifecycle. After successful installation,
copy the private Base URL and one-time Relmio bearer from the result screen
into n8n manually:

```text
Base URL: http://n8n-openai-oauth:10531/v1
API key: <one-time Relmio bearer shown by the wizard>
Use Responses API: On
```

The bearer authorizes the local sidecar; it is not an OpenAI API key or
provider token. Keep it in n8n's credential store and share it only with trusted
callers on that Docker network.

## Install for a local Codex client

The Codex App Server option preserves the WebSocket client protocol through a
local `ws` relay to the official Codex App Server's stdio interface. The
selected SIWC access token is supplied to the child as `ACCESS_TOKEN`; no
separate Codex device-code login is used. Its one-time local bearer authorizes
the endpoint. Treat this raw App Server target as high trust and use it only
from a trusted native client owned by the same account holder.

The Codex Chat Adapter is separate and narrower. It accepts a read-only
conversational turn from a trusted local backend, not a browser or a general
OpenAI `/v1` client. See [Local Docker endpoints](local-endpoints.md) for
interfaces and token-expiry recovery.

## Provider and VM limits

The local gateway discovers models for the selected account and sends supported
requests to the public Responses API. It rejects unsupported parameters,
routes, and capabilities rather than silently dropping them; only
output-token caps, which SIWC doesn't accept, are dropped. Audio, video,
Files API management, moderation, stored responses or conversations, and
other documented-unavailable features are not enabled. Image generation needs
the opt-in VPS add-on in
[VPS and n8n](vps-and-n8n.md#turn-on-image-generation-optional), which uses
a separate Codex sign-in. There is no account rotation or Platform API
billing fallback.

The website's `/api/chat` remains disabled with `410 Gone`. Local and
self-hosted installation does not enable hosted website inference. OpenAI's VM
guide and SIWC Terms leave persistent remote VM token storage unresolved; this
guide makes no provider approval claim for VPS use. See the
[2026-10-05 OpenAI source check](openai-source-check-2026-10-05.md).

## Recovery

- If identity is connected but plan use is unavailable, request the separate
  plan grant from the wizard. Do not retry inference until the grant is shown.
- If the wizard reports a plan usage limit, open
  [Manage usage](https://chatgpt.com/settings/usage). Do not rotate accounts or
  switch to a different billing path.
- If transfer is unresolved, leave the source frozen and inspect the exact
  destination before retrying. Do not restore a source token backup or enable
  both installations.
- If sign-out says provider revocation was not confirmed, local tokens were
  cleared. Disconnect Relmio in ChatGPT settings; local cleanup alone does not
  prove remote revocation.
- Preserve the SSH host fingerprint check and final write confirmation. Do not
  publish port `10531` or edit/restart n8n as a recovery step.

For verified commands, current API limits, and additional symptoms, see
[VPS and n8n](vps-and-n8n.md), [Configure n8n nodes](n8n-configuration.md),
and [Troubleshooting](troubleshooting.md).
