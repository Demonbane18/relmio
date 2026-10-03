import assert from "node:assert/strict";
import test from "node:test";
import { getHostingDeploymentProfiles } from "../src/domain/hosting-deployment.js";

// Browsers compile an input's pattern attribute as `^(?:pattern)$` with the
// `v` flag. A pattern that fails there is silently ignored, so the field loses
// native validation and a bad value only fails later on the server.
test("every hosting field pattern compiles the way browsers compile input patterns", () => {
  const rejected = [];
  let checked = 0;
  for (const { providerId, component, fields } of getHostingDeploymentProfiles()) {
    for (const field of fields) {
      if (typeof field.pattern !== "string") continue;
      checked += 1;
      try {
        new RegExp(`^(?:${field.pattern})$`, "v");
      } catch {
        rejected.push(`${providerId}/${component}/${field.name}: ${field.pattern}`);
      }
    }
  }
  assert.ok(checked > 100, `expected the full hosting catalog, checked ${checked} patterns`);
  assert.deepEqual(rejected, []);
});
