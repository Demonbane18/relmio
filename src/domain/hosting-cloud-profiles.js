import { createSearxngSettings, ASSISTANT_COMPANION_IMAGES } from "./assistant-templates.js";
import { LOCAL_MODEL_RUNTIME_IMAGE } from "./local-n8n-model.js";
import { createSearchImageFiles, modelEnvironment, searchEnvironment } from "./hosting-deployment-common.js";

// Field patterns also become HTML pattern attributes, which browsers compile
// with the `v` flag. Escape `-`, `(`, `)` and `/` inside character classes so
// both the `u` and `v` flags accept them.
const subscription = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const azureName = "[A-Za-z0-9][A-Za-z0-9_.\\(\\)\\-]{0,88}";
const azurePrefix = `/subscriptions/${subscription}/resourceGroups/${azureName}/providers/`;
const environmentPattern = `^${azurePrefix}Microsoft\\.App/managedEnvironments/[A-Za-z0-9][A-Za-z0-9\\-]{0,31}$`;
const subnetPattern = `^${azurePrefix}Microsoft\\.Network/virtualNetworks/${azureName}/subnets/${azureName}$`;
const identityPattern = `^${azurePrefix}Microsoft\\.ManagedIdentity/userAssignedIdentities/${azureName}$`;
const gcpEmail = "^[a-z][a-z0-9\\-]{4,28}[a-z0-9]@[a-z][a-z0-9\\-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$";
const locationPattern = "^[a-z][a-z0-9\\-]{1,30}$";
const imagePattern = "^(?::[a-z0-9][a-z0-9\\-]{0,61}\\.[a-z0-9][a-z0-9\\-]{0,61}\\.[1-9][0-9]*|[a-z0-9][a-z0-9.\\/_\\-]+@sha256:[0-9a-f]{64})$";
const vaultSecretPattern = "^https://[a-z0-9\\-]+\\.vault\\.azure\\.net/secrets/[a-zA-Z0-9\\-]+/[0-9a-fA-F]{32}$";

const field = (name, label, pattern, description) => ({ name, label, type: "text", required: true, pattern, description });
const cloudFields = [
  field("projectNumber", "Existing Google project number", "^[0-9]{6,20}$", "Real project number of the new receiving service."),
  field("region", "Cloud Run region", locationPattern, "Region allowed for the receiving service and existing caller."),
  field("serviceAccountEmail", "Receiver runtime service account", gcpEmail, "Existing identity; needs bucket read or Secret Manager access."),
  field("callerServiceAccountEmail", "Existing n8n caller service account", gcpEmail, "Must already be attached to an approved Google-hosted n8n runtime with internal routing."),
];
const azureAppFields = [
  field("resourceGroup", "Existing deployment resource group", "^[A-Za-z0-9][A-Za-z0-9._\\-]{0,88}$", "Actual resource group where only the new app will be created."),
  field("environmentId", "Existing Container Apps environment resource ID", environmentPattern, "Use the actual managed environment resource ID; this plan does not create or change it."),
  field("location", "Azure resource region", locationPattern, "Same region as the existing Container Apps environment."),
];
const aciFields = [
  field("location", "Azure resource region", locationPattern, "Same region as the existing delegated subnet and approved storage."),
  field("resourceGroup", "Existing deployment resource group", "^[A-Za-z0-9][A-Za-z0-9._\\-]{0,88}$", "Actual resource group where only the new container group will be created."),
  field("subnetId", "Existing ACI-delegated subnet resource ID", subnetPattern, "Must be delegated to Microsoft.ContainerInstance/containerGroups; confirm private n8n routing and NAT."),
];

function assertInputs(inputs, fields) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) ||
      Object.keys(inputs).some(name => !fields.some(field => field.name === name)) ||
      fields.some(({ name, pattern, required }) =>
        (required && !Object.hasOwn(inputs, name)) ||
        (Object.hasOwn(inputs, name) &&
          (typeof inputs[name] !== "string" || !new RegExp(pattern, "u").test(inputs[name]))))) {
    throw new TypeError("Cloud deployment resource references are invalid.");
  }
}

