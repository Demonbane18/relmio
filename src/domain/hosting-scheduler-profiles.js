import { LOCAL_MODEL_RUNTIME_IMAGE } from "./local-n8n-model.js";
import { modelEnvironment, searchEnvironment, createSearchImageFiles } from "./hosting-deployment-common.js";

// Field patterns also become HTML pattern attributes, which browsers compile
// with the `v` flag. Escape `-`, `(`, `)` and `/` inside character classes so
// both the `u` and `v` flags accept them.
const DNS_LABEL = "[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?";
const DNS_NAME = `^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`;
const ACCOUNT = "[0-9]{12}";
const AWS_REGION = "[a-z]{2}(?:-gov)?-[a-z]+-[0-9]";
const AWS_PARTITION = "aws(?:-us-gov|-cn)?";
const ECS_CLUSTER_ARN = new RegExp(`^arn:(${AWS_PARTITION}):ecs:(${AWS_REGION}):(${ACCOUNT}):cluster/([A-Za-z0-9_\\-]{1,255})$`, "u");
const IAM_ROLE_ARN = new RegExp(`^arn:(${AWS_PARTITION}):iam::(${ACCOUNT}):role/(?:[A-Za-z0-9+=,.@_\\-]+/)*[A-Za-z0-9+=,.@_\\-]{1,64}$`, "u");
const DISCOVERY_ARN = new RegExp(`^arn:(${AWS_PARTITION}):servicediscovery:(${AWS_REGION}):(${ACCOUNT}):service/(srv-[A-Za-z0-9]{1,64})$`, "u");
const SECRET_ARN = new RegExp(`^arn:(${AWS_PARTITION}):secretsmanager:(${AWS_REGION}):(${ACCOUNT}):secret:([A-Za-z0-9\\/_+=.@\\-]{1,512})$`, "u");
const ECR_REPOSITORY = /^([0-9]{12})\.dkr\.ecr\.([a-z]{2}(?:-gov)?-[a-z]+-[0-9])\.amazonaws\.com\/([a-z0-9]+(?:[._\/\-][a-z0-9]+)*)$/u;
const GAR_REPOSITORY = /^[a-z][a-z0-9\-]*-docker\.pkg\.dev\/[a-z][a-z0-9\-]{4,28}[a-z0-9]\/[a-z][a-z0-9\-]{0,62}\/[a-z0-9]+(?:[._\/\-][a-z0-9]+)*$/u;
const ACR_REPOSITORY = /^[a-z0-9]{5,50}\.azurecr\.io\/[a-z0-9]+(?:[._\/\-][a-z0-9]+)*$/u;
const NAME_RE = new RegExp(DNS_NAME, "u");
const NAMESPACE_RE = new RegExp(`^${DNS_LABEL}$`, "u");
const LABEL_KEY_RE = /^(?:(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\/)?[A-Za-z0-9](?:[A-Za-z0-9_.\-]{0,61}[A-Za-z0-9])?$/u;
const LABEL_VALUE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.\-]{0,61}[A-Za-z0-9])?$/u;
const AWS_ID = /^(?:fs|fsap|subnet|sg)-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u;
const FILE = (name, value) => ({ name, content: `${JSON.stringify(value, null, 2)}\n`, mediaType: "application/json" });
const text = (name, label, pattern, description) => ({ name, label, type: "text", required: true, pattern, description });
const dockerImages = (component) => component === "model" ? [] : createSearchImageFiles();

function check(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError("A valid existing scheduler resource reference is required.");
  return value;
}

function kubeObjectName(value) {
  check(value, NAME_RE);
  if (value.length > 253) throw new TypeError("A Kubernetes resource name is too long.");
  return value;
}

function values(value, prefix, max) {
  if (typeof value !== "string") throw new TypeError("Existing private network IDs are required.");
  const parts = value.split(",").map(part => part.trim());
  if (!parts.length || parts.length > max || parts.some(part => !AWS_ID.test(part) || !part.startsWith(`${prefix}-`)) || new Set(parts).size !== parts.length) {
    throw new TypeError("Existing private network IDs must be valid and distinct.");
  }
  return parts;
}

