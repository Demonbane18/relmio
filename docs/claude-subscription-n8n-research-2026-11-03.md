# Claude subscription access from n8n: feasibility review

Reviewed 2026-11-03. Historical evaluation of the original 0.17.5 development checkout, ported on 2026-11-04 with private machine/deployment details removed. Recommendations and acceptance criteria below are not passing tests or authorization. The subsequent prompt-only implementation is documented in the [operator guide](claude-native-prompt.md); the [2026-11-04 source check](claude-native-prompt-source-check-2026-11-04.md) covers the release candidate.

## Recommendation

Use n8n's existing Anthropic Chat Model with a Console API key for ordinary inference and full AI Agent tool loops. Eligible monthly API credits are a separate funding route. No Relmio inference bridge is needed for that integration.

For owner-initiated use of included subscription allowance, the smallest candidate was an owner-only wrapper around unmodified official `claude -p`. Native Claude keeps login, refresh and upstream traffic. This is not permission to offer a shared subscription service, customer/lead-event inference or Claude login on users' behalf.

Reject the full Hermes admission relay for this scope. Request rewriting, upstream bearer custody, replay behavior and caller-identity overrides add policy and maintenance risks. Do not add quota-weighting tricks, credential redistribution, account pooling or automatic paid fallback.

## Scope and evidence

The inspected checkout was on a development branch at `46b1889a587ef6558d64b743c5e0a257ea361977`, manifest `0.17.5`, with pre-existing uncommitted changes and an older recorded upstream. No fetch or unrelated edit occurred. Those observations are historical, not descriptions of the 0.23.0 worktree.

Only the research note was written during the evaluation. No plugin import/execution, credential access, login, authenticated provider request, implementation, live n8n, Docker/SSH, deployment, publication or private-vault ingestion occurred. An optional credential-free protocol check was denied before execution with `uninspectable protected eval: exact target unavailable.` It was not retried. `node --version` returned `v26.12.1`; that proves runtime availability only.

Independent read-only boundary review returned CLEAR for the recommendation. Public sources and source review did not establish account entitlement, a live protocol pass or runtime/deployment approval.

## Hermes mechanism and license

### Reviewed revision