function assertContext(context, component, providerId) {
  if (!context || context.providerId !== providerId || context.component !== component ||
      context.resourceName !== `relmio-${component}-${context.deploymentId}` ||
      !/^[0-9a-f]{12}$/u.test(context.deploymentId) ||
      (component === "model" && (!context.model || !/^[a-zA-Z0-9_.:-]+$/u.test(context.model.id) ||
        !Number.isSafeInteger(context.model.memoryBytes) || context.model.memoryBytes <= 0))) {
    throw new TypeError("Cloud deployment context is invalid.");
  }
}

const GIB = 1024 ** 3;
function modelMemoryGiB(model) {
  return Math.ceil(model.memoryBytes / GIB) + 2;
}

const file = (name, content, mediaType = "application/json") => ({ name, content, mediaType });
const jsonFile = (name, body) => file(name, `${JSON.stringify(body, null, 2)}\n`);
const envEntries = values => Object.entries(values).map(([name, value]) => ({ name, value: String(value) }));
const yamlString = value => JSON.stringify(value);

function cloudRunSteps(context, path) {
  const { projectNumber, region, callerServiceAccountEmail } = context.inputs;
  const { resourceName } = context;
  return [
    `Review collisions, billing and region; deploy ONLY the new ${resourceName} service: gcloud run services replace service.yaml --project=${projectNumber} --region=${region}. Do not replace an existing n8n service.`,
    `After creating the receiver, bind ONLY the existing n8n caller identity (this service YAML alone does NOT set IAM): gcloud run services add-iam-policy-binding ${resourceName} --project=${projectNumber} --region=${region} --member=serviceAccount:${callerServiceAccountEmail} --role=roles/run.invoker. Review existing IAM policy and remove broad allUsers/allAuthenticatedUsers bindings separately under operator policy; never disable Invoker IAM checks.`,
    `Discover the actual receiver URL: gcloud run services describe ${resourceName} --project=${projectNumber} --region=${region} --format='value(status.url)'. The service's exact URL (without ${path}) is the OIDC token audience.`,
    "Confirm the existing n8n runtime uses that caller service account and already routes Cloud Run-to-Cloud Run traffic through a VPC that the receiver recognizes as internal; same project alone does not make Cloud Run traffic internal. Do not edit or restart existing n8n from this plan.",
    `Only if the existing n8n security policy permits metadata access, create an operator-owned two-step HTTP Request workflow: name node 1 \"Fresh Cloud Run ID token\"; set GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity, query parameter audience = the EXACT service URL discovered above (without ${path}), header Metadata-Flavor = Google, Response Format = Text, Put Output in Field = idToken. For every invocation run that node before node 2, set node 2 URL to the same actual service URL plus ${path}, and set header X-Serverless-Authorization using the expression {{ 'Bearer ' + $('Fresh Cloud Run ID token').first().json.idToken }}. For the model choose POST + JSON body with model ${context.model?.id ?? "the selected model"}, messages [{\"role\":\"user\",\"content\":\"Reply with the digit 4 only.\"}], stream false; for search choose GET q=n8n and format=json. Never store a one-hour ID token as a lasting OpenAI API key or n8n credential.`,
    "Cloud metadata is link-local and sensitive. If n8n SSRF protection blocks metadata or private access, do NOT disable SSRF protection, broadly allow private/metadata CIDRs, or bypass policy; use an operator-approved narrowly scoped identity-aware caller with renewable audience-bound tokens, or leave the integration blocked. In the new workflow Settings, disable saving successful/failed/manual executions and execution progress, enable manual/production redaction where available; never pin token node data or include token bodies/headers in logs, exported workflows/executions or screenshots.",
    "With operator-approved routing and IAM, verify a fresh n8n HTTP Request returns an actual completion or JSON search results array. Container health alone does not prove inference or upstream search.",
  ];
}

