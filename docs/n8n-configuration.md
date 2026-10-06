# Configure n8n for ChatGPT plan use

Use this guide for the current local/SIWC OpenAI-compatible sidecar. It does not
cover an OpenAI Platform API-key connection or the separate Codex App Server
relay.

## Before setup

1. Open the local Relmio wizard and select **ChatGPT for n8n**.
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
| `GET /v1/models` | Returns the selected account's public model catalog (`visibility == "list"`) in provider order, with model slugs and display names. Relmio sends its pinned Codex version (0.160.0) as OpenAI's undocumented `client_version` parameter, which filters the catalog; OpenAI could change this. While the VPS image add-on is on, the list also includes `gpt-image-2`. |
| `POST /v1/responses` | Sends supported Responses requests to OpenAI. Relmio sets `store:false` and requests streaming; only a completed response counts as success. Streamed events, including `phase`, pass through unchanged. |
| `POST /v1/chat/completions` | Compatibility route translated into a Responses request. It accepts `model`, `messages`, `tools`, `tool_choice` (`auto`, `none`, or `required`), `parallel_tool_calls`, `stream`, and `stream_options.include_usage`. Messages are text `user`, `assistant`, or `developer` messages, assistant tool calls, and `tool` results. Only final-answer text is returned. |
| `POST /v1/images/generations` and `POST /v1/images/edits` | VPS image add-on only. See [Generate and edit images](#generate-and-edit-images-vps-add-on). Without it, these return `404 images_off`. |

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

## Function tools

Function tools, such as the ones an n8n agent sends, can use either route. In
a Responses request, flat function and custom tools are moved into one
developer `additional_tools` input item. The Chat Completions route builds the
same item from its `tools` list. A function tool that omits `parameters` or
`strict` is sent with `null` for that field. The gateway never runs a tool:
n8n executes it and sends the result back in the next request with the
matching call ID.

Limits:

- At most 32 tools in one list, and at most 32 tool calls in one Chat
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

## Generate and edit images (VPS add-on)

Image generation works only after you turn on the optional image add-on for an
installed VPS sidecar. It uses a separate Codex sign-in, the way Hermes Agent
does. OpenAI does not document this route for other apps, so it can stop
working without notice. Images count against your plan's Codex limits, and
the Codex refresh token is stored on the VPS. The ChatGPT plan session is
never used for images. A local sidecar has no image sign-in. See
[Turn on image generation](vps-and-n8n.md#turn-on-image-generation-optional)
for setup and sign-out.

In n8n:

1. Add an **OpenAI** node, choose **Image**, then **Generate an Image** or
   **Edit Image**.
2. Use the same OpenAI credential as your chat nodes: Base URL
   `http://n8n-openai-oauth:10531/v1` and the one-time Relmio key.
3. For **Model**, choose **ID** and enter `gpt-image-2`. n8n's defaults
   (`gpt-image-1-mini` for Generate, `gpt-image-1` for Edit) are refused.
   Entering an ID needs OpenAI node version 2.2 or newer for Generate and 2.3
   or newer for Edit.
4. For Edit Image, add the input images as binary fields. Leave the number of
   images at 1 and do not add the **Image Mask** option.

The result arrives as base64 and n8n saves it as binary data.

Limits:

- Only `gpt-image-2`, one image per request, and prompts up to 32,000
  characters.
- No masks and no URL responses (`response_format` may only be `b64_json`).
- Sizes `1024x1024`, `1024x1536`, `1536x1024` or `auto`. `256x256` and
  `512x512` are refused.
- Quality `low`, `medium`, `high` or `auto` (`standard` is sent as `auto`);
  background `transparent`, `opaque` or `auto`.
- Edits take 1 to 16 PNG, JPEG, WebP or GIF images, each up to 25 MiB, and at
  most 48 MiB per request. A generation request body is limited to 64 KiB.
- `user`, `output_format`, `output_compression` and `input_fidelity` are
  accepted but not sent to Codex. Other fields are refused.
- Relmio waits up to 5 minutes for an image and does not retry a failed one.
  A usage limit returns `429` with the code from OpenAI and, when OpenAI sends
  it, `resets_at`.

## Limits and recovery

The gateway rejects fields and tool types it cannot preserve, `background:true`,
`store:true`, stored response/conversation IDs, system messages, audio/video
input, and invalid input shapes. The Responses `image_generation` tool is
one of the rejected tool types. Audio, video, Files API upload/list/delete,
stored conversation, moderation, Live, and Realtime routes are not forwarded.
Image routes work only through the
[VPS image add-on](#generate-and-edit-images-vps-add-on). Image or
file content inside a Responses input is usable only when the selected model
supports it; this does not enable the Files API. Tool availability depends on
the selected model and account policy and is not guaranteed by catalog
discovery.

The gateway reports unsupported parameters instead of silently dropping them.
It does not switch registrations, replay a partially received inference, or
fall back to separately billed API access. A usage-limit error on the text
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
receives the Relmio bearer, not that provider token. The VPS image add-on keeps
its Codex tokens in the same protected folder, and n8n never receives them
either. The sidecar has no host port, and the wizard leaves n8n configuration
to its owner.

Using `store:false` is not a zero-logging or zero-retention promise. Docker,
SSH/VPS, n8n, OpenAI, and other infrastructure may have their own logs and
retention. See [Security and limits](security.md) and the
[2026-10-05 OpenAI source check](openai-source-check-2026-10-05.md).

The [2026-09-08 capability audit](experimental-images25-live1.md) records
historical behavior and tests for the previous credential-copy bridge. It does
not describe or establish capabilities of the current SIWC implementation.
