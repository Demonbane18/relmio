# Relmio release acceptance workflow

`relmio-release-acceptance.json` is an n8n 2.40.7 workflow export for the live
checks in the `release-qa` skill (`.agents/skills/release-qa/SKILL.md`). It
calls the ChatGPT sidecar through each n8n node Relmio supports, plus the image
add-on and the local model. A release run executes it once by hand and reads
each node's output.

The export is inactive and contains no credentials. Nodes refer to
credentials by name only, so nothing secret is in this file.

## Nodes

| Node | Calls | Expected output |
| --- | --- | --- |
| HTTP Request: Responses | `POST /v1/responses` | `http responses ok` |
| HTTP Request: Chat Completions | `POST /v1/chat/completions` | `http chat ok` |
| AI Agent, with Agent Chat Model (Responses API on) and Calculator | Responses route with one tool call | `391` |
| Basic LLM Chain, with Chain Chat Model (Responses API on) | Responses route | `chain ok` |
| OpenAI: Message a Model (node 2.3) | Responses route | `openai node ok` |
| OpenAI: Generate an Image (node 2.3, `gpt-image-2`) | `POST /v1/images/generations` | one binary image; VPS image add-on only |
| Local Model Chain, with Local Chat Model (Responses API off) | `http://n8n-local-model:11434/v1` | `4`; only where the local model is installed |

`Settings` holds the text model ID and the local model ID. The defaults are
`gpt-6-astra`, which is also the model the n8n AI Assistant uses, and
`qwen3:0.6b`. Every node reads them from `Settings`.

Before a run, open the Relmio wizard's **Check installed account** for the
target sidecar and set `model` to a model it shows as Ready. On 2026-10-07 the
owner's catalog also had `gpt-6.1-sol`, `gpt-6-sol` and `gpt-6-luna`. Set
`localModel` to the model the local model status shows as ready.

Each check node is set to continue on error, so one failure does not hide the
others. That also means a failed node can look finished. A check passes only
when its output shows the expected text. An `error` field is a failure. Image
and local model failures are expected where those add-ons are not installed;
record them as skipped with the reason.

## Credentials

Both credentials are n8n **OpenAI** credentials (`openAiApi`).

| Name | Base URL | API key | Used by |
| --- | --- | --- | --- |
| `OpenAI Relmio` | `http://n8n-openai-oauth:10531/v1` | The one-time Relmio bearer from the wizard | Every node except Local Chat Model |
| `Relmio Local Model` | `http://n8n-local-model:11434/v1` | `local-only` (ignored) | Local Chat Model |

The HTTP Request nodes use the predefined `OpenAI` credential type, so the
bearer stays in the credential and never appears in the URL or body. Their URLs
use the sidecar's Docker hostname, which is the same on the Hostinger VPS and a
local Docker n8n.

## Import and re-link

1. In n8n, open **Workflows**, choose **Import from File** and pick
   `relmio-release-acceptance.json`. Keep it inactive. It has only a manual
   trigger, so activating it would do nothing useful.
2. The export carries credential names but no IDs, so n8n may not link them on
   import. Open each node that shows a credential warning and pick the
   credential from the table above: both HTTP Request nodes, both OpenAI
   nodes, Agent Chat Model and Chain Chat Model use `OpenAI Relmio`, and Local
   Chat Model uses `Relmio Local Model`. If the owner's n8n names them
   differently, pick the matching credential by its Base URL; do not rename
   the owner's credentials.
3. Set the model IDs in `Settings`, then save.

Adding the workflow to the owner's n8n is a separate step that needs the
owner's confirmation. Importing it changes nothing else in n8n and does not
restart it.

## Plan usage

One run sends six text requests to the ChatGPT plan (the AI Agent makes two
because of the tool call) and one image request against the Codex image
limits when the add-on is on. The local model uses no plan. State these
numbers in the release evidence.
