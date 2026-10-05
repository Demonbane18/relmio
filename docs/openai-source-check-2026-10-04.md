# OpenAI Sign in with ChatGPT source check

Review date: 2026-10-04

**Historical review:** see the newer [2026-10-05 source check](openai-source-check-2026-10-05.md) for current implementation findings.

This source review compares current OpenAI Sign in with ChatGPT (SIWC) documentation with the local/self-hosted implementation in Relmio. It is a source and documentation review, not legal advice, provider approval, or runtime acceptance. No sign-in, credentials, provider request, real n8n workflow, SSH connection, Windows run, VM transfer, deployment, or browser QA was performed. Test fixtures and source inspection do not establish live eligibility, admission, model access, Terms compliance, or account-specific retention.

Finding labels:

- **Confirmed:** stated by a current official OpenAI source reviewed on the date above.
- **Observed:** present in the Relmio source reviewed here, without a live runtime claim.
- **Open:** the published documents and source review do not settle the question.

## Decision and three separate checks

**Confirmed:** The documented local open-source plan-usage path uses Relmio's
own app identity, per-user/workspace dynamic registration, a persistent host ID,
verified identity claims, separately granted ChatGPT-plan permission,
protected local tokens, account-specific model discovery, and the public
Responses API. It does not require a commercial approval, partner-issued
client ID, or client secret; use the documented local SIWC flow. Identity
sign-in can succeed while plan permission is absent. An identity badge,
requested scope list, successful sign-in, model listing, or local installation
confirmation is not evidence of the other checks. [Quickstart][quickstart]
[Registration][registration] [Sessions][sessions] [Models][models]

**Observed:** Relmio's local wizard stores separate registrations, selects one account at a time, uses verified issuer/client/subject identity rather than email to bind an account, and keeps safe account views separate from token records (`src/services/siwc-session.mjs`; `src/services/oauth.js`; `src/web/server.js`). The new-account route requests `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, saves OpenAI's issued client ID, and validates the returned ID token against OpenAI discovery/JWKS, issuer, client audience, state, nonce, and the prior subject for reauthorization (`src/services/oauth.js`; `src/services/siwc-session.mjs`). The account's plan permission comes from the token response's granted scopes, not the requested scopes. A verified identity without `chatgpt.tokens.use.direct` remains connected with plan use unavailable (`src/services/siwc-session.mjs`). These are source observations, not a live provider result.

**Observed:** OpenAI's issued client ID is stored in a protected pending
registration before token exchange. A failed or cancelled exchange never makes
an unverified account usable; an explicit retry reuses that pending client
registration. Only a successfully verified ID token promotes it to a verified
account (`src/services/oauth.js`; `src/services/siwc-session.mjs`).

**Confirmed / Observed:** The user must separately enable plan use through ChatGPT authorization. Relmio's button or checkbox cannot create that grant. A first-use confirmation is persisted for the selected registration and required before model use; the UI links to ChatGPT **Manage usage**. Account eligibility, account/workspace policy, host admission, model availability, and each completed response remain separate requirements. [Plan help][plan-help] [Errors][errors] [UI][ui]

## Local runtime and current request path

**Observed:** Initial authorization opens the system browser after a local HTTP callback listener is bound to `127.0.0.1`. The callback is single-use and bound to state; the listener validates the issued client ID, exchanges the code with PKCE and resource through OpenAI's token endpoint, verifies the ID token, and commits the registration into protected files below `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth` (`src/services/oauth.js`; `src/services/siwc-session.mjs`). POSIX storage uses owner-only directories/files and rejects symlinks or insecure entries; Windows calls the existing current-account ACL verifier. Browser APIs expose account metadata and model display values, not provider tokens, filesystem paths, or authorization URLs (`src/services/siwc-session.mjs`; `src/web/server.js`).

**Observed:** The local gateway accepts a Relmio-issued local bearer and only `GET /v1/models`, `POST /v1/responses`, and the text-only `POST /v1/chat/completions` compatibility route (`src/gateway/openai-oauth-sidecar.mjs`). The gateway obtains a short-lived token lease for the selected registration, calls `https://api.openai.com/v1/models` or `https://api.openai.com/v1/responses`, requests `store:false` and streaming upstream, and treats only `response.completed` as success. The catalog is the returned account catalog, filtered to `visibility == "list"`, preserving its order and displaying the provider's name/slug. The local compatibility chat route accepts only `model`, `messages`, and `stream`; messages are limited to text `user`, `assistant`, or `developer` roles. Unsupported parameters or content return an explicit error. Neither route switches account, retries a failed inference through another provider, nor falls back to Platform API billing.

