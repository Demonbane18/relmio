# Native Claude prompt adapter: official-source check

Checked 2026-11-03. Ported for the 0.23.0 draft on 2026-11-04 with private infrastructure details removed. This is the historical source review of the original experimental adapter, not an acceptance report for the packaged CLI. The OpenAI comparison below described the older 0.17.5 development checkout; it does not describe current Relmio SIWC behavior. See the [2026-11-04 source check](claude-native-prompt-source-check-2026-11-04.md) for the release candidate and the [operator guide](claude-native-prompt.md#verification-record) for dated runtime evidence.

Public-source reviews preceded implementation. Final read-only boundary review returned CLEAR; protocol review found no remaining actionable issues in its revised paths. These are source-review findings, not vendor approval, account entitlement, legal advice or live runtime qualification.

No native binary installation/start, login, credential read, authenticated provider request, model/quota probe, live n8n operation, Docker/SSH operation, deployment or publication occurred during these source checks. An earlier optional Eval check was denied before execution and was not retried.

## Anthropic sources

Unless shown below, fetched text did not establish a revision date. Links were checked on 2026-11-03.

| Official source | Recorded finding |
| --- | --- |
| [Claude Code v2.1.317](https://github.com/anthropics/claude-code/releases/tag/v2.1.317) | Release page showed 03 Nov 01:25; commit `964d69565952a176ac1975ed218362991db71433`. A candidate pin does not qualify an installed executable. |
| [CLI flags](https://code.claude.com/docs/en/cli-reference.md#cli-flags), [headless operation](https://code.claude.com/docs/en/headless.md), [SDK protocol](https://code.claude.com/docs/en/agent-sdk/typescript.md) | Document native print/stream operation, session controls and typed events. `client_composed` requires CLI 2.1.248 or later. Documentation alone does not prove combined controls in an installed candidate. |
| [Safe mode](https://code.claude.com/docs/en/cli-reference.md#cli-flags), [disableAllHooks](https://code.claude.com/docs/en/settings-reference.md#disableallhooks), [policyHelper](https://code.claude.com/docs/en/settings-reference.md#policyhelper), [managed policy locations](https://code.claude.com/docs/en/managed-settings.md#where-each-mechanism-stores-the-policy) | Safe mode retains native auth, but managed hooks, status-line/file-suggestion commands and built-in mods can still run. Caller settings cannot disable administrator hooks; effective managed `disableAllHooks: true` can. Policy, API-key and telemetry helpers are separate executable paths. Dedicated config does not remove system/MDM policy. |
| [Session metadata](https://code.claude.com/docs/en/headless.md#read-session-metadata), [resolveSettings](https://code.claude.com/docs/en/agent-sdk/typescript.md#resolvesettings) | Init/settings inspection can inform review, but init arrives after startup hooks. No atomic CLI-only guarantee against managed-command execution was established. |
| [Credential management](https://code.claude.com/docs/en/authentication.md#credential-management), [auth precedence](https://code.claude.com/docs/en/authentication.md#authentication-precedence), [application data](https://code.claude.com/docs/en/claude-directory.md#application-data) | Native owns authentication and state. `CLAUDE_CONFIG_DIR` changes credential-file location and macOS Keychain identity. Failed Keychain writes can fall back to a mode-0600 file. Profiles/workload identity can outrank saved login. |
| [Use the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | October 7, 2026 update says subscription-authenticated SDK and `claude -p` draw from plan limits; June 15 third-party-app billing wording remains. Billing behavior does not grant distributed-product permission. |
| [Fable and usage credits](https://code.claude.com/docs/en/model-config.md#fable-and-usage-credits), [plan limits](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan) | Fable in `-p` can consume usage credits without a consent prompt. Native subscription auth does not prove included-only billing. Exact model, account billing and extra usage need review before inference. |
| [Plan limits](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan), [usage reports](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkusagereport), [result usage](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkresultmessage) | Pro/Max have five-hour and weekly limits; verified Ultra has weekly limits without the ordinary five-hour ceiling. Model-specific limits can apply. Usage is shared across surfaces. Server meters differ from local token/USD estimates; `null` differs from an empty meter list. |
| [SDK usage-report eligibility](https://code.claude.com/docs/en/agent-sdk/typescript.md) | Docs name `user:profile` or a known plan type for usage reports and `user:inference` for inference-only setup tokens. These partial references do not establish a complete native-login grant. No token was inspected/generated. |
| [Data use](https://code.claude.com/docs/en/data-usage.md), [Privacy Policy](https://www.anthropic.com/legal/privacy) | Native telemetry may reach Anthropic and third-party metrics/error processors. Optional feedback may send transcripts to Anthropic/Google Cloud Storage and create a public GitHub issue. Consumer model-improvement settings affect training/retention: Code docs state five years when enabled and standard 30 days when disabled. Commercial defaults differ and have exceptions. Subscription use does not establish commercial privacy treatment. |
| [Legal/compliance](https://code.claude.com/docs/en/legal-and-compliance.md), [SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) | Unmodified hosting is contemplated under stated Commercial Terms conditions: native authentication intact, each user authenticating/billed directly, no usage resale/intermediation. Third-party Claude login/personal-plan routing remain restricted absent approval. Consumer automation requires API-key access or explicit permission. No exact ruling for a distributed Relmio n8n gateway was established. Terms effective-date headings were not established from fetched text. |

### Qualification boundary

The reviewed candidate was `2.1.317`. Before startup, the owner must qualify the exact official executable/digest, effective managed policy, dedicated native authentication, selected models and account billing. Assertions and an offline hash comparison do not prove provenance, entitlement or policy safety.

Review covers effective system settings/drop-ins, macOS MDM, cloud policy/caches, managed MCP, shadowed policy helpers, executable auth/telemetry helpers, managed hooks and model/paid-mode substitution. Safe mode and empty user configuration do not replace it. Source inspection is not execution approval.

The reviewed adapter had no upstream relay, authentication-header capture, credential export, identity override, account pooling, quota weighting or automatic paid fallback. That finding does not qualify managed policy.

## Data handling and recipients

Source inspection and vendor documentation, not a packet capture or installed-runtime audit:

| Boundary | Reads, stores, transmits and logs |
| --- | --- |
| Caller and adapter | Bounded prompt text, exact approved model and independent Relmio bearer enter memory. Prompt JSON goes through native stdin; native text/events return to the caller. No native credential file, upstream Authorization interception or raw native stderr enters the adapter's HTTP errors/logs. Model-generated text is caller data, not a universal secret-filtered channel. |
| Launcher | Reads local config, expected executable digest and owner assertions; uses a bearer verifier; writes a PID/start-time lock and creates private directories. Account-root locking does not coordinate unrelated native clients using the same provider account. |
| Official runtime | Native owns login, refresh, credentials and Anthropic authentication/inference traffic. `CLAUDE_CONFIG_DIR` separates state/Keychain identity, but native uses the real `HOME` for macOS Keychain support. HOME-resolved caches, logs, built-in-mod files, surviving managed commands and normal home backups remain in scope. `--no-session-persistence` does not guarantee no local files, crashes, backups or provider retention. |
| Provider/telemetry | Anthropic receives auth/inference. Documented metrics/error processors may receive native telemetry. Separately used feedback can add Anthropic/Google Cloud Storage/public GitHub recipients. Exact active endpoints/processors, privacy settings and retention were unobserved. Inference is not offline. |
| n8n | The proposed caller receives a separate Relmio bearer, never Claude login state. Runtime/admin access, credential database/backups and execution history can expose keys, prompts, outputs and errors. Optional tracing/memory and connected tools add recipients. Instance settings were unknown during this source check. See [credential encryption](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/set-a-custom-encryption-key.md) and [execution retention](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data.md). |

The original isolated local design had no task-data/credential recipient at OpenAI, Hermes, Docker or a VPS. That historical statement does not cover the later optional Docker companion: its host/container/volume are explicit custody boundaries in the [current guide](claude-native-prompt.md#docker-companion-vps-or-local-docker-n8n).

## Mandatory OpenAI check: historical unchanged flow

The required [Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) was fetched first on 2026-11-03. It showed “Updated: 12 days ago”; [plan sharing](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) showed “Updated: 6 days ago”.

| Official source | Displayed date |
| --- | --- |
| [Registration/scopes](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md), [models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md), [preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md) | Not shown |
| [Codex auth](https://developers.openai.com/codex/auth), [App Server](https://developers.openai.com/codex/app-server/) | Not shown; resolved to `learn.chatgpt.com/docs/auth` and `learn.chatgpt.com/docs/app-server` |
| [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech) | Page update not shown; included October 1, 2026 deprecation and January 6, 2027 shutdown references |
| [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms](https://openai.com/policies/service-terms/) | October 16, 2026 |
| [Terms of Use](https://openai.com/policies/terms-of-use/) | January 1, 2026 |
| [Services Agreement](https://openai.com/policies/services-agreement/) | Updated December 1, 2025; effective January 1, 2026 |
| [Privacy Policy](https://openai.com/policies/privacy-policy/) | July 30, 2026 |

Identity scopes `openid profile email`, separately granted plan permissions `offline_access resource.invoke chatgpt.tokens.use.direct`, and model/TTS capability were separate checks. The article described approved plan sharing; it did not validate a copied-Codex bridge.

Historical code observations in the 0.17.5 development checkout:

- `src/services/oauth.js` delegated Codex login, validated complete access/ID/refresh JSON and copied it into protected Relmio storage.
- `src/services/local-n8n-sidecar-installer.js` passed complete credential bytes through Docker stdin; `src/services/installer.js` could upload them to a VPS auth mount.
- `src/gateway/openai-oauth-sidecar.mjs` passed request data and a credential-file path to third-party `openai-oauth@2.0.0`. Dependency upstream/storage/telemetry/logging was not independently audited.

Recipients of that historical flow included official Codex/OpenAI auth, Relmio, selected Docker/remote hosts and the dependency. Credential copies, host volumes, prompts/tools, n8n history, logs and backups were separate risks. Generic wrapper errors did not prove dependencies/hosts/n8n omitted sensitive logs.

Actual scopes, bridge permission, dependency custody, n8n retention, account privacy and entitlement remained unresolved. Public SIWC Responses documentation did not validate the legacy bridge. Login/text success did not establish TTS. This check neither approved/upgraded that route nor granted Anthropic permission. Current Relmio uses a later SIWC implementation; consult the [release-candidate check](claude-native-prompt-source-check-2026-11-04.md), not these historical source anchors.

## Final read-only implementation review

Reviewed 2026-11-03. Boundary review returned CLEAR for original core, launcher, tests and docs, and refreshed CLI/SDK/settings/auth/legal/data-use sources plus the required OpenAI article. Protocol review confirmed corrections to bounded thinking-progress handling, startup-auth refusals and final-response flushing.

Original anchors were `scripts/claude-chat.js` (private config, expiring runtime-bound assertions, offline pin, exclusive claim, per-spawn identity checks) and `src/gateway/claude-chat.js` (bounded protocol, sanitized usage/errors, fixed argv/environment, stdin prompts, owned-group cleanup, bearer/Host/Origin admission). For 0.23.0, the launcher moves to `src/claude/launcher.js`; historical line numbers are not current-code references.

The pathname claim supplied exclusion; retaining a descriptor was not the lock. Reviews did not automatically attest managed policy/auth/billing. No provider HTTP client, native credential reader or deployment sink was found in the reviewed adapter/launcher. Reviewers ran no tests, services, binaries or authenticated provider calls.

## Outstanding evidence at the time

- The original full repository gate had three failures: a copied Node fixture's unresolved host dylib and two allowlist assertions for six research docs. Original totals and later live evidence appear in the [verification record](claude-native-prompt.md#verification-record). These are not current worktree test results.
- Synthetic protocol and standalone JSON/SSE smoke passes were parent-reported, not provider checks or reviewer executions.
- Installed binary/policy, account auth/scopes, entitlement, billing and native privacy were unqualified by the source review. Separately authorized 2026-11-04 checks are recorded in the guide.
- n8n Stop/disconnect, streaming through n8n and actual retention remained untested.
- Distributed-product permission and general deployment approval were not established.

See [feasibility research](claude-subscription-n8n-research-2026-11-03.md) for the rejected full Hermes relay and the API-key alternative for full n8n AI Agent workflows.
