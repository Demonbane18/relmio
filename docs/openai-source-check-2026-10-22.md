# OpenAI source check, 2026-10-22

This follows the [v0.22.2 addendum](openai-source-check-2026-10-07.md#addendum-v0222-release) of the 2026-10-07 record. It covers Relmio v0.22.3, the Node.js security hotfix in PR #125 (branch `hotfix/node-24.22.1-security`, base tag v0.22.2 at `10e668b`).

## Review scope

Check date: **2026-10-22**.

The change was compared through the GitHub diff of PR #125 from `10e668b` to head `3a2a941`, which lists 41 files. No local `git diff` was run, because this review had no shell. The working tree at `/private/tmp/relmio-hotfix-0.22.3` was read directly. It already holds edits made after `3a2a941`: `src/ui/guide/context.js` (`reviewedOn: "2026-10-22"`), `docs/contextual-help-source-check-2026-10-11.md` (a "0.22.3 metadata update" section), `docs/troubleshooting.md`, `docs/maintenance.md` and `web/app/components/CopyCommand.tsx`, all about the Node.js threshold. Another agent was editing installer and test files at the same time; this review did not read them beyond their names. File references describe the working tree as read.

This review did not sign in, call a provider API, read a credential, submit a form, use SSH or Docker, open a browser, build anything or run tests.

Labels: **Confirmed** means an official OpenAI source fetched today states it. **Observed** means Relmio source shows it. **Provisional** marks evidence that is not from OpenAI, such as the PR description, the CodeRabbit review and the Node.js release notes. **Open** means the reviewed evidence does not settle the question. Consequences that were not exercised are marked [INFERENCE].

## What changed

- **Observed:** The generated SIWC runtime `package.json` and the root entry of its lock now declare `engines.node` as `>=24.22.1` instead of `>=24` (`src/services/siwc-runtime-assets.js:47,57`). Package name, version, dependency list, lock checks and the source allowlist are unchanged.
- **Observed:** Generated Dockerfiles now start `FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` instead of the floating `node:24-bookworm-slim`. The constant is `src/domain/local-endpoints.js:7`. It is used by the VPS sidecar (`src/domain/templates.js:10`), the local sidecar (`src/domain/local-n8n-sidecar.js:85`), the Codex and Codex chat images (`src/domain/local-endpoints.js`, `createCodexDockerfile` and `createCodexChatDockerfile`) and the local-model helper (`src/domain/local-n8n-model.js:15`). The Grok build image pins `node:22.23.4-bookworm-slim@sha256:de170b39…` (`src/domain/local-endpoints.js:8`).
- **Observed:** `relmio` prints a warning to stderr when it runs on Node.js older than 24.22.1 on the 24 line or 26.12.1 on the 26 line, and keeps running (`src/cli.js:364-381`).
- **Observed:** `package.json` requires Node.js `>=24.22.1`. Installers, launchers, CI workflows, docs and the web install page change their Node.js thresholds. The help metadata `sourceVersion` is 0.22.3 (`src/ui/guide/context.js:6`).
- **Observed:** The PR diff touches no file under `src/gateway/`, and none of `src/services/oauth.js`, `src/services/siwc-session.mjs`, `src/services/model-discovery.mjs`, `src/browser.js`, `src/web/server.js` or the SIWC UI files. The compose templates, storage paths and container hardening are unchanged.

How existing installations get the patched base, from `CHANGELOG.md` on this branch: a VPS sidecar is rebuilt through **Review sidecar update** and **Update the sidecar**. A local sidecar has no in-place update; the user signs out and chooses **Review replacement with a fresh account**, or removes the bridge and sets it up again. Codex, Grok and local-model helper images take the pin when they are next installed or replaced.

## Sources

All fetched on 2026-10-22. The Sign in with ChatGPT article was fetched first. Developer and learn pages were read as Markdown and show no date. Relative dates are recorded as displayed.

| Source | Displayed date / note |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 4 days ago. It showed 9 days ago on 2026-10-11, so it changed after that check. [INFERENCE] about 2026-10-18 |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: 8 hours ago |
| [Managing your tenant in Admin Console](https://help.openai.com/en/articles/12289294-managing-your-tenant-in-admin-console), "Manage external access" | Updated: 13 hours ago. Linked from the Sign in with ChatGPT article; not listed in earlier records |
| [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | Updated: 8 hours ago |
| [SIWC open-source overview](https://developers.openai.com/siwc/token-sharing-open-source.md) | None |
| [SIWC registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) | None |
| [SIWC accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md) | None |
| [SIWC token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference.md) | None |
| [SIWC self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms.md) | None |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md) | None |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md) | None |
| [SIWC errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md) | None |
| [SIWC Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md) | None |
| [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines.md) | None |
| [Codex authentication](https://learn.chatgpt.com/docs/auth.md) | None. Opening section only |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server.md), authentication section | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 (unchanged) |
| [Service Terms](https://openai.com/policies/service-terms/), §15 | Updated: October 16, 2026. Earlier records showed September 29, 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) | Published and effective: January 1, 2026 (unchanged) |
| [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Updated: January 16, 2026 (unchanged) |
| [Privacy policy](https://openai.com/policies/privacy-policy/), canonical `/policies/services-communications-privacy-policy/` | Updated: July 30, 2026 (unchanged) |
| [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: August 24, 2026 (unchanged) |

Not fetched again: the general Responses API guides and reference pages, the data-controls guide, the Codex image and pricing pages, and the device-code pages listed in earlier 2026-10-07 addenda. This release changes no request shaping, no image route and no device sign-in, so those pages govern nothing that changed here. Their earlier findings stand as recorded.

### What changed in the sources since 2026-10-07

- **Confirmed:** The Sign in with ChatGPT article now has a section on delegated access and one on organization controls. An application "can separately request delegated access to specific data and actions", for example a ChatGPT Site asking for connected apps or HubSpot asking for a ChatGPT Ads account. "Identity sign-in and delegated data access are separate permissions." Global admins manage organization-level application permissions in **External access** in the OpenAI Admin Console, and "a workspace owner or admin does not automatically have permission to change these tenant-level settings." Sign in with ChatGPT is on by default for organizations without an explicit identity policy. The article still says identity sign-in releases only name, email address and profile picture, that identity sign-in can finish "without approving subscription sharing", and that subscription sharing "does not give the tool access to your ChatGPT conversations or memory." [INFERENCE] The delegated-access and External access text arrived with the update shown as 4 days ago; earlier records do not describe it.
- **Confirmed:** The tenant article says restricting identity sign-in "blocks new sign-ins to the affected applications", that existing identity-only tokens "can remain valid for up to 1 hour", and that organization approval "does not connect accounts on a member's behalf."
- **Confirmed:** The plan article says plan use in "participating commercial apps and sites" needs Go, Plus or Pro, and that "Supported open-source tools remain available to all ChatGPT users." Eligible requests count toward "the ChatGPT Work and Codex usage included in your plan." Credit use after plan limits is off by default, needs a separate opt-in, and needs the app's limit at 100%. Disconnecting is under **Settings > Security and login > Login connections**, and signing out of an app "does not disconnect it from ChatGPT or stop its authorized use of your plan." This review did not compare the text with the 2026-10-07 version, so it cannot say which of these sentences are new.
- **Confirmed:** Service Terms show a new date, October 16, 2026. §15 reads: users connecting through SIWC "agree to share information necessary to authenticate you (including name, email, and/or profile photo) and, where relevant, your ChatGPT usage." This review did not diff the September 29 text.
- **Confirmed:** Errors and recovery now names `force_reconsent=true` for use "only after OpenAI confirms deployment for your integration" and says "the existing OAuth `prompt=consent` mechanism remains supported before that rollout." Sign-in and accounts pages describe `id_token_hint` and `login_hint` for reauthorization. The overview recommends a JWK-thumbprint host ID and keeps UUID host IDs supported. Accounts and sessions says the Plus five-hour limit is shared across all apps. Whether these lines are new since 2026-10-07 was not checked.
- **Confirmed:** SIWC Terms, Terms of Use, both privacy policies, preview limitations and the models page carry the same dates or content summaries as before. The Codex App Server page still says app-server authentication "has never been permitted for commercial or h[osted services]" (text cut off in the fetch).

The following sources are **Provisional**. They are not OpenAI policy:

| Source | Used for |
| --- | --- |
| PR #125 description and CodeRabbit review, 2026-10-22 | The list of changed files, the digest check claim (`docker buildx imagetools inspect`), the test results, and the follow-up audit item that the VPS SIWC store sits under a `0755` parent reachable by host UID 1000. None of these were rerun or checked here |
| Node.js October 2026 security release notes, as quoted in the PR and CHANGELOG | Why the runtime floor moved. Not fetched |
| Owner report in the 2026-10-07 live result | A VPS sidecar update kept the sign-in and the Relmio key. Not rerun for this release |

## What Relmio reads, stores, transmits and logs

Everything here is **Observed** in source. None of it was exercised against OpenAI.

| Category | v0.22.3 change | Code |
| --- | --- | --- |
| Reads | The CLI now reads its own Node.js version. SIWC reads are unchanged: callback code, state and client ID, the token response, discovery and JWKS, and the verified ID token's `iss`, `sub` and optional `email` | `src/cli.js:375-376`; `src/services/oauth.js:148-171`; `src/services/siwc-session.mjs:625-631,644` |
| Stores | No new store. Generated `package.json` and lock metadata in the sidecar build context carry the new engines value only | `src/services/siwc-runtime-assets.js:47,56-59` |
| Transmits | No new SIWC recipient or field. Image builds now pull a digest-pinned base from the same registry | `src/domain/templates.js:10`; `src/domain/local-endpoints.js:7-8` |
| Logs | One new local stderr line from the CLI carrying the Node.js version string. Installers print a reason when they refuse an installed runtime. No sidecar log changed | `src/cli.js:377-381`; `src/gateway/openai-oauth-sidecar.mjs:1155` |

### Reads

- The sign-in callback reads `code`, `state`, `client_id` and any OAuth `error`, then exchanges the code and verifies the ID token. Relmio keeps the verified issuer, subject and optional email as identity (`src/services/oauth.js:148-171`).
- The sidecar reads Responses and chat bodies up to 2 MiB, checks the Relmio bearer, and fetches the SIWC lease (`src/gateway/openai-oauth-sidecar.mjs:13,1004-1038`).
- New in this release: `process.versions.node` for the warning (`src/cli.js:375`). It reads no account data.

### Stores

| Item | Where | Code |
| --- | --- | --- |
| Host identity | `host.json`, stable `urn:uuid:` host ID | `src/services/siwc-session.mjs:414-418` |
| Registration | `registrations/<registrationId>.json`: label, issued client ID, issuer, subject, optional email, owner host and runtime, access, refresh and ID tokens, granted scopes, expiry, plan, acknowledgment and background-consent state | `src/services/siwc-session.mjs:546-566,577-595` |
| Storage root | `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth`. On a VPS, `/home/node/.relmio-siwc` in the container, bound to `/docker/n8n-openai-oauth/siwc` | `src/services/siwc-session.mjs:59-63`; `src/domain/templates.js:38-43` |
| Protection | Directories `0700`, files written atomically with `0600`, Windows ACL checks | `src/services/siwc-session.mjs:77-115,137-150` |
| Memory only | Responses item cache, request counts awaiting their next write | Unchanged from the 2026-10-07 addenda |

The raw ID token is stored as returned, so any name or picture claims it holds are kept inside it, though Relmio does not extract them. This is unchanged.

[INFERENCE] A VPS sidecar update recreates the container. The bind-mounted tokens survive it, and the memory-only item cache is lost, as the 2026-10-07 record describes. A local replacement with a fresh account signs out first: Relmio attempts refresh-token revocation and clears local tokens (`src/services/siwc-session.mjs:864-900`), then a new sign-in stores a new record.

### Transmits

| Recipient | Data | Code |
| --- | --- | --- |
| OpenAI authentication, `auth.openai.com` | Authorization request with client ID (`dynamic_agent_client` on first registration), `agent_name_hint=Relmio` on first registration only, host ID, six scopes, resource, loopback `redirect_uri`, state, nonce, S256 challenge, and `prompt=consent` for **Allow ChatGPT plan use**. Code exchange, refresh and revocation forms. Discovery and JWKS requests | `src/services/oauth.js:10-11,203-213,155-160`; `src/services/siwc-session.mjs:625,644,670,771-772,880-883` |
| OpenAI API, `api.openai.com/v1` | `POST /responses` with the SIWC bearer, `store:false`, `stream:true`, and `reasoning.encrypted_content` in `include` only when the request sets `reasoning`. `GET /models` for discovery | `src/gateway/openai-oauth-sidecar.mjs:12,1032-1034,1056-1058`; `src/services/model-discovery.mjs:27-28` |
| ChatGPT `backend-api/codex` | Only the separate Codex image add-on, never SIWC tokens | `src/gateway/openai-oauth-sidecar.mjs:26,1005` |
| n8n and any holder of the Relmio bearer | Sidecar responses, with tokens redacted from errors | `src/gateway/openai-oauth-sidecar.mjs:101-103,1068` |
| `registry.npmjs.org` | Codex version lookup for model discovery; `npm ci` during image builds | `src/services/model-discovery.mjs:26`; `src/domain/templates.js:14` |
| Docker Hub | Base-image pull by tag and digest during a build. It receives no SIWC data. [INFERENCE] It sees the building host's address and pull metadata, as it did with the floating tag | `src/domain/local-endpoints.js:7-8` |

No Relmio-operated service receives any of this. Docker Hub was already contacted with the floating tag; earlier recipient lists did not name it.

### Logs

The sidecar still writes to stderr only when it cannot start (`src/gateway/openai-oauth-sidecar.mjs:1155`). The new CLI warning contains the Node.js version and nothing else (`src/cli.js:377-381`). OpenAI's article and privacy policy describe what OpenAI collects on its side: account identifiers, application and authorization details, request and session IDs, IP address and inferred location, browser or app version, user agent and device identifiers.

### Scopes and recipients

OAuth scopes are unchanged: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, with resource `https://api.openai.com/v1` (`src/services/oauth.js:10-11`). The URL validator accepts only that scope string and that resource (`src/browser.js:94-95`). The release adds no grant, consent step or token handling.

Recipients are the same as in the 2026-10-07 record:

- OpenAI's authentication and API services, and the vendors its privacy policy names
- the VPS and its root or Docker administrators
- n8n and anyone with the Relmio bearer
- the local Relmio process and browser
- `registry.npmjs.org` and, during image builds, Docker Hub

## Three separate checks

### 1. Identity sign-in

**Confirmed:** The article describes identity sign-in at participating partners, releasing name, email address and profile picture, and nothing from conversations, memory, files, tokens or billing. Organization members' availability "also depends on the organization's admin settings." The registration guide asks for the system browser, a `127.0.0.1` loopback callback, fresh state, nonce and PKCE with S256, and the issued client ID on later sign-ins.

**Observed:** This release does not touch sign-in, registration, refresh, ID-token checks or identity storage. The authorization parameters match the guide (`src/services/oauth.js:203-213`). Relmio sends neither `id_token_hint` nor `login_hint` on reauthorization, although it keeps the ID token. That predates this release.

**Observed, unchanged:** Relmio's flow is not the identity-only flow the article describes. The first authorization already asks for the plan scopes, and Relmio stores renewable tokens. The developer overview describes exactly this combined first sign-in for open-source tools.

**Open:** For a member of an organization, a global admin's External access settings can block Relmio's identity sign-in. Relmio has no code path that detects this, and the fetched pages do not say which error the authorize endpoint returns.

### 2. Separately approved permissions

**Confirmed:** Plan use is a separate approval. The plan article sets per-app weekly limits, opt-in credit use and disconnection in ChatGPT settings. SIWC Terms §1 to §4 are unchanged: local, user-controlled token storage; requests only for the authenticated user and the connected application; express consent before background use; no pooling or one user's plan serving another. Service Terms §15 still incorporates the SIWC Terms. The new delegated-access text covers connected apps and Ads data. Organization approval "does not replace the member's authorization."

**Observed:** Relmio requests no delegated access to connected apps, Sites or Ads. Its six scopes contain no such permission. The plan grant, **Allow ChatGPT plan use** with `prompt=consent`, the first-use plan default, background consent and model-check consent are unchanged (`src/services/oauth.js:212`; `src/services/siwc-session.mjs:591-593`). `prompt=consent` matches errors and recovery, which keeps it supported until OpenAI confirms `force_reconsent=true` for an integration.

**Observed:** The release changes how patched runtimes reach existing users. Following the CHANGELOG, a local user signs out, which attempts revocation, and signs in again with a fresh account replacement. That creates a new sign-in and a new Relmio key for n8n. **Open:** Whether that replacement registers a new client or reuses the issued client ID was not re-read for this check. The accounts page says signing in again "does not create a new client", and the 0.19.1 addendum found that the VPS refresh does create one. A new client would appear as a separate entry under Login connections and App limits. [INFERENCE] Its usage settings would then start from the defaults.

**Open, unchanged:** The connected-application question for n8n and the n8n Assistant under §2. The §1 question of persistent token storage on a VPS. Accounts and sessions now says "protected local or self-hosted runtime storage", and the self-hosted VM guide describes transferring credentials, but SIWC Terms §1 still says storage must not be "in a remote or managed environment." The Provisional audit item about the VPS store's parent directory and host UID 1000 bears on §1 and §3 security duties and is not resolved by this release.

**Open:** Whether Relmio is a "supported open-source tool" in the plan article's sense. That decides whether all ChatGPT users or only Go, Plus and Pro users can grant plan use. Relmio is not in OpenAI's partner directory (`docs/security.md:726`).

### 3. Model and TTS capability

**Confirmed:** Inference goes to `POST https://api.openai.com/v1/responses` with `store:false` and `stream:true` and counts as successful only at `response.completed`. Preview limitations list image generation, audio and video input, the Files upload API and transcription as unsupported in this flow. The Codex app-server page says a completed turn verifies a model only "for that request."

**Observed:** The sidecar's routes, request rewriting and outcome handling are unchanged (`src/gateway/openai-oauth-sidecar.mjs:1004-1068`). It exposes only `/v1/models`, `/v1/responses`, `/v1/chat/completions` and the separate Codex image routes. It has no speech route.

**Open:** No sidecar built on `node:24.22.1-bookworm-slim` has sent a request to OpenAI in this review. [INFERENCE] The Node.js fixes tighten TLS hostname verification, so a correctly configured `api.openai.com` connection should be unaffected; this was not tested. This review establishes no model, account, image or TTS capability. Service Terms §1(b) Prompt-to-Voice applies to the API product and grants nothing through SIWC.

## Findings

1. **No change to sign-in, scopes, storage, recipients or data handling** (Observed). The SIWC-facing change is the generated `engines.node` value and the pinned base image. Neither affects what is sent to OpenAI or stored.
2. **Digest pin** (Observed). Builds now fetch an exact base image. The digest was checked by the author with `docker buildx imagetools inspect`, which this review did not repeat (Provisional). Existing VPS sidecars stay on the old base until the owner runs the sidecar update.
3. **Local patch path asks for a fresh sign-in** (Observed and Open). Patching a local sidecar requires sign-out, revocation and a new sign-in. That is an existing flow, but this release makes it the recommended route. See check 2 for the client-ID question.
4. **Article update on delegated access and External access** (Confirmed). It does not change what Relmio requests. It adds an organization-level reason why sign-in can fail for work accounts, which Relmio's disclosures describe only as "workspace policy" (mismatch 5).
5. **Codex images** (Observed). The Codex and Codex chat images take the same base pin. Their credential flow is unchanged, and the base-image change is not permission for a Codex credential bridge. The App Server page's statement on app-server authentication is unchanged.

## Mismatches

Read on 2026-10-22 in README.md, npm/README.md and docs/security.md on this branch, while another agent was editing other files.

1. `README.md:25-29` and `npm/README.md:32-36` say the "October 2026 Node.js pin" addendum in `docs/node24-luna-source-check-2026-09-14.md` "covers this release." That addendum records Node.js versions and digests; it is not an OpenAI source check, and its own header calls the OpenAI findings below it historical. Link this record as the OpenAI source check for 0.22.3.
2. The PR #125 description says the OpenAI source check record is "in `docs/security.md` on the working branch." `docs/security.md` changes only its Node.js requirement line (`:754`). Update the PR description to point to this file.
3. `README.md:31-34` says 0.22.3 "pins generated bridge images to those patched Node.js bases." It does not say that existing sidecars keep the old base until updated, or that the local path needs sign-out and a fresh ChatGPT sign-in plus a new Relmio key for n8n. The CHANGELOG says this; the README and npm README do not.
4. `docs/security.md:754` says the package "requires Node.js 24.22.1 or newer." `README.md:59-60` and `npm/README.md:60-61` say 24.22.1 or newer, or 26.12.1 or newer. `engines` (`>=24.22.1`) admits Node.js 25 and 26.0 to 26.12.0, which the CLI warns about and the installers do not reuse. `README.md:65-68` and `npm/README.md:66-69` name only "older than the patched 24.22.1" and Node.js 25, leaving out 26.x below 26.12.1. Not an OpenAI matter; listed for accuracy.
5. `docs/security.md:691` (and `docs/faq.md:49-50`) name "workspace policy" as a limit. The article and tenant article place Sign in with ChatGPT and delegated-access permissions at the organization level, set by global admins in External access, and say a workspace owner or admin does not automatically control them. Suggested wording: "organization or workspace policy". Suggested troubleshooting text: "On a work account, if ChatGPT sign-in is unavailable, ask your organization's global admin to check Relmio under External access." This is a clarity improvement; no fetched source requires it.
6. `docs/security.md:20` and `:717` still call the 2026-10-05 record the "current source check." It remains the base description of the flow. Consider adding a pointer to this record for the latest dated check.

No disclosure in the three files was found to misstate scopes, storage, recipients, delegated access or plan sharing. `README.md:393-395` ("Identity sign-in or an installer confirmation cannot grant plan permission") still matches the article.

## Unknowns

- Whether OpenAI treats Relmio as a "supported open-source tool", and so which ChatGPT plans can grant it plan use.
- What an organization's External access setting does to Relmio's combined first authorization, and whether it affects plan use as well as identity.
- Whether the local fresh-account replacement creates a new issued client, and how ChatGPT then lists and limits it.
- Whether a sidecar on the pinned base works end to end against OpenAI for any account or model. Not tested.
- What changed in Service Terms on October 16, 2026 and in the plan article today, beyond the text read here.
- The pre-existing questions in the 2026-10-07 record: connected application under §2, VPS token storage under §1, notice adequacy under §3, retention of SIWC requests, and the separate Codex image bridge.
- The Provisional audit item about the VPS store's parent directory and host UID 1000.

This record is not legal advice, OpenAI approval, a Terms compliance determination or permission to use a Codex credential bridge. A successful sign-in or this source comparison does not establish model, image or TTS capability. Identity sign-in, separately approved permissions and model or TTS capability remain separate checks.
