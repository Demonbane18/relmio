import assert from "node:assert/strict";
import test from "node:test";
import { getLocalModelDefinition } from "../src/local-model/catalog.mjs";
import { SCHEDULER_HOSTING_PROFILES } from "../src/domain/hosting-scheduler-profiles.js";
import { createHostingDeploymentPlan } from "../src/domain/hosting-deployment.js";

const deploymentId = "abcdef123456";
const account = "123456789012";
const region = "eu-west-1";
const model = getLocalModelDefinition("qwen3:0.6b");
const aws = {
  clusterArn: `arn:aws:ecs:${region}:${account}:cluster/existing`,
  executionRoleArn: `arn:aws:iam::${account}:role/existing-execution`,
  taskRoleArn: `arn:aws:iam::${account}:role/existing-task`,
  subnetIds: "subnet-0123456789abcdef0,subnet-1234567890abcdef0",
  securityGroupIds: "sg-0123456789abcdef0",
  discoveryServiceArn: `arn:aws:servicediscovery:${region}:${account}:service/srv-0123456789abcdef0`,
  discoveryNamespace: "svc.internal",
};
const kubernetes = {
  namespace: "inference",
  n8nNamespace: "automation",
  n8nPodLabelKey: "app.kubernetes.io/name",
  n8nPodLabelValue: "n8n",
  modelClaimName: "existing-model-cache",
};
const fargate = {
  fargateProfileName: "example-private-profile",
  fargateSecurityGroupId: "sg-0123456789abcdef0",
  n8nCallerSecurityGroupId: "sg-1234567890abcdef0",
};

function render(providerId, component, inputs) {
  const profile = SCHEDULER_HOSTING_PROFILES.find(item => item.providerId === providerId && item.component === component);
  assert.ok(profile, `${providerId} ${component} has a profile`);
  return profile.render({ providerId, component, deploymentId, resourceName: `relmio-${component}-${deploymentId}`, model: component === "model" ? model : null, inputs });
}

function artifact(plan, name) {
  const file = plan.files.find(item => item.name === name);
  assert.ok(file, `${name} is generated`);
  return JSON.parse(file.content);
}

test("ECS model requires actual EFS, roles, private networking and private discovery for each launch type", () => {
  const inputs = { ...aws, fileSystemId: "fs-0123456789abcdef0", accessPointId: "fsap-0123456789abcdef0" };
  for (const provider of ["ecs-ec2", "ecs-fargate"]) {
    const plan = render(provider, "model", inputs);
    const task = artifact(plan, "task-definition.json");
    const service = artifact(plan, "service.json");
    assert.deepEqual(task.requiresCompatibilities, [provider === "ecs-ec2" ? "EC2" : "FARGATE"]);
    assert.equal(task.volumes[0].efsVolumeConfiguration.fileSystemId, inputs.fileSystemId);
    assert.equal(task.volumes[0].efsVolumeConfiguration.authorizationConfig.accessPointId, inputs.accessPointId);
    assert.equal(task.volumes[0].efsVolumeConfiguration.authorizationConfig.iam, "ENABLED");
    assert.equal(task.containerDefinitions[0].image.includes("@sha256:"), true);
    assert.equal(task.containerDefinitions[0].portMappings[0].containerPort, 11434);
    assert.equal(service.networkConfiguration.awsvpcConfiguration.assignPublicIp, "DISABLED");
    assert.deepEqual(service.networkConfiguration.awsvpcConfiguration.subnets, inputs.subnetIds.split(","));
    assert.equal(service.serviceRegistries[0].registryArn, inputs.discoveryServiceArn);
    assert.equal(service.desiredCount, 1);
    assert.equal(service.loadBalancers, undefined);
    assert.equal(Object.hasOwn(service, "platformFamily"), false);
    assert.match(plan.connection.baseUrl, /^http:\/\/relmio-model-abcdef123456\.svc\.internal:11434\/v1$/u);
  }
});

