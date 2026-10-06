# VPS and n8n

Relmio can add private n8n companions beside an existing VPS installation. The
ChatGPT sidecar uses a separately authorized SIWC registration; SuperGrok uses
its own session and does not require or read ChatGPT credentials.

The VPS model setup is tested on Hostinger KVM VPS. Other Linux VPS hosts,
including Hetzner, are experimental. Use the actual SSH username for your
image and an approved local SSH agent or password; provider defaults are
guidance, not credentials to try automatically.


| Connection | Private Base URL | n8n API-key field | Use Responses API |
| --- | --- | --- | --- |
| ChatGPT plan use | `http://n8n-openai-oauth:10531/v1` | One-time local Relmio bearer | **On** for OpenAI Chat Model node 1.3 |
| SuperGrok OAuth | `http://n8n-supergrok:14502/v1` | One-time local Relmio bearer | **Off** for workflow model nodes and Chat Hub |
| Local Ollama model | `http://n8n-local-model:11434/v1` | `local-only` ignored placeholder | **Off** for the documented Chat Completions recipe |

The local plan route is not an OpenAI Platform API key. ChatGPT identity,
plan-use permission, model availability, and successful requests are distinct.
See the [OpenAI source check](openai-source-check-2026-10-04.md) for capability,
account, and data-handling limits.

Relmio's managed files stay below `/docker/n8n-openai-oauth`; the safe,
root-owned `/docker` parent must already exist. Docker manages the companion's
approved images, containers and volumes in its own data root. Relmio does not
edit, rebuild, recreate, execute inside, stop, or restart your n8n Compose
project or image. No companion publishes a host port.

Build-capable actions use temporary mode-`0700` Buildx state inside the reviewed
operation lock. Verified cleanup removes owned temporary state only; ambiguous
or interrupted cleanup retains the lock for administrator inspection. Registry
credentials are not copied, moved or printed for this state.

The local-model companion is not a provider sign-in or an OpenAI API-key
connection. Ollama's API has no authentication by default, so any container on
the selected Docker network can reach its model-management API. Choose a
trusted network. It runs one CPU-based model and needs outbound internet to
download the runtime and model weights even though Ollama cloud features are
disabled. See [Private local models](local-models.md) and
[Hosting compatibility](hosting-compatibility.md).

## Use the wizard

The browser wizard has five steps: **Choose setup**, **Check server**,
**Choose n8n**, **Review**, and **Ready**. The route chooser appears before
ChatGPT sign-in. It is available from stable `@latest` and hosted installers.

1. Choose the ChatGPT route and complete SIWC sign-in on this computer before
   choosing the server. An identity-only registration stays connected but
   cannot use models until you separately allow plan use in ChatGPT. SuperGrok
   uses its own device sign-in; **Local model · your VPS** needs no provider
   sign-in.
2. Enter the server address and port, then independently compare and confirm
   the SSH host fingerprint. Only after that, enter the actual SSH username
   and choose **Local SSH agent** or approved password authentication. Never
   upload a private key or enable root/password SSH just for this wizard.
3. Connect and check the verified administrative identity. The ChatGPT
   sidecar, SuperGrok and Assistant VPS operations require the approved
   direct-root connection; agent authentication does not change that privilege
   boundary. **Passwordless sudo -n (model only)** is limited to local-model
   management and common read-only discovery.
4. Select a running official n8n container and one eligible existing Docker
   network. Rootful Docker Engine, Compose v2 and Buildx must use the same
   local daemon in the selected administrative context. If SSH connected but
   this read-only check fails, fix the problem on the server and choose
   **Retry discovery**. The wizard keeps the verified connection and does not
   ask for the password again. Changing the server details requires a fresh
   identity check.
5. Review the selected registration, verified SSH identity, target, and exact
   write plan. Confirm the SSH fingerprint before authentication and separately
   confirm the final remote write. Explicitly approve background n8n use.
   After installation, enter the one-time Relmio bearer manually in n8n. Select
   **Disconnect from VPS** when finished.

The plan review shows short IDs for the selected n8n container and network.
Relmio checks those exact IDs again before its first write and before the
credential transfer. If either changed, the install stops and asks for a new
review. An interrupted install stays bound to the full reviewed target. After
the install completes, status and sign-out need only the same SSH host
identity and Docker network ID, so they keep working if n8n is recreated or
you change the SSH login method. A changed network is still refused.

The destination runtime has a distinct persistent host ID. Relmio freezes the
source registration before transferring it and clears sender tokens only after
the destination returns an attested receipt. Unknown transfer outcomes stay
frozen for inspection; the destination is the only refresh owner after a
confirmed handoff. The published SIWC VM guide and Terms do not resolve
persistent remote token storage, so these implementation safeguards are not
a provider approval claim.

### Recover an interrupted install

- **Install stopped partway:** status shows the install as staged. Select the
  account, choose the resume action, review the plan, and confirm it. Relmio
  continues the same installation without deleting data or starting a second
  refresh writer. Turning plan use on or off, or a token refresh, before you
  resume does not block it. If the session had already moved, the one-time
  key is replaced.
- **Destination accepted the session but the acknowledgment was lost:**
  choose the reconcile action and confirm it within five minutes of the
  review. Relmio reads the destination's receipt and finishes the handoff.
  Without a receipt, the sender stays frozen and needs a fresh sign-in; old
  tokens are never restored.
- **Switching to a fresh account after "not accepted":** allowed only after a
  confirmed not-accepted result. Relmio refuses while a one-off sidecar helper
  container is still present or if the original receipt appears.
- **Ownership moved but a finishing step failed:** the result still shows the
  one-time key once. Save it, but do not use it until the reported issue is
  resolved.

Relmio never restarts an old writer automatically.

