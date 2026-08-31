import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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
  assert.match(html, /<body data-current-step="1">/u);
  assert.match(html, /<title>Relmio \| n8n Setup<\/title>/u);
  assert.match(html, /class="brand-mark"[\s\S]*<span>Relmio<\/span>/u);
  assert.match(html, /class="theme-picker"/u);
  assert.match(html, /name="color-theme" value="system"/u);
  assert.match(html, /name="color-theme" value="light"/u);
  assert.match(html, /name="color-theme" value="dark"/u);
  assert.match(html, /class="theme-icon theme-icon-system"/u);
  assert.match(html, /class="theme-icon theme-icon-light"/u);
  assert.match(html, /class="theme-icon theme-icon-dark"/u);
  assert.match(html, /title="Use system appearance"/u);
  assert.match(
    html,
    /<nav class="steps" aria-label="Setup progress">[\s\S]*data-step-marker="1"[\s\S]*data-step-marker="5"/u,
  );
  assert.match(html, /<main id="main-content" class="shell" tabindex="-1">/u);
  assert.match(
    html,
    /<aside class="rail" aria-label="Setup progress and safety">/u,
  );
  assert.match(
    html,
    /class="rail"[\s\S]*<h1 id="page-title">[\s\S]*aria-label="Setup progress"[\s\S]*class="toast-stack"[\s\S]*<section class="panel" data-step="1"/u,
  );
  assert.match(html, /unofficial, private, and policy-uncertain/u);
  assert.doesNotMatch(html, /class="(?:eyebrow|step-kicker)"/u);
  assert.doesNotMatch(html, /n8n OAuth Bridge/u);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /Back up first/);
  assert.match(html, /Export your n8n workflows before connecting/);
  assert.match(
    html,
    /class="toast-stack" aria-label="Wizard notifications"[\s\S]*id="global-safety"[\s\S]*id="global-backup"[\s\S]*id="global-message"[\s\S]*id="global-error"/u,
  );
  assert.match(html, /id="global-message"[\s\S]*role="status"/u);
  assert.match(html, /id="global-error"[\s\S]*role="alert"\s+tabindex="-1"/u);
  assert.equal(
    (html.match(/class="toast-close"/gu) ?? []).length,
    4,
  );
  assert.match(html, /data-dismiss-toast="global-safety"/u);
  assert.match(html, /data-dismiss-toast="global-backup"/u);
  assert.match(html, /data-dismiss-toast="global-message"/u);
  assert.match(html, /data-dismiss-toast="global-error"/u);
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
  assert.match(
    html,
    /data-copy-target="result-http-body"[\s\S]*aria-label="Copy HTTP JSON body"/,
  );
  assert.match(html, /id="copy-settings"[\s\S]*data-copy-group="credential"/u);
  assert.match(html, /id="copy-http-recipe"[\s\S]*data-copy-group="http"/u);
  assert.equal(
    (html.match(/<details class="recipe-disclosure">/gu) ?? []).length,
    2,
  );
  assert.match(
    html,
    /<details class="recipe-disclosure">[\s\S]*<summary>[\s\S]*AI Agent or Basic LLM Chain/u,
  );
  assert.match(
    html,
    /<details class="recipe-disclosure">[\s\S]*<summary>[\s\S]*HTTP Request node/u,
  );
  assert.match(html, /<dt>Method<\/dt>[\s\S]*<code>POST<\/code>/u);
  assert.match(html, /Generic Auth Type[\s\S]*Bearer Auth/u);
  assert.match(html, /Credential[\s\S]*openai-oauth/u);
  assert.match(html, /Bearer token[\s\S]*local-only/u);
  assert.match(html, /Authorization header[\s\S]*Bearer local-only/u);
  assert.match(
    html,
    /data-copy-target="result-http-auth"[\s\S]*aria-label="Copy Authorization header"/u,
  );
  assert.match(html, /Content-Type[\s\S]*application\/json/u);
  assert.match(html, /Send body[\s\S]*JSON[\s\S]*Using JSON/u);
  assert.match(html, /id="result-http-body"/u);
  assert.match(html, /OpenAI credential[\s\S]*OpenAI Chat Model/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\sonclick=/i);
});