function awsIdentity(inputs) {
  const cluster = check(inputs.clusterArn, ECS_CLUSTER_ARN).match(ECS_CLUSTER_ARN);
  const execution = check(inputs.executionRoleArn, IAM_ROLE_ARN).match(IAM_ROLE_ARN);
  const task = check(inputs.taskRoleArn, IAM_ROLE_ARN).match(IAM_ROLE_ARN);
  const discovery = check(inputs.discoveryServiceArn, DISCOVERY_ARN).match(DISCOVERY_ARN);
  if (execution[1] !== cluster[1] || task[1] !== cluster[1] || discovery[1] !== cluster[1] ||
      execution[2] !== cluster[3] || task[2] !== cluster[3] || discovery[3] !== cluster[3] || discovery[2] !== cluster[2]) {
    throw new TypeError("ECS resources must belong to the same partition, account and region.");
  }
  const subnets = values(inputs.subnetIds, "subnet", 16);
  const securityGroups = values(inputs.securityGroupIds, "sg", 5);
  const namespace = check(inputs.discoveryNamespace, NAME_RE);
  if (namespace.length > 253 || !namespace.includes(".")) throw new TypeError("An existing private Cloud Map DNS namespace is required.");
  return { region: cluster[2], account: cluster[3], subnets, securityGroups, namespace };
}

function repository(inputs, providerId, aws) {
  const value = inputs.searchRepository;
  const pattern = providerId.startsWith("ecs-") || providerId.startsWith("eks") ? ECR_REPOSITORY : providerId.startsWith("gke") ? GAR_REPOSITORY : ACR_REPOSITORY;
  const repo = check(value, pattern).match(pattern);
  if (value.length > 256 || (aws && (repo[1] !== aws.account || repo[2] !== aws.region))) throw new TypeError("The search repository must be a supported private registry in the selected account and region.");
  return value;
}

function capacity(model) {
  const gib = model.memoryBytes / 1024 ** 3;
  if (gib <= 2) return { cpu: 2048, memory: 4096, kubeCpu: "2", kubeMemory: "4Gi" };
  if (gib <= 6) return { cpu: 4096, memory: 8192, kubeCpu: "4", kubeMemory: "8Gi" };
  if (gib <= 14) return { cpu: 8192, memory: 16384, kubeCpu: "8", kubeMemory: "16Gi" };
  throw new RangeError("The selected model exceeds this reviewed scheduler resource profile.");
}

const ecsFields = [
  text("clusterArn", "Existing ECS cluster ARN", ECS_CLUSTER_ARN.source, "Cluster that will own only the new service."),
  text("executionRoleArn", "Existing task execution role ARN", IAM_ROLE_ARN.source, "Must authorize reviewed image pulls and, for search, Secrets Manager retrieval."),
  text("taskRoleArn", "Existing task role ARN", IAM_ROLE_ARN.source, "For model EFS IAM mount authorization."),
  text("subnetIds", "Private subnet IDs (comma-separated)", "^subnet-[0-9a-f]{8}(?:[0-9a-f]{9})?(?:\\s*,\\s*subnet-[0-9a-f]{8}(?:[0-9a-f]{9})?)*$", "Existing private subnets with approved outbound access; at most 16 distinct IDs."),
  text("securityGroupIds", "Task security group IDs (comma-separated)", "^sg-[0-9a-f]{8}(?:[0-9a-f]{9})?(?:\\s*,\\s*sg-[0-9a-f]{8}(?:[0-9a-f]{9})?)*$", "Existing groups allowing only the intended backend on the service port; at most five distinct IDs."),
  text("discoveryServiceArn", "Existing private Cloud Map service ARN", DISCOVERY_ARN.source, "Existing A-record service named for this generated companion in a private DNS namespace."),
  text("discoveryNamespace", "Existing private Cloud Map DNS namespace", DNS_NAME, "Exact private namespace DNS suffix of the supplied Cloud Map service."),
];
const ecsModelFields = [
  text("fileSystemId", "Existing EFS filesystem ID", "^fs-[0-9a-f]{8}(?:[0-9a-f]{9})?$", "Durable model cache, with reachable EFS mount target in the task VPC."),
  text("accessPointId", "Existing EFS access point ID", "^fsap-[0-9a-f]{8}(?:[0-9a-f]{9})?$", "Access point enforcing writable UID/GID 10001 and task-role IAM authorization."),
];
const ecsSearchFields = [
  text("searchRepository", "Existing private ECR repository URI", ECR_REPOSITORY.source, "Destination for the generated pinned derived search image; no image URL from arbitrary registries."),
  text("searchSecretArn", "Existing Secrets Manager secret ARN", SECRET_ARN.source, "Secret value is not requested or included in files; execution role reads it at runtime."),
];

