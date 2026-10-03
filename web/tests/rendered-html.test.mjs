import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import test from "node:test";

async function requestApp(path = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { accept: "text/html", ...init.headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function headerLinks(html) {
  const header = html.match(/<header\b[\s\S]*?<\/header>/u)?.[0] ?? "";
  return [...header.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)].map(([, attributes, inner]) => ({
    attributes,
    text: inner.replace(/<[^>]*>/gu, "").trim(),
  }));
}

function assertSharedTopBar(html, currentLabel) {
  const header = html.match(/<header\b[\s\S]*?<\/header>/u)?.[0] ?? "";
  assert.match(header, /src="\/relmio-icon-96\.png"/u);
  assert.match(header, /<legend[^>]*>Color theme<\/legend>/u);
  for (const mode of ["system", "light", "dark"]) {
    assert.match(header, new RegExp(`name="color-theme"[^>]*value="${mode}"|value="${mode}"[^>]*name="color-theme"`, "u"));
  }

  const links = headerLinks(html);
  for (const [href, label] of [["/", "Home"], ["/install", "Install"], ["/docs", "Docs"], ["/changelog", "Changelog"]]) {
    const link = links.find((candidate) => candidate.text === label && candidate.attributes.includes(`href="${href}"`));
    assert.ok(link, `missing top-bar link ${label}`);
    assert.equal(
      /aria-current="page"/u.test(link.attributes),
      label === currentLabel,
      `${label} aria-current`,
    );
  }

  for (const href of ["https://ko-fi.com/paldogies", "https://github.com/Demonbane18/relmio"]) {
    const external = links.filter((link) => link.attributes.includes(`href="${href}"`));
    assert.ok(external.length > 0, `missing ${href}`);
    for (const link of external) {
      assert.match(link.attributes, /target="_blank"/u);
      assert.match(link.attributes, /rel="noopener noreferrer"/u);
    }
  }
  assert.match(header, /aria-label="Support Relmio on Ko-fi \(opens in a new tab\)"/u);
}

const footerPages = ["/", "/install", "/docs", "/docs/local-endpoints", "/changelog", "/missing-page"];
const footerExternalLinks = [
  ["https://www.npmjs.com/package/relmio", "npm"],
  ["https://github.com/Demonbane18/relmio", "GitHub"],
  ["https://github.com/Demonbane18", "Demonbane18"],
  ["https://x.com/fusheenn", "@fusheenn"],
  ["https://www.linkedin.com/in/john-paul-fusin-35846714a/", "in/john-paul-fusin-35846714a"],
  ["https://www.youtube.com/@harness.engineer", "@harness.engineer"],
  ["https://www.facebook.com/fusin.automation/", "fusin.automation"],
  ["https://ko-fi.com/paldogies", "Ko-fi"],
];

function assertSiteFooter(html, path) {
  const footer = html.slice(html.lastIndexOf("<footer"));
  const links = [...footer.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)].map(([, attributes, inner]) => ({
    attributes,
    text: inner.replace(/<[^>]*>/gu, ""),
  }));
  for (const [href, label] of [["/install", "Install"], ["/docs", "Docs"], ["/changelog", "Changelog"]]) {
    assert.ok(
      links.some((link) => link.attributes.includes(`href="${href}"`) && link.text.trim() === label),
      `${path}: missing footer link ${label}`,
    );
  }
  for (const [href, visible] of footerExternalLinks) {
    const link = links.find((candidate) => candidate.attributes.includes(`href="${href}"`));
    assert.ok(link, `${path}: missing footer link ${href}`);
    assert.ok(link.text.includes(visible), `${path}: ${href} shows ${visible}`);
    assert.match(link.attributes, /target="_blank"/u, href);
    assert.match(link.attributes, /rel="noopener noreferrer"/u, href);
    assert.match(link.text, /\(opens in a new tab\)/u, href);
  }
  const text = footer.replace(/<[^>]*>/gu, "");
  assert.match(
    text,
    new RegExp(`© ${new Date().getFullYear()} John Paul Fusin\\. Relmio is released under the Apache-2\\.0 license`, "u"),
    path,
  );
}