**Observed:** The local Responses boundary rejects unknown or documented unsupported request fields, background requests, stored response/conversation IDs, system-role input, audio/video input, and unsupported tool types. Image generation/edit routes, Audio, Files upload/list/delete, stored Conversations, Moderations, Live, Realtime, Video, and other unimplemented routes are not forwarded. A listed model is not proof of entitlement or admission. A plan-usage `429` for the usage-limit error links to Manage usage; other errors retain safe status/code/parameter/request-ID and a bounded/redacted provider error shape with a specific recovery. Partial output followed by a provider error is a failure, not success. [Models][models] [Limitations][limitations] [Errors][errors]

**Observed:** The local n8n sidecar uses a generated Relmio bearer, stores only its SHA-256 verifier in Compose, and publishes no host port. It is reachable on the chosen private Docker network. The installer displays the generated bearer once; the owner must enter it manually as n8n's credential. The bearer identifies the installation boundary, not the provider account. The n8n plan is bound to the selected registration, client ID, generation, owner, target n8n/network, and an explicit background-workflow consent. The wizard does not edit n8n's own credential configuration (`src/domain/local-n8n-sidecar.js`; `src/domain/templates.js`; `src/services/local-n8n-sidecar-installer.js`; `src/web/server.js`).

## Codex clients remain distinct

**Observed:** The direct Codex target preserves the local WebSocket client
contract by relaying to the official Codex App Server over stdio. The child is
configured with the public Responses provider, `ACCESS_TOKEN`,
`supports_websockets=false`, and zero request/stream retries. The generated
configuration disables agent spawning and filters token variables from shell
environments. Requests are catalog-bound to the selected registration and
validated at the RPC boundary. Deferred/dynamic `tool_search`, hosted
connector/MCP OAuth, account/auth and marketplace/plugin/configuration
mutations, per-thread provider/model overrides, and path/history/rollout
selectors are rejected. Inline function/custom tools remain within the
high-trust boundary; this is not full App Server/MCP/agent feature parity.
(`src/domain/local-endpoints.js`; `src/gateway/codex-app-server.mjs`).

**Observed:** Successful App Server thread starts/forks are recorded in a
protected registration- and runtime-bound registry before their response is
forwarded. After relay restart, only a known same-issuer/client/subject thread
can be explicitly resumed; unknown or foreign IDs are rejected. A supplied
resume model must appear in the selected registration's model catalog.
Access-token expiry closes the socket shortly before expiry; reconnect and
explicit resume start a new child, without replaying an interrupted turn.
(`src/services/siwc-session.mjs`; `src/gateway/codex-app-server.mjs`).

**Observed:** The separate Chat Adapter maps Codex `codexErrorInfo` turn
failures to bounded status/code/recovery values: usage-limit errors lead to
`usage_limit`/Manage usage, unauthorized errors to reauthorization, malformed
requests to correction, and stream disconnection to interrupted-turn recovery.
It redacts registered SIWC token values, does not forward `additionalDetails`,
and does not fabricate a public Responses API error envelope or request ID.
(`src/gateway/codex-chat.js`).


## Credentials, transfer, and operator safety

**Observed:** The protected record holds verified identity metadata, client ID, granted scopes, token state, consent/plan settings, and owner/generation state. Refresh is serialized. If OpenAI discovery fails before a refresh request is sent, Relmio returns retry-later without changing the session. Before every refresh POST it persists `refreshUncertain` and disables plan use. A token-endpoint `503`, any other error response, or an ambiguous network result therefore leaves the retained token bytes frozen; callers cannot retry the old refresh token, and a fresh SIWC sign-in is needed before plan use. A successful token response is first stored in that frozen state as R1, then its ID token is verified. JWKS/identity verification failure leaves R1 protected for possible revocation but grants no access-token lease. A terminal `invalid_grant` clears unusable token state. (`src/services/siwc-session.mjs`; `src/services/oauth.js`)

**Observed:** Local n8n and VPS transfer establish a destination host ID before preparing a transfer. The source registration is frozen before its protected handoff bytes are sent. Destination ownership is committed only after an attested handoff receipt, then the sender's tokens are cleared. Unknown transfer or receipt outcomes stay frozen for inspection; they do not restore the old session or permit both copies to refresh. Installed-target sign-out or plan-disable first attests the exact managed sidecar and stops it; an unconfirmed stop prevents the account mutation (`src/services/siwc-session.mjs`; `src/services/siwc-handoff.mjs`; `src/services/local-n8n-sidecar-installer.js`; `src/services/installer.js`).

**Observed:** VPS setup confirms the SSH host fingerprint before authentication and requires a final reviewed write confirmation. It uses a static command allowlist and sends protected session data via SSH stdin, not a shell command or browser response. The destination has a distinct persistent host ID and becomes the sole refresh owner. Existing n8n configuration, container, image, and lifecycle remain operator-owned; the sidecar is private to its selected Docker network (`src/web/server.js`; `src/services/installer.js`; `src/domain/templates.js`).

