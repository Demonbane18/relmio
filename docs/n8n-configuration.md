# Configure n8n for ChatGPT plan use

How n8n uses Relmio's ChatGPT plan sidecar: request routes, models, tools, the
AI Assistant, image generation, and the limits of each.

This guide does not cover an OpenAI Platform API-key connection or the separate
Codex App Server relay.

## Before setup

1. Open the Relmio wizard and select **n8n with ChatGPT sign-in**.
2. Create a fresh Relmio sign-in or select one of your saved registrations.
   Personal Codex credentials are not imported, and matching email addresses do
   not merge registrations.
3. Complete the separate ChatGPT authorization for plan use. An identity-only
   connection does not authorize model requests.
4. Select the existing n8n container and one of its Docker networks. Review the
   exact plan and separately approve background workflow use before install.
5. Copy the one-time Relmio bearer from the result screen and enter it manually
   in n8n. Relmio does not edit n8n's credential or Compose configuration.

The sidecar publishes no host port. From n8n, use its private Docker hostname:

```text
http://n8n-openai-oauth:10531/v1
```

In the n8n OpenAI credential, enter the one-time Relmio bearer shown by the
wizard in the API key field. It authorizes the sidecar, not OpenAI. On OpenAI
Chat Model node version 1.3, turn **Use Responses API** on. The wizard's model
catalog belongs to the selected account; a listed model is not proof of
entitlement or host admission.

## Supported request paths

