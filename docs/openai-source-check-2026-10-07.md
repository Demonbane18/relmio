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
- Whether the SIWC route accepts replayed encrypted reasoning and replayed assistant messages, and for which models and accounts. The live result below shows that a request with `reasoning` and the added `include` was accepted for one account and model; the sidecar adds no logs, so whether that turn replayed earlier items was not observed.
- The plan usage of an uncapped model check, a request with 128 tools or a long replayed history. None of the fetched pages gives a usage rate for this route, and the plan article says "Usage rates may differ between an app and ChatGPT."
- Retention and training rules for SIWC requests, including replayed encrypted reasoning. The data controls guide covers Platform API organizations, and the privacy policy excludes API customer content. The migration guide says `encrypted_content` is "decrypted in memory, used for generating the next response, and then securely discarded", but it says so in its paragraph about ZDR organizations.
- Whether n8n stores the encrypted reasoning it now receives.
- Whether n8n's AI SDK retries 429 and 5xx responses on the model check. Errors and recovery says to pause after a usage-limit error. This behavior predates the change.
- OpenAI's exact `error` event schema, which was not read because the fetched reference was cut off.

### Live result after deployment

On 2026-10-07 the owner confirmed the VPS sidecar update in the wizard (only the sidecar was rebuilt and restarted; the sign-in and Relmio key stayed the same; n8n was not touched). n8n 2.40.7's AI Assistant, on one ChatGPT account (Pro plan), then used the sidecar with `gpt-6-astra`: n8n's model check passed and the setting saved; "Reply with OK" returned "OK"; "Which workflows do I have?" ran a tool step and listed the instance's workflows in about 35 seconds. This is **Observed** for one account, one model and two short turns. It is not evidence for other accounts, models, longer conversations or behavior after a sidecar restart, and it does not change the Terms §2 question above.

This review is not legal advice, OpenAI approval, proof of Terms compliance or permission to use a Codex credential bridge. Apart from the live result above, it is not evidence that the Assistant, any model or TTS works through the sidecar. Identity sign-in, the approved permissions and model capability remain separate checks.

## Addendum: setup guide and request counts

Review date: 2026-10-07.

Reviewed the 0.19.0 work on `feature/documented-siwc` since `0f13ecd` (the task names wave 1 `51caf75` and wave 2 `8339b54`; this review ran no git command and read the working tree). In scope: the setup guide and its error help (`src/ui/guide.js`, `src/ui/guide/*.js`), the guide preference (`src/services/ui-preferences.js`, `/api/ui/preferences`), the sidecar request counts (`src/gateway/openai-oauth-sidecar.mjs`, `src/services/model-discovery.mjs`, `src/services/installer.js`, `src/services/local-n8n-sidecar-installer.js`, `src/domain/safety.js`, `src/web/server.js`) and the Plan and usage panels (`src/ui/usage-panel.js`, `src/ui/index.html`, `src/ui/local.html`, `src/ui/app.js`, `src/ui/local.js`). Disclosures read: the "Request counts" section of `docs/security.md`, the Unreleased section of `CHANGELOG.md`, `README.md:220-223`, `docs/faq.md:27-36` and `docs/troubleshooting.md:205-262`. Documentation is being edited in parallel, so doc line numbers may move.

This review did not sign in, call a provider, read a credential, submit a form, use SSH or Docker, open a browser, build anything or run tests.

Labels follow the entry above. **Confirmed** means an official OpenAI source fetched today states it. **Observed** means Relmio source shows it. **Provisional** marks evidence that is not from OpenAI. **Open** means the reviewed evidence does not settle the question. [INFERENCE] marks consequences that were not exercised.

### What changed

- A skippable guide on all six wizard pages points at fields and buttons and explains errors. It picks error help by flag, then `code`, then `recovery`, then HTTP status (`src/ui/guide.js:50-58`). Its copy makes statements about ChatGPT sign-in, plan use and usage limits (`src/ui/guide/content-vps.js`, `content-local.js`, `errors.js`).
- The guide's on or off choice is saved in `ui-preferences.json` and in `sessionStorage` (`src/services/ui-preferences.js:6-55`; `src/ui/guide.js:101-131`; `src/web/server.js:3512-3524`).
- The n8n sidecar counts each text request it relays to OpenAI, per UTC day and model, with the outcome, the token counts of completed responses and the last plan-usage error (`src/gateway/openai-oauth-sidecar.mjs:263-266,1036-1048`; `src/services/model-discovery.mjs:833-899`).
- Two read-only routes return a 30-day view: `POST /api/siwc/vps/usage/status` and `GET /api/local/usage/status` (`src/web/server.js:5865-5886,3651-3657`).
- Plan and usage panels appear on the VPS owner panel, the VPS Ready screen, the `/local` dashboard and the local installed view (`src/ui/usage-panel.js`; `src/ui/index.html:451-458,682`; `src/ui/local.html:294-303,1157-1166`).

### Sources

All fetched on 2026-10-07, the Sign in with ChatGPT article first. Developer pages were read as Markdown and show no date.

