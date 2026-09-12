# Configure n8n nodes

Use this page after the wizard says **The private bridge is ready**. Each value
has its own code block for easy copying.

## Pick the provider recipe

The Responses API switch is provider-specific. Check it whenever you change the
credential or Base URL.

| Connection | Base URL | Value for the API-key field | Use Responses API |
| --- | --- | --- | --- |
| OpenAI OAuth with ChatGPT/Codex sign-in | `http://n8n-openai-oauth:10531/v1` | `local-only` placeholder | **On** in OpenAI Chat Model node version 1.3 |
| SuperGrok OAuth | `http://n8n-supergrok:14502/v1` | One-time local Relmio bearer | **Off** for workflow model nodes and Chat Hub |

The numbered recipe below configures the OpenAI OAuth bridge. SuperGrok uses its
own official device sign-in and never requires or reads ChatGPT credentials.

## 1. Create the OpenAI credential

In n8n, create or edit an **OpenAI** credential.

### API Key

```text
local-only
```

This required n8n placeholder is not an OpenAI Platform API key or secret.

### Base URL

```text
http://n8n-openai-oauth:10531/v1
```

### Organization ID

Leave this field empty.

### Add Custom Header

```text
Off
```

Save and test the credential. If n8n cannot reach it, confirm that n8n and the
sidecar share a Docker network and that the Base URL uses the private
`n8n-openai-oauth` hostname rather than `127.0.0.1`.

## 2. OpenAI Chat Model for an AI Agent or Basic LLM Chain

Use the same **OpenAI Chat Model** sub-node for either parent node.

1. Add an **AI Agent** or **Basic LLM Chain** node.
2. Add an **OpenAI Chat Model** to its **Chat Model** or **Model** connector.
3. Select the OpenAI credential created above.
4. In **Model**, select one of the model IDs detected by the wizard.
5. On OpenAI Chat Model node version 1.3, turn **Use Responses API** on.
6. Begin with no built-in tools and a simple test prompt.

If **Use Responses API** is absent, the workflow is using an earlier Chat
Model node version. Keep its default Chat Completions behavior; the bridge also
supports:

```text
/v1/chat/completions
```

Do not copy a model name from the README screenshot. Paste or select one from
the current wizard result:

```text
PASTE_ONE_MODEL_ID_FROM_THE_WIZARD
```

### AI Agent test

For an AI Agent connected to a Chat Trigger, a common prompt expression is:

```text
{{ $json.chatInput }}
```

Or use this fixed prompt for the first connection test:

```text
Reply with exactly: bridge works
```

Connect the OpenAI Chat Model to the AI Agent's model input, run the workflow,
and confirm the response before attaching tools or memory.

### Basic LLM Chain test

Use this fixed **Prompt** first:

```text
Reply with exactly: bridge works
```

For data supplied by an earlier node, a simple expression is:

```text
{{ $json.prompt }}
```

Connect the OpenAI Chat Model to the Basic LLM Chain's model input and execute
the chain.

## 3. OpenAI node V2 capability audit

This is the 2026-09-08 audit of the requested 16 OpenAI action-node operations,
cross-checked against n8n's current [OpenAI node V2 documentation](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.openai/).
It is for Relmio's private, unofficial `openai-oauth@2.0.0` ChatGPT/Codex
compatibility bridge; it is not a statement about OpenAI Platform API-key
capabilities or plan entitlement.

