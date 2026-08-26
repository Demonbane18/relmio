import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function relativeLuminance(hex) {
  const channels = hex
    .match(/[\da-f]{2}/giu)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return (
    0.2126 * channels[0] +
    0.7152 * channels[1] +
    0.0722 * channels[2]
  );
}

function contrastRatio(first, second) {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

test("local endpoint wizard exposes an accessible four-step flow", async () => {
  const html = await readFile("src/ui/local.html", "utf8");

  assert.match(html, /<html lang="en">/u);
  assert.match(html, /<title>Relmio \| Local Endpoint Setup<\/title>/u);
  assert.match(html, /<main id="main-content" class="shell" tabindex="-1">/u);
  assert.match(
    html,
    /<aside class="rail" aria-label="Local setup progress and safety">/u,
  );
  assert.match(html, /Local pre-flight/u);
  assert.match(html, /One boundary at a time/u);
  assert.match(
    html,
    /<nav class="steps" aria-label="Local setup progress">[\s\S]*data-step-marker="1"[\s\S]*data-step-marker="4"/u,
  );
  assert.equal((html.match(/<h1\b/gu) ?? []).length, 1);
  assert.equal((html.match(/<h2[^>]*tabindex="-1"/gu) ?? []).length, 4);
  assert.match(html, /<fieldset class="target-picker">[\s\S]*<legend>/u);
  assert.match(html, /name="target" value="openai-api" checked/u);
  assert.match(html, /name="target" value="codex-chatgpt"/u);
  assert.match(html, /<label[^>]*class="field compact">[\s\S]*id="local-port"/u);
  assert.match(html, /<label id="origins-field" class="field">[\s\S]*id="allowed-origins"/u);
  assert.match(html, /id="global-message"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(
    html,
    /id="global-error"[\s\S]*role="alert"[\s\S]*tabindex="-1"/u,
  );
  assert.match(html, /id="device-code-status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(html, /id="device-code-link"[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/u);
  assert.doesNotMatch(html, /\sonclick=/iu);
});

test("local wizard header always exposes persistent theme controls, support links, and the package version placeholder", async () => {
  const [html, theme, localStyles] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/theme.js", "utf8"),
    readFile("src/ui/local.css", "utf8"),
  ]);

  assert.match(html, /<script src="\/theme\.js" type="module"><\/script>/u);
  assert.match(
    html,
    /class="header-actions"[\s\S]*name="color-theme" value="system"[\s\S]*name="color-theme" value="light"[\s\S]*name="color-theme" value="dark"/u,
  );
  assert.match(
    html,
    /class="local-repository-button"[\s\S]*href="https:\/\/github\.com\/Demonbane18\/relmio"[\s\S]*GitHub[\s\S]*id="local-repository-stars">\?</u,
  );
  assert.match(
    html,
    /class="local-support-button"[\s\S]*href="https:\/\/ko-fi\.com\/paldogies"/u,
  );
  assert.match(html, /v__RELMIO_PACKAGE_VERSION__/u);
  assert.match(theme, /relmio-color-mode/u);
  assert.match(theme, /localStorage\.getItem/u);
  assert.match(theme, /localStorage\.setItem/u);
  assert.doesNotMatch(
    theme,
    /password|credential|token|fingerprint/iu,
  );
  assert.match(
    localStyles,
    /\.local-repository-action\s*\{[^}]*background:\s*var\(--background\);[^}]*color:\s*var\(--text\);/u,
  );
  assert.ok(contrastRatio("#f4f2ec", "#0d1b18") >= 4.5);
  assert.ok(contrastRatio("#101513", "#edf3f0") >= 4.5);
});

