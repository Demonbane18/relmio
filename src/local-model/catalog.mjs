const GIB = 1024 ** 3;

export const LOCAL_MODEL_CATALOG_REVISION = "2026-09-26";

// Download bytes are registry manifest layer sums observed on 2026-09-26.
// Full manifest SHA-256 values hash the exact raw registry response, not a weight blob.
// Memory/context values are conservative planning allowances, not benchmarks.
export const LOCAL_MODEL_CATALOG = Object.freeze([
  ["qwen3:0.6b", "Qwen3 0.6B", "Q4_K_M", 522653277, 2048, 2, "Qwen3-0.6B", "7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435"],
  ["qwen3:1.7b", "Qwen3 1.7B", "Q4_K_M", 1359292957, 2048, 3.5, "Qwen3-1.7B", "8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7"],
  ["qwen3.5:2b", "Qwen3.5 2B", "Q8_0", 2741192347, 4096, 5, "Qwen3.5-2B", "324d162be6ca5629ae4517c8710434d0bd2d665bc94dbad46e9af8fbf8a2f0df"],
  ["qwen3.5:4b", "Qwen3.5 4B", "Q4_K_M", 3389983260, 4096, 7, "Qwen3.5-4B", "2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd"],
  ["qwen3.5:9b", "Qwen3.5 9B", "Q4_K_M", 6594474236, 8192, 11, "Qwen3.5-9B", "6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7"],
].map(([id, label, quantization, expectedDownloadBytes, contextTokens, memoryGiB, card, digest]) => Object.freeze({
  id, label, quantization, expectedDownloadBytes, contextTokens, manifestDigest: `sha256:${digest}`,
  memoryBytes: memoryGiB * GIB,
  license: "Apache-2.0",
  licenseUrl: `https://huggingface.co/Qwen/${card}/blob/main/LICENSE`,
  sourceUrl: `https://registry.ollama.ai/v2/library/${id.replace(":", "/manifests/")}`,
  observedAt: LOCAL_MODEL_CATALOG_REVISION,
})));

export function getLocalModelDefinition(modelId) {
  const definition = LOCAL_MODEL_CATALOG.find(model => model.id === modelId);
  if (!definition) throw new TypeError("Choose an approved local model.");
  return definition;
}