function cloudRunService(context, image, env, port, volumes = [], mounts = [], options = {}) {
  const { resourceName, inputs } = context;
  const volumeYaml = volumes.map(volume => `      - name: ${volume.name}\n        ${volume.type === "bucket" ? `csi:\n          driver: gcsfuse.run.googleapis.com\n          readOnly: true\n          volumeAttributes:\n            bucketName: ${volume.bucket}` : `secret:\n          secretName: ${volume.secret}\n          items:\n          - key: ${yamlString(volume.version)}\n            path: ${volume.path}`}`).join("\n");
  const envYaml = envEntries(env).map(item => `        - name: ${item.name}\n          value: ${yamlString(item.value)}`);
  if (options.secret) {
    envYaml.push(`        - name: SEARXNG_SECRET\n          valueFrom:\n            secretKeyRef:\n              key: ${yamlString(options.secret.version)}\n              name: ${options.secret.name}`);
  }
  const memoryGiB = options.model ? modelMemoryGiB(context.model) : 1;
  return `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${resourceName}
  namespace: ${yamlString(inputs.projectNumber)}
  labels:
    cloud.googleapis.com/location: ${inputs.region}
  annotations:
    run.googleapis.com/ingress: internal
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/execution-environment: gen2
        autoscaling.knative.dev/maxScale: '1'
    spec:
      serviceAccountName: ${inputs.serviceAccountEmail}
      containerConcurrency: 1
      timeoutSeconds: 300
      containers:
      - name: ${resourceName}
        image: ${image}
${options.secret ? `        command: ["/bin/sh"]\n        args: ["-ec", "test \${#SEARXNG_SECRET} -ge 32 && exec /usr/local/searxng/entrypoint.sh"]\n` : ""}        ports:
        - containerPort: ${port}
        resources:
          limits:
            cpu: '${options.model ? (memoryGiB > 8 ? 4 : 2) : 1}'
            memory: ${memoryGiB}Gi
        env:
${envYaml.join("\n")}${mounts.length ? `\n        volumeMounts:\n${mounts.map(mount => `        - name: ${mount.name}\n          mountPath: ${mount.path}`).join("\n")}` : ""}${volumes.length ? `\n      volumes:\n${volumeYaml}` : ""}
  traffic:
  - percent: 100
    latestRevision: true
`;
}

function cloudRunModel(context) {
  assertContext(context, "model", "cloud-run");
  assertInputs(context.inputs, [...cloudFields, cloudModelFields[0]]);
  const { bucketName } = context.inputs;
  const service = cloudRunService(context, LOCAL_MODEL_RUNTIME_IMAGE,
    { ...modelEnvironment(context.model, "0.0.0.0:11434", "/var/data/models"), OLLAMA_NOPRUNE: "1" }, 11434,
    [{ name: "model-cache", type: "bucket", bucket: bucketName }],
    [{ name: "model-cache", path: "/var/data/models" }], { model: true });
  return {
    files: [file("service.yaml", service, "application/yaml")], settings: [],
    steps: [
      `Before deployment, in an operator-owned isolated preparation runtime running the pinned Ollama image acquire the allowlisted ${context.model.id}; upload its exact cache trees manifests/ and blobs/ at the ROOT of existing Cloud Storage bucket ${bucketName} (Cloud Storage Console > bucket > Upload folder, preserving both trees). Verify approved model manifest/blob integrity and read/list permissions, not a standalone GGUF. Review bucket policy, then grant only ${context.inputs.serviceAccountEmail} reader access: gcloud storage buckets add-iam-policy-binding gs://${bucketName} --member=serviceAccount:${context.inputs.serviceAccountEmail} --role=roles/storage.objectViewer. The mount is READ-ONLY: do not run /api/pull against this service or write into FUSE. A mutable model tag is not managed digest attestation.`,
      ...cloudRunSteps(context, "/v1/chat/completions"),
    ],
    connection: { type: "cloud-run-oidc-http-request", modelId: context.model.id, path: "/v1/chat/completions", audienceFrom: "deployed-service-status.url" },
    requirements: ["Existing approved Cloud Run n8n caller identity and internal VPC route", "Prepopulated exact Ollama cache in existing bucket and read-only bucket IAM", "Operator-reviewed resource collision and capacity"],
    limitations: ["CPU sizing is unbenchmarked; readonly GCS FUSE has non-POSIX semantics; inference is NOT-RUN.", "No static OpenAI API-key or native OpenAI-node authentication is configured.", "Cloud Run cannot host the privileged n8n Assistant runner."],
  };
}

