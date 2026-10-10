# Codex Chat SIWC source check, corrected for v0.22.0

Review date: 2026-10-10.

Scope: read-only comparison against `/tmp/relmio-winqa/wt`. `package.json:3` identifies version `0.22.0`. The assignment identifies this worktree as `origin/main` at `0e7ab6f` plus an installer fix; commit ancestry was not independently checked. All implementation citations below refer to this worktree, not the stale checkout used by the earlier report.

No files changed. No sign-in, credential-file access, provider API call, form submission, SSH connection, Docker execution, browser QA, build, or test was performed. Public documentation fetches are the only external requests made for this review. This is an engineering source comparison, not legal advice, OpenAI approval, or a certification of an installed runtime.

Labels: **Confirmed** means official OpenAI documentation states it; **Observed** means inspected Relmio source shows it; **Provisional** means non-OpenAI evidence cannot establish provider permission; **Open** means evidence does not settle the question. Unexercised consequences are marked **[INFERENCE]**.

## Decision

**v0.22.0 already implements SIWC for the Codex Chat Adapter, direct Codex App Server, and the n8n ChatGPT text sidecar. A proposal to “revamp Codex Chat Adapter to SIWC” does not describe a missing authentication migration in this version.**

The adapter already obtains a selected Relmio registration's plan-authorized access token, supplies it to an official Codex App Server child through `ACCESS_TOKEN`, and uses the documented public Responses provider. It does not use the old Codex-managed device-code login (`src/gateway/codex-chat.js:330-343,891-929`; `src/gateway/codex-app-server.mjs:10-24`).

**The connected-application restriction is therefore a current product-boundary question, not merely a risk of a future SIWC migration.** The n8n sidecar already accepts OpenAI-compatible requests and spends SIWC plan tokens. Codex Chat already accepts arbitrary conversational text from authenticated local backends. The direct App Server already relays a much broader JSON-RPC surface for trusted native clients. None of their local bearers establishes that the request belongs to Relmio's own application functionality or that another person's activity did not trigger it.

