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
