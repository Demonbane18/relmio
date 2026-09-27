// Hosting product identity is guidance, never an SSH or Docker capability attestation.
const reviewedOn = "2026-09-26";
const capability = (mode, note) => ({ mode, note });
const unavailable = (note) => capability("unavailable", note);
const manual = (note) => capability("manual", note);
const external = (note) => capability("external", note);
const source = (label, url) => ({ label, url });
const sshPolicy = "Use the actual image account and the existing approved SSH authentication. A verified passwordless sudo -n login can manage the model only; the bridge, Assistant, SearXNG and SuperGrok require already-approved direct UID 0. Never change SSH policy for a provider label.";
const managedComponents = {
  model: capability("managed", "Requires the existing rootful Docker/Compose/Buildx host contract, eligible n8n network and resource checks; sudo -n is model-only."),
  openai: capability("managed", "Experimental subscription bridge; direct UID-0 login, appropriate provider credential sign-in and separate permission review are required. No OpenAI Platform key or account entitlement is implied."),
  assistant: capability("managed", "Direct UID-0 login, operator-enabled instance-ai and an approved privileged Docker-in-Docker runner are required; n8n remains untouched."),
  searxng: capability("managed", "Optional private SearXNG with JSON search is installed through Assistant companion opt-in; direct UID-0 login, reachable n8n backend and permitted upstream search traffic are required."),
  supergrok: capability("managed", "Experimental private Grok CLI companion needs direct UID-0 login, fresh device authentication and account entitlement."),
};
const localComponents = {
  model: capability("managed", "Local Docker model requires the actual supported Engine, architecture, eligible existing n8n network and available memory/disk; no VPS SSH."),
  openai: capability("managed", "Local experimental OpenAI subscription bridge uses its own provider sign-in and permission review, not a Platform API key or VPS SSH."),
  assistant: capability("managed", "Local Assistant tools need operator-enabled instance-ai and an approved privileged Docker-in-Docker runner; existing n8n stays untouched."),
  searxng: capability("managed", "Optional local private JSON-enabled search is available through Assistant companion opt-in; n8n backend reachability and permitted upstream engines are required."),
  supergrok: capability("managed", "Local experimental SuperGrok companion requires fresh official device login and actual account entitlement."),
};

function vm(id, label, sshHint, sources) {
  return { id, label, kind: "managed-vm", sshHint: `${sshHint} ${sshPolicy}`, components: managedComponents, sources, reviewedOn };
}

const daytona = manual("Operator configures n8n's documented external Daytona sandbox; no Relmio runner install, n8n edit or restart. Daytona account and separate model configuration are required.");
const privateModel = manual("Operator-deployed private Ollama service and model acquisition; selected model tag is mutable and runtime inference remains untested.");
const privateSearch = manual("Operator-deployed private JSON-enabled SearXNG service; n8n must reach it and search upstream access remains conditional.");
const platformBridge = unavailable("No managed OpenAI subscription credential bridge on this platform; do not copy a subscription credential into an artifact.");
const platformGrok = unavailable("No managed SuperGrok CLI companion on this platform; do not copy a subscription session into an artifact.");

function platform(id, label, sources, { model = privateModel, searxng = privateSearch, assistant = daytona, sshHint = "This product is not a customer-administered Docker VM; use the reviewed manual deployment, not the managed SSH form." } = {}) {
  return { id, label, kind: "manual-platform", sshHint, components: { model, openai: platformBridge, assistant, searxng, supergrok: platformGrok }, sources, reviewedOn };
}

function endpoint(id, label, sources, note, sshHint = "This product does not provide Relmio's managed host SSH and rootful Docker contract.") {
  return { id, label, kind: "external-only", sshHint, components: {
    model: unavailable("Use a separate reachable, authenticated model endpoint; this product has no managed private Ollama deployment here."),
    openai: platformBridge,
    assistant: unavailable("No native Relmio sandbox runner installation or self-hosted n8n Assistant configuration on this product."),
    searxng: unavailable("Use an independently deployed authenticated search endpoint; no managed SearXNG installation here."),
    supergrok: platformGrok,
    endpoint: manual(note),
  }, sources, reviewedOn };
}

