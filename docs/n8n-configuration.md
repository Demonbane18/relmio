# Configure n8n nodes

Use this page after the wizard reaches **The private bridge is ready**. Each
value is in its own code block so it can be copied separately.

## 1. Create the OpenAI credential

In n8n, create or edit an **OpenAI** credential.

### API Key

```text
local-only
```

This is a required n8n placeholder, not an OpenAI Platform API key or secret.

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

## 3. HTTP Request node

The HTTP Request recipe calls the bridge directly and does not need the n8n
OpenAI credential.

### Copy-paste fields

Method:

```text
POST
```

URL:

```text
http://n8n-openai-oauth:10531/v1/responses
```

Authentication:

```text
None
```

Header 1 name:

```text
Authorization
```

Header 1 value:

```text
Bearer local-only
```

Header 2 name:

```text
Content-Type
```

Header 2 value:

```text
application/json
```

JSON body:

```json
{
  "model": "PASTE_ONE_MODEL_ID_FROM_THE_WIZARD",
  "input": "Reply with exactly: bridge works"
}
```

Enable **Send Headers** and **Send Body**, select a JSON body, and paste the
object above.

### Importable cURL version

The n8n HTTP Request node can import a cURL command. Replace only the model
placeholder:

```bash
curl --request POST \
  --url http://n8n-openai-oauth:10531/v1/responses \
  --header 'Authorization: Bearer local-only' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "PASTE_ONE_MODEL_ID_FROM_THE_WIZARD",
    "input": "Reply with exactly: bridge works"
  }'
```

The placeholder header is included because it matches OpenAI-compatible
client behavior. It is not a real API credential.

### Expression-driven HTTP body

After the fixed test succeeds, switch the entire JSON body field to
**Expression** mode and paste:

```javascript
={{ {
  model: "PASTE_ONE_MODEL_ID_FROM_THE_WIZARD",
  input: $json.prompt
} }}
```

This reads the `prompt` property from the item produced by the previous node.

## Related official n8n documentation

- [OpenAI credentials](https://docs.n8n.io/integrations/builtin/credentials/openai/)
- [OpenAI Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/)
- [OpenAI Chat Model source](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts)
- [AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
- [Basic LLM Chain](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.chainllm/)
- [HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
