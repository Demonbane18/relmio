# OAuth callback-port source check

Review date: 2026-09-26

This review covers Relmio 0.17.5. Before the official Codex browser login for
an OpenAI OAuth bridge, the wizard probes both `127.0.0.1:1455` and `[::1]:1455`
to see whether a TCP connection is accepted. The probe does not identify the
listener or establish that it can receive the browser callback. The release
also adds troubleshooting guidance for the reported sign-in page and MCP
`Transport closed` errors. This is a local reliability change. It is not a
legal opinion and does not establish account entitlement.

## Current official sources

- [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)
- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)

The Help Center article and Codex authentication page were retrieved directly
on the review date. In the initial retrieval, the three policy pages returned
HTTP 403 to command-line retrieval and were not re-read; the then-most-recent
recorded review was dated 2026-09-21. A dated follow-up below records successful
policy retrieval later on 2026-09-26. The original 403 result is retained here
as historical context, not a current access limitation.

## Findings

The Sign in with ChatGPT article describes identity sign-in for supported
external applications. The application receives name, email address, and
profile picture, and any additional access needs a separate permission
request. That identity-only description does not match or authorize Relmio's
third-party ChatGPT/Codex compatibility transport. This release does not
change that assessment.

The Codex authentication page says that `codex login` opens a browser, which
then returns credentials to Codex. It names the default local callback server
as `localhost:1455`. It lists "your local networking configuration blocks the
localhost callback" as a case where the browser flow may not work. It also
documents `cli_auth_credentials_store = "file"`, which writes `auth.json` under
`CODEX_HOME`. Admins can enforce that setting so that users cannot override
it. Relmio's preflight matches this documented callback design and does not
change the login command, its arguments, or its credential store.

## Relmio data flow for this release

- **Reads:** unchanged. The new preflight opens a TCP connection to
  `127.0.0.1:1455` and `[::1]:1455` on the user's own computer, sends no bytes,
  and closes it at once. It reads only whether a connection was accepted.
- **Stores:** unchanged. The preflight stores nothing. If a listener is found,
  Relmio does not create the pending sign-in directory.
- **Transmits:** unchanged. The preflight never leaves the loopback interface.
  The official Codex login still sends the browser sign-in to OpenAI. Relmio
  still seeds the resulting credential only into its owned bridge volume or,
  for VPS bridges, uploads it after explicit confirmation.
- **Logs:** unchanged. The wizard shows a fixed message that names port `1455`.
  Relmio does not log the other process's identity, prompts, or tokens.
- **OAuth scopes and permissions:** Relmio does not supply an explicit OAuth
  scope list or inspect the grant. The pinned Codex CLI's requested and granted
  scopes remain unknown. This callback-port change adds no known permission.
- **Recipients:** unchanged. OpenAI receives the browser sign-in. The user's
  own n8n bridge receives the resulting credential.

## Unknowns and limits

- Whether OpenAI permits this exact compatibility transport for the account
  and use case remains unresolved.
- In the initial retrieval, the Terms, Services Agreement, and Privacy Policy
  returned HTTP 403 to command-line retrieval and were not re-read. The
  successful follow-up retrieval later on 2026-09-26 is recorded below; the
  initial 403 remains historical context.
- If an admin enforces a non-file `cli_auth_credentials_store`, the file-based
  login that Relmio requests may be overridden. This release does not change
  or detect that behavior.
- A listener that starts after the preflight could interfere with the callback,
  but the preflight does not establish which process received a browser
  callback. The pinned Codex source and attribution limits are recorded in the
  2026-09-26 follow-up below.

## Follow-up — 2026-09-26

### Pinned Codex callback behavior

