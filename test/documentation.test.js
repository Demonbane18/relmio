import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createComposeFile,
  createDockerfile,
} from "../src/domain/templates.js";

test("manual guide copies the generated sidecar files exactly", async () => {
  const guide = await readFile("docs/manual-install.md", "utf8");

  assert.ok(guide.includes(createDockerfile().trim()));
  assert.ok(guide.includes(createComposeFile({ networkName: "proxy" }).trim()));
  assert.match(
    guide,
    /up -d --wait --wait-timeout 60 --no-deps openai-oauth/,
  );
  assert.match(guide, /http:\/\/n8n-openai-oauth:10531\/v1/);
  assert.doesNotMatch(guide, /148\.230\.103\.145/);
});

test("beginner documentation states the critical safety and product limits", async () => {
  const files = await Promise.all(
    [
      "README.md",
      "docs/troubleshooting.md",
      "docs/security.md",
      "docs/maintenance.md",
    ].map((path) => readFile(path, "utf8")),
  );
  const contents = files.join("\n");

  assert.match(contents, /does \*\*not\*\* create a real OpenAI API key/i);
  assert.match(contents, /never (?:edits|delete).*n8n/i);
  assert.match(contents, /unofficial/i);
  assert.match(contents, /OpenAI Terms/i);
  assert.match(contents, /no host `ports` mapping/i);
  assert.match(contents, /This sign-in request expired/i);
  assert.match(contents, /no matches found/i);
});