const cloudModelFields = [field("bucketName", "Existing prepopulated model cache bucket", "^[a-z0-9][a-z0-9._\\-]{2,61}[a-z0-9]$", "Only exact Ollama cache layout; prepopulated read-only mounted model directory.")];
const cloudSearchFields = [
  field("secretName", "Existing runtime SearXNG Secret Manager secret", "^[a-zA-Z][a-zA-Z0-9_\\-]{0,254}$", "Existing secret with the actual server secret; not the generated settings file."),
  field("secretVersion", "Secret Manager version number", "^[1-9][0-9]{0,12}$", "Pin a specific existing version; do not provide a secret value."),
];

function cloudRunSearch(context) {
  assertContext(context, "searxng", "cloud-run");
  assertInputs(context.inputs, [...cloudFields, ...cloudSearchFields]);
  const { secretName, secretVersion, serviceAccountEmail } = context.inputs;
  const settingsSecret = `${context.resourceName}-settings`;
  const service = cloudRunService(context, ASSISTANT_COMPANION_IMAGES.searxng, searchEnvironment(), 8080,
    [{ name: "search-settings", type: "secret", secret: settingsSecret, version: "1", path: "settings.yml" }],
    [{ name: "search-settings", path: "/etc/searxng" }], { secret: { name: secretName, version: secretVersion } });
  return {
    files: [file("service.yaml", service, "application/yaml"), file("settings.yml", createSearxngSettings(), "application/yaml")],
    settings: [],
    steps: [
      `Before service creation, operator creates NEW Secret Manager secret ${settingsSecret} from the supplied nonsecret settings.yml: gcloud secrets create ${settingsSecret} --project=${context.inputs.projectNumber} --data-file=settings.yml. Confirm this is version 1; do not silently use stale settings. Review each secret's IAM policy, then bind the runtime identity only to these two: gcloud secrets add-iam-policy-binding ${settingsSecret} --project=${context.inputs.projectNumber} --member=serviceAccount:${serviceAccountEmail} --role=roles/secretmanager.secretAccessor; gcloud secrets add-iam-policy-binding ${secretName} --project=${context.inputs.projectNumber} --member=serviceAccount:${serviceAccountEmail} --role=roles/secretmanager.secretAccessor. The pinned process must read /etc/searxng/settings.yml, and the existing ${secretName} version ${secretVersion} supplies SEARXNG_SECRET at startup; never paste its value into this download. The startup guard rejects missing or short secrets.`,
      ...cloudRunSteps(context, "/search?q=n8n&format=json"),
    ],
    connection: { type: "cloud-run-oidc-http-request", path: "/search", query: { format: "json" }, audienceFrom: "deployed-service-status.url" },
    requirements: ["Existing caller with private Cloud Run routing", "Nonsecret settings version 1 and existing runtime secret with least-privilege access", "Outbound search-engine access"],
    limitations: ["Search cache is ephemeral and upstream engines may block/rate-limit; remote runtime NOT-RUN.", "Secret volume permissions must permit the SearXNG process to read settings; do not elevate to privileged mode."],
  };
}

