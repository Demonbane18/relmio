# OpenAI Sign in with ChatGPT source check

Review date: 2026-10-05

This review compares today's OpenAI Sign in with ChatGPT (SIWC) sources with the uncommitted `feature/documented-siwc` worktree. It is not legal advice, provider approval, Terms-compliance proof, or a runtime test. No sign-in, credential access, provider API call, form submission, SSH session, Docker command, browser QA, build or test was run for the review itself. File and line references describe the worktree at review time. Later fixes in this change moved some lines; see [Resolved in this change](#resolved-in-this-change) and [Still open](#still-open).

Labels:

- **Confirmed:** stated by an official OpenAI source fetched today.
- **Observed:** present in Relmio source. Not a runtime claim.
- **Provisional:** non-OpenAI evidence, or an OpenAI-adjacent page whose authority is unclear.
- **Open:** today's sources and the code review do not settle it.
- **[INFERENCE]:** reasoning that no source or run confirms.

## Sources fetched (2026-10-05)

| URL | Status | Displayed date |
| --- | --- | --- |
| https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt (fetched first) | 200 | Updated: 3 days ago (shown as 2 days ago on 10-04; same revision) |
| https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites | 200 | Updated: yesterday (shown as 6 hours ago on 10-04; same revision) |
| https://developers.openai.com/siwc/llms.txt | 200 | none |
| https://developers.openai.com/siwc/llms-full.txt (searched) | 200 | none |
| https://developers.openai.com/siwc/quickstart.md | 200 | none |
| https://developers.openai.com/siwc/token-sharing-open-source (served as .md) | 200 | none |
| https://developers.openai.com/siwc/ui-ux-guidelines (served as .md) | 200 | none |
| https://developers.openai.com/siwc/sign-in | **404** (the page lives under /token-sharing-open-source/) | n/a |
| https://developers.openai.com/siwc/models-and-inference | **404** (the page lives under /token-sharing-open-source/) | n/a |
| https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md | 200 | none |
| https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md | 200 | none |
| https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md | 200 | none |
| https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md | 200 | none |
| https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms.md | 200 | none |
| https://developers.openai.com/siwc/token-sharing-open-source/token-reference.md | 200 | none |
| https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md | 200 | none |
| https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md | 200 | none |
| https://developers.openai.com/api/reference/resources/responses/methods/create.md (searched for `additional_tools`) | 200 | none |
| https://learn.chatgpt.com/docs/sign-in-with-chatgpt (partner directory) | 200 | none |
| https://openai.com/policies/sign-in-with-chatgpt-terms/ | 200 | September 29, 2026 |
| https://openai.com/policies/service-terms/ | 200 | Updated September 29, 2026 (§15 SIWC) |
| https://openai.com/policies/row-terms-of-use/ | 200 | Published/Effective January 1, 2026 |
| https://openai.com/policies/eu-terms-of-use/ | 200 | Updated January 16, 2026 |
| https://openai.com/policies/usage-policies/ | 200 | Effective October 29, 2025 |
| https://openai.com/policies/privacy-policy/ | 200 | Updated July 30, 2026 |
| https://openai.com/policies/eu-privacy-policy/ | 200 | Updated August 24, 2026 |

Compared with the [2026-10-04 source check](openai-source-check-2026-10-04.md) and the implementation contract for this change.

## Changes since 2026-10-04

