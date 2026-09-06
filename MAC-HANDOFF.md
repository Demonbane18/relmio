# Mac handoff: SuperGrok VPS and consistent browser wizard

## Start here

Continue on `codex/vps-supergrok-wizard` in `Demonbane18/relmio`. Fetch the branch
and inspect its current head before changing anything. This branch starts at the
0.14.0 Windows candidate `2a987972f84873b3446618b63877213363bfa8d1`, not npm latest.
Do not overwrite the Mac checkout's pending edits; use a separate worktree if needed.

The user wants the Mac session to revamp the browser installation wizard, keep its
design consistent, and finish integration and shipping there. Windows has added the
provider warning and prepared the feature; the redesign has deliberately not begun.
Read applicable repository instructions and release skills on the Mac. Resolve current
PR/main state and version metadata before deciding the integration and release path.
The Windows session only commits and pushes this feature branch; it does not merge,
publish to npm, deploy production, or create a release.

## What is implemented

- `694287f`: two Windows test portability prerequisites, already present in the
  separate Windows acceptance patch. Avoid applying equivalent fixes twice.
- `7e842c26d196d0b301f53ccae4f9e801ab151ddc`: SuperGrok VPS service, browser page,
  private Docker lifecycle and tests. Reuses the local n8n integration's runtime.
- The handoff commit adds a prominent, theme-consistent Responses API warning and
  this document. Consult Git for its exact revision.

The `/supergrok-vps` page is linked from the initial VPS wizard and detected-n8n
management screen. It supports verified SSH identity, discovery, reviewed installation,
fresh official device sign-in, cancellation, sign-out, model checks and owned removal.
The private endpoint is `http://n8n-supergrok:14502/v1`. Use the wizard-generated local
bridge bearer in the n8n OpenAI credential; never put credentials in this handoff.

## Live user finding

On 2026-09-06 the user tested the Hostinger VPS at `148.230.103.145`. Their screenshot
showed an OpenAI Chat Model node using `grok-4.6`, the correct private base URL, and
**Use Responses API ON**, returning `404 {"code":"not_found"}`. After being told to
turn the switch OFF in the workflow Editor and run again, the user said: **"ok now
it works"**. This is user-reported live success, not an independently captured successful
execution. Do not claim that all VPS Chat, Assistant or Calculator acceptance passed.

Provider-specific instructions are essential:

| Provider | n8n setting |
| --- | --- |
| SuperGrok | Responses API **OFF**; Chat Completions required |
| OpenAI OAuth/Codex | Responses API **ON** in the existing Chat Model v1.3 recipe; its bridge also supports Chat Completions where the switch is absent |

Do not infer that the 404 meant an invalid model or failed Docker installation.

## Mac redesign scope

1. Unify provider selection, VPS/local destination choice, step navigation, connection,
   discovery, review, sign-in and completion in the existing Relmio visual language.
   Preserve consistent typography, spacing, controls, cards, light/dark/system themes,
   mobile layout, keyboard focus and accessible status/error announcements.
2. Make SuperGrok a first-class provider choice without requiring ChatGPT sign-in.
   Preserve an already verified SSH connection while navigating within the wizard.
3. Keep clear provider-specific completion instructions beside the endpoint and bearer:
   SuperGrok Responses OFF versus OpenAI OAuth Responses ON. Do not reduce this to
   a generic shared instruction that becomes wrong after switching providers.
4. Preserve explicit host-key confirmation, exact reviewed plans, final human write
   confirmation, stale-plan invalidation, operation locks and credential protections.
   A UI redesign must not weaken service boundaries or automatically modify n8n.
5. Make busy, pending/expired sign-in, cancellation, failed connection, already-installed,
   recovery and removal states understandable. Test back/forward navigation and provider
   changes without replaying a write or displaying stale status/credentials.
6. Verify the final design on Mac and Windows/Opera-compatible layouts. Run relevant
   service/API/browser regressions and package checks. Review, integrate and ship from
   the Mac using the user's authorization and the current repository release process.

## Evidence and remaining checks

The transfer archive contains `VPS-SUPERGROK-RESULTS.md`, a Git bundle, ordered patches,
and sanitized test evidence. The earlier final Node 22.23.2/npm 10.9.8 check had **992
passes, 24 expected Windows skips, zero failures** across 1016 tests. Actual disposable
Docker Linux tests covered install/health, private networking, official device-prompt
detection, cancellation, logout, removal and preserved dummy n8n/sibling resources.
Opera fixture tests covered the browser flow, confirmation, masked bearer and responsive
layout; its password, model replies and device code were fake fixture values.

All six pre-existing Windows Docker containers retained identical identities, images,
states/start times, mounts, networks and ports. Tests did not touch the existing VPS
n8n workload. Actual user-driven VPS steps happened in the user's browser; do not
conflate them with agent-run disposable test evidence.

Still verify independently as needed: final live VPS model/chat generation, Assistant
with its separate sandbox prerequisites, Calculator tool execution, and the redesigned
browser flow. Do not replay a Telegram workflow without explicit permission to send
messages; use a disposable manual workflow for verification.

An interrupted SSH operation may leave `.supergrok-operation.lock`. There is no automatic
stale-lock removal; establish that no operation is running before administrator cleanup.
Existing companion model checks require the saved local bearer; do not extract it from
n8n. The tested source may need current-main reconciliation before release.

## Safety and transfer boundaries

Preserve existing n8n containers, images, Compose files, workflows, credentials and
OAuth sessions. Use only disposable resources for further tests. Never print, copy,
commit or transfer secrets. Ask the user for interactive sign-in. Do not reuse a Mac
provider session on the VPS. Require host-key confirmation before authenticated SSH and
the final human confirmation before remote writes. Keep deployments inside the approved
`/docker/n8n-openai-oauth` boundary and publish no companion host port.

The archive excludes private wizard directories, browser profiles, Docker auth volumes,
passwords and OAuth data. The old Windows server/browser session is not transferable.
Start the source branch on Mac and obtain any fresh interactive credentials there.