test("every page ends with the site footer, its links and the current copyright year", async () => {
  for (const path of footerPages) {
    const response = await requestApp(path);
    assertSiteFooter(await response.text(), path);
  }
});

test("server-renders the Relmio home page with the shared top bar", async () => {
  const response = await requestApp();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const text = html.replace(/<[^>]*>/g, "");
  assert.match(html, /<title>Relmio \| Connect local AI tools safely<\/title>/i);
  assert.match(text, /Bring your AI sign-ins to your tools\./);
  assertSharedTopBar(html, "Home");

  assert.match(html, /<figure[^>]*data-scene-running[^>]*>[\s\S]*?<svg[^>]*aria-hidden="true"[^>]*>/u);
  assert.match(html, /aria-label="Setup options"/);
  assert.match(html, /aria-pressed="true"/);
  for (const option of [
    "n8n with ChatGPT sign-in",
    "SuperGrok OAuth",
    "n8n Code Sandbox",
    "Codex Chat Adapter",
    "Codex App Server",
    "Local model for n8n",
  ]) {
    assert.match(html, new RegExp(option, "u"));
  }
  assert.match(html, /href="\/install"[^>]*>[\s\S]*?Install Relmio/u);
  assert.match(text, /does not edit the existing n8n container, image, or workflows/u);
  const notice = html.match(/<section[^>]*id="chat"[\s\S]*?<\/section>/u)?.[0] ?? "";
  assert.ok(notice, "the #chat anchor still lands on a section");
  assert.match(notice, /href="\/install"/u);
  assert.match(notice, /<button[^>]*type="button"[^>]*>Remove saved sign-in from this browser<\/button>/u);
  assert.match(notice, /role="status"[^>]*aria-live="polite"/u);
  assert.doesNotMatch(html, /Hosted chat console|chromewebstore\.google\.com|addons\.mozilla\.org|EvanZhouDev\/openai-oauth/u);
  assert.doesNotMatch(html, /href="\/#chat"/u, "no link points at the retired chat");
  assert.doesNotMatch(html, /data-astryx-theme|codex-preview|Your site is taking shape/u);
});

test("missing pages keep a 404 with a usable main and recovery links", async () => {
  const response = await requestApp("/missing-page");
  assert.equal(response.status, 404);
  const html = await response.text();
  assert.match(html, /<meta (?=[^>]*name="robots")(?=[^>]*content="noindex)[^>]*>/u);
  assert.equal((html.match(/<main\b/gu) ?? []).length, 1);
  assert.match(html, /<main[^>]*id="main-content"[^>]*tabindex="-1"/u);
  for (const path of ["/", "/install", "/docs"]) assert.ok(html.includes(`href="${path}"`));
});

test("every page enforces a fresh script nonce that its theme bootstrap and other scripts carry", async () => {
  const paths = ["/", "/docs/local-endpoints", "/missing-page"];
  const nonces = new Set();
  for (const path of paths) {
    const response = await requestApp(path);
    const policy = response.headers.get("content-security-policy") ?? "";
    const nonce = policy.match(/script-src 'self' 'nonce-([^']+)' 'strict-dynamic'(?:;|$)/u)?.[1];
    assert.ok(nonce, `${path}: ${policy}`);
    assert.match(policy, /(?:^|; )default-src 'self'(?:;|$)/u, path);
    assert.equal(response.headers.get("content-security-policy-report-only"), null, path);
    assert.doesNotMatch(policy, /(?:^|; )frame-src /u, `${path}: no frame exceptions`);
    assert.match(policy, /(?:^|; )connect-src 'self'(?:;|$)/u, `${path}: connections stay on the site`);
    nonces.add(nonce);

    const html = await response.text();
    const bootstrap = html.match(/<script\b([^>]*)>[^<]*relmio-color-mode[^<]*<\/script>/u);
    assert.ok(bootstrap, `${path}: theme bootstrap`);
    assert.ok(bootstrap[1].includes(`nonce="${nonce}"`), `${path}: bootstrap nonce`);
    for (const [tag] of html.matchAll(/<script\b[^>]*>/gu)) {
      assert.ok(tag.includes(`nonce="${nonce}"`), `${path}: ${tag}`);
    }
  }
  assert.equal(nonces.size, paths.length, "each response gets its own nonce");
});

test("public pages use their own canonical and social URL despite tracking parameters", async () => {
  for (const path of ["/", "/install", "/docs", "/docs/security", "/changelog"]) {
    const response = await requestApp(`${path}?utm_source=check`);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/u)?.[1];
    const socialUrl = html.match(/<meta property="og:url" content="([^"]+)"/u)?.[1];
    assert.ok(canonical, path);
    assert.equal(new URL(canonical).pathname, path);
    assert.equal(new URL(canonical).search, "");
    assert.equal(socialUrl, canonical);
    assert.match(html, /property="og:image" content="https?:\/\/[^"]+\/og\.png"/u);
    assert.match(html, /name="twitter:image" content="https?:\/\/[^"]+\/og\.png"/u);
  }
});