- **Confirmed, no date change:** All policy pages show the same dates as on 10-04. Both Help Center relative dates are consistent with the revisions reviewed on 10-04.
- **Confirmed, no change found in compared facts:** The guides still state the same contract facts: `dynamic_agent_client` plus `agent_name_hint` plus `ext_agent_host_id`; loopback `http://127.0.0.1:<port>/auth/callback`; S256 PKCE, state and nonce; scopes `openid profile email` + `offline_access resource.invoke chatgpt.tokens.use.direct`; `resource=https://api.openai.com/v1`; a 1 h access token and a 30-day rotating refresh token; `earliest_refresh_at` listed with no semantics; revocation through discovery `revocation_endpoint`; the same unsupported fields, error codes, VM transfer steps and app-server `env_key` recipe. The developer pages show no dates, so a silent wording edit can't be ruled out.
- **Observed today (could not be checked against a 10-04 snapshot):** The Quickstart says "ChatGPT plan usage is available to all open-source partners and selected private clients." The plan Help Center article says "All users can connect their account with supported open source tools. If you are a Plus or Pro user, you can also connect … eligible commercial tools," and also that only Plus and Pro can use their plan. The partner directory lists open-source integrations OpenClaw, OpenCode, Pi and T3. Relmio is not listed.
- **URL note:** Short guide URLs such as `/siwc/sign-in` and `/siwc/models-and-inference` return 404. Their canonical locations are under `/siwc/token-sharing-open-source/`. `/siwc/ui-ux-guidelines` and `/siwc/token-sharing-open-source` resolve.

## Check 1: identity sign-in

- **Confirmed:** Identity sign-in gives the app name, email and profile picture, plus the stable `sub` per the developer docs. It does not share conversations, memory, files, tokens or billing information. OpenAI separately processes account, authorization and security metadata. [Help 20001410]
- **Confirmed:** Validate state; handle `error=access_denied` without a code exchange; for a new registration, require the issued `client_id` in the callback and never save `dynamic_agent_client`; on reauthorization, reject a different client ID; verify the ID token's JWKS signature, issuer, audience (the issued client ID), expiry and nonce; bind the account by `sub` together with the issued client ID. [sign-in.md §3-4]
- **Confirmed:** "A successful **new registration** returns `code`, `state`, and the issued `client_id`. The callback may also include `scope`." The example callback includes `&scope=chatgpt.tokens.use.direct+email+offline_access+openid+profile+resource.invoke`. [sign-in.md §3]
- **Observed:** Relmio binds the listener on `127.0.0.1` port 0 before opening the browser (`src/services/oauth.js:182-185`). It builds `http://127.0.0.1:<port>/auth/callback` (`oauth.js:12,186`). It generates fresh 32-byte state, nonce and verifier with an S256 challenge (`oauth.js:76-77`), sends `agent_name_hint=Relmio` only on new registration (`oauth.js:194`), and sends `ext_agent_host_id` (`oauth.js:193`). The code exchange carries the issued client, verifier, the original redirect and the resource (`oauth.js:137-138`). The ID token is checked against discovery JWKS with issuer, audience equal to the client, 5 s clock tolerance, required sub/exp/iat/nonce and RS256/ES256 (`src/services/siwc-session.mjs:516-535`). For reauthorization the subject must match the saved one (`oauth.js:148-149`).
- **Observed at review time, C1:** `oauth.js:122` rejected any callback parameter other than `state`, `code` and `client_id`. If OpenAI includes `scope`, as the guide's example does, a valid sign-in would end with "ChatGPT sign-in could not be verified." **Resolved in this change.** Whether OpenAI also sends RFC 9207 `iss` is **Open**.
- **Observed at review time, C2 (UX):** A callback with `error=access_denied` got the same generic failure. It was safe because no code exchange happens. The guide wants state validated and the user routed to the 'plan use isn't enabled' path. **Resolved in this change.**
- **Observed, L1:** Reauthorization never sends `id_token_hint` or `login_hint` (`oauth.js:189-196`). profiles-and-sessions.md says to "Send a retained `id_token` as `id_token_hint`". The only effect is that the account selector appears. The subject check still blocks a wrong-account swap.

## Check 2: separately approved ChatGPT-plan permission