| n8n UI label | Bridge status and constraint | Evidence on 2026-09-08 |
| --- | --- | --- |
| Text > Message a Model | Supported synchronously through `/v1/responses`; streaming, tools, and inline image/file inputs are preserved. Background Mode must be off; Previous Response ID and Conversation ID must be empty. | Pinned-handler tests plus attended VPS execution returning the requested exact text. Streaming and tools are contract-tested, not covered by that live prompt. |
| Text > Classify Text for Violations | Unsupported. `/v1/moderations` now returns 501 with a specific alternative. | Pinned-handler test plus attended VPS unsupported-operation response. |
| Image > Analyze Image | Supported through `/v1/responses` for URL or binary image input. The node's Length of Description setting is ignored because the pinned transport removes `max_output_tokens`. | Request-contract fixture plus attended VPS URL-image description and valid JSON text output. Binary analysis was not separately smoke-tested. |
| Image > Generate an Image | Supported by `/v1/images/generations` with GPT Image 2 base64 output. No URL output, masks, or image streaming. | Pinned-handler fixture plus visually checked VPS output. Local Docker image generation also passed on the older bridge runtime; this does not verify the new local updater. |
| Image > Edit an Image | Supported by `/v1/images/edits` with up to five reference images and no mask. | Pinned-handler multipart fixture plus visually checked VPS edit changing bananas to blue. |
| Audio > Generate Audio | Unsupported. `/v1/audio/speech` returns 501 with a specific alternative. | Earlier user screenshot showed 501; pinned-handler test. Fresh post-update live run not established. |
| Audio > Transcribe a Recording | Unsupported. `/v1/audio/transcriptions` returns 501 with a specific alternative. | Pinned-handler test plus attended VPS audio-unavailable response with a valid WAV binary input. |
| Audio > Translate a Recording | Unsupported. `/v1/audio/translations` returns 501 with a specific alternative. | Pinned-handler test plus attended VPS 501 with a valid WAV binary input. |
| File > Upload a File | Unsupported. `POST /v1/files` returns 501. Inline file input for Message a Model is separate and supported. | Pinned-handler test plus observed VPS 501 using a public JPEG binary. |
| File > List Files | Unsupported. `GET /v1/files` returns 501. | Pinned-handler test plus observed VPS unsupported response. |
| File > Delete a File | Unsupported. `DELETE /v1/files/{id}` returns 501. | Pinned-handler test. Live attempt blocked by n8n File ID validation before the bridge; not a live endpoint pass. |
| Video > Generate a Video | Unsupported. `POST /v1/videos` returns 501 with a specific alternative. | Pinned-handler test. Live form had no selectable model; no video endpoint execution established. |
| Conversation > Create a Conversation | Unsupported. `POST /v1/conversations` returns 501. | Pinned-handler test plus observed VPS unsupported response. |
| Conversation > Get a Conversation | Unsupported. `GET /v1/conversations/{id}` returns 501. | Pinned-handler test plus observed VPS unsupported response using a synthetic ID. |
| Conversation > Update a Conversation | Unsupported. `POST /v1/conversations/{id}` returns 501. | Pinned-handler test plus attended VPS 501 using a synthetic ID and test metadata. |
| Conversation > Remove a Conversation | Unsupported. `DELETE /v1/conversations/{id}` returns 501. | Pinned-handler test plus attended VPS 501 using a synthetic ID. |

The 16 rows above are the action labels in the audited node UI. The separate
OpenAI Chat Model sub-node and HTTP Request recipe can use the supported
`/v1/chat/completions` route; they are documented in sections 2 and 4 rather
than counted as an OpenAI action-node operation.

The local and VPS generators package the same adapter source, and the focused
test verifies both use it as their Docker entrypoint. These behavior changes
take effect only after the owned sidecar is rebuilt through its reviewed update
flow. The table separates repeatable fake-provider contract checks from
authorized browser smoke tests observed in this session. Live results apply
only to the tested account, deployment and options; they do not certify all
node settings, provider entitlement, or the new local updater. Expected
unsupported responses confirm error handling, not feature availability.

In the **OpenAI** action node, choose **Text > Message a Model**, the same
OpenAI credential, and a text model from the account's model list. Both
**Simplify Output** settings work. Keep **Background Mode** off and leave
**Previous Response ID** and **Conversation ID** empty. Send conversation
history as messages on each call. The OAuth transport is stateless and disables
response storage even when n8n sends its default `store: true`.