test("robots and sitemap expose all published guide URLs", async () => {
  const [robots, sitemap] = await Promise.all([requestApp("/robots.txt"), requestApp("/sitemap.xml")]);
  assert.equal(robots.status, 200);
  assert.equal(sitemap.status, 200);
  const robotsText = await robots.text();
  const sitemapUrl = robotsText.match(/Sitemap: ([^\s]+)/u)?.[1];
  assert.equal(new URL(sitemapUrl).pathname, "/sitemap.xml");
  const xml = await sitemap.text();
  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, url]) => new URL(url).pathname);
  for (const path of ["/", "/install", "/docs", "/changelog", "/docs/security", "/docs/vps-supergrok"]) {
    assert.ok(paths.includes(path), path);
  }
  assert.ok(!paths.includes("/chat"), "the /chat redirect is not listed");
});

test("forwarded hosts cannot replace public canonical, social or sitemap URLs", async () => {
  const headers = {
    host: "relmio.jpfusin.tech",
    "x-forwarded-host": "boundary-audit.invalid",
    "x-forwarded-proto": "http",
  };
  const origin = "https://relmio.jpfusin.tech";
  const [page, robots, sitemap] = await Promise.all([
    requestApp("/install", { headers }),
    requestApp("/robots.txt", { headers }),
    requestApp("/sitemap.xml", { headers }),
  ]);
  assert.equal(page.status, 200);
  assert.equal(robots.status, 200);
  assert.equal(sitemap.status, 200);
  const html = await page.text();
  assert.ok(html.includes(`<link rel="canonical" href="${origin}/install"`));
  assert.ok(html.includes(`<meta property="og:url" content="${origin}/install"`));
  assert.ok((await robots.text()).includes(`Sitemap: ${origin}/sitemap.xml`));
  const xml = await sitemap.text();
  assert.ok(xml.includes(`<loc>${origin}/install</loc>`));
  assert.doesNotMatch(xml, /boundary-audit\.invalid/u);
});

