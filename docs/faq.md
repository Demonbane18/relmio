# Frequently asked questions

Answers about ChatGPT sign-in and plan use, usage limits, image generation,
local connections, SuperGrok, and private models. Read the
[OpenAI source check](openai-source-check-2026-10-05.md)
for implementation evidence and unresolved provider requirements.

## Is ChatGPT sign-in a Platform API key?

No. Relmio's local flow uses a separately authorized ChatGPT plan grant. It
neither creates nor converts an OpenAI Platform API key. The one-time bearer
shown for n8n authorizes that private Relmio sidecar; it is not an OpenAI key.
Platform API billing is not an automatic fallback.

## Why can an account be connected without model access?

Identity sign-in and permission to use a ChatGPT plan are separate. If the
provider returns verified identity without `chatgpt.tokens.use.direct`, Relmio
keeps the account connected but does not allow plan requests. Choose **Allow
ChatGPT plan use** to make a separate authorization request. Enabling the
Relmio setting cannot grant provider permission.

Each registration is bound to a verified issuer, client ID, and subject.
Email is only a label, so separate registrations remain separate even when
emails match. Relmio never imports a personal Codex login or switches accounts
after an error.

## What happens on first use and usage limits?

After plan permission is enabled, confirm the first-use **Using ChatGPT plan**
notice before requesting models. Model listings are account-specific and do not
prove admission or that a request will complete. ChatGPT account eligibility,
workspace policy, model availability, and usage limits still apply.

A plan usage-limit error directs you to **Manage usage** at
<https://chatgpt.com/settings/usage>. Other errors show their own recovery.
Relmio does not retry through another account or switch to Platform API billing.

**Plan and usage** in the wizard counts only the requests sent through the
Relmio sidecar in the last 30 days. It shows no plan percent, reset time or
credits. Those stay on ChatGPT's Usage page, which **Manage usage** opens.

## What can the OpenAI-compatible sidecar do?

The sidecar exposes `GET /v1/models` and `POST /v1/responses` behind a local
Relmio bearer. It also translates `POST /v1/chat/completions` requests into a
real Responses request. That route accepts text messages from `user`,
`assistant`, or `developer` roles, plus function tools, assistant tool calls,
and tool results. Function tools go upstream in one `additional_tools` item;
n8n runs the tools, not the gateway. Limits are 32 tool calls, 128 KiB of
arguments per call, and 2 MiB of streamed arguments in total. The route
rejects a named `tool_choice`, tool namespaces, custom tools in streamed
requests, system messages, and other fields it cannot preserve, but drops
output-token caps (`max_completion_tokens`, `max_tokens`). Chat clients
get only final-answer text. On 2026-10-05 a two-turn LangChain tool test
passed through the real gateway on one ChatGPT account, streaming over both
routes. That is not a guarantee for other accounts or models.