function ecsPlan(context) {
  const { providerId, component, resourceName, model, inputs, deploymentId } = context;
  const aws = awsIdentity(inputs);
  if (resourceName !== `relmio-${component}-${deploymentId}` || !/^[0-9a-f]{12}$/u.test(deploymentId)) throw new TypeError("Invalid deployment identity.");
  const isModel = component === "model";
  const port = isModel ? 11434 : 8080;
  const budget = isModel ? capacity(model) : { cpu: 512, memory: 1024 };
  const image = isModel ? LOCAL_MODEL_RUNTIME_IMAGE : `${repository(inputs, providerId, aws)}:${deploymentId}`;
  const container = {
    name: resourceName,
    image,
    essential: true,
    user: isModel ? "10001:10001" : "977:977",
    portMappings: [{ containerPort: port, hostPort: port, protocol: "tcp" }],
    environment: Object.entries(isModel ? { ...modelEnvironment(model), HOME: "/var/data" } : searchEnvironment()).map(([name, value]) => ({ name, value: String(value) })),
  };
  const task = {
    family: resourceName,
    networkMode: "awsvpc",
    requiresCompatibilities: [providerId === "ecs-fargate" ? "FARGATE" : "EC2"],
    runtimePlatform: { operatingSystemFamily: "LINUX", cpuArchitecture: "X86_64" },
    cpu: String(budget.cpu), memory: String(budget.memory),
    executionRoleArn: inputs.executionRoleArn, taskRoleArn: inputs.taskRoleArn,
    containerDefinitions: [container],
  };
  if (isModel) {
    check(inputs.fileSystemId, /^fs-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u);
    check(inputs.accessPointId, /^fsap-[0-9a-f]{8}(?:[0-9a-f]{9})?$/u);
    container.mountPoints = [{ sourceVolume: "model-cache", containerPath: "/var/data", readOnly: false }];
    task.volumes = [{ name: "model-cache", efsVolumeConfiguration: {
      fileSystemId: inputs.fileSystemId, rootDirectory: "/", transitEncryption: "ENABLED",
      authorizationConfig: { accessPointId: inputs.accessPointId, iam: "ENABLED" },
    } }];
  } else {
    const secret = check(inputs.searchSecretArn, SECRET_ARN).match(SECRET_ARN);
    if (secret[1] !== inputs.clusterArn.match(ECS_CLUSTER_ARN)[1] || secret[2] !== aws.region || secret[3] !== aws.account) {
      throw new TypeError("The search secret must be in the ECS account and region.");
    }
    container.secrets = [{ name: "SEARXNG_SECRET", valueFrom: inputs.searchSecretArn }];
  }
  const service = {
    cluster: inputs.clusterArn,
    serviceName: resourceName,
    taskDefinition: resourceName,
    launchType: providerId === "ecs-fargate" ? "FARGATE" : "EC2",
    ...(providerId === "ecs-fargate" ? { platformVersion: "1.4.0" } : {}),
    desiredCount: 1,
    deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100 },
    networkConfiguration: { awsvpcConfiguration: { subnets: aws.subnets, securityGroups: aws.securityGroups, assignPublicIp: "DISABLED" } },
    serviceRegistries: [{ registryArn: inputs.discoveryServiceArn }],
  };
  const address = `http://${resourceName}.${aws.namespace}:${port}`;
  return {
    files: [FILE("task-definition.json", task), FILE("service.json", service), ...dockerImages(component)],
    settings: [],
    steps: [
      `Confirm ${resourceName} is unused as an ECS task family, service name and Cloud Map A-record service; verify the existing discovery ARN resolves ${resourceName}.${aws.namespace} privately.`,
      ...(isModel ? [] : [`Build the included pinned Dockerfile and push only its derived image as ${image} to the existing private ECR repository; inject the actual SearXNG_SECRET value into the referenced Secrets Manager secret outside Relmio.`]),
      "Review both files and all existing role, subnet, security group, EFS/discovery permissions; only after human confirmation register task-definition.json as a new task revision and create the new service from service.json. Do not update an existing n8n task or service.",
      ...(isModel ? [
        `From the approved private n8n backend, POST ${address}/api/pull with JSON ${JSON.stringify({ model: model.id, stream: false })}; wait for status success. A pull does not establish inference readiness.`,
        `Submit a fresh non-empty Chat Completions request with model ${model.id} to ${address}/v1/chat/completions; use ${address}/v1 with Responses disabled in a private n8n OpenAI-compatible credential.`,
      ] : [`From the approved private n8n backend, use HTTP Request ${address}/search?q=n8n&format=json and require a JSON results array.`]),
    ],
    connection: isModel ? { baseUrl: `${address}/v1`, modelId: model.id, responsesApi: false } : { searchUrl: `${address}/search?q=n8n&format=json` },
    requirements: [
      "Existing private subnets, task security groups allowing only approved backend ingress, registry egress, Cloud Map private A-record service and correctly routed n8n task/VPC DNS are required; no public IP or load balancer is generated.",
      "Task execution and task IAM roles must be approved. If n8n SSRF protection is enabled, its operator must approve the exact private destination without globally disabling protection.",
      ...(isModel ? ["Existing EFS filesystem, IAM-enabled access point enforcing writable UID/GID 10001, mount targets, NFS 2049 permissions and sufficient capacity are required."] : ["Existing private ECR repository and Secrets Manager secret with a real operator-set SEARXNG_SECRET are required; search cache is disposable."]),
    ],
    limitations: [
      "Operator-owned ECS/Cloud Map setup only; no deployment or inference was run. Private DNS and reachability must be verified from the actual n8n backend.",
      "The selected model tag is mutable at its upstream registry; this plan does not attest its downloaded manifest digest or measured CPU/memory fit.",
      "Sources: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html ; https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html ; https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html ; https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-discovery.html ; https://docs.ollama.com/api/pull",
    ],
  };
}