test("loopback hosts keep their own HTTP origin despite forwarded headers", async () => {
  for (const host of ["127.0.0.1:3417", "localhost:3421", "[::1]:3456"]) {
    const response = await requestApp("/robots.txt", {
      headers: {
        host,
        "x-forwarded-host": "boundary-audit.invalid",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(response.status, 200, host);
    assert.ok((await response.text()).includes(`Sitemap: http://${host}/sitemap.xml`), host);
  }
});

test("the old /chat address redirects permanently to the hosted chat notice on the home page", async () => {
  const response = await requestApp("/chat");
  assert.equal(response.status, 308);
  const location = new URL(response.headers.get("location") ?? "", "http://localhost");
  assert.equal(location.pathname, "/");
  assert.equal(location.hash, "#chat");
});

test("server-renders canonical generated Markdown documentation routes", async () => {
  const [indexResponse, troubleshootingResponse] = await Promise.all([
    requestApp("/docs"),
    requestApp("/docs/troubleshooting"),
  ]);
  assert.equal(indexResponse.status, 200);
  assert.equal(troubleshootingResponse.status, 200);

  const [indexHtml, troubleshootingHtml] = await Promise.all([
    indexResponse.text(),
    troubleshootingResponse.text(),
  ]);
  assert.match(indexHtml, /Relmio documentation/u);
  assert.match(indexHtml, /href="\/docs\/getting-started"/u);
  assert.match(indexHtml, /href="\/docs\/vps-supergrok"/u);
  assert.match(indexHtml, /aria-label="Documentation navigation"/u);
  assert.match(indexHtml, /Find a guide/u);
  assert.match(
    troubleshootingHtml,
    /Canonical guide · Source <code>docs\/troubleshooting\.md<\/code>/u,
  );
  assert.match(troubleshootingHtml, /aria-label="Adjacent documentation"/u);
  assert.match(troubleshootingHtml, /id="local-image-build-failed"/u);
  assert.match(troubleshootingHtml, /Local image build failed/u);
  assertSharedTopBar(indexHtml, "Docs");
});

test("copy button copies current displayed code after it changes", async () => {
  const source = await readFile(new URL("../app/components/ui/CopyButton.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  let announcement = "";
  let copied = "";
  const code = { textContent: "old command" };
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "react") return {
        useEffect() {}, useRef: () => ({ current: undefined }),
        useState: (initial) => [initial, (value) => { if (typeof initial === "string") announcement = value; }],
      };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "./classNames") return { classNames: (...names) => names.join(" ") };
      if (name === "./Icon") return { Icon: () => null };
      throw new Error(`Unexpected import: ${name}`);
    },
    document: { getElementById: () => code },
    navigator: { clipboard: { async writeText(text) { copied = text; } } },
    window: { clearTimeout() {}, setTimeout() { return 1; } },
  });
  const rendered = exports.CopyButton({ targetId: "rendered-code", label: "command" });
  const button = rendered.props.children[0];
  code.textContent = "displayed command";
  await button.props.onClick();
  assert.equal(copied, "displayed command");
  assert.equal(announcement, "Copied command.");
  assert.equal(button.props["aria-label"], "Copy command");
});

