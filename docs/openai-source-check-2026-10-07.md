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
