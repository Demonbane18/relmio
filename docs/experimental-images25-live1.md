# GPT Image 2.5 and GPT-Live 1 evidence

- Checked: 2026-09-12
- Branch: `codex/experimental-images25-live1`
- Base: `4d69e963a0ac0d87ca2bfb382645b5d94a1b1ad7`

This report records source, access, data-flow, and bounded live evidence for the
experimental model check. It does not approve a release, deployment, credential
change, API-key fallback, or legal-compliance conclusion.

## Current finding

| Capability | Official name and ID | Documented access path | Relmio evidence | Status |
| --- | --- | --- | --- | --- |
| Fast image generation and editing | GPT-Image-2.5 Flare, `gpt-image-2.5-flare` | Image API or the Responses API image-generation tool | The pinned adapter forwards a non-empty model ID without aliasing. Direct OAuth generation and native n8n generation and edit executions succeeded. | Current-account route and native n8n execution passed; Browser execution and native From-list selection passed; post-install acceptance remains separate. |
| Precision-focused image generation and editing | GPT-Image-2.5 Sunburst, `gpt-image-2.5-sunburst` | Image API or the Responses API image-generation tool | The pinned adapter preserves the exact ID. Direct OAuth generation and native n8n generation and edit executions succeeded. | Current-account route and native n8n execution passed; Browser execution and native From-list selection passed; post-install acceptance remains separate. |
| Full-duplex voice conversation | GPT-Live 1, `gpt-live-1` | Live API session created by a trusted server using an OpenAI project API key | The integrated ChatGPT OAuth bridge filters Live and Realtime models from discovery and returns a specific 501 for those route families. Existing audio routes remain unsupported. | Explicitly unsupported through the current bridge. |
| Desktop voice for Codex tasks | ChatGPT Voice, powered by GPT-Live | ChatGPT desktop app, subject to plan, rollout, and workspace settings | Product UI capability only; it does not expose an n8n endpoint. | Separate from Relmio's bridge. |

The official image documentation names two GPT Image 2.5 IDs:
`gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`. It does not document
`gpt-image-2.5` as a generic request ID. Relmio must preserve the selected exact
ID. The existing `gpt-image-2` ID and behavior remain available and must not be
silently remapped.

## Integrated behavior

The implementation supplements the dynamic `/v1/models` result with the
two exact GPT Image 2.5 IDs that the current account and transport accepted. It
deduplicates the merged list and preserves the discovered catalog, including
`gpt-image-2`. The supplemented list expresses known transport compatibility;
it is not a promise of universal account entitlement.

The same boundary filters known GPT-Live and Realtime session-model IDs from
this HTTP bridge's advertised catalog and returns a specific 501 response for
exact `/v1/live` and `/v1/realtime` route families. The message directs the
operator to a separately configured Platform connection. This avoids presenting
an incompatible model as usable merely because it appeared in model discovery.

The implementation does not change the pinned package version, its `gpt-image-2`
default, image request transport, credentials, or authentication method. The
integrated tests and isolated runtime results below exercise these boundaries.

## Official capability sources