function azureArm(resource) {
  return { $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#", contentVersion: "1.0.0.0", ...resource };
}

function azureApps(context) {
  const { component, inputs, resourceName } = context;
  assertContext(context, component, "azure-container-apps");
  const search = component === "searxng";
  assertInputs(inputs, search ? [...azureAppFields, ...acaSearchFields] : [...azureAppFields, ...acaModelFields]);
  const environment = search ? searchEnvironment() : modelEnvironment(context.model);
  const env = envEntries(environment);
  const image = search ? "[parameters('searchImage')]" : LOCAL_MODEL_RUNTIME_IMAGE;
  const config = {
    activeRevisionsMode: "Single",
    ingress: { external: false, targetPort: search ? 8080 : 11434, transport: "http", allowInsecure: false },
  };
  const modelMemory = search ? 0 : modelMemoryGiB(context.model);
  if (!search && modelMemory > 4 && !inputs.workloadProfileName) {
    throw new TypeError("This model needs an existing dedicated Container Apps workload profile.");
  }
  const container = { name: resourceName, image, env, resources: {
    cpu: search ? 0.5 : 2, memory: search ? "1Gi" : `${modelMemory}Gi`,
  } };
  const template = { containers: [container], scale: { minReplicas: 1, maxReplicas: 1 } };
  const parameters = {};
  if (search) {
    parameters.searchImage = { type: "string", metadata: { description: "Operator-built immutable image digest from supplied SearXNG Dockerfile/files, passed at deployment (not a secret)." } };
    config.secrets = [{ name: "search-secret", keyVaultUrl: inputs.secretUrl, identity: inputs.identityId }];
    config.registries = [{ server: inputs.registryServer, identity: inputs.identityId }];
    container.env.push({ name: "SEARXNG_SECRET", secretRef: "search-secret" });
  } else {
    container.volumeMounts = [{ volumeName: "model-cache", mountPath: "/var/data" }];
    template.volumes = [{ name: "model-cache", storageType: "AzureFile", storageName: inputs.storageName }];
  }
  const arm = azureArm({ parameters, resources: [{
    type: "Microsoft.App/containerApps", apiVersion: "2024-03-01", name: resourceName,
    location: inputs.location,
    ...(search ? { identity: { type: "UserAssigned", userAssignedIdentities: { [inputs.identityId]: {} } } } : {}),
    properties: { environmentId: inputs.environmentId, configuration: config, template, ...(!search && inputs.workloadProfileName ? { workloadProfileName: inputs.workloadProfileName } : {}) },
  }] });
  const steps = [
    `Check ${resourceName} is new; review the existing ${inputs.environmentId} environment, resource group ${inputs.resourceGroup} and region ${inputs.location}; it must not target any existing n8n app. Apply this one-resource ARM template through Azure Portal > Deploy a custom template > Build your own template in editor > load template.json, select existing ${inputs.resourceGroup}${search ? ", enter the actual built immutable image reference in searchImage" : ""}, and review the one-resource preview before final submission. Do not replace or change the existing environment or n8n app.`,
    `Confirm n8n is already a caller inside the same Container Apps environment. App internal ingress (external:false) is not a VNet-wide URL: callers elsewhere in VNet can get HTTP 404. Do not change existing n8n or expose raw model/search publicly.`,
    `Discover the actual internal ingress FQDN with az containerapp show --resource-group='${inputs.resourceGroup}' --name='${resourceName}' --query properties.configuration.ingress.fqdn --output tsv. From n8n INSIDE the same environment use HTTPS to that exact returned FQDN and append ${search ? "/search?q=n8n&format=json" : "/api/pull"} with TLS validation enabled; do not assume the HTTPS redirect from an http:// short name preserves a working certificate. targetPort ${search ? 8080 : 11434} is the container listener, not the TLS ingress port. For a model perform a bounded private POST /api/pull with JSON {"model":${JSON.stringify(context.model?.id ?? "")},"stream":false}, then a separate /v1/chat/completions inference request. For search require a JSON results array.`,
    "Review existing n8n SSRF outbound restrictions and authorize only the exact service under operator policy; do not disable protection or open broad private CIDRs.",
  ];
  if (search) steps.splice(0, 0, `Build/publish supplied Dockerfile + settings.yml + start.sh + .dockerignore as an approved immutable linux/amd64 image in existing ACR ${inputs.registryServer}, then supply its actual digest under that server via searchImage at deployment. Existing identity ${inputs.identityId} must already have AcrPull on the ACR and read permission on Key Vault secret ${inputs.secretUrl}; enable only the registry-approved authentication/network settings. No secret value is in the template.`);
  else steps.splice(0, 0, `Ensure environment storage ${inputs.storageName} already maps an approved classic Azure Files SMB share with writable /var/data/models for the pinned Ollama runtime; maintain single writer and sufficient capacity. Do NOT substitute ephemeral replica storage. Review storage/UID permissions before deploying. This model requests ${modelMemory}GiB plus 2 vCPU; ${inputs.workloadProfileName ? `verify existing dedicated workload profile ${inputs.workloadProfileName} has enough free capacity and billing approval` : "the default Consumption-only environment must permit the 2-vCPU/4-GiB allocation"}. This is a planning allowance, NOT a measured memory peak.`);
  return {
    files: [jsonFile("template.json", arm), ...(search ? createSearchImageFiles() : [])], settings: [], steps,
    connection: { type: "same-container-apps-environment", fqdnFrom: `az containerapp show --resource-group='${inputs.resourceGroup}' --name='${resourceName}' --query properties.configuration.ingress.fqdn --output tsv`, scheme: "https", path: search ? "/search" : "/v1" },
    requirements: ["Existing same-environment n8n caller with permitted internal access", ...(search ? ["Existing Azure Key Vault secret and identity with read access", "Operator-built pinned SearXNG image"] : ["Existing registered classic Azure Files SMB environment storage and writable model cache"])],
    limitations: ["Internal app ingress is not reachable from arbitrary VNet resources.", "No privileged Assistant runner; runtime NOT-RUN."],
  };
}

const acaModelFields = [
  field("storageName", "Existing environment Azure Files storage name", "^[a-zA-Z][a-zA-Z0-9\\-]{0,30}$", "Pre-registered classic SMB share; model storage must be writable."),
  { ...field("workloadProfileName", "Existing dedicated workload profile (required above 4 GiB)", "^[A-Za-z][A-Za-z0-9\\-]{0,30}$", "An existing dedicated profile with enough free vCPU/RAM for this model; leave blank only for the small Consumption model."), required: false },
];
const acaSearchFields = [
  field("identityId", "Existing user-assigned identity ID", identityPattern, "Identity with read access to the specified Key Vault secret."),
  field("secretUrl", "Existing Key Vault secret version URL", vaultSecretPattern, "Only secret URI/version, never its value."),
  field("registryServer", "Existing Azure Container Registry login server", "^[a-z0-9]{5,50}\\.azurecr\\.io$", "Private operator registry hosting the approved immutable search image; existing identity needs AcrPull."),
];

function azureInstances(context) {
  const { component, inputs, resourceName } = context;
  assertContext(context, component, "azure-container-instances");
  const search = component === "searxng";
  assertInputs(inputs, search ? [...aciFields, ...aciSearchFields] : [...aciFields, ...aciModelFields]);
  const parameters = search
    ? { searchImage: { type: "string", metadata: { description: "Operator-built immutable SearXNG image digest." } }, searchSecret: { type: "secureString" } }
    : { storageAccountKey: { type: "secureString" } };
  const environment = search ? searchEnvironment() : modelEnvironment(context.model);
  const modelMemory = search ? 0 : modelMemoryGiB(context.model);
  const properties = {
    image: search ? "[parameters('searchImage')]" : LOCAL_MODEL_RUNTIME_IMAGE,
    environmentVariables: envEntries(environment),
    ports: [{ port: search ? 8080 : 11434, protocol: "TCP" }],
    resources: { requests: { cpu: search ? 1 : (modelMemory > 8 ? 4 : 2), memoryInGB: search ? 1.5 : modelMemory } },
  };
  if (search) properties.environmentVariables.push({ name: "SEARXNG_SECRET", secureValue: "[parameters('searchSecret')]" });
  else properties.volumeMounts = [{ name: "model-cache", mountPath: "/var/data" }];
  const group = {
    osType: "Linux", restartPolicy: "Always",
    containers: [{ name: resourceName, properties }],
    ipAddress: { type: "Private", ports: [{ protocol: "TCP", port: search ? 8080 : 11434 }] },
    subnetIds: [{ id: inputs.subnetId }],
  };
  if (search) group.imageRegistryCredentials = [{ server: inputs.registryServer, identity: inputs.identityId }];
  if (!search) group.volumes = [{ name: "model-cache", azureFile: {
    shareName: inputs.shareName, storageAccountName: inputs.storageAccountName,
    storageAccountKey: "[parameters('storageAccountKey')]", readOnly: false,
  } }];
  const arm = azureArm({ parameters, resources: [{
    type: "Microsoft.ContainerInstance/containerGroups", apiVersion: "2023-05-01",
    name: resourceName, location: inputs.location,
    ...(search ? { identity: { type: "UserAssigned", userAssignedIdentities: { [inputs.identityId]: {} } } } : {}),
    properties: group,
  }] });
  return {
    files: [jsonFile("template.json", arm), ...(search ? createSearchImageFiles() : [])], settings: [],
    steps: [
      ...(search ? [`Build/publish supplied pinned SearXNG Dockerfile/settings/start files as an immutable image into existing ACR ${inputs.registryServer}, and pass the actual digest from that server as searchImage at deployment. User-assigned identity ${inputs.identityId} must have AcrPull on that registry; for private endpoint registries, keep the registry endpoint OUTSIDE the ACI-delegated subnet and review trusted-services/network policy. Inject the actual SEARXNG_SECRET only via ARM secureString searchSecret through an approved secure deployment channel; never place the value in downloaded files, command history, logs or screenshots.`] : [
        `Existing classic Azure Files share ${inputs.storageAccountName}/${inputs.shareName} must be writable for the model cache under /var/data/models. Azure Files SMB in ACI requires a ROOT container; this is not privileged DinD. Supply the real storage account key ONLY via ARM secureString storageAccountKey at deployment, never the generated artifact or a logged CLI argument. The pinned runtime image must have compatible UID and permissions.`,
      ]),
      `Check ${resourceName} does not already exist. Review delegated subnet ${inputs.subnetId} for Microsoft.ContainerInstance/containerGroups, private n8n routing, NAT/outbound registry${search ? "/upstream" : "/model"} egress and storage SMB network access. In Azure Portal > Deploy a custom template > Build your own template in editor, load template.json, select existing ${inputs.resourceGroup}, fill the required secure parameter ${search ? "searchSecret (and nonsecret searchImage)" : "storageAccountKey"} in the secure input, inspect the one-resource preview and apply under operator approval. Never paste a key into JSON, shell history or a public parameter file. Do not deploy to an existing n8n group.`,
      `Discover actual private IP after deployment: az container show --resource-group='${inputs.resourceGroup}' --name='${resourceName}' --query ipAddress.ip --output tsv. The private IP is not stable across replacement; operator must maintain private DNS and permit exactly the caller's VNet path. No public DNS label or internet ingress is generated.`,
      search ? "From an approved private n8n backend, query actual private IP:8080/search?q=n8n&format=json and inspect a JSON results array. Do not use the browser as reachability proof." : `From an approved private n8n backend, POST /api/pull to the actual private IP:11434 with JSON {"model":${JSON.stringify(context.model.id)},"stream":false}, then request /v1/chat/completions and check real inference rather than container health.`,
      "Honor existing n8n SSRF outbound policy; do not broadly allow private ranges, disable protections, or mutate/restart existing n8n.",
    ],
    connection: { type: "private-vnet-dynamic-ip", targetPort: search ? 8080 : 11434, path: search ? "/search" : "/v1", ...(!search ? { modelId: context.model.id } : {}) },
    requirements: ["Existing ACI-delegated private subnet, NAT/outbound and approved n8n private routing", ...(search ? ["Operator-built immutable SearXNG image; runtime secureString secret"] : ["Existing classic Azure Files share and secureString account key at deployment; root-compatible model image"])],
    limitations: ["Private ACI IP can change; operator owns stable DNS and secure SMB key lifecycle.", "No privileged Assistant runner; runtime NOT-RUN."],
  };
}

const aciModelFields = [
  field("storageAccountName", "Existing Azure Storage account name", "^[a-z0-9]{3,24}$", "Existing account for classic Azure Files; no key here."),
  field("shareName", "Existing Azure Files share", "^[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]$", "Existing share for persistent Ollama cache."),
];

const aciSearchFields = [
  field("registryServer", "Existing Azure Container Registry login server", "^[a-z0-9]{5,50}\\.azurecr\\.io$", "Existing private operator registry for the search image."),
  field("identityId", "Existing user-assigned registry-pull identity ID", identityPattern, "Existing identity with AcrPull on registry; ACI does not support system-assigned ACR image-pull identity."),
];

const lightsailFields = [
  field("serviceName", "Existing Lightsail container service name", "^[a-z0-9][a-z0-9\\-]{0,61}[a-z0-9]$", "Operator-owned service in same AWS Region as n8n's approved Lightsail caller."),
  field("imageRef", "Actual operator-built SearXNG image reference", imagePattern, "Build supplied files and push first; use actual immutable digest or Lightsail service image reference."),
];

function lightsailSearch(context) {
  assertContext(context, "searxng", "lightsail-containers");
  assertInputs(context.inputs, lightsailFields);
  const { resourceName, inputs } = context;
  const body = {
    serviceName: inputs.serviceName,
    containers: { [resourceName]: {
      image: inputs.imageRef, ports: { "8080": "HTTP" }, environment: searchEnvironment(),
    } },
  };
  return {
    files: [...createSearchImageFiles(), jsonFile("deployment.json", body)], settings: [],
    steps: [
      `The operator must have a dedicated Lightsail container service named ${inputs.serviceName}. If it does not yet exist, first create it in the AWS Lightsail Console > Containers > Create container service with the operator-approved same AWS Region, power and scale; confirm pricing and select only this new service, never an existing n8n service. This plan does not create or purchase it.`,
      "Build supplied Dockerfile/settings.yml/start.sh/.dockerignore and push the resulting image to the operator's Lightsail container-service registry (or a supported registry). Generate this plan with its ACTUAL reviewed image reference; do not treat mutable tags as digest attestation. Confirm the preexisting service name and review active deployment: Lightsail keeps one active deployment and prior versions, so use a dedicated search-only service rather than replacing an existing n8n deployment.",
      `Review the Lightsail service ${inputs.serviceName} power/scale/region and name collision. Keep the deployment WITHOUT publicEndpoint; any public endpoint on the existing service must be removed under operator review. The caller must be an authorized Lightsail resource in the same AWS region and access http://${inputs.serviceName}.service.local:8080; an ordinary laptop, n8n Cloud or arbitrary VPC caller cannot use this private DNS by assumption.`,
      `Before the operator calls CreateContainerServiceDeployment, inject a freshly created SEARXNG_SECRET into containers.${resourceName}.environment through an approved secret-aware deployment process without printing, returning, saving into this download, or placing the value in command history. The generated deployment.json deliberately lacks the secret and fails closed if deployed unchanged. Lightsail's Container API has NO secret-reference or secret-file-mount field: deployment environment values and retained deployment versions may be visible to authorized account readers. If your policy requires native secret references, do not deploy this Lightsail lane; use a platform with Secret Manager integration instead.`,
      "Only after review, operator calls AWS Lightsail CreateContainerServiceDeployment with the completed deployment request in the service's region; do not create a publicEndpoint. From the same-region Lightsail n8n backend, query /search?q=n8n&format=json and inspect the JSON results array and upstream errors. Honor existing n8n SSRF policy without broad private-network exemptions.",
    ],
    connection: { type: "lightsail-private-domain", baseUrl: `http://${inputs.serviceName}.service.local:8080`, path: "/search" },
    requirements: ["Existing dedicated Lightsail container service and same-region Lightsail n8n caller", "Operator-built immutable image and operator-side runtime secret injection"],
    limitations: ["Lightsail has no native secret reference; do not deploy under a secret-reference-only policy.", "No persistent model volume or privileged runner; search runtime NOT-RUN."],
  };
}

export const CLOUD_HOSTING_PROFILES = Object.freeze([
  { providerId: "cloud-run", component: "model", fields: [...cloudFields, ...cloudModelFields], render: cloudRunModel },
  { providerId: "cloud-run", component: "searxng", fields: [...cloudFields, ...cloudSearchFields], render: cloudRunSearch },
  { providerId: "azure-container-apps", component: "model", fields: [...azureAppFields, ...acaModelFields], render: azureApps },
  { providerId: "azure-container-apps", component: "searxng", fields: [...azureAppFields, ...acaSearchFields], render: azureApps },
  { providerId: "azure-container-instances", component: "model", fields: [...aciFields, ...aciModelFields], render: azureInstances },
  { providerId: "azure-container-instances", component: "searxng", fields: [...aciFields, ...aciSearchFields], render: azureInstances },
  { providerId: "lightsail-containers", component: "searxng", fields: lightsailFields, render: lightsailSearch },
]);