Audio, video, Files API routes, stored responses/conversations, moderation,
and unsupported Responses parameters are not implemented. Audio input and
transcription are unsupported. Image generation and editing are an opt-in
add-on, on a VPS or on this computer, with a separate Codex sign-in that
OpenAI does not document for other apps; see
[Can n8n generate images through Relmio?](#can-n8n-generate-images-through-relmio).

The n8n sidecar asks for text models as the newest stable Codex release from
npm, checked about every 12 hours and never below Relmio's pin (0.160.0).
`registry.npmjs.org` sees the server's IP address and receives no credentials.
The catalog cache lasts 5 minutes. OpenAI's `client_version` filter is
undocumented and could change; local Codex clients and the pre-install picker
still use the pin. Optional VPS model checks use small requests from your plan
and need confirmation. See [model discovery and checks](n8n-configuration.md#model-discovery-and-checks).

A model listing is not an entitlement promise. The gateway reports unsupported
operations and provider errors; it has no alternative provider or account
fallback.

## Can n8n generate images through Relmio?

Yes, after you turn on the image add-on for an installed ChatGPT plan sidecar,
on a VPS or on this computer. It uses a separate Codex sign-in that OpenAI does
not document for other apps, so it can stop working without notice. In n8n,
use the OpenAI node's **Generate an Image** or **Edit Image** with the same
credential as your chat nodes and the model `gpt-image-2`.

Limits:

- Images use your plan's Codex limits 3 to 5 times faster than text, then
  credits. Free plans can't use them. Your Codex limits are at
  `chatgpt.com/codex/settings/usage`.
- The Codex sign-in is stored on the VPS, or for a local sidecar in its Docker
  volume on this computer. Anyone who can run workflows in that n8n can make
  images with the account.
- Only `gpt-image-2`, one image per request, returned as base64. Masks and URL
  responses are not supported. For GPT Image 2.5 Flare or Sunburst, use your
  own OpenAI Platform API key in a separate n8n credential.
- Sizes `1024x1024`, `1024x1536`, `1536x1024` or `auto`. OpenAI may return a
  different size.
- Edits take up to 16 images, each up to 25 MiB and 48 MiB in total.
- Relmio waits up to 5 minutes for an image and does not retry a failed one.

Setup and sign-out are in
[Turn on image generation on a VPS](vps-and-n8n.md#turn-on-image-generation-optional)
and [on this computer](local-endpoints.md#turn-on-image-generation-optional).
Every limit is in
[Generate and edit images](n8n-configuration.md#generate-and-edit-images).

## How do I connect n8n?

Select the ChatGPT plan sidecar, choose the account, grant plan use, and review
the installation. n8n must already be running on a selected Docker network.
The wizard displays a private base URL and one-time Relmio bearer. Enter both
manually in n8n. Keep **Use Responses API** on for OpenAI Chat Model node 1.3.
The sidecar publishes no host port and does not edit n8n credentials or Compose
files. Installing for n8n requires separate explicit consent for background
workflows.

The new local/VPS runtime owns the SIWC registration after a receipt confirms
transfer. Legacy credential-copy installations are not silently adopted: the
separate migration requires a fresh SIWC sign-in and final consent, stops only
the exact old Relmio service, and keeps its credential/workspace volumes
offline. Old tokens are never imported. If migration is uncertain, it stays
stopped for inspection; Relmio does not automatically restart the old service
or delete the preserved data.

If an install stops partway, the wizard shows it as staged and offers a
reviewed resume. If the destination accepted the session but the
acknowledgment was lost, a reviewed reconcile finishes the handoff from the
destination's receipt. Without a receipt the sender stays frozen and needs a
fresh sign-in.

## Can I use this local flow for the public website?

No. The website's `/api/chat` returns `410 Gone`; plan-funded website chat
remains off pending separate hosted-access work. This fact applies to that
hosted route, not the documented local open-source flow. Local use needs no
commercial approval, partner-issued client ID, or client secret; it follows the
documented SIWC registration and separate plan-consent flow. This documentation
change does not implement hosted chat. See the
[source check](openai-source-check-2026-10-05.md).

## Is a VPS transfer approved by OpenAI?

This documentation does not claim that. Relmio gives the destination its own
host ID, freezes the source before transfer, and clears source tokens only after
a matching destination receipt. An uncertain transfer stays frozen, and the
destination is the only refresh owner after completion. When that sign-in
needs renewing, Relmio makes a new registration for the same account and
replaces the old one. OpenAI's guides instead repeat the sign-in with the saved
client ID and the VM's own host ID. OpenAI's self-hosted VM
guide describes transfers, while SIWC Terms also say persistent tokens must be
local and user-controlled. The published wording does not resolve that tension.

The SIWC Terms also limit use to the connected application and say not to
provide general-purpose API access for other tools. Whether an
OpenAI-compatible endpoint for n8n fits that rule needs an answer from OpenAI.
Relmio is not listed in OpenAI's partner directory, and the published sources
do not define whether it counts as a supported open-source tool.

The wizard verifies the SSH fingerprint before authentication and asks for a
separate final confirmation before remote writes. Relmio does not edit, restart,
rebuild, recreate, or stop your existing n8n deployment.

## What does sign-out do?

Relmio attempts to revoke the refresh token, clears local access, refresh, and
ID tokens, and retains the registration label and identity mapping. A
refresh-uncertain session remains unconfirmed even if OpenAI returns HTTP 200,
because the token family may have rotated beyond the known record. Otherwise,
the result says whether remote revocation was confirmed. If unconfirmed,
disconnect Relmio in ChatGPT settings. Local cleanup does not prove provider
revocation or deletion of provider-side data.

## Can I use SuperGrok or a local model?

The experimental SuperGrok adapter keeps its official xAI/Grok session separate
from ChatGPT. It uses Chat Completions, a separate local Relmio bearer, and no
xAI API key. n8n uses **Use Responses API** off for that connection. Authentication
and quota errors do not select another account or fall back to API billing.

Relmio can also run one CPU-based Ollama model beside existing self-hosted n8n.
The model API has no authentication and is reachable by containers on the
selected private Docker network, so trust those peers. Image and model downloads
need internet access. This workflow Chat Model is separate from n8n AI
Assistant sandbox setup and does not establish reliable tool calling. See
[Private local models](local-models.md).