Reviewed `claude-subscription-directsdk` version `0.3.3` at [`01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731`](https://github.com/NousResearch/hermes-official-plugins/tree/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk). Main resolved to `a50b0fea59d10f9a51b488206f587d9cb6ca6163`; both held plugin subtree `e64685dff9ed1d637798e2af857246caad61349b`. These pins describe the 2026-11-03 review, not the latest plugin.

[pyproject.toml](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/pyproject.toml) requires Python >=3.10 and declares no package dependencies. It drives the official executable directly, without the Python Agent SDK, but still uses Hermes core helpers. The [manifest](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/plugin.yaml) requires Hermes >=0.21.4.

The [plugin license](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/LICENSE) is MIT, copyright 2026 Nous Research and contributors. Reused substantial portions require its notices. Source licensing does not grant Anthropic service access. [Claude Code licensing](https://github.com/anthropics/claude-code/blob/main/LICENSE.md), service terms and binary/dependency distribution are separate checks; no complete redistribution audit occurred.

### Request flow

1. Hermes calls a Python OpenAI-shaped `chat.completions.create`; this plugin is not an HTTP Base URL for n8n.
2. Each request starts a fresh official `claude -p` using stream-json input/output, partial messages, disabled built-in tools, strict MCP, one native turn and no session persistence. Temporary system/settings/tool files can hold task content. Native owns auth/refresh.
3. An [inert MCP server](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/inert_mcp.py) advertises tools but rejects execution. Hermes executes tools outside native Claude.
4. A request-scoped loopback admission relay receives native auth headers, rewrites requests and forwards them over TLS, normally to Anthropic Messages.
5. Streaming text/thinking and final external tool batches return to Hermes. History replay uses `shouldQuery:false`, zero-turn acknowledgements and a `reasoning_details` carrier retaining native blocks/signed thinking.

Sources: [history conversion](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/directsdk.py#L90-L188), [launch](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/directsdk.py#L740-L805), [replay/results](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/directsdk.py#L878-L1042).

[SDKUserMessage](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkusermessage) documents `shouldQuery:false` as context insertion without a model turn. That does not establish Hermes's complete stateless assistant-history/signed-carrier replay as a supported external-tool protocol.

### Relay and identity changes

[Admission code](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/admission.py#L637-L857) rejects browser Origin and admits one native Messages attempt per gate. It retains native Authorization/User-Agent/beta/identity headers except hop/encoding headers. Subscription bearer material therefore enters relay memory without a credential-file read.

It restores tool-result content when provable, repositions date/reminder context, adjusts cache breakpoints and enables eager tool-input streaming. Unrestored requests can still forward with a marker. Gzip fallback can resend uncompressed, so one admitted attempt does not prove one upstream POST. Configurable HTTPS upstreams, unsupported-proxy direct fallback and Python transport also change the native transport boundary. There is no account-wide concurrency ceiling; shared-client cancellation requires care. Sources: [proxy/upstream handling](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/admission.py#L585-L737), [cancellation](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/directsdk.py#L373-L560).

The relay itself does not invent identity headers. Separately, [setup](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/directsdk_setup.py#L56-L127) sets `CLAUDE_CODE_ENTRYPOINT=hermes-agent`. [README measurements](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/README.md#L162-L190) report quota differences. These are third-party observations, not Anthropic guarantees or permission. Relmio does not copy that identity override.

## Authentication, terms and privacy

The October 7 update to [Use the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says subscription-authenticated SDK and `claude -p` draw from plan limits; June 15 third-party-app billing language remains. Neither blanket prohibition nor blanket product permission follows from billing behavior.

[Legal/compliance](https://code.claude.com/docs/en/legal-and-compliance.md) restricts collecting/storing/intermediating Claude.ai credentials, offering a separate Claude login and routing personal-plan credentials on users' behalf. It contemplates unmodified hosting under stated Commercial Terms conditions, retaining native auth, direct user billing and no resale/intermediation. The [SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md) separately requires approval for third-party Claude.ai login/plan-rate-limit offerings. No exact distributed Relmio gateway ruling was established.

[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) restrict credential sharing and automated access except API-key access or explicit permission. [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) allow API-backed applications subject to restrictions. Fetched text did not establish current effective-date headings. Personal self-hosting is not a blanket exemption or quota-evasion permission.

[Gateway docs](https://code.claude.com/docs/en/llm-gateway.md#subscriptions-and-gateways) describe `ANTHROPIC_BASE_URL` with saved subscription login. [Protocol guidance](https://code.claude.com/docs/en/llm-gateway-protocol.md) requires native capabilities, beta headers, attribution, cache markers and streaming order, and warns that content changes can break signed thinking. This does not establish approval for Hermes's exact rewriting/identity behavior.

### Models, billing and usage

The reviewed [catalog](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/model_catalog.py) listed Sonnet 5.5/5, Haiku 5.5/4.5, Opus 5.5/5/4.8 and Fable 5.1, often with `[1m]`. Static discovery does not prove entitlement, context access, included allowance or successful inference. [Native model docs](https://code.claude.com/docs/en/model-config.md) permit runtime/account/policy-dependent selection; record the resolved native model.

Fable in `-p` can use paid credits without a consent prompt. Check exact account/model, billing mode and extra-usage controls before inference. Native subscription login is not a zero-charge guarantee.

[Usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work), [plan guidance](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan) and [Ultra details](https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan) describe shared, plan/model-specific meters. Pro/Max have five-hour and weekly limits; verified Ultra lacks the ordinary five-hour ceiling. Do not promise a universal window pair or fixed token allowance.

Hermes's [fetch_usage](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/directsdk_setup.py#L234-L277) uses native raw `get_usage`. Documented alternatives include [`/usage`](https://code.claude.com/docs/en/costs.md), [`SDKRateLimitEvent`](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkratelimitevent) and experimental [`SDKUsageReport`](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkusagereport), available from SDK v0.3.273 in eligible sessions. No standalone public subscription-quota REST contract was established. Keep unavailable/stale meter states distinct from empty lists.

Scope references (`user:profile` for usage reports, `user:inference` for inference-only setup tokens) were partial. No native grant/token was inspected. [Local cost estimates](https://code.claude.com/docs/en/agent-sdk/cost-tracking.md) are not invoices or remaining allowance.

### Separate monthly API-credit route

The [monthly-credit article](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans) recorded these eligible monthly amounts: Max $100, Ultra $200, Team Standard $20/seat and Team Premium $100/seat. Team pooling is capped at $500. It requires an active good-standing eligible plan for seven days and a linked Console organization with the necessary roles. Free, Pro and Enterprise are excluded. Credits expire each cycle and do not roll over; organization keys share the balance.

Ordinary n8n Messages API traffic with that organization's key fits the documented API category. API credits do not consume/increase/replace included subscription limits. Purchased balance, auto-reload or invoicing can pay after credits, otherwise requests stop. [Platform guidance](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers.md) warns auto-reload can respond to purchased balance while included credits remain. [Credit Terms](https://www.anthropic.com/legal/credit-terms) restrict transfer/sale. No eligibility/link/balance was checked.

### Custody and recipients

| Boundary | Recorded data handling |
| --- | --- |
| Hermes/native | Prompt/history/tool data and signed carriers occupy memory and temporary files. Native auth, caches/logs/crash artifacts/backups and Hermes history remain separate despite no-session-persistence. |
| Relay | Native Authorization, request body, SSE and bounded errors enter memory; authenticated rewritten requests go to Anthropic. No inspected inference route used Nous-hosted inference. Configured upstreams/proxies/tools can add recipients. |
| Errors | Disabled access logs do not exclude bounded native stderr, malformed stdout or upstream errors in caller logs. [Error source](https://github.com/NousResearch/hermes-official-plugins/blob/01fa168f3608185e8ce9ab7bcc1dbc60d5fa6731/claude-subscription-directsdk/directsdk.py#L850-L952). |
| Proposed Relmio wrapper | Bounded prompts, output/events and a separate local bearer, without native credential reads, upstream interception, request rewriting or login export. Later implementation uses real HOME with dedicated `CLAUDE_CONFIG_DIR`; home-resolved data is not isolated. |
| n8n | API-key integration gives n8n/LangChain the Console key and task data. [Encrypted credentials](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/set-a-custom-encryption-key.md) remain accessible to runtime/admins. Cloud/host/database/backup operators, tracing/memory and tools add boundaries. [Execution history](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data.md) may retain prompts, outputs, errors and tool results; actual settings were unknown. |
| Telemetry/distribution | [Claude data policy](https://code.claude.com/docs/en/data-usage.md) names Anthropic and metrics/error processors. Optional feedback can add transcript uploads and public GitHub. Hermes telemetry settings and [n8n self-hosted telemetry](https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/control-telemetry.md) are separate. GitHub/npm/container/binary hosts receive install requests when used. Exact active endpoints/settings were unverified. |

[Native auth docs](https://code.claude.com/docs/en/authentication.md) describe macOS Keychain with protected-file fallback, Linux protected files and Windows profile ACLs. Never export setup tokens or mount personal Claude state into n8n.

[Data policy](https://code.claude.com/docs/en/data-usage.md), [Privacy Policy](https://www.anthropic.com/legal/privacy), [consumer retention](https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data), [organization retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) and [covered-model retention](https://privacy.claude.com/en/articles/15425996-data-retention-practices-for-covered-models) require account/model review. Consumer model improvement can mean training and five-year retention; disabled means standard 30-day Code retention. Commercial defaults differ and have exceptions. Local hosting does not promise offline inference, zero retention, no training or backup deletion.

## Implementation choices

1. Prompt-only wrapper: fixed executable/cwd, native auth/refresh, one bounded process/request, text stdin, strict output/cleanup, local capability and no tools. The original proposed `/chat` was not a full Chat Model. The later implementation adds a text-only Chat Completions facade; it still has no tool loop. No upstream relay, identity override, token seed, raw quota probe or account rotation.
2. Full Hermes-style facade: external tool IDs/results, signed-history replay, native lifecycle, per-owner state and conversion errors create a much larger protocol. Generic n8n history can discard replay carriers. SDK callbacks/MCP/tool deferral do not establish a stateless drop-in external-tool contract. Reject this port for current scope.
3. API-key route: use n8n [Anthropic credentials](https://docs.n8n.io/integrations/builtin/credentials/anthropic.md), [Anthropic Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatanthropic.md) and [Tools Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent.md). n8n/LangChain handles Messages tools and streaming. API billing/credits and limits differ from included subscription allowance.

Another design lets native Claude own its agent loop and call approved n8n tools via the [MCP Server Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger.md). That is Claude-as-agent, not n8n AI Agent using a subscription Chat Model, and is outside this adapter.

Historical reusable Relmio patterns included `src/gateway/codex-chat.js` for subprocess/HTTP bounds, `src/supergrok/chat.js` for SSE/single-flight and tool-history invariants, and private companion topology from local n8n domain modules. Reuse patterns, not another provider's auth headers or credential-copy mechanism. No new provider framework, Python service or dependency was justified.

## n8n acceptance boundary

An [HTTP Request node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest.md) can POST text/consume JSON, but does not become an `AiLanguageModel`. Full AI Agent support needs schemas, stable assistant-call IDs, n8n execution, matching results, another model turn and terminal answer. [Anthropic client tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works.md) define that loop. Output parsers may also use tools.

OpenAI Chat Model node v1.3 defaults Responses API on despite differing prose defaults. Inspect actual versions/requests and explicitly turn it off for a Chat Completions facade. Use a Relmio-only bearer, never a real OpenAI key or Claude token. HTTP Request final JSON does not prove incremental n8n streaming, workflow Stop cancellation, proxy behavior or private reachability.

### Proposed verification criteria, not passed evidence

| Case | Required evidence |
| --- | --- |
| Streaming | Fragmented UTF-8/JSON, correct event order, no duplicate text, incomplete/error terminals and bounded slow consumers. |
| Tools, only if later supported | Multiple stable calls, out-of-order matching results, failed/duplicate/orphan/missing results, schema validation, parser tools, next turn and terminal answer. No side effect from partial calls. |
| History/isolation | No cross-request/account leakage; replay fidelity or explicit limits; no stale signatures after edits; no reliance on arbitrary preserved n8n metadata. |
| Cancellation | Before output, midstream, actual n8n Stop and any tool wait; owned child/socket gone, unrelated sessions intact. Cancellation is not a refund or undo. |
| Concurrency | Distinct busy result, no queue/retry/double execution, slot held through cleanup. |
| Auth/quota | Synthetic auth/quota/billing/model failures; no silent account/model/billing switch, quota guess or real quota exhaustion test. |
| Custody | Synthetic canaries absent from errors/SSE/argv/logs/artifacts; native credentials not read/exported; telemetry/retention separately inspected. |
| n8n | Disposable workflow on actual versions, timeout/cancel, private network, local auth and execution-retention review. |
| Live pilot | Separate owner approval, qualified binary/policy/auth/model/billing, synthetic prompt, resolved model and timestamp. Rounded shared meters do not prove fixed weighting or free cancellation. |

Launch controls must be qualified together. Safe mode, empty tools/MCP, `--no-session-persistence` and `client_composed:true` do not remove managed-policy execution risks. Do not use `--bare` for this subscription design: [headless docs](https://code.claude.com/docs/en/headless.md) say it skips OAuth/Keychain and requires API credentials. Init arrives too late to prevent startup hooks. Keep startup policy/helpers controlled throughout any expiring qualification.

Later Docker/VPS work needs its own reviewed target, SSH host-key check before authentication and final human confirmation before writes. Do not edit/rebuild/restart n8n or publish inference ports. Approval for another provider is not Claude deployment approval.

## Required OpenAI comparison: historical

The 2026-11-03 check fetched current identity, plan-sharing, SIWC registration/inference/limits, Codex auth/App Server, TTS, Terms and privacy sources. Exact links/dates and findings are preserved in the [same-day source check](claude-native-prompt-source-check-2026-11-03.md#mandatory-openai-check-historical-unchanged-flow).

Identity scopes, separate plan grants and model/TTS capability remained distinct. The older checkout copied Codex credential JSON into local/Docker/remote storage and used `openai-oauth@2.0.0`; dependency custody and bridge permission were unresolved. That comparison does not describe 0.23.0 SIWC and does not authorize Anthropic use. Login/text success was no TTS proof.

## Unresolved at the evaluation date

No binary, native-login grant, entitlement, extra-usage setting, API-credit eligibility/link/balance, live n8n version/topology, tools, cancellation, concurrency, refresh, quota or traffic/log capture was verified. Optional protocol execution was denied, not passed. MIT notices and binary-distribution review remained separate requirements. Distributed subscription-backed gateway permission remained unresolved.

Decision: API-key integration for full n8n agent workflows; separately approved, owner-only unmodified-native prompt use as the smallest subscription experiment. Later passing evidence belongs in the dated [verification record](claude-native-prompt.md#verification-record), not retroactively in these criteria.