| Route | Behavior |
| --- | --- |
| `GET /v1/models` | Returns the selected account's text models in OpenAI's order, with IDs and display names. See [Model discovery and checks](#model-discovery-and-checks). While the image add-on is on, requests without n8n's `openai-platform` header also get `gpt-image-2`. |
| `POST /v1/responses` | Sends supported Responses requests to OpenAI. Relmio sets `store:false`, even when the client asks for `store:true` as n8n's OpenAI node does by default, requests streaming and, when the request sets `reasoning`, asks for `reasoning.encrypted_content`; only a completed response counts as success. It drops `max_output_tokens` and fills in `item_reference` items from memory; see [AI Assistant requests](#ai-assistant-requests). Streamed events, including `phase`, pass through unchanged, except failure events, which carry a safe error. |
| `POST /v1/chat/completions` | Compatibility route translated into a Responses request. It accepts `model`, `messages`, `tools`, `tool_choice` (`auto`, `none`, or `required`), `parallel_tool_calls`, `stream`, `stream_options.include_usage`, and `reasoning_effort`, which is sent as `reasoning.effort`. It drops `max_completion_tokens` and `max_tokens`. Messages are text `user`, `assistant`, or `developer` messages, assistant tool calls, and `tool` results. Only final-answer text is returned. |
| `POST /v1/images/generations` and `POST /v1/images/edits` | Image add-on only, on a VPS or on this computer. See [Generate and edit images](#generate-and-edit-images). Without it, these return `404 images_off`. |

For a basic OpenAI Chat Model workflow, select a catalog model and begin with
a simple text prompt. A Responses request uses the full input array; send
history in the request instead of a stored response/conversation ID.

A simple HTTP Request node can call the private Responses route. Keep the bearer
in an n8n credential, not in a URL, browser bundle, workflow text, or command
argument:

```text
Method: POST
URL: http://n8n-openai-oauth:10531/v1/responses
Authorization: Bearer <one-time Relmio bearer from the wizard>
Content-Type: application/json
```

Example body:

```json
{
  "model": "<slug from the selected account's catalog>",
  "input": [{"role": "user", "content": "Reply with exactly: bridge works"}]
}
```

## Model discovery and checks

The sidecar reads the selected account's catalog from
`https://api.openai.com/v1/models`. OpenAI filters that catalog by an
undocumented `client_version` parameter, and OpenAI could change this. On the
owner's account on 2026-10-06, version 0.150.0 listed 3 models, 0.160.0 and
newer listed 7, and no version listed 4. The sidecar therefore asks as the
newest stable Codex release:

- It reads `https://registry.npmjs.org/@openai/codex/latest` when it next
  fetches the catalog for n8n or for turning checks on, about every 12 hours.
  Failed attempts count too. The wizard's status check never contacts npm; it
  uses the last version the sidecar read, or the pin. The request carries no
  credentials or account data. npm sees the sidecar host's IP address.
- It never asks as a version below Relmio's pin (0.160.0) and ignores
  prerelease versions. If npm can't be reached, it keeps the last version it
  read, or the pin.

Local Codex clients and the wizard's account picker before install keep the
pinned version.

The list keeps models OpenAI marks for display and API use, leaves out IDs
that contain `image`, keeps OpenAI's order and stops at 256 models. The sidecar
caches the catalog for 5 minutes, so the sidecar may take that long to see a
change. A new model can take longer to reach n8n: it may need the next npm
version check, a model check, or an admin's Chat Hub setting. n8n's server
does not cache the list; **Refresh List** in a dropdown asks the sidecar
again. n8n shows only model IDs, not display names.

When OpenAI rejects a request through the sidecar because of the model (HTTP
400 or 404 with error parameter `model`, or code `model_not_found` or
`invalid_model`), the sidecar hides that model from n8n for 24 hours. A request
that completes marks the model as working. If the catalog can't be read, the
sidecar serves its last list for up to an hour. After that, or when OpenAI
rejects the sign-in, n8n gets `catalog_unavailable`. See
[Troubleshooting](troubleshooting.md#symptom-table).

A listed or working model is not an entitlement promise. A completed test or
request proves only that request.

### Optional model checks

Model checks are off by default and are turned on per VPS install from the
wizard. See [See models and turn on model checks](vps-and-n8n.md#see-models-and-turn-on-model-checks).
The wizard shows this notice before you confirm:

> When on, the sidecar sends one short test request ('Reply with OK') to
> models in your catalog: now for up to 12 of them, then for each new model,
> and again once a day for a model that failed. A test that gets no answer is
> tried again after an hour. n8n lists a model only after it answers; until any
> model has answered, n8n shows the full catalog except models that recently
> failed. Each test uses a small amount of your plan.

How the checks run:

- A test is a Responses request with the instruction `Reply with OK.`, the
  input `OK`, `store:false`, and the lowest reasoning effort the catalog lists
  for that model. Tests run one model at a time.
- Turning checks on tests up to 12 models within about 3 minutes and records
  your consent with the time and notice version.
- After that, when n8n asks for models and some are untested, or failed more
  than a day ago, the sidecar tests up to 8 of them in the background, 5
  seconds apart. n8n gets its list without waiting.
- A run stops when the plan's usage is unavailable, ChatGPT sign-in is needed,
  the ChatGPT session isn't available for plan use, OpenAI refuses the test
  request, or checks were turned off. Timeouts, network errors and server
  errors record nothing, so those models are tested again later. After a run
  that stopped early or left a model unrecorded, the next background run waits
  60 minutes.
- A failed test hides the model while checks are on, for 24 hours. A failure
  in a real request hides it with checks on or off.
- Turning checks off makes no network call and removes your consent. A
  running check stops before its next test, even while it waits for the
  session. Recorded results stay. **Sign out and revoke** turns checks off
  first, as a best effort.

Local sidecars have no check controls, so checks stay off there. They still
hide models that fail with a model error and mark completed ones as working.

### Which n8n pickers list which models

| n8n picker | What it lists |
| --- | --- |
| OpenAI Chat Model node 1.2 or newer, **From list** | Text models. The node sends an `openai-platform` header, so the sidecar leaves out `gpt-image-2`. |
| Chat Hub, OpenAI provider | The Chat Model node's list. If an admin set allowed models under **Settings > Chat**, new models stay hidden until added there. |
| OpenAI node, **Message a Model** | Text models, plus `gpt-image-2` while images are on. This picker shares one request with the image picker. Don't choose `gpt-image-2` for text. |
| OpenAI node, **Generate an Image** or **Edit Image** | n8n keeps only IDs that contain `gpt-image` or `dall-e`, so it lists `gpt-image-2` while images are on. |
| AI Assistant | Nothing. It never asks for the list; paste a model ID instead. See [AI Assistant](ai-assistant.md#optional-chatgpt-plan-sidecar). |

The sidecar tells these requests apart by the `openai-platform` header. If n8n
changes that header, `gpt-image-2` may show in chat lists again or leave the
image picker. Entering the ID still works.

## Function tools

Function tools, such as the ones an n8n agent sends, can use either route. In
a Responses request, flat function and custom tools are moved into one
developer `additional_tools` input item. The Chat Completions route builds the
same item from its `tools` list. A function tool that omits `parameters` or
`strict` is sent with `null` for that field. The gateway never runs a tool:
n8n executes it and sends the result back in the next request with the
matching call ID.

Limits:

- At most 128 tools in one list, and at most 32 tool calls in one Chat
  Completions message or response.
- At most 128 KiB of arguments for one call.
- At most 2 MiB of streamed tool-call arguments in one Chat Completions
  response.
- Every Chat Completions assistant tool call needs exactly one `tool` result.

The Chat Completions route rejects a named `tool_choice`, tool namespaces,
custom tools in streamed requests, and system messages. Responses requests
can use namespaces and `additional_tools` items directly. On the Chat
Completions route, reasoning items and `commentary` text are skipped; clients
receive only message text with phase `final_answer` or no phase.

On 2026-10-05 a two-turn LangChain function-tool test passed through the real
gateway on one ChatGPT account, streaming over both Chat Completions and
Responses. Other accounts, models, and non-streaming tool calls were not
tested live. The SIWC guide names `additional_tools`, but only the general
Responses reference documents its shape.

## AI Assistant requests

n8n's AI Assistant reaches the sidecar's Responses route through the AI SDK.
Setup and a 2026-10-07 live test are in
[AI Assistant](ai-assistant.md#optional-chatgpt-plan-sidecar). The rules below
come from the requests n8n 2.40.7 sends and apply to every client. The sidecar
adds no logs, so the live test doesn't show whether earlier items were filled
in from memory.

Output-token caps are dropped. n8n's model check sends `max_output_tokens: 16`.
SIWC lists `max_output_tokens` as unsupported
([source check](openai-source-check-2026-10-05.md#check-3-model-and-inference-capability-no-tts)),
so no cap can be honored: the sidecar removes the field and the reply is not
capped. The Chat Completions route drops `max_completion_tokens` and
`max_tokens` the same way. Other unsupported fields are still refused.

Earlier output is filled in from memory. In tool steps and follow-up
messages, the AI SDK sends an `item_reference` that holds only an item ID in
place of earlier reasoning and assistant text. A Responses request that sets
`reasoning`, as the Assistant's do, asks OpenAI for
`reasoning.encrypted_content`, added to any valid `include` values the client
sent; other requests keep the client's `include` as is. When a request reaches
`response.completed`, the sidecar
keeps its reasoning items (encrypted content and summary) and assistant
messages (text and a valid `phase`). A later reference to a kept ID is
replaced with a copy of that item before the request goes to OpenAI.
References to unknown IDs are dropped. A reference without a valid ID, or a
request left with no input, is refused with `param: input`. The copies in one
request can total at most 2 MiB; more returns `413 body_too_large`.

The memory belongs to one sidecar process and is never written to disk. It
holds at most 4,096 items and 32 MiB. An item expires 6 hours after it is
kept, and when the memory is full the least recently used item goes first.
Items from failed, incomplete or interrupted responses are not kept, and Chat
Completions requests neither fill nor use the memory. A restart or update
empties it. References from an open Assistant conversation are then dropped,
and the model no longer sees that earlier reasoning and those replies; start a
new conversation. Data handling is in
[Security](security.md#remembered-responses-items).

Stream failures use OpenAI's event format. On `/v1/responses`, an error the
sidecar adds to a stream, such as `stream_interrupted`, is an `error` event
with `type`, `sequence_number`, `code`, `message` and `param`. Rewritten
`response.failed` and `response.incomplete` events keep their
`sequence_number`. AI SDK clients then see the error, or the reason a response
was incomplete, instead of a type-validation error or an empty answer. The
Chat Completions route keeps its own error body.

A request can list up to 128 tools; see [Function tools](#function-tools). The
Assistant sends its own tools plus any from connected MCP servers.

## Generate and edit images

Image generation works only after you turn on the optional image add-on for
an installed sidecar, on a VPS or on this computer. It uses a separate Codex
sign-in, the way Hermes Agent does. OpenAI does not document this route for
other apps, so it can stop working without notice. Images use your plan's
Codex limits 3 to 5 times faster than text, then credits, and Free plans can't
use them. The Codex refresh token is stored on the VPS, or for a local sidecar
in its Docker volume on this computer. The ChatGPT plan session is never used
for images. For setup and sign-out, see
[Turn on image generation on a VPS](vps-and-n8n.md#turn-on-image-generation-optional)
or [on this computer](local-endpoints.md#turn-on-image-generation-optional).

In n8n:

1. Add an **OpenAI** node, choose **Image**, then **Generate an Image** or
   **Edit Image**.
2. Use the same OpenAI credential as your chat nodes: Base URL
   `http://n8n-openai-oauth:10531/v1` and the one-time Relmio key.
3. For **Model**, pick `gpt-image-2` from the list, or choose **ID** and enter
   it. The list shows it only while images are on. n8n's defaults
   (`gpt-image-1-mini` for Generate, `gpt-image-1` for Edit) are refused. Both
   need OpenAI node version 2.2 or newer for Generate and 2.3 or newer for
   Edit.
4. For Edit Image, add the input images as binary fields. Leave the number of
   images at 1 and do not add the **Image Mask** option.

The result arrives as base64 and n8n saves it as binary data.

Limits:

- Only `gpt-image-2`, one image per request, and prompts up to 32,000
  characters.
- No masks and no URL responses (`response_format` may only be `b64_json`).
- Sizes `1024x1024`, `1024x1536`, `1536x1024` or `auto`. `256x256` and
  `512x512` are refused. OpenAI may return a different size than requested.
- Quality `low`, `medium`, `high` or `auto` (`standard` is sent as `auto`);
  background `transparent`, `opaque` or `auto`.
- Edits take 1 to 16 PNG, JPEG, WebP or GIF images, each up to 25 MiB, and at
  most 48 MiB per request. A generation request body is limited to 64 KiB.
- `user`, `output_format`, `output_compression` and `input_fidelity` are
  accepted but not sent to Codex. Other fields are refused.
- Relmio waits up to 5 minutes for an image and does not retry a failed one.
  A usage limit returns `429` with the code from OpenAI and, when OpenAI sends
  it, `resets_at`.

Only `gpt-image-2` is offered. On 2026-10-06 Relmio sent three test images
through this Codex route on the owner's VPS, as `gpt-image-2`,
`gpt-image-2.5-flare` and a made-up model ID. All three returned the same
result: 515 image tokens, 1254x1254 pixels and the same C2PA provenance. The
route ignores the model ID, so asking it for Flare or Sunburst would not get
them. To use GPT Image 2.5 Flare or Sunburst, give n8n's image node a separate
OpenAI credential with your own OpenAI Platform API key and OpenAI's default
Base URL. OpenAI bills that to your API account, and Relmio is not involved.
See the
[2026-10-06 source check](openai-source-check-2026-10-06.md#addendum-automatic-model-discovery).

## Limits and recovery

The gateway rejects fields and tool types it cannot preserve, `background:true`,
a `store` value that is not `true` or `false`, stored response/conversation
IDs, system messages, audio/video
input, and invalid input shapes. The Responses `image_generation` tool is
one of the rejected tool types. Audio, video, Files API upload/list/delete,
stored conversation, moderation, Live, and Realtime routes are not forwarded.
Image routes work only through the
[image add-on](#generate-and-edit-images). Image or
file content inside a Responses input is usable only when the selected model
supports it; this does not enable the Files API. Tool availability depends on
the selected model and account policy and is not guaranteed by catalog
discovery.

The gateway reports unsupported parameters instead of silently dropping them.
Output-token caps are the exception; see
[AI Assistant requests](#ai-assistant-requests). `store:true` is also accepted
and sent as `store:false`, so the gateway never asks OpenAI to keep a
retrievable Responses object, and a later request that names a stored response
(`previous_response_id`) is still refused. The gateway does not switch
registrations, replay a partially received inference, or fall back to
separately billed API access. A usage-limit error on the text
routes directs you to [Manage usage](https://chatgpt.com/settings/usage).
Other request, permission, connection, and provider failures require the
recovery shown by the wizard.

A successful identity sign-in, installed container, health response, or model
list is not proof that a model request will be admitted or complete. ChatGPT
account eligibility, workspace policy, provider admission, and current limits
still apply. Audio, video, Files management, and other unsupported
capabilities are not enabled by refreshing the sign-in, and the ChatGPT
sign-in never turns on image generation.

## Safety and data handling

The bearer shown by Relmio protects the local sidecar boundary. Store it as an
n8n credential and share it only with trusted callers on the selected Docker
network. The provider token remains in the sidecar's protected SIWC record; n8n
receives the Relmio bearer, not that provider token. The image add-on keeps
its Codex tokens in the same protected store (on a VPS, its `siwc` folder; on
this computer, the sidecar's Docker volume), and n8n never receives them
either. The sidecar has no host port, and the wizard leaves n8n configuration
to its owner.

Using `store:false` is not a zero-logging or zero-retention promise. Docker,
SSH/VPS, n8n, OpenAI, and other infrastructure may have their own logs and
retention. See [Security and limits](security.md) and the
[2026-10-05 OpenAI source check](openai-source-check-2026-10-05.md).

The [2026-09-08 capability audit](experimental-images25-live1.md) records
historical behavior and tests for the previous credential-copy bridge. It does
not describe or establish capabilities of the current SIWC implementation.