test("ECS rejects incomplete, duplicated, malformed, cross-account and over-limit network identities", () => {
  const inputs = { ...aws, fileSystemId: "fs-0123456789abcdef0", accessPointId: "fsap-0123456789abcdef0" };
  for (const changes of [
    { subnetIds: "subnet-0123456789abcdef0, subnet-0123456789abcdef0" },
    { subnetIds: Array.from({ length: 17 }, (_, i) => `subnet-${i.toString(16).padStart(17, "0")}`).join(",") },
    { subnetIds: "subnet-0123456789abcdef0,subnet-1234567890abcdef0\npublic" },
    { securityGroupIds: "sg-0123456789abcdef0,sg-0123456789abcdef0" },
    { securityGroupIds: Array.from({ length: 6 }, (_, i) => `sg-${i.toString(16).padStart(17, "0")}`).join(",") },
    { taskRoleArn: "arn:aws:iam::999999999999:role/existing" },
    { discoveryServiceArn: "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-0123456789abcdef0" },
    { clusterArn: "arn:aws:ecs:eu-west-1:123456789012:cluster/old;rm" },
    { accessPointId: "" },
    { discoveryNamespace: "../public.example" },
  ]) assert.throws(() => render("ecs-fargate", "model", { ...inputs, ...changes }));
});

test("ECS search references a provider secret and derived pinned image without returning secret data", () => {
  const plan = render("ecs-fargate", "searxng", {
    ...aws,
    searchRepository: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/relmio-search",
    searchSecretArn: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:existing-search-AbCd12",
  });
  const task = artifact(plan, "task-definition.json");
  assert.equal(task.containerDefinitions[0].secrets[0].valueFrom.includes("existing-search"), true);
  assert.equal(task.containerDefinitions[0].secrets[0].name, "SEARXNG_SECRET");
  assert.equal(task.containerDefinitions[0].image, "123456789012.dkr.ecr.eu-west-1.amazonaws.com/relmio-search:abcdef123456");
  assert.ok(plan.files.some(file => file.name === "Dockerfile"));
  assert.ok(plan.files.some(file => file.name === "settings.yml" && file.content.includes("json")));
  assert.equal(artifact(plan, "service.json").networkConfiguration.awsvpcConfiguration.assignPublicIp, "DISABLED");
});

