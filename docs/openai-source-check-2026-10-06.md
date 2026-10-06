# OpenAI source check, 2026-10-06

This is a follow-up to [the 2026-10-05 check](openai-source-check-2026-10-05.md).
It covers two fixes: the wizard's model-list check during plan review, and the
VPS sidecar's Compose ownership check. No sign-in, provider request, credential
read or remote operation was part of this review.

## Sources

Retrieved on 2026-10-06. Developer pages show no update date.

| Source | Status | Displayed date |
| --- | --- | --- |
| [Sign in with ChatGPT (Help Center)](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Retrieved | Updated 4 days ago |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Retrieved | Updated 3 hours ago |
| [SIWC Quickstart](https://developers.openai.com/siwc/quickstart.md) | Retrieved | None |
| [Token sharing for open-source tools](https://developers.openai.com/siwc/token-sharing-open-source) and its sign-in, profiles and sessions, models and inference, Codex App Server, self-hosted VMs, token reference, errors and recovery, and preview limitations pages | Retrieved | None |
| [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) | Retrieved | None |
| [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create.md) | Retrieved | None |
| [Sign in with ChatGPT (learn.chatgpt.com)](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) | Retrieved | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | Retrieved | September 29, 2026 |
| [Service Terms](https://openai.com/policies/service-terms/) | Retrieved | September 29, 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) and [EU Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Retrieved | January 1 and January 16, 2026 |
| [Usage policies](https://openai.com/policies/usage-policies/) | Retrieved | October 29, 2025 |
| [Privacy policy](https://openai.com/policies/privacy-policy/) and [EU privacy policy](https://openai.com/policies/eu-privacy-policy/) | Retrieved | July 30 and August 24, 2026 |

`https://developers.openai.com/siwc/sign-in` and
`https://developers.openai.com/siwc/models-and-inference` returned 404; their
content is under the token-sharing pages above.

## Findings

- The plan article now lists Go, Plus and Pro for plan use in participating
  apps, and says supported open-source tools remain available to all ChatGPT
  users. The 2026-10-05 check recorded Plus and Pro only. The Quickstart and
  partner directory still say Plus and Pro, so the official pages disagree.
  Relmio does not check the subscription tier in code.
- No other compared fact changed. Refresh still uses the issued client ID,
  refresh token and API resource without `scope`, and replacement tokens need
  no new consent. Model discovery still uses the selected account's bearer at
  `/v1/models`. Policy dates match the previous check.
- Identity sign-in, the separate plan permission and model capability are
  unchanged by these fixes. The model-list endpoint still requires a verified,
  connected, locally owned account with plan use enabled before and after
  discovery. A refreshed token no longer causes a false conflict, and a
  different selected account is still refused. A returned model list is not
  proof that a model request or TTS works.
- The Compose fix only accepts `command` and `entrypoint` when Docker reports
  them as `null` or omits them. Any value, including an empty list or string,
  is still rejected. Image and container checks are separate and unchanged.

## What Relmio reads, stores, transmits and logs

Neither fix changes this. The model-list endpoint reads the selected
registration, its account state and the account's model list. Registration
records stay in `N8N_OPENAI_OAUTH_HOME` or
`~/.n8n-openai-oauth/registrations/`. Refresh sends the refresh token, client
ID and resource to OpenAI's token endpoint, and discovery sends the bearer to
`https://api.openai.com/v1/models?client_version=0.160.0`. The browser receives
the sanitized account view, the model list or an error, never a provider token.

The Compose check reads the resolved Compose configuration over the reviewed
SSH session and writes nothing. When it passes, the existing reviewed session
transfer can run. It adds no transfer method, destination or permission.

No logging was added. OAuth scopes are unchanged:
`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`,
resource `https://api.openai.com/v1`. Recipients are unchanged: the local
Relmio process and its protected storage, the local browser, OpenAI's
authentication and API services, the selected VPS and its administrator, and
n8n through its separate local bearer.

## Addendum: VPS sidecar update

Reviewed the same day against the sources above. The new **Review sidecar
update** action rebuilds the installed VPS sidecar image from the current
Relmio files and recreates only the sidecar container. It runs no sign-in,
refresh, handoff or accept step, uploads no credential and does not rewrite
the Compose file, so the one-time Relmio key and the stored session are
unchanged. It reads the installed account view from the running sidecar, as
status already does. What Relmio reads, stores, transmits and logs, its OAuth
scopes and its recipients are unchanged. Building the image contacts the npm
registry for the pinned dependencies, as the original install does.

## Addendum: Codex-login image add-on

Reviewed on 2026-10-06 against the uncommitted add-on on `feature/documented-siwc` (base `5beb837`): `src/services/codex-images.mjs`, the image routes in `src/gateway/openai-oauth-sidecar.mjs`, the VPS commands in `src/domain/safety.js` and `src/services/installer.js`, the wizard routes in `src/web/server.js`, and the copy in `src/ui/index.html` and `src/ui/app.js`. This review did not sign in, call a provider, read a credential, run a remote operation or run tests.

On 2026-10-06 the owner accepted that this route is not documented by OpenAI for third-party apps, may stop working and counts against the plan's Codex limits. That is Relmio's own risk decision. Nothing in this addendum is OpenAI approval, proof of Terms compliance, permission to use a Codex credential bridge, or evidence that image generation works for any account.

### Sources

All retrieved on 2026-10-06. The Sign in with ChatGPT article was fetched first. Developer and learn pages show no update date.

| Source | Status | Displayed date |
| --- | --- | --- |
| [Sign in with ChatGPT (Help Center)](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Retrieved | Updated 4 days ago |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Retrieved | Updated 9 hours ago |
| [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | Retrieved | Updated 22 minutes ago |
| [Codex authentication](https://developers.openai.com/codex/auth) (served from `learn.chatgpt.com/docs/auth.md`) | Retrieved | None |
| [Codex App Server, Auth endpoints](https://learn.chatgpt.com/docs/app-server) | Retrieved | None |
| [Codex image generation](https://learn.chatgpt.com/docs/image-generation) | Retrieved | None |
| [Codex pricing: image-generation usage and feature availability](https://learn.chatgpt.com/docs/pricing#image-generation-usage-limits) | Retrieved | None |
| [GPT-Image-2 model page](https://developers.openai.com/api/docs/models/gpt-image-2) | Retrieved | None (default snapshot `gpt-image-2-2026-04-21`) |
| [SIWC token sharing for open-source tools](https://developers.openai.com/siwc/token-sharing-open-source) and its [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) and [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) pages | Retrieved | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | Retrieved | September 29, 2026 |
| [Service Terms](https://openai.com/policies/service-terms/) | Retrieved | Updated September 29, 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) and [EU Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Retrieved | Published January 1, 2026; updated January 16, 2026 |
| [Usage policies](https://openai.com/policies/usage-policies/) | Retrieved | Effective October 29, 2025 |
| [Privacy policy](https://openai.com/policies/privacy-policy/) and [EU privacy policy](https://openai.com/policies/eu-privacy-policy/) | Retrieved | Updated July 30 and August 24, 2026 |

Policy dates match the earlier check today. The wire details of the image route and device flow come from OpenAI's open-source Codex client at `github.com/openai/codex@822e58c` and from Hermes Agent at `NousResearch/hermes-agent@daefc2b`. Neither is on an OpenAI documentation domain, so those details are labelled Provisional here.

### What the add-on reads, stores, transmits and logs

Reads:

- On the VPS, inside the sidecar container running as `node` (`src/domain/templates.js:18`): `codex-images/session.json`, `pending.json` and `lock` under `N8N_OPENAI_OAUTH_HOME=/home/node/.relmio-siwc` (`templates.js:38,43`; `codex-images.mjs:87-102,522`). Symlinks, hard links, foreign owners and group or other permissions are refused (`codex-images.mjs:103-107`).
- Token responses: `email` from the ID token; `chatgpt_account_id` and `chatgpt_plan_type` from the `https://api.openai.com/auth` claim of the ID or access token; access-token `exp` (`codex-images.mjs:296-315`). Each lease also reads `chatgpt_data_residency` or `chatgpt_compute_residency` and `chatgpt_account_is_fedramp` (`codex-images.mjs:362-370`). The JWTs are decoded without signature checks (`codex-images.mjs:70-82`), so these values are display and routing data only.
- n8n requests on `/v1/images/generations` (JSON up to 64 KiB) and `/v1/images/edits` (multipart up to 48 MiB, 1 to 16 images of up to 25 MiB), after the existing local bearer check (`openai-oauth-sidecar.mjs:775-792,839-840`).
- On the desktop, Relmio reads only the CLI's single JSON line over SSH and drops remote stderr (`installer.js:1490-1509`).

Stores:

- Host path `/docker/n8n-openai-oauth/siwc/codex-images/` (`safety.js:64`; `templates.js:43`). The directory is created 0700 (`codex-images.mjs:93`). Files are written 0600 through a temp file and rename (`codex-images.mjs:134`).
- `session.json`: client ID, full ChatGPT account ID, optional email and plan type, access token, refresh token, access expiry, timestamps and refresh state (`codex-images.mjs:309-314`). The ID token is not stored.
- `pending.json`: device auth ID, user code, poll interval, expiry and next poll time (`codex-images.mjs:399-403`). It is deleted on success, decline, expiry, cancel and sign-out.
- `lock`: PID and creation time (`codex-images.mjs:235`).
- Desktop Relmio keeps an in-memory target (reviewed SSH target, registration ID, container ID, pending flag, 20-minute expiry) and no token (`server.js:5712-5713`).
- Prompts, reference images and generated images are handled per request in memory and not written (`openai-oauth-sidecar.mjs:775-827`).

Transmits:

| Recipient | Data | Code |
| --- | --- | --- |
| `auth.openai.com` (OpenAI), from the VPS | User code request with `{client_id}` only; poll with `{device_auth_id, user_code}`; form exchange with authorization code, code verifier, client ID and redirect URI; JSON refresh with client ID and refresh token; JSON revoke of the refresh token on sign-out. Relmio sets only `content-type` and `accept`; it sends no `originator` or Relmio User-Agent here. | `codex-images.mjs:255-262,316-328,337-339,389,420,462-464` |
| `chatgpt.com/backend-api/codex/images/{generations,edits}` (OpenAI), from the VPS | Bearer Codex access token, `ChatGPT-Account-ID`, optional residency and FedRAMP headers, `originator: relmio`, `User-Agent: Relmio (n8n sidecar)`, a fresh `x-codex-image-turn-id`. Body: prompt, `model: gpt-image-2`, optional quality, size and background; edits add each image as a base64 data URL. `n`, `user`, `response_format`, `output_*` and `input_fidelity` are not forwarded; `mask` is refused. | `openai-oauth-sidecar.mjs:21-23,693-707,773,797-807` |
| n8n on the private Docker network | `{created, data:[{b64_json}]}` plus reported size, quality and background; error bodies with the Codex token, the n8n bearer, the prompt and image base64 redacted. `/v1/models` gains `gpt-image-2` only while signed in. | `openai-oauth-sidecar.mjs:794-795,808-827,887-889` |
| Desktop Relmio process and local browser | State, email, plan type, last six characters of the account ID, user code, verification URL fixed to `https://auth.openai.com/codex/device`, expiry, outcome and revocation result | `codex-images.mjs:194-204`; `server.js:886-907`; `app.js:2026-2052` |
| The user's own browser to `auth.openai.com/codex/device` | The user signs in and enters the code there. Relmio does not see that page. | `index.html:457-459` |

The SIWC text path, its scopes and its recipients are unchanged. Image routes never call the SIWC token source, and `image_generation` stays refused on `/v1/responses` (`openai-oauth-sidecar.mjs:19,775-786,840`; `test/openai-oauth-sidecar-images.test.js:71,315-327`).

Logs: the add-on adds no log lines. The CLI prints one JSON line without tokens, device auth ID, authorization code or verifier (`codex-images.mjs:51-56,517`). The sidecar writes stderr only when it fails to start (`openai-oauth-sidecar.mjs:965`). OpenAI's privacy policy describes its own collection of IP address, user agent, device data and content for these requests.

OAuth scopes: the device flow sends no `scope` (`codex-images.mjs:389`), refresh sends none (`codex-images.mjs:338`), and Relmio does not read a `scope` field from token responses (`codex-images.mjs:296-315`). The scopes OpenAI grants to these tokens are unknown. The images-only limit is enforced by Relmio code. The OAuth grant itself carries no such limit: the stored token is a Codex sign-in for the account. For comparison, Codex's browser flow requests `openid profile email offline_access api.connectors.read api.connectors.invoke` (Provisional, `openai/codex codex-rs/login/src/server.rs:594-610`); the add-on does not use that flow.

Parties that receive data:

- OpenAI at `auth.openai.com` and `chatgpt.com`, and the hosting and content delivery vendors its privacy policy lists.
- The VPS and anyone with root or Docker access there, who can read `session.json`.
- n8n and anyone who can run workflows with the sidecar credential. Those runs spend this account's Codex limits.
- The desktop Relmio process and local browser, which receive status fields only.
- No Relmio-operated service. The add-on's only network targets are the OpenAI URLs above (`codex-images.mjs:16-21`; `openai-oauth-sidecar.mjs:21`).

### Three separate checks

| Check | Sources | Code | Label |
| --- | --- | --- | --- |
| Identity sign-in | The Help Center article describes identity-only sign-in at a participating partner, which releases name, email and profile picture; other permissions are approved separately. | The add-on does not use SIWC. It runs the Codex CLI device flow with Codex's client ID `app_EMoamEEZ73f0CkXaXp7hrann`, so the sign-in page is Codex's. Relmio decodes email, plan type and account ID from the tokens for display. | Confirmed: the article does not describe this flow, and this flow does not match it. |
| Separately approved permission | No fetched source gives a third-party app permission to use Codex image generation. The Codex auth page says device code login (beta) must be enabled in ChatGPT security settings or by a workspace admin, and recommends API keys for automation. The App Server page says local or open-source apps that already use Codex app-server authentication "can continue", recommends migrating to Sign in with ChatGPT, and says app-server authentication "has never been permitted for commercial or hosted services." The SIWC models page says the plan flow must "not point it at ChatGPT's `backend-api` endpoints." SIWC Terms §2 says SIWC "does not grant extra usage or access to other OpenAI services." | Approval consists of the user's Codex device approval and Relmio's two confirmations (`index.html:451-454,466-469`; `installer.js:1527-1528`). The SIWC token never reaches `backend-api`. The add-on is not app-server authentication: it calls Codex's OAuth endpoints directly. [INFERENCE] As a non-SIWC client, it has no per-app limit or Disconnect entry in ChatGPT settings. | Open. No source permits or forbids a third-party client reusing the Codex CLI client ID. The owner's acceptance is not OpenAI permission. |
| Image capability | The Codex image-generation page says built-in Codex image generation uses `gpt-image-2` and counts toward general Codex limits, using them 3 to 5 times faster, and points larger batches to the API. The pricing page says image generation draws credits after included limits, is not available on Free, and lists it for Plus, Pro, Business, Enterprise and API keys (Go is not listed). The GPT-Image-2 page documents `/v1/images/*` for Platform API keys. SIWC preview limitations list image generation as unsupported. | Only `gpt-image-2`, one image, base64 output. The `/v1/models` entry is added by Relmio and is not an OpenAI catalog result. No live image request was made. | Confirmed that OpenAI documents `gpt-image-2` inside first-party Codex clients. Provisional for the `backend-api/codex/images` route and wire format. Open for whether it works for a given account, plan, region or client. |

### Terms and privacy

- Confirmed: the Codex Help article says the ChatGPT Terms of Use and Privacy Policy apply when someone signs in to Codex with a ChatGPT account.
- Open: the Terms of Use and EU Terms forbid sharing account credentials or making an account available to anyone else, automatically or programmatically extracting data or Output, and circumventing rate limits. They also require compliance with the documentation and guidelines OpenAI makes available. This review cannot resolve how those clauses apply to n8n automation through a ChatGPT login on an undocumented route.
- Observed: the code does not retry 429 or 5xx, refuses `n` above 1, and passes 429 through with its reset time (`openai-oauth-sidecar.mjs:699,808-818`). This avoids retry loops. It is not evidence of compliance.
- Observed: Service Terms §6 forbids using images to identify a person or reproduce a likeness without consent. Edits send reference images, and the wizard does not mention this.
- Open: SIWC Terms §1 says to use the app's own name and not impersonate another application. The add-on is outside SIWC. It identifies as `originator: relmio` on image requests but authenticates as the Codex CLI's OAuth client.
- Open: the privacy policy covers prompts and uploaded images as content, plus log, usage and device data, and allows training use unless the user opts out. The Codex Help article says Plus and Pro Codex content may be used to improve models unless training is turned off. The image body has no `store` field, and retention for this route is not documented.

### Mismatches and resolution

The review ran while docs and code were still changing. Same-day resolution:

1. README, FAQ and security docs now describe the add-on, its storage under
   `siwc/codex-images`, who can read it, revocation and the unsupported SIWC
   image path. Resolved.
2. The wizard disclosure now says OpenAI recommends an API key for automation,
   that images use Codex limits 3 to 5 times faster and then credits, that Free
   plans can't use it, that device code sign-in must be on in ChatGPT security
   settings, that root or Docker users on the server can read the stored
   sign-in, and to use the same account as the sidecar. The pending code shows
   "Only enter this code at auth.openai.com. Never share it." A 404 from the
   user-code request reports that device code sign-in is off. Resolved. The
   likeness rule in Service Terms §6 and OpenAI's handling of prompts and
   reference images are covered by OpenAI's own terms, not repeated in the
   wizard.
3. The `images_off` error now says the feature needs a separate Codex sign-in
   that OpenAI doesn't document for other apps, and that it is turned on from a
   VPS sidecar. Resolved.
4. The image User-Agent is `Relmio (n8n sidecar)`. It carries no release
   version, because pinning one would change the sidecar image digest every
   release. Accepted deviation.
5. The image account is not compared with the SIWC registration's account. The
   wizard shows the signed-in email and asks for the same account. Open.

### Unknowns

- Whether OpenAI permits a third-party open-source tool to use the Codex CLI client ID and device flow, and whether the App Server page's "can continue" wording covers a feature added today.
- Whether a user's self-hosted VPS counts as a "hosted service" under that page.
- The scopes and lifetimes of device-flow tokens, and whether the stored token works beyond images.
- Whether the image route accepts `originator: relmio`, needs the residency header outside the US, or works for Go, Business, Enterprise or FedRAMP accounts.
- Server-side image limits, credit use through this route, and whether usage appears in workspace Compliance API logs.
- Retention and training treatment of prompts and images on this route.
- Whether revoking this refresh token affects the user's other Codex sessions, and what a disabled device-code setting returns.
- How the Terms clauses on programmatic extraction and account availability apply to user-configured n8n workflows.

This review is not legal advice, Terms-compliance proof, OpenAI approval, permission to use a Codex credential bridge, or evidence that `gpt-image-2` or any image request works for any account.

## Addendum: automatic model discovery

Review date: 2026-10-06.

Compared the amended discovery module, sidecar, installer, command allowlist, web routes and wizard with the binding model-discovery contract and its final review amendments. Re-read the final code and README, security, FAQ and related setup disclosures after the consent and wording fixes landed. File references describe that working-tree snapshot.

Nothing here is OpenAI approval, permission to use a Codex credential bridge, or proof of Terms compliance. This is a source review, not legal advice or a runtime capability test. No files were edited. No login, credential access, provider API call, form submission, SSH, Docker command, browser QA, build or test was performed.

Labels: **Confirmed** means stated by an official OpenAI source fetched today; **Observed** means present in Relmio source; **Provisional** identifies non-OpenAI evidence, including n8n's versioned documentation and supplied owner observations; **Open** means the reviewed evidence does not settle the question. Unexercised consequences are marked **[INFERENCE]**.

### Sources

All fetched on 2026-10-06. The identity Help Center article was fetched first. Developer pages were served through their Markdown versions and showed no publication or update date.

| Source | Displayed date / retrieval note |
| --- | --- |
| [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Updated: 4 days ago; fetched first |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Updated: 13 hours ago |
| [Token-sharing overview](https://developers.openai.com/siwc/token-sharing-open-source) | None |
| [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | None |
| [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | None |
| [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | None |
| [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | None |
| [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) | None |
| [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) | None |
| [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | September 29, 2026 |
| [Service Terms, English-GB](https://openai.com/en-GB/policies/service-terms/) | Updated: 29 September 2026. Retrieved successfully; the [unlocalized URL](https://openai.com/policies/service-terms/) and its no-trailing-slash form returned 403 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) | Published and effective: January 1, 2026 |
| [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Updated: January 16, 2026; relevant sections fetched and searched |
| [Usage policies](https://openai.com/policies/usage-policies/) | Effective: October 29, 2025 |
| [Privacy policy](https://openai.com/policies/privacy-policy/) and its [canonical page](https://openai.com/policies/services-communications-privacy-policy/) | Updated: July 30, 2026; both retrieved |
| [Europe privacy policy](https://openai.com/policies/eu-privacy-policy/) | Updated: August 24, 2026; relevant sections fetched and searched |
| [SIWC partner directory](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) | None |
| [Codex image generation](https://learn.chatgpt.com/docs/image-generation) | None |
| [GPT-Image-2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) and [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) | No page update date; each default snapshot ends in `2026-09-08` |

The following sources are **Provisional for OpenAI policy**. They are n8n's own sources, not OpenAI permission to use the sidecar:

| Source | Displayed date / version |
| --- | --- |
| [n8n 2.40.7 release](https://github.com/n8n-io/n8n/releases/tag/n8n%402.40.7) | 2026-09-25; commit `09b3ce6f9889c889e13cf3747f6f6c68eebdeeb6` |
| [Instance AI configuration at 2.40.7](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.40.7/packages/@n8n/instance-ai/docs/configuration.md) | No document update date; pinned to the owner's version |
| [Current Assistant setup guide](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant) | None; unversioned. The requested `set-up-ai-assistant` URL redirected here |
| 2.40.7 [model catalog service](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.40.7/packages/cli/src/modules/instance-ai/instance-ai-model-catalog.service.ts), [custom model selector](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.40.7/packages/frontend/editor-ui/src/features/ai/instanceAi/instanceAiModelCatalog.ts), [provider choices](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.40.7/packages/frontend/editor-ui/src/features/ai/instanceAi/instanceAiConnection.constants.ts) and [onboarding UI](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.40.7/packages/frontend/editor-ui/src/features/ai/instanceAi/onboarding/InstanceAiOnboardingWizard.vue) | No displayed update dates |
| 2.40.7 [catalog fetch](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.40.7/packages/@n8n/agents/src/sdk/catalog.ts), [model transport](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.40.7/packages/@n8n/agents/src/runtime/model/model-factory.ts) and [resource-locator cache](https://raw.githubusercontent.com/n8n-io/n8n/n8n%402.40.7/packages/frontend/editor-ui/src/features/ndv/parameters/components/ResourceLocator/ResourceLocator.vue) | No displayed update dates |

### What discovery reads, stores, transmits and logs

The following are **Observed** source behavior, not claims about a deployed installation.

#### Reads

- The selected registration's access-token lease, through the existing SIWC session service. That service reads the registration, runtime ownership, granted scopes, enabled-plan state and token expiry; it can refresh the session. Discovery does not import the user's personal Codex credentials. See `src/gateway/openai-oauth-sidecar.mjs:869-874`, `src/services/model-discovery.mjs:449-453,709-712` and `src/services/siwc-session.mjs:729-768`.
- The account catalog's `models` array: `slug`, `display_name`, `visibility`, `supported_in_api` and `supported_reasoning_levels`. Relmio retains valid, unique, visible slugs, excludes IDs containing `image`, excludes explicit `supported_in_api:false`, preserves order and caps the catalog at 256 entries. Labels and known reasoning levels are retained in memory. See `src/services/model-discovery.mjs:299-319`.
- The new per-registration model-check record and the npm response's `version` field. Stable numeric versions only are accepted; the selected catalog version is never below `CODEX_CLI_VERSION = "0.160.0"`. See `src/services/model-discovery.mjs:14-24,337-353,387-407,457-476`.
- Terminal events and model-level errors from probes, plus completion/rejection outcomes from ordinary sidecar traffic. Passive learning accepts only IDs in that discovery instance's last loaded catalog and runs with checks on or off. See `src/services/model-discovery.mjs:253-296,325-335,516-541,639-647`; `src/gateway/openai-oauth-sidecar.mjs:255-256,490-491,614-615,915-923`.
- The optional image add-on's local sign-in status when a model-list request lacks `openai-platform`. This does not call an image-generation endpoint. See `src/gateway/openai-oauth-sidecar.mjs:850-867` and `src/services/codex-images.mjs:378-382`.

#### Stores

The new file is `${storageRoot}/model-checks/${registrationId}.json`. On the VPS it is under `/docker/n8n-openai-oauth/siwc/model-checks/`, mounted into the sidecar at `/home/node/.relmio-siwc/model-checks/`. See `src/services/model-discovery.mjs:369-397`, `src/domain/safety.js:64` and `src/domain/templates.js:18,38-43`.

| Stored field | Meaning |
| --- | --- |
| `schemaVersion`, `registrationId` | Schema version 1 and registration binding |
| `checksEnabled` | Stored opt-in flag |
| `consent` | `{ acceptedAt, noticeVersion }`, or `null`; current notice is `model-checks-2026-10-06` |
| `updatedAt` | Record-write timestamp |
| `models[id]` | Model ID as key; value has `state` (`verified` or `failed`), `checkedAt`, `source` (`probe` or `traffic`) and optional `code` |
| `codexRelease` | Optional `{ version?, checkedAt }`; remembers the npm check, including a failed attempt without a newly obtained version |

The schema and serialization are at `src/services/model-discovery.mjs:91-97,387-419,463-476,589-592,639-647,665-681`. The file contains no intentional token, prompt, response-body or model-output storage. Display labels, the catalog body and background cooldown are not persisted there. Oldest model records can be removed to fit 256 entries and 64 KiB.

The directory is created with mode `0700`, files with `0600`. Ownership, type, symlink and hard-link checks protect reads; writes use an exclusive temporary file, fsync, rename and a per-registration lock. The lock holds PID and creation time. See `src/services/model-discovery.mjs:132-232,369-384,423-439`.

Turning checks off writes `checksEnabled:false` and `consent:null` without a network call. Normal records retain model results and `codexRelease`; an explicitly disabled, corrupt-but-safely-owned file may be replaced. Unsafe files still fail. See `src/services/model-discovery.mjs:423-439,665-672`.

Existing OAuth storage is unchanged: `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth`, with `registrations/<registrationId>.json` containing the verified identity, issued client ID, owner, granted scopes and access/refresh/retained ID tokens. See `src/services/siwc-session.mjs:59-69,545-565,567-590`.

#### Transmits and recipients

| Recipient | Data and conditions | Code |
| --- | --- | --- |
| `registry.npmjs.org` | Credential-free `GET /@openai/codex/latest`, with `Accept: application/json`. No OpenAI token, registration ID, account data or prompt is added. npm receives the host's network/request metadata. Lookup happens on demand about every 12 hours, with the check shared through the store when writable; concurrent processes can occasionally both check. Failed attempts count toward the cache interval. No package is installed or executed by this lookup. | `src/services/model-discovery.mjs:22,337-353,457-476` |
| `api.openai.com` catalog | `GET /v1/models?client_version=<resolved version>` with the selected SIWC bearer and JSON Accept header. It can run with checks off. Redirects are refused; the catalog has a 20-second request timeout, a 4 MiB body cap and a five-minute in-memory cache. On other catalog failures a list younger than one hour may be served; lease errors and a catalog 401 do not use stale fallback. | `src/services/model-discovery.mjs:26,36,478-511` |
| `api.openai.com` probes | `POST /v1/responses` with a fresh SIWC lease for each probe, model ID, `instructions:"Reply with OK."`, user input `OK`, `stream:true`, `store:false` and the lowest recognized advertised reasoning effort when present. No workflow prompt, tools, images or `background` field is included. | `src/services/model-discovery.mjs:516-541,563-592` |
| `auth.openai.com`, when a lease needs renewal | Existing discovery/JWKS calls and refresh exchange. Refresh sends the issued client ID, refresh token and `resource=https://api.openai.com/v1`; no new scope is requested. | `src/services/siwc-session.mjs:619-646,729-768` |
| n8n / another holder of the private Relmio bearer | The filtered OpenAI-compatible model list and ordinary inference responses. Provider credentials are not returned. Model discovery adds no new inference destination to normal traffic. | `src/gateway/openai-oauth-sidecar.mjs:99-104,850-918` |
| Local Relmio process and local browser | Over the reviewed SSH connection: a bounded, validated status view with up to 64 model rows, IDs, labels, state, `listed`, optional check times, catalog version/time, optional catalog error and last-run counts/reason. No provider token or raw remote error is deliberately returned. Copy ID sends only that ID to the OS clipboard. | `src/services/installer.js:1588-1668`; `src/web/server.js:923-958,5773-5812`; `src/ui/app.js:2193-2247` |
| Selected runtime's filesystem and administrators | SIWC credentials and new model-check metadata remain accessible to the runtime owner and administrators with sufficient host/root/Docker access. The browser receives the sanitized view, not these files. | `src/domain/templates.js:18,38-43`; `src/services/model-discovery.mjs:369-439`; `src/services/siwc-session.mjs:59-69` |

No Relmio-operated service is a destination in the new discovery code. The separate existing image routes still use `chatgpt.com/backend-api/codex`; discovery does not send its SIWC token there (`src/gateway/openai-oauth-sidecar.mjs:21,802-829,850-874`). OpenAI's privacy policies identify further recipient categories, including service providers, affiliates and applicable account administrators. Actual hosting, backup and log recipients were not inspected.

#### Logs

Discovery adds no request, prompt, response or credential log calls. Its CLI writes one status/error JSON line to stdout; the installer validates that output and substitutes fixed local error messages. The existing sidecar startup failure still writes a fixed stderr message. See `src/services/model-discovery.mjs:693-727`, `src/services/installer.js:1575-1634` and `src/gateway/openai-oauth-sidecar.mjs:995`.

This does not mean nothing is retained: model outcomes and times are stored as described above. OpenAI and npm can retain their own request metadata. If the owner later uses n8n Assistant, n8n 2.40.7 documents raw output storage, database-backed conversation/history/checkpoint/event records and optional LangSmith export. Its workflow/node parameter values are included by default. Those are separate n8n data paths, not discovery logs; see the versioned configuration at lines 24, 33-39, 152-170 and 205-229.

OAuth scopes remain `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1` (`src/services/oauth.js:10-11,204-210`). The new checkbox adds a local, versioned approval; it does not add an OAuth scope or extend OpenAI's grant.

### Three separate checks

#### 1. Identity sign-in

**Confirmed:** The Help Center identity flow releases basic identity information and requires additional permissions to be approved separately. Identity sign-in does not independently release ChatGPT conversations, memory, files, tokens or billing data. The OSS token-sharing guide separately documents issued client IDs, verified ID tokens, token storage and the plan-use grant.

**Observed:** Discovery changes no sign-in scopes or identity validation. Relmio uses its own `agent_name_hint=Relmio`, the issued client ID, PKCE/state/nonce and the existing verified identity/session code (`src/services/oauth.js:114-160,204-210`; `src/services/siwc-session.mjs:630-655`). The complete Relmio flow includes stored renewable OAuth credentials and plan-funded inference, so the Help Center's identity-only description is not a complete description of it.

**Open:** Successful identity sign-in would establish neither permission for n8n/Assistant use nor access to a particular model. Relmio and n8n are absent from the fetched partner directory; that absence supplies neither approval nor proof of prohibition.

#### 2. Separately approved permissions

**Confirmed:** SIWC Terms §2 requires requests to arise from the authenticated user's activity or expressly authorized automation/background processes. It requires express consent before background use, restricts use to the connected application and forbids general-purpose API access for other tools. Another user's activity must not trigger requests against the authenticated user's account. Service Terms §15 incorporates the SIWC Terms; ordinary Terms of Use and Usage Policies still apply.

**Observed: three approvals remain distinct.**

1. OpenAI plan permission is checked from granted scopes together with enabled-plan and runtime-ownership state before the session service provides a usable lease (`src/services/siwc-session.mjs:729-750`).
2. Existing n8n background-workflow approval is validated separately during installation (`src/services/installer.js:459-470`; `src/services/siwc-session.mjs:255-273`; `src/ui/index.html:814-816`).
3. Model checks are off by default. The wizard requires its separate checkbox and confirmation, binds the action to a reviewed registration/container and an expiring target, and the installer rechecks ownership under the operation lock (`src/ui/index.html:484-497`; `src/ui/app.js:2184-2188,2238-2268`; `src/web/server.js:876-885,5773-5812`; `src/services/installer.js:1648-1668`).

The initial confirmed action probes up to 12 due models, one at a time, before saving enabled state and the notice-version consent. That run has a 180-second CLI budget, including time reserved for saving. Subsequent `/v1/models` calls can start one in-process background run of up to eight models, five seconds apart. Both `checksEnabled` and the current notice must match. Consent is re-read before obtaining the lease and again immediately before sending each probe. Turning checks off does not cancel an already-sent request, but stops subsequent probes. Sign-out attempts to disable checks before stopping the sidecar, as a best effort. See `src/services/model-discovery.mjs:31-34,106-107,547-596,621-635,665-690` and `src/services/installer.js:1420-1425`.

A stopped or incomplete background run pauses further background runs in that process for 60 minutes. Model-level failures become eligible again after 24 hours. Successful records are not periodically re-probed; ordinary traffic can replace an outcome. These are on-demand checks, not a timer that runs while the sidecar is idle. Restarting the process clears the in-memory cooldown, and there is no cross-process probe-run lock (`src/services/model-discovery.mjs:99-115,621-647`).

**Confirmed distinction:** The unsupported Responses `background` request field is not the same as a background process under Terms §2. Probes omit that field and use ordinary streaming Responses requests; their unattended scheduling still needs express consent.

**Open:** These controls support explicit user authorization but do not settle whether an OpenAI-compatible sidecar for n8n, especially a second feature such as Assistant, fits “connected application only” and “no general-purpose API access.” A private Docker address and local bearer do not resolve that question. The Assistant warning now limits the suggested experiment to an n8n instance nobody else uses (`src/ui/index.html:499`; `README.md:332-338`). This is a warning, not per-user provider authorization enforced by the sidecar.

**Open, unchanged:** SIWC Terms §1 says persistent Authentication Token storage must be local and under the user's control, not remote or managed. The self-hosted VM guide describes protected credential transfer to a VM. The fetched sources do not resolve that tension for this VPS design.

#### 3. Model and feature capability

**Confirmed:** OpenAI documents the selected account's catalog and requires `store:false`, `stream:true` and a terminal `response.completed` before counting inference as successful. The app-server guide says a catalog is not an entitlement check and limits completed-inference evidence to the selected model **for that request**. Pretesting every listed model is Relmio's optional policy, not an OpenAI requirement or certification.

**Observed:** Probes record verification only on `response.completed` with no contradictory response status. Passive learning also waits for upstream completion. It does not prove that every client-side translation or Assistant feature succeeds. “Ready” is a remembered completion, not a live entitlement test, and the code does not require the returned text literally to equal `OK` (`src/services/model-discovery.mjs:253-263,599-611,639-647`; `src/gateway/openai-oauth-sidecar.mjs:490-500,614-624`).

With checks off, eligible catalog entries are listed without a probe. With checks on, verified entries are listed; if there are none yet, the bootstrap fallback lists entries not hidden by a recent failure. Probe failures hide models only with checks on; traffic model failures hide them in either mode, for 24 hours. Thus “only after a completed inference” has an explicit bootstrap exception. The final wizard notice now states it (`src/services/model-discovery.mjs:99-115`; `src/ui/index.html:485`).

**Open: `client_version`.** None of the fetched SIWC catalog pages documents this query parameter, its gating rule, `supported_in_api` or `supported_reasoning_levels`. Relmio obtains a stable npm release and sends `max(pin,last-known-release)` as the catalog version. It does not upgrade executable code. Local Codex installs and `listSiwcModels` still use 0.160.0; the n8n text sidecar itself sends HTTP requests directly. See `src/services/model-discovery.mjs:14,337-353,463-493`, `src/gateway/openai-oauth-sidecar.mjs:909-912,926-941` and `src/domain/local-endpoints.js:398-424`.

Sending a newer catalog version can expose choices the unchanged client has not exercised. A minimal completed probe reduces uncertainty about that one request; it does not prove support for new request shapes, tools, reasoning behavior or every Assistant action. No fetched OpenAI source approves this version-selection strategy or establishes that a greater version value grants entitlement.

**Provisional, owner-supplied observations:** On 2026-10-06 the owner's SIWC catalog listed three visible models at 0.150.0, seven at 0.160.0/0.160.1/0.999.0 and four without the parameter. The Codex catalog contained no image models. Three image requests using `gpt-image-2`, Flare and a made-up ID produced the same reported 515 image tokens, 1254×1254 dimensions and C2PA provenance. These observations were supplied for this review and were not rerun. They support keeping the sidecar's image listing at `gpt-image-2`; they are not a published API contract or proof of Flare/Sunburst selection.

**Observed:** `gpt-image-2` remains a manually appended, separate-sign-in entry, omitted when the request has `openai-platform`; it is not discovered or verified by these text probes (`src/gateway/openai-oauth-sidecar.mjs:850-867`). **Confirmed:** SIWC preview limitations exclude image generation, while first-party Codex documentation names `gpt-image-2` and the Flare/Sunburst API pages document Image API support. Selecting those API models requires the separate Platform-key route described in the n8n guide, not relabeling the Codex add-on. Nothing here authorizes that credential bridge or establishes TTS access; the sidecar exposes no speech route (`src/gateway/openai-oauth-sidecar.mjs:882-884`).

**Provisional: n8n 2.40.7 Assistant.** Its pinned configuration supports a custom base URL and model ID. The custom selector returns no options and uses a text input; built-in-provider choices come from n8n's models.dev-backed catalog, not the sidecar's `/v1/models`. Copyable IDs are therefore appropriate; changing the sidecar list cannot populate the Assistant field. Setting a model connection alone does not complete member setup: n8n also requires sandbox configuration and search configuration or an explicit skip. The live Assistant test remains unperformed. The final UI and docs now say so plainly and retain the open SIWC Terms question (`src/ui/index.html:499`; `docs/ai-assistant.md:247-273`).

### Mismatches, resolutions and limits

- **Resolved, Observed:** The initial code lacked versioned consent and could continue a probe run after checks were disabled. The final module requires the current notice, makes checks-off network-free, and rechecks consent after a potentially slow lease before sending (`src/services/model-discovery.mjs:106-107,563-587,665-672`). This review did not exercise the fix.
- **Resolved, Observed:** The original “only after it answers” notice omitted the bootstrap fallback. The final notice includes the full-catalog exception and recent-failure exclusion. It now also mentions an hour-before-retry for unanswered checks and uses “about every 12 hours” for npm (`src/ui/index.html:482-485`). Detailed docs explain that later n8n list requests trigger background work.
- **Resolved, Observed:** Pause messages no longer equate temporary usage unavailability with an exhausted plan, or every lease failure with a busy session (`src/ui/app.js:2151-2156`). The Assistant copy no longer implies partial live testing and warns against shared-user use (`src/ui/index.html:499`).
- **Accepted limit, Observed:** The npm interval is a best-effort shared cache, not a hard installation-wide rate limit. The fetch precedes the locked metadata update, which may be skipped on a busy/unsafe store. Concurrent processes can both check. Repeated enabling can also overlap a background probe run. Do not describe either as an exactly-once guarantee (`src/services/model-discovery.mjs:337-353,463-476,627-632`).
- **Resolved same day, Observed:** The status operation could persist `codexRelease`. After the boundary audit, status makes no npm request and writes nothing to the record; it uses the last stored version or the pin. Reading the catalog can still refresh the SIWC token, as any sidecar request can. It does not start probes or change the opt-in flag (`docs/security.md:532-537`). Shutdown now also stops a background check run (`close()` on SIGTERM and SIGINT).
- **Source/code diagnostic difference, Observed:** OpenAI's recovery guide asks integrations to preserve HTTP status, error shape/code and request ID. Probe status deliberately collapses failures into fixed stop categories and optional model-error codes; it does not retain raw errors or request IDs. The 60-minute pause is Relmio backoff, not evidence of OpenAI's reset time (`src/services/model-discovery.mjs:253-263,516-541,599-611`).
- **Open classification limit:** A probe's parameter-less `subscription_sharing_unsupported_capability` is treated as model rejection. OpenAI says that code can concern an input, tool, feature, model or service-tier override; it does not guarantee the parameter-less case names the model. The probe sends instructions/input and sometimes reasoning. Treat its failure as evidence about that probe, not a definitive entitlement judgment (`src/services/model-discovery.mjs:325-335,516-540`).
- **Provisional documentation difference:** The current unversioned n8n setup guide says to include `instance-ai` in `N8N_ENABLED_MODULES` in its Daytona example. The exact 2.40.7 configuration says the module is already enabled by default. Use the pinned version's configuration when describing the owner's installation; this review changed no n8n settings.

### Unknowns

- Whether OpenAI accepts this exact automatic-probe/version-selection strategy and the n8n sidecar/Assistant architecture under SIWC Terms §§1-2. User consent does not answer those provider-permission questions.
- Future `client_version` semantics and compatibility between newly exposed models and Relmio's unchanged request translator.
- Account/workspace eligibility, future availability, tool behavior, Assistant interoperability and TTS capability. Catalogs and historical completions do not establish these.
- Exact probe cost. The prompt is short, but there is no output-token or monetary cap; SIWC documents `max_output_tokens` as unsupported. Plan usage and separately enabled ChatGPT credits can be consumed.
- SIWC-specific retention/training treatment and actual deployment logs, backups, tracing and optional n8n tool recipients. `store:false` is required request behavior, not a zero-retention promise. The privacy policies' general provisions and business/API-content carve-out do not settle treatment merely because the hostname is `api.openai.com`.

Identity sign-in, approved plan/background/model-check permissions and model capability remain separate. None of these findings supplies OpenAI approval or establishes Terms compliance.

## Unknowns

- Which plans are eligible is unclear while the Help Center and Quickstart
  disagree. Eligibility for an untested account or model is unverified.
- Still open from earlier checks: Relmio is not in the partner directory;
  persistent VPS token storage against SIWC Terms §1 and the n8n endpoint
  against §2 are unresolved; refresh-503 rotation, `earliest_refresh_at`, the
  undocumented `client_version`, provider log retention and per-account
  capability are not documented. `store: false` does not prove zero retention.

This review is not legal advice, Terms-compliance proof, OpenAI approval or
evidence of model or TTS access.