- **Confirmed:** Plan permission comes from the granted scopes in the token response (`chatgpt.tokens.use.direct`), not from the requested scopes or the callback. If the user declines, keep identity and disable plan use. Re-enable by repeating OAuth with the complete scope set; `prompt=consent` is supported, and `force_reconsent=true` only after OpenAI confirms the rollout. Only Plus and Pro accounts can use their plan. Apps can have weekly caps. A usage-limit error means the app should pause plan requests and link to Manage usage; it must not infer a reset time or fall back to another billing path. [sign-in.md §4; errors-and-recovery.md; Help 20001542]
- **Observed:** The scope string is exactly the documented one (`oauth.js:11`). The `enable-plan` flow adds `prompt=consent` and never `force_reconsent` (`oauth.js:195`). Plan permission is computed from the stored granted scopes (`siwc-session.mjs:293`). Plan use requires `planEnabled` and the scope (`siwc-session.mjs:625-626`, `478`, `493`).
- **Confirmed:** Refresh sends `grant_type=refresh_token`, the issued `client_id`, `refresh_token` and `resource`, with no scope. Refreshes are serialized. The terminal codes are `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated` and `refresh_token_reused`; `invalid_client` means fix the configuration. Do not erase credentials only because of a temporary failure. [profiles-and-sessions.md; errors-and-recovery.md]
- **Observed:** The refresh form matches (`siwc-session.mjs:641-642`), runs under a per-registration lock (`siwc-session.mjs:617`) and uses the same terminal-code set (`siwc-session.mjs:11`). The session is persisted as `refreshUncertain` before each POST (`siwc-session.mjs:636-638`). Network uncertainty leaves it frozen and requires reauthorization (`siwc-session.mjs:548`).
- **Observed, D2:** On HTTP 503 with code `temporarily_unavailable`, the code restores the pre-refresh session (`siwc-session.mjs:556`, `644-645`). The 2026-10-04 check said a 503 leaves the tokens frozen. No OpenAI page says a 503 response guarantees the token was not rotated [INFERENCE]. The code is unchanged; documentation now discloses the assumption. See [Still open](#still-open).
- **Open:** `earliest_refresh_at` appears in the token response list, with no stated units or meaning. Relmio stores it (`siwc-session.mjs:440-441,455`) and does not use it to schedule refreshes; it refreshes when less than 60 s of validity remains (`siwc-session.mjs:629`). This contradicts nothing published.
- **Confirmed:** Revocation is a form POST to the discovery `revocation_endpoint` with `token`, `token_type_hint=refresh_token` and `client_id`. An empty HTTP 200 means success. Retry network errors and 5xx with backoff. Clear tokens and keep the account mapping. If revocation is not confirmed, tell the user and point them to ChatGPT Settings. [profiles-and-sessions.md]
- **Observed:** The revocation request matches (`siwc-session.mjs:745-760`): 3 attempts with 100/200 ms backoff, and the endpoint must be on the issuer origin (`siwc-session.mjs:511-513`). A registration that is `refreshUncertain` stays `unconfirmed` even after a 200 (`siwc-session.mjs:755`). The session is cleared while the mapping is kept (`siwc-session.mjs:765`).
- **Confirmed:** VM transfer: create the VM host ID first, complete OAuth locally, copy the protected file over SSH, keep the VM's host ID, and let the VM own later refreshes. "Host-specific usage attribution and revocation … for transferred sessions are not yet available." [self-hosted-vms.md]
- **Observed:** Transfer requires plan to be enabled and a destination host ID different from the source (`siwc-session.mjs:780-782`). The handoff is sent through SSH stdin (`src/services/installer.js:641-656`) or local Docker CLI stdin (`src/services/local-n8n-sidecar-installer.js:2272-2283`), and the source stays frozen while the outcome is uncertain (`local-n8n-sidecar-installer.js:2285`). Host IDs are `urn:uuid:` UUIDv4 values, one per runtime (`siwc-session.mjs:43,307`).
- **Open, unchanged:** SIWC Terms §1 says persistent token storage "must be local and under the user's control, not in a remote or managed environment". The VM guide describes storing credentials on a VM. Do not present VPS transfer as approved under the Terms.
- **Open, Terms (not a code fact):** SIWC Terms §2 says "Connected application only … Do not provide general-purpose API access for other tools or unrelated requests" and requires express consent before background use. The n8n sidecar gives n8n, which is a separate tool, an OpenAI-compatible API. Relmio does collect explicit background-workflow consent (`siwc-session.mjs:777`; welcome copy `src/ui/local.html:461`). Whether this architecture fits §2 needs an answer from OpenAI.
- **Open:** Relmio is not in the directory's open-source integrations list. Whether it counts as a "supported open source tool" (Help 20001542) or one of "all open-source partners" (Quickstart) is not defined.

## Check 3: model and inference capability (no TTS)

- **Confirmed:** `GET https://api.openai.com/v1/models` returns a `models` array. Keep `visibility == "list"`, preserve order, show `display_name` and send `slug`. Use `POST https://api.openai.com/v1/responses` with `store:false` and `stream:true`, never `backend-api`. Success means `response.completed` only. Usage errors can arrive mid-stream as `response.failed`. [models-and-inference.md]
- **Observed:** The sidecar sends upstream requests only to `/models` and `/responses` (`src/gateway/openai-oauth-sidecar.mjs:8,610-612`). It filters and maps the catalog (`:618-622`, `listSiwcModels :627-643`). It forces `store:false, stream:true` upstream (`:596`, `:563`). Mid-stream failure codes map to statuses (`:44-50`), and `subscription_sharing_usage_limit_exceeded` gets the `manage-usage` recovery (`:35`).
- **Confirmed, unsupported fields:** `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`; omit `previous_response_id` over HTTP; system-message items are rejected. The unsupported tools are image generation, file search, Code Interpreter, computer use, hosted MCP and `tool_search`; `programmatic_tool_calling` is not accepted. Audio and video input, the Files upload API and the transcription API are unsupported. [preview-limitations.md]
- **Observed:** The rejected-field set matches and adds `previous_response_id` (`openai-oauth-sidecar.mjs:13`). `background` is accepted only as `false` and then deleted (`:169`, `:597`). There is an allowlist of top-level fields (`:15`), a set of unsupported tools (`:14`), and system, audio and video input is rejected (`:120-121`).
- **Confirmed, `additional_tools`:** The SIWC guide's exact wording is "**Supported tools:** Group function/custom tools in namespaces or supply them through `additional_tools` input items." (preview-limitations.md). The SIWC guides do not use the words "developer" or "flat function" for this item. The Responses API reference defines `AdditionalTools object { role, tools, type, id }` with `role: "developer"` ("The role that provided the additional tools. Only `developer` is supported.") and `tools` that include `Function object { name, parameters, strict, … }` (create.md, around lines 2447-2530).
- **Observed:** Flat top-level function and custom tools are moved into `{type:"additional_tools", role:"developer", tools}` (`openai-oauth-sidecar.mjs:152-164`). The chat translation builds the same item (`:528`). Incoming items are validated (`:122-131`).
- **Observed at review time, L2:** In the reference, `parameters` and `strict` have no `optional` marker (both are nullable). Relmio allowed both to be omitted for nested and flat function tools (`openai-oauth-sidecar.mjs:90-93`). **Resolved in this change** for the request shape. Whether the SIWC route accepts flat tools at all has not been tested live.
- **Confirmed, Chat Completions:** No SIWC page documents an upstream Chat Completions route. errors-and-recovery.md says that for `subscription_sharing_route_not_supported` (403) "support for another client type or route is not permission to use it here." **Observed:** `/v1/chat/completions` exists only as a local route that translates to Responses (`openai-oauth-sidecar.mjs:577,583-588,494-566`). It is never forwarded upstream as Chat Completions. No contradiction.
- **Observed at review time, D1:** The FAQ and README described the chat route as text-only and tool-rejecting. The code accepts `tools`, `tool_choice`, `parallel_tool_calls` and `stream_options`, plus tool-call roundtrips (`openai-oauth-sidecar.mjs:496-566`). **Resolved in this change** by the documentation update.
- **Confirmed, Codex app-server:** The provider config is `openai_chatgpt_plan` with `base_url=https://api.openai.com/v1`, `env_key="ACCESS_TOKEN"`, `wire_api="responses"`, `requires_openai_auth=false` and `supports_websockets=false`. `clientInfo.name` should match `agent_name_hint`. Only `turn/completed` with status `completed` counts as success. To renew, restart the child and call `thread/resume`. `model/list` is a catalog, not an entitlement check. [codex-app-server.md; preview-limitations.md]
- **Observed:** The args match, plus `--strict-config`, zero retries and token-environment filters (`src/gateway/codex-app-server.mjs:10-24`). `ACCESS_TOKEN` is passed only in the child's environment (`codex-app-server.mjs:121`; `src/gateway/codex-chat.js:341`). `clientInfo` is `{name:"Relmio", title:"Relmio"}` (`codex-app-server.mjs:233`; `codex-chat.js:702-705`).
- **Confirmed:** Errors before a stream opens may be `{"detail":"…"}` with direct statuses 401, 403 or 503. **Observed:** `detail` is handled and redacted (`openai-oauth-sidecar.mjs:28-42`). Minor: `subscription_sharing_user_not_eligible` (403) maps to recovery `fix-configuration`, while the guide says to explain the restriction. That is not an OAuth loop.
- **Confirmed:** No SIWC page grants TTS (`/v1/audio/speech`), and audio is unsupported in this flow. **Observed:** Relmio forwards no audio routes. A model listing, a connected badge or a successful sign-in does not prove access to any model or capability.

## UI guidelines

- **Confirmed:** "Continue with ChatGPT"; a first-use "You're using your ChatGPT plan" modal; "Using ChatGPT plan" near the model selector or composer; a Manage usage link to `https://chatgpt.com/settings/usage`; Manage usage as the primary action on limit errors. [ui-ux-guidelines]
- **Observed:** "Continue with ChatGPT" appears at `src/ui/local.html:449` and `src/ui/index.html:223`. The welcome modal (`local.html:459-463`) uses a "Continue" button; the guide gives "Got it" only as an example. The plan badge and Manage usage link appear at `local.html:821,1072,1224` and `index.html:548`. The usage-limit primary action is at `local.html:1078,1260` and `src/ui/siwc-controls.js:26`. No contradiction.

## Data handling

| Item | Reads / stores / transmits / logs | Receiving parties |
| --- | --- | --- |
| Discovery and JWKS | Reads `https://auth.openai.com/.well-known/openid-configuration` and validates the endpoints (`siwc-session.mjs:505-514`); JWKS for the ID token (`:516-535`) | OpenAI (auth.openai.com) |
| Authorization | The system browser opens the authorize URL with client_id, host ID, redirect, scopes, resource, state, nonce and challenge (`oauth.js:186-199`). No `id_token_hint`. | OpenAI; the user's browser |
| Callback and code exchange | The loopback listener receives code, state and client_id, plus optional `scope` and `iss` after the C1 fix (`oauth.js:110-125`); POSTs code, verifier, redirect, client and resource (`oauth.js:135-140`). The browser gets a page with no tokens (`oauth.js:14,161-162`). | OpenAI token endpoint; local Relmio process |
| Stored record | Verified issuer, sub, optional email, issued client ID, host owner, granted scopes, access, refresh and ID tokens, expiry, `earliestRefreshAt`, plan and background consent flags (`siwc-session.mjs:450-455,476-481`). Stored under `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth` (`:47-50`) with directories 0700, files 0600 created exclusively (`:67,99`), owner/mode/symlink checks (`:61-63`), and a Windows ACL path (`:62,71,102`). | Local filesystem and OS account |
| Host ID | `urn:uuid:<v4>` per runtime (`siwc-session.mjs:300-310`) | Sent to OpenAI as `ext_agent_host_id` |
| Refresh and revocation | Refresh token, client ID and resource to the token endpoint (`:641-642`); refresh token to `revocation_endpoint` (`:749-751`) | OpenAI |
| Inference | The access token, model slug, input, tools and supported options go to `api.openai.com/v1/models` or `/v1/responses` (`openai-oauth-sidecar.mjs:608-614`). Responses come back to the local caller. | OpenAI API; the local caller (wizard, n8n container on the private Docker network, Codex WebSocket client) |
| Local client bearer | Only its SHA-256 is checked (`openai-oauth-sidecar.mjs:76-81`). The raw value is shown once and entered into n8n by the owner. | n8n credential store (operator-owned) |
| Codex child | Short-lived `ACCESS_TOKEN` in the child environment, excluded from shell tools (`codex-app-server.mjs:22-23,121`) | Local `codex` process, then OpenAI Responses |
| Transfer | Protected handoff bytes over SSH stdin (`installer.js:652-653`) or Docker CLI stdin (`local-n8n-sidecar-installer.js:2281-2283`) | Selected VPS or Docker host, its storage and its administrators |
| Logs | Child stderr is discarded (`codex-app-server.mjs:206`). Startup failures write fixed strings only (`openai-oauth-sidecar.mjs:696`; `siwc-handoff.mjs:116`). Provider errors are bounded to 512 characters and redacted (`openai-oauth-sidecar.mjs:17-42`). Token-exchange bodies are never shown (`oauth.js:17-27`). `console.*` was not found in the SIWC session, OAuth, handoff, gateway or `src/web/server.js` files reviewed (grep, 2026-10-05). | No deliberate Relmio log sink. Docker, SSH, host, n8n execution history and OpenAI logs are **Open**. |

OAuth scopes requested: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` (`oauth.js:11`), resource `https://api.openai.com/v1` (`oauth.js:10`). OpenAI's privacy policies (July 30 / August 24, 2026) describe categories of data and recipients. They do not name Relmio-specific recipients or retention. `store:false` is not a promise of zero retention.

## Resolved in this change

- **C1, callback `scope`:** The callback now accepts and ignores an optional `scope`. Plan permission still comes only from the token response's granted scopes. An optional `iss`, when present, must exactly equal the discovered issuer. Duplicate parameters and any other unexpected parameter still fail before the code exchange.
- **C2, `access_denied`:** A valid-state `error=access_denied` consumes the transaction and makes no token request. New sign-in reports "ChatGPT sign-in was declined." Enable-plan reports "ChatGPT plan use was declined." and leaves the existing verified registration unchanged. Invalid state, a mismatched issuer, an unknown error or an unexpected `error_description` stay generic failures.
- **L2, nullable function fields:** When a function tool omits `parameters` or `strict`, the Responses and Chat Completions translations now send `parameters: null` and `strict: null`. Supplied values, including `strict: false`, are unchanged. Existing `additional_tools` items get the same normalization. Namespace children and custom tools are unchanged.
- **D1, chat route disclosure:** README, FAQ and the related guides now describe function-tool support through `additional_tools` and its limits.

These fixes were checked with injected provider responses and a fake local upstream only.

## Still open

- **D2, refresh 503:** On HTTP 503 `temporarily_unavailable`, Relmio restores the pre-refresh session. This assumes the refresh token was not rotated. OpenAI does not document that guarantee. The documentation now states the assumption; the design is unchanged.
- **L1:** Reauthorization still does not send `id_token_hint` or `login_hint`. The account selector appears; the subject check still blocks a wrong-account swap.
- **Terms §1:** Persistent VPS token storage may conflict with the "local and under the user's control" wording. Relmio makes no provider-approval claim for VPS use.
- **Terms §2:** Whether an OpenAI-compatible endpoint for n8n fits "connected application only" and "no general-purpose API access" needs an answer from OpenAI.
- **Partner directory:** Relmio is not listed. Whether it counts as a "supported open source tool" or "open-source partner" is not defined.
- **Flat tools on the live route:** Whether the SIWC route accepts `additional_tools` with flat function tools has not been tested. Only the generic Responses reference documents the shape.
- **Other unknowns:** semantics of `earliest_refresh_at`; whether OpenAI sends `iss` in the callback.
- **Live verification:** Live eligibility, admission region, account catalog, completed inference, tool-call roundtrips with OpenAI, refresh rotation, revocation effect, Windows ACL behavior, real Docker or VM transfer, and deployment-specific logs and retention were not exercised.

Nothing in this check is evidence of Terms compliance, provider approval, or TTS or model entitlement.