If an existing bridge returns `Unsupported parameter: background` with Background
Mode off, update the Relmio sidecar. n8n includes `background: false` in its
request; the updated sidecar omits that field before contacting the provider.
Updating Relmio source alone does not update a running sidecar container. For a
local bridge, choose **Manage bridge**, read the runtime update summary, select
its confirmation checkbox, then choose **Update bridge runtime**. For a VPS
bridge, reconnect through `relmio vps`, confirm the SSH host fingerprint, select
the n8n container and network, then choose **OpenAI-OAuth/Codex bridge** and
**Manage OpenAI-OAuth/Codex bridge**. Select **Review bridge update**, review the
plan, select its confirmation checkbox, then choose **Update the bridge**.

For **Image > Generate an Image** and **Image > Edit an Image**, choose a
discovered image model **From list**. If the current n8n picker does not show a
discovered model, choose **By ID** and enter its exact ID: `gpt-image-2`,
`gpt-image-2.5-flare`, or `gpt-image-2.5-sunburst`. Do not enter the generic
`gpt-image-2.5`: it is not a request ID. Begin with a prompt and **Quality: Low**.
Keep URL output off. GPT Image returns base64 data that n8n converts into its
binary output. Do not use the node's DALL-E default or substitute a text model.
The existing OAuth transport also accepts multipart image editing, up to five
reference images, with no mask. Provider/account limits still apply.

Image options `input_fidelity`, `moderation`, `output_compression`,
`output_format`, and `partial_images` are rejected by the pinned transport.
ChatGPT app voice access does not establish support for n8n's `/audio/speech`
request. Signing in again or rebuilding the same bridge will not enable audio.
OpenAI documents its API requests as separately authenticated with Platform API
credentials. If an unsupported action is needed, configure a separate Platform
credential in n8n according to your account and policy requirements. Do not put
that key in this bridge, and do not treat ChatGPT voice or a successful ChatGPT
sign-in as proof that the action is available.

### Data and policy check