function sandbox(id, label, sources, note) {
  return { id, label, kind: "external-only", sshHint: "An SDK sandbox is not a host VM or a native n8n sandbox provider; do not enter its service credentials in the managed SSH form.", components: {
    model: unavailable("No managed persistent Ollama deployment in this SDK sandbox lane."),
    openai: platformBridge,
    assistant: external(note),
    searxng: unavailable("No managed private SearXNG deployment in this SDK sandbox lane."),
    supergrok: platformGrok,
  }, sources, reviewedOn };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export const HOSTING_PROVIDERS = deepFreeze([
  vm("generic", "Generic Linux VM", "Use your Linux image's real login; a provider name cannot establish Docker, n8n, root access, disk or network eligibility.", [source("Docker Engine installation", "https://docs.docker.com/engine/install/ubuntu/"), source("n8n Docker Compose", "https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose/")]),
  vm("hostinger", "Hostinger KVM VPS", "Hostinger's VPS Docker template shows a root login, but preserve your actual chosen account; do not confuse VPS with managed web hosting.", [source("Hostinger Docker VPS template", "https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/"), source("Hostinger VPS SSH keys", "https://www.hostinger.com/support/4792364-how-to-use-ssh-keys-at-hostinger-vps/")]),
  vm("hetzner", "Hetzner Cloud Server", "Hetzner documents root SSH for standard Cloud servers; custom images and hardened accounts may differ. Do not assume the Docker app includes Buildx.", [source("Hetzner SSH connection", "https://docs.hetzner.com/cloud/servers/getting-started/connecting-to-the-server/"), source("Hetzner Docker app", "https://docs.hetzner.com/cloud/apps/list/docker-ce/")]),
  vm("contabo", "Contabo Linux VPS / VDS", "Use the actual username from your delivery details; a delivered root password is not approval to enable password login or proof of an SSH key.", [source("Contabo first connection", "https://help.contabo.com/en/support/solutions/articles/103000271271-how-do-i-connect-to-my-contabo-server-for-the-first-time-"), source("Contabo SSH keys", "https://help.contabo.com/en/support/solutions/articles/103000271398-how-do-i-set-up-an-ssh-connection-")]),
  vm("aws", "AWS EC2 Linux VM", "Amazon Linux commonly uses ec2-user and Ubuntu commonly uses ubuntu. Default root SSH is disabled; sudo ability is not direct-root SSH. ECS is a separate product.", [source("EC2 Linux users", "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/managing-users.html")]),
  vm("lightsail", "AWS Lightsail Linux VM", "Lightsail blueprint logins vary: Ubuntu ubuntu, Amazon Linux ec2-user, Debian admin and Bitnami bitnami. Do not confuse this VM with Lightsail Containers.", [source("Lightsail SSH clients and usernames", "https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-ssh-using-terminal.html")]),
  vm("digitalocean", "DigitalOcean Droplet", "Most official Linux Droplet images initially use root; custom/administrator-created accounts differ. App Platform is not a Droplet.", [source("Droplet SSH connection", "https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/"), source("Docker Droplet app", "https://docs.digitalocean.com/products/marketplace/catalog/docker/")]),
  vm("oci", "Oracle OCI Compute VM", "Oracle Linux commonly uses opc and Ubuntu commonly uses ubuntu; direct root SSH is disabled by default. OCI capacity and Docker Engine remain target-specific.", [source("OCI Linux SSH users", "https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/connect-to-linux-instance.htm"), source("OCI root policy", "https://docs.oracle.com/en-us/iaas/oracle-linux/oci/troubleshooting-permissions.htm")]),
  vm("gce", "Google Compute Engine VM", "OS Login can derive the actual username and separates user/admin roles; Google recommends sudo instead of enabling root login. Browser/gcloud/IAP login is not automatically supported SSH authentication.", [source("Compute Engine root SSH guidance", "https://docs.cloud.google.com/compute/docs/connect/root-ssh"), source("Compute Engine OS Login", "https://docs.cloud.google.com/compute/docs/oslogin")]),
  vm("azure-vm", "Azure Linux VM", "Azure's administrator username is operator-selected and cannot be root at VM creation; temporary disk is not durable state. Do not use VMAccess to change the account policy for Relmio.", [source("Azure Linux VM FAQ", "https://learn.microsoft.com/en-us/azure/virtual-machines/linux/faq")]),
  vm("linode", "Akamai / Linode Compute VM", "Docker Quick Deploy has a chosen limited sudo user; keys may also be on root unless root access was disabled. Ordinary sudo is not verified sudo -n.", [source("Akamai Docker Quick Deploy", "https://techdocs.akamai.com/quick-deploy-apps/docs/docker")]),
  vm("vultr", "Vultr Cloud Compute VM", "Limited User Login chooses linuxuser with sudo instead of root. Preserve that choice and verify sudo -n for model-only access.", [source("Vultr Cloud Compute provisioning", "https://docs.vultr.com/products/compute/instances/cloud-compute/provisioning")]),
  vm("ovh", "OVHcloud VPS / Public Cloud VM", "Stock VPS login follows its OS (ubuntu/debian/rocky), with root disabled by default. Public Cloud username is also image-specific and sudo does not authorize a direct-root companion login.", [source("OVHcloud VPS first login", "https://docs.ovhcloud.com/en/guides/bare-metal-cloud/virtual-private-servers/starting-with-a-vps"), source("OVHcloud Public Cloud compute", "https://docs.ovhcloud.com/en/guides/public-cloud/compute/getting-started")]),
  vm("scaleway", "Scaleway Linux Instance", "Scaleway documents a root login using an uploaded key; image architecture and all selected component images must match.", [source("Scaleway Instance connection", "https://www.scaleway.com/en/docs/instances/how-to/connect-to-instance/")]),
  vm("upcloud", "UpCloud Cloud Server", "The Ubuntu Docker tutorial uses root with an SSH key; custom images or hardened hosts may use another actual login.", [source("UpCloud Docker on Cloud Server", "https://upcloud.com/global/resources/tutorials/running-containers-with-docker-on-upcloud-a-complete-guide/")]),
  { id: "local", label: "Local Docker", kind: "local", sshHint: "Use the local Docker wizard, not VPS SSH. Its OS/Engine/architecture checks and component-specific prerequisites still apply.", components: localComponents, sources: [source("n8n Docker Compose", "https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose/"), source("Ollama CPU Docker", "https://docs.ollama.com/docker")], reviewedOn },
  platform("render", "Render private services", [source("Render private services", "https://render.com/docs/private-services"), source("Render persistent disks", "https://render.com/docs/disks"), source("Render Blueprint spec", "https://render.com/docs/blueprint-spec")]),
  platform("railway", "Railway services", [source("Railway private networking", "https://docs.railway.com/networking/private-networking"), source("Railway volumes", "https://docs.railway.com/volumes"), source("Railway infrastructure as code", "https://docs.railway.com/infrastructure-as-code")]),
  platform("fly", "Fly.io Machines", [source("Fly private networking", "https://docs.fly.io/networking/private-networking/"), source("Fly volumes", "https://docs.fly.io/volumes/overview/"), source("Fly app configuration", "https://docs.fly.io/reference/configuration/")]),
  platform("digitalocean-app", "DigitalOcean App Platform", [source("App Platform limits", "https://docs.digitalocean.com/products/app-platform/details/limits/"), source("App Platform internal routing", "https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/")], { model: unavailable("App Platform has no persistent volume; use an authenticated external model endpoint or a Droplet, not a durable Ollama cache claim.") }),
  platform("ecs-ec2", "Amazon ECS on EC2", [source("ECS task networking", "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking-awsvpc.html"), source("ECS EFS volumes", "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html")]),
  platform("ecs-fargate", "Amazon ECS Fargate", [source("ECS Fargate task parameters", "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html"), source("ECS container privilege", "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-tasks-containers.html")]),
  platform("eks", "Amazon EKS on EC2", [source("EKS Pod Security", "https://docs.aws.amazon.com/eks/latest/best-practices/pod-security.html"), source("n8n AWS hosting guide", "https://docs.n8n.io/deploy/host-n8n/install-options/use-a-cloud-provider/deploy-to-aws.md")]),
  platform("eks-fargate", "Amazon EKS Fargate", [source("EKS Fargate restrictions", "https://docs.aws.amazon.com/eks/latest/userguide/fargate.html")]),
  platform("gke", "Google GKE Standard", [source("GKE cluster modes", "https://docs.cloud.google.com/kubernetes-engine/docs/concepts/choose-cluster-mode"), source("n8n GKE guide", "https://docs.n8n.io/deploy/host-n8n/install-options/use-a-cloud-provider/deploy-to-google-kubernetes.md")]),
  platform("gke-autopilot", "Google GKE Autopilot", [source("GKE Autopilot privileged workload policies", "https://docs.cloud.google.com/kubernetes-engine/docs/concepts/about-autopilot-privileged-workloads")]),
  platform("aks", "Azure AKS", [source("AKS Pod security", "https://learn.microsoft.com/en-us/azure/aks/developer-best-practices-pod-security"), source("n8n Azure guide", "https://docs.n8n.io/deploy/host-n8n/install-options/use-a-cloud-provider/deploy-to-azure.md")]),
  platform("cloud-run", "Google Cloud Run", [source("Cloud Run container contract", "https://docs.cloud.google.com/run/docs/container-contract"), source("Cloud Run service authentication", "https://docs.cloud.google.com/run/docs/authenticating/service-to-service")]),
  platform("azure-container-apps", "Azure Container Apps", [source("Container Apps ingress", "https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview"), source("Container Apps storage", "https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts")]),
  platform("azure-container-instances", "Azure Container Instances", [source("ACI Azure Files volumes", "https://learn.microsoft.com/en-us/azure/container-instances/container-instances-volume-azure-files"), source("ACI private networking", "https://learn.microsoft.com/en-us/azure/container-instances/container-instances-vnet")]),
  platform("lightsail-containers", "AWS Lightsail Containers", [source("Lightsail container services", "https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services.html"), source("Lightsail container schema", "https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_Container.html")], { model: unavailable("No persistent mutable model-volume contract in Lightsail Containers; use Lightsail VM or an approved authenticated external model."), searxng: privateSearch }),
  platform("cloudflare-containers", "Cloudflare Containers", [source("Cloudflare Containers overview", "https://developers.cloudflare.com/containers/"), source("Cloudflare Containers limits", "https://developers.cloudflare.com/containers/platform/limits/")], { model: unavailable("Container disk is ephemeral; no durable Ollama cache/manual model profile here."), assistant: unavailable("Cloudflare Containers do not support the current privileged DinD n8n runner; no Daytona handoff profile for this product."), searxng: manual("JSON-enabled SearXNG in a Container behind a path-restricted authenticated Worker; off-platform n8n uses an HTTP Request tool, not a native Assistant header-auth setting.") }),
  endpoint("n8n-cloud", "n8n Cloud external connection", [source("n8n Cloud", "https://docs.n8n.io/deploy/use-n8n-cloud/"), source("n8n Ollama credential", "https://docs.n8n.io/integrations/builtin/credentials/ollama.md")], "Operator connection handoff to an existing reachable authenticated model/search endpoint. n8n Cloud's native Assistant availability is provider-managed, not this self-hosted sandbox."),
  endpoint("vercel", "Vercel Functions HTTP integration", [source("Vercel Functions runtimes", "https://vercel.com/docs/functions/runtimes"), source("Vercel container images", "https://vercel.com/docs/functions/container-images")], "Restricted authenticated HTTP endpoint proxy to an existing service, not a persistent host n8n/Ollama stack."),
  endpoint("netlify", "Netlify Functions HTTP integration", [source("Netlify Functions", "https://docs.netlify.com/build/functions/overview/"), source("Netlify private connectivity", "https://docs.netlify.com/manage/security/private-connectivity/")], "Restricted authenticated HTTP endpoint proxy to an existing service; ephemeral Functions are not an always-on model host."),
  endpoint("cloudflare-workers", "Cloudflare Workers HTTP integration", [source("Workers limits", "https://developers.cloudflare.com/workers/platform/limits/"), source("Workers service bindings", "https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/")], "Restricted authenticated Worker proxy to an existing HTTP service, not host Docker or private raw Ollama publication."),
  sandbox("vercel-sandbox", "Vercel Sandbox SDK (external alternative)", [source("Vercel Sandbox", "https://vercel.com/docs/sandbox")], "Separate on-demand code execution SDK, not a native n8n SANDBOX_PROVIDER or a 24/7 host; requires a purpose-built authenticated lifecycle adapter."),
  sandbox("railway-sandbox", "Railway Sandbox SDK (external alternative)", [source("Railway Sandboxes", "https://docs.railway.com/sandboxes")], "Separate SDK-managed VM product, not Railway service DinD or a native n8n SANDBOX_PROVIDER; integration and privilege policy are unestablished."),
  sandbox("cloudflare-sandbox", "Cloudflare Sandbox SDK (external alternative)", [source("Cloudflare Sandbox rootless Docker", "https://developers.cloudflare.com/sandbox/guides/docker-in-docker/")], "Rootless-only SDK sandbox; not the current privileged DinD runner and not a native n8n SANDBOX_PROVIDER."),
]);

const byId = new Map(HOSTING_PROVIDERS.map((provider) => [provider.id, provider]));

export function getHostingProvider(id) {
  if (typeof id !== "string" || !byId.has(id)) throw new RangeError("Unknown hosting provider.");
  return byId.get(id);
}