test("local wizard states the OpenAI and Codex credential boundaries", async () => {
  const html = await readFile("src/ui/local.html", "utf8");

  assert.match(html, /A ChatGPT subscription is not an OpenAI Platform API key/u);
  assert.match(html, /Relmio never converts one into the other/u);
  assert.match(html, /Platform API usage is billed[\s\S]*separately from ChatGPT/u);
  assert.match(html, /This is not an OpenAI-compatible <code>\/v1<\/code> endpoint/u);
  assert.match(html, /browsers cannot connect directly/u);
  assert.match(html, /High-trust capability/u);
  assert.match(
    html,
    /client credential can control Codex[\s\S]*recover that container's ChatGPT session[\s\S]*credential/u,
  );
  assert.match(html, /Treat this capability like your ChatGPT password/u);
  assert.match(html, /trusted native local app/u);
  assert.match(html, /bind only to[\s\S]*<code>127\.0\.0\.1<\/code>/u);
  assert.match(html, /id="install-confirm" type="checkbox"/u);
  assert.match(
    html,
    /id="platform-api-key"[\s\S]*pattern="sk-\[A-Za-z0-9_\\-\]\{32,509\}"/u,
  );
  assert.match(html, /id="review-origins-row"[\s\S]*id="review-origins"/u);
  assert.match(html, /authorize Relmio to write[\s\S]*start this Docker container/u);
  assert.match(html, /shows the generated client credential only in this install[\s\S]*response/u);
});

test("local wizard shows Codex WebSocket production limits before and after install", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
  ]);

  assert.match(
    html,
    /value="codex-chatgpt"[\s\S]*Codex App Server WebSocket is experimental and unsupported for production workloads/u,
  );
  assert.match(
    html,
    /data-step="4"[\s\S]*id="codex-production-warning"[\s\S]*id="codex-production-warning-detail"/u,
  );
  assert.match(
    script,
    /Codex App Server WebSocket is experimental and unsupported for production workloads/u,
  );
});

test("local wizard presents Codex Chat as an experimental server-side HTTP adapter", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
  ]);

  assert.match(html, /name="target" value="codex-chat"/u);
  assert.match(html, /Codex Chat Adapter/u);
  assert.match(html, /Relmio-specific authenticated <code>POST \/chat<\/code>/u);
  assert.match(html, /browser bundles[\s\S]*must never connect/u);
  assert.match(
    html,
    /trusted local backends or development servers only/u,
  );
  assert.match(script, /return target === "codex-chat"/u);
  assert.match(script, /\? "14501"/u);
  assert.match(script, /Relmio Codex Chat HTTP: POST \/chat/u);
  assert.match(script, /no CORS/u);
  assert.match(
    script,
    /Credential for trusted local backends or development servers only/u,
  );
  assert.match(
    script,
    /Experimental Codex Chat Adapter — trusted local backends or development servers only/u,
  );
  assert.match(
    script,
    /Experimental Chat Adapter — trusted local backends or development servers only/u,
  );
  assert.match(
    script,
    /Codex Chat Adapter for trusted local backends or development servers verified/u,
  );
  assert.match(
    script,
    /Keep it only in a trusted local backend or development server; never put it in browser code/u,
  );
  assert.match(
    script,
    /ready for your trusted local backend or development server/u,
  );
  assert.doesNotMatch(script, /trusted server-side (?:app|client)/iu);
  assert.doesNotMatch(
    script,
    /Codex Chat[^\n]*(?:native process)|adapter is for[^\n]*native process/iu,
  );
  assert.match(script, /body: \{ target: state\.installedTarget \}/u);
  assert.match(script, /\["openai-api", "codex-chatgpt", "codex-chat"\]/u);
});

