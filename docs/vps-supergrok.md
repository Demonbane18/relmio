# SuperGrok for n8n on a VPS

Since Relmio 0.14.0, the browser wizard can set up a private SuperGrok companion
on an existing n8n VPS. It does not require or read ChatGPT credentials. It uses
the same pinned official Grok CLI, fresh-session reader, Chat Completions
adapter, and account model discovery as local n8n.

Run `relmio vps`, then choose **Set up SuperGrok for n8n**.
You can also choose **SuperGrok companion** from the detected n8n management
screen. That link keeps the current wizard's verified SSH connection. ChatGPT
sign-in is not required for this flow.

1. Enter the VPS address and actual SSH username. Independently confirm the
   host fingerprint before using **Local SSH agent** or an already-approved
   password login. This credential-bearing route requires a verified direct
   UID-0 account; a **Passwordless sudo -n (model only)** session cannot manage
   SuperGrok. Do not enable root/password SSH to bypass that boundary.
2. Select the running n8n container and its existing Docker network.
3. Review installation. Confirm the exact action before any remote write.
4. Save the newly generated **local bridge bearer** directly into an n8n OpenAI
   credential. Its Base URL is `http://n8n-supergrok:14502/v1`. The bearer is not an
   xAI API key; it is shown only in the current browser session.
5. Choose **Sign in with Grok**, review and confirm, then follow the official
   device-sign-in link and enter the displayed code. A fresh session stays inside
   the companion's Docker volume on the VPS. No local/Mac provider session is
   uploaded.
6. Choose **Check account models**. Use a returned model such as `grok-4.6` only
   when it is available to your account. A listed model may not support every tool.
7. **SuperGrok requires Use Responses API OFF.** In the workflow Editor, open the
   OpenAI Chat Model node and turn this switch off; also turn it off in Chat Hub's
   OpenAI provider settings. Leaving it on returns `404 not_found`. This differs
   from Relmio's **OpenAI OAuth/Codex recipe, which uses Responses API ON**.
   Recheck the switch whenever changing providers, save, and run a fresh test.
   For Assistant, use its custom OpenAI-compatible
   endpoint with the same URL, local bearer and text model ID. Assistant's sandbox
   is a separate companion with its own prerequisites.

Test each n8n path separately: Chat, Assistant node search, and an AI Agent with
Calculator. Ask the
Agent to call Calculator for `317 * 29`, then verify both the tool result and the
model's final answer are `9193`. Relmio does not create these workflows or replace
your existing credentials or provider selections.

## Management and safety

The companion files live in `/docker/n8n-openai-oauth/supergrok`, with a sibling
owned operation lock under the same managed root. The companion joins the
selected existing Docker network and publishes no host port. Relmio does not
modify, rebuild, stop, recreate or restart n8n, its image or Compose file.
Sibling ChatGPT and Assistant installations remain untouched.

The wizard supports status, fresh device sign-in, cancellation of a pending
credential action, sign-out, and removal. Every change requires a reviewed plan
and confirmation. Removal deletes only the ownership-verified SuperGrok container,
credential-action container, auth volume and exact generated files. It leaves
the n8n network, other containers and build-image cache in place. A pending
sign-in must finish, expire or be cancelled before sign-out/removal.

Root-owned private files, content hashes, exact Docker identities, generated
resource names and ownership labels are checked before management. Name or
network-alias collisions fail closed. An exclusive operation directory and a
deterministic credential-action container prevent concurrent changes to the same
auth volume. Sign-in expires after 15 minutes; logout after one minute.

Install, sign-in and sign-out reviews disclose temporary root-only mode-`0700`
Buildx client state at
`/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx`. Even a Compose
credential-action run can build an image, so this boundary covers those
actions, not just installation. State is created only for a confirmed
build-capable call; status, removal and sign-in cancellation do not create it.
Registry credentials are not copied, moved or printed for this state.

Verified cleanup removes only owned temporary build state. An interrupted SSH
operation or uncertain cleanup can leave
`/docker/n8n-openai-oauth/.supergrok-operation.lock` and a partial `buildx` tree.
Automatic stale-lock deletion is deliberately unsupported. An administrator
must inspect the operation, ownership and remaining state before recovery;
do not assume the lock is empty or remove it recursively to bypass a refusal.
See [operation-lock recovery](maintenance.md#vps-build-state-and-operation-lock-recovery).
An incomplete owned installation can be reviewed and removed; it is never
silently overwritten. Do not delete an existing installation merely to
recover a bearer until you have considered its saved Grok session.

The VPS needs existing approved direct-root SSH access, rootful Docker Engine
with Compose and Buildx targeting that same local daemon,
standard Linux tools, outbound HTTPS for the pinned image/CLI and
provider, and an eligible Grok account. An available local SSH agent can supply
authentication, not sudo authorization. The safe root-owned, non-symlink
`/docker` parent must already exist without group/other write permission. The
shared `/docker/n8n-openai-oauth` root must be absent or already marked as
Relmio-managed; unmanaged files are not adopted automatically. See
[hosting and agent guidance](hosting-compatibility.md#ssh-agent-and-administrative-access).

The adapter remains experimental. During the VPS handoff, the user's first Chat
test returned `404 not_found` with Responses API on. The user reported that Chat
worked after turning the switch off. That successful run was not independently
captured, and VPS Assistant and Calculator remain unverified. Local Windows live
checks for those paths do not establish acceptance on a production VPS. Review
and approve each VPS installation separately.
