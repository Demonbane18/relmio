import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("wizard HTML has accessible landmarks, labels, and no inline scripts", async () => {
  const html = await readFile("src/ui/index.html", "utf8");

  assert.match(html, /<html lang="en">/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert" tabindex="-1"/);
  assert.equal(
    (html.match(/<h2[^>]*tabindex="-1"/g) ?? []).length,
    5,
  );
  assert.match(html, /<label class="field">[\s\S]*id="host"/);
  assert.match(html, /id="password"[\s\S]*disabled[\s\S]*required/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\sonclick=/i);
});

test("browser code never uses innerHTML or web storage for credentials", async () => {
  const app = await readFile("src/ui/app.js", "utf8");

  assert.doesNotMatch(app, /\.innerHTML\b/);
  assert.doesNotMatch(app, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(app, /console\.(?:log|warn|error)/);
  assert.match(app, /textContent/);
});