**Open:** OpenAI's self-hosted VM guide describes a protected VM credential and refresh transfer, while SIWC Terms separately say persistent Authentication Tokens must be local and user-controlled, not remote or managed. The published wording does not resolve that tension for a VPS. Relmio's transfer and safety code is an implementation observation, not provider approval or legal interpretation. Do not present VPS transfer as Terms-approved. [VM guide][vms] [SIWC Terms][siwc-terms]

**Observed:** Sign-out attempts remote token revocation and always clears local access/refresh/ID tokens while retaining the account mapping. Its result distinguishes confirmed, unconfirmed, or not-applicable revocation. A refresh-uncertain registration remains **unconfirmed even if token revocation returns HTTP 200**, because the token family may have rotated outside the known record. The UI says local credentials were cleared and points the user to ChatGPT disconnection controls. Removing browser data, deleting a registration, or stopping a sidecar alone is not proof of remote revocation or provider-side deletion (`src/services/siwc-session.mjs`; `src/ui/siwc-controls.js`).

## Website route (separate hosted scope)

**Observed:** The public website's `/api/chat` route responds `410 Gone` with
`Cache-Control: no-store`; it does not parse request bodies or call a provider
(`web/app/api/chat/route.ts`). The local open-source SIWC flow is separate and
does not enable this route.

**Confirmed, hosted scope only:** OpenAI's cookbook directs paid or remotely
hosted apps to request access. This does not impose that hosted-app process on
the documented local OSS path above. This change does not implement or assess
hosted plan-funded chat; the public route remains disabled pending separate
hosted-access work. [Cookbook][cookbook]

## Data handling and recipients

This table describes source-configured boundaries, not all deployed logs, onward recipients, or retention.

| Stage | Source observation and receiving parties |
| --- | --- |
| Identity and permission | The user's system browser contacts OpenAI authorization and token endpoints. OpenAI receives the app name, dynamic/issued client identifiers, host identifier, redirect, requested scopes, user choice, and sign-in/security metadata. Relmio's loopback callback receives the authorization code and token response; the browser receives a token-free completion page. Relmio verifies the ID token and stores verified issuer, subject, optional email, issued client ID, and granted scopes in the protected record. Account label/email is recognition metadata; registrations are not merged by email. |
| Storage and refresh | The local Relmio process reads/writes protected registration JSON and host identity under its configured root or `~/.n8n-openai-oauth`. Local n8n sidecars store their SIWC record at `/home/node/.relmio-siwc`; the VPS runtime stores it under the owned `/docker/n8n-openai-oauth/siwc` directory, mounted at the same container path. This is separate from legacy `/auth/auth.json` storage, which remains offline rather than mounted into the SIWC runtime during migration. Docker/OS storage and the VPS host administrator remain access boundaries. Refresh traffic sends a refresh token to OpenAI; provider tokens are never returned to browser code. |
| Inference | The selected local sidecar or user-controlled installation sends the selected account's OAuth bearer, model slug, prompt/input and supported options to `api.openai.com/v1/models` or `/v1/responses`. Model metadata and response text return through Relmio's local server to the browser or n8n client. The local n8n bearer is separately sent by n8n to the private sidecar and is not an OpenAI credential. The direct Codex child receives the short-lived access token through `ACCESS_TOKEN` and calls the public Responses endpoint. |
| Installation and runtime assets | Local Docker, the selected SSH/VPS service, and destination filesystem receive runtime files and protected handoff bytes as part of an explicitly reviewed installation. Runtime builds fetch Node and the pinned `jose` and `ws` packages; the asset collector validates lockfile versions, npm tarball URLs, and integrity values, using the packaged `src/services/siwc-runtime-lock.json` when the project lockfile is unavailable. The one-time n8n bearer is generated locally and its hash, not its raw value, is persisted in Compose (`src/services/siwc-runtime-assets.js`; `src/services/siwc-runtime-lock.json`). |
| Logs and cleanup | The source bounds and redacts provider error fields and does not deliberately log prompts or tokens in the SIWC request handlers. Process/runtime, Docker, SSH, host-provider, workflow, browser, registry, and OpenAI logs are not all controlled or observed here. A successful local cleanup or logout does not establish remote revocation. OpenAI privacy policies describe categories of account/content/device/usage data and possible service-provider, affiliate, administrator, legal, and other recipients, but not which deployment-specific entities receive Relmio data or how long each retains it. |