const kubeFields = [
  text("namespace", "Existing destination namespace", NAMESPACE_RE.source, "Existing namespace for only the new companion resources."),
  text("n8nNamespace", "Existing n8n pod namespace", NAMESPACE_RE.source, "Exact n8n workload namespace selected by kubernetes.io/metadata.name."),
  text("n8nPodLabelKey", "Existing n8n pod label key", LABEL_KEY_RE.source, "Actual n8n backend pod label key for restricted ingress."),
  text("n8nPodLabelValue", "Existing n8n pod label value", LABEL_VALUE_RE.source, "Actual n8n backend pod label value for restricted ingress."),
];
const kubeModelFields = [text("modelClaimName", "Existing model PVC name", NAME_RE.source, "Already-bound persistent PVC in the destination namespace; no claim or storage class is fabricated.")];
const kubeSearchFields = (providerId) => [
  text("searchRepository", "Existing private image repository", (providerId.startsWith("eks") ? ECR_REPOSITORY : providerId.startsWith("gke") ? GAR_REPOSITORY : ACR_REPOSITORY).source, "ECR, Artifact Registry or ACR repository for the derived pinned search image, according to provider."),
  text("searchSecretName", "Existing Kubernetes Secret name", NAME_RE.source, "Secret with key SEARXNG_SECRET in the destination namespace; secret contents stay outside generated files."),
];
const fargateFields = [
  text("fargateProfileName", "Existing EKS Fargate profile name", "^[A-Za-z0-9](?:[A-Za-z0-9_\\-]{0,61}[A-Za-z0-9])?$", "The approved existing Fargate profile must select this namespace and generated companion Pod label."),
  text("fargateSecurityGroupId", "Existing companion Pod security group ID", "^sg-[0-9a-f]{8}(?:[0-9a-f]{9})?$", "Dedicated existing security group whose inbound service port is restricted to the approved n8n caller security group."),
  text("n8nCallerSecurityGroupId", "Existing n8n caller security group ID", "^sg-[0-9a-f]{8}(?:[0-9a-f]{9})?$", "Existing group assigned to the actual n8n backend Pod ENI, used to review the companion security group's ingress rule."),
];
const fargateModelFields = [text("efsStaticPvName", "Existing statically provisioned EFS PV", NAME_RE.source, "Bound PV for modelClaimName must use efs.csi.aws.com static provisioning, not EBS or dynamic EFS.")];

