import assert from "node:assert/strict";
import test from "node:test";

import { classifyGrokLoginExitCode } from "../src/services/vps-supergrok.js";

test("SuperGrok credential status identifies only GNU timeout exit 124 as expired", () => {
  assert.equal(classifyGrokLoginExitCode(0), "complete");
  assert.equal(classifyGrokLoginExitCode(124), "expired");
  assert.equal(classifyGrokLoginExitCode(137), "failed");
  assert.equal(classifyGrokLoginExitCode(undefined), "failed");
});
