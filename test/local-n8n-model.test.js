import assert from "node:assert/strict";
import test from "node:test";
import { createLocalN8nModelPlan, normalizeLocalN8nModelPlan, getLocalModelDefinition, createLocalN8nModelComposeFile } from "../src/domain/local-n8n-model.js";

const GIB = 1024 ** 3;
const selection = {
  dockerHost: "unix:///var/run/docker.sock", n8nContainerId: "a".repeat(64),
  n8nContainerName: "existing-n8n", dockerNetworkId: "b".repeat(64), networkName: "private_network",
  modelId: "qwen3:0.6b", hostResources: { memoryBytes: 4 * GIB, cpus: 1, diskAvailableBytes: 50 * GIB },
};

test("local model review rejects unknown capacity and reserves n8n headroom", () => {
  assert.throws(() => createLocalN8nModelPlan({ ...selection, hostResources: undefined }), /Measured Docker/u);
  assert.throws(() => createLocalN8nModelPlan({ ...selection, hostResources: { ...selection.hostResources, cpus: 0 } }), /Measured Docker/u);
  assert.throws(() => createLocalN8nModelPlan({ ...selection, modelId: "qwen3.5:9b" }), /memory is insufficient/u);
  assert.throws(() => createLocalN8nModelPlan({ ...selection, hostResources: { ...selection.hostResources, diskAvailableBytes: GIB } }), /disk is insufficient/u);
  const plan = createLocalN8nModelPlan(selection);
  assert.ok(plan.memoryBytes + plan.reservedMemoryBytes <= selection.hostResources.memoryBytes);
  assert.ok(plan.cpus < selection.hostResources.cpus);
  assert.ok(plan.requiredDiskBytes > plan.expectedDownloadBytes * 2);
});

test("catalog rejects cloud tags, arbitrary registries, shell syntax and prototype names", () => {
  for (const modelId of ["qwen3:latest", "qwen3:0.6b-cloud", "https://example.test/model", "qwen3:0.6b;id", "constructor", "__proto__", null]) {
    assert.throws(() => getLocalModelDefinition(modelId), /approved local model/u);
    assert.throws(() => createLocalN8nModelPlan({ ...selection, modelId }));
  }
  assert.throws(() => { getLocalModelDefinition("qwen3:0.6b").memoryBytes = 1; }, TypeError);
});

test("reviewed plan cannot be rewritten to change identities, cloud, resources or publication", () => {
  const plan = createLocalN8nModelPlan(selection);
  for (const changes of [
    { dockerHost: "tcp://attacker:2375" }, { networkName: "network\nports:" },
    { modelId: "qwen3:1.7b" }, { contextTokens: 32768 }, { memoryBytes: 1 },
    { runtimeImage: "ollama/ollama:latest" }, { hostPublication: "11434" },
    { approvedModelDigest: `sha256:${"f".repeat(64)}` },
    { cloudEnabled: true }, { apiKey: "ignored-secret" }, { authentication: "bearer" },
    { hostResources: { ...plan.hostResources, memoryBytes: 100 * GIB } },
    { hostResources: { ...plan.hostResources, additional: true } },
    { disposableHarnessWarning: "true" },
  ]) assert.throws(() => normalizeLocalN8nModelPlan({ ...plan, ...changes }));
  assert.deepEqual(normalizeLocalN8nModelPlan({ ...plan, disposableHarnessWarning: true }), plan);
});

test("compose generation rejects invalid names, ownership and unreviewable budgets", () => {
  const input = { ...selection, installId: "c".repeat(32) };
  for (const changes of [
    { installId: "../../somewhere" }, { networkName: "network\n  ports: [11434]" },
    { modelId: "qwen3:cloud" }, { hostResources: { ...selection.hostResources, memoryBytes: GIB } },
  ]) assert.throws(() => createLocalN8nModelComposeFile({ ...input, ...changes }));
});