function kubePlan(context) {
  const { providerId, component, model, inputs, resourceName, deploymentId } = context;
  if (resourceName !== `relmio-${component}-${deploymentId}` || !/^[0-9a-f]{12}$/u.test(deploymentId)) throw new TypeError("Invalid deployment identity.");
  const namespace = check(inputs.namespace, NAMESPACE_RE);
  const n8nNamespace = check(inputs.n8nNamespace, NAMESPACE_RE);
  const key = check(inputs.n8nPodLabelKey, LABEL_KEY_RE);
  const value = check(inputs.n8nPodLabelValue, LABEL_VALUE_RE);
  if (namespace.length > 63 || n8nNamespace.length > 63 || key.split("/")[0].length > 253) throw new TypeError("The namespace or selector is too long.");
  const onFargate = providerId === "eks-fargate";
  if (onFargate) {
    check(inputs.fargateProfileName, /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/u);
    values(inputs.fargateSecurityGroupId, "sg", 1);
    values(inputs.n8nCallerSecurityGroupId, "sg", 1);
    if (inputs.fargateSecurityGroupId === inputs.n8nCallerSecurityGroupId) throw new TypeError("The companion and caller security groups must be distinct.");
  }
  const isModel = component === "model";
  const port = isModel ? 11434 : 8080;
  const budget = isModel ? capacity(model) : { kubeCpu: "500m", kubeMemory: "1Gi" };
  if (isModel) kubeObjectName(inputs.modelClaimName);
  if (onFargate && isModel) kubeObjectName(inputs.efsStaticPvName);
  if (!isModel) kubeObjectName(inputs.searchSecretName);
  const repo = isModel ? null : repository(inputs, providerId);
  const image = isModel ? LOCAL_MODEL_RUNTIME_IMAGE : `${repo}:${deploymentId}`;
  const selector = { "app.kubernetes.io/instance": resourceName };
  const deployment = {
    apiVersion: "apps/v1", kind: "Deployment", metadata: { name: resourceName, namespace },
    spec: {
      replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: selector },
      template: { metadata: { labels: { ...selector, ...(onFargate ? { "eks.amazonaws.com/fargate-profile": inputs.fargateProfileName } : {}) } }, spec: {
        nodeSelector: { "kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux" },
        securityContext: { runAsNonRoot: true, runAsUser: isModel ? 10001 : 977, runAsGroup: isModel ? 10001 : 977, fsGroup: isModel ? 10001 : 977, seccompProfile: { type: "RuntimeDefault" } },
        containers: [{
          name: component,
          image,
          ports: [{ name: "http", containerPort: port, protocol: "TCP" }],
          env: [
            ...Object.entries(isModel ? { ...modelEnvironment(model), HOME: "/var/data" } : searchEnvironment()).map(([name, envValue]) => ({ name, value: String(envValue) })),
            ...(!isModel ? [{ name: "SEARXNG_SECRET", valueFrom: { secretKeyRef: { name: inputs.searchSecretName, key: "SEARXNG_SECRET", optional: false } } }] : []),
          ],
          resources: { requests: { cpu: budget.kubeCpu, memory: budget.kubeMemory }, limits: { cpu: budget.kubeCpu, memory: budget.kubeMemory } },
          securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
          volumeMounts: isModel ? [{ name: "model-cache", mountPath: "/var/data" }, { name: "tmp", mountPath: "/tmp" }] : [{ name: "search-cache", mountPath: "/var/cache/searxng" }, { name: "tmp", mountPath: "/tmp" }],
        }],
        volumes: isModel ? [{ name: "model-cache", persistentVolumeClaim: { claimName: inputs.modelClaimName } }, { name: "tmp", emptyDir: {} }] : [{ name: "search-cache", emptyDir: {} }, { name: "tmp", emptyDir: {} }],
      } },
    },
  };
  const service = {
    apiVersion: "v1", kind: "Service", metadata: { name: resourceName, namespace },
    spec: { type: "ClusterIP", selector, ports: [{ name: "http", protocol: "TCP", port, targetPort: "http" }] },
  };
  const policy = {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: resourceName, namespace },
    spec: { podSelector: { matchLabels: selector }, policyTypes: ["Ingress"], ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": n8nNamespace } }, podSelector: { matchLabels: { [key]: value } } }], ports: [{ protocol: "TCP", port }] }] },
  };
  const podSecurityGroup = onFargate ? {
    apiVersion: "vpcresources.k8s.aws/v1beta1", kind: "SecurityGroupPolicy", metadata: { name: resourceName, namespace },
    spec: { podSelector: { matchLabels: selector }, securityGroups: { groupIds: [inputs.fargateSecurityGroupId] } },
  } : null;
  const address = `http://${resourceName}.${namespace}.svc.cluster.local:${port}`;
  return {
    files: [...(podSecurityGroup ? [FILE("security-group-policy.json", podSecurityGroup)] : []), FILE("network-policy.json", policy), FILE("deployment.json", deployment), FILE("service.json", service), ...dockerImages(component)],
    settings: [],
    steps: [
      `Confirm ${resourceName} does not already exist in namespace ${namespace}, inspect existing n8n pod labels and namespace identity; ${onFargate ? `confirm Fargate profile ${inputs.fargateProfileName} selects this namespace and generated companion label, and that dedicated security group ${inputs.fargateSecurityGroupId} allows inbound ${port}/TCP only from the actual n8n backend caller group ${inputs.n8nCallerSecurityGroupId}` : "verify the CNI actually enforces NetworkPolicy"} and that n8n egress permits this new ClusterIP.`,
      ...(isModel ? [`Confirm existing PVC ${inputs.modelClaimName} is Bound, writable by UID/GID 10001 and supported by this node type.`] : [
        `Build and push the included pinned Dockerfile as ${image} to the existing private registry; securely create or inspect existing Kubernetes Secret ${inputs.searchSecretName} with nonempty SEARXNG_SECRET key outside Relmio.`,
      ]),
      ...(providerId === "eks-fargate" && isModel ? [`Confirm PVC ${inputs.modelClaimName} is bound to PV ${inputs.efsStaticPvName}, whose CSI driver is efs.csi.aws.com and whose volumeHandle names the approved static EFS filesystem/access point; EBS and dynamic EFS are unsupported on EKS Fargate.`] : []),
      ...(onFargate ? [`After human confirmation, first apply only security-group-policy.json to namespace ${namespace}; verify its exact generated Pod selector and existing SG ${inputs.fargateSecurityGroupId}. Abort if admission fails or the existing SG ingress/caller membership review fails.`] : []),
      `After human confirmation, ${onFargate ? "then" : "first"} apply only network-policy.json to namespace ${namespace}; verify successful creation and exact n8n namespace/pod selectors, destination selector and port ${port}. ${onFargate ? "EKS Fargate does not enforce this policy: verify SecurityGroupPolicy and existing SG rules instead, or abort." : "Verify the selected CNI enforces this policy, and audit additive policies for broader ingress. Abort if policy creation or enforcement fails."}`,
      `Only after the preceding private-access checks succeed, apply deployment.json and service.json to namespace ${namespace}; do not apply or edit existing n8n resources.`,
      ...(isModel ? [
        `From the actual approved n8n backend, POST ${address}/api/pull with JSON ${JSON.stringify({ model: model.id, stream: false })}; wait for status success before inference.`,
        `Send a fresh non-empty Chat Completions request to ${address}/v1/chat/completions using model ${model.id}; configure private n8n OpenAI-compatible base URL ${address}/v1 with Responses disabled.`,
      ] : [`Use n8n backend HTTP Request ${address}/search?q=n8n&format=json and require a JSON results array.`]),
    ],
    connection: isModel ? { baseUrl: `${address}/v1`, modelId: model.id, responsesApi: false } : { searchUrl: `${address}/search?q=n8n&format=json` },
    requirements: [
      `Existing namespace ${namespace}, private n8n backend in namespace ${n8nNamespace} with the exact supplied pod label, working cluster DNS and ${onFargate ? `existing Fargate profile ${inputs.fargateProfileName} plus security group ${inputs.fargateSecurityGroupId} whose inbound ${port}/TCP rule has only dedicated n8n caller security group ${inputs.n8nCallerSecurityGroupId} as source; NetworkPolicy is not enforced by Fargate VPC CNI` : "enforced ingress NetworkPolicy"} are required.`,
      ...(onFargate ? [`Before applying, verify security group ${inputs.fargateSecurityGroupId} permits outbound TCP and UDP 53 to CoreDNS and its return path, control-plane connectivity on TCP 443 and 10250 as required by the cluster SG, ${isModel ? "TCP 2049 to EFS mount target security groups and HTTPS 443 to the approved model registry" : "HTTPS 443 to approved upstream search services and image registry endpoints"}, and no broad inbound service-port rule. The existing n8n caller group must permit outbound ${port}/TCP; security-group and Fargate-profile policies remain operator-owned and are never changed by Relmio.`] : []),
      "Caller-side egress and any n8n SSRF protection must explicitly permit this private endpoint; do not disable SSRF protection globally.",
      ...(isModel ? [`Existing persistent PVC ${inputs.modelClaimName} with adequate space and nonroot UID/GID 10001 write permissions is required.`] : ["Existing private image repository, cluster image-pull authorization and Kubernetes Secret with SEARXNG_SECRET are required; search cache is disposable."]),
      ...(providerId === "eks-fargate" && isModel ? [`Existing static EFS PV ${inputs.efsStaticPvName} bound to the selected claim is required; EKS Fargate cannot use EBS or dynamically provisioned EFS.`] : []),
    ],
    limitations: [
      "Operator-owned Kubernetes resources only; no apply, live inference or private routing was run. Other additive NetworkPolicies may allow more ingress; audit the namespace policy set.",
      ...(onFargate ? ["EKS Fargate VPC CNI cannot apply Kubernetes NetworkPolicy to these Pods. The exact n8n-selector policy is review-only here; generated SecurityGroupPolicy binds an existing SG to newly scheduled companion Pods but neither creates nor checks SG rules. Confirm the caller SG is dedicated to the approved n8n backend and has no unintended members or broad ingress. Sources: https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html ; https://docs.aws.amazon.com/eks/latest/userguide/sg-pods-example-deployment.html ; https://docs.aws.amazon.com/eks/latest/userguide/fargate-profile.html ; https://docs.aws.amazon.com/eks/latest/userguide/sec-group-reqs.html"] : []),
      "CPU/memory and selected model pull are planning allowances, not measured capacity or digest attestation.",
      "Sources: https://kubernetes.io/docs/concepts/services-networking/network-policies/ ; https://kubernetes.io/docs/concepts/workloads/controllers/deployment/ ; https://docs.aws.amazon.com/eks/latest/userguide/fargate.html ; https://docs.aws.amazon.com/eks/latest/userguide/efs-csi.html ; https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests ; https://learn.microsoft.com/en-us/azure/aks/concepts-storage ; https://docs.ollama.com/api/pull",
    ],
  };
}

export const SCHEDULER_HOSTING_PROFILES = Object.freeze([
  ...["ecs-ec2", "ecs-fargate"].flatMap(providerId => [
    { providerId, component: "model", fields: [...ecsFields, ...ecsModelFields], render: ecsPlan },
    { providerId, component: "searxng", fields: [...ecsFields, ...ecsSearchFields], render: ecsPlan },
  ]),
  ...["eks", "eks-fargate", "gke", "gke-autopilot", "aks"].flatMap(providerId => [
    { providerId, component: "model", fields: [...kubeFields, ...kubeModelFields, ...(providerId === "eks-fargate" ? [...fargateFields, ...fargateModelFields] : [])], render: kubePlan },
    { providerId, component: "searxng", fields: [...kubeFields, ...kubeSearchFields(providerId), ...(providerId === "eks-fargate" ? fargateFields : [])], render: kubePlan },
  ]),
]);