test("Codex Chat ready state provides an in-wizard, ephemeral encrypted chat tester", async () => {
  const [html, script, css] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
    readFile("src/ui/local.css", "utf8"),
  ]);

  assert.match(html, /id="chat-tester"[^>]*aria-labelledby="chat-tester-title"/u);
  assert.match(html, /id="chat-tester-title">Test this local Chat Adapter<\/h3>/u);
  assert.match(html, /Streaming verification console/u);
  assert.match(html, /Request route/u);
  assert.match(html, /Wizard relay/u);
  assert.match(html, /Chat Adapter/u);
  assert.match(html, /id="chat-tester-endpoint"[^>]*placeholder="http:\/\/127\.0\.0\.1:14501"/u);
  assert.match(html, /id="chat-tester-credential"[^>]*type="password"/u);
  assert.match(html, /id="chat-tester-transcript"[^>]*role="log"[^>]*aria-live="polite"/u);
  assert.match(html, /id="chat-tester-status"[^>]*role="status"/u);
  assert.match(html, /id="chat-tester-error"[^>]*role="alert"/u);
  assert.match(html, /id="chat-tester-reset"[^>]*>[\s\S]*Forget tester\s*<\/button>/u);
  assert.match(
    html,
    /Encryption prevents accidental transit\/storage exposure but not a compromised browser, extension, or local machine\./u,
  );
  assert.match(script, /window\.crypto\.subtle\.importKey/u);
  assert.match(script, /name: "RSA-OAEP", hash: "SHA-256"/u);
  assert.match(script, /window\.crypto\.subtle\.encrypt/u);
  assert.match(script, /clientCredentialInput\.value = "";/u);
  assert.match(script, /api\("\/api\/local\/chat-test\/key"/u);
  assert.match(script, /fetch\("\/api\/local\/chat-test\/message"/u);
  assert.match(script, /Accept: "text\/event-stream"/u);
  assert.match(script, /response\.body\.getReader\(\)/u);
  assert.match(script, /let exhausted = false;/u);
  assert.match(script, /await reader\.cancel\(\)/u);
  assert.match(script, /event === "delta"/u);
  assert.match(script, /assistantContent\.textContent \+= data\.text/u);
  assert.match(script, /chat-tester-turn-incomplete/u);
  assert.match(script, /Local adapter · incomplete/u);
  assert.match(script, /event === "terminal"/u);
  assert.match(script, /api\("\/api\/local\/chat-test\/reset"/u);
  assert.match(script, /appendChatTesterTurn/u);
  assert.match(script, /\.textContent = text/u);
  assert.doesNotMatch(script, /fetch\(\s*(?:endpointBaseUrl|adapter|chatTester)/u);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|document\.cookie/u);
  assert.match(css, /\.chat-tester\s*\{/u);
  assert.match(css, /\.chat-tester-turn-incomplete\s*\{/u);
  assert.match(css, /@media \(max-width: 48rem\)/u);
});

test("local image build failures reveal only safe guidance and the hosted troubleshooting route", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
  ]);

  assert.match(
    html,
    /id="local-image-build-troubleshooting"[^>]*href="https:\/\/relmio\.vercel\.app\/docs\/troubleshooting#local-image-build-failed"[^>]*>View troubleshooting<\/a>/u,
  );
  assert.match(script, /Local image build failed\./u);
  assert.match(script, /could not build the local image/u);
  assert.doesNotMatch(script, /Docker stderr|docker stderr/u);
});

test("local wizard clearly excludes native Windows", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
  ]);

  assert.match(
    html,
    /Native Windows is not supported[\s\S]*owner-only file permissions/u,
  );
  assert.match(script, /result\.unsupportedPlatform === true/u);
  assert.match(script, /Native Windows is not supported/u);
  assert.match(script, /POSIX owner-only file permissions/u);
});

