# OpenAI source check, 2026-10-07

This follows [the 2026-10-06 check](openai-source-check-2026-10-06.md) and covers the sidecar change that lets n8n 2.40.7's AI Assistant use the ChatGPT plan sidecar.

## Addendum: n8n Assistant compatibility

Review date: 2026-10-07.

Reviewed the uncommitted changes on `feature/documented-siwc` over `0243289` in `src/gateway/openai-oauth-sidecar.mjs` and `test/openai-oauth-sidecar.test.js`. Also reviewed: the user-facing copy in `README.md`, `docs/security.md`, `docs/faq.md`, `docs/ai-assistant.md`, `docs/n8n-configuration.md` and `src/ui/index.html`, the compatibility contract and the n8n request evidence. File references describe the working-tree snapshot read for this review. No `git diff` was run. The untracked empty `src/gateway/.head-sidecar.mjs` was ignored. The documentation was being edited in parallel, so its line numbers may move.

This review did not sign in, call a provider, read a credential, submit a form, use SSH or Docker, build anything or run tests.

Labels: **Confirmed** means an official OpenAI source fetched today states it. **Observed** means Relmio source shows it. **Provisional** marks evidence that is not from OpenAI: n8n and AI SDK sources, the local harness and owner reports. **Open** means the reviewed evidence does not settle the question. Consequences that were not exercised are marked [INFERENCE].

### What changed

- `/v1/responses` now drops `max_output_tokens` before validation instead of refusing it. Every other unsupported field is still refused (`src/gateway/openai-oauth-sidecar.mjs:22,986-997`).
- `/v1/chat/completions` drops `max_completion_tokens` and `max_tokens` and sends `reasoning_effort` as `reasoning.effort`. Values outside the allowed set are refused with `param: "reasoning_effort"` (`:25,712-720,789-790`).
- Upstream Responses requests always include `reasoning.encrypted_content` (`:999-1000`). A memory cache, one per process, keeps replayable items from completed responses. The AI SDK's `item_reference` input items are expanded from it (`:342-397,965,1019-1022`).
- Responses stream errors now use `{type:"error", sequence_number, code, message, param}`. Rewritten `response.failed` and `response.incomplete` frames keep `sequence_number`, `incomplete_details.reason` and whole-number `usage` (`:424-428,600-608,676-680`).
- A request may define up to 128 tools. One response can still carry at most 32 tool calls (`:15-16,140,160,196,218,732`).

Tests: `test/openai-oauth-sidecar.test.js:1010,1057,1085,1096,1123,1142,1153,1172,1184,1200,1212,1259`. This review did not run them.

### Sources

All retrieved on 2026-10-07. The Sign in with ChatGPT article was fetched first. Developer pages were read as Markdown and show no date.

