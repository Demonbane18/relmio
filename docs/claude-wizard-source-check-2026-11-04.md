# Claude browser wizard: official-source check

Checked 2026-11-05 for the proposed Relmio 0.24.0 Claude wizard update. The requested filename retains the feature's November 4 date; this source check occurred November 5.

The required [Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) was fetched first. Review covered the local and VPS Claude wizard implementations, shared companion builder, native request adapter, affected UI copy, README, security documentation and FAQ in the release worktree. OpenAI flows are unchanged by the assigned feature; their authentication, storage and text-inference boundaries were inspected for the mandatory comparison.

No files were edited. No login, forms, credentials, authenticated provider calls, native Claude execution, inference, Docker, SSH, deployment, tests or builds were performed. Code observations describe implementation, not live runtime evidence. This report supplies no vendor approval, legal opinion, account entitlement or release acceptance.

## Sources and dates

All URLs below were fetched on 2026-11-05. “Not shown” means the fetched content supplied no published or updated date. Relative Help Center dates are preserved as displayed rather than converted into an assumed publication date.

### Anthropic sources

These are first-party evidence for Anthropic's own behavior and restrictions, not evidence of OpenAI permission.

| Source | Displayed date | Relevant finding |
| --- | --- | --- |
| [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | Updates October 7, 2026 and June 15, 2026 | Subscription-authenticated Agent SDK and `claude -p` still draw from subscription limits. Linked monthly API credits apply separately when using an API key from the linked Console organization. |
| [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md) | Not shown | Hosting/preinstalling unmodified Claude Code is contemplated under Commercial Terms and stated conditions. Authentication methods must remain intact; users authenticate and are billed directly. The page separately restricts third-party Claude.ai login, credential intermediation and routing personal-plan requests on users' behalf. |
| [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md) | Not shown | Unless previously approved, third-party developers may not offer Claude.ai login or rate limits for their products. Recommends API-key or supported cloud-provider authentication. |
| [Model configuration](https://code.claude.com/docs/en/model-config.md#fable-and-usage-credits) | Not shown | Fable requests in `-p`, or SDK applications without the consent prompt, can bill usage credits without asking. Model selection, substitutions and entitlement remain separate concerns. |
| [Headless operation](https://code.claude.com/docs/en/headless.md) | Not shown | Documents `-p`, stdin and JSON/stream-json output. Startup hooks can precede `system/init`. `--bare` does not read subscription OAuth credentials or the system Keychain. |
| [Claude Code authentication](https://code.claude.com/docs/en/authentication.md) | Not shown | Official CLI owns browser login and terminal paste-code handling. Documents credential precedence, native storage and dedicated `CLAUDE_CONFIG_DIR` behavior. Linux credentials use `.credentials.json`; macOS normally uses Keychain, with a file fallback when Keychain rejects the write. |
| [Data usage](https://code.claude.com/docs/en/data-usage.md) | Not shown | Consumer training and retention depend on settings: five years with model improvement enabled, 30 days when disabled, subject to applicable policy exceptions. Documents native telemetry and optional feedback recipients. Commercial treatment differs. |
| [Privacy Policy](https://www.anthropic.com/legal/privacy) | Not established in fetched text | Covers inputs/outputs, account and technical data, service providers, organization access, safety processing and legal disclosures. |
| [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) | Not established in fetched text | Retains the restriction on automated/non-human access except through an API key or explicit permission. Account sharing and making an account available to others are prohibited. |
| [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) | No calendar revision date established | Applies to offerings governed by those terms; its existence does not move every personal subscription onto commercial treatment. |
| [Official Claude Code 2.1.317 manifest](https://downloads.claude.ai/claude-code-releases/2.1.317/manifest.json) | Build date `2026-11-02T22:39:48Z` | Linux x64 and arm64 checksums match the builder and Dockerfile pins. Build commit is `3d3e7cb16b5577dccaee9520c8dc1189d02d61b7`. No binary was downloaded or run. |

**Confirmed:** all five specifically requested November 4 sources were re-fetched, together with the authentication documentation. The material subscription-billing, third-party-login and Fable warnings recorded in the preceding report remain present. That comparison does not establish byte-for-byte equality of the pages.

### Mandatory OpenAI sources

All sources in this table use official OpenAI domains.

| Source | Displayed date |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 13 days ago |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: 8 days ago |
| [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) | Not shown |
| [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md) | Not shown |
| [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md) | Not shown |
| [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md) | Not shown |
| [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms.md) | Not shown |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | **Effective November 4, 2026** |
| [Service Terms](https://openai.com/policies/service-terms/) | Updated October 16, 2026 |
| [Terms of Use](https://openai.com/policies/terms-of-use/), canonical [rest-of-world Terms](https://openai.com/policies/row-terms-of-use/) | Published/effective January 1, 2026 |
| [Privacy Policy](https://openai.com/policies/privacy-policy/), canonical [services/communications policy](https://openai.com/policies/services-communications-privacy-policy/) | Updated July 30, 2026 |
| [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech) | Page revision not shown; cites October 1, 2026 deprecation and January 6, 2027 shutdown |

**Confirmed:** the current SIWC Terms display November 4, 2026, rather than the September 29 date recorded in the preceding report. Persistent-token storage and connected-application restrictions remain in the fetched text. No claim is made that those are the only changes to the Terms.

## Anthropic findings

### Identity and native sign-in

**Confirmed:** official authentication documentation supports `claude auth login`, a provider browser flow and, when required, pasting the login code into the official CLI's terminal prompt.

**Observed:** the browser supplies a terminal command, not a Claude login form. VPS commands invoke `login.sh` over the user's terminal SSH session; the script runs the pinned official executable inside the companion. Local `relmio claude companion login` requires a TTY and starts Docker with inherited terminal stdio. Relmio's JavaScript does not parse or capture that login exchange (`src/services/vps-claude.js:211-214`; `src/templates/claude-companion/login.sh:5-13`; `src/services/claude-login.js:9-51`).

**Observed:** browser status is restricted to `loggedIn`, `authMethod` and `subscriptionType`. The VPS UI requires `loggedIn === true` and `authMethod === "claude.ai"` before displaying plan sign-in as confirmed (`src/claude/companion.js:114-126`; `src/web/server.js:2808-2815,5328-5338,5956-5960`; `src/ui/claude-vps.js:352-359`).

**Open:** this is native Claude subscription authentication, not identity-only sign-in to a Relmio account. The actual OAuth scopes and grant are selected by official Claude Code and were not inspected. Relmio defines no Anthropic OAuth client or scope list in these paths. An auth-status label does not prove billing settings, permissions or successful inference.

### Separately approved permissions

**Confirmed:** the plan article describes billing and limits. The quickstart and legal/compliance pages separately constrain third-party products, login and credential handling. Neither a working native login nor documented `claude -p` billing supplies blanket approval for Relmio.

**Observed:** installation and renewal require four owner assertions and confirmation. These cover the binary, effective policy, native auth/billing and control of later changes. The builder records the assertions in an expiring launch file; it does not conduct the review itself (`src/services/vps-claude.js:78-83,272-312,387-407`; `src/services/local-n8n-claude-installer.js:240-244,365-387`; `src/claude/companion.js:65-100`).

**Open: wizard distribution and login offering.** The new chooser and local card explicitly offer a Claude setup path, with “Official sign-in” and “Experimental” badges (`src/ui/index.html:173-181`; `src/ui/local.html:368-374`). That offering is relevant to the quickstart's prohibition on third parties offering Claude.ai login or rate limits for their products unless approved. Keeping authentication in the unmodified official CLI avoids a browser paste-code relay, but does not by itself settle whether the distributed wizard/gateway falls within that restriction. The legal/compliance page's allowance for user login to hosted unmodified Claude Code must be considered together with its other conditions. No fetched source expressly approves Relmio's n8n gateway or wizard.

Owner-only use, non-endorsement notices and unchecked review boxes do not constitute Anthropic approval. The VPS checkbox asking the owner to confirm that personal use is permitted records the owner's judgment, not a resolved legal finding (`src/ui/claude-vps.html:165-169`).

### Model capability and billing

**Confirmed:** Anthropic documents non-interactive CLI requests and stream-json output. Fable can incur usage-credit charges without a prompt in this mode.

**Observed:** the adapter pins Claude Code 2.1.317, accepts one to eight exact configured model IDs, refuses Fable, disables tools/MCP for the request, and supports text Chat Completions rather than Responses, images, audio or AI Agent tool execution. It flattens accepted text messages into one native prompt; sampling fields, output caps and stop settings are validated but not applied (`src/claude/launcher.js:11-42`; `src/gateway/claude-chat.js:190-270,680-705,845-857`). Native output checks constrain model, runtime and terminal completion; detected tool execution fails closed (`src/gateway/claude-chat.js:560-644`).

**Observed:** “Check models” reads the companion's configured allowlist. It does not query Anthropic or run an inference request. `/health` explicitly reports `providerReadiness: "not-probed"` (`src/gateway/claude-chat.js:845-854`; `src/services/vps-claude.js:416-428`; `src/services/local-n8n-claude-installer.js:402-413`). Local UI states this directly; VPS UI says a listed model does not prove a workflow succeeds (`src/ui/local.html:1503-1505`; `src/ui/claude-vps.js:360-365`).

**Open:** account access to each model, native policy behavior, current allowance, extra-usage settings and actual charges require target-specific evidence. Fable refusal is not an account-wide spending cap. Owner review expiry is not OAuth token expiry or provider permission expiry. `--no-session-persistence` does not prove absence of native files or provider retention, and startup hooks can run before the adapter receives `system/init`.

## Mandatory OpenAI findings

### Identity sign-in

**Confirmed:** the current Help Center article describes basic identity information and separately approved additional permissions. Identity-only sign-in does not independently share conversations, memory, files, tokens or billing data.

**Observed:** Relmio's complete OpenAI flow requests both identity and plan-use scopes. It uses `dynamic_agent_client` for initial registration, `agent_name_hint: Relmio`, a stable host ID, state/nonce, S256 PKCE and a loopback callback. Code exchange uses the issued client ID; ID-token validation checks signature, issuer, audience, expiry, nonce and returning subject (`src/services/oauth.js:10-12,70-75,147-178,202-213`; `src/services/siwc-session.mjs:624-658`). This is not the historical copied-Codex credential bridge.

The identity-only Help Center description therefore does not describe Relmio's entire plan-use session. README and FAQ preserve this distinction (`README.md:20-30`; `docs/faq.md:26-57`).

### Separately approved permissions

**Confirmed:** documented identity scopes are `openid profile email`; plan-use scopes are `offline_access resource.invoke chatgpt.tokens.use.direct`.

**Observed:** Relmio requests those six scopes, stores the returned grant and derives plan permission from returned `chatgpt.tokens.use.direct`. A verified identity alone cannot release an inference token. Background-use consent is part of the protected runtime handoff (`src/services/oauth.js:11-12,202-213`; `src/services/siwc-session.mjs:546-595,733-795,905-938`).

**Open, unchanged:** current SIWC Terms require persistent tokens to be local and under user control, “not in a remote or managed environment.” They also permit requests from a remote runtime controlled only by that user. The VM guide documents protected credential transfer and destination-owned refresh. Relmio implements such transfers, but the published storage wording remains unresolved for VPS use. The Terms also prohibit general-purpose API access for other tools or unrelated requests; whether the n8n-compatible endpoint fits the connected-application requirement remains unresolved. Existing disclosures retain both questions (`README.md:160-168`; `docs/faq.md:153-168`).

### Model and TTS capability

**Confirmed:** SIWC text inference uses public `https://api.openai.com/v1/responses` with `store:false` and `stream:true`; the guide excludes ChatGPT backend-api endpoints for that flow. A catalog listing does not establish completed inference or account entitlement.

**Observed:** Relmio obtains the selected registration's token, translates Chat Completions to Responses, forces those storage/stream settings and rejects speech routes (`src/gateway/openai-oauth-sidecar.mjs:822-826,991-1080`). The separate, unchanged Codex image add-on is disclosed separately in `docs/security.md:500-559` and `docs/faq.md:74-83`; this Claude feature does not authorize or qualify it.

**Confirmed:** the TTS guide describes a separate Speech API workflow. `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` are deprecated with January 6, 2027 shutdown; `gpt-realtime-2.1-mini` is not a drop-in `/v1/audio/speech` replacement. Identity sign-in, plan permission, a successful text request or native Claude login establishes no TTS access. The Claude wizard adds none.

## Data handling and recipients

The following inventory covers the changed Claude paths and inspected OpenAI baseline. It describes code and provider documentation, not packet capture. Deployment-specific logging, backups, extensions, workflow integrations and provider-side processing remain separate boundaries.

### Claude wizard and companion

| Boundary | Reads / stores / transmits / logs | Receiving parties and evidence |
| --- | --- | --- |
| VPS connection | Reads host, port, username, confirmed fingerprint and either SSH password or local-agent authentication. The SSH library uses the selected method, with agent forwarding disabled. Executes inspection/build/management commands and uploads bundle files over the authenticated connection. | Browser, local Relmio process, local SSH agent where selected, selected VPS SSH service and host administrators. `src/infrastructure/ssh.js:152-188,238-334,447-479`; `src/web/server.js:980-981,5892-5955`. These are SSH credentials, not Claude credentials. |
| Owner review and installation | Reads selected Docker container/network, architecture, model IDs, ownership markers, file hashes and four review answers. Stores generated adapter/templates, `.env` containing network/platform/key hash, launch approval, installation metadata and locks. Local root defaults to `~/.relmio/local/n8n-claude-oauth`; VPS root is `/docker/n8n-openai-oauth/claude`. Approval lasts seven days minus one hour. | Local filesystem or selected VPS, Docker daemon/container, root/Docker administrators and backups. `src/claude/companion.js:65-100`; `src/services/vps-claude.js:18-45,313-353`; `src/services/local-n8n-claude-installer.js:61-68,240-294`. |
| Official terminal login | Local wrapper inherits terminal stdio; VPS script runs official native login through terminal SSH/Docker. No browser paste-code endpoint or field exists in the reviewed flow. Official native, rather than the Relmio adapter, reads/stores/refreshes provider credentials. | User's terminal and browser, OS SSH/Docker transport, official Claude process and Anthropic authentication services. `src/services/claude-login.js:17-51`; `src/templates/claude-companion/login.sh:5-13`. Terminal capture or privileged host access remains possible. |
| Native credential custody | `CLAUDE_CONFIG_DIR=/data/account/config` sits in Docker volume `relmio-claude_claude-account`, mounted at `/data/account`. On Linux, official documentation places `.credentials.json` under that directory. The image is read-only except mounted data/tmpfs; no host port or Docker socket is declared. | Official Claude runtime, Docker storage, VPS/local host administrators and backups; Anthropic receives native authentication/refresh traffic. `src/templates/claude-companion/compose.yml:5-34`; `src/services/local-n8n-claude-installer.js:25`; `src/gateway/claude-chat.js:689-705`. Actual provider OAuth scopes remain unknown; Relmio requests none itself. |
| Auth-status checks | Runs `claude auth status --json`, receives raw stdout, then parses and keeps only `loggedIn`, `authMethod`, `subscriptionType` for browser responses. Raw status may contain additional identity metadata. On VPS, raw stdout/stderr crosses SSH to local Relmio before filtering. | Official child, Docker, local Relmio process; for VPS also SSH transport. Browser receives the three-field response only. `src/services/vps-claude.js:72-75,262-268`; `src/infrastructure/ssh.js:284-309`; `src/services/local-n8n-claude-installer.js:328-337`; `src/claude/companion.js:114-126`; `src/web/server.js:2808-2815,5328-5338`. |
| Relmio client key | Generates an independent random bearer; wizard bundle files store its SHA256 rather than plaintext. Sends the plaintext key once in the install result and retains it in the displayed page until cleared. Copy action sends it to the OS clipboard. Model checks pass it to a Docker probe through stdin, then as an HTTP Authorization header. | Browser/local Relmio, clipboard if copied, Docker probe, companion and trusted caller. The key is not a Claude/OpenAI token and is not passed to the native Claude child. `src/claude/companion.js:86-100`; `src/ui/claude-vps.js:341-343,360-380`; `src/services/vps-claude.js:416-428`; `src/services/local-n8n-claude-installer.js:402-413`; `src/gateway/claude-chat.js:121-126,733-780`. The separate manual CLI preparation still writes `n8n-api-key.txt` (`src/claude/companion.js:155-168`). |
| Local n8n credential import | For an attested Relmio-created n8n stack, sends the Relmio key and private base URL to `n8n import:credentials` over stdin. Stores credential ID/name/import timestamp in `.runtime/credentials.json`; actual key is handed to n8n's credential store. Failed import leaves manual one-time-key setup available. VPS wizard does not perform this import. | Selected local n8n, Docker transport, n8n storage/administrators/backups. `src/web/server.js:5087-5112`; `src/services/local-n8n-stack-credentials.js:10-15,79-97`. “Shown once” does not mean no stored copy exists in n8n. |
| Prompt inference | Reads bearer, selected model and bounded text messages/history. Flattens them into one prompt and sends `client_composed` stream-json over native stdin. Receives native events, validates text/usage/completion, returns response or filtered errors. One request runs at a time. Raw stderr is counted/drained, not logged or returned by the adapter. | n8n/calling app, Relmio companion memory, official Claude process, Anthropic inference and any owner-configured downstream workflow recipients. `src/gateway/claude-chat.js:190-270,560-644,733-800,845-932`. Docker-network HTTP is not encrypted; privileged host access remains relevant. No OpenAI inference recipient appears in this Claude path. |
| Native files and diagnostics | Launcher reads executable bytes/hash and launch configuration; creates private runtime directories and account lock. Logs listener address or fixed refusal/shutdown codes. Native receives explicit environment requesting nonessential-traffic and marketplace-auto-install disablement, plus disabled session persistence. | Local/container filesystem, owner terminal or Docker log collector, privileged administrators and backups. `src/claude/launcher.js:90-113,239-375`; `src/gateway/claude-chat.js:680-705`. These flags do not prove zero native files, zero provider retention or complete egress suppression. |
| Sign-out, renewal and removal | Sign-out invokes native logout. Renewal rewrites approval timestamps and restarts only the companion; it does not itself renew a provider OAuth grant. VPS replacement retains the login volume and rotates the Relmio key. Removal deletes the managed companion and login volume. | Same native/host/storage boundaries as above. `src/services/vps-claude.js:355-407`; `src/services/local-n8n-claude-installer.js:365-398`. Removal does not establish deletion of backups or provider-retained data. |
| Build downloads | Container build obtains the Node base image, Debian packages and the checksum-pinned official Claude executable. | Container registry, configured Debian mirrors and `downloads.claude.ai` receive build request/IP metadata. `src/templates/claude-companion/Dockerfile:3-24`. No account login is put into the build inputs by the inspected builder. |
| Provider telemetry and retention | Anthropic documents operational metrics/error processors and optional feedback uploads; configured organization collectors can add recipients. Inference child requests nonessential traffic off. Local auth commands and terminal login do not all set that flag; VPS status does. | Anthropic and its documented processors; optional feedback can reach Google Cloud Storage and public GitHub. Actual enabled destinations were not measured. `src/gateway/claude-chat.js:689-705`; `src/services/vps-claude.js:72-75`; `src/services/local-n8n-claude-installer.js:25`; `src/templates/claude-companion/login.sh:5-13`; official data-usage/privacy sources above. |
| Wizard metadata and help | Topbar requests public GitHub stars, with Relmio website fallback, using version User-Agent. Opening external setup-guide links sends ordinary browser request metadata to that site. | GitHub, Relmio website hosting and browser/OS. No Claude prompt or provider token is part of the inspected star request. `src/services/project-meta.js:7-35`; `src/ui/claude-vps.js:382`; `src/ui/claude-vps.html:171`; `src/ui/local.html:748`. These services are not vendor-policy authorities. |

### Unchanged OpenAI baseline

| Boundary | Reads / stores / transmits / logs | Receiving parties and evidence |
| --- | --- | --- |
| Authorization and local storage | Reads callback code/state/issued client ID and token response. Stores verified issuer/subject/email, client and host/runtime IDs, granted scopes, access/refresh/ID tokens, expiry and permission/consent state under `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth`, including `registrations/<id>.json`. Unix directories/files use 0700/0600 protection; Windows uses ACL handling. Authorization state/nonce/PKCE values belong to the pending attempt. | Browser/OS launch surface, local Relmio, OpenAI auth/discovery/JWKS/token services, owning OS account, privileged administrators and backups. `src/services/oauth.js:70-178,202-227`; `src/services/siwc-session.mjs:59-69,90-166,546-595,624-658`. Requested scopes are the six listed above; returned grants govern plan use. |
| Refresh and destination handoff | Sends refresh token, issued client ID and resource to OpenAI. Serializes rotating updates. Transfers the protected registration to the reviewed destination through Docker stdin or SSH; freezes source ownership and clears source tokens after a matching receipt. | OpenAI; local Docker runtime or selected VPS/container/storage; host administrators and backups. n8n receives a separate Relmio bearer. `src/services/siwc-session.mjs:733-795,905-938,995-1056`; `src/services/installer.js:735-782`; `src/services/local-n8n-sidecar-installer.js:2372-2400`. |
| Text inference, catalog and accounting | Reads caller messages and supported tool/input data; sends normalized request with selected access token to public Responses. Caches replayable assistant text/encrypted reasoning in process memory. Catalog checks contact OpenAI; npm version lookup sends no provider token. Stores bounded model/accounting records, not remaining-plan allowance. Filters provider errors before returning them. | OpenAI, n8n/calling app and owner-selected workflow recipients; npm receives version-query metadata; runtime stores cache/accounting. `src/gateway/openai-oauth-sidecar.mjs:348-388,991-1080`; `src/services/model-discovery.mjs:17-28,620-665,837-897`. |

The existing optional Codex image session and App Server have separate data paths documented in the preceding source check. They are unchanged and were not newly live-qualified here. Anthropic documentation supplies no authority for those OpenAI paths.

## Disclosure comparison and mismatches

1. **Observed: stale CLI-only descriptions.** At this review cutoff, `README.md:191-196` says there is no Claude browser-wizard option or automatic deployer, and `docs/claude-subscription.md:18-21` says there are no wizard screens. Both contradict the new implementation. README's current-release/source-check references still describe 0.23.0 (`README.md:29-35`). Update them when integrating the release; this report does not claim 0.24.0 has shipped.
2. **Observed: security/FAQ coverage gap.** The inspected `docs/security.md` and `docs/faq.md` contain no Claude-specific section. Add the native credential-volume boundary, status metadata handling, one-time Relmio key/n8n import, terminal-only login, removal effects and unresolved product-permission question. Existing OpenAI disclosure text must remain separate.
3. **Observed: browser filtering is narrower than the backend comment claims.** `src/services/vps-claude.js:4` says only three status fields ever leave the VPS. In fact, `readAuthStatus` receives raw native stdout over SSH and filters it locally (`:262-268`; `src/infrastructure/ssh.js:284-309`). The three-field guarantee is accurate for browser responses, not for the VPS-to-Relmio boundary. Additional native identity metadata may reach local process memory; no live payload was inspected. This finding does not establish provider-token exposure.
4. **Observed/Open: the wizard warning does not explicitly explain approval uncertainty.** The new surfaces show Experimental, non-endorsement, terminal login, personal use and possible loss of access (`src/ui/index.html:173-181`; `src/ui/local.html:744-750,1491-1515`; `src/ui/claude-vps.html:196-228`). Existing README text explicitly names the quickstart restriction and lack of Anthropic approval (`README.md:206-211`). Preserve that explicit unresolved-permission warning when updating docs; do not use “Relmio provides no Claude login” to imply that the wizard offering is outside the restriction.
5. **Observed: credential-custody wording needs a defined subject.** “Relmio never sees your Claude login” is supported for the browser paste code and adapter credential-file handling. It must not imply that the whole installed companion contains no credentials: official Claude stores them in its Docker volume, and host administrators/backups can access them. Local management and VPS storage disclosures already mention this boundary (`src/ui/local.html:1506`; `src/ui/claude-vps.html:216`). Auth-status metadata is also read by Relmio.
6. **Observed: capability disclosures mostly match the adapter.** UI identifies text-only operation, Basic LLM Chain plus OpenAI Chat Model, Responses API off, Max Retries 0, Timeout at least 135000 ms, Batch Size 1 and no AI Agent tools/n8n AI Assistant (`src/ui/local.html:1501`; `src/ui/claude-vps.html:213`). A model check remains an allowlist/reachability check, not inference qualification. VPS copy could state that distinction as directly as the local note does.
7. **Observed: stale OpenAI retention comment.** `src/gateway/openai-oauth-sidecar.mjs:349` says `store:false` means nothing is kept upstream. Current provider privacy wording does not support that absolute statement. It disables persisted Responses state in this flow; it does not prove zero safety/security retention or zero caller history.
8. **Observed: unchanged returning-sign-in difference.** OpenAI session guidance instructs sending retained `id_token_hint` during reauthorization. Relmio retains the ID token but does not send that hint in `src/services/oauth.js:202-213`. Current docs also describe the no-hint account-selector behavior. This is a protocol/UX difference, not evidence that returning identity validation is absent.
9. **Provisional: historical third-party usage measurements.** README cites Hermes measurements suggesting faster five-hour-window consumption and records approximate small-call native overhead (`README.md:216-223`). Hermes is not vendor permission or entitlement evidence. Those measurements were not re-fetched or reproduced in this check; preserve their existing third-party/approximate qualification rather than promoting them to current confirmed results.

## Remaining unknowns

- Whether Anthropic approves this distributed wizard/gateway under the quickstart and legal/compliance restrictions. Terminal-only official login does not resolve it.
- Actual native OAuth grant/scopes, account model access, effective managed policy/hooks/helpers, extra-usage settings and provider-selected authentication on each installation.
- Actual inference, cancellation, renewal-after-expiry, sign-out/revocation and removal behavior on supported local/VPS targets. Static review and model listings are insufficient evidence.
- Whether all active native traffic honors the requested disablement settings, including commands that do not set them; exact deployed telemetry/processor destinations.
- n8n execution-history, tracing and memory configuration; terminal/browser capture; Docker/host logs and backups; account-specific provider retention/training settings.
- OpenAI's persistent remote-token storage wording and connected-application restriction as applied to the existing n8n endpoint. The November 4 SIWC Terms do not resolve those questions in the fetched text.

## Conclusion

The implementation keeps Claude login in the official CLI, leaves provider credentials under native custody, and exposes filtered browser status plus a separate Relmio bearer. Those design facts do not resolve Anthropic's restriction on third-party products offering Claude.ai login or plan limits. The new wizard offering must remain explicitly unresolved, experimental and owner-only.

The mandatory OpenAI refresh preserves separate identity, permission and capability checks. Current SIWC Terms now display November 4, 2026; existing remote-storage and connected-application questions remain open. Neither vendor's login or capability documentation establishes blanket compliance, credential-bridge permission or TTS access.

This completes the public-source comparison and code observations above. Documentation integration, implementation fixes, main-agent verification and live release acceptance remain separate work; no such result is claimed by this report.