See [Hosting compatibility](hosting-compatibility.md) for image-qualified
accounts on Hetzner, Contabo, AWS, DigitalOcean and OCI, local-agent setup,
the existing `/docker` prerequisite, and Render's separate manual private
service. A provider choice does not provision or repair the host.

Relmio also closes the authenticated SSH session after 15 minutes of
inactivity. An active VPS operation holds a bounded lease so discovery or an
approved install can finish before the idle timer resumes.

Every remote command has a finite deadline: 45 minutes by default, 30 minutes
for an image build, 2 minutes for the destination's handoff acceptance, and
5 minutes for publishing a managed file. When a deadline passes, Relmio closes
that command and reports an unknown remote outcome. It does not retry
automatically; inspect the target before trying again. Managed files are
published atomically under `/docker/n8n-openai-oauth` through an exclusive
temporary file and a rename. Relmio rejects symlinked, non-root-owned or
group/other-writable parent directories and symlinked or hard-linked targets.

## Install or manage the ChatGPT sidecar

The first install signs in locally, selects an authorized registration, and
reviews a fresh n8n target and network. Enter the one-time local Relmio bearer
shown after installation manually as n8n's credential:

```text
Base URL: http://n8n-openai-oauth:10531/v1
API key: <one-time Relmio bearer shown by the wizard>
Use Responses API: On
```

The sidecar uses the selected registration to discover public models and send
supported Responses requests. It rejects unsupported routes and parameters;
model discovery does not guarantee account entitlement or host admission.
Legacy credential-copy installations are never adopted automatically. The
reviewed VPS migration attests the exact old sidecar, image, network, and
protected credential ownership, archives the old managed Docker files under
`/docker/n8n-openai-oauth/legacy`, and writes a pending-migration marker before
stopping only that sidecar. The old `/docker/n8n-openai-oauth/auth/auth.json`
and credential volume stay offline; their token bytes are not copied into the
SIWC runtime.

The new SIWC record lives in `/docker/n8n-openai-oauth/siwc`, mounted inside
the container at `/home/node/.relmio-siwc`. It receives its own host identity
and becomes the only refresh owner after a matching transfer receipt. n8n is
unchanged. If stop or transfer is uncertain, the pending marker and old data
are retained, the old sidecar is not resumed automatically, and the transfer
must be inspected rather than retried blindly.

For an installed VPS account, Relmio verifies the managed Compose configuration
and target identity, stops the exact owned sidecar, confirms it is stopped, then
performs the selected sign-out or plan-disable operation. If it cannot attest
that state, it does not mutate the registration.

No port is published and n8n remains unchanged. ChatGPT plan use through a VM
is not described here as provider-approved: OpenAI's self-hosted VM guide and
SIWC Terms leave persistent remote token storage unresolved.

### Update the installed sidecar

Installing a newer Relmio package does not change a sidecar that is already
running. To rebuild an installed VPS sidecar from your current Relmio version,
connect to the server, select its n8n container and network, and then:

1. Open **Manage the installed ChatGPT session** and choose **Check installed
   account**. The panel says whether a newer sidecar runtime is available.
2. Choose **Review sidecar update**. The review shows how many runtime files
   change and the short image and container IDs. If nothing needs rebuilding,
   it says `Already current. Nothing to update.`
3. Select **I approve rebuilding and restarting only this owned sidecar**,
   which also names your SSH user, host and port. Then choose **Update the
   sidecar**. The account check and the review each expire after five
   minutes; check and review again if they do.

Relmio uploads this version's runtime files, builds a new image and replaces
only the sidecar container. The old container keeps serving while the image
builds, so the sidecar is unavailable only while it restarts. Relmio does not
rewrite the Compose file, so the one-time Relmio key stays the same. The
ChatGPT session stays in `/docker/n8n-openai-oauth/siwc` and is not
transferred again. n8n is not stopped or restarted, and no host port is
published. Relmio disconnects from the VPS when the update ends.

The sidecar must be running with plan use on. Pausing plan use stops the
sidecar, and Relmio refuses to update a stopped sidecar.

If the image build fails and Relmio can confirm the old sidecar is still the
one running, it keeps that sidecar and marks the install as complete again, so
status, pause and sign-out keep working. Review the update again later.

If the update stops partway for another reason, status reports `updating` and
the panel says the update did not finish. Choose **Check installed account**,
then **Review sidecar update** again and confirm to finish it. Relmio rebuilds
the image on every attempt. The staged-install resume and new install plans
for this server are refused until the update finishes. If the new sidecar
fails its checks, Relmio stops it and the update stays open for another
review. If Relmio cannot confirm that the sidecar stopped, do not use it until
you inspect it.

## Next guides

- [Configure n8n nodes](./n8n-configuration.md)
- [SuperGrok on a VPS](./vps-supergrok.md)
- [AI Assistant companion](./ai-assistant.md)
- [Manual installation](./manual-install.md)
- [Troubleshooting](./troubleshooting.md)

## Unsupported ChatGPT plan capabilities

The gateway provides model discovery and supported `/v1/responses` requests.
Image generation/editing, audio, video, Files API management, moderation,
stored responses/conversations, and unsupported parameters are rejected.
The Chat Completions compatibility route accepts function tools through
`additional_tools`, with limits of 32 tool calls, 128 KiB of arguments per
call, and 2 MiB of streamed arguments in total. It rejects a named
`tool_choice`, tool namespaces, custom tools in streamed requests, and system
messages. Tool roundtrips passed live on one ChatGPT account on a local macOS
setup on 2026-10-05; a VPS install was not tested live. Discovery does not
establish account access. See [Configure n8n nodes](n8n-configuration.md) and
the [dated source check](openai-source-check-2026-10-05.md).