| Source | Displayed date / note |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 5 days ago; fetched first |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: 23 hours ago |
| [SIWC accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | None |
| [SIWC errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) | None |
| [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) | None |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | None |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | None |
| [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create), `usage` object | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms, English-GB](https://openai.com/en-GB/policies/service-terms/), §15 | Updated: 29 September 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) | Published and effective January 1, 2026 |
| [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Updated: January 16, 2026 |
| [Privacy policy](https://openai.com/policies/privacy-policy/) | Updated: July 30, 2026. The page's canonical link now reads `/policies/services-communications-privacy-policy/` |
| [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: August 24, 2026 |

Policy dates match the entry above. The plan article showed "18 hours ago" earlier today; [INFERENCE] the relative label fits the same update.

The following sources are **Provisional**. They are not OpenAI policy:

| Source | Used for |
| --- | --- |
| Implementation reports from GuideContent, UsageBackend, UsagePanels, AuditFixes and WizardRefresh, 2026-10-07 | Test results and browser QA. The panel QA used intercepted fixture responses. Not rerun |
| UsageDataResearch report, 2026-10-07 | Its list of undocumented Codex usage endpoints and headers, used only to check that Relmio calls none of them |

### What Relmio reads, stores, transmits and logs

Everything in this section is **Observed** in source. None of it was exercised against OpenAI.

#### Reads

- For each text request it relays, the sidecar takes the client's `model` value, the outcome, the error code of a failed request and, for completed responses only, `usage.input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens` and `total_tokens` (`openai-oauth-sidecar.mjs:1036-1048`; `model-discovery.mjs:180-187,841-853`). These come from frames the sidecar already parsed. The error code comes from a structured pre-stream error body or a `response.failed` frame; a `{"detail": ...}` body yields none. A model ID is kept only when the request completed or ended incomplete, or when the last loaded catalog lists it (`openai-oauth-sidecar.mjs:1045`; `model-discovery.mjs:845`).
- The wizard reads the stored record with the static `usage` command: on a VPS over the reviewed SSH session (`src/domain/safety.js:123`; `src/services/installer.js:1649-1659`), locally through `docker compose exec` after ownership checks (`src/services/local-n8n-sidecar-installer.js:474-508`). The command reads one file and does not touch the SIWC lease (`model-discovery.mjs:893-899,945-951`).
- The panels also show account fields Relmio already had: label, email, session state, plan permission and plan on or off (`usage-panel.js:102-109`). When the VPS image add-on is signed in, they show the plan type Relmio decoded from the `chatgpt_plan_type` claim of the separate Codex image tokens (`src/services/codex-images.mjs:309-310`; `src/ui/app.js:2220`; `usage-panel.js:110`).
- The guide reads the page's DOM state. From an error it keeps only `code`, `errorCode`, `stoppedReason`, `recovery`, `param`, `status` and six boolean flags (`guide.js:69-78`).
- No OpenAI call is added. These features use no `backend-api`, `wham`, rate-limit header or usage API. The only `chatgpt.com/backend-api` use in `src/` is the existing image route (`openai-oauth-sidecar.mjs:26`).

#### Stores

| Item | Where | Content and bounds | Code |
| --- | --- | --- | --- |
| Request counts | `activity/<registration ID>.json` and a `.lock` file in the sidecar's SIWC storage: `/docker/n8n-openai-oauth/siwc/activity` on a VPS, the sidecar's `siwc-store` Docker volume locally | Registration ID, first and last write times, and for each UTC day and model (or `other`): requests, completed, failed, incomplete, and input, cached, output, reasoning and total tokens. The last plan-usage event `{at, code}` for four codes, cleared by the next completed response. 31 days, 64 named models a day, 900 KiB. Folder `0700`, file `0600`, locked atomic writes, at most one write per 30 seconds plus one at shutdown. No prompts, outputs, request IDs, IP addresses, headers or tokens | `model-discovery.mjs:22-24,58-76,155-243,833-899` |
| Unwritten counts | Sidecar memory | Until the next write; put back after a failed write | `model-discovery.mjs:833-882` |
| Guide preference | `ui-preferences.json` in the SIWC storage root on the wizard's computer (`N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth`), and `sessionStorage` key `relmio-guide` | `{"guide": "on"}` or `"off"`. At most 1 KiB, `0600`, written only into a private root the user owns | `ui-preferences.js:6-55`; `guide.js:102-131` |
| Last view | Wizard page memory | One view per registration | `app.js:2359`; `local.js:2159` |

#### Transmits

| Recipient | Data | Code |
| --- | --- | --- |
| OpenAI | Nothing new. Counting sends no request, and the panels call no OpenAI endpoint. Manage usage opens `https://chatgpt.com/settings/usage` in a new tab with `noopener noreferrer` and carries no Relmio data | `openai-oauth-sidecar.mjs:263-266`; `usage-panel.js:6,83-90` |
| Wizard, from the VPS | The stored record as the `usage` command's output, over the reviewed SSH connection. Allowed only after Check installed account, with an exact body, full root scope and at most 10 reads in 15 minutes | `server.js:129-130,5865-5886`; `installer.js:1649-1659` |
| Wizard, from local Docker | The same record through `docker compose exec`, only for an attested, running, owned sidecar | `local-n8n-sidecar-installer.js:474-508`; `server.js:3651-3657` |
| Browser tab | The 30-day view: totals, active days, peak day, per-day requests and tokens, up to 64 models plus `other`, and the last event with its recovery | `model-discovery.mjs:245-279` |
| Wizard, from the browser | `{guide}` to `/api/ui/preferences` and `{containerName, networkName, registrationId}` to the VPS usage route, both with the setup token | `guide.js:117-127`; `server.js:3516-3524,5868-5869` |

n8n and other holders of the Relmio key receive no counts. The sidecar's HTTP routes are unchanged and include no usage route (`openai-oauth-sidecar.mjs:999-1004`). The guide loads only same-origin files and makes no third-party request.

#### Logs

Counting, the `usage` command, the two routes and the guide add no log lines. The command prints the record to stdout for the wizard. [INFERENCE] SSH or Docker auditing on the host can record that the static command ran, without its output. OpenAI describes its own processing in the Sign in with ChatGPT article's privacy section and in its privacy policy.

#### Scopes and recipients

OAuth scopes are unchanged: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, with resource `https://api.openai.com/v1` (`src/services/oauth.js:10-11`). Allow ChatGPT plan use still repeats OAuth with `prompt=consent` (`oauth.js:210`). These features add no grant, consent step or token handling.

The new data reaches only the VPS and its root or Docker administrators, the local operating-system account and Docker, the local Relmio process and the browser tab. Relmio's maintainers and website receive nothing. The recipients listed in the entry above are otherwise unchanged.

### Three separate checks

#### 1. Identity sign-in

**Confirmed:** The Sign in with ChatGPT article says identity sign-in releases only name, email address and profile picture, and does not independently share "Your billing information or other ChatGPT account data." It also says "You can complete identity sign-in without approving subscription sharing." The accounts and sessions page says a returning sign-in reuses the registration's issued `client_id` and stable `ext_agent_host_id`, and that switching back to a saved account "does not create a new client."

**Observed:** The panels show only the label and email that Relmio already keeps from the verified ID token (`oauth.js:169-170`; `usage-panel.js:107-109`). No fetched SIWC page documents a plan tier, and Relmio shows none from SIWC. The guide treats signing in and allowing plan use as separate steps (`content-vps.js:103`; `content-local.js:44`; `errors.js:87`), which matches the article. Sign in again repeats OAuth for the same registration with its saved client ID and host ID (`siwc-controls.js:271-274`; `oauth.js:204-208`), as the accounts page describes. The guide's line "Relmio never reuses an old sign-in" describes this poorly (mismatch 7). The panel shows "Signed out" for an account that only needs a fresh sign-in (mismatch 11).

As earlier entries found, Relmio's flow is not the identity-only flow the article describes: it requests the plan scope and stores renewable tokens. These features do not change that.

#### 2. Separately approved permissions

**Confirmed:** The plan article says plan use is a separate choice and each app can have a weekly limit set in Settings > Usage. It says "An app can reach its own limit even when your ChatGPT plan still has usage available." Apps can use credits after plan limits only if the user explicitly allowed it. "Usage settings do not show details about your actions in the app", and users should "Keep the task details". Errors and recovery describes the plan-not-enabled branch, says `prompt=consent` remains supported before `force_reconsent` rolls out, and gives a recovery for each usage code. SIWC Terms §2 requires "express consent before background use". §3 limits personal data to what is "reasonably necessary" and asks for a privacy notice "presented to users before processing their data" and "any necessary disclosures". §4 bars "rotating accounts, or otherwise bypassing usage limits." Service Terms §15 says a connecting user agrees to share "where relevant, your ChatGPT usage." The UI/UX page illustrates an app-side summary of the last 30 days with Total, Peak per day and Active days, and a Manage usage link right below it.

**Observed:** No new scope, grant, consent step or token handling. The guide's background-use tips match §2 (`content-vps.js:376,468`; `content-local.js:520,594`). Error help keeps the same account and tells users not to work around limits (`errors.js:16,66-73,247`), which fits §4 and the errors page's "OpenAI does not silently switch the request to another billing path." The panels follow the UI/UX layout and put Manage usage beside the counts (`usage-panel.js:150-156,196-200`).

**Observed:** The request counts are new processing tied to a registration. They stay on the user's VPS or computer and reach no one else. The panel note, `docs/security.md:539-581` and `CHANGELOG.md:12-20` describe them. Nothing tells the user before counting starts: not the VPS review list, the local review list or the sidecar update summary (`index.html:559-566`; `local.html:857`; `app.js:2459-2463`).

**Open:** Whether §3's notice-before-processing rule covers data that never leaves user-controlled hosts. Mismatch 8 adds a one-line notice either way.

**Open, unchanged:** The image add-on uses a Codex sign-in that OpenAI does not document for other apps. The panel now also shows its plan type, which comes from an undocumented token claim. No fetched source permits or forbids showing it.

#### 3. Model capability

**Confirmed:** Models and inference treats a request as successful only at `response.completed`, says usage-limit and usage-unavailable errors can arrive mid-stream as `response.failed`, lists models from `/v1/models` and says not to use `backend-api`. The Responses reference defines an optional `usage` object with `input_tokens`, `input_tokens_details.cached_tokens` and `cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens` and `total_tokens`. Preview limitations lists image generation as unsupported on the SIWC route. None of the fetched pages documents plan percent, remaining usage, reset times, credit balance or plan tier for SIWC. Errors and recovery says not to "infer a reset time from this code alone", and the plan article says "Usage rates may differ between an app and ChatGPT."

**Observed:** Tokens come only from `response.completed.usage`; incomplete and failed requests add none (`model-discovery.mjs:849-852`). `cache_write_tokens` is not recorded. The panels show no percent, reset time or credits (`usage-panel.js:1-4,198-199`). "Verified by a completed request" means a model check or real request completed on the VPS, and on `/local` a model with tokens in the last 30 days (`usage-panel.js:111-120`). Neither feature adds or claims a TTS route.

**Open:** Whether SIWC streams always include `usage`. When one does not, Relmio counts the request with zero tokens (`model-discovery.mjs:180-187`).

**Provisional:** Tests and browser QA used fixtures. No live SIWC request was observed for these features.

### Findings on the change

1. **Documented data only** (Confirmed and Observed). The panels show Relmio's own counts, the last plan-usage code and a Manage usage link, as the UI/UX and accounts pages describe. They show no plan percent, reset time, credits or SIWC plan tier, and Relmio calls none of the undocumented Codex usage endpoints in the research report. OpenAI's illustration titles such a summary "ChatGPT plan usage over the last 30 days"; Relmio labels its numbers as its own counts, the more cautious reading given that usage rates may differ.
2. **Last plan-usage event** (Confirmed and Observed). Relmio takes the code only from a structured error, never from `{"detail": ...}` text, as errors and recovery advises. It shows when the event happened, never a reset time. It keeps no request ID; the plan article says a request ID "helps when available" for support but is not required.
3. **No pause after a limit** (Observed, predates this change). Errors and recovery tells the integration to "Pause new requests that use the user's ChatGPT plan." The sidecar now records the limit event but still relays every new request (`openai-oauth-sidecar.mjs:1033-1075`). Only background model checks pause, for 60 minutes (`model-discovery.mjs:33,806-815`). The panel asks the user to pause instead (`usage-panel.js:13`).
4. **Counting cannot alter traffic** (Observed). The count is fire-and-forget and kept in memory until written (`openai-oauth-sidecar.mjs:263-266`; `model-discovery.mjs:841-866`). The UsageBackend report says tests compare the streamed output with and without a counter (Provisional; not rerun).
5. **The counts are a partial usage record** (Observed). Model-check tests go from model discovery straight to OpenAI and are never counted (`model-discovery.mjs:691-717`; `recordActivity` is called only from the sidecar's `tally`). Image requests return before counting (`openai-oauth-sidecar.mjs:1001`). Tokens come only from completed responses. The copy still says the counts cover requests "through Relmio" (mismatches 4 and 10).
6. **Where guide error help runs** (Observed). It runs only from each page's `showError` (`app.js:182-188`; `local.js:184-200`), which the sign-in controls use (`app.js:1011`; `local.js:671`). The VPS Ready readiness line, the usage panels and the `/local` chat tester show their errors without it (`app.js:1853-1866,2360-2361`; `local.js:3988-3995`).

### Mismatches

The fixes keep the guide content test's rules: at most three sentences in `say`, and no exclamation marks, en or em dashes, or emoji.

1. **A plan-use refusal tells users to sign in again.** The sidecar maps every upstream status other than 400, 401, 422 and 503 to `fix-configuration`, unless the code is the usage limit (`openai-oauth-sidecar.mjs:62-63`). That covers `subscription_sharing_user_not_eligible`, `subscription_sharing_route_not_supported`, `chatpass_v2_*` and a direct-admission 403. The sign-in panel's model list uses this mapping (`openai-oauth-sidecar.mjs:256-258,1086-1089`; `server.js:3660-3668`), the wizard keeps `code` and `recovery` (`server.js:1549-1569,6410`; `siwc-controls.js:4-15`), and the guide has no entry for the not-eligible code. It falls back to `recovery["fix-configuration"]`, which says "Start a fresh ChatGPT sign-in for the same account." (`errors.js:105-112`). Errors and recovery says for not-eligible: "Explain the restriction; do not repeat the same request or loop through OAuth." The plan article says "Buying credits or signing in again does not make an account eligible." [INFERENCE] whether `/v1/models` returns these codes; they are documented for Responses.
   Fix, a new entry in `GUIDE_ERRORS.codes`:
   ```js
   subscription_sharing_user_not_eligible: {
     title: "Plan use not available",
     say: "OpenAI says ChatGPT plan use is not available for this account, workspace or policy. Signing in again or retrying does not change that.",
     steps: [
       "Check that you signed in with the ChatGPT account and workspace you meant to use.",
       "If it should be eligible, contact OpenAI Support with the error shown.",
     ],
   },
   ```
   And in `errors.js:107-111`: say "OpenAI did not accept this sign-in setup or request. The message names the reason.", with the steps "Follow the repair the message names." and "Sign in again only if the message asks for it."

2. **Usage-limit help assumes the plan's own limit.** `errors.js:15-20`, used for `manage-usage` and for the limit code, says "OpenAI paused requests for this account because its plan usage is limited." and "Wait until your plan allows requests again." `content-vps.js:540` says "The account reached its plan usage limit." `errors.js:204` says "Your plan's usage limit was reached". Errors and recovery: "Do not assume the entire plan is empty ... an app-specific limit can also apply." The UI/UX page: "The limit may apply to their ChatGPT plan or specifically to your app." The plan article: "Signing in again or repeatedly retrying does not restore your usage."
   Fix `errors.js:15-20`:
   ```js
   title: "Usage limit reached",
   say: "OpenAI refused the request because a usage limit was reached. It can be your plan's limit or the weekly limit set for this app in ChatGPT. Relmio does not switch accounts or billing.",
   steps: [
     "Press Manage usage to see which limit applies and when it resets.",
     "Wait for that reset, or raise this app's limit in ChatGPT if you set it lower.",
     "Try again with the same account. Signing in again does not restore usage.",
   ],
   ```
   Fix `content-vps.js:540`: "OpenAI reported a usage limit. It can be your plan's limit or the weekly limit set for this app. Press Manage usage to check which one in ChatGPT."
   Fix `errors.js:204`: "A usage limit was reached, or OpenAI could not check the usage or the account just then. The limit can be your plan's or this app's limit in ChatGPT. Untested models are tried again later."
   The guide took its wording from `docs/troubleshooting.md:209,259`, which have the same gap.

3. **Panel event titles overstate three codes.** `usage-panel.js:14` titles `subscription_sharing_usage_unavailable` "Plan usage was unavailable". The code means "Usage availability could not be checked", and the plan article says such an error "does not necessarily mean you've reached your limits." `usage-panel.js:15` titles `subscription_sharing_user_unavailable` "The account was unavailable"; the code means user or workspace information is temporarily unavailable. `usage-panel.js:16-17` says "This plan can't be used here" and "Check this account's plan in ChatGPT"; the code covers "the selected user, workspace, or policy."
   Fix:
   ```js
   subscription_sharing_usage_unavailable: ["Usage could not be checked",
     "OpenAI could not check plan usage just then. This does not mean a limit was reached. Try again later with the same account."],
   subscription_sharing_user_unavailable: ["Account details were unavailable",
     "OpenAI could not read this account or workspace just then. Try again later with the same account."],
   subscription_sharing_user_not_eligible: ["Plan use not available",
     "OpenAI said plan use is not available for this account, workspace or policy. Check that this is the account you meant to use. Signing in again does not change it."],
   ```
   Because the sidecar does not pause (finding 3), the limit line at `usage-panel.js:13` could also read "Pause the n8n workflows that use this account and open Manage usage. The limit can be your plan's, or one you set for this app in ChatGPT." Any of these changes needs `test/usage-panel.test.js:151-154` updated.

4. **"Requests through Relmio" leaves out model checks and images** (finding 5). Model checks use the plan (`content-vps.js:304`), and the plan article asks users to compare app activity when usage is higher than expected. Current wording: `usage-panel.js:150` "Requests through Relmio, last 30 days"; `usage-panel.js:199` "These are requests sent through Relmio, not your ChatGPT plan's usage."; `usage-panel.js:22` "counts each text request it sends to OpenAI"; `content-vps.js:288` "the requests Relmio sent for this account"; `content-vps.js:296` "the requests and tokens that went through Relmio"; `content-vps.js:582` "Relmio counts each request n8n sends through the sidecar."; `index.html:682`; and `docs/security.md:546-552`, which excludes images but not model checks. Fixes:
   - `usage-panel.js:150`: "Text requests through the sidecar, last 30 days"
   - `usage-panel.js:199`: "These are Relmio's counts of text requests through the sidecar. Model checks and image requests are not counted, and ChatGPT measures plan usage its own way. Plan limits, reset times and credits stay in ChatGPT. "
   - `usage-panel.js:22`: "No requests counted in the last 30 days. A sidecar from this Relmio version counts each text request n8n sends through it. Model checks and image requests are not counted. An older sidecar counts nothing until you update it with Review sidecar update above."
   - `content-vps.js:288`: "Press Refresh usage to read the text requests the sidecar sent for this account in the last 30 days. It only reads from your server. If the account check has expired, press Check installed account first."
   - `content-vps.js:296`: "These are the text requests and tokens that went through the sidecar, not your plan's limits. Model checks and images are not counted. Manage usage opens ChatGPT, which shows your limits and reset times."
   - `content-vps.js:582`: "Relmio counts each text request n8n sends through the sidecar, but not model checks or images. To see the counts later, open Manage the installed ChatGPT session in Choose your n8n and press Refresh usage."
   - `index.html:682`: "Relmio counts the text requests n8n sends through it, but not model checks or images. See them later under Manage the installed ChatGPT session."
   - `docs/security.md:551-552`: "Image requests, model-check tests and requests the sidecar rejects before sending are not counted."

   The `/local` copy is accurate as written: the local sidecar runs no model checks and has no image sign-in.

5. **The plan notice tip leaves out credits.** `content-vps.js:87` and `content-local.js:28` say "Your ChatGPT plan pays for these requests, and OpenAI's limits apply." The plan article says requests "count toward the ChatGPT Work and Codex usage included in your plan", and that an app can use credits after plan limits if the user explicitly allowed it. The UI/UX settings card says "usage included in your ChatGPT plan or credits balance." Fix both: "Requests count toward the usage in your ChatGPT plan, and OpenAI's limits apply. If you allowed apps to use credits in ChatGPT, credits can be used after the plan limit. Press Continue when you have read it." The notice itself has the same gap (`index.html:245`; `local.html:494`); `README.md:221` already mentions credits.

6. **Pause and sign-out do not stop the sidecar "for a moment".** `content-vps.js:368` and `content-local.js:586` say "Pause, resume and sign-out stop only this sidecar for a moment." Pause and sign-out leave it stopped; only Use ChatGPT plan starts it again (`installer.js:1431-1486`; `local-n8n-sidecar-installer.js:2743`). The plan article adds that signing out of an app "does not disconnect it from ChatGPT". Fix: "Pause stops this sidecar until you press Use ChatGPT plan. Sign out stops it until you sign in again. Tick the box first, then press the action you want." Optional `find`: "To remove Relmio from ChatGPT as well, use Disconnect under Settings, Security and login, Login connections, if ChatGPT lists it."

7. **"Relmio never reuses an old sign-in."** This line is in `content-vps.js:119` and `content-local.js:60`, with similar wording at `errors.js:77`. Sign in again reuses the saved registration, client ID and host ID, as the accounts page asks; only the tokens are new. The `reauthorize` recovery also covers every upstream 401 (`openai-oauth-sidecar.mjs:62-63`). For a direct-admission 401, errors and recovery says "Check the selected ChatGPT account and granted scopes". For `subscription_sharing_invalid_user`, it says to ask for a new sign-in "after confirmed revocation or a terminal refresh error."
   Fix the tips: "If the status says this account needs a fresh sign-in, press Sign in again. Relmio keeps the same saved account and replaces its old sign-in."
   Fix `errors.js:76-82`: title "Check the ChatGPT sign-in"; say "OpenAI did not accept this account's sign-in or plan permission. Check that the selected account is the one you meant to use."; steps "If Sign in again is shown, press it and use the same account.", "Finish the sign-in on the ChatGPT page." and "Come back and repeat the step that stopped."

8. **No notice before counting starts.** SIWC Terms §3; whether it applies is Open (check 2). Add to `#review-will-list` (`index.html:559-566`): "Let the sidecar keep daily request and token counts on this server for 31 days, with no prompts or answers". Add the same line, ending "on this computer", to the n8n ChatGPT sidecar review on `/local` (`local.html:857`). Add to the sidecar update summary (`app.js:2459-2463`): "The updated sidecar keeps daily request and token counts on the server for 31 days, with no prompts or answers."

9. **The image add-on's plan type is not marked as undocumented.** The hint at `usage-panel.js:110` reads "From the image add-on's separate Codex sign-in." The value comes from the undocumented `chatgpt_plan_type` claim (`codex-images.mjs:309-310`). Fix the hint: "From the image add-on's separate Codex sign-in. OpenAI does not document this value for other apps." This matches the guide's own wording at `content-vps.js:336`.

10. **Token totals count completed responses only.** `usage-panel.js:153` labels the sum "Tokens" with no qualifier. [INFERENCE] Incomplete and failed requests can still use plan usage; the plan article says an answer can stop partway and asks users to report usage that was still recorded. Fix: `["Tokens", format.count(sum.total), "from completed responses"]`.

11. **"Signed out" for an account that needs a fresh sign-in.** `usage-panel.js:102-103` maps every session other than `connected`, including `reauthorize`, to "Signed out". Fix: return "Needs a fresh sign-in" when `account.session === "reauthorize"`, before the "Signed out" case.

12. **Manage usage is described as plan limits only.** `content-vps.js:144` says "Check your plan's limits there at any time." and `content-vps.js:603` says "Open Manage usage in ChatGPT to watch your plan limits". The accounts page and the plan article say Settings > Usage shows each app's usage and its weekly limit. Fix `:144`: "Manage usage opens ChatGPT's usage page. There you can see each app's usage, set a weekly limit for an app and see when limits reset." Fix `:603`: "Open Manage usage in ChatGPT to watch usage and limits".

13. **"Plan" means two things in error help.** `errors.js:114-119` ("Review the plan again", "Approve the new plan.") and `errors.js:168` ("Your reviewed plan is kept.") use "plan" for Relmio's setup plan, next to copy about the ChatGPT plan. Fix: "Review the setup plan again", "Something changed since you reviewed the setup plan, so Relmio stopped and needs a fresh review.", "Approve the new setup plan." and "Your reviewed setup plan is kept."

14. **Doc drift after the audit fix.** `docs/security.md:552-553` says a model keeps its ID "only when OpenAI accepted the request". The code keeps it only for a completed or incomplete outcome, or a catalog ID (`openai-oauth-sidecar.mjs:1045`). Fix: "A model keeps its ID only when OpenAI completed the request or ended it incomplete, or the account's catalog lists it".

`README.md` and `docs/faq.md` do not mention the request counts yet.

Resolution, same day, before release: mismatches 1 to 14 are fixed. The guide has an entry for `subscription_sharing_user_not_eligible`, and `fix-configuration` no longer sends people to sign in again. Usage-limit help says the limit can be the plan's or a limit set for this app in ChatGPT. The panel's event titles follow the codes' documented meaning. The VPS copy says the counts are text requests through the sidecar and leave out model checks and images. The plan notice and its tips mention credits. Pause and sign-out describe how long the sidecar stays stopped. Sign in again keeps the saved account. The VPS review, the VPS sidecar update summary and the `/local` sidecar review now say that daily request and token counts are kept, with no prompts or answers. The image add-on plan type is marked as a value OpenAI does not document for other apps. Token totals are labelled as coming from completed responses. A session that needs a fresh sign-in says so. Manage usage is described as ChatGPT's usage page with per-app limits and resets. Error help says "setup plan" for Relmio's own plan. `docs/security.md` and `docs/troubleshooting.md` match the code, and `README.md` and `docs/faq.md` describe the request counts.

### Unknowns

- Whether OpenAI's `/v1/models` returns `subscription_sharing_user_not_eligible` or a direct-admission 403 (mismatch 1). The errors page documents these for Responses.
- Whether SIWC `response.completed` events always carry `usage`, and how token counts relate to the usage ChatGPT records. The plan article says rates may differ.
- Whether ChatGPT lists Relmio by name under App limits, so a user can find its weekly limit. Relmio sends `agent_name_hint: 'Relmio'` only on a first sign-in (`oauth.js:209`).
- Whether model-check tests count toward the same app entry in ChatGPT as relayed requests. [INFERENCE] They use the same SIWC token.
- Whether the credits behaviour in the plan article applies to Relmio's open-source route. It is documented for apps that use the plan and has not been observed here.
- Whether SIWC Terms §3 notice and minimization rules apply to counts kept only on user hosts.
- Whether OpenAI allows showing the image add-on's plan type, which comes from an undocumented claim of an undocumented sign-in.
- Unchanged from earlier entries: VPS token storage under §1, and whether n8n and its Assistant fit "connected application only" under §2.

This review is not legal advice, OpenAI approval, proof of Terms compliance or permission to use a Codex credential bridge. It is not evidence that any model, account, usage figure or TTS works through Relmio. Identity sign-in, the approved permissions and model capability remain separate checks.

## Addendum: 0.19.1 sign-in refresh and maintenance fixes

Review date: 2026-10-07.

This review covers the four pull requests in Relmio 0.19.1 on `Demonbane18/relmio`. Each was read from its `pr://` diff and from the local worktree on its head branch:

- #105, `fix/local-project-meta` (`/private/tmp/relmio-local-project-meta`): the star count cache with a fallback to the website, and Hostinger KVM VPS preselected.
- #106, `fix/vps-owned-sidecar-update` (`relmio-frontend-revamp`): step 3 routing and the VPS ChatGPT sign-in refresh.
- #107, `ci/release-gates` (`/private/tmp/relmio-ci-gates`): CI, the n8n node harness, release QA and the `/v1/chat/completions` `content: []` fix.
- #108, `fix/windows-siwc-lock` (`/private/tmp/relmio-win-lock`): the Windows lock-holder probe.

Line numbers come from those worktrees and can move when the PRs merge. The refresh depends on code that #106 does not change: `src/services/oauth.js`, `siwc-session.mjs`, `installer.js`, `model-discovery.mjs`, `codex-images.mjs`, `src/web/server.js` and `src/domain/safety.js`. Those files were read on the #106 branch.

Disclosures read: `CHANGELOG.md`, `README.md`, `docs/vps-and-n8n.md`, `docs/troubleshooting.md`, `docs/security.md`, `docs/faq.md`, `src/ui/index.html`, `src/ui/guide/content-vps.js` and `src/ui/guide/errors.js`. The Hostinger preselection in #105 only changes which hosting option starts selected and sends nothing, so it is not covered further.

This review did not sign in, call a provider, read a credential, submit a form, use SSH or Docker, open a browser, build anything or run tests. Labels follow the entries above.

### What changed

- **#106.** When **Choose your n8n** opens, the wizard now reads the installed VPS sidecar and names the main button after what it will do (`src/ui/app.js:1370-1372,1995-2050`). When the installed account's session is `reauthorize`, the panel says `Needs a fresh sign-in.` and offers **Refresh ChatGPT sign-in** (`app.js:2108-2116`; `src/ui/index.html:451-454`).
  - The refresh starts a new ChatGPT sign-in on the wizard's computer. It then reuses the reviewed sign-out and replacement: **Sign out and revoke** on the VPS, reconnect, **Review replacement**, **Replace the sidecar**, and a new Relmio key for n8n (`app.js:2128-2133,2555-2561,2667-2674`; `docs/vps-and-n8n.md:228-263`).
  - The wizard refuses a replacement with any registration other than the one the refresh sign-in produced (`app.js:2052-2068`).
- **#107.** `/v1/chat/completions` accepts an assistant message with `content: []` plus `tool_calls`. n8n's AI Agent sends this shape when Use Responses API is off (`src/gateway/openai-oauth-sidecar.mjs:795-799`).
- **#105.** The wizard keeps the GitHub star count for 15 minutes. When GitHub fails, the wizard server asks `https://relmio.jpfusin.tech/api/project-meta` (`src/services/project-meta.js:7-8,28-40`).
- **#108.** On Windows, a lock holder whose PowerShell probe prints `ambiguous` now counts as dead, but only after a separate probe returns ESRCH (`src/infrastructure/process-identity.js:131-133,201-203`).

### Sources

All sources were fetched on 2026-10-07, with the Sign in with ChatGPT article first. The developer pages were read as Markdown and show no date.

| Source | Displayed date / note |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 5 days ago; fetched first |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: yesterday. Earlier entries today showed 18 and 23 hours ago |
| [SIWC open-source overview](https://developers.openai.com/siwc/token-sharing-open-source), "A client vs. an agent host" | None |
| [SIWC registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | None |
| [SIWC accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | None |
| [SIWC errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) | None |
| [SIWC self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) | None |
| [SIWC token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) | None |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | None |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms, English-GB](https://openai.com/en-GB/policies/service-terms/), §15 | Updated: 29 September 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) | Published: January 1, 2026; Effective: January 1, 2026 |
| [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Updated: January 16, 2026 |
| [Privacy policy](https://openai.com/policies/privacy-policy/) | Updated: July 30, 2026. Canonical link reads `/policies/services-communications-privacy-policy/` |
| [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: August 24, 2026. Its link to the version for other regions reads `/policies/communications-privacy-policy/` |

The policy dates match the entries above.

The following sources are **Provisional**. They are not OpenAI policy:

| Source | Used for |
| --- | --- |
| PR bodies for #105 to #108 and their CodeRabbit reviews, 2026-10-07 | Test counts, the n8n harness result and the retained review concern about refresh intent on #106. None was rerun |
| Vercel bot comments on the PRs | They show that the website (`web/`) deploys on Vercel, so Vercel hosts `relmio.jpfusin.tech/api/project-meta` |
| #107 n8n node harness: n8n 2.40.7 in Docker against a mock OpenAI upstream | The `content: []` replay shape. No ChatGPT account was used, and its CI run was not observed here |

### What Relmio reads, stores, transmits and logs

Everything in this section is **Observed** in source. None of it was exercised against OpenAI.

#### Reads

- **Refresh sign-in.** On OpenAI's callback, Relmio reads `code`, `state`, the issued `client_id`, `scope` and `iss` (`oauth.js:127-145`). It then reads the token response and validates the ID token against OpenAI's JWKS with the new client ID and nonce (`oauth.js:150-164`). No saved subject is compared, because the refresh has no saved registration (`oauth.js:164`).
- **Owner check, now automatic on step 3.** The wizard reads the installed account's label, email, registration ID, session state and plan state from the VPS (`app.js:1372,2449-2472`).
  - For a running sidecar that Relmio owns, it then reads image status and the model view (`app.js:2474-2482`).
  - The model view runs `model-discovery.mjs status` inside the sidecar (`safety.js:120`; `installer.js:1645`). That command takes a SIWC lease, which may renew the token. With no catalog in that process, it sends `GET https://api.openai.com/v1/models?client_version=…` with the access token (`model-discovery.mjs:651-660,677-682,901-911`).
  - [INFERENCE] `docker compose exec` starts a new process, so this read usually reaches OpenAI. Before #106, it ran only when the user pressed **Check installed account**.
- **#107.** The chat route accepts one more request shape. It reads nothing new.
- **#105.** The wizard reads only `stargazers_count` from GitHub or `stars` from the website. The website's `version` is ignored (`project-meta.js:29-31`; test "when GitHub refuses or fails, the website's cached count is used…").

#### Stores

| Item | Where | Detail | Code |
| --- | --- | --- | --- |
| Refresh intent | Wizard page memory | `{registrationId, newRegistrationId}`. Cleared only after a successful sidecar install, not when the refresh sign-in is cancelled or fails | `app.js:21,1428-1431,1859,2671` |
| New registration | SIWC store on the wizard's computer, then the VPS | New issued client ID, verified issuer, subject and email, tokens and scopes. After transfer, the local copy keeps no tokens. On the VPS it keeps the VPS's existing host ID | `oauth.js:146-148,166-169`; `siwc-session.mjs:373`; `installer.js:704-705`; `README.md:253-256` |
| Old registration | VPS SIWC store | Kept with an empty session, plan use off and background consent off. Its tokens and history are not reused. [INFERENCE] Its request-count file stays, because counts are kept per registration and no longer updated | `siwc-session.mjs:892`; `docs/vps-and-n8n.md:262-263` |
| Codex image sign-in | VPS | Deleted by the sign-out step of the refresh, as a best effort | `installer.js:1420-1423`; `codex-images.mjs:459-486` |
| Star count (#105) | Wizard process memory | 15 minutes. The last good count is kept for the rest of the run | `project-meta.js:23-40` |

#108 and #107 store nothing new.

#### Transmits

| Recipient | Data | Code |
| --- | --- | --- |
| OpenAI authorization, from the browser and wizard on the user's computer | A first-time authorization: `client_id=dynamic_agent_client`, `agent_name_hint=Relmio`, that computer's `ext_agent_host_id`, all six scopes, `resource`, `state`, `nonce` and PKCE. Then the code exchange with the issued client ID | `app.js:2672`; `server.js:3758-3759`; `oauth.js:150-155,204-210` |
| OpenAI authorization, from the VPS | **Sign out and revoke** posts the old refresh token, `token_type_hint=refresh_token` and the old client ID to the revocation endpoint, with up to three attempts. It also tries to revoke the Codex image refresh token. If a terminal refresh error already cleared the tokens, nothing is sent | `safety.js:119,124`; `siwc-session.mjs:858-893`; `codex-images.mjs:469-476`; `siwc-session.mjs:772-773` |
| OpenAI API, from the VPS | The automatic owner check's catalog request, plus a token renewal when one is due | see Reads |
| VPS, over the reviewed SSH session | The new registration's credential record, through the existing handoff. This happens only after the replacement, background-use and final approvals | `server.js:6097-6104`; `installer.js:477-479,534-538,655-657` |
| n8n | A new one-time Relmio key, which the user copies. The old key stops working | `app.js:1858-1862` |
| OpenAI, for #107 | For `content: []`, the upstream Responses body is the same as for `content: null`: `function_call` items and no empty assistant message. Assistant content with parts stays refused | `openai-oauth-sidecar.mjs:796-799`; `test/openai-oauth-sidecar.test.js:701-703,747-755` |
| Relmio's website, `relmio.jpfusin.tech`, for #105 | New. Sent only when GitHub fails. The request carries a `relmio/<version>` User-Agent and an `Accept` header, with no cookies or credentials, `redirect: "error"` and a 5-second timeout. The host sees the IP address and the time. The website route then asks GitHub and npm from its own servers | `project-meta.js:16,24,29-31`; `web/app/api/project-meta/route.ts:25-32` |

GitHub already received the star-count request before #105.

#### Logs

No log lines were added. #106 shows status only as page text. The sign-out and status commands print JSON to stdout for the wizard, as before. [INFERENCE] SSH or Docker auditing on the host can record that these commands ran.

#107's release QA workflow runs in the owner's n8n. [INFERENCE] n8n may save execution data according to its settings. The CI harness logs contain only mock traffic (Provisional).

#### Scopes and recipients

OAuth scopes are unchanged: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, with resource `https://api.openai.com/v1` (`oauth.js:10-11`). The refresh requests all of them on a new registration, without `prompt=consent` (`oauth.js:207-210`).

One recipient is new: the host of Relmio's website, for #105. The other recipients match the entries above:

- OpenAI's authentication and API services
- the VPS and its root or Docker administrators
- n8n and anyone who holds the Relmio key
- the local Relmio process and the browser tab
- `registry.npmjs.org`
- GitHub

### Three separate checks

#### 1. Identity sign-in

**Confirmed:** The Help Center article says identity sign-in releases "only your name, email address, and profile picture". Service Terms §15 says the same.

The sign-in page sets these rules:

- A new registration uses `dynamic_agent_client`, `agent_name_hint` and the host ID.
- A returning sign-in uses the saved issued `client_id`.
- "For a returning account, confirm the new ID token's verified identity matches the selected account before replacing credentials."
- "Email and `sub` are not workspace identifiers."

The accounts page says: "When signing in again to the same account on the same host, reuse the registration's issued `client_id` and stable `ext_agent_host_id`. Signing out or switching back to a saved ChatGPT account does not create a new client." For reauthorization it says to omit `agent_name_hint` and send a retained `id_token` as `id_token_hint`.

Errors and recovery says that after an unusable refresh token, apps should "Clear unusable tokens and repeat OAuth with the saved issued client ID."

The self-hosted VMs page says to "Complete OAuth locally with the same tool/client for the same user and workspace you will use on the VM" and to "Preserve the host ID assigned to the VM when importing the credentials". It adds: "Use its own host ID for its next authorization."

The overview says "Later sign-ins reuse the saved client ID."

**Observed:** The refresh is a first-time registration. The wizard sends `{purpose: "sign-in"}` with no registration (`app.js:2672`; `server.js:3758-3759`). The authorization therefore uses `dynamic_agent_client`, `agent_name_hint: 'Relmio'` and the computer's host ID (`oauth.js:66,205,208-209`).

Relmio cannot start a returning sign-in for the VPS registration. After the transfer, the local record belongs to another runtime, and `startOAuthLogin` refuses it (`oauth.js:67-69`).

The VPS keeps its own host ID when the new credentials are imported (`installer.js:704-705`), which matches the VMs page.

Relmio checks the new sign-in's identity only by email:

- The wizard warns when the emails differ but does not refuse (`app.js:2128-2133`).
- The server and the installer check only that the new registration is a different registration (`server.js:5946-5950`; `installer.js:534-538`).
- Any successful sign-in on the page while a refresh is pending becomes the "new sign-in". That includes **Sign in again** for another saved account, and an intent left over from a cancelled or failed attempt (`app.js:1428-1431,1859`). CodeRabbit raised this, and the code confirms it.
- `src/` sends no `id_token_hint` or `login_hint`. This predates 0.19.1.

As earlier entries found, Relmio's flow is not the identity-only flow the article describes.

**Open:** OpenAI's guides describe renewing a sign-in through the saved client. Whether a transferred VPS registration can be renewed that way was not tested; see Unknowns.

#### 2. Separately approved permissions

**Confirmed:**

- The Help Center article says: "Review and approve any additional permissions separately."
- The plan article says that when an app asks you to reconnect, you should "follow its connection flow and review the permissions again". It also says "Signing in again or repeatedly retrying does not restore your usage", and that each app has its own weekly limit under **Settings > Usage**.
- The overview says an issued `client_id` "identifies that registration, its security boundaries, and its ChatGPT plan usage settings". It adds that one client can "share ChatGPT plan usage settings and limits" across a laptop and a VM.
- The accounts page says "Revoking this session does not delete the registered client."
- The VMs page says "Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available."
- SIWC Terms §1 requires persistent token storage to be "local and under the user's control". §2 requires express consent before background use and use only for the connected application.
- SIWC Terms §4 forbids "Creating multiple accounts, splitting usage, rotating accounts, or otherwise bypassing usage limits" and "Using one user's subscription to fulfill another user's requests".
- The Terms of Use say: "You may not share your account credentials or make your account available to anyone else."

**Observed:** The refresh collects consent again. The new registration asks for the identity and plan scopes together (`oauth.js:11,207`). Reviewing the replacement requires plan use to be on and the plan notice to be read (`app.js:2054-2058`). The install requires `confirmed`, `backgroundConsent` and `replacementConsent` (`server.js:6097-6104`; `installer.js:477-479`).

Sign-out clears the old registration's plan use and background consent (`siwc-session.mjs:892`) and turns model checks off (`docs/troubleshooting.md:266`). The replacement proceeds only when the old registration is signed out at the reviewed generation (`installer.js:889-894`).

**Refresh ChatGPT sign-in** is shown for any live sidecar that Relmio owns, not only when the session needs renewing (`app.js:2108-2109`). The guide says to use it only when the panel asks (`content-vps.js:296`).

**Open:**

- Each refresh creates a new client. Per the overview, a new client has its own usage settings, so a lower weekly limit the user set for the old connection does not carry over. Whether OpenAI treats repeated new clients for one account as acceptable under §4 is not stated. [INFERENCE] Pressing refresh after an app limit was reached could reset that limit. The plan-wide limits still apply.
- What a successful revocation response from the VPS means, given that the VMs page says revocation for transferred sessions is "not yet available".
- Unchanged and exercised again by the refresh's transfer: VPS token storage under §1, and whether n8n fits "connected application only" under §2.

#### 3. Model capability

**Confirmed:** Models and inference says to request the catalog with `GET /v1/models` "with the same access token you will use for inference", and to run inference only through `POST /v1/responses` with `store:false` and `stream:true`. Preview limitations says to "Send `input` as an array containing the context needed for each request". It lists audio and video input and the transcription API as unsupported. The token reference gives a one-hour access token and a 30-day refresh token that each refresh renews.

**Observed:**

- #106 changes no inference path. Its automatic owner check can reach `/v1/models` and renew the token, as described under Reads.
- #107 changes only which chat request shapes are accepted. It adds no field, tool or route.
- #108 keeps one refresh owner at a time. Its regression test returns the cached token without a refresh request (`test/siwc-session.test.js:896-935`). This fits "serialize refreshes for the same session so two processes do not race a rotating token."
- None of the PRs adds a speech, audio or TTS route.

**Provisional:** The #107 harness ran against a mock upstream. The PR reports give the `npm run check` results.

**Open:**

- Whether the SIWC route accepts the chat route's translated tool replay. This was not observed live. The earlier live result covered the Assistant on Responses only.
- Whether catalog requests count toward plan usage.

### Findings on the change

1. **A new client for every refresh** (Confirmed guidance, Observed code). OpenAI's guides renew a sign-in by repeating OAuth with the saved client ID and the VM's own host ID. Relmio registers a new client from the user's computer instead.

   The consequences come from the overview and the accounts page:
   - ChatGPT asks for workspace selection and consent again.
   - The old connection's usage settings do not carry over.
   - The old client stays registered after revocation.

   [INFERENCE] ChatGPT may list two Relmio connections. Because refresh tokens expire after 30 days, an n8n that sits idle for a month will need a refresh, so these connections can pile up over time.

2. **Sign-out and revocation match "End the renewable session"** (Confirmed and Observed). Relmio sends a POST with `token`, `token_type_hint` and `client_id` (`siwc-session.mjs:876-880`). It retries network errors and 5xx responses up to three times and stops on a 4xx (`siwc-session.mjs:873-889`). It always clears the local tokens (`siwc-session.mjs:892`).

   When no 200 arrives, or after an uncertain rotation, Relmio reports `unconfirmed` and tells the user to disconnect Relmio in ChatGPT (`app.js:2555-2556`), as the accounts page asks. After a terminal refresh error, the tokens were already cleared at that point (`siwc-session.mjs:772-773`), as errors and recovery asks.

   [INFERENCE] During a refresh, that disconnect advice could lead someone to disconnect the new connection by mistake (mismatch 4).

3. **No token reuse** (Observed). The new registration has its own client and tokens. Thread bindings include the client ID (`siwc-session.mjs:836-857`), and the old registration must be signed out before the replacement. This matches "Never overwrite another account registration's credentials or combine one registration's client ID with another registration's tokens." `refresh_token_reused` is in Relmio's terminal set (`siwc-session.mjs:18`).

4. **`Needs a fresh sign-in.` also covers uncertain renewals** (Observed). A network failure or an unverifiable rotation freezes the record as `refreshUncertain`, and the panel shows it as `reauthorize` (`siwc-session.mjs:401,758-774`). Relmio keeps those credentials frozen rather than erasing them. The refresh then revokes them, which is the cautious path for a rotating token. The copy says only that "OpenAI no longer accepts" the sign-in (mismatch 3).

5. **The new account is checked by email only** (Observed). Two workspaces can share an email, and the warning does not stop a different email (finding under check 1). [INFERENCE] Another person's account, signed in on the same computer while a refresh is pending, could replace the VPS sign-in with only a warning. §4 forbids using one user's subscription for another user's requests. The earlier **Review replacement** flow already allowed a deliberate switch to another account.

6. **The automatic owner check reaches OpenAI** (Observed). Step 3 calls a documented endpoint with the user's sign-in when the user opens the step, which is the user's own activity under §2. The CHANGELOG and the VPS guide call it a "read-only check" (mismatch 7).

7. **The refresh signs out of image generation** (Observed). Sign-out first signs out of the Codex image add-on (`installer.js:1420-1423`). `docs/vps-and-n8n.md:330-331` says so for **Sign out and revoke**, but the refresh steps do not mention it.

8. **#107 changes no upstream request** (Observed). The Responses `input` for `content: []` matches the `content: null` case. #107 also adds a release QA workflow that sends six text requests and one image request per run from the owner's own n8n (`qa/acceptance/README.md:45,73-76`). That is the owner's own activity under §2. The image request uses the Codex image sign-in, which is still Open.

9. **#105 adds a new recipient but no OpenAI data** (Observed). `docs/security.md:161-169` discloses the website request accurately. [INFERENCE] SIWC Terms §3 covers personal data processed for SIWC, and an IP address in a star-count request falls outside it.

10. **#108** (Observed). A holder counts as dead only when ESRCH is observed. A live or unverifiable holder stays `ambiguous` (`process-identity.js:131-133,202`), so a rotating refresh token is never raced.

### Mismatches

The fixes keep the guide content test's rules: at most three sentences in `say`, and no exclamation marks, en or em dashes, or emoji.

1. `docs/vps-and-n8n.md:233-235` reads: "Relmio cannot sign in again for the registration on the server, because the server's sidecar owns it. It gives the sidecar a new sign-in for the same ChatGPT account through the reviewed replacement instead:"

   Fix: "Relmio does not yet renew the registration that the server's sidecar owns. OpenAI's guides renew a sign-in by repeating it with the registration's saved client ID. Relmio instead makes a new registration for the same ChatGPT account and gives it to the sidecar through the reviewed replacement:"

2. `docs/vps-and-n8n.md:240-242` reads: "Sign in with the same ChatGPT account in the browser window Relmio opens. The new sign-in is a separate registration, even with the same email."

   Fix: "Sign in with the same ChatGPT account, and choose the same workspace, in the browser window Relmio opens. ChatGPT treats this as a new connection: it asks you to approve it again, and usage settings for the old connection, such as a weekly app limit, do not carry over. You can change the app name ChatGPT shows so you can tell the two apart."

3. The uncertain-renewal case is missing in three places:
   - `docs/vps-and-n8n.md:230-231`: change "If OpenAI stops accepting it," to "If OpenAI stops accepting it, or Relmio cannot confirm that a renewal worked,".
   - `CHANGELOG.md:35`: change "When OpenAI no longer accepts the VPS sidecar's sign-in," to "When OpenAI no longer accepts the VPS sidecar's sign-in, or Relmio cannot confirm its last renewal,".
   - `docs/troubleshooting.md:222`, cause column: "OpenAI no longer accepts the installed sidecar's ChatGPT sign-in, or Relmio could not confirm its last renewal. Relmio does not renew a registration that has moved to the server, so the refresh makes a new one."

4. Nothing says the old connection stays registered in ChatGPT.
   - After `docs/vps-and-n8n.md:263`, add: "Revoking the old sign-in does not remove its connection from ChatGPT. Once the replacement works, you can disconnect the old Relmio connection under **Settings > Security and login > Login connections** if ChatGPT lists it. Check that you pick the old one."
   - In `app.js:2555-2556`, when `state.vpsSignInRefresh?.newRegistrationId` is set and revocation is `unconfirmed`, replace "Disconnect Relmio in ChatGPT settings." with "Finish the replacement first. Then you can disconnect the old Relmio connection in ChatGPT settings and keep the new one."

5. The refresh steps leave out image generation (finding 7). After step 6 at `docs/vps-and-n8n.md:257-260`, add: "7. If you used image generation, turn it on again under `[Turn on image generation](#turn-on-image-generation-optional)`. **Sign out and revoke** also signed out of images."

6. The UI copy does not say the refresh is a new connection.
   - `src/ui/index.html:452`: "Sign in again on this computer with the same ChatGPT account and workspace. ChatGPT treats it as a new Relmio connection, and the old connection's usage settings do not carry over. Then sign out the old sign-in here and review the replacement. n8n needs the new Relmio key afterwards."
   - `src/ui/guide/content-vps.js:296`, `say`: "Use this only when the panel says the sign-in needs a fresh ChatGPT sign-in. Sign in with the same account and workspace; ChatGPT treats it as a new connection with its own usage settings. Then follow the main button to sign out the old sign-in and review the replacement, and give n8n the new Relmio key."

7. Two places call the step 3 check "read-only" (finding 6).
   - `CHANGELOG.md:20-21`: "A check of the installed sidecar runs when the step opens. It does not change the sidecar, but a running sidecar may renew its ChatGPT sign-in and ask OpenAI for the account's model list."
   - `docs/vps-and-n8n.md:69-70`: "Relmio then checks the installed sidecar on that n8n. The check does not change the sidecar, but a running sidecar may renew its ChatGPT sign-in and ask OpenAI for the account's model list. The main button then says what comes next:"

8. `CHANGELOG.md:42-43` reads: "The replacement must use the registration from that new sign-in; another account saved on this computer is refused."

   Fix: "The wizard accepts only the registration from that new sign-in and refuses other accounts saved on this computer. It warns when the new sign-in has a different email, but it cannot tell two workspaces with the same email apart."

9. Two places send a 401 straight to a refresh. Errors and recovery says a direct-admission 401 means "Check the selected ChatGPT account and granted scopes."
   - `docs/troubleshooting.md:256`: "For `reauthorize`, choose **Check installed account**. If it says `Needs a fresh sign-in.`, choose [Refresh ChatGPT sign-in](vps-and-n8n.md#refresh-the-chatgpt-sign-in); otherwise check that the installed account is the one you meant to use."
   - `src/ui/guide/errors.js:254`: "If it asks for a sign-in, press Check installed account, and press Refresh ChatGPT sign-in only if the panel asks for a fresh sign-in."

10. `docs/faq.md:114-118`, under "Is a VPS transfer approved by OpenAI?", should name the difference from OpenAI's guide. After "the destination is the only refresh owner after completion.", add: "When that sign-in needs renewing, Relmio makes a new registration for the same account and replaces the old one. OpenAI's guides instead repeat the sign-in with the saved client ID and the VM's own host ID."

11. Code: show **Refresh ChatGPT sign-in** only when it is needed (finding 1 and the §4 Open item). At `app.js:2109`, use `element("vps-owner-refresh-row").hidden = !(live && account.session === "reauthorize");`.

12. Code: tie the refresh to its own sign-in (finding 5). At `app.js:1428-1431`, set `newRegistrationId` only when the completed intent has no `registrationId`. In that handler's `catch`, clear `state.vpsSignInRefresh` while `newRegistrationId` is still unset. Also consider refusing, rather than warning about, a different email at `app.js:2130`, and leave deliberate account switches to **Review replacement**.

### Unknowns

- Whether a transferred VPS registration can be renewed by signing in locally with its saved client ID and the VM's host ID, then transferring the new tokens. The VMs page suggests this route, and it would keep the client's usage settings. It was not tested.
- How ChatGPT lists several Relmio connections for one account under Login connections and App limits, and whether disconnecting one affects the others.
- Which weekly limit and credit setting a new client starts with.
- What the VMs page's "revocation of ChatGPT plan access for transferred sessions are not yet available" means for the VPS sign-out's revocation request and its HTTP 200.
- Whether OpenAI accepts repeated new registrations for the same account under SIWC Terms §4.
- Whether `/v1/models` requests count toward plan usage, now that step 3 can send one automatically.
- Whether the SIWC route accepts the chat route's translated tool replay. Only the mock harness has run it.
- How long the website's host keeps request logs with IP addresses (Provisional).
- Unchanged from earlier entries: VPS token storage under §1, whether n8n and its Assistant fit "connected application only" under §2, and the image add-on's undocumented Codex sign-in.

### Changes after this review

- #106 (8c57160) applied all 12 mismatches above. Item 12 went further than suggested: a new sign-in with a different email is refused, not only warned about.
- #106 (11eb6f7): **Refresh ChatGPT sign-in** no longer starts when the installed account has no email, because the new sign-in could not be checked against it. The wizard points to **Sign out and revoke** and **Review replacement** instead. This closes the gap in finding 5 for accounts without an email. Two workspaces with the same email still cannot be told apart.
- #105 (947afb9): after GitHub and the website both fail, the wizard waits a minute before asking either again. No new recipient or data.
- A CodeRabbit security comment on #106 raised the SIWC Terms §1 storage question for the VPS transfer. It is the Open item recorded under check 1 on 2026-10-06 and is unchanged by this release.
- Release QA on the VPS found that n8n's OpenAI node sends `store:true` by default and the sidecar refused it. The sidecar now accepts `store:true` and forwards those requests with `store:false`, as SIWC models and inference requires; `previous_response_id` stays refused. Requests the sidecar used to refuse for `store:true` now reach OpenAI with the same fields as any other Responses request. No field or recipient is added.

This review is not legal advice, OpenAI approval, proof of Terms compliance or permission to use a Codex credential bridge. It is not evidence that any model, account, sign-in refresh or TTS works through Relmio. Identity sign-in, the approved permissions and model capability remain separate checks.

## Addendum: image add-on for the local sidecar

Review date: 2026-10-07.

This entry checks a planned change. The Codex image add-on, offered today only for a VPS sidecar, would also be offered for the local Docker ChatGPT plan sidecar that the `/local` dashboard installs beside a local n8n. Reviewed in `/private/tmp/relmio-local-images` (branch base `535acc6`):

- the image module and sidecar routes that the local sidecar image already ships (`src/services/codex-images.mjs`, `src/gateway/openai-oauth-sidecar.mjs`)
- the local Compose template and installer (`src/domain/local-n8n-sidecar.js`, `src/services/local-n8n-sidecar-installer.js`)
- the VPS orchestration the local version would follow (`src/services/installer.js`, `src/web/server.js`, `src/ui/index.html`), and the CLI result parser that another agent moved to `src/domain/codex-images.js` during this review
- the copy the change would make wrong (`src/ui/local.html`, `src/ui/usage-panel.js`, `README.md`, `npm/README.md`, `SPEC.md`, `docs/security.md`, `docs/faq.md`, `docs/local-endpoints.md`, `docs/local-endpoints-spec.md`, `docs/n8n-configuration.md`, `docs/troubleshooting.md`)

No local image route, dashboard control or orchestration existed when this review last checked. Statements marked [design] describe the task's design, not code. The working tree was being edited in parallel, so line numbers may move.

This review did not sign in, call a provider, read a credential, submit a form, use SSH or Docker, open a browser, build anything or run tests.

On 2026-10-06 the owner accepted the risks of the VPS add-on: OpenAI does not document the route for other apps, it may stop working, and it counts against the plan's Codex limits. That decision named the VPS. This entry does not extend it to the local sidecar. Nothing here is OpenAI approval, proof of Terms compliance, permission to use a Codex credential bridge, or evidence that image generation works from any computer or account.

Labels follow the entries above. **Confirmed** means an official OpenAI source fetched today states it. **Observed** means Relmio source shows it. **Provisional** marks evidence that is not from an OpenAI documentation page. **Open** means the reviewed evidence does not settle the question. [INFERENCE] marks consequences that were not exercised.

### Planned design

- The `/local` dashboard starts the Codex device sign-in. Relmio runs the shipped CLI inside the running, ownership-attested local sidecar with `docker compose exec -T openai-oauth node /app/services/codex-images.mjs <command>`, the same way it already reads request counts (`local-n8n-sidecar-installer.js:497-501`). The VPS runs the same five commands over SSH (`src/domain/safety.js:115-119`).
- The user opens `https://auth.openai.com/codex/device` in their own browser and enters the code.
- The Codex tokens stay in the sidecar's `siwc-store` Docker volume on this computer, under `/home/node/.relmio-siwc/codex-images/` (`local-n8n-sidecar.js:135,140`; `codex-images.mjs:89-95`).
- The local n8n sends `/v1/images/*` to the sidecar with the Relmio key, and the sidecar calls the Codex image route.
- Sign-out deletes the files and asks OpenAI to revoke the refresh token.

### Sources

All fetched on 2026-10-07. The Sign in with ChatGPT article was fetched first. Developer and learn pages were read as Markdown and show no date.

| Source | Displayed date / note |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 6 days ago; fetched first. Earlier entries today recorded 5 days ago; [INFERENCE] the relative label rolled over on the same update |
| [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | Updated: yesterday (22 minutes ago on 2026-10-06) |
| [Codex authentication](https://developers.openai.com/codex/auth) (served from `learn.chatgpt.com/docs/auth.md`): login on headless devices, device code authentication (beta), login caching, credential storage | None |
| [Codex image generation](https://learn.chatgpt.com/docs/image-generation) | None |
| [Codex pricing](https://learn.chatgpt.com/docs/pricing#image-generation-usage-limits): image-generation usage, credit rates, feature availability | None |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server): Auth endpoints and device-code login | None |
| [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source) | None |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | None |
| [SIWC Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) | None |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms, English-GB](https://openai.com/en-GB/policies/service-terms/), §6 and §15 | Updated: 29 September 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) | Published and effective January 1, 2026 |
| [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Updated: January 16, 2026. Registration and prohibited-use clauses searched |
| [Privacy policy](https://openai.com/policies/privacy-policy/) | Updated: July 30, 2026. Canonical link `/policies/services-communications-privacy-policy/` |
| [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: August 24, 2026. Date only |

Policy dates match the earlier entries.

The following sources are **Provisional** and were not refetched today:

| Source | Used for |
| --- | --- |
| `openai/codex@822e58c` and `NousResearch/hermes-agent@daefc2b`, as recorded in the 2026-10-06 image addendum | Device-flow endpoints, the Codex CLI client ID and the image route's wire format |
| Owner's VPS test, 2026-10-06 (`docs/n8n-configuration.md:287-291`) | Three images through the route on the owner's VPS; the route ignored the model ID. Never run from a local sidecar |

### What Relmio reads, stores, transmits and logs

The image module and routes are **Observed** in code the local sidecar image already ships (`local-n8n-sidecar.js:104`; `local-n8n-sidecar-installer.js:61-62`). The local orchestration is [design]. Nothing was exercised against OpenAI.

#### Reads

- Inside the local sidecar, as the image's `node` user (`local-n8n-sidecar.js:98`): `codex-images/session.json`, `pending.json` and `lock` under `N8N_OPENAI_OAUTH_HOME=/home/node/.relmio-siwc` (`local-n8n-sidecar.js:135`; `codex-images.mjs:89-107,537`). Symlinks, hard links, other owners and group or other permissions are refused (`codex-images.mjs:108-111`).
- From token responses: `email` from the ID token, `chatgpt_account_id` and `chatgpt_plan_type` from the `https://api.openai.com/auth` claim, and the access token's `exp` (`codex-images.mjs:305-312`). Each lease also reads `chatgpt_data_residency` or `chatgpt_compute_residency` and `chatgpt_account_is_fedramp` (`codex-images.mjs:367-373`). The JWTs are decoded without signature checks (`codex-images.mjs:75-87`), so these values are used only for display and routing.
- n8n requests on `/v1/images/generations` (JSON up to 64 KiB) and `/v1/images/edits` (multipart up to 48 MiB, 1 to 16 images of up to 25 MiB each), after the origin, host and Relmio key checks (`openai-oauth-sidecar.mjs:30-34,1001-1005`).
- On this computer, the Relmio dashboard process reads only the CLI's JSON line from `docker compose exec`. The shared parser caps it at 4 KiB, never reads stderr or the CLI's message, and passes on only `state`, `account`, `pending`, `outcome` and `revocation` (`src/domain/codex-images.js:1-30`). [design] The local route should then copy only checked fields to the browser, as the VPS route does (`server.js:883-905`).

#### Stores

- The sidecar's named volume `<project>_siwc-store`, mounted read-write at `/home/node/.relmio-siwc` (`local-n8n-sidecar.js:140,219-220`; mount checked at `local-n8n-sidecar-installer.js:1660-1665`). The credential-seed helper sets the volume root to `1000:1000`, mode `0700`, with no network and no logging (`local-n8n-sidecar.js:179-208`). The image folder is created `0700`, and files are written `0600` through a temporary file and rename (`codex-images.mjs:98,139`).
- `session.json`: client ID, full ChatGPT account ID, optional email and plan type, access token, refresh token, access expiry, timestamps and refresh state (`codex-images.mjs:315-318`). The ID token is not stored.
- `pending.json`: device auth ID, user code, poll interval, 15-minute expiry and next poll time (`codex-images.mjs:24,409-410`). It is deleted on success, decline, expiry, cancel and sign-out.
- `lock`: PID and creation time (`codex-images.mjs:240`).
- [design] The dashboard keeps an in-memory target and pending flag, as the VPS route does (`server.js:5782-5783`), and no token.
- Prompts, reference images and generated images stay in sidecar memory for the one request (`openai-oauth-sidecar.mjs:919-971`).

[INFERENCE] Docker Desktop on macOS and Windows keeps named volumes inside its Linux VM disk on this computer. Docker Engine on Linux keeps them under Docker's data directory, which root can read. This review did not inspect a host.

#### Transmits

| Recipient | Data | Code |
| --- | --- | --- |
| `auth.openai.com` (OpenAI), from the local sidecar | User-code request with `{client_id}` only; poll with `{device_auth_id, user_code}`; form exchange with authorization code, code verifier, client ID and redirect URI; JSON refresh with client ID and refresh token; revocation of the refresh token on sign-out, waiting up to 10 seconds. Relmio sets only `content-type` and `accept`, refuses redirects, and sends no `originator` or Relmio User-Agent on these calls | `codex-images.mjs:16-23,260-268,324-326,343,393,429,471-473` |
| `chatgpt.com/backend-api/codex/images/{generations,edits}` (OpenAI), from the local sidecar | Bearer Codex access token, `ChatGPT-Account-ID`, optional residency and FedRAMP headers, `originator: relmio`, `User-Agent: Relmio (n8n sidecar)` and a new `x-codex-image-turn-id`. Body: prompt, `model: gpt-image-2`, optional quality, size and background; edits add each image as a base64 data URL. More than one image, masks and URL responses are refused | `openai-oauth-sidecar.mjs:26-28,828-840,908,941-949` |
| The local n8n on the reviewed Docker network, and anyone holding the Relmio key | `{created, data:[{b64_json}]}` plus reported size, quality and background. Errors have the Codex token, the Relmio key and the prompt redacted. `/v1/models` lists `gpt-image-2` only while signed in, and not for requests with n8n's `openai-platform` header | `openai-oauth-sidecar.mjs:938,955-970,981-986` |
| The Relmio dashboard process and the local browser tab | [design] State, email, plan type, last six characters of the account ID, user code, verification URL fixed to `https://auth.openai.com/codex/device`, expiry, outcome and revocation result | `codex-images.mjs:199-206`; `src/domain/codex-images.js:26-28`; VPS copy at `server.js:883-905` |
| The user's browser, at `auth.openai.com/codex/device` | The user signs in and enters the code there. Relmio does not see that page | `codex-images.mjs:13` |

The sidecar publishes no host port, and Relmio refuses to manage it if a port binding appears (`local-n8n-sidecar.js:141-146`; `local-n8n-sidecar-installer.js:1554-1561,1655-1656`). The SIWC text path, its scopes and its recipients are unchanged. Image routes never use the SIWC token, and the `image_generation` tool stays refused on `/v1/responses` (`openai-oauth-sidecar.mjs:23,992-993,1005`).

#### Logs

The add-on adds no log lines. The CLI prints one JSON line without tokens, device auth ID, authorization code or verifier (`codex-images.mjs:53-62,532`). The sidecar writes to stderr only when it cannot start (`openai-oauth-sidecar.mjs:1155`), and its image errors are fixed text. [INFERENCE] `docker compose exec` output goes to the calling process, not to the container's Docker log. OpenAI's privacy policy describes its own log, usage and device data, including IP address and user agent.

#### Scopes and recipients

The device flow and refresh send no `scope`, and Relmio reads no `scope` from token responses (`codex-images.mjs:301-319,343,393`). The scopes OpenAI grants are unknown. Relmio code limits the token to image requests, but the grant is a full Codex sign-in for the account.

Recipients:

- OpenAI at `auth.openai.com` and `chatgpt.com`, and the vendors its privacy policy lists
- this computer's administrators, root and any account that can use Docker, and any backup of Docker's data, which can read `session.json`
- the local n8n and anyone who can run its workflows with the Relmio key; those runs spend the account's Codex limits
- the Relmio dashboard process and browser tab, which get status fields only

No Relmio-operated service receives anything.

### Compared with the VPS add-on

| | VPS, reviewed 2026-10-06 | Local, planned |
| --- | --- | --- |
| Token storage | `/docker/n8n-openai-oauth/siwc/codex-images` on a rented server (`safety.js:64`) | The `siwc-store` Docker volume on the user's own computer |
| Who can read the refresh token | VPS root and Docker users, [INFERENCE] the hosting provider, and backups of that folder | This computer's administrators and Docker users, and backups of Docker's data |
| How Relmio runs the CLI | Over the reviewed SSH session, under the VPS operation lock (`installer.js:1498-1540`) | `docker compose exec` on the local Docker context after ownership checks; no SSH |
| Network address OpenAI sees | The VPS | [INFERENCE] This computer's public address |
| Codex image traffic | Endpoints, headers and bodies as above | Unchanged |
| SIWC sign-out | Signs out of images first, while the sidecar still runs (`installer.js:1421-1426`) | Not yet. Local SIWC sign-out stops the sidecar before its CLI step (`local-n8n-sidecar-installer.js:2685-2688`). See finding 1 |
| Removal | Not applicable | `docker compose down --volumes` (`local-n8n-sidecar-installer.js:1680-1693`) after SIWC sign-out (`:2813-2815`). Without an image sign-out first, this deletes the tokens without asking OpenAI to revoke them |

SIWC Terms §1 says: "Any persistent storage of Authentication Tokens must be local and under the user's control, not in a remote or managed environment." The 2026-10-06 entries left the VPS design Open against this. The local volume fits the wording better, because it sits on the user's computer and publishes no port. Two limits remain. §1 defines Authentication Tokens as "SIWC access and refresh tokens", and the Codex image tokens are not SIWC tokens, so §1 is a benchmark here and does not govern them. Anyone with Docker or administrator access on the computer can still reach the files.

### Three separate checks

#### 1. Identity sign-in

**Confirmed:** The Sign in with ChatGPT article describes identity sign-in at participating partners, which releases name, email address and profile picture. It says to "Review and approve any additional permissions separately", and that subscription sharing is a separate request. The App Server page documents a Codex device-code login (`chatgptDeviceCode`) whose verification URL is `https://auth.openai.com/codex/device`.

**Observed:** The add-on does not use SIWC. It runs the Codex CLI device flow with the Codex client ID `app_EMoamEEZ73f0CkXaXp7hrann` (`codex-images.mjs:12`), so the sign-in and consent screens are Codex's. Relmio decodes email, plan type and account ID from the tokens it receives. Moving the add-on to a local sidecar changes nothing about identity.

**Confirmed and Observed:** The article does not describe this flow, and this flow does not match it. The result is a full Codex sign-in with renewable tokens.

**Open, carried over:** The image account is not compared with the SIWC account in the same sidecar (2026-10-06 mismatch 5). The local dashboard already knows the SIWC account's email, so [design] it can warn when the two differ.

#### 2. Separately approved permissions

**Confirmed:**

- No fetched source gives a third-party app permission to use a Codex sign-in or Codex image generation.
- The Codex auth page says to "Enable device code login in your ChatGPT security settings (personal account) or ChatGPT workspace permissions (workspace admin)." It prefers device code when the CLI runs "in a remote or headless environment" or when local networking "blocks the localhost callback". It says "API keys are still the recommended default for automation" and "Use API key authentication for programmatic Codex CLI workflows".
- The same page documents Codex's own credentials in a plaintext `~/.codex/auth.json`, and shows copying that file into a Docker container. That guidance is for running Codex itself, not for another app.
- The App Server page says: "If you've built a local or open-source application using Codex app-server authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT". It also says "App-server authentication has never been permitted for commercial or hosted services."
- SIWC models and inference says the plan flow must "not point it at ChatGPT's `backend-api` endpoints." SIWC Terms §2 says SIWC "does not grant extra usage or access to other OpenAI services."
- The Terms of Use and Europe Terms of Use say "You may not share your account credentials or make your account available to anyone else". They forbid automatically or programmatically extracting data or Output and circumventing rate limits, and require compliance with the "documentation, guidelines, or policies we make available to you".

**Observed:** Approval consists of the user's device approval at `auth.openai.com` and [design] Relmio's confirmation on the dashboard. The SIWC token never reaches `backend-api`. The add-on is not app-server authentication: it calls Codex's OAuth endpoints directly. The sidecar has no host port, so a browser callback on `localhost` could not reach it; device code is the flow Codex documents for that case.

**What changes locally:** Tokens and requests stay on the user's computer, and no rented server or SSH session is involved. [INFERENCE] A user's own computer is further from the "hosted services" exclusion than a VPS was.

**Open:**

- Whether OpenAI permits a third-party open-source tool to reuse the Codex CLI client ID and device flow, and whether "can continue" covers a feature added now. The owner's acceptance is not OpenAI permission.
- How "make your account available to anyone else" applies when other people can run workflows on the same n8n. The local **Set up new n8n** stack can be published through ngrok behind Basic Auth (`local.html:449`), and n8n webhooks can start workflows from outside. [INFERENCE] Any of those runs could make images on this account.
- [INFERENCE] As a non-SIWC client, the add-on has no per-app weekly limit or Disconnect entry in ChatGPT settings.

#### 3. Model and image capability

**Confirmed:**

- The Codex image page says built-in image generation "uses `gpt-image-2` and counts toward your general Codex usage limits", uses included limits 3 to 5 times faster on average, and that larger batches should use `OPENAI_API_KEY` so API pricing applies.
- The pricing page says image generation draws credits after the included limits and "isn't available on the Free plan". Its feature table lists image generation for Plus, Pro, Business, Enterprise and API keys; Go is not listed. It gives credit rates for GPT-Image-2 image and text tokens, and points to `chatgpt.com/codex/settings/usage` for current limits and reset times.
- The Codex Help article says Codex is included on Free and Go, and that ChatGPT's own image limits "do not apply to Codex".
- SIWC preview limitations list image generation as unsupported on the plan route, so this add-on remains the only image path.

**Provisional:** The `backend-api/codex/images` route and its wire format come from the Codex client and Hermes Agent source. The only live result is the owner's VPS test on 2026-10-06.

**Open:** Whether the route works from a local sidecar for a given account, plan, region or residency. No local image request was made. The `/v1/models` entry is added by Relmio and is not an OpenAI catalog result. The change adds no TTS or audio route.

### Terms and privacy

- **Confirmed:** The Codex Help article says the ChatGPT Terms of Use and Privacy Policy apply "to data shared between Codex and ChatGPT" when someone signs in to Codex with a ChatGPT account. Plus and Pro Codex content "may be used to improve models unless you turn off training"; Business, Enterprise and Edu content is not used by default.
- **Confirmed:** The privacy policy treats prompts and uploaded images as Content and collects log, usage and device data, including IP address and user agent. For a local sidecar, that is this computer's network address.
- **Confirmed:** Service Terms §6 says "You may not use Visual Capabilities to reproduce the likeness of any person without express consent and all necessary rights." The Codex image page asks users to confirm permission before depicting a real person. Edits send reference images.
- **Open:** Retention for this route. The Codex auth page ties ChatGPT sign-in to workspace retention settings, but no source covers this route for another app.
- **Open:** Whether these requests appear in the Compliance API. The Codex Help article says it covers "supported Codex clients". The App Server page asks new enterprise integrations to identify themselves and contact OpenAI. Relmio sends `originator: relmio`.

### Findings on the design

1. **Sign-out and removal must sign out of images first** (Observed). Local SIWC sign-out stops the sidecar before its CLI step (`local-n8n-sidecar-installer.js:2685-2688`), and removal deletes the volume (`:1680-1693`). Without a change, removal deletes a live refresh token without asking OpenAI to revoke it, and a later sign-in on the same store could inherit the image sign-in. The VPS runs image sign-out while the sidecar still runs (`installer.js:1421-1426`). The local path needs the same step before the stop, and removal should report the revocation result.
2. **Device code fits the container** (Confirmed and Observed). Codex documents device code for headless setups and blocked callbacks. The sidecar is headless and has no host port.
3. **Image usage is Codex usage** (Confirmed and Observed). The local panels link **Manage usage** to `chatgpt.com/settings/usage` (`usage-panel.js:7`; `local.html:1089`), the SIWC app usage page. OpenAI puts Codex limits and reset times at `chatgpt.com/codex/settings/usage`. Image requests return before Relmio counts anything (`openai-oauth-sidecar.mjs:1005`), so the local counts note must say images are not counted.
4. **Status copy** (Observed for the parser, [design] for the route). The shared parser already drops stderr and unknown fields (`src/domain/codex-images.js:11-30`). The local route should also accept only the four states, check the code format and the fixed verification URL, and never return the device auth ID, as `server.js:883-905` does.
5. **The `images_off` message names only the VPS** (Observed). `openai-oauth-sidecar.mjs:42` ships in the local image too.

### Required disclosure wording

The local panel needs the same points as the VPS panel (`index.html:465-470`), with storage described for this computer:

> Image generation uses a separate Codex sign-in, the way Hermes Agent does it. It isn't the official Sign in with ChatGPT, and OpenAI doesn't document this route for other apps, so it can stop working at any time. OpenAI recommends an API key for automation.
>
> - Images use your plan's Codex limits 3 to 5 times faster than text, then credits. Free plans can't use it. Your Codex limits are at chatgpt.com/codex/settings/usage.
> - This computer stores a full Codex sign-in for the account in the sidecar's Docker volume. Anyone with administrator or Docker access on this computer, and any backup of Docker's data, can read it.
> - Anyone who can run workflows in this n8n can make images with this account. Turn this on only if nobody else uses it.
> - Device code sign-in must be on in ChatGPT security settings, or allowed by your workspace admin.
> - Sign in with the same ChatGPT account as this sidecar. In n8n, choose the model gpt-image-2.

The Codex usage URL and the shared-n8n line go beyond the VPS panel. The usage URL is documented by OpenAI. The shared-n8n line follows the Terms of Use clause on making an account available; its application is Open.

Confirmation: "I understand. Sign in to Codex for images on this computer." Pending code: "Only enter this code at auth.openai.com. Never share it." Sign-out: "I approve signing out of images on this computer. Relmio deletes the Codex sign-in here and asks OpenAI to revoke it." Beside **Sign out of ChatGPT** and removal: "This signs out of images first and asks OpenAI to revoke that sign-in." Beside **Pause plan use**: "Pausing keeps the image sign-in. Sign out of images if you want it gone."

Other copy the change makes wrong:

| Place | Now | Required |
| --- | --- | --- |
| `openai-oauth-sidecar.mjs:42` | "On a VPS sidecar, turn it on in Relmio under Manage the installed ChatGPT session." | "Turn it on in Relmio: for a VPS under Manage the installed ChatGPT session, or for this computer in the local dashboard." The new text changes the sidecar image digest |
| `local.html:443` | "This integration does not support image generation, audio, video, Files upload, or stored conversations." | "Image generation needs a separate, optional Codex sign-in that OpenAI doesn't document for other apps. This integration does not support audio, video, Files upload, or stored conversations." |
| `usage-panel.js:34-35` and the `local` `empty` and `note` strings | The comment says the local sidecar has no image sign-in; the local strings do not mention images | Add "Image requests are not counted." to both strings, as the VPS strings do, and update the comment |
| `README.md:332,343`; `npm/README.md:370`; `SPEC.md:215-227`; `docs/faq.md:61-65,81,103`; `docs/local-endpoints.md:257-260,869-871`; `docs/local-endpoints-spec.md:115-117`; `docs/n8n-configuration.md:38,41,244-252,306-307,337-339`; `docs/troubleshooting.md:273-274` | "On a VPS", "Only on a VPS", "The local sidecar has no image sign-in", "returns `images_off`" | Say the add-on is available for a VPS sidecar and for the local sidecar, and that the local Codex refresh token is stored in the sidecar's Docker volume on this computer |
| `docs/security.md:7-9,469-471,478-521,661-663` | "Codex image add-on (VPS)" and VPS-only storage | Add a local storage line: "On this computer, the sidecar's `siwc-store` Docker volume holds the same files under `codex-images`. Administrators and Docker users on this computer, and any backup of Docker's data, can read the refresh token. Signing out of ChatGPT or removing the sidecar signs out of images first; removal then deletes the volume." |
| `CHANGELOG.md` | 0.19.0 history says VPS only | Leave the history unchanged and add a new entry |

### Unknowns

- Whether OpenAI permits a third-party open-source tool to use the Codex CLI client ID and device flow at all, on a computer or a server.
- The scopes and lifetimes OpenAI grants to device-flow tokens, and whether the stored token works beyond images.
- Whether the route accepts `originator: relmio`, needs the residency header outside the US, or works for Go, Business, Enterprise or FedRAMP accounts.
- Server-side image limits, credit use and Compliance API visibility for this route.
- Retention and training treatment of prompts and reference images on this route.
- Whether revoking this refresh token affects the user's other Codex sign-ins on the same computer, such as the Codex CLI or desktop app.
- How the Terms clauses on programmatic extraction and making an account available apply to n8n workflows that other people or webhooks can start.
- Whether the owner accepts for the local sidecar the risks accepted for the VPS on 2026-10-06.

### Changes after this review

Reviewed on 2026-10-07; applied on 2026-10-08 on `feat/local-images`.

- Finding 1: local SIWC sign-out runs the image sign-out in the running sidecar before the stop (`src/services/local-n8n-sidecar-installer.js:2687`, helper at `:2759`), and reports `imagesRevocation`. Removal runs it before `docker compose down --volumes` (`:2927`); if the step does not finish, removal stops and keeps the volume. An install without the image module skips the step.
- Finding 2: unchanged; the local add-on uses the same device-code flow.
- Finding 3: the local usage strings say image requests are not counted (`src/ui/usage-panel.js:34,46,49`), and the local panel links `chatgpt.com/codex/settings/usage` (`src/ui/local.html:1175`).
- Finding 4: the local routes at `src/web/server.js:4288` reuse the VPS copier (`:890`): the known states only, the user-code format, the fixed verification URL, and no device auth ID or token.
- Finding 5: the `images_off` message names both places (`src/gateway/openai-oauth-sidecar.mjs:42`).
- Required wording: the local panel uses the disclosure, confirmation, pending and sign-out text above, including the shared-n8n line (`src/ui/local.html:1173-1202`). The notes beside **Sign out and revoke**, **Pause plan use** and removal are at `src/ui/local.html:1152-1153,1387`, and the connection details line at `:443`. The copy table was applied to README, npm README, SPEC, the FAQ, the local endpoint guide and spec, Configure n8n, troubleshooting, and the local storage line in `docs/security.md:498`. The CHANGELOG history was left unchanged and a new Unreleased entry added.

This review is not legal advice, OpenAI approval, proof of Terms compliance or permission to use a Codex credential bridge. It is not evidence that `gpt-image-2`, any image request or TTS works through Relmio. Identity sign-in, the approved permissions and model capability remain separate checks.

## Addendum: image sign-in during sidecar install

Review date: 2026-10-08.

Reviewed the working tree in `/private/tmp/relmio-images-install`, including the image authentication module, gateway, VPS and local orchestration, and disclosures in `README.md`, `docs/security.md`, `docs/faq.md`, `src/ui/index.html` and `src/ui/local.html`. This follows the [2026-10-06 Codex image review](openai-source-check-2026-10-06.md#addendum-codex-login-image-add-on) and the local-sidecar addendum above.

Implementation was changing during this review. The local install checkbox and startup handler, and the VPS install backend, were present in the later snapshot. The VPS review and Ready controls were still pending in the UI snapshot read. File references describe those snapshots and may move. Planned behavior is identified below rather than reported as tested behavior.

No sign-in, provider API call, form submission, credential access, SSH or Docker operation, browser session, build or test was performed. No files were edited.

Labels: **Confirmed** means an official OpenAI source fetched today states it. **Observed** means the inspected Relmio source shows it. **Open** means the evidence does not settle the question. Recommendations and unexercised consequences are marked **Open [assessment]** or **Open [design]**. Prior third-party implementation evidence remains **Provisional** and was not refetched or used as OpenAI authorization.

### What changed

- **Open [design]:** Offer **Image generation (optional)** during sidecar install review, unchecked by default and separate from install approval, ChatGPT identity sign-in and permission for background n8n use. After a verified install, an opted-in user receives the Codex device code on Ready. An unticked install must not start image sign-in. Image-sign-in failure must not turn a successful install into a failed install.
- **Observed:** Local review has a separate checkbox without a `checked` attribute. The existing disclosures precede it. JavaScript clears it when invalidating or rendering a plan and captures its value only for the n8n sidecar. `startInstallImages` requires verified readiness, a running runtime, no finalization failure, a non-partial deployment and an owned account. It then calls the existing image status and login-start routes, catches image errors separately, and reuses the pending-code renderer and polling (`src/ui/local.html:884-910`; `src/ui/local.js:3184-3186,3442-3444,5022,5148,2334-2362,2225-2283`).
- **Observed:** VPS `/api/install` now requires a separate Boolean `imagesConsent`. Only true enters the image branch, after install-result validation. That branch checks a running, non-partial runtime without finalization failure, checks image status and starts login when status is `off`. It adds a sanitized image result or fixed image-failure message to the install response. SSH remains attached only when that returned image state is pending; otherwise the install handler detaches (`src/web/server.js:6120-6224`).
- **Open:** In the inspected VPS branch, the image gate checks runtime and finalization but does not explicitly check `readiness === "verified"`, unlike the local handler. The parent must resolve whether this meets the task's verified-install criterion before acceptance. The VPS UI wiring and complete terminal-state cleanup were not yet available for this review.
- **Observed:** The gateway still appends `gpt-image-2` only when the image store reports `signed-in`, and only when the model-list request lacks `openai-platform`. This is a Relmio-created entry, not an OpenAI image-capability probe (`src/gateway/openai-oauth-sidecar.mjs:972-986`). **Open [assessment]:** That explains why a fresh unsigned-in add-on can provide no image choice. This review did not reproduce n8n's picker or establish that every empty picker has that cause.

### Sources with retrieval dates

Every source below was retrieved on **2026-10-08**. The Sign in with ChatGPT Help Center article was fetched first. Developer and learn pages showed no publication or update date. Relative dates are recorded as displayed, without converting them to an inferred timestamp.

| Official source | Displayed publication or update date | Retrieval date |
| --- | --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 6 days ago; fetched first | 2026-10-08 |
| [Codex authentication](https://developers.openai.com/codex/auth), served as [Authentication](https://learn.chatgpt.com/docs/auth), including headless device-code login, caching and credential storage | None | 2026-10-08 |
| [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | Updated: 5 hours ago | 2026-10-08 |
| [Codex image generation](https://learn.chatgpt.com/docs/image-generation) | None | 2026-10-08 |
| [Codex pricing](https://learn.chatgpt.com/docs/pricing), image usage and feature availability | None | 2026-10-08 |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server), Auth endpoints | None | 2026-10-08 |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | None | 2026-10-08 |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | None | 2026-10-08 |
| [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) | None | 2026-10-08 |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 | 2026-10-08 |
| [Service Terms, English-GB](https://openai.com/en-GB/policies/service-terms/), especially §§1, 3, 6 and 15 | Updated: 29 September 2026 | 2026-10-08 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) | Published and effective January 1, 2026 | 2026-10-08 |
| [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Updated: January 16, 2026 | 2026-10-08 |
| [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) | Updated: December 1, 2025; effective January 1, 2026 | 2026-10-08 |
| [Privacy policy](https://openai.com/policies/privacy-policy/) | Updated: July 30, 2026; returned canonical URL is `/policies/services-communications-privacy-policy/` | 2026-10-08 |
| [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: August 24, 2026 | 2026-10-08 |

**Confirmed:** The Codex Help article says ChatGPT Terms of Use and Privacy Policy, or the corresponding services agreement for the named business offerings, apply to data shared between Codex and ChatGPT. The Services Agreement expressly covers APIs, ChatGPT Enterprise, ChatGPT Business and other specified business/developer services; it is not a blanket consumer agreement. Its API integration permission does not itself establish permission for this Codex credential bridge.

### What Relmio reads/stores/transmits/logs

#### Reads

- **Observed:** The added input is the independent image choice. VPS receives `imagesConsent` in the install request. Local code reads the checkbox and later sends `confirmed:true` to the existing image action route. These are Relmio approvals, not new OAuth scopes (`src/web/server.js:6124-6129,6194`; `src/ui/local.js:5022,5148,2351-2355`).
- **Observed:** The image module continues to read its own `session.json`, `pending.json` and lock state. It decodes email, full ChatGPT account ID, plan type, expiry, residency and FedRAMP claims from token responses or stored access tokens. JWT payload decoding here does not verify signatures (`src/services/codex-images.mjs:75-87,89-131,158-208,301-318,367-373`). This change adds no ChatGPT conversation, memory, billing or file read.
- **Observed:** The gateway reads image-generation prompts and options, or image-edit multipart bodies, after bearer and image-lease checks. Limits remain 64 KiB for generation JSON, 48 MiB for an edit body, up to 16 input images and 25 MiB per input image (`src/gateway/openai-oauth-sidecar.mjs:30-34,828-840,904-908,919-938,1001-1005`).

#### Stores

- **Observed:** `session.json` holds the Codex client ID, full account ID, optional email and plan type, access token, refresh token, expiry, timestamps and refresh state. It does not persist the ID token. `pending.json` holds the device auth ID, user code, provider polling interval, a locally imposed 15-minute expiry and next-poll time. The folder is `0700`; files are written `0600` using a temporary file and rename, with ownership and link checks (`src/services/codex-images.mjs:24,89-149,158-170,301-318,405-412`).
- **Observed:** Local storage is the sidecar's named `siwc-store` Docker volume mounted at `/home/node/.relmio-siwc`; image records sit under `codex-images` (`src/domain/local-n8n-sidecar.js:135-140,219-220`). VPS storage is a **bind mount**, not that named volume: `/docker/n8n-openai-oauth/siwc/codex-images` (`src/domain/safety.js:64`; `src/domain/templates.js:38-43`). Moving consent does not change either location.
- **Observed:** Relmio keeps target, container, registration and pending-state records in server memory. The VPS install response now carries the same sanitized image-status fields already used by management. No new persistent image-consent record is written in these handlers (`src/web/server.js:890-914,4288-4325,6206-6209`). The local checkbox and selected choice remain page/request state (`src/ui/local.js:3184-3186,3442-3444,5022,5148`).
- **Observed:** Prompts, reference images and generated images are processed in gateway memory for the request; this image path has no file-writing call (`src/gateway/openai-oauth-sidecar.mjs:919-970`). **Open:** n8n execution-history retention, host swap, backups and administrators' copies were not inspected.

#### Transmits and receiving parties

| Recipient | Data and change | Evidence |
| --- | --- | --- |
| **Observed:** OpenAI authentication, `auth.openai.com`, from the sidecar | Existing device-code request with Codex CLI client ID `app_EMoamEEZ73f0CkXaXp7hrann`; polling with device auth ID and user code; authorization-code exchange with verifier and redirect URI; access-token refresh; refresh-token revocation. Opting in now initiates this after installation instead of a later management action. | `src/services/codex-images.mjs:12-23,260-268,320-345,385-443,459-476` |
| **Observed:** OpenAI, `chatgpt.com/backend-api/codex/images/generations` or `/images/edits` | Existing Codex access-token bearer, account ID, optional residency/FedRAMP headers, `originator: relmio`, `User-Agent: Relmio (n8n sidecar)`, random image-turn ID, prompt, `gpt-image-2`, supported options and base64 reference images for edits. Install sign-in itself does not generate a test image. | `src/gateway/openai-oauth-sidecar.mjs:26-28,828-840,908,941-949`; install path `src/web/server.js:6194-6218`; local path `src/ui/local.js:2334-2362` |
| **Observed:** Local Relmio server and browser | Consent choice, account/status fields, email, plan type, last six account-ID characters, user code, fixed verification URL, expiry, outcome and revocation result. No provider token, device auth ID, authorization code or verifier is included in the copied status. | `src/domain/codex-images.js:11-30`; `src/web/server.js:890-914,4288-4325,6206-6219`; `src/services/codex-images.mjs:199-208` |
| **Observed:** Reviewed VPS and its sidecar, over SSH | Fixed image CLI commands and their bounded status output. The existing authenticated SSH connection now survives successful install while image approval is pending. Code exchange and token storage still happen inside the sidecar; Codex tokens do not travel back through status output. | `src/services/installer.js:1499-1543`; `src/web/server.js:6194-6223` |
| **Observed:** Local Docker daemon and owned sidecar | Existing `docker compose exec -T ... codex-images.mjs` commands and status output. No SSH is added to local installation. | `src/services/local-n8n-sidecar-installer.js:2780-2853` |
| **Observed:** n8n and other callers holding the Relmio key | Existing model listing and generated-image response `{created, data:[{b64_json}]}`, with supported reported options or sanitized errors. There is no per-n8n-user identity check in the image route. | `src/gateway/openai-oauth-sidecar.mjs:938-986,1001-1005` |
| **Observed:** User's browser to OpenAI's device page | Link opens `https://auth.openai.com/codex/device`; user completes OpenAI sign-in and enters the code there. Links use `noopener noreferrer`. Relmio does not collect the password through these controls. | `src/services/codex-images.mjs:13`; `src/ui/index.html:479-486`; `src/ui/local.html:1188-1195` in the initial UI snapshot |

- **Observed:** Image code sends no data to a Relmio-operated service or Hermes Agent. Hermes is mentioned as implementation provenance, not a recipient (`src/services/codex-images.mjs:16-21,260-268`; `src/gateway/openai-oauth-sidecar.mjs:26,941-949`).
- **Observed:** Existing disclosure says host administrators and Docker users can read the stored sign-in; backups can contain it (`docs/security.md:492-506`). **Open [assessment]:** A VPS hosting operator with host/storage access can also access it. Actual host, backup and audit arrangements are deployment-specific and were not inspected.
- **Confirmed:** OpenAI's privacy policies describe content, account, log, usage, device and IP/location processing. They name downstream categories including vendors/service providers, affiliates, applicable business-account administrators, legal/safety recipients and transaction successors. These are policy-described potential recipients, not proof that every category receives every Relmio request. OpenAI sees the sidecar host's connection for sidecar requests and the user's browser connection for browser sign-in.
- **Observed:** Existing SIWC text and model-discovery recipients remain separate: `api.openai.com` and the npm registry used for Codex-version discovery. The image move adds neither a new discovery destination nor an image-prompt transmission to npm (`src/services/model-discovery.mjs:26-28`; `src/gateway/openai-oauth-sidecar.mjs:992-1008`).

#### Logs and scopes

- **Observed:** The image CLI prints a JSON result to stdout. Pending results include the user-facing device code, so it would be inaccurate to say that no code ever leaves the sidecar process. Provider tokens and internal device IDs are omitted. The caller accepts at most 4 KiB and discards the CLI's message and stderr; the web copier validates the browser-visible fields (`src/services/codex-images.mjs:199-208,519-533`; `src/domain/codex-images.js:1-30`; `src/web/server.js:890-914`).
- **Observed:** Inspected image handlers add no persistent application log. Gateway startup failure still writes fixed text to stderr; image errors use fixed or sanitized responses (`src/gateway/openai-oauth-sidecar.mjs:938-970,1155`). **Open:** SSH, Docker, hosting, browser tooling and n8n may have independent logging. Keeping SSH attached does not prove those systems record nothing.
- **Observed:** The device-code request, code exchange and refresh send no `scope`; `sessionFrom` does not read a granted-scope field (`src/services/codex-images.mjs:301-345,393`). **Open:** Granted Codex scopes and the credential's usable authority outside Relmio remain unknown. Relmio's images-only routing is not an OAuth-enforced images-only grant.
- **Observed:** SIWC scopes remain `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`. Plan-permission authorization still uses `prompt=consent`. The new image checkbox changes neither (`src/services/oauth.js:10-11,204-210`).

### Three separate checks

#### 1. Identity sign-in

**Confirmed:** The [Help Center article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) describes participating-app identity sign-in sharing name, email and profile picture. Other permissions require separate authorization; identity sign-in can finish without subscription sharing. Identity alone does not share files, tokens, conversations or memory.

**Observed:** This add-on uses the Codex CLI client ID and Codex device flow, receives renewable credentials, and stores account information beyond the article's identity-only release (`src/services/codex-images.mjs:12-23,301-345,385-443`). Relmio's existing SIWC plan flow also requests plan and offline scopes separately from this add-on (`src/services/oauth.js:10-11`).

**Open [assessment]:** Placing images inside **ChatGPT plan sidecar** onboarding makes that distinction easier to miss. The review must explicitly identify a separate Codex sign-in and must not present the checkbox as enabling an image permission within SIWC. Successful Codex sign-in does not establish that Relmio is a participating SIWC partner or that the two flows use the same account.

#### 2. Separately approved permissions

**Confirmed:** The article requires separate review of additional permissions. [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) require express consent for background use, user-controlled requests for the authenticated user, use only for the connected application, an adequate notice before processing, and no misleading interaction or implied endorsement. They expressly say SIWC does not grant access to other OpenAI services.

**Open [assessment]:** A separate, explicit, unchecked checkbox at review can preserve **Relmio's user-consent boundary** without adding another identical checkbox on Ready, provided:

- Its notice appears before the choice and names Codex, storage destination, usage consequences and shared-n8n risk.
- Installation works with the checkbox unchecked, and neither install approval nor SIWC/background-use approval selects it.
- The choice applies only to the reviewed account and destination, resets on a changed review, and starts only the disclosed post-install device flow.
- OpenAI's device-page approval still occurs separately. The checkbox does not claim to grant an images-only OAuth permission.
- Ready distinguishes installed sidecar, pending sign-in and signed-in add-on, with cancel and truthful failure/status handling.

No fetched source certifies that this checkbox is legally sufficient or authorizes Relmio's underlying Codex bridge. User consent cannot supply OpenAI's permission.

**Confirmed:** [Codex authentication](https://learn.chatgpt.com/docs/auth) documents device login for Codex on headless machines, requires enabling it in personal security settings or workspace permissions, and recommends API keys for automation. [App Server](https://learn.chatgpt.com/docs/app-server) allows existing local/open-source app-server-auth integrations to continue, recommends SIWC, and says app-server authentication has never been permitted for commercial or hosted services.

**Observed:** Relmio directly implements the device endpoints and image request rather than using that documented app-server authentication interface (`src/services/codex-images.mjs:16-21,385-443`; `src/gateway/openai-oauth-sidecar.mjs:941-949`). **Open:** The app-server statement does not settle permission to reuse the Codex CLI client ID and direct image route, or the classification of this self-hosted VPS arrangement.

**Confirmed:** Consumer Terms prohibit sharing account credentials or making an account available to anyone else, programmatic extraction, and bypassing restrictions. Services Agreement §§3.1-3.3 prohibit sharing individual credentials between users, restrict extraction to what the Services permit, and prohibit bypassing limits. **Open:** Their application to this direct route and workflows triggered by other users or public webhooks remains unresolved.

**Confirmed:** SIWC Terms §1 restrict persistent storage of defined SIWC access/refresh tokens to local user-controlled storage, not a remote or managed environment. **Open:** That pre-existing VPS SIWC issue remains unresolved. Do not automatically apply the clause to the separate Codex tokens or claim that the checkbox cures either issue.

#### 3. Model/image capability

**Confirmed:** [Codex image documentation](https://learn.chatgpt.com/docs/image-generation) names `gpt-image-2` for built-in Codex images. [Pricing](https://learn.chatgpt.com/docs/pricing) says image turns use included limits about 3 to 5 times faster on average than comparable non-image turns, depending on quality and size, then draw credits after included limits. Images are unavailable on Free; the feature table lists Plus, Pro, Business, Enterprise and API keys. General Codex availability on Free and Go is not proof of image availability.

**Confirmed:** [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) list image generation as unsupported. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) explicitly says not to point SIWC plan inference at ChatGPT `backend-api` endpoints.

**Observed:** The image path uses a separate Codex lease; it does not use the SIWC bearer. The Responses `image_generation` tool remains refused. The `gpt-image-2` list entry is conditional on stored sign-in status, not an actual image request (`src/gateway/openai-oauth-sidecar.mjs:23,919-949,972-1008`).

**Open:** Built-in Codex capability documentation and a completed device login do not establish that this direct route works for the current account, plan, region or workspace. The move adds no image test, TTS route or audio capability evidence.

### Findings on the change

1. **Observed and Open [assessment]: Consent separation is preserved locally at source level.** The local checkbox is independent and resets with review. The VPS backend also treats the choice as a separate Boolean. This supports the planned interaction, not Terms compliance. Final VPS UI and behavior still require parent verification.
2. **Observed and Open [assessment]: Existing disclosure is mostly reusable, but its action wording needs timing.** Both old panels distinguish Codex from SIWC and disclose unsupported third-party routing and credential storage. The new local label says “Also turn on image generation” even though installation only starts sign-in (`src/ui/local.html:899-909`). Say “start Codex sign-in after installation” instead. Avoid implying capability is already on when the checkbox is selected.
3. **Observed and Open [assessment]: Preserve the shared-n8n warning on both destinations.** Local copy says anyone running workflows can use the account; the inspected VPS image block omits it (`src/ui/local.html:1177` in the initial snapshot; `src/ui/index.html:465-471`). The same bearer-only gateway serves both. Copy the warning into VPS install review too. This warning does not technically enforce single-user use.
4. **Observed and Open [assessment]: Explain SSH retention without claiming an exact cleanup guarantee yet.** The new VPS install branch retains the authenticated connection for pending sign-in. Existing polling detaches when a successful status response stops being pending (`src/web/server.js:5820-5841,6207-6223`). However, the inspected route sets immediate detach for sign-out and terminal polling, not login-cancel or every polling exception. The existing owner UI also stops polling on an error without disconnecting in that catch (`src/ui/app.js:2230-2250`). Idle expiry exists (`src/web/server.js:1138-1167`). The parent must check the new Ready cancel/error/leave paths before saying SSH stays attached *only* while pending in every case.
5. **Observed and Open [assessment]: Ready must distinguish installation from image status.** Existing “Images on” reports stored sign-in, not a capability test (`src/ui/local.js:2247`; `src/gateway/openai-oauth-sidecar.mjs:985-986`). Prefer “Codex image sign-in complete” and “Image generation has not been tested.” On unknown polling outcomes, say status could not be checked, not that images are definitely off.
6. **Observed and Open [assessment]: Documentation needs the new entry point, not new provider claims.** `README.md:332-337` gives only post-install management steps; `docs/faq.md:80-84` introduces the installed add-on; `docs/security.md:484-535` describes the existing separate sign-in. Add the review checkbox and Ready flow, keep later management/retry/sign-out instructions, and document retained VPS SSH. Keep the existing storage, revocation and uncertainty disclosures.
7. **Confirmed and Open [assessment]: Tighten cost wording.** Existing “3 to 5 times faster than text” is broader than OpenAI's comparison with similar turns without image generation. Use “about 3 to 5 times faster on average than similar turns without images.” Link **Codex usage** to `https://chatgpt.com/codex/settings/usage`; do not imply the SIWC app limit controls this separate route.
8. **Confirmed and Open:** Privacy obligations are unchanged, but moving approval earlier moves the notice boundary. Prompts/reference images are Content under OpenAI's policies. Service Terms §6 requires consent and rights for reproducing a person's likeness. The Codex Help article describes ChatGPT training controls and business defaults; it does not establish this undocumented route's exact retention or Compliance API coverage. Do not promise zero retention, API data handling or no training for this route.

### Required wording

**Open [assessment]:** Exact proposed strings below describe the intended behavior and preserve the source boundaries. They are recommendations, not quotations or OpenAI approval. Keep risk, storage and usage text next to the checkbox inside the optional group. Do not move them exclusively to Ready or a distant document.

Review heading:

> Image generation (optional)

Review introduction:

> Uses a separate Codex sign-in, not the sidecar's Sign in with ChatGPT permission. OpenAI does not document this image route for other apps, so it may stop working. OpenAI recommends an API key for automation.

Timing and optionality:

> Leave this unchecked to install without image sign-in. If selected, Relmio starts Codex sign-in after installation. You still approve it on OpenAI's page.

Usage:

> Images use your Codex limits about 3 to 5 times faster on average than similar turns without images, then credits. Free plans cannot use them.

Link label and destination:

> Codex usage

`https://chatgpt.com/codex/settings/usage`

VPS storage:

> This server stores a full Codex sign-in, including a refresh token. Root users, Docker users and backups can access it.

Local storage:

> This computer stores a full Codex sign-in, including a refresh token, in the sidecar's Docker volume. Administrators, Docker users and backups can access it.

Shared-n8n warning, both destinations:

> Anyone who can run workflows in this n8n can use your account for images. Turn this on only if nobody else uses it.

Device prerequisite:

> Device code sign-in must be enabled in ChatGPT security settings or allowed by your workspace admin.

Account choice:

> Use the same ChatGPT account as this sidecar. Relmio does not verify that the accounts match.

Data disclosure, with links to Relmio security documentation and OpenAI's applicable privacy policy:

> Image requests send your prompt and any reference images to OpenAI. Review the data handling and privacy notices before continuing.

VPS checkbox:

> I understand. After installation, start Codex sign-in for images on this server.

Local checkbox:

> I understand. After installation, start Codex sign-in for images on this computer.

VPS review connection notice:

> Relmio keeps the SSH connection open while you complete image sign-in.

Ready pending heading:

> Sidecar installed. Image sign-in pending.

Ready pending instructions:

> Open the Codex sign-in page and enter this code. Only enter it at auth.openai.com. Never share it.

Ready link:

> Open the Codex sign-in page

`https://auth.openai.com/codex/device`

Ready expiry and polling, substituting the displayed expiry time:

> Code expires at {time}. Relmio checks every 5 seconds.

VPS pending notice:

> SSH is still connected for image sign-in. Keep this Relmio tab open until you finish or cancel.

Cancel action:

> Cancel image sign-in

Ready after confirmed sign-in:

> Codex image sign-in complete. In n8n, choose gpt-image-2. Image generation has not been tested.

Ready after a known image-start failure on an otherwise verified install:

> Sidecar installed. Image sign-in did not start. You can try again from the sidecar's Image generation controls.

Ready after a polling error:

> Sidecar installed. Image sign-in status could not be checked. Check image generation before trying again.

Ready after confirmed cancellation or expiry with no existing image session:

> Sidecar installed. Image generation is off. You can sign in for images later.

**Open [assessment]:** Show the signed-in account label alongside completion. Do not use “Sidecar installed” for a partial or unverified installation, do not report “SSH disconnected” before detachment is confirmed, and do not reuse “Image generation is off” for an unknown outcome or a retained existing image session. A separate cancellation is not revocation of an already completed sign-in.

### Unknowns

- **Open:** Whether OpenAI permits Relmio to use the Codex CLI client ID, direct device endpoints and direct image route on a local computer or VPS. The fetched Help, authentication, app-server and capability pages do not resolve this combination.
- **Open:** Whether the planned checkbox and notice meet all applicable legal consent requirements. They can separate Relmio actions but cannot replace OpenAI authorization, workspace approval or applicable Terms.
- **Open:** Final VPS review/Ready implementation, verified-readiness gating, target changes, unticked behavior, and SSH cleanup after completion, cancellation, expiry, errors or leaving Ready. Only source inspection occurred; implementation was still in progress.
- **Open:** Device-flow granted scopes, full token authority, token lifetimes, and whether image revocation affects other Codex sessions. Moving the checkbox changes none of these unknowns.
- **Observed and Open:** The UI requests the same account, but the image session stores and uses its own account ID without comparing it to the SIWC registration (`src/services/codex-images.mjs:301-318`; `src/services/installer.js:1514-1543`; `src/services/local-n8n-sidecar-installer.js:2782-2853`). Account matching is not established by install success.
- **Open:** Actual image access, limits and credit treatment for each account, plan, region, residency or FedRAMP setting. A local `/v1/models` entry does not settle these.
- **Open:** Exact OpenAI retention, training and Compliance API behavior for Relmio's direct image route, plus deployment-specific n8n history, host logging, hosting-provider access and backups.
- **Open:** How account-sharing, programmatic-extraction, connected-application and hosted-service restrictions apply to this n8n bridge, especially shared instances and externally triggered workflows.

This review is not legal advice, OpenAI approval, proof of Terms compliance or permission to use a Codex credential bridge. It does not prove image or TTS capability. Identity sign-in, separately approved permissions and model/image capability remain separate checks.

### Changes after this review

Applied on 2026-10-08 on `feat/images-in-install`, before merge:

- The VPS image branch now also requires `readiness === "verified"`, like the local flow (`src/web/server.js` `/api/install`).
- SSH is detached on every exit from a pending install-time sign-in: a poll that leaves `pending`, `login-cancel`, a poll error on the Ready step, and leaving the page (`pagehide` sends `/api/disconnect`). The idle expiry still applies. **Cancel image sign-in** in the existing VPS image panel now also detaches, so the panel returns to **Check your server**.
- The review group and Ready strings use the wording in "Required wording" above, including the shared-n8n warning on the VPS review, the timing wording ("After installation, start Codex sign-in…"), the usage comparison with similar turns without images and the **Codex usage** link. Ready reports "Codex image sign-in complete … Image generation has not been tested." rather than "Images on".
- The existing post-install image panels keep their wording; finding 7's usage wording is applied only to the new review group so far.
- Layout, to keep each step on one screen (`DESIGN.md`): the review group is a closed **Image generation (optional)** disclosure in the plan body, and its notice and warnings sit above the checkbox inside it, so the box cannot be ticked without opening the notice. On the VPS Ready step, a status line stays visible and the code, link and **Cancel image sign-in** sit in an **Enter the Codex sign-in code** disclosure. On the local Ready step, the existing **Image generation** block stays closed and its summary repeats the status ("… Open to see the code."). The required wording is unchanged.
- Docs updated: `README.md`, `npm/README.md`, `docs/vps-and-n8n.md`, `docs/local-endpoints.md`, `docs/troubleshooting.md` (new row for an empty n8n image **Model** list) and `CHANGELOG.md`.

## Addendum: Windows sign-in launch (#115)

Check date: **2026-10-09**. Read-only source review of PR #116 (branch `fix/windows-chatgpt-signin-launch`). No sign-in, credentials, provider API calls, Windows execution or tests.

### What changed

**Observed:** Windows authorization now uses the system `cmd.exe` with `/d /s /c start "" "<url>"`, verbatim arguments and a hidden launcher window. Authorization URLs are validated and quoted; raw percent signs not followed by two hexadecimal characters are rejected. The private dashboard handoff file still uses Explorer. Authorization launch fails on a nonzero exit, signal, spawn failure or Windows launcher timeout (`src/browser.js:34-52,107-110,136-214`).

### Sources with retrieval dates

All sources retrieved **2026-10-09**. The Help Center identity article was fetched first. Dates below reproduce the pages' displayed dates rather than inferring publication dates.

| Official source | Displayed publication or update date |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 7 days ago |
| [SIWC registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | None |
| [SIWC accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | None |
| [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) | None |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | None |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | None |
| [Codex authentication](https://developers.openai.com/codex/auth), returned as [Authentication](https://learn.chatgpt.com/docs/auth) | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms](https://openai.com/policies/service-terms/), especially §15 | Updated: September 29, 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) | Published and effective: January 1, 2026 |
| [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Updated: January 16, 2026 |
| [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) | Updated: December 1, 2025; effective: January 1, 2026 |
| [Privacy policy](https://openai.com/policies/privacy-policy/), returned canonical `/policies/services-communications-privacy-policy/` | Updated: July 30, 2026 |
| [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: August 24, 2026 |

### What Relmio reads/stores/transmits/logs

- **Observed, reads:** Existing registration, issued client ID, host identity, OpenAI discovery/JWKS, callback code/state and token response. ID-token signature, issuer, audience, expiry, nonce and returning subject are checked. No new password, cookie, conversation, memory or file access is introduced (`src/services/oauth.js:53-76,102-174`; `src/services/siwc-session.mjs:619-655`).
- **Observed, stores:** Per-attempt state, nonce, PKCE verifier and callback URI remain in memory. Existing persistent storage remains `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth`, with `host.json` and `registrations/<registrationId>.json`. Records retain verified issuer/subject/email, client and owner identities, granted scopes, expiry, and access/refresh/ID tokens when returned. Files use atomic owner-only writes, including Windows ACL checks (`src/services/oauth.js:72-98`; `src/services/siwc-session.mjs:59-69,78-165,410-421,547-596`). The launch change adds no credential store.
- **Observed, scopes:** `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; resource `https://api.openai.com/v1`. Plan authorization still adds `prompt=consent` (`src/services/oauth.js:10-11,204-210`).
- **Observed, recipients:** Windows `cmd.exe` and the user's default browser receive the authorization URL. OpenAI's `auth.openai.com` receives authorization parameters and the subsequent form-encoded code exchange, including the verifier. The browser returns the code to Relmio's loopback listener. Relmio's dashboard receives only launch mode and attempt ID, followed by sanitized status (`src/browser.js:143-172`; `src/services/oauth.js:102-174,190-213`; `src/web/server.js:3831-3916`). No new Relmio-hosted recipient or model request is added by this launch change.
- **Observed, logs:** Launcher stdio is ignored; OAuth errors use fixed or allowlisted fields rather than endpoint bodies. No authorization URL is returned as a dashboard link or printed by these paths (`src/browser.js:160-172`; `src/services/oauth.js:17-34,215-222`; `src/ui/app.js:1395-1396`; `src/web/server.js:3913-3916`). **Open:** The URL necessarily reaches the system browser and launcher arguments. Browser history, operating-system process inspection and administrator logging are outside this guarantee.
- **Confirmed:** OpenAI's identity article and privacy policies describe account, authorization, IP, browser/device, usage and security processing. Policy-described downstream recipients include service providers, affiliates, relevant business administrators and legal/safety recipients. This is not evidence that each recipient receives each request. The applicable business agreement governs business-offering content rather than the consumer privacy policy alone.

### Three separate checks

#### 1. Identity sign-in

**Confirmed:** The identity Help article describes name, email and profile-picture sharing. Additional permissions require separate approval. The OSS sign-in documentation expressly calls for the **system browser**, an HTTP callback on **127.0.0.1**, fresh state/nonce/PKCE, `S256`, and the exact same callback URI in authorization and exchange.

**Observed:** Relmio still opens an external system browser, not an embedded webview. The listener starts first on an ephemeral `127.0.0.1` port at `/auth/callback`; callback host and state are checked, state is consumed before exchange, and the verifier and exact redirect URI go to the token endpoint (`src/services/oauth.js:72-76,102-150,190-213`). Changing the Windows dispatch executable changes none of those protocol values or checks.

**Observed:** Relmio requests renewable plan-use authority as well as identity. Its full flow therefore exceeds the Help article's identity-only description. Its separate plan controls and disclosures remain necessary (`docs/faq.md:15-26`; `README.md:223-233`).

#### 2. Separately approved permissions

**Confirmed:** SIWC Terms require authorized token handling, express consent for background use, requests for the authenticated user, and connected-application-only use. Successful browser launch or login supplies none of these approvals by itself.

**Observed:** The launcher adds no scope, grant, background consent or account-sharing permission. Existing granted-scope and local plan-enable checks remain (`src/services/siwc-session.mjs:547-611`). Codex authentication documentation does not turn this SIWC launch fix into permission for a Codex credential bridge.

#### 3. Model/image capability

**Confirmed:** SIWC inference uses the selected account's catalog and public Responses endpoint, with `store:false` and `stream:true`. Preview limitations exclude image generation and several other features.

**Observed:** This diff changes browser dispatch and launch failure text, not inference. Launcher exit zero is neither completed OAuth nor model admission. No model, image or TTS capability was exercised or established.

### Findings

1. **Observed and Open [assessment]:** No new conflict with the documented system-browser, loopback, PKCE or state requirements was identified in the launch change. This is source evidence, not proof that Windows preserves every argument or opens every default browser correctly.
2. **Observed:** The new failure text is: “The ChatGPT sign-in browser could not start. Check the default browser, then try again.” It gives a local recovery step without disclosing the URL, implying consent or recommending weaker browser security (`src/services/oauth.js:215-222`).
3. **Observed and Open [assessment]:** That message also covers failures inside the listener/launch setup block. Checking the default browser is advice, not a proven diagnosis. A successful `start` dispatch still cannot prove the browser loaded OpenAI's page.

### Required wording

Keep the new failure text above. No additional README, FAQ or security wording change is required solely for this launcher change. Describe URL handling as “Relmio does not display or log the authorization URL.” Do not claim the URL never reaches the browser or operating system.

### Unknowns

**Open:** Actual Windows/default-browser behavior, exact command-line preservation and callback completion were not exercised. OpenAI eligibility, workspace policy, granted permissions, connected-application interpretation and inference capability remain independent. This review is not legal advice, OpenAI approval or proof of Terms compliance.

### Changes after this review

Applied on 2026-10-09 on `fix/windows-chatgpt-signin-launch` before merge:

- **Observed:** CI run 37904056265 on `windows-latest` launched a stand-in browser through `cmd.exe` `start`. The full authorization URL arrived as one argument with every `&` and `%3A` escape intact. That test then recorded the script path too and was corrected.
- **Observed, changed after review:** `cmd.exe` expands `%NAME%` in its command text, so a variable named `3A` or `2F` could have rewritten `%3A%2F` in `redirect_uri`. The URL is no longer in the command text. It travels in the launcher's `RELMIO_BROWSER_TARGET_0` environment variable and is read with delayed expansion: `/d /v:on /s /c start "" "!RELMIO_BROWSER_TARGET_0!"`. That expansion runs after `cmd` has parsed the line, so `%`, `&` and `!` in the URL are not interpreted. URLs containing `"` or control characters are still rejected. The percent-sign rule above no longer applies. The native Windows test now defines `3A` and `2F` and checks that the URL arrives unchanged.
- **Observed, recipients:** Unchanged. `cmd.exe` and the default browser receive the URL, now through the inherited environment instead of the command line. Relmio still does not display or log it. Same-user process inspection can read either.
- **Open:** A real Windows 11 sign-in still has to confirm that `start` opens the default browser and the callback completes.

## Addendum: one-click local n8n stack with add-on credentials

Check date: **2026-10-09**. Read-only source review of branch `feat/local-stack-seamless`. References describe the inspected working-tree snapshot. No files edited, Docker run, sign-in completed or provider API called. No shell device was available to obtain the uncommitted `git diff`; implementation and disclosures were read directly.

### What changed

**Observed:** New stacks default to loopback-only n8n. ngrok requires an unchecked opt-in. The template pins n8n 2.42.5 and gives long-running services `restart: unless-stopped`; the certificate initializer remains a one-shot service. Ready offers separately reviewed add-ons with the owned n8n and network preselected. Importable credentials cover ChatGPT, local model and SuperGrok, not Assistant tools (`src/ui/local.html:683-690,1117-1137`; `src/ui/local.js:3058-3072,4700-4727`; `src/templates/local-n8n-stack/index.js:6-12,129-300`; `src/services/local-n8n-stack-credentials.js:10-14`).

### Sources with retrieval dates

All sources retrieved **2026-10-09**. The identity article was fetched first in this review. Only official OpenAI sources support provider-policy findings.

| Official source | Displayed publication or update date |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 7 days ago |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: yesterday |
| [SIWC registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | None |
| [SIWC accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | None |
| [SIWC self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) | None |
| [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) | None |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | None |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | None |
| [Codex authentication](https://developers.openai.com/codex/auth), returned as [Authentication](https://learn.chatgpt.com/docs/auth) | None |
| [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | Updated: 12 hours ago |
| [Codex image generation](https://learn.chatgpt.com/docs/image-generation) | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms](https://openai.com/policies/service-terms/), especially §§6 and 15 | Updated: September 29, 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) | Published and effective: January 1, 2026 |
| [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Updated: January 16, 2026 |
| [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) | Updated: December 1, 2025; effective: January 1, 2026 |
| [Privacy policy](https://openai.com/policies/privacy-policy/), returned canonical `/policies/services-communications-privacy-policy/` | Updated: July 30, 2026 |
| [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: August 24, 2026 |

### What Relmio reads/stores/transmits/logs

#### Reads and scopes

- **Observed:** Credential import reads the newly generated add-on key, owned stack marker, prior credential-ID record and Docker container metadata. It verifies the local Docker host, running container identity and ownership labels. The server supplies `result.clientCredential` for ChatGPT, `result.clientKey` for SuperGrok, or the ignored `local-only` placeholder for the local model. It does not supply an OpenAI token (`src/services/local-n8n-stack-credentials.js:29-83`; `src/web/server.js:4891-4916`).
- **Observed:** Import itself requests no OAuth permission. The unchanged SIWC flow requests `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`, with `prompt=consent` for plan authorization (`src/services/oauth.js:10-11,204-210`). Background-workflow approval remains a separate server check (`src/web/server.js:4810-4826`).

#### Stores and access

- **Observed:** Relmio submits an `openAiApi` credential named **Relmio ChatGPT plan**, containing the local bearer and `http://n8n-openai-oauth:10531/v1`. Submission is JSON over stdin to `docker exec -i <verified-container-id> n8n import:credentials --input=/dev/stdin`. No plaintext import file or secret command-line argument is created by this helper (`src/services/local-n8n-stack-credentials.js:81-88`).
- **Observed:** n8n's persistent data mount is the owned Compose `n8n-data` volume at `/home/node/.n8n`. Relmio generates `N8N_ENCRYPTION_KEY`, stores it in the stack's owner-protected `.env`, and passes it into n8n. Default stack directory is `~/.relmio/local/n8n-stack`, subject to validated `RELMIO_HOME` configuration (`src/templates/local-n8n-stack/index.js:88-101,140-155`; `src/services/local-n8n-stack-installer.js:205-233,1270-1290`). **Provisional [n8n runtime]:** Credential-database encryption and the usual SQLite layout are expected n8n behavior, not independently verified by this OpenAI-only review. The mount and encryption-key configuration are code facts.
- **Observed:** `.runtime/credentials.json` stores only feature-keyed credential IDs, names and import timestamps, with owner-only protection. It contains no bearer. Its deterministic ID supports later imports for the same stack/feature (`src/services/local-n8n-stack-credentials.js:18-26,62-96`).
- **Observed:** The sidecar still holds the SIWC registration in its separate `siwc-store` volume at `/home/node/.relmio-siwc`; its Compose environment contains the local bearer's SHA-256 verifier, not the raw bearer or provider token (`src/domain/local-n8n-sidecar.js:110-145`). “Compose stores only the hash” remains true. “The bearer is not stored” or “Relmio never edits n8n credentials” would be false.
- **Observed and Open [assessment]:** The Relmio process, local Docker daemon, n8n import/runtime and one-time result page receive the raw bearer. Host administrators and Docker users can access runtime storage and the encryption key. A backup containing both n8n data and `.env` must be protected as a credential backup. Users permitted to use the credential in n8n can exercise its authority even when n8n hides the raw value. Exact n8n owner/project assignment and read/export permissions remain **Open**: this import supplies no `--userId` or `--projectId`, and no live n8n roles were inspected (`src/services/local-n8n-stack-credentials.js:81-87`; `src/ui/local.js:4005-4040`).

#### Transmits, recipients and logs

- **Observed:** The added transmission is local Relmio to Docker to the owned n8n container. Import adds no direct OpenAI request or new external credential recipient. Result status contains only state/name, while the existing one-time install result still carries the local key to the browser (`src/web/server.js:4880-4920`; `src/ui/local.js:4005-4040`).
- **Observed:** Subsequent n8n requests send the local bearer and workflow input to the sidecar. The sidecar substitutes its SIWC access token for requests to OpenAI's public Responses endpoint; n8n does not receive that token. Model discovery also contacts `api.openai.com` and checks Codex release metadata at `registry.npmjs.org` without credentials. Optional images use the separate Codex credential and `chatgpt.com/backend-api/codex/images` route, not the SIWC token (`src/gateway/openai-oauth-sidecar.mjs:919-949,991-1058`; `src/services/model-discovery.mjs:26-28,529-530,657-659`). Local-model and SuperGrok credentials point to their separate local services; this review grants no OpenAI authority to those services.
- **Observed:** Private mode creates no ngrok service or ngrok secret. Opted-in mode passes the agent token, hostname and Basic Auth policy to ngrok and tunnels the n8n route. Public editor/webhook traffic then crosses ngrok; the credential import itself still uses local Docker. The sidecar port is not published. Image pulls use the template's Docker Hub/GHCR references, independently of OpenAI sign-in (`src/templates/local-n8n-stack/index.js:6-12,34-40,98-103,153-155,174-212`). **Open:** ngrok, registry and n8n retention/internal processing were not audited; their configuration is not OpenAI policy evidence.
- **Observed:** Import stdout/stderr are bounded, captured in process memory and not returned by the helper. Its result and non-secret metadata omit the bearer. Existing sidecar usage records retain daily model/request/token counts and allowlisted usage-error codes, not prompts or answers (`src/infrastructure/local-process.js:844-876,983-1028`; `src/services/local-n8n-stack-credentials.js:84-99`; `src/services/model-discovery.mjs:58-69,193-213,841-878`). **Open:** n8n execution history, Docker/OS auditing and backups may retain additional data. No blanket “nothing is logged” claim is supported.
- **Confirmed:** OpenAI's privacy notices describe content, account, log, device/IP and usage processing and potential disclosure to service providers, affiliates, relevant account administrators and legal/safety recipients. Business-offering content follows the applicable agreement. A local credential import does not change those upstream rules or establish zero retention or no training.

### Three separate checks

#### 1. Identity sign-in

**Confirmed:** Identity sign-in can finish without subscription sharing. It does not independently expose conversations, memory or files.

**Observed:** Ready add-on selection and n8n credential import do not perform identity verification or grant OpenAI access. Relmio's existing SIWC registration and separate plan permission still exceed the identity-only Help description. Calling the n8n credential `openAiApi` does not make its value an OpenAI Platform key.

#### 2. Separately approved permissions

**Confirmed:** SIWC Terms §§1-4 distinguish Authentication Tokens from other application credentials and require user control, express background consent, requests for the authenticated user, and connected-application-only use. They prohibit general-purpose API access for unrelated tools and using one person's subscription for another person's requests.

**Observed and Open [assessment]:** Saving the local Relmio bearer in the same user's local n8n does not itself copy an OpenAI Authentication Token into n8n or create a new OAuth grant. Compared with manual entry, it automates provisioning of the same authority. It does add an explicit Relmio write and another retained secret copy, so prior manual-entry and no-credential-edit promises must change. The inspected review already asks permission for this write (`src/ui/local.js:3667-3689`).

**Observed and Open [assessment]:** No per-workflow or per-n8n-user identity check exists at the bearer gate (`src/gateway/openai-oauth-sidecar.mjs:999-1008`). Private networking, Docker ownership and Basic Auth do not establish that every request belongs to the authenticated OpenAI user. Public webhooks serving other users and shared credentials remain incompatible with treating personal plan permission as general service access. Whether this particular n8n integration satisfies the connected-application restriction remains **Open**; automated import neither resolves nor newly authorizes it.

**Confirmed and Open:** SIWC Terms require persistent Authentication Token storage to be local and user-controlled, while the VM guide describes secure remote transfer. That pre-existing documentation/Terms tension is not resolved here. This change targets local Docker and does not authorize remote managed storage. Codex image-bridge permission remains independently unresolved.

#### 3. Model/image capability

**Confirmed:** SIWC documents account-specific models and public Responses inference; image generation is unsupported on that flow. Codex documents built-in `gpt-image-2`, not blanket authorization for Relmio's direct image bridge.

**Observed:** Credential import status, n8n 2.42.5, Docker restart policy and add-on buttons establish no model entitlement or completed workflow. Assistant tools receive no automatic model credential through this importer. Images still need separate Codex sign-in. No TTS route is added (`src/services/local-n8n-stack-credentials.js:10-14`; `src/web/server.js:4891-4916`; `src/gateway/openai-oauth-sidecar.mjs:1004-1008`).

### Findings

1. **Observed:** Private by default is implemented for new setup. Old schema-version-1 stacks retain their ngrok classification; this is not a migration that makes existing public stacks private (`src/domain/local-n8n-stack.js:143-168`). Long-running services can restart with Docker, including an opted-in tunnel. Closing Relmio does not revoke background permission or stop these services.
2. **Observed:** README, local-endpoint/security/FAQ text still requires manual entry or promises no n8n credential writes. The install checkbox also still says “I will enter its one-time Relmio client key in n8n myself” (`README.md:278-281`; `docs/local-endpoints.md:211-222`; `docs/security.md:289-322`; `docs/faq.md:109-116`; `src/ui/local.html:998-1001`). These contradict the new owned-stack path.
3. **Observed and Open [assessment]:** “Use the key elsewhere” invites a broader use than the connected-n8n boundary. Replace it with a recovery-oriented label and an explicit same-installation restriction (`src/ui/local.html:1117-1123`).
4. **Observed:** The helper reports success from CLI exit status, not a read-back or workflow test. An import can succeed before writing the metadata file fails, so a failed result does not prove no credential was written (`src/services/local-n8n-stack-credentials.js:84-99`).
5. **Observed:** Removal checks network attachments and refuses while add-on containers remain attached. This is a deletion boundary, not credential revocation (`src/services/local-n8n-stack-installer.js:418-463,2286-2287`).

### Required wording

Use these short notices before approving the ChatGPT add-on:

> For n8n created by Relmio, installation tries to save the local Relmio key and private base URL in n8n's credential store. OpenAI tokens stay in the sidecar. Other n8n installations require manual entry.

> Anyone allowed to use this credential can send requests through your sidecar. Use it only for your own approved workflows in this n8n. Do not share it or use it to serve other users.

For stack setup:

> New n8n is private to this computer by default. Turn on ngrok only when you need a public URL. Basic Auth protects that URL but does not make it private.

For recovery:

> Relmio could not confirm credential setup. Check n8n for the named credential before adding it manually.

Exact disclosure replacements accompany this addendum. Existing separate image warnings, plan-use notice and background approval must remain.

### Unknowns

**Open:** Real n8n import compatibility, encryption at rest, credential project ownership, who can use/export it, live workflow success, and credential behavior after rotation/removal were not exercised. Also unresolved: deployment-specific logging/backups, actual public-route protection, current model/image eligibility, the connected-application interpretation, and permission for the separate Codex image bridge. Neither source review nor login establishes Terms compliance, OpenAI endorsement or TTS capability.

### Changes after this review

Applied on 2026-10-09 on `feat/local-stack-seamless` before merge: the disclosure replacements listed with this review (README, `docs/local-n8n-stack.md`, `docs/local-endpoints.md`, `docs/security.md`, `docs/faq.md` and the dashboard's review, Ready and recovery text), including the shared-use warning before the ChatGPT add-on is approved and the recovery wording that asks the user to check n8n for the named credential before adding it manually.