The pinned `@openai/codex@0.154.0` source was reviewed at immutable commit
[`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/login/src/server.rs).
It defines port `1455` as the default and `1457` as a registered fallback,
binds the callback server to IPv4 loopback, and constructs the browser callback
URL from the port actually bound. On a collision at the default port, the CLI
may send a local `GET /cancel`, retry binding, and use the fallback. Therefore
a listener at `1455` does not by itself prove that Codex failed to bind or that
the listener received a callback.

The wording “Signed in to ChatGPT” / “This sign-in request expired” does not
identify its originating application or prove callback delivery to another
process. A competing localhost listener is a plausible interference path, not
an observed cause in the reported case. No screenshot or callback receipt was
independently observed in this source review. Do not share callback query
strings, authorization codes, `state` values, tokens, or full authentication
URLs when seeking help.

### Successful policy retrieval

Later on 2026-09-26, the following official pages were retrieved successfully;
this updates the initial retrieval limitation above without erasing its
historical 403 result:

- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) (canonical
  ROW Terms, published and effective 2026-01-01): restrictions include
  credential sharing, programmatic extraction, circumvention, and bypassing
  safeguards.
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)
  (updated 2025-12-01; effective 2026-01-01): covers specified business and
  developer services, but does not expressly approve this third-party
  subscription-credential bridge.
- [Privacy Policy](https://openai.com/policies/privacy-policy/) (updated
  2026-07-30; retrieval returned the canonical
  [services communications privacy policy](https://openai.com/policies/services-communications-privacy-policy/)):
  describes account/content/log data and listed recipient categories. This
  source review does not establish which parties received a particular user's
  data.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) documents the
  host CLI's browser login and credential file behavior; it does not provide
  approval for Relmio's n8n-compatible transport.

The identity article's supported-app identity sign-in is distinct from the
host Codex CLI credential flow. Relmio's explicit confirmation is permission
for its same-owner deployment copy, not a provider-delegated grant. The
requested/granted scopes, account entitlement, and permission for this exact
compatibility use remain unknown. This follow-up and the callback reliability
changes do not establish OpenAI approval or broaden any scope.

Public social statements and private maintainer correspondence mentioned in
`docs/security.md` were not used as permission evidence in this follow-up. They
do not establish account-specific scopes, entitlement, or permission for this
bridge.

### Capability and authentication separation

Also retrieved on 2026-09-26:

- [Codex models](https://learn.chatgpt.com/docs/models): availability depends
  on rollout, sign-in method, client, plan, and workspace settings. Selecting
  a model does not grant access. This review did not establish any particular
  account's model entitlement or prove a TTS capability.
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication):
  the documented API credentials are API keys or short-lived workload-identity
  tokens. This is distinct from Codex subscription sign-in and is not approval
  to repurpose a Codex credential as a general API credential.

The accompanying managed local-model flow uses a private Ollama runtime and
the reviewed Qwen catalog, not an OpenAI credential or an OpenAI-hosted model.
It adds no OpenAI OAuth scope or cloud fallback. Its inference readiness does
not establish n8n tool reliability, AI Assistant eligibility, or TTS support.
The separate [local-model data-flow and capability limits](./local-models.md)
describe registry downloads, unauthenticated trusted-network access, model
cache retention, and n8n/host logging.

## Follow-up — SSH agent and model-only sudo — 2026-09-26

This is a dated source/data-flow review of the cloud-host access continuation,
not a release certification or legal opinion. The source reviewer inspected
the previous SSH implementation and the new shared contract while integration
was in progress. Subsequent implementation-owner handoffs describe the new
transport and model-only scope. Integration verification on 2026-09-26 passed
1,216 root tests with 16 platform skips and 73 web tests. Actual browser
scenarios against injected remote services rejected credential routes on a
model-only session and rejected stale cross-tab identities. A separate real
loopback SSH handshake verified agent signatures and host-key rejection,
with administrative probe responses explicitly emulated. These checks do
not establish live VPS sudo, native Windows agent, Linux Docker or provider
deployment success, and do not certify provider permission or Terms compliance.

### Current official sources and distinctions

The reviewer retrieved the following first-party sources on 2026-09-26:

- [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
  (displayed “Updated: 2 days ago”): participating-app identity sign-in shares
  name, email and profile picture; it does not independently share files or
  tokens. Additional access needs separate user authorization, even where an
  organization has approved the application.
- [Codex authentication](https://developers.openai.com/codex/auth/), resolving
  to [the current authentication guide](https://learn.chatgpt.com/docs/auth):
  documents browser credentials returning to Codex, file/keyring storage,
  `CODEX_HOME/auth.json`, administrator settings and trusted headless-machine
  or container credential-cache copying. That documented Codex pattern is
  not blanket approval for a third-party n8n-compatible credential bridge.
- [Codex models](https://developers.openai.com/codex/models/), resolving to
  [the current model guide](https://learn.chatgpt.com/docs/models): account,
  client, rollout, plan and workspace controls determine availability.
- [API authentication](https://developers.openai.com/api/reference/overview#authentication)
  documents API keys or short-lived workload-identity tokens, not a grant to
  turn a Codex subscription credential into a general OpenAI API credential.
- [Text-to-speech](https://developers.openai.com/api/docs/guides/text-to-speech)
  documents a separate Audio API capability and AI-generated-voice disclosure.
  It does not establish TTS support through this bridge.
- [Terms of Use](https://openai.com/policies/terms-of-use/), canonical
  [ROW terms](https://openai.com/policies/row-terms-of-use/) (published/effective
  2026-01-01), and [Services Agreement](https://openai.com/policies/services-agreement/)
  (updated 2025-12-01, effective 2026-01-01): account/credential restrictions,
  documented-use requirements and anti-circumvention provisions remain
  applicable as determined by the user's region, account and agreement.
  Neither page expressly approves this exact third-party subscription bridge.
- [Service Terms](https://openai.com/policies/service-terms/) (updated
  2026-09-21): documented API use, Codex/code-generation and ChatGPT Voice
  Output are distinct subjects, not interchangeable grants.
- [Privacy Policy](https://openai.com/policies/privacy-policy/), returning the
  [services communications privacy policy](https://openai.com/policies/services-communications-privacy-policy/)
  (updated 2026-07-30): describes account/content/log/usage data and recipient
  categories. Business-service data can instead be governed by customer
  agreements. This does not identify a particular user's actual downstream
  recipients, retention or training settings.

**Identity, delegated permission and model/TTS capability are three different
checks.** Relmio obtains a Codex credential file and copies its complete
validated JSON for the user's private bridge; that does not match the identity
article's identity-only data release. A successful login, local install
confirmation or SSH-agent connection is not OpenAI permission for this use.
The bridge remains unofficial, private and policy-uncertain. Its audio routes
remain unsupported; local Ollama readiness does not establish provider
entitlement, Assistant capability or reliable tool calling.

### Reads, stores, transmits and logs

- **SSH authentication:** the local browser/Relmio process handles host, port,
  username, confirmed host fingerprint and the explicitly chosen password or
  agent method. The local SSH library requests public identities and signatures
  from the supported local agent; the private key remains in its agent/key
  store. Authentication public-key/signature data still travels to the remote
  SSH server. This is not a claim that “no authentication data is transmitted.”
  No browser private-key/passphrase input, key-file reading or agent forwarding
  belongs to the new transport contract.
- **Session/capability state:** Relmio holds the authenticated connection and
  safe identity in process memory. Capability status reports only safe
  configured/untested/unavailable information, not socket paths or browser key
  lists. Clearing the browser password/request field is not proof that every
  internal library copy is immediately erased from memory.
- **Existing credential flow:** the pinned Codex CLI uses a protected pending
  file store and Relmio validates access/ID/refresh-token fields before
  promoting the complete JSON to `~/.n8n-openai-oauth/auth.json` by default
  (overridable through its existing home setting). For an explicitly confirmed
  direct-root VPS bridge operation, the complete validated file is copied by
  SFTP to `/docker/n8n-openai-oauth/auth/auth.json`, mode `0600`, and mounted
  into the sidecar at `/home/node/.codex`. The pinned third-party
  `openai-oauth` package consumes it. Agent authentication does not remove or
  broaden this credential-copy disclosure.
- **Model-only sudo:** the implementation contract confines this context to
  model operations and shared discovery, denying OAuth bridge, Assistant and
  SuperGrok VPS operations before credential reads/service calls/uploads.
  Model stdin uploads contain packaged runtime assets and managed metadata
  such as model/install IDs, resource identities, measurements and hashes,
  not provider/Assistant credentials. That metadata is non-secret, not
  necessarily appropriate for public disclosure. Direct-root credential
  transfers retain their SFTP path; they are not moved into sudo stdin.
- **Docker client build state:** the later integration uses bounded silent
  current/default selector attestation, not `docker buildx inspect`, which can
  initialize home state and expose nodegroup secrets. After final confirmation,
  build-capable model, SuperGrok and OAuth actions create temporary root-only
  Buildx client state in their respective owned operation locks. The exact
  [reviewed state paths](reference.md#vps-authentication-and-privilege) are
  deployment metadata, not an OAuth grant. State-management code does not copy,
  move or print registry credentials; normal Docker registry authentication is
  separate from that statement. The OAuth build-context allowlist excludes
  credential files, sibling installations and temporary state. Verified cleanup
  removes only owned temporary state; uncertainty can retain a lock and partial
  tree for administrator inspection. These changes add no known OpenAI scope
  or model/TTS capability. Source inspection and adapted POSIX filesystem
  checks are not proof of native privileged Linux/Compose/provider execution.
- **Inference/downloads:** the model runtime uses `OLLAMA_NO_CLOUD=1` on the
  selected eligible private Docker network. The acquisition helper submits a
  fixed inference probe; subsequent n8n workflow data goes to that Ollama
  runtime. Image/model registries receive setup/download requests. Disabling
  cloud models does not block registry egress or n8n tools contacting their
  own external services.
- **Logs:** Relmio uses bounded subprocess/SSH output and sanitized error/status
  projections; model runtime/helper logs are bounded. This does not control
  remote sudo/sshd audit recording, n8n execution history, host/provider
  logging, backups, third-party runtime internals or Codex diagnostic files.
  Current Codex docs mention login diagnostics; their precise behavior in the
  pinned CLI was not audited here. Sudo I/O recording is why credential-bearing
  operations are excluded from model-only scope. No “nothing is logged”
  guarantee is made.

Identifiable processing components are the user's browser/local Relmio process,
local SSH agent, selected remote SSH server and administrator-controlled
storage/Docker runtime, n8n, the selected local-model service, and—when the
separate credential bridge is used—the sidecar/third-party package and OpenAI.
OpenAI receives browser sign-in and supported provider-bound bridge requests;
npm and image/model registries receive relevant installation/download requests.
Exact registry/CDN chains were not traced. Other trusted-network containers
are potential callers of the unauthenticated model API, not proven recipients
of every prompt. Privileged host/provider administrators and logging systems
remain trust/exposure boundaries.

### Scopes, unknowns and acceptance limits

Relmio supplies no explicit scope list in the inspected Codex login command
and does not inspect requested or granted scopes. Valid token fields are not
scope validation. This SSH change requests no known additional OpenAI scope;
it does not prove an unchanged or approved provider grant. Account/workspace
restrictions, applicable contractual permission and actual scopes remain
unknown. No provider call or entitlement test was performed in this review.

Integration checks exercised model-only credential-route rejection,
asynchronous identity replacement and the separate direct-root/SFTP boundary.
The source review itself is not runtime evidence; actual Linux/provider
acceptance remains separate. Private maintainer correspondence, identity
sign-in success and user deployment consent cannot substitute for provider
permission. See [Security](security.md), [Hosting compatibility](hosting-compatibility.md)
and [Local models](local-models.md) for the public operational boundaries.