test("VPS wizard uses icon-only copy controls and starts fresh from Ready", async () => {
  const [html, script, css] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/styles.css", "utf8"),
  ]);

  assert.doesNotMatch(html, />\s*Copy(?:\s+[^<]*)?\s*<\/button>/u);
  assert.match(
    html,
    /data-copy-target="result-url"[\s\S]*aria-label="Copy Base URL"[\s\S]*title="Copy Base URL"[\s\S]*class="copy-icon copy-icon-copy"[\s\S]*class="copy-icon copy-icon-check"/u,
  );
  assert.match(
    html,
    /id="copy-settings"[\s\S]*aria-label="Copy OpenAI credential settings"[\s\S]*title="Copy OpenAI credential settings"/u,
  );
  assert.match(html, /data-step="5"[\s\S]*id="setup-another-vps"/u);
  assert.doesNotMatch(html, /data-step="5"[\s\S]*data-back="4"/u);
  assert.match(script, /element\("setup-another-vps"\)\.href = token/u);
  assert.match(script, /button\.classList\.add\("copied"\)/u);
  assert.match(css, /\.copy-value\.copied \.copy-icon-copy/u);
  assert.match(css, /\.copy-value\.copied \.copy-icon-check/u);
  assert.match(css, /\.copy-value\s*\{[^}]*min-height:\s*2\.75rem;[^}]*width:\s*2\.75rem;/su);
});

