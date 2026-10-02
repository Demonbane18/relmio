# Hosting compatibility for n8n and local models

This page compares hosts for n8n and local models and distinguishes the **managed SSH/Docker path** from a separate **manual platform deployment**. Provider documentation was checked on 2026-09-26; it is not evidence of a live deployment on each provider. Relmio's managed model setup installs one CPU-based Ollama companion beside an existing running n8n container, on that same Docker host and an eligible existing network. It does not provision cloud servers or offer provider one-click installs.

## Current path and host requirements

| Hosting option | Status | Managed model path | Account and prerequisite guidance |
|---|---|---|---|
| Local Docker Engine or Docker Desktop | Tested | Local model setup | Existing running official n8n container, eligible user-defined bridge, supported local engine and sufficient measured resources. Docker Desktop's Linux VM allocation, not physical host RAM alone, determines capacity. |
| Hostinger KVM VPS | Tested | Capability-gated VPS SSH setup | Use the actual SSH username and an approved local SSH agent or password. The managed path still requires the documented Docker, n8n, network, resource and `/docker` prerequisites. |
| Hetzner Cloud Linux VM | Experimental | Capability-gated VPS SSH setup | Hetzner's stock Cloud/Docker CE access uses `root`; customized hosts use their existing administrator account. The Docker CE image lists Engine and Compose, but Relmio checks the installed tools. CAX needs a native arm64 runtime. |
| Contabo Linux VPS/VDS | Experimental | Capability-gated VPS SSH setup | Use the username from your actual login details or administrator; `root` is not a universal default. Its n8n add-on is a customer-maintained Docker deployment, not permission to reinstall the server or rerun its installer. |
| AWS EC2 or Lightsail Linux VM | Experimental | Capability-gated VPS SSH setup | Ubuntu commonly uses `ubuntu`, Amazon Linux `ec2-user`; Lightsail also documents Debian `admin` and Bitnami `bitnami`. Keep approved access and verified model-only noninteractive sudo. Browser SSH is not Relmio authentication. Lightsail Containers has separate manual SearXNG artifacts only. |
| DigitalOcean Linux Droplet | Experimental | Capability-gated VPS SSH setup | Docker 1-Click initially uses `root`; most stock images do too, but n8n's guide creates a separate sudo user. Use the actual existing account. App Platform and Kubernetes are different products. |
| Oracle Cloud Infrastructure (OCI) Compute Linux VM | Experimental | Capability-gated VPS SSH setup | OCI Ubuntu uses `ubuntu`; Oracle Linux uses `opc`. Requires actual rootful Docker Engine and Compose, not `podman-docker`. Always Free capacity and retention are not guaranteed. |
| Render, Railway, Fly.io, DigitalOcean App Platform | Experimental | No managed SSH/Docker install; provider-specific model/search artifacts where listed below | Manual profiles are operator-applied and NOT-RUN. Render SSH enters a service, Railway services are nonprivileged, Fly is a guest Machine, and DigitalOcean App Platform has no persistent volumes. |
| ECS, EKS, GKE, AKS and managed container products | Experimental | No managed host installer; scheduler-native artifacts for specified model/search lanes | Relmio does not deploy or edit existing n8n. ECS Fargate and EKS Fargate do not support the current privileged runner; see the component-specific constraints below. |
| Cloud Run, Azure Container Apps, Azure Container Instances, Lightsail Containers, Cloudflare Containers | Experimental | No managed SSH/Docker install; selected manual artifacts only | These are separate service contracts, not VM presets. Read each platform's private routing, storage and secret limitations below. |
| n8n Cloud | Experimental | Cannot host a managed sidecar | The handoff uses an already reachable authenticated external endpoint and native HTTP Request nodes; it does not assume provider-private DNS or edit n8n. |
| Vercel, Netlify, Cloudflare Workers | Experimental | No managed n8n/model stack | Restricted authenticated Chat Completions relay artifacts target an already-running bearer-authenticated HTTPS model. They are not general URL proxies or native n8n adapters. |
| Vercel, Railway, Cloudflare Sandbox SDKs | Experimental | External SDK descriptions only | Separate APIs/lifecycles; not native n8n sandbox provider values or Relmio's host-Compose runner. |

Relmio's tested hosting paths are local Docker and Hostinger KVM VPS. Other
Linux VPS hosts, including Hetzner, and all hosting-plan platforms are
experimental; the provider documentation review is not a live deployment test.

Provider selection in **Hosting options** is distinct from **Local model · your VPS**: the former compares six capability categories, manual plans and endpoint handoffs; the latter uses the existing managed SSH flow for an actual eligible Docker VM. The managed catalog has 15 Linux VM presets (generic, Hostinger KVM, Hetzner, Contabo, AWS EC2, Lightsail VM, DigitalOcean Droplet, OCI Compute, GCE, Azure VM, Linode, Vultr, OVHcloud, Scaleway and UpCloud) plus local Docker. These labels give source-linked login guidance only; they do not attest SSH reachability, image defaults on a customized host, Docker readiness, root access or provider-account permissions.

The authenticated `/hosting` page loads its provider catalog and profile schemas via `/api/hosting/providers`; the existing wizard session token is required, and plan POSTs are same-origin. Validated plan submissions go to `/api/hosting/plan`. They use allowlisted model IDs and declared nonsecret fields to render manual settings, requirements, limitations, source links, connection details and ordered operator instructions. A plan is marked `not-live-tested`. The UI offers individual file downloads and a complete ZIP that keeps relative nested paths and hidden `.dockerignore` files intact. Input changes invalidate an existing review. Neither endpoint reads SSH/Docker state or contacts a cloud account. Generation provisions no resource, executes no command, applies no file, exposes no endpoint and changes no existing n8n definition.

