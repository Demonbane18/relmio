import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatAuthUpdatedAt } from "../src/ui/time.js";

test("credential timestamps are formatted in the user's local date and time", () => {
  assert.equal(
    formatAuthUpdatedAt("2026-07-28T01:11:01.000Z", {
      locale: "en-US",
      timeZone: "Asia/Manila",
    }),
    "Jul 28, 2026, 9:11:01 AM",
  );
  assert.equal(formatAuthUpdatedAt("not-a-date"), null);
});

test("wizard HTML has accessible landmarks, labels, and no inline scripts", async () => {
  const html = await readFile("src/ui/index.html", "utf8");

  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Relmio \| Private n8n setup<\/title>/u);
  assert.match(
    html,
    /<body>\s*<!--[\s\S]*c4426c7c[\s\S]*unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN\.md[\s\S]*-->/u,
  );
  assert.match(html, /class="brand-mark"[\s\S]*<span>Relmio<\/span>/u);
  assert.doesNotMatch(html, /n8n OAuth Bridge/u);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /class="wizard-layout"/);
  assert.match(html, /Your private route/);
  assert.match(html, /id="preview-badge"[\s\S]*Sanitized preview/);
  assert.match(html, /Five gates\. One private sidecar\./);
  assert.match(html, /Runs only on this computer/);
  assert.match(html, /Back up first/);
  assert.match(html, /Export your n8n workflows before connecting/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert" tabindex="-1"/);
  assert.match(
    html,
    /id="auth-updated"[^>]*hidden[\s\S]*<time id="auth-updated-time"><\/time>/,
  );
  assert.equal(
    (html.match(/<h2[^>]*tabindex="-1"/g) ?? []).length,
    5,
  );
  assert.match(html, /<label class="field">[\s\S]*id="host"/);
  assert.match(html, /id="password"[\s\S]*disabled[\s\S]*required/);
  assert.match(
    html,
    /data-copy-target="result-url"[\s\S]*aria-label="Copy Base URL"/,
  );
  assert.match(
    html,
    /data-copy-target="result-key"[\s\S]*aria-label="Copy API key"/,
  );
  assert.match(
    html,
    /data-copy-target="result-model"[\s\S]*aria-label="Copy model ID"/,
  );
  assert.match(
    html,
    /data-copy-target="result-http-url"[\s\S]*aria-label="Copy HTTP endpoint"/,
  );
  assert.match(html, /OpenAI credential[\s\S]*OpenAI Chat Model/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\sonclick=/i);
});

test("wizard visual system is responsive, theme-aware, and gradient-free", async () => {
  const css = await readFile("src/ui/styles.css", "utf8");

  assert.match(css, /color-scheme:\s*light dark/u);
  assert.match(css, /@media \(prefers-color-scheme:\s*dark\)/u);
  assert.match(css, /@media \(min-width:\s*60rem\)/u);
  assert.match(css, /--signal:/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /\.preview-badge/u);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/u);
  assert.doesNotMatch(css, /\.eyebrow|\.step-kicker/u);
});

test("browser code never uses innerHTML or web storage for credentials", async () => {
  const app = await readFile("src/ui/app.js", "utf8");

  assert.doesNotMatch(app, /\.innerHTML\b/);
  assert.doesNotMatch(app, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(app, /console\.(?:log|warn|error)/);
  assert.match(app, /textContent/);
  assert.match(app, /authUpdatedAt/);
  assert.match(app, /Fresh sign-in saved/);
  assert.match(app, /unexpected response/);
  assert.match(app, /installAttempted/);
  assert.match(app, /status\.previewMode/);
  assert.match(app, /Preview sign-in disabled/);
  assert.match(app, /querySelectorAll\("\[data-copy-target\]"\)/);
  assert.match(app, /async function copyText\(value\)/);
  assert.match(app, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(app, /document\.execCommand\("copy"\)/);
  assert.match(
    app,
    /try \{[\s\S]*document\.execCommand\("copy"\)[\s\S]*finally \{[\s\S]*textarea\.remove\(\)[\s\S]*previouslyFocused\?\.focus\?\.\(\)/u,
  );
  assert.doesNotMatch(app, /"Use Responses API: on"/u);
});