Reviewed 2026-09-08 against OpenAI's [Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt),
[Codex authentication documentation](https://learn.chatgpt.com/docs/auth),
[API authentication reference](https://developers.openai.com/api/reference/overview),
[Moderation guide](https://developers.openai.com/api/docs/guides/moderation),
[video-generation guide](https://developers.openai.com/api/docs/guides/video-generation),
[Terms of Use](https://openai.com/policies/terms-of-use/), and
[Privacy Policy](https://openai.com/policies/privacy-policy/). The Sign in with
ChatGPT article describes identity sign-in for supported external applications;
it does not establish Relmio support, OAuth scope approval, access to these API
actions, feature availability, or Terms compliance for this unofficial
compatibility bridge.

For supported actions, n8n sends the selected prompt, messages, tool
definitions, inline image/file input, or image-edit reference data over the
private Docker network to the sidecar. The third-party pinned `openai-oauth`
package reads the saved ChatGPT/Codex OAuth session and transmits supported
requests to its default Codex backend at `https://chatgpt.com/backend-api/codex`.
The local route copies the complete credential JSON through a network-disabled
credential-seed helper into a private named Docker volume. The VPS route uploads
it with SFTP to `auth/auth.json` under the deployment's bind mount. Building the
sidecar contacts the npm registry for the pinned package.

The sidecar is stateless for Responses: it sets `store: false`, retains no
conversation or file object, and stores the private OAuth session required to
sign requests. Only the one-shot credential-seed helper disables Docker logging;
the main sidecar has no explicit Docker log-driver setting. The pinned package
can emit limited request metadata only when `CODEX_OPENAI_SERVER_LOG_REQUESTS=1`;
Relmio does not set that variable. The package defaults request
`openid profile email offline_access`, uses `https://auth.openai.com` as issuer,
and defaults to the Codex backend above. This review did not observe the
account's consent screen or actual grant, so granted scopes remain unknown.
Provider-side retention, account entitlement, policy eligibility, and main
sidecar/VPS log configuration also require account-owner verification. No
separate API key, API-key proxy, or emulated moderation/video service is added
by this bridge.

The request defaults are defined in [n8n's Responses helper](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/vendors/OpenAi/v2/actions/text/helpers/responses.ts).
The Analyze Image fixture follows n8n's current
[action source](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/vendors/OpenAi/v2/actions/image/analyze.operation.ts);
this source comparison is not live n8n acceptance.
The supported routes and image restrictions come from the pinned
[`openai-oauth` server](https://github.com/EvanZhouDev/openai-oauth/blob/v2.0.0/packages/openai-oauth/src/server.ts)
and [image adapter](https://github.com/EvanZhouDev/openai-oauth/blob/v2.0.0/packages/core/src/images.ts).

## 4. HTTP Request node

The HTTP Request recipe calls the bridge directly with n8n's generic Bearer
Auth credential. It uses the Chat Completions route because the body below uses
the `messages` format shown in the n8n node.

### Copy-paste fields

Method:

```text
POST
```

URL:

```text
http://n8n-openai-oauth:10531/v1/chat/completions
```

Authentication:

```text
Generic Credential Type
```

Generic Auth Type:

```text
Bearer Auth
```

Credential name:

```text
openai-oauth
```

Bearer token:

```text
local-only
```

Enable **Send Headers** and add this header:

Header name:

```text
Content-Type
```

Header value:

```text
application/json
```

Enable **Send Body**, select **JSON** for **Body Content Type**, and choose
**Using JSON** for **Specify Body**. Paste this body:

```json
{
  "model": "gpt-5.6-sol",
  "messages": [
    {
      "role": "user",
      "content": "What is a robot?"
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "answer",
      "schema": {
        "type": "object",
        "properties": {
          "content": { "type": "string" }
        },
        "required": ["content"],
        "additionalProperties": false
      },
      "strict": true
    }
  }
}
```

If the wizard reports a different model ID, replace only `gpt-5.6-sol` with
that detected ID. The `local-only` bearer value is a harmless n8n placeholder;
it is not an OpenAI Platform API key.

### Importable cURL version

The n8n HTTP Request node can import this cURL command. Replace only the model
if the wizard reports a different ID:

```bash
curl --request POST \
  --url http://n8n-openai-oauth:10531/v1/chat/completions \
  --header 'Authorization: Bearer local-only' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "gpt-5.6-sol",
    "messages": [
      {
        "role": "user",
        "content": "What is a robot?"
      }
    ],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "answer",
        "schema": {
          "type": "object",
          "properties": {
            "content": { "type": "string" }
          },
          "required": ["content"],
          "additionalProperties": false
        },
        "strict": true
      }
    }
  }'
```

The cURL `Authorization` header is equivalent to the n8n Bearer Auth
credential. It is included so the command can be imported or run as a direct
connectivity check.

### Expression-driven HTTP body

After the fixed test succeeds, switch the entire JSON body field to
**Expression** mode and paste:

```javascript
={{ {
  model: "gpt-5.6-sol",
  messages: [
    {
      role: "user",
      content: $json.prompt
    }
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "answer",
      schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false
      },
      strict: true
    }
  }
} }}
```

This reads the `prompt` property from the item produced by the previous node.

## SuperGrok in n8n

Create a separate OpenAI-compatible credential with the Base URL and one-time
local bearer shown by the SuperGrok wizard. For a workflow OpenAI Chat Model,
select a freshly discovered model **From list** and turn **Use Responses API**
off. For Chat Hub, turn it off in **Settings > Chat > OpenAI > Edit provider**.
Leaving it on sends the request to an unsupported Responses route and can return
`404 not_found` even when the companion and model are healthy.

The n8n AI Assistant custom endpoint uses the same private Base URL and bearer,
but its model is a text field. Enter a model returned by account discovery.
Assistant's Code Sandbox is a separate companion with its own prerequisites.
See [SuperGrok on a VPS](./vps-supergrok.md) for the remote flow and its remaining
live acceptance limits.

## Related official n8n documentation

- [OpenAI credentials](https://docs.n8n.io/integrations/builtin/credentials/openai/)
- [OpenAI Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/)
- [OpenAI Chat Model source](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts)
- [AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
- [Basic LLM Chain](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.chainllm/)
- [HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
