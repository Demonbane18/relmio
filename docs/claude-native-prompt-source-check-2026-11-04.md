# Native Claude prompt adapter: official-source check

Checked 2026-11-04 for the Relmio 0.23.0 Claude adapter release. OpenAI behavior is unchanged by this release's stated scope. This record refreshes vendor sources and compares them with the release worktree's existing OpenAI implementation and disclosures, plus the original Claude feature source being ported.

The required [Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) was fetched first, before the other vendor pages. No files were edited. No native Claude or Codex executable was installed or started; no login, credential access, authenticated provider request, inference or quota probe, Docker/SSH operation, deployment or publication occurred. No tests or builds ran.

**Review boundary:** the packaged Claude implementation and final CLI contract were not yet available in the release worktree at this review's cutoff. Claude implementation references below explicitly identify the original feature source. They must not be represented as acceptance of a finished package. Current-worktree OpenAI references were inspected directly. Source review is not vendor approval, legal advice, account entitlement or live runtime qualification.

## Anthropic sources

Every URL below was fetched on 2026-11-04. Unless a date is shown, fetched content supplied no published/updated date.

| Source | Displayed date and current finding |
| --- | --- |
| [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | Explicit updates October 7, 2026 and June 15, 2026. Subscription-authenticated Agent SDK and `claude -p` still draw from subscription limits. The October update separately describes API-key usage funded by linked monthly API credits. |
| [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md) | No revision date shown. Hosting/preinstalling unmodified Claude Code is contemplated under Commercial Terms and stated conditions: authentication methods intact, each end user authenticating and billed directly, no resale or intermediation of usage. It separately restricts third-party Claude.ai login, collection/storage/intermediation of Claude credentials, and personal-plan routing on users' behalf. |
| [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md) | No revision date shown. Recommends API-key/cloud-provider authentication and retains the warning that, unless approved, third-party developers may not offer Claude.ai login or rate limits for their products. |
| [Model configuration](https://code.claude.com/docs/en/model-config.md#fable-and-usage-credits) | No revision date shown. Fable requests in `-p`, or SDK applications that do not show a consent prompt, can bill usage credits without asking. Model aliases, availability and policy-driven substitutions remain account/runtime dependent. |
| [Headless operation](https://code.claude.com/docs/en/headless.md) | No revision date shown. Documents `-p`, JSON/stream-json, stdin, completion/failure behavior and startup metadata. `--bare` does not read subscription OAuth credentials or the system Keychain; it is not a drop-in isolation flag for this subscription design. Startup hooks can precede `system/init`. |
| [CLI reference](https://code.claude.com/docs/en/cli-reference.md) | No revision date shown. Documents safe mode, disabled tools, strict MCP configuration, print-mode permission denial and disabled session persistence. Safe mode retains authentication but does not remove managed policy or its configured commands. |
| [Settings reference](https://code.claude.com/docs/en/settings-reference.md#disableallhooks), including [policyHelper](https://code.claude.com/docs/en/settings-reference.md#policyhelper) | No revision date shown. Only managed settings can disable administrator-managed hooks. Built-in mods keep running even with `disableAllHooks`. A policy helper executes before the first prompt and can run later when previously shadowing server policy disappears. |
| [Managed settings](https://code.claude.com/docs/en/managed-settings.md) | No revision date shown. System files/drop-ins, MDM, cached/cloud policy and managed helpers remain relevant even when user/project settings are excluded. |
| [Authentication](https://code.claude.com/docs/en/authentication.md), [application data](https://code.claude.com/docs/en/claude-directory.md#application-data) | No revision dates shown. Native owns login/refresh/storage. `CLAUDE_CONFIG_DIR` changes credential-file location and macOS Keychain entry identity. Linux uses `.credentials.json`; failed macOS Keychain writes can fall back to a mode-0600 file. Other credential sources can outrank subscription login. Native also maintains application state, caches and other files. |
| [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript.md) | No revision date shown. `client_composed` requires Claude Code 2.1.248 or later. `resolveSettings()` does not execute policy helpers or fetch server-managed policy. Usage-report eligibility mentions a known plan type or `user:profile`; default setup tokens carry `user:inference`. Those references do not enumerate a complete native-login grant. Local cost estimates differ from server-reported allowance and extra-usage spend. |
| [Pro, Max and Ultra plan limits](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan) | No revision date shown. Pro/Max have five-hour and weekly limits; verified Ultra has no ordinary five-hour ceiling. Usage is shared across Claude surfaces. Usage credits and API billing are separate account settings. |
| [Data usage](https://code.claude.com/docs/en/data-usage.md), [Privacy Policy](https://www.anthropic.com/legal/privacy) | No revision dates established. Consumer training/retention depends on settings and policy exceptions. Code documentation states five-year retention with model improvement enabled and 30 days when disabled. Commercial treatment differs. Native telemetry and optional feedback have additional recipients. |
| [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) | Effective-date headings were not established from fetched text. Consumer Terms retain the restriction on automated/non-human access except through an API key or explicit permission. Commercial Terms govern applicable business offerings, not every subscription merely because a wrapper exists. |
| [Claude Code v2.1.317 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.317) | Anthropic-controlled GitHub release; page shows 03 Nov 01:25 and repository commit `964d69565952a176ac1975ed218362991db71433`. |
| [Official 2.1.317 manifest](https://downloads.claude.ai/claude-code-releases/2.1.317/manifest.json) | `buildDate: 2026-11-02T22:39:48Z`; build commit `3d3e7cb16b5577dccaee9520c8dc1189d02d61b7`. Linux x64/arm64 checksums match the literal pins inspected in the original companion Dockerfile. A manifest comparison does not qualify an installed executable. The build commit and GitHub repository release commit are distinct fields. |

### Comparison with November 3

**Confirmed:** all five specifically requested sources were re-fetched: plan SDK article, legal/compliance, quickstart, model configuration/Fable billing and headless operation. Their material statements recorded on November 3 remain present. In particular, subscription billing support has not displaced the separate product/authentication restrictions, and the non-interactive Fable billing warning remains.

**Open:** the November 3 record contains summaries, not archived full response bodies or hashes. This check establishes consistency of the reviewed statements, not that every byte of every page stayed unchanged. Most pages expose no revision date.

### Anthropic findings

- **Identity/authentication — Confirmed:** official Claude Code supports native subscription login. **Observed, original feature source:** Relmio invokes the official executable and does not implement an Anthropic OAuth client or read native credential files. **Open:** actual login grant, account, native-selected auth mode and managed-policy behavior require target-specific qualification. `apiKeySource: "none"` alone does not prove subscription authentication.
- **Permissions — Confirmed:** native login, SDK plan billing and permission to distribute a product are separate questions. **Open:** no fetched source expressly approves the distributed Relmio n8n gateway. The unmodified-hosting conditions and third-party-login restrictions must be considered together. Owner-only use and disclosures reduce ambiguity but do not supply Anthropic approval.
- **Capability/billing — Confirmed:** `claude -p` is documented; Fable can incur usage-credit charges without a prompt. **Observed, original feature source:** Fable IDs are rejected, models are exact approved IDs, output is text only, and native model/terminal checks constrain accepted results. **Open:** model entitlement and included-only billing cannot be established from a model list, health response, pin or successful login. Disabling Fable does not disable account-level extra usage.

### Secondary measurements

**Provisional:** the [Hermes Claude Subscription DirectSDK page](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk), fetched November 4, shows catalog update November 3, 2026. It reports measurements suggesting `claude -p` can consume the five-hour window faster than interactive Claude Code. These are third-party observations, not an Anthropic guarantee or a stable multiplier. Hermes describes its own caller-name override; the reviewed Relmio child environment does not set one.

**Observed in prior owner-run records, not reproduced here:** the original operator guide records small native/n8n prompts with approximately 1.7–2.5K prompt tokens, including Claude Code's own system prompt and other context (`docs/claude-native-prompt.md:197-218,426-430`, original feature source). Preserve the approximate overhead warning. Do not describe that range as a fixed or independently measured system-prompt size for every call.

## Mandatory OpenAI sources

Every URL below was fetched on 2026-11-04. These are official OpenAI domains; Anthropic and Hermes sources above are not evidence of OpenAI permission.

| Source | Displayed date |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 13 days ago |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: 7 days ago |
| [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) | Not shown |
| [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md) | Not shown |
| [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md) | Not shown |
| [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md) | Not shown |
| [SIWC Codex app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md) | Not shown |
| [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms.md) | Not shown |
| [Codex authentication](https://developers.openai.com/codex/auth), resolved to [current authentication documentation](https://learn.chatgpt.com/docs/auth) | Not shown |
| [Codex image generation](https://learn.chatgpt.com/docs/image-generation), [pricing and image limits](https://learn.chatgpt.com/docs/pricing) | Not shown |
| [Image generation API](https://developers.openai.com/api/docs/guides/image-generation) | Not shown |
| [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech) | Page revision not shown; October 1, 2026 deprecation reference and January 6, 2027 shutdown date |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms](https://openai.com/policies/service-terms/) | Updated October 16, 2026 |
| [Terms of Use](https://openai.com/policies/terms-of-use/), canonical [rest-of-world Terms](https://openai.com/policies/row-terms-of-use/) | Published/effective January 1, 2026 |
| [Services Agreement](https://openai.com/policies/services-agreement/) | Updated December 1, 2025; effective January 1, 2026. Initial fetch returned 403; the slashless URL subsequently returned the document. |
| [Privacy Policy](https://openai.com/policies/privacy-policy/), canonical [services/communications privacy policy](https://openai.com/policies/services-communications-privacy-policy/) | Updated July 30, 2026 |

### Identity sign-in

**Confirmed:** the current identity article describes identity information and separately approved additional permissions, including eligible plan sharing. Identity-only sign-in does not independently share conversations, memories, files, tokens or billing information. The article's identity-only sharing description cannot describe Relmio's complete plan-use session.

**Observed:** current `src/services/oauth.js:11-12,70-75,147-178,202-213` implements Relmio's SIWC flow with `dynamic_agent_client` for initial registration, `agent_name_hint: Relmio`, a stable host ID, random state/nonce, S256 PKCE, loopback callback and the issued client ID for exchange. `src/services/siwc-session.mjs:624-658` checks discovery and verifies ID-token signature, issuer, audience, expiry, nonce and returning subject. It is not the historical copied-Codex text login.

**Observed disclosure match:** `README.md:20-28,228-241`, `docs/faq.md:26-57` and `docs/security.md:1-18,37-52,147-151` distinguish identity, plan permission, account selection and provider tokens. The UI has separate Continue with ChatGPT, Allow ChatGPT plan use and first-use notice controls (`src/ui/index.html:232-255`; `src/ui/local.html:471-496`).

**Open:** successful source inspection does not establish that a particular account or workspace can authorize the flow.

### Separately approved permissions

**Confirmed:** documented identity scopes are `openid profile email`. Documented plan-use scopes are `offline_access resource.invoke chatgpt.tokens.use.direct`. The returned grant, not requested scopes or a verified ID token, determines plan permission.

**Observed:** Relmio requests all six scopes (`src/services/oauth.js:12,205-213`), stores the returned scope set and token expiry, and derives plan state from returned `chatgpt.tokens.use.direct` (`src/services/siwc-session.mjs:546-595`). Identity-only accounts remain connected without model access. Refresh and inference token release check ownership and plan permission (`src/services/siwc-session.mjs:733-795`). n8n background consent is separately validated by both installers (`src/services/installer.js:460-472`; `src/services/local-n8n-sidecar-installer.js:2000-2027`) and disclosed in UI (`src/ui/local.html:1007-1010`; `src/ui/index.html:869-872`).

**Open, unchanged:** SIWC Terms require persistent authentication tokens to be local and user-controlled, not in a remote or managed environment. The self-hosted VM guide nevertheless documents protected transfer over SSH, destination host identity and destination-owned refresh. Relmio implements protected destination transfer; this review does not resolve the apparent tension in the published wording.

**Open, unchanged:** SIWC Terms limit use to the connected application and prohibit general-purpose API access for other tools or unrelated requests. An OpenAI-compatible n8n endpoint needs its own assessment against that restriction. Local authentication, single-owner operation and explicit background consent do not settle it. `README.md:158-164` and `docs/faq.md:153-165` already disclose these questions.

### Model, image and TTS capability

**Confirmed:** documented SIWC inference uses `https://api.openai.com/v1/responses` with `store:false` and `stream:true`; the guide explicitly excludes ChatGPT backend-api endpoints for this flow. Model listings do not establish completed inference. The preview excludes audio/video input, transcription, Files uploads and several hosted tools, including image generation.

**Observed:** the text sidecar obtains the selected registration's token, calls the public Responses endpoint and forces those storage/stream settings. Its Chat Completions interface translates to Responses rather than using a separate ChatGPT backend (`src/gateway/openai-oauth-sidecar.mjs:822-826,991-1080`). Unsupported routes, including speech, are rejected (`src/gateway/openai-oauth-sidecar.mjs:1000-1008`). This agrees with `docs/faq.md:60-94`.

**Observed, separate route:** optional images use a separate Codex device-code session and `chatgpt.com/backend-api/codex/images/...`, not the SIWC text token (`src/services/codex-images.mjs:12-24,299-332,385-447`; `src/gateway/openai-oauth-sidecar.mjs:940-953`). Official Codex documentation describes built-in `gpt-image-2` and its usage limits; the general Image API guide describes separate Platform API capabilities. Neither supplies permission for Relmio's third-party backend image route. Its approval, actual granted scopes and account entitlement remain **Open**. Existing disclosures identify this distinction (`docs/security.md:500-559`; `src/ui/local.html:883-896`).

**Confirmed:** the TTS guide describes the separate Speech API and migration to Realtime. `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` are deprecated, with shutdown January 6, 2027; `gpt-realtime-2.1-mini` is not a drop-in `/v1/audio/speech` model. Successful SIWC identity, plan authorization, text inference or Codex login establishes no TTS access. The Claude text facade adds none.

## Data handling and recipients

These are inspected code paths and documented provider behavior, not packet-capture findings. Account-specific privacy settings, host logging and installed n8n retention were not inspected.

### Current release-worktree OpenAI paths

| Boundary | Reads, stores, transmits and logs | Recipients and evidence |
| --- | --- | --- |
| SIWC authorization | Reads callback code/state/client ID and token response; validates identity; retains identity issuer/subject/email, issued client, host/runtime identity, granted scopes, access/refresh/ID tokens and expiry. State, nonce and PKCE verifier are held for the attempt. Sends authorization parameters to OpenAI in the browser and code/verifier/resource to the token endpoint. | Browser/OS launch surface, Relmio process and OpenAI auth/discovery/JWKS/token endpoints. `src/services/oauth.js:70-178,202-227`; `src/services/siwc-session.mjs:567-595,624-658`. |
| Local registration storage and refresh | Protected JSON under `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth`, with `registrations/<id>.json`, stable host state and selected-registration state. Unix directories are 0700 and atomic token files 0600; Windows uses ACL lockdown. Serializes rotating refreshes and freezes uncertain results. | Owning OS account, privileged host users and backups; OpenAI receives refresh/revocation requests. `src/services/siwc-session.mjs:59-69,90-166,410-491,546-595,733-795,863-899`. |
| Transfer to installed sidecar | Reads the selected protected registration, serializes its token set/metadata into a handoff, freezes source ownership, and clears source tokens only after destination receipt. Transmits over Docker stdin or the verified SSH channel. Destination stores the registration. | Local Docker daemon/container/volume or selected remote host/container/storage; root/Docker administrators and backups. n8n receives a distinct Relmio bearer, not these provider tokens. `src/services/siwc-session.mjs:905-938,995-1056`; `src/services/local-n8n-sidecar-installer.js:1407-1433,2372-2400`; `src/services/installer.js:735-782`. |
| Text inference and response memory | Reads local bearer, model, prompt/history, supported tool definitions/results and eligible input content; sends normalized request plus access bearer to OpenAI; returns text/events to caller. Caches selected assistant text and encrypted reasoning items in process memory, bounded to 4096 items/32 MiB with six-hour expiry checked on use. | Relmio sidecar, OpenAI, n8n/calling app, and any workflow recipients chosen by the owner. `src/gateway/openai-oauth-sidecar.mjs:12-23,348-388,991-1080`. n8n execution history, tracing, memory integrations and host backups can retain caller data independently; actual deployment configuration is unknown. |
| Model discovery and request accounting | Fetches Codex version metadata from npm without a provider token, obtains account catalog from OpenAI with the selected token, and makes small plan-funded probes only under model-check consent. Stores consent, model results/version/time and bounded per-day request/token counters under `model-checks` and `activity`; these records are not plan allowance meters. | npm receives request/IP metadata; OpenAI receives catalog/probe traffic; owning runtime stores records. `src/services/model-discovery.mjs:17-28,186-265,555-558,620-665,691-701,837-897`. |
| Official Codex App Server | Reads selected SIWC access token and identity-bound thread mapping; passes only short-lived access token in `ACCESS_TOKEN` to official child over its process environment; forwards accepted RPC data through stdin/stdout and saves thread bindings. Child stderr is drained, not exposed. | Official Codex child, its local workspace/state and tools, OpenAI Responses, trusted local client and host administrators. `src/gateway/codex-app-server.mjs:10-24,87-126,159-168,196-208,226-266`; `src/services/siwc-session.mjs:798-857`. Same-user tools/processes are not an OS security boundary. |
| Optional Codex images | Uses device-code endpoints without an explicit scope parameter. Temporarily stores device authorization ID/user code; stores access/refresh tokens, account ID, email/plan labels and expiry under `<storageRoot>/codex-images`. Reads ID-token claims during exchange but does not persist the ID token. Sends prompt/reference images, Codex access bearer and account ID to the separate image backend. | OpenAI auth/image services, sidecar process/storage, n8n, host administrators and backups. `src/services/codex-images.mjs:12-24,89-104,299-332,385-447`; `src/gateway/openai-oauth-sidecar.mjs:932-970`. Actual granted scopes remain unknown. |
| Browser views and diagnostics | Returns sanitized account/status and fixed or filtered failures rather than stored token JSON. Same-browser launch hands the authorization URL to a one-use redirect, not a status JSON field. This does not control browser history/extensions or OS logging. Sidecar startup failure is fixed text; inference errors are filtered. | Browser and local UI user; caller/runtime logs can still capture returned data. `src/services/siwc-session.mjs:393-408`; `src/services/oauth.js:17-34`; `src/web/server.js:3895-3943,6440-6480`; `src/gateway/openai-oauth-sidecar.mjs:1055-1068,1149-1156`. |
| Dashboard project metadata | Separately requests public GitHub stars, with Relmio website fallback. Sends version User-Agent and ordinary request metadata, not tokens or prompts. | GitHub, website host and local cache. `src/services/project-meta.js:7-35`. These third-party recipients are not OpenAI policy authorities. |

OpenAI's privacy policy also describes provider-side processing, service providers, applicable organization administrators, legal disclosures and retention exceptions. `store:false` controls Responses state storage; it does not establish zero provider retention, no safety logging, or commercial no-training treatment for every account.

### Original Claude feature source inspected before packaging

The following anchors refer to the original feature source, not an assertion that its package relocation has already been reviewed.

| Boundary | Reads, stores, transmits and logs | Recipients and evidence |
| --- | --- | --- |
| HTTP adapter and native child | Reads bounded prompt/messages, exact model and independent local bearer. Hashes bearer for admission and does not forward it to native. Sends flattened text as one `client_composed` stdin message, receives bounded native events and returns validated text/usage. Raw stderr is counted/drained rather than logged or returned. | Caller/n8n, Relmio adapter memory and official Claude child. Original `src/gateway/claude-chat.js:94-128,264-270,564-654,681-710,738-800,833-932`. |
| Native authentication and storage | Adapter passes real HOME/USER/LOGNAME and dedicated `CLAUDE_CONFIG_DIR`, with explicit environment rather than inherited provider credentials. Native owns credential reads, login/refresh and network authentication. Relmio defines no Anthropic OAuth scopes. | Official Claude runtime, its dedicated native state/Keychain or Linux credential file, Anthropic auth/inference, host administrators and backups. Original `src/gateway/claude-chat.js:691-710,738-800`; original `scripts/claude-chat.js:260-272`; official authentication/data-use pages above. |
| Launcher qualification | Reads private launch configuration, executable bytes/digest, filesystem identity and expiring owner assertions. Creates private account/config/empty-cwd directories and PID/start-time lock. Logs local listener origin or fixed refusal codes, not prompt, bearer or raw native diagnostics. Assertions do not perform the policy/account/billing review. | Local filesystem/process and owner terminal/log collector. Original `scripts/claude-chat.js:83-151,156-187,239-320,329-338`. |
| Companion preparation and runtime | Original helper copies build inputs and writes launch JSON, bearer hash `.env` and plaintext local bearer file. Compose mounts dedicated `claude-account` volume and read-only launch file, joins named external n8n network, publishes no host port and mounts no Docker socket. Login script invokes official native login; renewal reads native status and writes qualification timestamps. | Owner, Docker daemon/container/volume, trusted network peers, host/backup administrators, n8n credential store. Original `dev/claude-companion/prepare.mjs:19-53`, `compose.yml:1-33`, `login.sh:5-13`, `renew.sh:5-35`. Private-network HTTP is not encrypted. Native Linux credentials live in the volume even though adapter code does not read them. |
| Build/download traffic | Container build obtains Node base image, Debian packages and pinned official Claude executable. The inspected Linux checksum literals match the fetched official manifest. | Container registry, Debian mirrors and Anthropic download service receive ordinary build request metadata. Original `dev/claude-companion/Dockerfile:3-24`. No installed binary was fetched or executed by this reviewer. |
| Native telemetry and provider retention | Child requests `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and disables official marketplace auto-install. This is a requested native setting, not a measured egress guarantee. Managed policy and native behavior require qualification. | Anthropic receives inference/authentication. Documented optional metrics/error processors, configured organizational collectors, and separately enabled feedback destinations can add recipients. Feedback can reach Anthropic/Google Cloud Storage and public GitHub. Original `src/gateway/claude-chat.js:691-710`; official data-use/privacy pages above. |

No OpenAI or Hermes inference recipient appears in the inspected original Claude adapter's child/stdin path. The companion adds a Docker/host custody boundary, so the November 3 isolated-design statement that Claude task data does not reach Docker or a VPS must not be reused for the companion.

`--no-session-persistence` is not a promise of no native files, crash artifacts, backups or provider retention. Real HOME remains significant for native-resolved files and OS state. Generated text is caller data, not a universal secret-filtered channel.

## Mismatches and remaining unknowns

1. **Historical checkout mismatch — Observed.** The original November 3 OpenAI section describes copying Codex credentials and using `openai-oauth@2.0.0`. Current release-worktree `oauth.js` and sidecar implement SIWC/public Responses for text. Keep the old report historical; use this record for current behavior. The newly ported November 3 report already labels that distinction.
2. **Returning sign-in hint — Observed.** Current registration/session docs instruct clients to send retained `id_token_hint` during reauthorization. Relmio retains the ID token but `src/services/oauth.js:202-213` does not send it. The docs also describe the no-hint account-selector flow, and Relmio validates returning identity. This is a documented UX/protocol difference, not evidence of account substitution or blanket noncompliance.
3. **Retention wording — Observed.** The comment at `src/gateway/openai-oauth-sidecar.mjs:349` says `store:false` means nothing is kept upstream. That wording exceeds the evidence. Public prose must distinguish unavailable persisted Responses state from provider safety/security retention and local caller history.
4. **Remote storage and connected-application permission — Open.** SIWC VM guidance and Terms remain unresolved for Relmio's remote persistent tokens and n8n-compatible endpoint. Existing warnings must remain.
5. **Separate image route — Open.** Native Codex image capability and a successful device login do not establish permission for Relmio's backend image endpoint. Actual granted scopes, cross-account matching, entitlement and provider retention were not inspected. UI expressly says account matching is not verified.
6. **Claude distributed-product permission — Open.** No vendor statement expressly approves this Relmio gateway. Preserve Experimental, owner-only and non-endorsement notices. Do not offer a shared/hosted subscription service.
7. **Claude package integration — Open at review cutoff.** Packaged CLI/setup/preparation code was not yet available. The original preparation helper writes positive qualification assertions without an interactive review, whereas the release contract requires guided setup to ask the owner and refuse without a TTY. Do not infer that the new contract is satisfied from the original helper. Final integration review must inspect the landed helper and its exact CLI contract.
8. **Native target qualification — Open for each installation.** Exact official binary/digest, managed policy and helper paths, native auth/scopes, approved model/account, billing, extra usage and control of policy changes must be reviewed before inference. An init check occurs too late to prevent startup hooks. Prior owner-run successes do not qualify another account or machine.
9. **Operational privacy — Open.** Installed n8n history, tracing, memory integrations, host logging/backups, active native telemetry endpoints, account training/retention settings and packet-level recipients were not observed. Provider-side processor lists describe possibilities, not a measured destination inventory.

## Required disclosure and limitation set

Preserve this set in the release README, npm README, operator documentation and website page. No source refresh removed these limitations:

- Experimental; not affiliated with or endorsed by Anthropic. Uses unmodified official Claude Code, installed and logged into by the owner through Anthropic's flow. Relmio adapter code does not open, copy, refresh or transmit Claude credentials; official native Claude performs authentication and credential handling itself.
- Owner-only personal use. Do not offer it to others as a shared or hosted service. Anthropic's terms and usage policies apply; Anthropic may change or block access.
- Plan limits are shared with other Claude surfaces. `claude -p` may draw the five-hour window faster than interactive Claude Code, based on Provisional Hermes measurements. Relmio does not override native caller identity.
- Turn extra usage off if overage billing is unwanted. Fable is refused, but account-level usage-credit settings remain the owner's responsibility. No zero-charge guarantee follows from subscription login.
- Claude Code adds native prompt/context overhead, approximately 1.7–2.5K tokens in the recorded small-call observations. This is not a fixed per-call guarantee.
- Text only: no tools/AI Agent tool loop, n8n AI Assistant, Responses API or images. Accepted sampling controls are ignored; output-token caps and stop settings do not become native generation controls.
- One request at a time, no queue. Reconfirm qualification: one-hour default for the planned local helper, maximum seven days. Pin Claude Code 2.1.317; other versions need requalification.
- Unused undocumented native stream records are ignored; detected tool/command signals fail closed. That tolerance is version sensitive.
- No remaining-quota/allowance display. Native token or list-price counts are not invoice evidence or remaining plan usage.
- Native resolves some files through HOME. Dedicated configuration and disabled session persistence do not eliminate native files, administrator access, backups or provider retention.
- Keep tested surfaces separate from experimental ones. Prior owner-run Mac/native n8n and named-host companion results are limited evidence; other VPS providers remain untested. Local container qualification in progress must not be reported as passed by this source check.
- n8n settings: Use Responses API off; Max Retries 0; Timeout at least 135000 ms; Basic LLM Chain Batch Size 1. Disable workflow automatic retries and leave tools/fallback routes disconnected.
- Recommend Anthropic API-key access, including eligible linked monthly API credits where applicable, for full AI Agent tool workflows. Subscription allowance and API credits are separate billing routes.

## Review conclusion

The refreshed sources preserve the material November 3 Anthropic findings. Current OpenAI text code follows the documented SIWC/public Responses architecture rather than the historical copied-Codex bridge, while its existing permission and privacy questions remain open. Neither vendor's successful login, native capability documentation nor subscription billing statement supplies blanket approval for Relmio.

This record completes the public-source refresh and read-only observations described above. Final package integration, synthetic verification, live runtime acceptance and release approval are separate evidence; none is claimed here.