test("Kubernetes model has only private service, exact n8n ingress, one replica and an existing claim", () => {
  for (const provider of ["eks", "eks-fargate", "gke", "gke-autopilot", "aks"]) {
    const inputs = provider === "eks-fargate" ? { ...kubernetes, ...fargate, efsStaticPvName: "existing-static-efs-pv" } : kubernetes;
    const plan = render(provider, "model", inputs);
    const deployment = artifact(plan, "deployment.json");
    const service = artifact(plan, "service.json");
    const policy = artifact(plan, "network-policy.json");
    assert.deepEqual(plan.files.slice(0, provider === "eks-fargate" ? 4 : 3).map(file => file.name),
      provider === "eks-fargate"
        ? ["security-group-policy.json", "network-policy.json", "deployment.json", "service.json"]
        : ["network-policy.json", "deployment.json", "service.json"]);
    assert.equal(deployment.spec.replicas, 1);
    assert.equal(deployment.spec.strategy.type, "Recreate");
    assert.equal(deployment.spec.template.spec.volumes[0].persistentVolumeClaim.claimName, inputs.modelClaimName);
    assert.equal(deployment.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
    assert.equal(deployment.spec.template.spec.containers[0].securityContext.runAsNonRoot, true);
    assert.equal(service.spec.type, "ClusterIP");
    assert.equal(policy.spec.ingress[0].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"], inputs.n8nNamespace);
    assert.equal(policy.spec.ingress[0].from[0].podSelector.matchLabels[inputs.n8nPodLabelKey], inputs.n8nPodLabelValue);
    assert.equal(policy.spec.ingress[0].ports[0].port, 11434);
    assert.equal(plan.connection.baseUrl, "http://relmio-model-abcdef123456.inference.svc.cluster.local:11434/v1");
    if (provider === "eks-fargate") {
      assert.ok(plan.requirements.some(text => text.includes("existing-static-efs-pv")));
      assert.ok(plan.requirements.some(text => text.includes("NetworkPolicy is not enforced")));
      assert.equal(deployment.spec.template.metadata.labels["eks.amazonaws.com/fargate-profile"], fargate.fargateProfileName);
      assert.deepEqual(artifact(plan, "security-group-policy.json").spec.securityGroups.groupIds, [fargate.fargateSecurityGroupId]);
    }
  }
});

test("Kubernetes search uses the existing referenced Secret and restricts ingress to n8n", () => {
  const plan = render("gke-autopilot", "searxng", {
    ...kubernetes,
    searchRepository: "europe-west1-docker.pkg.dev/my-project/my-repository/searxng",
    searchSecretName: "existing-searxng-secret",
  });
  const deployment = artifact(plan, "deployment.json");
  const policy = artifact(plan, "network-policy.json");
  assert.deepEqual(plan.files.slice(0, 3).map(file => file.name), ["network-policy.json", "deployment.json", "service.json"]);
  assert.equal(deployment.spec.template.spec.containers[0].env.find(e => e.name === "SEARXNG_SECRET").valueFrom.secretKeyRef.name, "existing-searxng-secret");
  assert.equal(policy.spec.ingress[0].ports[0].port, 8080);
  assert.equal(artifact(plan, "service.json").spec.type, "ClusterIP");
  assert.equal(plan.connection.searchUrl, "http://relmio-searxng-abcdef123456.inference.svc.cluster.local:8080/search?q=n8n&format=json");
  assert.ok(plan.files.some(file => file.name === "Dockerfile"));
});

test("Kubernetes rejects invalid selectors, namespaces, PVCs and Fargate without static EFS attestation", () => {
  for (const changes of [
    { namespace: "public\n---" },
    { n8nNamespace: "../automation" },
    { namespace: "automation.invalid" },
    { n8nPodLabelKey: "bad key" },
    { n8nPodLabelValue: "" },
    { n8nPodLabelKey: "bad..domain/key" },
    { modelClaimName: "" },
  ]) assert.throws(() => render("gke", "model", { ...kubernetes, ...changes }));
  assert.throws(() => render("eks-fargate", "model", kubernetes));
  assert.throws(() => render("eks-fargate", "model", { ...kubernetes, ...fargate, efsStaticPvName: "fake/ebs" }));
  assert.throws(() => render("eks-fargate", "model", { ...kubernetes, ...fargate, efsStaticPvName: "existing-static-efs-pv", fargateSecurityGroupId: "0.0.0.0/0" }));
  const search = render("eks-fargate", "searxng", { ...kubernetes, ...fargate, searchRepository: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/search", searchSecretName: "secret" });
  assert.equal(artifact(search, "deployment.json").spec.template.spec.volumes.some(volume => volume.persistentVolumeClaim), false);
  assert.deepEqual(artifact(search, "security-group-policy.json").spec.securityGroups.groupIds, [fargate.fargateSecurityGroupId]);
});

test("public planner rejects extra secret fields and unsupported registry paths before issuing a bundle", () => {
  const { namespace, n8nNamespace, n8nPodLabelKey, n8nPodLabelValue } = kubernetes;
  const inputs = {
    namespace, n8nNamespace, n8nPodLabelKey, n8nPodLabelValue,
    searchRepository: "europe-west1-docker.pkg.dev/my-project/my-repository/searxng",
    searchSecretName: "existing-searxng-secret",
  };
  const request = { providerId: "gke", component: "searxng", deploymentId, inputs };
  const plan = createHostingDeploymentPlan(request);
  assert.equal(plan.verification, "not-live-tested");
  assert.throws(() => createHostingDeploymentPlan({ ...request, inputs: { ...inputs, secretValue: "actual-secret-value" } }));
  assert.throws(() => createHostingDeploymentPlan({ ...request, inputs: { ...inputs, searchRepository: "evil.example/search:latest" } }));
  assert.throws(() => createHostingDeploymentPlan({ ...request, inputs: { ...inputs, n8nNamespace: "automation\n{\"namespaceSelector\":{}}" } }));
});