| Source | Displayed date / note |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 5 days ago (4 days ago on 2026-10-06); fetched first |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: 18 hours ago |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | None |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | None |
| [SIWC errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) | None |
| [SIWC Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) | None |
| [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create): `include`, `store`, `max_output_tokens`, `reasoning`, `ItemReference`, reasoning `encrypted_content` | None |
| [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning): preserving reasoning without stored responses, keeping reasoning items in context, assistant `phase` | None |
| [Conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state): managing conversation state manually | None |
| [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses): "Decide when to store state" | None |
| [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data): `/v1/responses` | None |
| [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) and [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events) | None. The fetched events page was cut off before the `error` event schema |
| [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling) | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms, English-GB](https://openai.com/en-GB/policies/service-terms/), §15 | Updated: 29 September 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) and [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Published and effective January 1, 2026; updated January 16, 2026 |
| [Privacy policy](https://openai.com/policies/privacy-policy/) and [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: July 30, 2026 and August 24, 2026 |

Policy dates match the 2026-10-06 check.

The following sources are **Provisional**. They are not OpenAI policy:

| Source | Used for |
| --- | --- |
| n8n `n8n@2.40.7` (commit `09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6`) with `ai@7.0.74` and `@ai-sdk/openai@4.0.20`, from the compatibility evidence report and not refetched today | The model check sends `max_output_tokens: 16` (`instance-ai-verification.service.ts:33,139-144`). Chat turns send `reasoning.effort: "high"` and function tools, with no `store` or `include`. The AI SDK assumes `store` is true and replays reasoning and assistant text as `item_reference` items (`@ai-sdk/openai` `dist/index.js:3933-3938,4226-4233,6489`) |
| Local harness runs against a fake upstream, from the implementation report | The model check returned "OK". References reached the fake upstream as full items, and failure frames parsed as errors. None of these requests reached OpenAI |
| Owner report, 2026-10-07, VPS | The stale Assistant key got 401 "A local client credential is required." The current key's model check was refused with "This Responses parameter is unavailable with ChatGPT plan usage." (`max_output_tokens`). Not rerun |

### What Relmio reads, stores, transmits and logs

Everything in this section is **Observed** in source. None of it was exercised against OpenAI.

#### Reads

- Client `/v1/responses` bodies up to 2 MiB, as before (`:13,250-252,977`). `max_output_tokens` is now read and discarded (`:986-988`). For each `item_reference`, only its `id` is read (`:383-397`).
- Client `/v1/chat/completions` bodies. `max_completion_tokens` and `max_tokens` are read and discarded. `reasoning_effort` must be `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` (`:25,714-720`).
- Output items of upstream responses that end in `response.completed`. Cached items come from the completed response and are checked against `response.output_item.done`. The `response.output_item.added` copies, which can be incomplete, are never cached (`:324-341,477-480,560-566,697-700`).
- The SIWC lease is fetched as before (`:1004-1005`). No new file, environment variable or credential is read.

#### Stores (memory only)

| Item | Detail | Code |
| --- | --- | --- |
| Reasoning item | `{type:"reasoning", id, encrypted_content, summary}`. Cached only when `encrypted_content` is non-empty and `summary` is an array | `:344-347` |
| Assistant message | `{type:"message", role:"assistant", id, content:[{type:"output_text", text}]}`. `phase` is kept only when it is `commentary` or `final_answer`. Only non-empty messages made entirely of `output_text` parts are cached | `:348-352` |
| Bounds | 4,096 items, 32 MiB of serialized JSON and 6 hours from insertion; use does not extend an item's life. The least recently used item is evicted first. Expired entries are removed on insert and on lookup. Item IDs must match `^[A-Za-z0-9_-]{1,128}$` | `:19-21,342,354-382`; tests `:1142,1153,1172,1184` |
| Scope | One cache per sidecar process, shared by every caller that holds the Relmio bearer. Responses route only. Nothing is cached from failed, incomplete or interrupted responses | `:965,1019-1022,1096`; test `:1096` |

The cache holds no user or developer messages, instructions, tool definitions, function calls, function outputs, tokens or request IDs. It is never written to disk or to a log. It is lost when the process restarts, which includes the sidecar update because that recreates the container. On the VPS the sidecar runs with a read-only root filesystem and `mem_limit: 512m` (`src/domain/templates.js:54-59`). [INFERENCE] The host can still page process memory to swap, and root or Docker administrators on the VPS can read process memory. The stored SIWC tokens are already inside that same boundary.

Storage on disk is unchanged. Registrations, model-check records and image add-on files stay as described in the 2026-10-06 check.

#### Transmits

| Recipient | Data | Code |
| --- | --- | --- |
| OpenAI, `POST https://api.openai.com/v1/responses` | The SIWC bearer is the same as before. Every Responses request now carries `include` with `reasoning.encrypted_content` merged into the client's values, plus `store:false` and `stream:true`. Each known reference is replaced with the cached item, so earlier encrypted reasoning, its summary and the model's earlier text go back to OpenAI as input. Unknown references are removed. `max_output_tokens`, `item_reference` and `previous_response_id` never go upstream. Chat requests can carry `reasoning.effort` but never an output cap or `include`. Up to 128 function or custom tool definitions go in one `additional_tools` item | `:12,22,383-397,789-790,986-1000,1008-1011` |
| n8n, and any other holder of the Relmio bearer | Responses streams and JSON still pass through. Reasoning items now carry `encrypted_content` even when the client did not ask for it. Sidecar stream errors use the new error shape. Rewritten failed and incomplete frames add `sequence_number`, `incomplete_details.reason` and whole-number `usage`. Every frame still goes through token redaction, and SSE responses keep the `x-request-id` header. Chat clients still receive no reasoning items | `:424-428,599-612,630,676-680,703` |

No new destination was added, and no Relmio-operated service receives data. The image routes still use only the separate Codex image sign-in, and the cache never sees them (`:26,972`).

The client body stays capped at 2 MiB, and the expanded copies are capped at another 2 MiB (`:393`). An upstream body can therefore approach 4 MiB. None of the fetched SIWC pages gives a request-size limit.

#### Logs

No log lines were added. The sidecar still writes to stderr only when it cannot start (`:1100`). Neither the cache nor expanded requests are logged. OpenAI's privacy policy describes what OpenAI itself collects: content, plus log, usage and device data.

#### Scopes and recipients

OAuth scopes are unchanged: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, with resource `https://api.openai.com/v1` (`src/services/oauth.js:10-11`). The change adds no scope, grant, consent step or token handling.

The recipients are the same as before:

- OpenAI's authentication and API services, and the vendors its privacy policy names
- the VPS and its root or Docker administrators
- n8n and anyone with the Relmio bearer
- the local Relmio process and browser
- `registry.npmjs.org`, for model discovery

One thing is new for n8n: it now receives opaque encrypted reasoning. [INFERENCE] n8n may save it with Assistant history or LangSmith traces. This review did not check.

### Three separate checks

#### 1. Identity sign-in

**Confirmed:** The Help Center article still describes identity sign-in at participating partners. That sign-in releases name, email address and profile picture. Plan use is a separate request, and subscription sharing "does not give the tool access to your ChatGPT conversations or memory."

**Observed:** The change does not touch sign-in, registration, refresh or identity code. The Assistant's earlier 401, "A local client credential is required.", came from the sidecar's own check of the Relmio bearer (`:101-103,971`), so it tells us nothing about OpenAI identity. As earlier checks found, the article's identity-only description does not cover Relmio's full flow, which stores renewable tokens and spends the plan.

#### 2. Separately approved permissions

**Confirmed:** SIWC Terms §2 sets these requirements:

- Requests must originate from "the user's local runtime or a remote runtime only that user controls."
- Requests must be for the authenticated user and come from their activity or from automations they expressly authorized.
- "Another user's activity must not trigger requests to the authenticated user's account."
- The plan may be used "only for the application they connected", with no "general-purpose API access for other tools or unrelated requests."

§3 forbids collecting personal data "beyond what is reasonably necessary" and requires any necessary disclosures. §4 forbids "using one user's subscription to fulfill another user's requests." Service Terms §15 incorporates the SIWC Terms. The plan article says users can set a weekly limit for each app and that apps use credits only if the user allowed it.

**Observed:** The change requests and records no new permission. The plan grant, the n8n background-workflow consent and the model-check consent are unchanged. Pointing the Assistant at the sidecar is a manual n8n setting. Relmio's only control is a warning to do this only when nobody else uses that n8n (`src/ui/index.html:499`; `README.md:332-338`; `docs/ai-assistant.md:262-269`). The compatibility changes apply to every bearer holder on `/v1/responses` and every chat client, not only the Assistant.

**Open:** Does the n8n Assistant, a second n8n feature that reaches the plan through an OpenAI-compatible endpoint, fit "connected application only" and "no general-purpose API access"? No fetched source answers this. The sidecar cannot tell n8n users apart. On a shared n8n, the §2 and §4 user limits therefore depend on the owner following the warning.

**Open:** Is holding the model's output text and encrypted reasoning in memory for up to six hours "reasonably necessary" under §3? The cache exists only to answer the client's own references under `store:false`. The docs do not yet give the disclosure §3 requires (see mismatch 4).

**Open, unchanged:** §1 requires persistent token storage to be local and under the user's control. Whether the VPS design meets that is still unresolved.

#### 3. Model capability

**Confirmed (SIWC):** Inference goes to `POST https://api.openai.com/v1/responses` with `store:false` and `stream:true`, and it counts as successful only at `response.completed`. The preview limitations page lists `max_output_tokens` among the fields to omit. It says to "send `input` as an array containing the context needed for each request", and to omit `previous_response_id` over HTTP and "send the required history in `input`." It also says local thread history still works with `store: false`. Function tools go in namespaces or `additional_tools`. The app-server page says a completed inference turn verifies access to the selected model "for that request."

**Confirmed (Responses API in general):** `store` defaults to true, and stored response data is kept for at least 30 days. With `store:false`, the reasoning guide says reasoning items carry `encrypted_content` by default and that the API "still accepts the legacy `reasoning.encrypted_content` value in `include` for compatibility." The `include` reference says this value "enables reasoning items to be used in multi-turn conversations when using the Responses API statelessly." The conversation-state guide says to "include the model's previous response output as input" and, for stateless reasoning requests, to "preserve every item in the response's `output` array." The migration guide says to "Preserve and replay every returned reasoning item." The reference says to replay reasoning from `response.output_item.done`, because the copy in `response.output_item.added` "may be incomplete." It defines `ItemReference` as "An internal identifier for an item to reference."

**Open:** The SIWC pages do not mention `include`, replayed reasoning items or `item_reference`, either as allowed or as unsupported. The general API docs are not specific to SIWC, and the live retest has not run. Whether the SIWC route accepts the forced `include` and replayed encrypted reasoning is therefore unverified. [INFERENCE] OpenAI could not resolve an `item_reference` under `store:false`. No source says so, and the sidecar never forwards one.

**Provisional:** n8n 2.40.7's model check sends `max_output_tokens: 16`, and its chat turns produce `item_reference` items. The harness runs against a fake upstream passed. No Assistant request has yet reached OpenAI through the changed sidecar. None of this shows that the Assistant works end to end, or that any model, account or TTS works. The sidecar still has no speech route.

### Findings on the change

1. **Dropping `max_output_tokens`** (Confirmed and Observed). The upstream request now omits the field, as preview limitations ask. The errors and recovery page also tells integrations to "remove the unsupported input, tool, execution feature, model, or service-tier override" instead of retrying the same body. The client's cap is never applied, and the client is not told. The reference defines `max_output_tokens` as an upper bound that includes reasoning tokens. The reasoning guide says models "may generate anywhere from a few hundred to tens of thousands of reasoning tokens." On this route, usage is limited only by the plan, the per-app weekly limit and, if the user allowed it, credits. Dropping `max_completion_tokens` and `max_tokens` on the chat route is the same case, and it affects any chat client. This is consistent with OpenAI's documented limits, but the uncapped usage has to be disclosed.
2. **Encrypted reasoning with `store:false`** (Confirmed for the general API, Open for SIWC). This is documented for stateless multi-turn use, and no fetched SIWC page or Terms clause restricts it. It has not been shown to work on the SIWC route.
3. **Replaying the client's own earlier outputs** (Confirmed and Observed). Expansion fills in the history the client meant to send: reasoning and assistant text that this sidecar process received from OpenAI on completed responses, in the client's order. This matches "send `input` as an array containing the context needed for each request" and the guides on managing state manually. There are two gaps:
   - After a restart, the six-hour expiry or eviction, references the cache no longer holds are dropped without notice. The reasoning guide says "we highly recommend you pass back any reasoning items returned with the last function call" and that items between the last user message and the function output should be "passed into the next response untouched."
   - Unknown `phase` values are dropped, while the guide says to "preserve each original `phase` value."

   Both gaps can lower answer quality. None of the fetched Terms address them.
4. **Reasoning effort** (Confirmed and Observed). Relmio's seven values match the reference exactly. The reference adds "Not all reasoning models support every value", so OpenAI can still refuse one.
5. **Tool count** (Observed). None of the fetched sources sets a hard limit. The function-calling guide suggests fewer than 20 functions and calls this "just a soft suggestion." The 128 limit is Relmio's own. [INFERENCE] More tool definitions mean more input per request.
6. **Error frames** (partly Confirmed, partly Provisional). The streaming guide lists an `error` event that carries `message`. The full field set `{type, sequence_number, code, message, param}` was checked only against AI SDK 4.0.20's schema, because the fetched OpenAI events page was cut off. Rewritten failed and incomplete frames keep the error code, status and request ID that errors and recovery asks integrations to preserve. An incomplete frame uses Relmio's own `response_incomplete` code alongside OpenAI's reason. Stream errors the sidecar generates itself have no request ID in the frame, but the SSE `x-request-id` header still carries it.

### Mismatches

The disclosures below were read on 2026-10-07 while another agent was editing them. Recheck after that work lands.

1. `README.md:302-303` says "The Responses route passes OpenAI's events unchanged." The sidecar now adds encrypted reasoning to every response and rewrites error, failed and incomplete frames.
2. `README.md:305-307` says unsupported parameters "are rejected", and `docs/ai-assistant.md:265-266` says the sidecar "refuses request fields and tools it cannot keep." `max_output_tokens`, `max_completion_tokens` and `max_tokens` are now dropped without notice, so a client's output cap is not applied.
3. `docs/n8n-configuration.md:170-171` says "At most 32 tools in one list." The code now allows 128 definitions and keeps the limit of 32 calls per message or response.
4. No disclosure describes the item cache: what it holds, its bounds, that it lives only in memory and is shared by every bearer holder, and that a restart drops earlier context. `docs/security.md:547-549` says "stored responses/conversations" are not enabled. That is still true of storage at OpenAI, but the page should mention the sidecar's own short-lived copy. SIWC Terms §3 requires necessary disclosures.
5. `docs/ai-assistant.md:271-272` and `README.md:335-338` are still accurate: the sidecar adds no logs, and the Assistant is untested with the sidecar until the live retest. Harness results against a fake upstream must not be described as a live test.
6. OpenAI's own docs differ. The `include` reference presents `reasoning.encrypted_content` as an opt-in value. The reasoning and migration guides say stateless responses return it by default, and the reasoning guide calls the `include` value legacy. Relmio asks for it explicitly, which both accept.
7. The change summary says expansion is "bounded by the 2 MiB body limit." The code caps the expanded copies at 2 MiB in addition to the 2 MiB client body.

Resolution, same day, after the documentation update landed: items 2, 3 and 4 are fixed. The README, npm README, Assistant guide and n8n configuration guide name the output-cap exception; the configuration guide lists 128 tool definitions and 32 calls; `docs/security.md` has a "Remembered Responses items" section covering contents, bounds, memory-only storage, sharing among Relmio key holders and loss on restart. Item 1 stands as accurate: OpenAI's events still pass through unchanged apart from failure events, and the configuration guide states that every Responses request asks for `reasoning.encrypted_content`.

Changes after the boundary audit, same day (reviewed against the same sources; recipients and scopes unchanged):

- `reasoning.encrypted_content` is added to `include` only when the client request sets `reasoning`, as Codex does. Other requests, such as an OpenAI Chat Model node without reasoning settings, keep the client's `include` as sent, so they no longer receive encrypted reasoning they did not ask for. The "always include" statements in "What changed" and "Transmits" above describe the earlier snapshot.
- Sidecar-generated stream errors and rewritten `response.failed` frames also carry a top-level `error: { code, message }` with the same redacted values, so the OpenAI Node SDK used by n8n's Chat Model node raises them instead of ending quietly.
- A repeated reference expands once; cached items are held as exact-size buffers; the copy budget comment now matches the code (copies have their own 2 MiB budget on top of the client body).

### Unknowns

- Whether OpenAI treats the n8n Assistant as part of the connected application under SIWC Terms §2, and whether wider client compatibility brings the sidecar closer to the "general-purpose API access" that §2 rules out.
- Whether the SIWC route accepts the forced `include`, replayed encrypted reasoning and replayed assistant messages, and for which models and accounts.
- The plan usage of an uncapped model check, a request with 128 tools or a long replayed history. None of the fetched pages gives a usage rate for this route, and the plan article says "Usage rates may differ between an app and ChatGPT."
- Retention and training rules for SIWC requests, including replayed encrypted reasoning. The data controls guide covers Platform API organizations, and the privacy policy excludes API customer content. The migration guide says `encrypted_content` is "decrypted in memory, used for generating the next response, and then securely discarded", but it says so in its paragraph about ZDR organizations.
- Whether n8n stores the encrypted reasoning it now receives.
- Whether n8n's AI SDK retries 429 and 5xx responses on the model check. Errors and recovery says to pause after a usage-limit error. This behavior predates the change.
- OpenAI's exact `error` event schema, which was not read because the fetched reference was cut off.

This review is not legal advice, OpenAI approval, proof of Terms compliance or permission to use a Codex credential bridge. It is not evidence that the Assistant, any model or TTS works through the sidecar. Identity sign-in, the approved permissions and model capability remain separate checks.