test("workspace CSS keeps the document still and notices in flow", async () => {
  const css = await readFile("src/ui/styles.css", "utf8");

  const bodyBlock = css.match(/(?:^|\n)body\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(bodyBlock, /overflow:\s*hidden/u);

  const toastStackBlock = css.match(/\.toast-stack\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.notEqual(toastStackBlock, "");
  assert.doesNotMatch(toastStackBlock, /position:\s*fixed/u);

  const panelBlock = css.match(/\.panel\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(panelBlock, /overflow-y:\s*auto/u);

  assert.match(css, /--radius-lg:\s*1rem/u);
});

test("short narrow viewports preserve an internally scrollable task panel", async () => {
  const css = await readFile("src/ui/styles.css", "utf8");
  const shortNarrowStart = css.indexOf(
    "@media (max-width: 60rem) and (max-height: 36rem)",
  );

  assert.notEqual(shortNarrowStart, -1);

  const shortNarrowCss = css.slice(shortNarrowStart);
  assert.match(shortNarrowCss, /\.intro\s*\{\s*display:\s*none/u);
  assert.match(
    shortNarrowCss,
    /\.shell\s*\{[\s\S]*grid-template-rows:\s*auto\s+minmax\(7rem,\s*1fr\)/u,
  );
  assert.match(
    shortNarrowCss,
    /\.toast-stack\s*\{[\s\S]*display:\s*flex[\s\S]*overflow-x:\s*auto/u,
  );
  assert.match(shortNarrowCss, /\.safety-note\s*>\s*span\s*\{\s*display:\s*none/u);
  assert.match(
    shortNarrowCss,
    /\.panel\s*\{[\s\S]*min-height:\s*7rem[\s\S]*overflow-y:\s*auto/u,
  );
});

test("browser code never uses innerHTML or web storage for credentials", async () => {
  const [app, oauthPopup] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/oauth-popup.js", "utf8"),
  ]);
  const browserCode = `${app}\n${oauthPopup}`;

  assert.doesNotMatch(browserCode, /\.innerHTML\b/);
  assert.doesNotMatch(browserCode, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(app, /console\.(?:log|warn|error)/);
  assert.match(app, /textContent/);
  assert.match(app, /authUpdatedAt/);
  assert.match(app, /Fresh sign-in saved/);
  assert.match(app, /unexpected response/);
  assert.match(app, /full URL printed by the active setup terminal/);
  assert.match(app, /installAttempted/);
  assert.match(app, /status\.previewMode/);
  assert.match(app, /Preview sign-in disabled/);
  assert.match(
    app,
    /querySelectorAll\(\s*"\[data-copy-target\], \[data-copy-group\]",?\s*\)/u,
  );
  assert.match(app, /async function copyText\(value\)/);
  assert.match(app, /textarea\.focus\(\)/);
  assert.match(app, /textarea\.select\(\)/);
  assert.match(app, /textarea\.setSelectionRange\?\.\(0, textarea\.value\.length\)/);
  assert.match(app, /document\.execCommand\("copy"\)/);
  assert.match(
    app,
    /const textarea = document\.createElement\("textarea"\);[\s\S]*textarea\.focus\(\);[\s\S]*textarea\.select\(\);[\s\S]*textarea\.setSelectionRange\?\.\(0, textarea\.value\.length\);[\s\S]*document\.execCommand\("copy"\)[\s\S]*finally \{[\s\S]*textarea\.remove\(\);[\s\S]*previouslyFocused\?\.focus\?\.\(\);[\s\S]*if \(copied\) \{[\s\S]*navigator\.clipboard\.writeText\(value\)/u,
  );
  assert.match(app, /messages:[\s\S]*What is a robot\?/u);
  assert.match(app, /response_format:[\s\S]*json_schema/u);
  assert.match(app, /additionalProperties: false/u);
  assert.match(app, /strict: true/u);
  assert.match(app, /chat\/completions/u);
  assert.match(app, /Authentication: Generic Credential Type/u);
  assert.match(app, /Generic Auth Type: Bearer Auth/u);
  assert.match(app, /Authorization: \$\{element\("result-http-auth"\)\.textContent\}/u);
  assert.match(app, /Specify Body: Using JSON/u);
  assert.match(app, /function dismissToast\(toast\)/u);
  assert.match(app, /document\.body\.dataset\.currentStep = String\(step\)/u);
  assert.match(
    app,
    /if \(step === 5\) \{[\s\S]*dismissToast\(element\("global-safety"\)\);[\s\S]*dismissToast\(element\("global-backup"\)\);/u,
  );
  assert.match(app, /window\.setTimeout\([\s\S]*dismissToast\(messageToast\)/u);
  assert.match(app, /data-dismiss-toast/u);
  assert.doesNotMatch(app, /"Use Responses API: on"/u);
});

test("copy success survives the browser clearing event.currentTarget", async () => {
  const app = await readFile("src/ui/app.js", "utf8");
  const functionStart = app.indexOf("function createCopyClickHandler(");
  const functionEnd = app.indexOf("const handleCopyClick", functionStart);

  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const functionSource = app.slice(functionStart, functionEnd).trimEnd();
  const createCopyClickHandler = vm.runInNewContext(
    `${functionSource}; createCopyClickHandler`,
  );
  const button = { dataset: { copyLabel: "Base URL" } };
  const event = { currentTarget: button };
  const calls = [];
  const handler = createCopyClickHandler({
    copyValueFor(copyButton) {
      assert.equal(copyButton, button);
      return "http://n8n-openai-oauth:10531/v1";
    },
    clearError() {
      calls.push("clear-error");
    },
    async copyText(value) {
      calls.push(["copy", value]);
      await Promise.resolve();
    },
    flashCopied(copyButton) {
      calls.push(["flash", copyButton]);
    },
    setMessage(message) {
      calls.push(["message", message]);
    },
    showError(error) {
      calls.push(["error", error.message]);
    },
  });

  const completion = handler(event);
  event.currentTarget = null;
  await completion;

  assert.deepEqual(calls, [
    "clear-error",
    ["copy", "http://n8n-openai-oauth:10531/v1"],
    ["flash", button],
    ["message", "Base URL copied."],
  ]);
});

test("local OAuth prepares and navigates its popup before severing opener access", async () => {
  const [app, html] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/index.html", "utf8"),
  ]);

  assert.match(app, /Preparing a fresh ChatGPT sign-in/u);
  assert.match(app, /prepareOAuthPopup\(loginWindow\);/u);
  assert.match(
    app,
    /loginWindow\.location\.replace\(authorizationUrl\);[\s\S]*loginWindowNavigated = true;[\s\S]*loginWindow\.opener = null;/u,
  );
  assert.match(
    app,
    /loginWindow\.location\.replace\(authorizationUrl\);[\s\S]*loginWindow\.opener = null;/u,
  );
  assert.doesNotMatch(
    app,
    /const loginWindow = window\.open\("about:blank", "_blank"\);[\s\S]{0,120}loginWindow\.opener = null;/u,
  );
  assert.match(app, /loginLink\.href = authorizationUrl;/u);
  assert.match(app, /loginWindow\.close\(\);/u);
  assert.match(html, /id="login-link"[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"/u);
});

test("OAuth UI offers an accessible stop control and rejects stale polling after replacement", async () => {
  const [app, html] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/index.html", "utf8"),
  ]);

  assert.match(
    html,
    /<button id="stop-login-button" class="button secondary" type="button" hidden>\s*Stop ChatGPT sign-in\s*<\/button>/u,
  );
  assert.match(app, /async function waitForOAuthCompletion\(expectedAttemptId\)/u);
  assert.match(
    app,
    /result\.retryBlocked === true[\s\S]*oauthRetryBlocked = true[\s\S]*result\.attemptId !== expectedAttemptId/u,
  );
  assert.match(
    app,
    /result\.attemptId !== expectedAttemptId[\s\S]*replaced by a newer attempt/u,
  );
  assert.match(
    app,
    /if \(error\.oauthRetryBlocked === true\) \{\s*blockOAuthRetry\(\);/u,
  );
  assert.match(app, /\/api\/oauth\/cancel/u);
  assert.match(app, /body: \{ attemptId \}/u);
  assert.match(app, /oauthLoginGeneration/u);
  assert.match(app, /oauthRetryBlocked/u);
  assert.match(app, /stop-login-button/u);
});

test("wizard theme preferences store only the selected color mode", async () => {
  const theme = await readFile("src/ui/theme.js", "utf8");

  assert.match(theme, /relmio-color-mode/u);
  assert.match(theme, /localStorage\.getItem/u);
  assert.match(theme, /localStorage\.setItem/u);
  assert.doesNotMatch(theme, /password|credential|token|fingerprint/iu);
});