- [GPT-Image-2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
  describes the fast, everyday model and gives the exact undated and dated IDs.
- [GPT-Image-2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
  describes the editing-precision model and gives the exact undated and dated
  IDs.
- The [image-generation guide](https://developers.openai.com/api/docs/guides/image-generation)
  distinguishes direct Image API generation/editing from the Responses API
  image-generation tool. It instructs callers to select Flare or Sunburst by
  exact ID.
- [GPT-Live 1](https://developers.openai.com/api/docs/models/gpt-live-1) is the
  exact display name; `gpt-live-1` is the exact model ID. It is a full-duplex
  voice model rather than an ordinary text-to-speech model.
- The [GPT-Live guide](https://developers.openai.com/api/docs/guides/live) and
  [WebRTC quickstart](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
  require a trusted server with a project API key that has GPT-Live access. The
  server creates `POST /v1/live/sessions`; WebRTC carries microphone and speaker
  media while a data channel carries events. Voice-session and delegated backend
  usage are billed separately.
- The [text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)
  documents the separate `POST /v1/audio/speech` route and Platform bearer-key
  authentication. TTS converts text to speech; it is not a GPT-Live session.
- [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice) is a separate
  ChatGPT desktop experience powered by GPT-Live. In Codex it uses the task's
  conversation and selected task model. Availability and allowances depend on
  the user's plan, rollout, and workspace.

## Authentication and policy source check

The 2026-09-12 review used the following current sources. These findings define
questions and boundaries; they do not provide a legal opinion.

- [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
  describes identity sharing such as name, email address, and profile image. An
  external application must request any additional permission separately. The
  article does not by itself authorize this third-party compatibility bridge or
  grant a model capability.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) separates ChatGPT
  subscription sign-in from usage-based API-key access. It directs general
  OpenAI API calls to Platform API keys and explains that the active sign-in
  method selects different account controls and data settings.
- The [API authentication reference](https://developers.openai.com/api/reference/overview)
  documents bearer API keys and supported workload-identity flows with
  short-lived credentials. Those mechanisms are distinct from Relmio's copied
  ChatGPT/Codex session.
- The [Terms of Use](https://openai.com/policies/terms-of-use/) include
  restrictions concerning credential sharing, programmatic extraction, and
  circumventing safeguards or limits. Whether the present bridge satisfies all
  applicable terms remains unresolved.
- The [Services Agreement](https://openai.com/policies/services-agreement/)
  provides conditional rights for applications using the API under that
  agreement and its limits. It is not evidence that OpenAI approved the Codex
  credential bridge.
- The [Privacy Policy](https://openai.com/policies/privacy-policy/) describes
  collection of user content and service metadata and distinguishes API content
  handled under applicable business terms. Provider-side retention and the
  terms applying to this exact flow still require confirmation.

The pinned dependency defaults to issuer `https://auth.openai.com`, scope
`openid profile email offline_access`, and Codex backend
`https://chatgpt.com/backend-api/codex`. The actual consent screen and granted
scope set were not inspected, so the actual grant remains unknown.

## Current Relmio path

The integrated wrapper creates the third-party handler with the mounted credential
file in
[`src/gateway/openai-oauth-sidecar.mjs`](../src/gateway/openai-oauth-sidecar.mjs).
The installed `@openai-oauth/core` runtime reads an access token and account ID,
adds them to Codex-backend requests, and normally refreshes and rewrites the
saved session when its freshness rules require it.

The pinned image adapter uses `gpt-image-2` only when the request omits a model.
When the caller supplies a non-empty model ID, generation and edit normalization
preserve that value. Image edits convert uploaded binary reference images to
data URLs before forwarding them. This request-shape behavior does not prove
that OpenAI served the named backend model.

The current public HTTP surface supports model listing, Responses, Chat
Completions, image generation, and image editing. The wrapper returns specific
501 responses for `/v1/audio/*`, `/v1/live/*`, and `/v1/realtime*`, and removes
known GPT-Live and Realtime session models from its compatible model list.
Built-in ChatGPT Voice therefore does not make GPT-Live available to n8n through
this sidecar.

The current upstream
[n8n Generate Image source](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/vendors/OpenAi/v2/actions/image/generate.operation.ts)
uses `imageGenerateModelSearch` for node type version 2.2 or newer, extracts the
exact selected model ID, sends it to `/images/generations`, and converts
`gpt-image*` base64 responses to n8n binary data. The installed n8n 2.36.8 used
OpenAI node type version 2.3 and completed the native node run described below.
This does not verify the GUI picker or guarantee that an older fixed dropdown
contains the new IDs. Begin with low quality and avoid options that the pinned
adapter rejects.

### Credential placement

- The local installer sends the complete credential JSON to a network-disabled
  one-shot seed helper. It validates the JSON and atomically writes a mode-0600
  file into the private `oauth-auth` Docker volume. See
  [`src/domain/local-n8n-sidecar.js`](../src/domain/local-n8n-sidecar.js).
- The VPS installer validates the credential contents, then uploads them by SFTP
  as `/docker/n8n-openai-oauth/auth/auth.json` with mode 0600. See
  [`src/services/installer.js`](../src/services/installer.js).
- Normal dependency operation can refresh tokens and rewrite the mounted session.
  The bounded experimental probe used `ensureFresh: false`, so it did not refresh
  credentials. The credential-file SHA was unchanged across the successful
  Flare and Sunburst probes.

No new authentication method or Platform API key was added by this experiment.
A Platform GPT-Live or Audio integration would be a separately authorized and
separately billed connection, not a key inserted into this OAuth bridge.

## Data flow and recipients

For supported image calls, the path is:

```text
n8n or the bounded local probe
  -> private Relmio sidecar
  -> pinned third-party openai-oauth package
  -> OpenAI Codex backend
  -> sidecar
  -> caller or n8n execution
```

The request can contain the prompt, exact model ID, image options, and reference
images. Analyze Image URL inputs are sent upstream as URLs. Image-edit binary
inputs are converted to inline data URLs by the adapter. The response, including
generated image data, returns to the caller; n8n may retain it in execution
history according to the owner's n8n configuration. Native execution 19 stored
four image results as n8n binary references; its preserved evidence records
their binary metadata and byte counts. Those four native outputs were not
exported or visually checked for this report; the two direct-probe PNGs were
validated separately.

Recipients and processors observed in this design are the owner's local machine,
the owner's VPS when that deployment path is chosen, n8n, the pinned third-party
package, and OpenAI. The npm registry receives package and version requests
during dependency installation or version resolution, not prompts or reference
images through this application path. This change adds no telemetry or new data
recipient.

Responses requests set `store: false`. That setting does not establish zero
process memory: the dependency can hold request, response, replay, or catalog
state in memory while running. The local seed helper disables Docker logging.
The main sidecar has no explicit Docker log driver. Dependency request-metadata
logging is opt-in through `CODEX_OPENAI_SERVER_LOG_REQUESTS=1`; Relmio does not
enable it. The wrapper emits only generic server errors. Actual provider logging,
retention, entitlement, and n8n execution retention remain outside this local
proof.

## Bounded live and integrated evidence

The primary-owned probe used the installed pinned package and Relmio handler
without changing authentication or contacting n8n.

The ephemeral evidence directory is
`/private/tmp/relmio-images25-evidence-20260912`. It contains the two result JSON
files and validated PNG outputs. These files are local evidence and are not part
of the release artifact. Native n8n evidence is under
`/private/tmp/relmio-images25-n8n-20260912`, including the preserved execution
and a sanitized node-level summary.

| Check | Observed result | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Pre-integration bridge discovery | `/v1/models` returned HTTP 200 with `gpt-image-2` and neither 2.5 ID. The dependency can inject `gpt-image-2` as a fallback. | The bridge list and parser worked. | That `gpt-image-2` came from the raw authenticated catalog, or that omission of the 2.5 IDs meant the account lacked access. |
| Flare generation | Exact `gpt-image-2.5-flare` request reached `/backend-api/codex/images/generations` and returned HTTP 200 with a visually checked 725,399-byte, 1254×1254 valid PNG of a blue square. | This account and unchanged transport accepted that exact request and returned usable image bytes. | Independent proof of backend model identity, every option, edit support, n8n behavior, policy compliance, or another account. |
| Sunburst generation | Exact `gpt-image-2.5-sunburst` request reached `/backend-api/codex/images/generations` and returned HTTP 200 with a validated 703,095-byte, 1254×1254 PNG. | This account and unchanged transport accepted that exact request and returned usable image bytes. | Independent proof of backend model identity, every option, edit support, n8n behavior, policy compliance, or another account. |
| Credential integrity | Both probes used `ensureFresh: false`; credential SHA was unchanged before and after. | These probes did not refresh or rewrite the credential file. | Normal runtime sessions never refresh or write credentials. |
| Integrated model discovery | A new isolated sidecar returned HTTP 200 with existing text models plus exact `gpt-image-2`, Flare, and Sunburst IDs, deduplicated, and no Live ID. | The packaged integrated model-list boundary works in Docker. | Universal entitlement or n8n node execution. |
| Existing n8n reachability | A read-only GET from the existing n8n container reached the isolated sidecar and returned HTTP 200 with exact Image 2, Flare, and Sunburst IDs and no Live ID. | Existing n8n can resolve the target and consume the integrated list. | GUI-picker availability. |
| Native n8n image nodes | n8n 2.36.8 OpenAI nodes at type version 2.3 completed Flare generation in 16,874 ms with a 725,069-byte PNG, Flare edit in 20,344 ms with a 983,298-byte PNG, Sunburst generation in 15,840 ms with a 742,461-byte PNG, and Sunburst edit in 19,762 ms with a 986,328-byte PNG. | The native n8n runtime accepted both exact IDs for generation and editing through this route. | Independent backend-model identity, all image options, universal entitlement, or GUI-picker availability. |
| Unsupported-route nodes | The Live, Realtime, and Audio probes each executed and received the expected 501 `unsupported_oauth_feature` response. | Incompatible route families fail explicitly at the integrated boundary. | Platform API or desktop ChatGPT Voice availability. |
| Native workflow execution | All nine nodes succeeded in execution 19 from `2026-09-12T04:24:28.290Z` to `2026-09-12T04:25:41.955Z`. Readback export confirmed the separate workflow is inactive, has nine nodes, and uses four native OpenAI nodes. | The saved workflow, discovery, four image calls, and three negative probes ran together through the local n8n CLI/runtime. | Browser-driven execution or a GUI screenshot. |
| Existing n8n UI | The existing OpenAI node test was inspected and confirmed to point at the VPS host; it was not run. | Configuration provenance was observed. | Acceptance of this experiment through that existing workflow. |
| Repository checks | Focused suites passed 22/22 after review repairs; full `npm test` reported 1,075 total, 1,063 passed, 0 failed, and 12 skipped; lint checked 116 JavaScript files; release check passed at 0.15.0. | Integrated code and repository checks pass in the tested environment. | Browser or production acceptance. |

The local Codex model cache fetched at `2026-09-12T03:51:29Z` contained no
image-2.5, Live, Realtime, Audio, Speech, TTS, or transcription IDs. A Codex
model cache is not a complete Platform capability catalog and its omissions are
not entitlement evidence.

`npm ci --ignore-scripts` completed with 39 packages installed. No dependency
was changed. `npm audit --audit-level=high` exited 0; npm reported six
pre-existing low-severity transitive findings in `@ai-sdk/provider-utils` under
`GHSA-866g-f22w-33x8`, with no fix available. `npm run release:check` exited 0
and confirmed that version `0.15.0` is unchanged. `npm pack --dry-run` listed
118 entries, including this report and the sidecar. The package-inventory checks
passed 4/4 after adding this report to the expected list.

The HTTP tests first encountered sandbox `listen EPERM`. They passed when rerun
with loopback access; that environment restriction was not an application
failure.

Review tightened two response-integrity cases: the supplemented catalog now
requires `object: "list"`, and it removes modern digest fields plus
`last-modified` when rewriting a response. The focused 22/22 and full-suite
results above were rerun on those final repaired bytes. The full-suite log is
`/private/tmp/relmio-images25-full-test-final.log`.

The isolated runtime is named `relmio-experimental-images25-20260912`. It reused
image
`sha256:6c2d4e65d9e3672604ea8686f3a5060fa8afe17f3d3ca5a8e0b53a72df7c27e8`
with no host port, a read-only root filesystem, all capabilities dropped,
`no-new-privileges`, a read-only mount of the existing Relmio credential,
`ensureFresh: false`, and Docker logging disabled. The existing n8n setup was
not restarted or replaced.

The native test imported one inactive workflow named
`Relmio Images 2.5 experimental test 20260912`, ID
`2c8d55a4-7dc4-4156-8f0b-62bd06e581dd`, and one dummy credential, ID
`f9b30a23-d207-43f0-bc72-6a500fa0b498`, which contains only a dummy placeholder
and no real OpenAI Platform API key. Its local
workflow URL is
`http://localhost:5678/workflow/2c8d55a4-7dc4-4156-8f0b-62bd06e581dd`.
The supported CLI imports each accepted one record. A command-scoped
`N8N_RUNNERS_BROKER_PORT=5689` avoided the existing broker without persisting a
configuration change.

The saved local browser login was rejected and the ngrok page was blank; no
authentication reset was attempted. The CLI therefore supplied the native
runtime evidence without a browser or GUI claim. Final preservation checks
showed the original n8n and sidecar with the same container IDs, image hashes,
start times, and restart counts of zero. Existing workflows, credentials, and
configuration were left untouched; the separate test sidecar, inactive
workflow, and dummy credential were retained as requested. The isolated sidecar
remains running with credential refresh disabled. This bounded run therefore
does not prove unattended operation after the current session requires a normal
credential refresh.

## Review and disposition

Fresh Hypernova review completed with **SHIP for the experimental local change**
and no open blocking findings. The built-in default reviewer ran on observed
`gpt-5.6-sol` at Ultra. It repaired the model-list discriminator check and stale
response validators, then verified the final tests, native execution, and PNGs.
The primary remained on observed Astra High; all three built-in workers ran on
observed Sol Ultra. Four advertised native slots supported the three-worker
first wave. No worker delegated further. This verdict is not release, merge,
push, or deployment authorization.

The four native outputs were copied intact to
`/private/tmp/relmio-images25-n8n-20260912/` as `flare-generation.png`,
`flare-edit.png`, `sunburst-generation.png`, and `sunburst-edit.png`. Each is a
valid 1254x1254 PNG. Visual inspection confirmed blue squares for generation and
a centered white circle added by both edits. `artifact-summary.json` records
the sizes and hashes. The requests specified 1024x1024, so the returned dimensions
did not match the requested size; this experiment does not establish size-option
conformance. Browser-driven execution subsequently passed as recorded below; the GUI picker remains unverified.

A follow-up size trace used the actual installed n8n generation and edit
`execute` functions with an HTTP capture stub. All four calls, covering both
2.5 variants, forwarded `1024x1024` unchanged. A separate injected-fetch check
of the pinned bridge preserved that size in six generation/edit calls covering
Image 2 and both 2.5 variants. The bridge also returned the supplied base64
unchanged. The installed n8n operations decode the returned base64 into binary
data and do not resize or enforce dimensions. These checks made no provider
requests. Their records are `size-forwarding-native.json` and
`size-forwarding-bridge.json` in the native evidence directory above.

The experimental discovery change does not modify this existing image request
or byte-return path. The local source and injected checks therefore show no
size rewriting by n8n or this adapter. They are not captures of the successful
live requests on the wire. The cause of the live 1254x1254 result remains
unknown, so it cannot be conclusively attributed to a particular upstream
component. Exact-size support remains unverified; generation and editing
feasibility should not be read as full image-option conformance.

Universal account entitlement, provider retention, the actual OAuth grant, and
policy eligibility remain unknown. They do not undo the bounded current-account
route acceptance, but they limit any broader support or compliance claim.

No production or VPS deployment, merge, push, publication, remote write, or
release occurred as part of this evidence review. Existing n8n resources and
container configuration were not modified; only the separate inactive local
test workflow, dummy credential, and isolated sidecar were added and retained.

## Browser acceptance and installer release follow-up

On 2026-09-12, the owner manually ran the preserved experimental workflow in
Opera GX after its isolated image service was started. The UI reported all
nine steps successful in about 80 seconds. Both native edit-node binary
previews displayed valid PNGs with a blue square and the requested white
circle. The owner's existing n8n session and workflows remained intact.
The unsupported Audio response was inspected and contained the expected
501 result; successful negative-test nodes do not establish voice support.
No additional image request was made during output inspection.

The browser node exposes **From list** and **By ID** modes. The successful
image run used the exact Flare/Sunburst IDs. In a separate, inactive workflow
copy, Opera GX subsequently loaded the native image-model lists and selected
Flare and Sunburst in both Generate an Image and Edit Image: all four nodes
displayed the selected model name in **From list** mode. GPT Image 2 remained
in both catalogs. The original workflow was not edited, and the copied
workflow was not executed during this picker check. This verifies selection
against the experimental companion, not a newly installed release companion.

The local completion UI was also inspected in Opera GX at desktop and
390-pixel widths using production HTML, CSS, and render functions with a
synthetic catalog. All three image choices remained readable; mouse copying
returned the exact Flare ID, keyboard navigation reached the Sunburst copy
button, and keyboard activation reported success. The update preview showed
only the returned Flare entry; clearing an error state removed all stale
image choices. This renderer-only check did not install or update a companion.
The owner subsequently requested a simpler local and VPS wizard, so these
screens require another visual check after that refinement. The owner will
perform the separate live VPS smoke test; local success does not establish
VPS acceptance.

For the installer feature release, the known v0.15.0 runtime must be accepted
as a compatible predecessor while arbitrary modifications continue to fail
closed. Fresh installations and runtime updates use the same bundled adapter.
Only actual returned model IDs belong in the completion screen, and image
choices must remain separate from text-chat recipes. Unit lifecycle evidence
is distinct from a real installed-runtime/browser acceptance run.

The official-source review was refreshed on 2026-09-12 using the linked
Sign in with ChatGPT, authentication, Image 2.5 model, API authentication,
Terms, Services Agreement, and Privacy documents above. The model pages
confirm the two exact IDs and text/image input with image output. Identity
sign-in, separately granted permissions, and model capability remain distinct.
The current Codex authentication page directs general OpenAI API calls to
Platform API keys; the successful compatibility experiment does not resolve
policy eligibility for this third-party route. The Terms link currently
redirects to Europe Terms; applicable account/jurisdiction terms must be
reviewed separately and no global legal conclusion is inferred from that page.

No authentication flow, scope, provider, or data recipient is added by the
installer image-discovery changes. The source/data-flow and credential-storage
sections above remain applicable: the complete local session file is copied
on fresh installation, the local runtime-only update preserves the installed
credential volume, the VPS update retains its separately reviewed SFTP flow,
and prompts/reference images go through the pinned package to OpenAI. Actual
OAuth grants and provider retention remain unverified. Runtime request logging
stays disabled by default; execution images may be retained by n8n.
