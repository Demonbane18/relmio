# n8n node compatibility harness

This harness checks that n8n's own nodes still work with the Relmio sidecar's wire format. It uses no ChatGPT account. A mock upstream stands in for OpenAI and answers the way the SIWC route does: streamed events with every item in `response.output_item.done` and an empty `output` list in `response.completed`. It records every request the sidecar sends.

The sidecar is the production handler from `src/gateway/openai-oauth-sidecar.mjs`. Only its account-facing parts are fakes: a token verifier for a fixed made-up key, a fake lease, a model list with one model, and the image add-on off.

It is not part of `npm test` because the full run needs Docker.

## Run it

```sh
npm ci --ignore-scripts --prefix test/integration/n8n-nodes
npm run test:n8n-nodes
```

`test:n8n-nodes` first runs the tests in this folder, which need no Docker, then `run.mjs`. On a machine without Docker, run the first part on its own:

```sh
node --test test/integration/n8n-nodes/*.test.js
```

`run.mjs` needs Linux and a running Docker daemon. It pulls `n8nio/n8n:2.40.7` by digest, creates a network, a volume and a container named `relmio-n8n-nodes-<random>`, and removes all three when it ends, even after a failure or Ctrl-C. It never touches other containers. It publishes no port.

## What it checks

| Check | Where | Pass condition |
| --- | --- | --- |
| HTTP Request node calling `/v1/responses` and `/v1/chat/completions` | `n8n/workflows/http-request.json` | Both nodes return the mock's answer. |
| AI Agent with the OpenAI Chat Model, Responses API on, one Calculator call | `n8n/workflows/agent-responses.json` | The agent returns the answer; the first upstream request offers `Calculator` in `additional_tools`; a later one carries the result `42`. |
| The same agent with Responses API off | `n8n/workflows/agent-chat.json` | As above, through `/v1/chat/completions`. |
| Basic LLM Chain with the OpenAI Chat Model | `n8n/workflows/basic-llm-chain.json` | The chain returns the answer. |
| OpenAI node, Message a model | `n8n/workflows/openai-message.json` | The node returns the answer. |
| n8n AI Assistant model check and a two-step tool turn | `assistant.test.js` | The AI SDK gets the answer. The second step reaches upstream with the full reasoning item instead of an `item_reference`. |

Every upstream request must use the test model, `store:false` and `stream:true`, keep function tools inside `additional_tools`, and contain no `item_reference`.

The Assistant check runs without Docker. n8n's AI Assistant calls the model through the AI SDK, so the test makes the same calls with the same pinned packages (`ai@7.0.74`, `@ai-sdk/openai@4.0.20`, `zod@3.25.76`, as resolved in n8n's lockfile at the tag below).

## How it reaches n8n

The workflows and the credential in `n8n/credentials.json` use the production address, `http://n8n-openai-oauth:10531/v1`. The container maps `n8n-openai-oauth` to the gateway address of the run's own Docker network with `--add-host`, and the sidecar listens on that address only. The sidecar accepts only Host values on its private allowlist, so `host.docker.internal` would be refused with 421.

No n8n server runs in the container. Each `n8n import:credentials`, `n8n import:workflow` and `n8n execute --id` call is its own process, so they never share the SQLite database or the task broker port. `N8N_LOG_FORMAT=json` lets `run.mjs` read the run from `n8n execute --rawOutput`.

The model id is `gpt-5-relmio-harness`. LangChain 1.4.4, which n8n 2.40.7 uses, sends the agent's system prompt with role `developer` only when the model id starts with `gpt-5` or `o` and a digit. Otherwise it sends role `system`, which the sidecar refuses. The OpenAI node sends `store:true` unless its Store option is off, so that workflow turns it off.

## Node types and versions

From n8n tag `n8n@2.40.7`, commit [`09b3ce6`](https://github.com/n8n-io/n8n/tree/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6):

| Node | Type | Version | Source |
| --- | --- | --- | --- |
| Manual Trigger | `n8n-nodes-base.manualTrigger` | 1 | [ManualTrigger.node.ts](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/nodes-base/nodes/ManualTrigger/ManualTrigger.node.ts) |
| HTTP Request | `n8n-nodes-base.httpRequest` | 4.5, the default | [HttpRequest.node.ts](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/nodes-base/nodes/HttpRequest/HttpRequest.node.ts) |
| AI Agent | `@n8n/n8n-nodes-langchain.agent` | 3.1, the default | [Agent.node.ts](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/@n8n/nodes-langchain/nodes/agents/Agent/Agent.node.ts) |
| OpenAI Chat Model | `@n8n/n8n-nodes-langchain.lmChatOpenAi` | 1.3, the newest | [LmChatOpenAi.node.ts](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/@n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts) |
| Basic LLM Chain | `@n8n/n8n-nodes-langchain.chainLlm` | 1.9, the newest | [ChainLlm.node.ts](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/@n8n/nodes-langchain/nodes/chains/ChainLLM/ChainLlm.node.ts) |
| OpenAI, Message a model | `@n8n/n8n-nodes-langchain.openAi`, resource `text`, operation `response` | 2.3, the default | [OpenAi.node.ts](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/@n8n/nodes-langchain/nodes/vendors/OpenAi/OpenAi.node.ts), [text/index.ts](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/@n8n/nodes-langchain/nodes/vendors/OpenAi/v2/actions/text/index.ts) |
| Calculator | `@n8n/n8n-nodes-langchain.toolCalculator` | 1 | [ToolCalculator.node.ts](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/@n8n/nodes-langchain/nodes/tools/ToolCalculator/ToolCalculator.node.ts) |

The import and execute rules the tests check come from [`import/workflow.ts`](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/cli/src/commands/import/workflow.ts), [`import/credentials.ts`](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/cli/src/commands/import/credentials.ts), [`execute.ts`](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/cli/src/commands/execute.ts), [`utils.ts`](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/cli/src/utils.ts) and [`workflow-structure-validation.ts`](https://github.com/n8n-io/n8n/blob/09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6/packages/workflow/src/workflow-structure-validation.ts).

## Updating n8n

Change the image tag and digest in `run.mjs`, then recheck each node's type and version at the new tag, the AI SDK versions in n8n's `pnpm-lock.yaml`, and the Assistant calls named at the top of `assistant.test.js`.