The artifact catalog contains 48 explicit provider/component profiles, not 48 managed adapters:

| Manual lane | Generated handoff | Material limits |
|---|---|---|
| Render, Railway, Fly.io | Private Ollama model and/or JSON SearXNG files or exact console steps | Model runs on a separate service with its own persistent storage; acquisition is an operator-triggered private `/api/pull`, followed by real inference. Render uses a new private service and its own disk; Railway uses a runtime volume and has nonprivileged service containers; Fly uses one explicitly maintained private 6PN Machine and one attached volume without public service blocks. |
| DigitalOcean App Platform | Additive private SearXNG service fragment | No persistent volumes; search cache is disposable. This is not a durable Ollama-cache profile. |
| ECS on EC2 and ECS Fargate | Paired task-definition/service JSON, private service discovery, security groups and EFS model storage where applicable | Service networking assigns no public IP. EFS, roles, subnets, security groups and Cloud Map objects must already exist; the planner does not create them. Fargate does not support privileged containers. |
| EKS, EKS Fargate, GKE Standard, GKE Autopilot, AKS | Namespaced Deployment, ClusterIP Service, ingress NetworkPolicy, persistent model claim or private SearXNG settings/image files | Uses an existing namespace, exact n8n caller labels and compatible storage. EKS Fargate does **not** enforce Kubernetes NetworkPolicy: generated security-group references do not create or verify ingress rules. It requires an existing dedicated pod security group restricted to the actual n8n caller, a matching Fargate profile and statically provisioned EFS PV/PVC for models; no EBS/dynamic EFS. Verify CNI enforcement on other clusters. |
| Cloud Run | Internal service YAML, and a paired least-privilege IAM/caller procedure | Model cache must be prepopulated in an existing exact-layout Cloud Storage bucket and mounted read-only; no pull to the service cache. Internal ingress and IAM are independent; n8n must reach the internal service and receive renewable audience-bound OIDC tokens. Check n8n SSRF policy for metadata/private destinations; never disable it broadly or save tokens in execution data. No privileged runner. |
| Azure Container Apps | Single-resource ARM template and, for search, generated image build inputs | Model requires existing registered Azure Files storage and writable cache; search requires an operator-built pinned image plus existing Key Vault secret/identity/registry. `external:false` internal ingress is scoped to the same Container Apps environment; resolve its actual FQDN and use HTTPS with valid TLS. It is not automatically VNet-wide. No privileged runner. |
| Azure Container Instances | Private Container Group template; secureString deployment parameters for account/search secrets | Existing delegated subnet, outbound/NAT, routing and classic Azure Files are required. Model account key is a secureString supplied only in secure deployment; SearXNG secret likewise stays outside downloaded files. SMB model volume requires container UID 0 but this is not privileged DinD. Private IP may change; operator maintains DNS. |
| AWS Lightsail Containers | Private SearXNG deployment JSON and supplied image build files | No model profile because no documented durable mutable model-volume contract. Container API has no native secret reference or secret-file mount: inject the actual SearXNG secret privately at runtime/deployment, never in the artifact or command history. A dedicated same-region Lightsail caller is required. |
| Cloudflare Containers | SearXNG image files plus Worker/Container configuration and authenticated proxy | Two independent secrets are operator-supplied. The Worker authenticates a constrained `/search?q=…&format=json` route and forwards only to the bound container; use an n8n HTTP Request tool, not the native Assistant URL integration that lacks the required header. Container disk/cache is ephemeral; no privileged runner or persistent model profile. The generated Worker compatibility date is 2026-09-27. |
| n8n Cloud | Exact connection handoff for a remote authenticated model/search endpoint | No customer host SSH or managed sidecar. Use the actual externally reachable HTTPS endpoint and n8n credentials/HTTP Request nodes; provider-private names and localhost are not reachable by assumption. Native Assistant availability is managed by n8n. |
| Vercel Functions, Netlify Functions, Cloudflare Workers | Restricted `/api/chat` endpoint relay source and runtime secret instructions | Relays only Chat Completions to the HTTPS origin fixed at plan generation, with independently supplied caller/upstream bearer secrets. Not a model host, general URL relay, Responses API adapter, or ChatGPT/Codex credential bridge. |

Every self-hosted platform in the catalog that offers a Daytona profile receives the same n8n-native, operator-managed Assistant handoff across these **15** products: Render, Railway, Fly.io, DigitalOcean App Platform, ECS EC2, ECS Fargate, EKS EC2, EKS Fargate, GKE Standard, GKE Autopilot, AKS, Cloud Run, Azure Container Apps, Azure Container Instances and Lightsail Containers. The handoff provides exact nonsecret `instance-ai`/Daytona settings; the operator adds their Daytona API key and independent model credential to the existing n8n secret store and performs any n8n maintenance themselves. It neither provisions Daytona nor edits/restarts n8n. This substitutes n8n's external Daytona sandbox; it does not install Relmio's privileged local runner, OpenAI/Grok bridges, model or search.