`store:false` is an API request option, not a zero-logging or zero-retention promise. The Platform API data-controls guide must not be automatically applied to consumer ChatGPT-plan requests. OpenAI's policies do not establish all recipients or retention for this local implementation. [Privacy][privacy] [Europe privacy][eu-privacy] [API data controls][data] [Errors][errors]

## Historical implementation reviews

The 2026-10-01 and earlier source checks below are historical records of prior hosted Codex/browser-storage and local credential-copy code. Their source observations must not be read as a description of the current local SIWC implementation. Their historical provider-permission and unresolved-policy findings remain relevant; this check does not convert them into approval. See [the 2026-10-01 review](openai-source-check-2026-10-01.md), [the 2026-09-29 review](openai-source-check-2026-09-29.md), and the dated sections later on this [security page](security.md).

## Not verified

- Any live user's identity, selected workspace, plan permission, Plus/Pro eligibility, serving-host admission, model list, or completed inference.
- Native Windows SIWC storage/ACL behavior, native Windows setup, or real VM/VPS transfer. The VM token-storage Terms tension remains open.
- Live OAuth consent, refresh rotation, remote revocation, or provider deletion behavior. Source code and fixtures do not establish actual provider behavior.
- OpenAI's approval or Terms position for a Relmio-hosted website runtime, any owner's application/approval state, deployment-specific provider retention, or complete logs/recipients.
- A legally adequate privacy notice or any legal/Terms page. Issue #97 assigns legal drafting to the owner/counsel; this source review is not approval of that work.

## Official source register

All sources were reviewed on 2026-10-04. Relative dates below are reproduced as displayed and are not converted into asserted publication dates.

| Source | Displayed date |
| --- | --- |
| [Sign in with ChatGPT Help Center article][identity-help] | Updated: 2 days ago |
| [ChatGPT plan usage Help Center article][plan-help] | Updated: 6 hours ago |
| [SIWC quickstart][quickstart] | No date shown |
| [SIWC open-source overview][overview] | No date shown |
| [SIWC registration and sign-in][registration] | No date shown |
| [SIWC accounts and sessions][sessions] | No date shown |
| [SIWC token reference][tokens] | No date shown |
| [SIWC models and inference][models] | No date shown |
| [SIWC preview limitations][limitations] | No date shown |
| [SIWC errors and recovery][errors] | No date shown |
| [SIWC self-hosted VMs][vms] | No date shown |
| [SIWC Codex App Server recipe][app-server] | No date shown |
| [SIWC website guide][website] | No date shown |
| [Request a client ID][client-id] | No date shown |
| [SIWC cookbook][cookbook] | No date shown |
| [SIWC Terms][siwc-terms] | September 29, 2026 |
| [Service Terms][service-terms] | Updated September 29, 2026 |
| [ROW Terms of Use][row-terms] | Effective January 1, 2026 |
| [Europe Terms of Use][eu-terms] | Updated January 16, 2026 |
| [Services Agreement][services-agreement] | Updated December 1, 2025; effective January 1, 2026 |
| [Usage Policies][usage] | Effective October 29, 2025 |
| [OpenAI Privacy Policy][privacy] | Updated July 30, 2026; canonical Services Communications Privacy Policy |
| [Europe Privacy Policy][eu-privacy] | Updated August 24, 2026 |
| [Text-to-speech guide][speech] | No date shown |
| [API data controls][data] | No date shown |
| [OpenAI branding][brand] | No date shown |

[identity-help]: https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt
[plan-help]: https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites
[quickstart]: https://developers.openai.com/siwc/quickstart.md
[overview]: https://developers.openai.com/siwc/token-sharing-open-source.md
[registration]: https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md
[sessions]: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md
[tokens]: https://developers.openai.com/siwc/token-sharing-open-source/token-reference.md
[models]: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md
[limitations]: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md
[errors]: https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md
[vms]: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms.md
[app-server]: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md
[website]: https://developers.openai.com/siwc/website.md
[client-id]: https://developers.openai.com/siwc/request-client-id.md
[cookbook]: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
[siwc-terms]: https://openai.com/policies/sign-in-with-chatgpt-terms/
[service-terms]: https://openai.com/policies/service-terms/
[row-terms]: https://openai.com/policies/row-terms-of-use/
[eu-terms]: https://openai.com/policies/eu-terms-of-use/
[services-agreement]: https://openai.com/policies/services-agreement/
[usage]: https://openai.com/policies/usage-policies/
[privacy]: https://openai.com/policies/privacy-policy/
[eu-privacy]: https://openai.com/policies/eu-privacy-policy/
[speech]: https://developers.openai.com/api/docs/guides/text-to-speech
[data]: https://developers.openai.com/api/docs/guides/your-data
[brand]: https://openai.com/brand/
