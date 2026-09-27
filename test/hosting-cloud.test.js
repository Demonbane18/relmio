import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_HOSTING_PROFILES } from "../src/domain/hosting-cloud-profiles.js";

const deploymentId = "abcdef012345";
const subscription = "12345678-1234-1234-1234-123456789abc";
const resourceGroup = "operator-rg";
const environmentId = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.App/managedEnvironments/operator-env`;
const subnetId = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/virtualNetworks/operator-vnet/subnets/aci-delegated`;
const identityId = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/operator-search`;
const model = { id: "qwen3:0.6b", contextTokens: 2048, memoryBytes: 2 * 1024 ** 3 };

function render(providerId, component, inputs, selectedModel = model) {
  const profile = CLOUD_HOSTING_PROFILES.find(profile => profile.providerId === providerId && profile.component === component);
  assert.ok(profile, `${providerId}/${component} profile exists`);
  return profile.render({ providerId, component, deploymentId, resourceName: `relmio-${component}-${deploymentId}`, model: component === "model" ? selectedModel : null, inputs });
}

function jsonFile(plan, filename) {
  return JSON.parse(plan.files.find(file => file.name === filename).content);
}

const cloudIdentity = {
  projectNumber: "123456789012", region: "europe-west1",
  serviceAccountEmail: "model-runtime@operator-project.iam.gserviceaccount.com",
  callerServiceAccountEmail: "n8n-caller@operator-project.iam.gserviceaccount.com",
};
const runInputs = { ...cloudIdentity, bucketName: "operator-ollama-cache" };

test("Cloud Run model mounts only the prepopulated read-only cache and requires a live IAM caller", () => {
  const plan = render("cloud-run", "model", runInputs);
  const yaml = plan.files.find(file => file.name === "service.yaml").content;
  assert.match(yaml, /run.googleapis.com\/ingress: internal/);
  assert.match(yaml, /readOnly: true/);
  assert.match(yaml, /bucketName: operator-ollama-cache/);
  assert.match(yaml, /OLLAMA_MODELS/);
  assert.doesNotMatch(yaml, /allow-unauthenticated|invoker-iam-disabled|ollama pull|allUsers/);
  const directions = plan.steps.join("\n");
  assert.match(directions, /roles\/run\.invoker/);
  assert.match(directions, /metadata\.google\.internal/);
  assert.match(directions, /X-Serverless-Authorization/);
  assert.match(directions, /audience/);
  assert.match(directions, /SSRF/);
  assert.doesNotMatch(directions, /N8N_SSRF_PROTECTION_ENABLED=false|--allow-unauthenticated|API key.*local-only/);
});

test("Cloud Run search uses a secret reference and same IAM routing, not a public search endpoint", () => {
  const plan = render("cloud-run", "searxng", {
    ...cloudIdentity, secretName: "operator-searxng-secret", secretVersion: "3",
  });
  const yaml = plan.files.find(file => file.name === "service.yaml").content;
  assert.match(yaml, /secretKeyRef:/);
  assert.match(yaml, /run.googleapis.com\/ingress: internal/);
  assert.match(yaml, /test \$\{#SEARXNG_SECRET\} -ge 32/);
  assert.match(yaml, /name: operator-searxng-secret/);
  assert.match(plan.steps.join("\n"), /roles\/run\.invoker/);
  assert.doesNotMatch(yaml, /allow-unauthenticated|allUsers/);
});

const acaInputs = { environmentId, resourceGroup: "operator-rg", location: "westeurope", storageName: "operator-model-cache" };

test("Container Apps model binds existing environment storage with internal single-replica ingress", () => {
  const arm = jsonFile(render("azure-container-apps", "model", acaInputs), "template.json");
  const app = arm.resources[0];
  assert.equal(app.properties.environmentId, environmentId);
  assert.equal(app.properties.configuration.ingress.external, false);
  assert.deepEqual(app.properties.template.scale, { minReplicas: 1, maxReplicas: 1 });
  assert.equal(app.properties.template.volumes[0].storageName, acaInputs.storageName);
  assert.equal(app.properties.template.volumes[0].storageType, "AzureFile");
  assert.equal(app.properties.configuration.ingress.targetPort, 11434);
  assert.deepEqual(arm.resources.map(resource => resource.type), ["Microsoft.App/containerApps"]);
});

test("Container Apps search references existing Key Vault identity and secret, not its value", () => {
  const plan = render("azure-container-apps", "searxng", {
    environmentId, resourceGroup: "operator-rg", location: "westeurope", identityId,
    secretUrl: "https://operator-vault.vault.azure.net/secrets/search-secret/1234567890abcdef1234567890abcdef",
    registryServer: "operatorregistry.azurecr.io",
  });
  const app = jsonFile(plan, "template.json").resources[0];
  assert.equal(app.properties.configuration.ingress.external, false);
  assert.equal(app.properties.configuration.ingress.allowInsecure, false);
  assert.equal(plan.connection.scheme, "https");
  assert.match(plan.connection.fqdnFrom, /properties\.configuration\.ingress\.fqdn/);
  assert.equal(app.properties.template.scale.maxReplicas, 1);
  assert.equal(app.properties.configuration.secrets[0].identity, identityId);
  assert.ok(app.properties.configuration.secrets[0].keyVaultUrl.includes("operator-vault"));
  assert.deepEqual(app.properties.configuration.registries, [{ server: "operatorregistry.azurecr.io", identity: identityId }]);
  assert.equal(app.properties.template.containers[0].env.find(item => item.name === "SEARXNG_SECRET").secretRef, "search-secret");
  assert.equal(app.properties.configuration.secrets[0].value, undefined);
});

const aciInputs = { resourceGroup: "operator-rg", location: "westeurope", subnetId, storageAccountName: "operatorfiles", shareName: "operator-models" };

test("Container Instances model uses delegated private subnet and a secure runtime storage key parameter", () => {
  const arm = jsonFile(render("azure-container-instances", "model", aciInputs), "template.json");
  const group = arm.resources[0];
  assert.equal(arm.parameters.storageAccountKey.type, "secureString");
  assert.equal(arm.parameters.storageAccountKey.defaultValue, undefined);
  assert.equal(group.properties.volumes[0].azureFile.storageAccountKey, "[parameters('storageAccountKey')]");
  assert.equal(group.properties.ipAddress.type, "Private");
  assert.equal(group.properties.subnetIds[0].id, subnetId);
  assert.equal(group.properties.ipAddress.dnsNameLabel, undefined);
  assert.doesNotMatch(JSON.stringify(arm), /privileged|publicEndpoint|10531/);
});

test("Container Instances search remains private and obtains the SearXNG secret only at ARM deployment time", () => {
  const arm = jsonFile(render("azure-container-instances", "searxng", { resourceGroup: "operator-rg", location: "westeurope", subnetId, registryServer: "operatorregistry.azurecr.io", identityId }), "template.json");
  const group = arm.resources[0];
  assert.equal(group.properties.ipAddress.type, "Private");
  assert.equal(group.properties.subnetIds[0].id, subnetId);
  assert.equal(arm.parameters.searchSecret.type, "secureString");
  assert.equal(group.properties.containers[0].properties.environmentVariables.find(item => item.name === "SEARXNG_SECRET").secureValue, "[parameters('searchSecret')]");
  assert.deepEqual(group.properties.imageRegistryCredentials, [{ server: "operatorregistry.azurecr.io", identity: identityId }]);
});

test("large catalog models require a dedicated Container Apps profile and get adequate planning memory", () => {
  const largerModel = { id: "qwen3.5:9b", contextTokens: 8192, memoryBytes: 11 * 1024 ** 3 };
  assert.throws(() => render("azure-container-apps", "model", acaInputs, largerModel), TypeError);
  const app = jsonFile(render("azure-container-apps", "model", { ...acaInputs, workloadProfileName: "operator-memory" }, largerModel), "template.json").resources[0];
  assert.equal(app.properties.workloadProfileName, "operator-memory");
  assert.equal(app.properties.template.containers[0].resources.memory, "13Gi");
  const runYaml = render("cloud-run", "model", runInputs, largerModel).files.find(file => file.name === "service.yaml").content;
  assert.match(runYaml, /cpu: '4'/);
  assert.match(runYaml, /memory: 13Gi/);
  const aci = jsonFile(render("azure-container-instances", "model", aciInputs, largerModel), "template.json").resources[0];
  assert.equal(aci.properties.containers[0].properties.resources.requests.memoryInGB, 13);
});

test("Lightsail search deployment never configures a public endpoint or persists a generated secret", () => {
  const plan = render("lightsail-containers", "searxng", { serviceName: "operator-private-search", imageRef: ":operator-private-search.search.1" });
  const deploy = jsonFile(plan, "deployment.json");
  assert.equal(deploy.serviceName, "operator-private-search");
  assert.equal(deploy.publicEndpoint, undefined);
  assert.equal(deploy.containers["relmio-searxng-abcdef012345"].ports["8080"], "HTTP");
  assert.equal(deploy.containers["relmio-searxng-abcdef012345"].environment.SEARXNG_SECRET, undefined);
  assert.match(plan.steps.join("\n"), /same.*region/i);
});

test("direct rendering rejects fake or command-bearing resource references", () => {
  assert.throws(() => render("azure-container-apps", "model", { ...acaInputs, environmentId: "/subscriptions/EXAMPLE/resourceGroups/demo" }), TypeError);
  assert.throws(() => render("azure-container-instances", "model", { ...aciInputs, subnetId: `${subnetId}; echo bad` }), TypeError);
  assert.throws(() => render("azure-container-apps", "model", { ...acaInputs, resourceGroup: "operator-rg; echo bad" }), TypeError);
  assert.throws(() => render("cloud-run", "model", { ...runInputs, bucketName: "gs://operator-ollama-cache; echo bad" }), TypeError);
  assert.throws(() => render("cloud-run", "searxng", { ...cloudIdentity, secretName: "not/secret", secretVersion: "1" }), TypeError);
  assert.throws(() => render("cloud-run", "searxng", { ...cloudIdentity, secretName: "operator-searxng-secret", secretVersion: "latest" }), TypeError);
  assert.throws(() => render("lightsail-containers", "searxng", { serviceName: "foo; echo bad", imageRef: ":operator-private-search.search.1" }), TypeError);
  assert.throws(() => render("lightsail-containers", "searxng", { serviceName: "operator-private-search", imageRef: "latest" }), TypeError);
});