Model deployment profiles use a pinned Ollama runtime image and manual mutable model-tag acquisition; this does not inherit managed VM manifest-digest verification. Search profiles enable SearXNG JSON output and require independent secret injection and permitted egress to upstream search engines. A successful container health check or model pull is not a PASS: test actual model completion or SearXNG JSON/search from the n8n execution backend. All new cloud/platform runtime results remain **NOT-RUN**.

Local verification exercised all 48 profiles through the actual `/hosting` UI
and authenticated plan API. All 48 ZIPs contained the exact 174 expected
entries; generated YAML, TOML, JSON and JSONC parsed, two Render blueprints
passed the official schema, and generated JS/shell files passed syntax checks.
These checks validate planner and artifact generation only. No live provider
deployment or runtime test was performed.

The planner does not collect or copy OpenAI/xAI subscription credentials. A
deployed Chat Completions relay does read the operator-supplied upstream bearer
from a server-side runtime secret and sends it only to the fixed configured
upstream; it does not validate credential provenance or provider permission.
Do not configure it with ChatGPT/Codex/SuperGrok session credentials: use an
independently authorized upstream API credential. The existing experimental
OpenAI bridge is separate, limited to the managed local/VM flow, requires
direct UID-0 VPS access, and needs its own provider-permission review. The
[2026-09-27 source review](security.md#2026-09-27-openai-and-hosting-source-review)
records the article's supported-partner identity sign-in distinction, runtime
data flow, recipients, telemetry, and unknowns; successful login or a rendered
plan does not establish provider permission, account entitlement, or runtime
compatibility.

Plan generation receives selected nonsecret metadata in the local browser and
returns rendered files through the same-origin Relmio endpoint; it makes no
provider-account request and does not persist the plan. Downloaded artifacts
remain on the operator's machine unless separately deployed. Once deployed,
the model relay receives the full accepted JSON request and the configured
upstream receives that body plus its bearer; n8n may retain executions.
Generated Cloudflare Workers enable logs and traces. Search profiles pass the
query in a URL, so treat it as potentially present in access telemetry. Exact
provider log fields, onward recipients, and retention were not established.

### External n8n Cloud and HTTP endpoint handoffs

The n8n Cloud profile accepts no provider credential. It returns an operator
handoff for an existing externally reachable HTTPS service: use n8n's
authenticated remote [Ollama credential](https://docs.n8n.io/integrations/builtin/credentials/ollama.md)
only when the remote service speaks that interface, or use HTTP Request for
the generated Chat Completions relay and store its caller bearer in an n8n
Header Auth credential. The Vercel, Netlify and Cloudflare Workers files fix the
upstream public HTTPS origin and `/v1/chat/completions` path when generating;
operator supplies a separate incoming token and already-issued upstream bearer
as runtime secrets. Their endpoint is `POST /api/chat`, not `/v1` and not a
general URL relay. Use n8n's HTTP Request node/tool with the actual deployed
HTTPS URL and Chat Completions body; Responses mode is not supported by this
relay.

For external search, use an independent reachable authenticated HTTPS search
endpoint from a separate n8n HTTP Request node/tool with its own stored Header
Auth credential, `GET /search?q=<URL-encoded query>&format=json`, and verify a
JSON `results` array. This is not an n8n Cloud native SearXNG/Assistant
configuration. The authenticated Cloudflare Container Worker route has this
same header requirement; n8n's native Assistant SearXNG URL setting cannot
supply it. See n8n's [HTTP Request node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest.md)
and [webhook authentication](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook.md).

Vercel Sandbox, Railway Sandbox and Cloudflare Sandbox are separate SDK-managed
execution products, not `n8n-sandbox`/`daytona` provider values and not Relmio
managed host or privileged-runner installations. Their product docs describe
[Vercel Sandbox](https://vercel.com/docs/sandbox),
[Railway Sandboxes](https://docs.railway.com/sandboxes), and
[Cloudflare Sandbox rootless Docker](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/).
Cloudflare's documented Sandbox/Containers execution is rootless-only and
cannot satisfy the current privileged n8n runner.

Provider selection in **Local model · your VPS** supplies connection guidance, not a compatibility bypass. Enter the account you already use: image defaults are hints, not identities to try automatically. See [SSH agent and administrative access](#ssh-agent-and-administrative-access). Choosing Render directs you to the manual guide instead of offering an SSH installation.

Before managed VPS installation, all of these prerequisites must hold:

1. The machine running Relmio can reach the existing Linux host's SSH address/port. A provider browser console, Session Manager, `doctl`, terminal `ProxyJump`, or ECS Exec session does not establish this route.
2. The selected SSH account authenticates by its approved password or a supported local SSH agent. Direct-root mode proves UID 0; model-only `sudo-n` proves noninteractive effective UID 0. No SSH/sudo policy or group membership is changed.
3. **Rootful Docker Engine, Docker Compose v2 and its Buildx build tooling** work in the selected administrative context. The existing Docker context must already be **`default`**, targeting the same `unix:///var/run/docker.sock` daemon that owns n8n. Relmio does not switch from a custom/remote context, rootless Docker or Podman. The built-in default builder must not be shadowed by a saved named instance or a foreign/ambiguous selection. Preparation checks bounded, root-owned, non-symlink current/default selector files beneath the administrative account's `.docker/buildx`, without printing their contents, reading nodegroup/TLS secrets or `config.json`, or invoking the Buildx CLI. A pre-existing running builder is not required. Inherited `BUILDX_BUILDER`, `BUILDX_CONFIG`, `BUILDKIT_HOST`, `DOCKER_CONFIG` and `COMPOSE_BAKE` selectors are rejected. Amazon Linux may need Compose/Buildx installed separately by its administrator; user-only plugins may be unavailable to sudo. Oracle Linux's Podman Compose tutorial does not establish Docker Engine compatibility. Administrative preparation has a 30-second deadline, not permission to repair the host.
4. **`/docker` already exists as a root-owned, non-symlink administrator-managed directory without group/other write permission.** Relmio does not create it. Only the reviewed `/docker/n8n-openai-oauth` subtree, its disclosed root marker, model files and operation lock belong to this installer. Docker additionally manages its own approved images, containers and cache volume under its data root.
5. A running supported official n8n container already uses an eligible, non-internal user-defined local bridge with inter-container communication and Docker DNS. Default/NAT and filtered `routed` gateway modes are permitted; active-family `nat-unprotected`, unknown and isolated modes are rejected. Direct-routing settings alone do not publish an unpublished port. The default `bridge`, host networking and scheduler-managed networks are not substitutes. These checks are not a full host-firewall audit. Relmio never attaches a new network to n8n or recreates it to make setup work.
6. The actual CPU architecture, runtime image, Docker-visible memory/CPU, current VPS available memory and disk support the reviewed plan. Outbound DNS/HTTPS must permit runtime-image and model-weight acquisition. A successful login or model listing does not prove inference readiness.


For the managed model workflow, the reviewed HOME must still match the user's
configured home when Relmio re-attests before a model build/retry. It reads
bounded `current` and `defaults` selector files under that home and rejects an
`instances/default` shadow; it does not rewrite the user's saved Docker config.
The workflow attests before mutation and again before build/retry. Explicit
helper-image builds pass `--builder default`; Compose `run` calls that can
trigger an implicit build use the same attested command-scoped config and
`BUILDX_BUILDER=default` environment, without unsupported Compose flags. An
unavailable or ambiguous builder is a stop, not permission to repair or reset
the user's selection.
Preparation also requires the standard Linux filesystem tools used by the
guards (`find`, `awk`, `rm`, `rmdir`, `mkdir`, GNU `dd`/`stat`/`sha256sum`) and
readable `/proc/self/mountinfo`. `DOCKER_BUILDKIT` may be unset, empty or `1`;
`0` and other nonempty values are rejected rather than using a classic-builder
fallback. Selection attestation is not proof of a successful build.

After **final confirmation**, build-capable actions use temporary root-only
mode-`0700` Buildx client state inside their owned operation lock, not the
administrative home. The reviewed state locations are:

| Managed VPS action | Temporary Buildx client state |
|---|---|
| Model install or retry, when a build is needed | `/docker/n8n-openai-oauth/.local-model-operation.lock/buildx` |
| SuperGrok install, sign-in or sign-out, whose Compose action can build | `/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx` |
| OpenAI OAuth bridge install/update | `/docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx` |

State is created lazily for a confirmed build-capable call. Status, removal
and retries that need no build do not create it. Successful verified cleanup
removes only the owned temporary state and lock; uncertain ownership or
interrupted cleanup can retain the lock and a partial state tree for
administrator inspection. It does not delete n8n or model-cache data.
Relmio does not copy, move or print Docker registry credentials for this state.
The root-only OAuth build uses a guarded `Dockerfile.dockerignore` allowlist
so credentials, sibling installations and build state are excluded from its
build context. An unexpected existing ignore file is not overwritten.
See [operation-lock recovery](maintenance.md#vps-build-state-and-operation-lock-recovery).

Relmio does not install/upgrade Docker, install n8n, restart the daemon, alter firewall rules, or change existing n8n files, images or containers. Missing prerequisites are administrator decisions, not automatic repair steps. For a separately chosen new VM, Ubuntu with official Docker Engine and its Compose plugin is a straightforward common baseline; do not reinstall an existing host just to match that recommendation.

### SSH agent and administrative access

In **SSH authentication**, choose **Local SSH agent** or **Password** explicitly.
The model page's **Administrative context** offers **Root account (UID 0)** and
**Passwordless sudo -n (model only)**. Provider choice never silently replaces
an entered SSH username or grants either privilege.

Load the existing approved key using your operating system's trusted agent flow **before starting Relmio**. For a Unix-like terminal with an agent already running:

```sh
ssh-add /path/to/your-existing-key
ssh-add -l
```

Replace the example path locally. The second command checks loaded identities for your own use; do not paste its output, private keys or passphrases into Relmio or support messages. An encrypted key is unlocked by the local agent, not a browser passphrase field. Relmio does not read a private-key file or forward your agent to the VPS.

Start the foreground wizard from that agent-enabled environment. A persistent dashboard keeps its launch environment: if the agent socket changed, finish active operations, use `relmio stop`, then `relmio start` and `relmio open` from the correct environment. This stops only the dashboard, not n8n or its companions. Loading another key into the **same** reachable agent does not itself require changing the socket environment.

Native Windows agent availability and WSL agent availability belong to different process environments. If your existing Windows OpenSSH agent service is already configured and running, load the approved key locally with `ssh-add C:\path\to\your-existing-key`; use the Unix-side agent flow when Relmio runs inside WSL. Relmio does not start/configure that service. The native Windows capability probe checks the standard OpenSSH pipe's availability only; it does not enumerate keys or prove server authentication. Unix socket presence is likewise reported as configured/untested. Use the wizard's status, not the mere presence of `ssh.exe`. There is no automatic password fallback or promise that `~/.ssh/config`, jump hosts, provider browser sessions, hardware-key prompts or every agent family are supported. No live native Windows agent session was exercised for this change.

Scan the host key, compare its SHA256 fingerprint through an independent trusted provider/administrator channel, and confirm it **before authentication**. The server's host key is not your login key-pair fingerprint. A mismatch is a stop. Review the connected username, authentication method and verified privilege again in the final plan; fingerprint trust is not permission to write.

**Noninteractive sudo is model-only.** It authorizes model discovery, installation, status, retry and separately confirmed removal; it does not authorize OAuth bridge, AI Assistant or SuperGrok VPS operations. Those routes retain their existing verified direct-root requirement, with password or agent authentication as already permitted by the host. Do not enable root/password SSH to work around this distinction.

`sudo -n` fails rather than requesting a sudo password. Being in the sudo group, having a working Docker CLI, or passing a different sudo command is insufficient. This is root-equivalent administrative authority, not a least-privilege OS sandbox. Remote sudo I/O recording can capture stdin; Relmio therefore excludes credential-bearing bridge operations from this mode. No sudo password, sudoers change or credential upload is part of the model path.

### Provider network and image notes

- **Hetzner:** complete any required first-login password change through normal approved administration. The Docker CE image lists Compose while n8n's older guide says it must be installed; observed `docker compose` capability wins. Do not run an OS upgrade on an existing n8n host as a companion setup step.
- **Contabo:** preserve the n8n add-on's existing Caddy/TLS and Docker deployment. Server SSH credentials and the n8n web login are separately managed; do not assume an initial shared password is still valid. Do not choose a provider **Reinstall** action to add a model.
- **AWS:** use the correct image's account; AWS's Oracle AMI hint is `ec2-user`, not OCI's `opc`. Check EC2 security groups or Lightsail's distinct IPv4/IPv6 firewalls and actual route from the Relmio backend. Lightsail's public-IP firewall does not govern private-IP traffic.
- **DigitalOcean:** a private Droplet needs a route already available to the Relmio backend; choosing agent authentication does not implement a bastion. n8n's sudo-user recipe does not prove passwordless sudo.
- **OCI:** check VCN routing, NSGs/security lists and the guest firewall. Preserve provider iSCSI protections; do not flush firewall rules or apply generic UFW repair advice to OCI images.
- **All VM providers:** permit only the existing SSH port from the approved source, without changing n8n's established HTTPS access. Do not open `10531`, `11434` or a Docker TCP API. No host-published port is necessary for same-bridge traffic, but private networking still trusts the host administrator and other network members.

Provider firewall defaults differ: an attached empty Hetzner Cloud firewall allows outbound traffic while blocking inbound; Contabo's provider firewall does not restrict outbound; DigitalOcean empty inbound/outbound rules deny the corresponding direction. Check existing broad allows, explicit denies where supported, and guest rules rather than copying one provider's recipe to another.

### OCI Always Free is not guaranteed model hosting

The [current Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), retrieved 2026-09-26, states A1 allowances of **1,500 OCPU-hours and 9,000 GB-hours/month**, described as **2 OCPUs and 12 GB**. This differs from historical advice quoting 4 OCPUs/24 GB; it is not a claim that every existing tenancy has the same entitlement or has been resized. Check the current console and eligibility for your tenancy.

Home-region restrictions, out-of-host-capacity errors, shared boot/block storage allowances and idle reclamation apply. Do not promise availability, indefinite retention, a permanently free production model server, or generate artificial usage to avoid reclamation. The 1 GB E2 micro is not a sensible co-resident model baseline. A larger A1 allocation is only a candidate after native arm64 compatibility, current memory/disk reserves and real inference have been checked. Keep independent backups under your own retention policy.

## Model choices are not provider sizing guarantees

The current allowlist has five Qwen models. The KVM mappings below are cautious workflow-model starting choices based on advertised tier memory and separately estimated model allowances; they are not vendor or Relmio performance guarantees. Relmio checks the selected Docker engine's measured memory and CPU capacity plus available disk against its reviewed budget, not the VPS marketing label.

Across Hetzner, Contabo, AWS, Droplets and OCI, use the same **unmeasured planning
estimates**, then let actual resource checks and workflow inference decide:
1–2 GB total co-resident host RAM is not a recommended baseline; about 4 GB
with very light n8n is a tiny `qwen3:0.6b` experiment; about 8 GB can give
`qwen3:1.7b` or `qwen3.5:2b` room only after n8n/database/OS reserves. Larger
16/32 GB hosts are candidates for the table's 4B/9B allowances, not automatic
model assignments. Shared versus dedicated vCPU changes predictability, not
a guaranteed token rate. Native arm64 is relevant to Hetzner CAX, supported
AWS Arm images and OCI A1; exact runtime-image support must still match.

| Example plan | Advertised capacity | Suggested catalog start | Catalog memory allowance / context | Notes |
|---|---|---|---|---|
| Hostinger KVM 1 | 1 vCPU / 4 GB | `qwen3:0.6b` · Q4_K_M · 0.523 GB download | ~2 GiB / 2,048 tokens | Experiment or low-volume short extraction; very limited headroom and response quality. |
| Hostinger KVM 2 | 2 vCPU / 8 GB | `qwen3.5:2b` · Q8_0 · 2.741 GB download | ~5 GiB / 4,096 tokens | Light n8n workloads only; `qwen3:1.7b` is a smaller alternative if engine capacity is tight. |
| Hostinger KVM 4 | 4 vCPU / 16 GB | `qwen3.5:4b` · Q4_K_M · 3.390 GB download | ~7 GiB / 4,096 tokens | Keep headroom for n8n, OS, Docker, databases, other containers and workload peaks. |
| Hostinger KVM 8 | 8 vCPU / 32 GB | `qwen3.5:9b` · Q4_K_M · 6.594 GB download | ~11 GiB / 8,192 tokens | Larger model does not imply GPU-class throughput; consider the smaller model for interactive latency. |

Model allowances are conservative, unmeasured catalog planning values—not minimums, measured peak RSS, or a throughput promise. Actual memory depends on runtime, context, prompt, concurrency, Docker's allocation and other services. Quantization and download-size figures are point-in-time Ollama registry observations from 2026-09-26. Every model download is separate from the Ollama container image. No model or Hostinger plan has a guaranteed tokens/second result. Shared vCPU performance varies; measure the chosen workflow on the purchased instance.

Hostinger's [VPS page](https://www.hostinger.com/vps-hosting) advertised KVM 1/2/4/8 with 1/2/4/8 vCPU and 4/8/16/32 GB RAM at retrieval. Its KVM VPS is CPU-based compute; Hostinger's separate GPU products are not GPU allocation on these KVM plans. Do not infer a guest's exact EPYC SKU or AVX feature exposure from marketing hardware. Other providers' tier capacity, regional availability, and total prices change independently.

These figures cover a workflow model only. n8n, its database, OS, Docker, and optional services consume capacity first. The [AI Assistant guidance](ai-assistant.md) gives a separate 4 GB RAM / 2 vCPU planning floor for n8n plus its privileged sandbox companion; it is not an estimate that the sandbox and a model both fit in that allocation. Budget and observe n8n/OS, sandbox if enabled, and model separately. n8n recommends Daytona for production sandboxing; Relmio does not provision Daytona.

## Render manual private model service

**This is operator-managed guidance, not a Relmio adapter, tested Render deployment or one-click Blueprint.** Render's service SSH does not provide the host Docker daemon or existing Docker bridge that the managed installer requires. An `onrender.com` URL is a public web-service address, not a Docker-host SSH address. Installing a Docker CLI or trying sudo inside a service does not change that boundary.

A separate **paid private service** can run Ollama for an existing Render n8n deployment. Keep n8n's image, start command, database and infrastructure unchanged. After validation, the operator manually chooses a model endpoint in an n8n credential/node; Relmio does not perform that configuration.

### Create only the model service

1. In Render choose **New → Private Service → Existing Image**. Use the same workspace and region as n8n's request-executing service, including queue workers, and an environment whose private-network rules permit that traffic. Do not relax environment isolation automatically.
2. Use a reviewed `linux/amd64` Ollama image digest. The managed catalog currently uses `docker.io/ollama/ollama:0.34.4@sha256:8262851b2846b87c649eddf3e76beb270c52f4d1bc94559f47efde16b0841551`; verify the selected image against Render's current image requirements. Do not deploy an arm64-only laptop build.
3. Choose paid CPU/RAM capacity for **the model service itself**, separate from n8n's quota. As unmeasured starting estimates, 2 GB is a tight tiny `qwen3:0.6b` experiment, 4 GB gives that tiny model more room, and 8 GB is a more defensible start for `qwen3.5:2b`. Its current Q8_0 weights alone are about 2.741 GB; a 2 GB service is not a credible baseline. No plan guarantees latency, peak-memory fit or GPU acceleration.
4. Attach the model service's **own** persistent disk at `/var/data`. Set the environment below and preserve the image's normal `ollama serve` startup. The disk is not n8n's disk and cannot be shared with another helper service.

```text
OLLAMA_HOST=0.0.0.0:11434
OLLAMA_MODELS=/var/data/models
OLLAMA_NO_CLOUD=1
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_NUM_PARALLEL=1
OLLAMA_CONTEXT_LENGTH=2048
OLLAMA_KEEP_ALIVE=5m
```

Binding to `0.0.0.0` here is inside a Render **private service**, which has no public `onrender.com` URL. It is not an instruction to publish a Docker host port. `OLLAMA_NO_CLOUD=1` disables cloud inference/search, not outbound image/model downloads. “Local model” means inference on the Render-hosted machine, not on your laptop.

### Acquire weights at runtime and prove inference

After the Ollama server starts, use that model service's permitted **runtime** shell to run:

```sh
ollama pull qwen3:0.6b
ollama list
ollama run qwen3:0.6b "Reply with the result of 2 + 2."
```

Use the exact intended model ID; the two-billion catalog choice is `qwen3.5:2b`, not `qwen3:2b`. Confirm shell support for the chosen model image. Do not modify n8n to obtain a shell. These upstream commands acquire a mutable tag; they do **not** apply Relmio's managed catalog digest/quantization attestation. Record and verify the intended model identity yourself before treating the manual service as accepted.

The disk exists only at service runtime, not in a build or pre-deploy command. Do not use an ephemeral shell, one-off job or separate helper service expecting the live disk to be mounted there. Render also documents an `initialDeployHook` after the first successful deploy for disk initialization, but Relmio supplies no auto-deploy Blueprint or hook lifecycle manager. Do not block server port readiness on a large download.

A listening port or `ollama list` is insufficient. Require a real, bounded response from the exact selected model, then test Chat Completions from an authorized service on the same private network:

```sh
curl --fail-with-body --silent --show-error --max-time 300 \
  http://ACTUAL_INTERNAL_MODEL_HOST:11434/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --data '{"model":"qwen3:0.6b","messages":[{"role":"user","content":"Reply with exactly: 4"}],"reasoning_effort":"none","max_tokens":64,"stream":false}'
```

Replace `ACTUAL_INTERNAL_MODEL_HOST` with the model service's **Connect → Internal / Service Address** value. Inspect a nonempty, correct visible answer—not only HTTP success—and measure cold and warm latency and memory on the chosen service. This fixed smoke prompt is not certification for autonomous tools or reliable workflow reasoning. The example's five-minute client deadline is a test bound, not a Render timeout guarantee.

Configure the n8n OpenAI-compatible credential/node manually:

```text
Base URL: http://ACTUAL_INTERNAL_MODEL_HOST:11434/v1
API key: ollama (ignored nonsecret placeholder)
Model: exact acquired model ID
Use Responses API: Off
```

Do not use `localhost`, `n8n-local-model` (the managed Docker alias), or an invented `.onrender.com` URL. Set bounded output and n8n's request timeout from observed cold/warm inference. Test one workflow from its actual executing worker; the laptop wizard cannot establish Render-private DNS reachability. A free n8n web service can initiate private requests to a paid same-region service, but retains its own spin-down and reliability limits.

### Operating and security limits

- There is no free private-service tier, and free web services cannot attach the required persistent disk. Price the model compute, disk, n8n/database, workspace and traffic separately using current rates; no static cheapest-provider claim is made here.
- Persistent disks belong to one instance of one service, prevent horizontal scaling beyond that instance, and disable zero-downtime deploys. Updates stop the old instance before its replacement; cached weights persist, loaded RAM does not. Size for partial downloads and retained versions as well as final weights.
- Private-service health is TCP-only, not an inference probe. Do not set a web-only `healthCheckPath` or equate Render's healthy status with model readiness. Render's automatic restart behavior differs from Relmio's managed Docker `restart: no` contract.
- Ollama may unload an idle model; a paid service and a persistent disk do not eliminate cold loading. CPU quota, contention, context and concurrency affect practical latency. No universal private-network inference timeout or tokens/second promise is established here.
- Ollama's local API ignores the key placeholder. Permitted private-network peers and the host/platform administrator remain trusted, including for model-management calls. Do not place untrusted services in that trust domain or expose the model publicly to make probing easier.
- Failed acquisition requires explicit runtime inspection and retry. Preserve the cache by default; deleting a service/disk/cache is a separate destructive operator decision, not automatic recovery. Relmio does not own Render status, restart, removal or rollback.

Render's privileged Docker-in-Docker Assistant runner feasibility is separate from unprivileged Ollama inference. This manual architecture does not provide that sandbox, an OAuth bridge, or approval for any provider credential use.

## Cost comparisons

Do not choose a “cheapest AWS” plan from an instance sticker price. A usable comparison needs the region, OS, CPU/RAM, storage, IPv4, backups, bandwidth, egress, taxes, runtime duration, model-download traffic and any database/services in scope. This research did not calculate total workload costs across AWS, Hostinger, Hetzner, or Render. Fargate's task pricing cannot be compared as a turnkey substitute when the current installer cannot deploy there.

## Sources and retrieval limits

Platform facts are from the following primary sources retrieved 2026-09-26. They establish the cited product networking or access shape, not Relmio support by themselves:

- Hetzner: [Cloud SSH](https://docs.hetzner.com/cloud/servers/getting-started/connecting-to-the-server/), [Docker CE](https://docs.hetzner.com/cloud/apps/list/docker-ce/), [hardware](https://docs.hetzner.com/cloud/technical-details/faq/), [firewalls](https://docs.hetzner.com/cloud/firewalls/overview/), [n8n guide](https://docs.n8n.io/deploy/host-n8n/install-options/use-a-cloud-provider/deploy-to-hetzner.md).
- Contabo: [first login](https://help.contabo.com/en/support/solutions/articles/103000271271-how-do-i-connect-to-my-contabo-server-for-the-first-time-), [SSH setup](https://help.contabo.com/en/support/solutions/articles/103000271398-how-do-i-set-up-an-ssh-connection-), [n8n add-on](https://help.contabo.com/en/support/solutions/articles/103000368853-what-is-n8n-and-how-do-i-use-it-on-contabo-), [firewall](https://help.contabo.com/en/support/solutions/articles/103000390430-firewall-what-is-it-and-how-does-it-protect-my-vps-vds-).
- AWS: [EC2 users](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/managing-users.html), [host fingerprints](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connection-prereqs-general.html), [Lightsail terminal SSH](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-ssh-using-terminal.html), [Lightsail firewall](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html), [Docker installation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-docker.html), [Fargate differences](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html), [ECS EC2 networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking.html), [ECS Exec](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html).
- DigitalOcean: [Droplet SSH](https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/), [Docker 1-Click](https://docs.digitalocean.com/products/marketplace/catalog/docker/), [firewalls](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/), [n8n guide](https://docs.n8n.io/deploy/host-n8n/install-options/use-a-cloud-provider/deploy-to-digital-ocean.md), [App Platform routing](https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/).
- Oracle: [platform images](https://docs.oracle.com/en-us/iaas/Content/Compute/References/images.htm), [SSH](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/connect-to-linux-instance.htm), [Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Podman Compose tutorial](https://docs.oracle.com/en/learn/ol-podman-compose/), [security lists](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm).
- Render: [SSH](https://render.com/docs/ssh), [private services](https://render.com/docs/private-services), [private network](https://render.com/docs/private-network), [disks](https://render.com/docs/disks), [image deployment](https://render.com/docs/deploying-an-image), [health checks](https://render.com/docs/health-checks), [deploys](https://render.com/docs/deploys), [initial deploy hook](https://render.com/docs/blueprint-spec#initialdeployhook), [free limits](https://render.com/docs/free), [compute plans](https://render.com/docs/compute-plans).
- Docker: [Ubuntu Engine](https://docs.docker.com/engine/install/ubuntu/), [Compose plugin](https://docs.docker.com/compose/install/linux/), [root-equivalent Docker group](https://docs.docker.com/engine/install/linux-postinstall/), [bridge networking](https://docs.docker.com/engine/network/drivers/bridge/), [port publishing and direct routing](https://docs.docker.com/engine/network/port-publishing/). Agent behavior: [OpenSSH ssh-agent](https://man.openbsd.org/ssh-agent).
- Ollama: [Docker](https://docs.ollama.com/docker), [CLI](https://docs.ollama.com/cli), [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [model storage, cloud controls and concurrency](https://docs.ollama.com/faq). n8n: [Chat Model timeout](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/#timeout), [Assistant setup](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant.md), [Cloud](https://docs.n8n.io/deploy/use-n8n-cloud/).
- Other platform shapes: [Railway private networking](https://docs.railway.com/networking/private-networking), [Fly private networking](https://fly.io/docs/networking/private-networking/). Sizing context: [Hostinger VPS requirements](https://www.hostinger.com/tutorials/n8n-vps-requirements/).

No provider deployment, native Windows agent session, VM inference benchmark or Render workflow was run for this documentation research. Capability checks and a successful bounded inference remain required on the actual target. See [VPS and n8n](vps-and-n8n.md), [Local models](local-models.md), and the [separate Linux acceptance harness](maintenance.md#linux-local-model-acceptance-harness).

### Catalog source links

The hosting page links the reviewed official product docs for the selected
provider; generated instructions include that provider's links as well as
component sources. The 15 Linux VM preset sources include
[Docker Engine for generic Linux](https://docs.docker.com/engine/install/ubuntu/),
[Hostinger Docker VPS](https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/),
[Hetzner Cloud SSH](https://docs.hetzner.com/cloud/servers/getting-started/connecting-to-the-server/),
[Contabo first connection](https://help.contabo.com/en/support/solutions/articles/103000271271-how-do-i-connect-to-my-contabo-server-for-the-first-time-),
[AWS EC2 users](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/managing-users.html),
[Lightsail SSH](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-ssh-using-terminal.html),
[DigitalOcean Droplet SSH](https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/),
[OCI SSH users](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/connect-to-linux-instance.htm),
[GCE OS Login](https://docs.cloud.google.com/compute/docs/oslogin),
[Azure Linux VM FAQ](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/faq),
[Akamai Docker Quick Deploy](https://techdocs.akamai.com/quick-deploy-apps/docs/docker),
[Vultr provisioning](https://docs.vultr.com/products/compute/instances/cloud-compute/provisioning),
[OVHcloud VPS first login](https://docs.ovhcloud.com/en/guides/bare-metal-cloud/virtual-private-servers/starting-with-a-vps),
[Scaleway Instance connection](https://www.scaleway.com/en/docs/instances/how-to/connect-to-instance/),
and [UpCloud Docker on Cloud Server](https://upcloud.com/global/resources/tutorials/running-containers-with-docker-on-upcloud-a-complete-guide/).

Manual product schemas and boundaries reference
[Render private services and disks](https://render.com/docs/private-services),
[Railway private networking and volumes](https://docs.railway.com/networking/private-networking),
[Fly private networking and volumes](https://docs.fly.io/networking/private-networking/),
[DigitalOcean App Platform limits](https://docs.digitalocean.com/products/app-platform/details/limits/),
[ECS task definitions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html),
[ECS Fargate security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-tasks-containers.html),
[EKS Fargate restrictions](https://docs.aws.amazon.com/eks/latest/userguide/fargate.html),
[GKE cluster modes](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/choose-cluster-mode),
[AKS pod security](https://learn.microsoft.com/en-us/azure/aks/developer-best-practices-pod-security),
[Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)
and [service-to-service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service),
[Azure Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview)
and [storage](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts),
[ACI private networking](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-vnet)
and [Azure Files](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-volume-azure-files),
[Lightsail Container schema](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_Container.html),
[Cloudflare Containers](https://developers.cloudflare.com/containers/),
[n8n Cloud](https://docs.n8n.io/deploy/use-n8n-cloud/),
[Vercel Functions](https://vercel.com/docs/functions/runtimes),
[Netlify Functions](https://docs.netlify.com/build/functions/overview/),
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [n8n Assistant / Daytona setup](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant/).
Search artifacts follow the [SearXNG JSON API](https://docs.searxng.org/dev/search_api.html);
manual model acquisition uses the [Ollama pull API](https://docs.ollama.com/api/pull).
