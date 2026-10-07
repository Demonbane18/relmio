import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


function assertOnlyDocumentationAddresses(contents) {
  const allowed = new Set(["0.0.0.0", "127.0.0.1", "192.0.2.10"]);
  const addresses = contents.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu) ?? [];

  for (const address of addresses) {
    assert.ok(
      allowed.has(address),
      "documentation contains a non-documentation IPv4 address",
    );
  }
}

test("public setup examples do not expose private host addresses", async () => {
  for (const path of [
    "docs/manual-install.md",
    "docs/local-dashboard.md",
    "docs/n8n-configuration.md",
  ]) {
    assertOnlyDocumentationAddresses(await readFile(path, "utf8"));
  }
});


test("local endpoint curl samples keep bearer credentials out of process arguments", async () => {
  const guides = await Promise.all(
    ["docs/local-endpoints.md", "docs/reference.md"].map((path) =>
      readFile(path, "utf8"),
    ),
  );

  for (const guide of guides) {
    assert.doesNotMatch(
      guide,
      /(?:--header|-H) "Authorization: Bearer \$RELMIO_[A-Z_]+"/u,
    );
  }
});