test("renders a command-first self-hosted n8n install page", async () => {
  const response = await requestApp("/install");
  assert.equal(response.status, 200);

  const [html, installScript, commandPromptInstallScript, powerShellInstallScript] = await Promise.all([
    response.text(),
    readFile(new URL("../dist/client/install.sh", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/install.cmd", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/install.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Install Relmio on your computer\./);
  assertSharedTopBar(html, "Install");
  assert.match(html, /Self-hosted n8n/);
  assert.doesNotMatch(html, /Hostinger VPS/);
  assert.match(
    html,
    /Experimental SuperGrok setup works with local apps and private local or VPS n8n companions without a ChatGPT credential\./,
  );
  assert.match(
    html,
    /curl -fsSL https:\/\/relmio\.jpfusin\.tech\/install\.sh \| sh/,
  );
  assert.match(html, /<noscript>[\s\S]*?curl -fsSL https:\/\/relmio\.jpfusin\.tech\/install\.sh \| sh[\s\S]*?npx --yes --ignore-scripts relmio@latest[\s\S]*?<\/noscript>/u);
  const fallback = html.match(/<noscript>([\s\S]*?)<\/noscript>/u)?.[1] ?? "";
  assert.equal((fallback.match(/<details\b/gu) ?? []).length, 4);
  assert.doesNotMatch(fallback, /<details\b[^>]*\bopen\b/u);
  for (const label of ["Homebrew", "PowerShell", "CMD", "NPX"]) {
    assert.ok(fallback.includes(`<summary>${label}</summary>`), label);
  }
  assert.match(
    html,
    /brew tap Demonbane18\/relmio &amp;&amp; brew trust --formula Demonbane18\/relmio\/relmio &amp;&amp; brew install relmio/,
  );
  assert.doesNotMatch(html, /brew trust Demonbane18\/relmio(?:\s|&)/);
  assert.doesNotMatch(html, /\bwinget install\b/i);
  assert.match(html, /Homebrew is public/);
  assert.match(html, /trusts only the Relmio formula/);
  assert.match(
    html,
    /irm https:\/\/relmio\.jpfusin\.tech\/install\.ps1 \| iex/,
  );
  assert.match(
    html,
    /for \/f &quot;delims=&quot; %F/,
  );
  assert.match(html, /relmio-install-%RANDOM%-%RANDOM%-%RANDOM%\.cmd/);
  assert.match(html, /--remove-on-error/);
  assert.match(html, /RELMIO_SELF_DELETE=%~F/);
  assert.doesNotMatch(html, /-o install\.cmd/);
  assert.match(html, /npx --yes --ignore-scripts relmio@latest/);
  assert.match(html, /role="tablist"[^>]*aria-label="Installation method"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>[^<]*macOS \/ Linux/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*Homebrew/);
  assert.doesNotMatch(html, /role="tab"[^>]*>[^<]*WinGet/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*PowerShell/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*CMD/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*NPX/);
  assert.match(html, /macOS, Linux, WSL, or Git Bash/);
  assert.match(html, /foreground one-shot wizard/);
  assert.match(
    html,
    /Runs a foreground one-shot wizard; no Git Bash or preinstalled Node\.js required/,
  );
  assert.match(html, /For Command Prompt, not PowerShell/);
  assert.match(html, /non-admin bootstrap verifies a temporary runtime/);
  assert.match(html, /already has Node\.js 24 or newer/);
  assert.match(html, /WinGet remains hidden until Microsoft accepts[^<]*catalog pull request/);
  assert.match(html, /Copy macOS \/ Linux installation command/);
  assert.match(html, /title="Copy macOS \/ Linux installation command"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<span role="status"[^>]*>Copy<\/span>/);
  assert.match(html, /Choose an installation method/);
  assert.match(html, /Run Relmio on your own computer/);
  assert.match(html, /foreground[^<]*one-shot wizard/);
  assert.match(html, /relmio start/);
  assert.match(html, /relmio status/);
  assert.match(html, /relmio open/);
  assert.match(html, /relmio stop/);
  assert.match(html, /never stops[^<]*n8n or a managed companion/);
  assert.match(installScript, /^#!\/bin\/sh/m);
  assert.match(installScript, /--ignore-scripts relmio@latest/);
  assert.match(commandPromptInstallScript, /--ignore-scripts relmio@latest/u);
  assert.match(powerShellInstallScript, /--ignore-scripts/);
});

test("renders the generated repository changelog as a hosted release-notes page", async () => {
  const response = await requestApp("/changelog");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Changelog \| Relmio<\/title>/u);
  assert.match(html, /Release notes/u);
  assert.match(html, /What changed, in plain language\./u);
  assert.match(html, /href="#changelog-content"[^>]*>Skip to release notes<\/a>/u);
  assert.match(html, /0\.10\.0/u);
  assert.match(html, /0\.9\.1/u);
  assert.match(html, /href="\/docs"[^>]*>Docs<\/a>/u);
});

test("returns current repository stars and npm version for the GitHub control", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("api.github.com/repos/Demonbane18/relmio")) {
      return Response.json({ stargazers_count: 42 });
    }
    if (url.includes("registry.npmjs.org/relmio/latest")) {
      return Response.json({ version: "0.2.1" });
    }
    return new Response("Not found", { status: 404 });
  });

  const response = await requestApp("/api/project-meta");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    stars: 42,
    version: "0.2.1",
  });
  assert.equal(response.headers.get("cache-control"), "public, s-maxage=60, stale-while-revalidate=60");
});

test("malformed metadata keeps the public installer on a stable release", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

  const response = await requestApp("/api/project-meta");
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.stars, null);
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/u);
});

test("the retired chat API answers 410 for every method without forwarding or logging", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("The chat API must not call any upstream.");
  });
  const logs = ["log", "info", "warn", "error"].map((level) => t.mock.method(console, level, () => {}));

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await requestApp("/api/chat", {
      method,
      headers: {
        authorization: "Bearer test-token",
        "chatgpt-account-id": "test-account",
        "content-type": "application/json",
      },
      body: method === "GET" ? undefined : JSON.stringify({ prompt: "hello" }),
    });
    assert.equal(response.status, 410, method);
    assert.equal(response.headers.get("cache-control"), "no-store", method);
    assert.deepEqual(await response.json(), { error: "Hosted chat is turned off." }, method);
  }

  assert.equal(upstream.mock.callCount(), 0);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});