[SIWC Terms §2](https://openai.com/policies/sign-in-with-chatgpt-terms/) expressly says:

> “Use the user's plan only for the application they connected. Do not provide general-purpose API access for other tools or unrelated requests.”

**Confirmed:** general-purpose access for other tools or unrelated requests is prohibited. **Observed:** v0.22.0 already contains interfaces capable of that use. **Open:** OpenAI has not established in the reviewed sources whether Relmio's specifically bounded, same-user n8n deployment or a particular native client counts as part of the connected application. Do not turn that unresolved classification into either blanket approval or a claim that every request through these interfaces violates the Terms.

Changing authentication ceremony, endpoint spelling, or loopback binding cannot resolve this. For unrestricted other-tool workflows, use separately authorized Platform API access or a local model. An application-bound SIWC design can reuse the implementation already present, but needs a defensible application/use boundary.

## Current official sources

Same-day source evidence from the earlier report was reused. The required Help Center article was fetched first again. Registration, App Server integration, SIWC Terms, and privacy were also rechecked to compare their exact requirements with the newly identified implementation. Other rows retain the official evidence fetched earlier on 2026-10-10. Dates below are displayed dates, not inferred publication dates.

| Source | Displayed date | Evidence handling |
|---|---|---|
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 8 days ago | Refetched first |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: 2 days ago | Same-day evidence reused |
| [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source.md) | Not shown | Reused |
| [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) | Not shown | Refetched |
| [SIWC Codex App Server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md) | Not shown | Refetched |
| [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md) | Not shown | Reused |
| [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md) | Not shown | Reused |
| [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md) | Not shown | Reused |
| [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference.md) | Not shown | Reused |
| [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms.md) | Not shown | Reused |
| [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines.md) | Not shown | Reused |
| [Official SIWC cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) | Not shown | Reused |
| [Codex authentication](https://developers.openai.com/codex/auth/), resolving to [authentication guide](https://learn.chatgpt.com/docs/auth) | Not shown | Reused |
| [Codex App Server](https://developers.openai.com/codex/app-server/), resolving to [App Server guide](https://learn.chatgpt.com/docs/app-server) | Not shown | Reused |
| [Codex models](https://developers.openai.com/codex/models/), resolving to [model guide](https://learn.chatgpt.com/docs/models) | Not shown | Reused |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 | Refetched |
| [Service Terms](https://openai.com/policies/service-terms/) | Updated September 29, 2026 | Reused |
| [Terms of Use](https://openai.com/policies/terms-of-use/), canonical [ROW Terms](https://openai.com/policies/row-terms-of-use/) | Published/effective January 1, 2026 | Reused |
| [Services Agreement](https://openai.com/policies/services-agreement/) | Updated December 1, 2025; effective January 1, 2026 | Reused |
| [Usage Policies](https://openai.com/policies/usage-policies/) | Effective October 29, 2025 | Reused |
| [Privacy Policy](https://openai.com/policies/privacy-policy/), canonical [Services Communications Privacy Policy](https://openai.com/policies/services-communications-privacy-policy/) | Updated July 30, 2026 | Refetched |

All external permission/capability evidence used here is from OpenAI domains. References to Hermes, n8n behavior, package metadata, repository test reports, and owner-reported live results are **Provisional** for provider permission. The repository remains direct **Observed** evidence of its own implementation. No social post or private correspondence was used as approval.

Applicable regional terms, account agreement, workspace policy, and any negotiated exception remain unknown. The public policy pages are not an account-specific ruling.

## Corrections to the earlier stale-checkout report

The earlier report inspected v0.17.5 under `/Users/demonbane/Documents/personal projects/relmio-herdr`. These implementation conclusions must be replaced:

| Earlier finding | Correct v0.22.0 finding |
|---|---|
| Relmio has no own SIWC registration, plan-scope validation, or explicit SIWC Responses provider. | All three exist: `src/services/oauth.js:54-74,140-170,198-208`; `src/services/siwc-session.mjs:545-580,737-766`; `src/gateway/codex-app-server.mjs:10-24`. |
| Codex Chat uses `account/login/start` with `chatgptDeviceCode`. | Codex Chat obtains `getAccessToken()` from its selected Relmio registration and starts the child with `ACCESS_TOKEN`: `src/gateway/codex-chat.js:891-929,330-343`. `src/services/codex-login.js:8-59` now implements installed SIWC management commands, not the old device login. |
| Separate host `oauth.js` delegates to Codex CLI and copies `auth.json`. | `oauth.js` now implements native Authorization Code + PKCE/OIDC dynamic registration. Tokens are stored in protected registration records, not imported from personal Codex: `src/services/oauth.js:54-223`; `src/services/siwc-session.mjs:59-69,545-601`. |
| Codex owns the adapter's provider-token persistence and refresh. | Relmio owns token storage, ownership transfer, refresh, scope checks, and revocation. Codex receives an access token in its child environment: `src/services/siwc-session.mjs:737-807,856-900`; `src/gateway/codex-chat.js:330-343`. |
| n8n uses a separate whole-Codex-credential compatibility bridge. | Text n8n requests now use SIWC access tokens and public `/v1/responses`: `src/gateway/openai-oauth-sidecar.mjs:992-1079`. The separately authenticated Codex image add-on remains distinct. |
| Plan consent, first-use notice, account controls, and SIWC sign-out would all need introducing. | They already exist: `src/ui/siwc-controls.js:277-340`; `src/web/server.js:355-362,4009-4035`; `src/services/siwc-session.mjs:603-619,856-900`. |
| README has only the outdated identity-only description and no current SIWC flow. | README already distinguishes identity, plan permission, models, transfer, and unresolved Terms issues: `README.md:148-163,225-237,506-543`. |
| Adapter has no application/account/model binding at all. | It binds conversations to issuer/client/subject and model, and checks the account catalog. It still lacks a connected-application/workflow-purpose boundary: `src/gateway/codex-chat.js:891-932`. |
| Local Codex pins are 0.147.0 and a separate host-login pin is 0.154.0. | Current local Codex pin is 0.160.0: `src/services/model-discovery.mjs:14-15`; Dockerfiles consume it at `src/domain/local-endpoints.js:393-425`. |
| The general-purpose SIWC concern applies only to a proposed future migration. | It applies to already implemented v0.22.0 SIWC-backed interfaces. |

The earlier report's separation of identity, permission, and capability still holds. Its warning that locality and `/chat` naming are not Terms exemptions also still holds. Its claim that the migration itself had not happened was wrong for current released source.

## Findings: identity sign-in

### Question (a): What is SIWC, and does v0.22.0 implement it?

**Confirmed:** the [Help Center article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) describes identity sign-in and separately approved subscription sharing. Identity alone does not expose ChatGPT conversations or memory and does not authorize plan spending.

**Observed:** v0.22.0 implements the documented dynamic public-client flow:

- A stable host UUID is persisted in `host.json`; each registration retains its issued client ID and verified issuer/subject (`src/services/siwc-session.mjs:401-420,528-544,566-601`).
- A new attempt uses random state, nonce, and S256 PKCE. Callback listens on `127.0.0.1` with `/auth/callback`; state is checked and consumed before exchange. Host, duplicate parameters, optional issuer, deadline, and returned client ID are checked (`src/services/oauth.js:71-74,103-151,186-208`).
- Initial authorization uses `dynamic_agent_client`, `agent_name_hint=Relmio`, and `ext_agent_host_id`; later sign-ins use the saved issued client ID (`src/services/oauth.js:198-208`).
- Token exchange uses the issued client ID, code/verifier, exact redirect URI, and API resource. ID-token verification checks JWKS signature, issuer, issued-client audience, expiration, nonce, and returning subject (`src/services/oauth.js:152-171`; `src/services/siwc-session.mjs:621-660`).
- Identity is issuer/client/subject, not email. The normalized stored identity retains optional email; it does not separately retain name or picture fields, though the raw ID token is retained (`src/services/siwc-session.mjs:558-601`).

**Important scope detail:** both `purpose: "sign-in"` and `purpose: "enable-plan"` send the same six scopes:

`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`

Both use resource `https://api.openai.com/v1`; `enable-plan` additionally uses `prompt=consent` and requires an existing registration (`src/services/oauth.js:10-11,54-69,198-208`). Relmio separates granted permission and local enablement, but does not implement two different authorization scope sets. It would be inaccurate to say the first outgoing authorization URL requests only identity.

This matches the documented combined registration request while preserving an identity-only result if OpenAI returns no plan permission. The actual browser consent screens were not exercised.

## Findings: separately approved permissions

### Question (b): What scopes are requested and validated? Who owns refresh?

**Confirmed:** [registration guidance](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) requires checking the token response's granted `chatgpt.tokens.use.direct` before inference. A valid ID token alone is insufficient.

**Observed:** Relmio parses and stores the token response's `scope`, token type, access/refresh/ID tokens, receipt time, expiry, and optional refresh metadata. It does not use callback `scope` as authority (`src/services/oauth.js:126-169`; `src/services/siwc-session.mjs:545-564`).

The specific permission gate is `chatgpt.tokens.use.direct`, combined with enabled plan use and correct host/runtime ownership. The implementation does not require exact equality with all six requested scopes or independently require `resource.invoke`/`offline_access` membership before every request. Installs require a refresh token as well (`src/services/siwc-session.mjs:603-619,737-766`; `src/services/local-installer.js:2529-2542`; `src/services/local-n8n-sidecar-installer.js:1744-1757`). This is a description of the actual checks, not a claim of six-scope validation.

New authorization does not automatically enable plan use. Separate controls enable/pause it, and the wizard requires first-use acknowledgment before model discovery or installation review. The low-level token lease checks plan state/scope/ownership; acknowledgment is enforced in the wizard/review path, not repeated inside `getAccessToken()` (`src/services/siwc-session.mjs:588-619,737-766`; `src/web/server.js:355-362,3675-3686,4009-4035`; `src/ui/siwc-controls.js:319-340`).

Relmio serializes refresh by registration and atomically publishes token records. Before sending a refresh it persistently freezes plan use. It rotates the access token, refresh token, scope set, and expiry together, verifies a returned ID token and client ID, and blocks uncertain or terminal outcomes rather than replaying an uncertain refresh token (`src/services/siwc-session.mjs:137-166,182-256,693-807`).

Sign-out attempts provider revocation of the refresh token, then clears local token state and background consent while retaining the registration/identity mapping. An uncertain rotation prevents claiming confirmed revocation merely from HTTP 200 (`src/services/siwc-session.mjs:856-900`).

**Changed from the earlier report:** browser versus device code is no longer a choice between two current Codex Chat authentication ceremonies. The text adapter already uses Relmio SIWC. Device code remains relevant to the separate image add-on.

### Question (c): Which features already consume SIWC plan grants?

| Feature | Current source behavior | Finding |
|---|---|---|
| n8n ChatGPT plan text add-on, local or VPS | Local bearer protects `/v1/models`, `/v1/responses`, and `/v1/chat/completions`. Text requests obtain `getAccessToken()` and send that bearer to public OpenAI Responses. Chat Completions is translated to Responses. | **Observed: SIWC already implemented.** `src/gateway/openai-oauth-sidecar.mjs:992-1079`. |
| n8n AI Assistant through that add-on | Uses the same compatible endpoint and local bearer; no separate provider grant is requested for Assistant traffic. README supplies configuration and warns against other users' Assistant requests. | **Observed: same SIWC text path.** `README.md:362-373`; `src/gateway/openai-oauth-sidecar.mjs:992-1079`. |
| Direct Codex App Server | WebSocket admission checks local bearer; relay obtains a SIWC lease and account catalog, starts official App Server over stdio with `ACCESS_TOKEN`, and forwards JSON-RPC except listed exclusions. | **Observed: SIWC already implemented.** `src/gateway/codex-app-server.mjs:28-32,67-132,219-267`. |
| Codex Chat Adapter | Local bearer protects `/models` and `POST /chat`. Chat accepts text, optional conversation ID and model, obtains a SIWC lease with enough remaining lifetime, checks catalog and conversation binding, then starts a read-only App Server turn. | **Observed: SIWC already implemented.** `src/gateway/codex-chat.js:270-306,330-343,811-866,891-939`. |
| Wizard model picker and optional model checks | Catalog calls use SIWC token. Optional sidecar probes send `Reply with OK.` / `OK` through public Responses and record consent/results. | **Observed: SIWC consumers.** `src/web/server.js:3675-3686`; `src/gateway/openai-oauth-sidecar.mjs:1085-1101`; `src/services/model-discovery.mjs:691-722,929-933`. |
| Image generation/editing | Routes dispatch to a separate Codex-image lease before the SIWC text lease. Requests go to `https://chatgpt.com/backend-api/codex/images/generations` or `/images/edits`. | **Observed: not SIWC plan-token inference.** `src/gateway/openai-oauth-sidecar.mjs:26,920-949,1004-1006`. |

One registration is transferred to its selected runtime; this is not one live token record shared concurrently among every target. Handoff freezes the source, destination receives a new host/runtime ownership binding, and a matching receipt clears source tokens. Codex targets pass `backgroundConsent:false`; n8n installs require a versioned background-consent record (`src/services/local-installer.js:3347-3379`; `src/services/local-n8n-sidecar-installer.js:2025-2026,2372-2401`; `src/services/installer.js:470-471,729-782`; `src/services/siwc-session.mjs:904-938,987-1055`).

### Question (d): Does existing use reach the Terms' general-purpose-bridge restriction?

**Yes, the restriction is directly relevant to current code.** The clearest case is the n8n OpenAI-compatible sidecar: caller-selected models, messages/instructions, supported tools, and tool results are accepted and relayed using the SIWC plan token (`src/gateway/openai-oauth-sidecar.mjs:992-1079`). It has protocol restrictions, but is not limited to a fixed Relmio-owned task.

Codex Chat is narrower: read-only text turns, no general `/v1` contract, account/model-bound conversations. It still accepts arbitrary text from trusted local backends and contains no connected-client application identity or task-purpose field (`src/gateway/codex-chat.js:270-306,839-866,891-932`). Direct App Server exposes a broader native-client surface, forwarding methods except its deny-list and identity/model/thread restrictions (`src/gateway/codex-app-server.mjs:219-267`).

**Observed controls:** local bearer possession, Host/Origin restrictions, selected registration ownership, model/thread restrictions, n8n deployment review, and n8n background-use consent. **Not established by those controls:** whether the caller is the connected application, whether its use is unrelated, or whether a different person's request triggered a workflow. The sidecar does not identify individual n8n users.

[SIWC Terms §2](https://openai.com/policies/sign-in-with-chatgpt-terms/) also permits expressly authorized background processes for the authenticated user and prohibits another user's activity from triggering requests. Relmio's n8n checkbox states that boundary (`src/ui/local.html:997-999`); it cannot technically enforce downstream workflow authorship or trigger ownership.

**Confirmed conclusion:** a general-purpose SIWC gateway for unrelated tools is not allowed by the quoted Terms. **Open classification:** whether the selected single-owner n8n deployment, Assistant, or a specific native integration is sufficiently application-bound. The current README already identifies n8n compatibility as unresolved (`README.md:155-163,362-373`; `docs/faq.md:148-152`).

The earlier [App Server continuation guidance](https://learn.chatgpt.com/docs/app-server) for qualifying local/open-source applications does not exempt new SIWC-token requests from SIWC Terms. Nor does an identity article, successful login, model response, private Docker network, or user-owned computer establish blanket compliance.

### Question (e): Does running locally change this conclusion?

**Confirmed:** locality and user control matter to eligibility and deployment. They do not remove the connected-application restriction.

**Observed:** Codex targets listen on all container interfaces but publish only a host-loopback port. The n8n sidecar joins the reviewed Docker network without publishing a host port (`src/domain/local-endpoints.js:450-471,541-561`; `src/domain/local-n8n-sidecar.js:120-146`; `src/domain/templates.js:29-49`). Provider inference still goes to OpenAI. Tool-network restrictions are not provider-egress restrictions.

For VPS use, renewable tokens persist on the remote server. [SIWC Terms §1](https://openai.com/policies/sign-in-with-chatgpt-terms/) requires persistent tokens to be local and user-controlled, “not in a remote or managed environment.” The [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms.md) describes transfer to user-controlled VMs, while Terms §2 allows user-controlled remote requests. That source tension remains unresolved; neither successful handoff nor explicit owner approval resolves the provider's storage terms.

## Findings: model and TTS capability

**Confirmed:** the documented SIWC App Server configuration uses `https://api.openai.com/v1`, `wire_api="responses"`, `requires_openai_auth=false`, `supports_websockets=false`, and an access-token environment variable. No separate Codex sign-in is required. Relmio already configures that provider (`src/gateway/codex-app-server.mjs:10-24`; `src/domain/local-endpoints.js:263-278`).

**Observed:** the text sidecar sets `store:false` and `stream:true`; Chat Completions is translated. Unsupported features are restricted, and client output-token caps are deliberately dropped rather than enforced (`src/gateway/openai-oauth-sidecar.mjs:22-25,744-747,1010-1035`; `README.md:324-328`). The adapter checks `turn.status === "completed"` and rejects failed/interrupted turns (`src/gateway/codex-chat.js:594-628`).

Model catalogs are evidence of a listing, not entitlement. Relmio fetches account models and can perform separately approved sidecar probes; it cannot infer universal model availability from sign-in. App Server sockets close before token expiry and require reconnection; the Chat Adapter starts a child per request with a sufficiently fresh lease (`src/gateway/codex-app-server.mjs:91-105,153-156`; `src/gateway/codex-chat.js:891-903,330-343`).

**Open:** current account/model admission and runtime success. Historical live results described in `README.md:321-323,368-373` were not repeated and do not establish current entitlement or Terms permission.

**Confirmed capability limit:** the [SIWC preview documentation](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md) does not grant audio/TTS, video, transcription, Files API, or SIWC image-generation access. **Observed:** reviewed text interfaces implement no TTS route. Successful identity, plan authorization, or text response cannot establish TTS support.

### Separate image authentication

The image add-on implements Codex device authorization itself using a fixed Codex public client ID, `auth.openai.com/api/accounts/deviceauth/usercode`, device polling, and `auth.openai.com/oauth/token`. It stores its own access/refresh session and derives account, plan, and expiry fields from token claims (`src/services/codex-images.mjs:12-24,75-87,302-328,385-446`). It does not use Relmio's issued SIWC client, SIWC scope validator, or SIWC ID-token-verification path. Its actual granted scopes remain **Open**: these requests supply no explicit scope list, and the stored image session does not retain a granted-scope set.

Storage is `${storageRoot}/codex-images/session.json`, with a separate pending device-login file and lock. Refresh and sign-out are independent (`src/services/codex-images.mjs:89-150,335-372,459-508`). Image requests send the Codex token, account ID, prompt/input images, and optional residency/FedRAMP headers to the Codex backend route (`src/gateway/openai-oauth-sidecar.mjs:920-949`).

**Observed:** SIWC text permission is not the authorization source for these image requests. The image route dispatches before the text lease check; pausing SIWC plan use does not itself disable the image login. Security docs disclose this (`docs/security.md:543-549`). **Open:** provider permission for this other-app Codex image route. Hermes similarity is **Provisional**, not OpenAI authorization. README already says OpenAI does not document this route for other apps (`README.md:342-350`).

## Relmio data flow

These are source-level behaviors, not captured traffic. Credential contents were not opened.

| Stage | Reads / stores / transmits / logs | Recipients and evidence |
|---|---|---|
| Registration browser flow | Reads selected registration/purpose. Holds fresh state, nonce and PKCE verifier in process memory. Sends app name, host ID, client ID, six scopes, resource, callback and PKCE challenge to OpenAI. Receives callback code/client ID. | User's system browser, local callback server, OpenAI authentication. `src/services/oauth.js:54-74,103-171,186-208`. |
| Identity and token verification | Reads discovery/JWKS and token response. Checks identity cryptographically. Stores issuer, subject, issued client, optional email, tokens, granted scopes, expiry, owner, generations and local consent/state. Browser receives account views, not token records. | Relmio wizard/backend, protected filesystem, OpenAI authentication. `src/services/siwc-session.mjs:383-399,545-660`; `src/services/oauth.js:39-50,152-171`. |
| Host storage | Root is `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth`. Registrations are `registrations/<id>.json`; `host.json` and `selection.json` retain host and selection. Unix owner-only directories/files, Windows ACL handling, atomic writes. File protection is not encryption at rest. | User-controlled host storage. `src/services/siwc-session.mjs:59-69,78-166,401-420,479-492`. |
| Refresh/revocation | Sends refresh token, issued client ID and resource to supported token endpoint. Persists frozen/rotated state. Revocation sends refresh token and client ID to discovered revocation endpoint; sign-out removes token fields from the record. | OpenAI authentication and owning runtime's storage. `src/services/siwc-session.mjs:661-682,737-807,856-900`. |
| Installation handoff | Reads and transfers the selected full registration record, including renewable credentials, via helper stdin. Source remains frozen until identity/target-bound receipt; source token fields then cleared. Local install uses Docker process input; VPS uses reviewed SSH exec input. | Local wizard, Docker daemon/helper, selected container; VPS adds SSH server/remote runtime. `src/services/local-installer.js:3347-3379`; `src/services/codex-login.js:32-58`; `src/services/local-n8n-sidecar-installer.js:2372-2401`; `src/services/installer.js:729-782`; `src/services/siwc-session.mjs:904-938,987-1055`. |
| Installed provider storage | Container root is `/home/node/.relmio-siwc`. Local targets use private project-scoped `siwc-store` volumes. VPS mounts `/docker/n8n-openai-oauth/siwc`. Compose contains registration/runtime IDs and a local bearer hash, not provider tokens. | Local Docker storage or selected VPS filesystem. `src/domain/local-endpoints.js:450-471,541-561`; `src/domain/local-n8n-sidecar.js:120-146,217-222`; `src/domain/templates.js:29-43,95-103`; `src/domain/safety.js:64`. |
| n8n local credential | Generated Relmio capability is separate from OpenAI credentials. Installer returns it once and saves its hash. For matching Relmio-created n8n, server attempts credential import. | Wizard/browser and n8n credential store receive local bearer; provider tokens stay in sidecar store. `src/services/local-n8n-sidecar-installer.js:2112-2115,2518-2522`; `src/web/server.js:4908-4928`; `docs/security.md:328-337`. |
| n8n text inference | Reads local bearer, caller model, supported messages/instructions/tools/results, and SIWC lease. Sends content and SIWC bearer to public Responses. Returns JSON/SSE/model outputs to caller; sidecar does not execute n8n tools. | n8n or another admitted bearer holder, sidecar, OpenAI. `src/gateway/openai-oauth-sidecar.mjs:104-115,992-1079`; `docs/security.md:338-342`. |
| Codex Chat inference | Reads bounded text/model/conversation ID, local bearer, account identity and SIWC lease. Passes only provider access token explicitly as `ACCESS_TOKEN`; sends conversation commands over stdio. Returns text/thread ID. Conversation-to-identity/model map is process memory. | Local backend, gateway, official Codex child, OpenAI inference. `src/gateway/codex-chat.js:270-306,330-343,448-484,594-628,891-939`; provider args `src/gateway/codex-app-server.mjs:10-24`. |
| Direct App Server | Reads authenticated native JSON-RPC, SIWC lease/account/catalog, and persistent identity/model/thread bindings. Passes access token to child. Forwards permitted client requests and child replies; redacts known tokens in outbound JSON. | Trusted native client, relay, Codex child, OpenAI; tools authorized through the broader App Server surface can have further destinations. `src/gateway/codex-app-server.mjs:91-132,163-197,219-267`; `src/services/siwc-session.mjs:808-853`. |
| Local history and sandbox | Codex state/workspace volumes persist. Chat uses thread start/resume. Generated config denies model filesystem access to SIWC store, disables analytics/feedback, and uses read-only chat permissions. These are not an OS boundary against same-UID trusted App Server tools. | Container storage and trusted host/Docker administrators. `src/domain/local-endpoints.js:243-289,468-471,558-561`; `src/gateway/codex-chat.js:448-484`; `docs/security.md:106-111,343-352`. Exact Codex internal history retention was not audited. |
| Built-in chat tester | Browser sends encrypted local bearer plus prompt/model/conversation to wizard. Wizard decrypts bearer in memory and forwards request to `/chat`; it clears byte buffers afterward. Wizard is a prompt/bearer recipient, not an end-to-end encrypted pass-through. | Browser, local wizard, adapter, then Codex/OpenAI. `src/services/local-chat-test.js:438-479,525-597`. |
| Remembered Responses items | Keeps completed assistant text and encrypted reasoning/summary in a process-wide cache: at most 4,096 items, 32 MiB, six hours. Replays referenced items to OpenAI. Shared among the process's bearer-authorized callers; lost on restart. | Sidecar process memory, calling n8n/clients, OpenAI on replay. `src/gateway/openai-oauth-sidecar.mjs:19-21,349-401,998,1022-1035,1074-1079`; `docs/security.md:651-670`. |
| Models and optional probes | Reads account catalog using SIWC bearer. n8n sidecar queries npm for latest stable Codex version without provider credentials. Optional probes send fixed `OK` request. Records model results, consent, timestamps, and cached version metadata under `model-checks/<id>.json`. | OpenAI; npm receives package metadata request, not prompts/tokens. Wizard receives status/results. `src/services/model-discovery.mjs:15-28,522-538,555-570,649-672,691-722,929-933`. |
| Usage records | Reads response outcomes and completed token counts; stores daily/model aggregates and last usage-error time/code in `activity/<id>.json`. Keeps 31 days and up to 64 named models/day. No prompt/output/token credential stored in that record. | Owning runtime disk; management CLI/wizard can read counts. `src/services/model-discovery.mjs:58-75,833-899,946-953`; sidecar tallies at `src/gateway/openai-oauth-sidecar.mjs:1040-1052`. |
| Image add-on | Reads device authorization result and its own tokens/account claims; stores separate protected session/pending records. Sends Codex bearer/account ID, prompt/images and metadata to Codex image backend; returns base64 output. | Browser for device approval, sidecar/VPS storage, OpenAI auth and Codex backend, n8n. `src/services/codex-images.mjs:12-24,89-150,302-372,385-446`; `src/gateway/openai-oauth-sidecar.mjs:920-972`. |
| Logs and errors | OAuth substitutes bounded safe errors instead of token-response bodies. Chat parses bounded stdout and counts/discards stderr; relay discards stderr and redacts known credentials. Gateways print fixed startup failures. Usage records and history remain separate forms of stored data. | Local processes and Docker log system; callers receive bounded error/status data. `src/services/oauth.js:17-34,180-183`; `src/gateway/codex-chat.js:648-681,996-1004`; `src/gateway/codex-app-server.mjs:192-197,214-217,283-287`; `src/gateway/openai-oauth-sidecar.mjs:44-67,1155`; `src/domain/local-endpoints.js:489-490`. No claim about all Codex internals, n8n logs, or OpenAI logs follows. |
| Wizard metadata and package downloads | Separate from inference: GitHub star-count request, with fallback to Relmio website, carries version User-Agent. Docker/npm installation fetches packages/images. | GitHub, `relmio.jpfusin.tech`, npm and image-distribution infrastructure. `src/services/project-meta.js:7-8,16-35`; `src/domain/local-endpoints.js:393-425`; `src/domain/templates.js:9-17`. No token/prompt is passed to metadata readers. |

**[INFERENCE]** Host/root/Docker administrators, backups, swap, n8n execution history, and downstream workflow/tool services are additional exposure boundaries. Actual downstream recipients depend on selected workflows and App Server tools and cannot be enumerated from the gateway alone. No Relmio-operated prompt collector was found in the inspected inference path; the website metadata fallback means “Relmio never contacts a Relmio server” would still be inaccurate.

The [Privacy Policy](https://openai.com/policies/privacy-policy/) describes OpenAI collection of content, account information, IP/device/log/usage data, and conditional disclosure to service providers, affiliates, administrators, and other listed recipients. Those are policy categories, not proof that every recipient receives every Relmio request. Its exclusion for business-offering customer content does not by itself settle which retention/training agreement covers SIWC plan-funded requests at the public API URL. `store:false`, local hosting, and encrypted reasoning are not blanket zero-retention or no-training guarantees.

## Disclosure gaps and source/code mismatches

1. **Withdraw stale missing-SIWC findings.** Current README, FAQ, security docs, local UI, and code already describe and implement Relmio-owned SIWC. They should not be rewritten to introduce a migration that already happened (`README.md:225-237,506-543`; `docs/faq.md:15-37`; `src/ui/local.js:3426-3428`).

2. **Apply the connected-app warning to every relevant interface.** README/FAQ explicitly discuss the unresolved n8n case, but Codex sections emphasize “not /v1,” native clients, and trusted local backends (`README.md:506-520,540-543`; `src/ui/local.html:445-446`; `docs/local-endpoints.md:19-29`). Those are protocol/security properties. They do not settle whether other applications' requests are permitted. The same warning applies to Codex Chat and direct App Server when offered as other-tool bridges.

3. **Do not describe the first OAuth request as scope-limited identity-only sign-in.** Both purposes request identity plus plan scopes; returned grant, local plan toggle, and acknowledgment are distinct (`src/services/oauth.js:10-11,198-208`; `src/ui/siwc-controls.js:319-340`). Existing copy is mostly consistent, but explanations should preserve this distinction.

4. **Background consent exists for n8n, not arbitrary Codex-client automation.** n8n's checkbox expressly covers the authenticated user's own workflows. Codex target handoff supplies `backgroundConsent:false`, and `/chat` accepts no background-purpose/consent field (`src/ui/local.html:997-999`; `src/services/local-installer.js:3347-3351`; `src/gateway/codex-chat.js:270-306`). Do not imply installation approval or bearer possession covers all background use.

5. **“Same selected account” does not mean one registration remains active in every runtime.** README's two-target wording should be read alongside ownership-transfer rules (`README.md:517-520`; `src/services/siwc-session.mjs:904-938,987-1055`). Each completed handoff clears source tokens; separate installations must not be portrayed as a shared renewable-token pool.

6. **Image permission remains separate and unresolved.** Existing warnings correctly distinguish Codex image login from SIWC. Keep that warning; do not use successful SIWC text or the Help Center identity article to legitimize the image backend route (`README.md:342-350`; `docs/faq.md:78-104`). Pausing text plan use leaves the image session intact, as disclosed.

7. **Account controls are implemented; capability remains unproven by sign-in.** Current source has first-use acknowledgment, catalog checks, sign-out/revocation state, thread binding, and completed-turn checks. The earlier guidance-only sign-out and device-login “ready” observations must not be carried forward. None of those controls substitutes for a completed authorized runtime request.

8. **Retained ID-token hint is not sent on reauthorization.** Registration docs describe retaining `id_token` for `id_token_hint`; Relmio retains it but sends neither that hint nor `login_hint` (`src/services/siwc-session.mjs:558-564`; `src/services/oauth.js:198-208`). The same docs explicitly describe an account-selector path without a hint, so this is a UX difference, not evidence of a permission failure. Returning subject/client checks remain present.

9. **Existing storage/privacy warnings are substantive, not missing.** Protected records, remote-transfer uncertainty, remembered Responses items, aggregate counts, and n8n bearer persistence are already disclosed (`docs/security.md:146-199,328-337,553-670`; `docs/faq.md:136-152`). The unresolved provider-storage and connected-app questions still require resolution; adding more consent text cannot override them.

10. **Separate static packaging concern, not exercised:** Chat Adapter imports `./codex-app-server.mjs` (`src/gateway/codex-chat.js:7`), while its generated Docker ignore allowlist names `codex-chat.js` and `openai-oauth-sidecar.mjs` but omits `codex-app-server.mjs` (`src/domain/local-endpoints.js:134-136`). The installer asset list contains the file (`src/services/local-installer.js:76-80`). **[INFERENCE]** The ignore rule may exclude the imported module from a newly built Chat Adapter image. This does not change the authentication architecture finding, but source presence must not be reported as successful deployment. No build was run to test it.

## Recommended design, relative to v0.22.0

### What “revamp Codex Chat Adapter to SIWC” would concretely change

If it means “replace Codex device login with Relmio dynamic registration, separate plan permission, protected storage, Relmio refresh, and an access-token Responses provider,” **nothing fundamental remains to migrate**: those components already exist.

If it means “fix the connected-application issue,” it is a product/use-boundary change, not an OAuth replacement:

- Define which Relmio-owned feature the connected application supplies. Identify whether the native client or n8n deployment is part of that application, with provider clarification where needed.
- Restrict admitted use to that feature and authenticated user. Do not treat a generic bearer, a private network, account-bound threads, or a renamed route as proof of application scope.
- Obtain express consent for application-owned background work. Do not let other users' actions spend the account holder's plan.
- Keep unrestricted n8n/other-program access on separately authorized API access or a local model. This is a proposed alternative, not an approved silent reduction of the requested product scope.

Reuse the existing SIWC registration/session/handoff code and supported App Server provider rather than creating a second OAuth stack. Preserve scope-loss, uncertain-refresh, account binding, first-use notice, and revocation behavior. Keep provider tokens out of browser state, process arguments, Compose values, and downstream-client credentials. The current child access-token environment mechanism follows OpenAI's documented integration; same-UID trust limits still need disclosure.

Do not merge SIWC text and Codex image authorization. Do not claim TTS or image support from SIWC sign-in. Clarify remote token persistence before treating VPS use as provider-approved.

No implementation or scope change was made by this review.

## Unknowns and verification limits

- OpenAI's classification of Relmio's bounded n8n/Assistant/native-client use under “connected application only.” The prohibition on general-purpose other-tool access is explicit; the unresolved part is the classification of each actual application use, not whether the rule exists.
- Resolution of the remote-persistent-token wording versus self-hosted VM guidance.
- Actual consent screens and grants for an account, workspace/admin approval, negotiated agreement, model admission, limits, retention/training treatment, and any written provider exception.
- Actual image-token scopes, provider approval for the other-app Codex image route, and account-specific image availability.
- Exact pinned Codex internal request behavior, diagnostics/history retention, and deployed-image behavior. Wrapper source and official docs establish intended integration, not an exercised binary result.
- Whether the static Chat Adapter packaging concern affects the current candidate or any already-running image.
- Which applications possess local bearers, who triggers their requests, what n8n saves, and what configured workflow/App Server tools send onward.
- Source-check history includes prior live-test claims, but this review exercised none. Main agent may separately verify packaging, OAuth denial/scope loss, refresh/revocation, handoff ownership, local client admission, and an expressly authorized completed turn if that verification is commissioned.

Bottom line: **v0.22.0 already made the SIWC authentication change. Correct next question is whether its current bridge use stays within the connected Relmio application's permitted scope, not how to replace a device-code login that Codex Chat no longer uses.**
