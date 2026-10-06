# Local ChatGPT plan-use walkthrough outline

Use this outline for a local/self-hosted n8n demonstration of Relmio's
open-source Sign in with ChatGPT (SIWC) flow. It is not a claim of live
provider acceptance, legal advice, or a guarantee of model availability. Do not
record VPS token transfer in this walkthrough; the published VM guide and SIWC
Terms leave persistent remote token storage unresolved.

## Suggested title

> Relmio: connect local n8n to ChatGPT plan use with documented SIWC

Do not promise an OpenAI Platform API key, unlimited usage, guaranteed credits,
or approval for a hosted/VPS service. The local OSS flow requires no commercial
approval, partner-issued client ID, or client secret; the user still separately
grants ChatGPT plan use.

## Seven-minute structure

### 0:00 — Show the boundaries

- Relmio runs locally and keeps the SIWC registration in protected storage.
- The website's `/api/chat` is disabled and returns `410 Gone`; this local flow
  does not enable hosted inference.
- ChatGPT identity, plan permission, account/model eligibility, and successful
  inference are separate checks.

Use the [architecture guide](architecture.md) and current
[OpenAI source check](openai-source-check-2026-10-05.md). Avoid showing an
actual account email, callback URL, authorization code, state, or token.

### 0:40 — Install and sign in

Start the local wizard using the
[README](../README.md)'s current command. Show a fresh SIWC registration in the
system browser without exposing the authorization URL or personal account
information. Explain that Relmio uses its own dynamic client registration and
verified identity; it does not import `~/.codex` or require a partner credential.

Identity alone may connect without `chatgpt.tokens.use.direct`. Show the
separate ChatGPT plan-consent action only in a sanitized demo account, then
confirm the first-use plan notice before model access. **Manage usage** opens
ChatGPT's usage settings. A model listing is not proof of entitlement or host
admission.

### 2:40 — Review the n8n sidecar plan

Select an existing local n8n container and a Docker network it already uses.
Read the exact target, network, no-host-port boundary, and installation plan.
Separately consent to n8n background workflow use and confirm the reviewed
install. Relmio leaves n8n's credentials, Compose file, image, and lifecycle
unchanged.

### 3:40 — Configure n8n

Enter the wizard's one-time Relmio bearer manually in the n8n OpenAI
credential's API-key field. It is not an OpenAI API key or ChatGPT token. Use
the private network URL:

```text
Base URL: http://n8n-openai-oauth:10531/v1
Authentication: the one-time Relmio bearer shown by the wizard
```

Keep **Use Responses API** on for OpenAI Chat Model node version 1.3. Verify a
single safe text prompt first. Do not show or leave the one-time bearer visible
in the recording.

### 5:15 — Explain what works and what does not

- The sidecar exposes `/v1/models` and `/v1/responses`, plus a Chat
  Completions compatibility route that carries function tools through
  `additional_tools` (32 tool calls, 128 KiB per call, 2 MiB streamed in
  total). n8n runs the tools. A two-turn tool test passed live on one ChatGPT
  account on 2026-10-05 (streaming, local macOS). Do not present it as
  verified for every account, model, or a VPS install.
- Chat clients receive only final-answer text, not reasoning or commentary.
- Audio, video, Files management, Moderations, stored conversations, and
  unsupported fields/tool types are rejected; output-token caps are dropped.
  Image generation is an opt-in
  VPS add-on with a separate Codex sign-in that OpenAI does not document for
  other apps; do not present it as part of Sign in with ChatGPT.
- Usage limits direct the user to ChatGPT **Manage usage**; errors do not switch
  accounts or fall back to Platform API billing.
- `store:false` is not a zero-retention promise.

Use [Configure n8n](n8n-configuration.md) for the exact request limits.

### 6:15 — Recovery and close

If OpenAI discovery fails before a refresh POST, the current session remains
unchanged and can be retried later. Before any refresh POST, Relmio freezes the
session and disables plan use. A refresh `503` with `temporarily_unavailable`
restores the earlier session for a later retry; this assumes OpenAI did not
rotate the token, which OpenAI does not document. Another refresh error or an
uncertain network outcome must not replay the possibly rotated token; finish
a fresh SIWC sign-in for the same registration. `invalid_grant` clears
unusable tokens. Sign-out from uncertain state remains unconfirmed even if
OpenAI returns HTTP 200. Do not present local cleanup as proof of provider
revocation.

If an install stops partway, show the staged status and the reviewed resume.
If an acknowledgment was lost, show the reviewed reconcile. Use preview
fixtures such as `RELMIO_PREVIEW_FIXTURE=staged` or `handoff-pending` with
`node scripts/preview.js` instead of a real account.

Point viewers to [Troubleshooting](troubleshooting.md),
[Maintenance](maintenance.md), and the current
[source check](openai-source-check-2026-10-05.md).

## Recording safety checklist

- Use a disposable, sanitized local n8n environment and account approved for
  demonstration; no production workflows or personal data.
- Use mock hostnames, account labels, responses, and workflow contents.
- Keep authorization URLs, callback values, account email, provider tokens,
  Relmio bearers, credentials, cookies, SSH secrets, and private keys out of
  screen capture, terminal history, logs, and support channels.
- Do not open or print token files. Do not display QR codes or security prompts.
- Confirm the sidecar has no host-port mapping and n8n remains unchanged.
- State the exact Relmio release used; do not claim runtime scenarios that were
  not exercised for that recording.

## Reference links

- [Relmio README](../README.md)
- [Local endpoints](local-endpoints.md)
- [n8n configuration](n8n-configuration.md)
- [OpenAI SIWC sources and code observations](openai-source-check-2026-10-05.md)
- [OpenAI SIWC documentation](https://developers.openai.com/siwc/token-sharing-open-source)
- [n8n OpenAI credential documentation](https://docs.n8n.io/integrations/builtin/credentials/openai/)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