test("local browser code does not persist or inject credentials", async () => {
  const script = await readFile("src/ui/local.js", "utf8");

  assert.doesNotMatch(script, /\.innerHTML\b/u);
  assert.doesNotMatch(
    script,
    /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/u,
  );
  assert.doesNotMatch(script, /console\.(?:log|warn|error)/u);
  assert.match(script, /\.textContent/u);
  assert.match(
    script,
    /new URLSearchParams\(window\.location\.search\)\.get\("session"\);[\s\S]*window\.history\.replaceState\(null, "", window\.location\.pathname\);/u,
  );
  assert.match(script, /"X-Setup-Token": token/u);
  assert.doesNotMatch(script, /session=\$\{[^}]*clientCredential/u);

  const installStart = script.indexOf(
    'element("install-button").addEventListener("click"',
  );
  const installRequest = script.indexOf(
    'api("/api/local/install"',
    installStart,
  );
  const firstKeyClear = script.indexOf('apiKeyInput.value = "";', installStart);
  assert.notEqual(installStart, -1);
  assert.notEqual(installRequest, -1);
  assert.ok(firstKeyClear > installStart && firstKeyClear < installRequest);
  assert.match(
    script.slice(installStart),
    /finally \{[\s\S]*requestBody\.apiKey = undefined;[\s\S]*apiKeyInput\.value = "";/u,
  );

  assert.match(script, /url\.origin !== "https:\/\/auth\.openai\.com"/u);
  assert.match(script, /url\.username !== ""/u);
  assert.match(script, /url\.password !== ""/u);
  assert.match(script, /url\.hash !== ""/u);
});

test("local Platform key validation uses a browser-compatible pattern", async () => {
  const html = await readFile("src/ui/local.html", "utf8");
  assert.match(html, /pattern="sk-\[A-Za-z0-9_\\-\]\{32,509\}"/u);
});

test("local wizard calls only the dedicated local API contract", async () => {
  const script = await readFile("src/ui/local.js", "utf8");

  for (const path of [
    "/api/local/docker/status",
    "/api/local/project-meta",
    "/api/local/plan",
    "/api/local/install",
    "/api/local/client-credential/rotate",
    "/api/local/client-credential/activate",
    "/api/local/codex/login",
    "/api/local/codex/login/status",
  ]) {
    assert.ok(script.includes(path), `missing local route ${path}`);
  }
  assert.match(script, /result\.dockerAvailable === true/u);
  assert.match(script, /result\.previewMode === true/u);
  assert.match(script, /result\.planId/u);
  assert.match(script, /result\.clientCredential/u);
  assert.match(script, /new Intl\.NumberFormat/u);
  assert.match(script, /result\.verificationUrl/u);
  assert.match(script, /result\.userCode/u);
  assert.match(script, /recover that container's ChatGPT session credential/u);
  assert.match(script, /Treat it like your ChatGPT password/u);
  assert.match(script, /trusted local backends and development servers only/u);
  assert.match(
    script,
    /Codex Chat Adapter for trusted local backends or development servers verified/u,
  );
  assert.doesNotMatch(script, /\/api\/oauth\/login/u);
  assert.doesNotMatch(script, /\/api\/install["']/u);
});

test("local wizard makes credential rotation explicit and replaces only DOM text after a fresh response", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
  ]);

  assert.match(html, /id="rotate-credential-button"/u);
  assert.match(
    html,
    /Relmio shows the replacement first, then activates and verifies\s+it/u,
  );
  assert.match(
    html,
    /After successful activation, the previous credential no longer works/u,
  );
  assert.doesNotMatch(html, /permanently revokes the previous/u);
  assert.match(script, /api\("\/api\/local\/client-credential\/rotate"/u);
  assert.match(script, /api\("\/api\/local\/client-credential\/activate"/u);
  assert.match(script, /setBusy\(button, true, "Rotating credential…"\)/u);
  assert.match(script, /renderInstallResult\(staged\)/u);
  assert.match(script, /requestAnimationFrame/u);
  assert.match(script, /result-credential"\)\.textContent = result\.clientCredential/u);
  assert.doesNotMatch(script, /\.innerHTML\b/u);
});

test("main wizard offers token-preserving local endpoint navigation", async () => {
  const [html, app] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);

  assert.match(html, /id="local-endpoint-title">Need an endpoint on this computer\?/u);
  assert.match(html, /id="local-endpoint-link"[\s\S]*Set up a local endpoint/u);
  assert.match(
    app,
    /localEndpointLink\.href = `\/local\?session=\$\{encodeURIComponent\(token\)\}`;/u,
  );
});

test("local CSS preserves responsive, visible security controls", async () => {
  const css = await readFile("src/ui/local.css", "utf8");

  assert.match(css, /\.target-picker\s*\{[\s\S]*display:\s*grid/u);
  assert.match(css, /\.target-card:has\(input:focus-visible\)/u);
  assert.match(css, /\.high-trust-warning\s*\{/u);
  assert.match(css, /\.one-time-note\s*\{/u);
  assert.match(css, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/u);
  assert.match(css, /@media \(max-width: 48rem\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(css, /position:\s*fixed/u);
  assert.match(css, /\.local-wizard \.toast-stack\s*\{[\s\S]*overflow:\s*visible/u);
  assert.match(
    css,
    /\.local-wizard #global-message-text,[\s\S]*white-space:\s*normal[\s\S]*overflow-wrap:\s*anywhere/u,
  );
  assert.match(css, /\.local-wizard \.safety-note > span\s*\{[\s\S]*display:\s*block/u);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/u);
});
