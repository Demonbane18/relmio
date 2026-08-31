import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appFile = (path) =>
  readFile(new URL(`../app/${path}`, import.meta.url), "utf8");

test("keeps every supported installer method and exact public command", async () => {
  const picker = await appFile("components/CopyCommand.tsx");

  for (const [id, label, command] of [
    ["posix", "macOS / Linux", "curl -fsSL https://relmio.vercel.app/install.sh | sh"],
    ["homebrew", "Homebrew", "brew tap Demonbane18/relmio && brew trust --formula Demonbane18/relmio/relmio && brew install relmio"],
    ["powershell", "PowerShell", "irm https://relmio.vercel.app/install.ps1 | iex"],
    ["cmd", "CMD", "https://relmio.vercel.app/install.cmd"],
    ["npx", "NPX", "npx --yes --ignore-scripts relmio@latest"],
  ]) {
    assert.match(picker, new RegExp(`id: "${id}"`, "u"));
    assert.match(picker, new RegExp(`label: "${label.replace("/", "\\/")}"`, "u"));
    assert.ok(picker.includes(command), `missing installer command: ${command}`);
  }

  assert.doesNotMatch(picker, /winget install/iu);
  assert.doesNotMatch(picker, /brew trust Demonbane18\/relmio(?:\s|$)/u);
});

test("renders an always-black terminal independent of page theme", async () => {
  const [picker, styles] = await Promise.all([
    appFile("components/CopyCommand.tsx"),
    appFile("install/install.module.css"),
  ]);

  assert.match(picker, /data-terminal-theme="always-dark"/u);
  assert.match(styles, /--terminal-background:\s*#070b0a;/u);
  assert.match(styles, /\.terminal\s*\{[^}]*background:\s*var\(--terminal-background\);/su);
  assert.match(styles, /--terminal-foreground:\s*#f1f5f2;/u);
  assert.doesNotMatch(styles, /data-theme[^\n]*\.terminal|\.terminal[^\n]*data-theme/iu);
});

test("keeps the installer tabs and copy control keyboard and screen-reader complete", async () => {
  const [picker, styles] = await Promise.all([
    appFile("components/CopyCommand.tsx"),
    appFile("install/install.module.css"),
  ]);

  assert.match(picker, /role="tablist"/u);
  assert.match(picker, /role="tab"/u);
  assert.match(picker, /role="tabpanel"/u);
  assert.match(picker, /aria-selected=\{selected\}/u);
  assert.match(picker, /tabIndex=\{selected \? 0 : -1\}/u);
  assert.match(picker, /ArrowRight/u);
  assert.match(picker, /ArrowLeft/u);
  assert.match(picker, /event\.key === "Home"/u);
  assert.match(picker, /event\.key === "End"/u);
  assert.match(picker, /tabRefs\.current\[nextIndex\]\?\.focus\(\)/u);
  assert.match(picker, /navigator\.clipboard\.writeText/u);
  assert.match(picker, /document\.execCommand\("copy"\)/u);
  assert.match(picker, /aria-label=\{`Copy \$\{method\.label\} installation command`\}/u);
  assert.match(picker, /role="status" aria-live="polite" aria-atomic="true"/u);
  assert.match(picker, /Copy failed/u);
  assert.match(styles, /\.copyButton\s*\{[^}]*width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem;/su);
  assert.doesNotMatch(styles, /\.copyButton\s*\{[^}]*width:\s*(?:2\.[0-6]\d*|[01](?:\.\d+)?)rem;/su);
});

test("puts the complete terminal selector before compact safety detail", async () => {
  const page = await appFile("install/page.tsx");

  assert.match(page, /Self-hosted n8n · local installer/u);
  assert.match(page, /compatible self-hosted n8n setup/u);
  assert.doesNotMatch(page, /Hostinger(?: VPS)?/iu);

  const intro = page.indexOf("install-title");
  const toolbox = page.indexOf("data-install-toolbox");
  const command = page.indexOf("<CopyCommand");
  const steps = page.indexOf("<ol");
  const disclosure = page.indexOf("<details");

  assert.ok(intro >= 0 && toolbox > intro, "installer toolbox must follow the short intro");
  assert.ok(command > toolbox, "command selector must be inside the first toolbox");
  assert.ok(command < steps, "active command must precede the setup sequence");
  assert.ok(command < disclosure, "active command must precede safety disclosure");
  assert.match(page, /Homebrew is public/u);
  assert.match(page, /trusts only the Relmio formula/u);
  assert.match(page, /WinGet\s+remains hidden until Microsoft accepts/u);
});

test("prominently exposes the dedicated AI Assistant launcher without changing installer methods", async () => {
  const [page, styles] = await Promise.all([
    appFile("install/page.tsx"),
    appFile("install/install.module.css"),
  ]);

  assert.match(page, /n8n AI Assistant companion/u);
  assert.match(page, /npx --yes --ignore-scripts relmio@latest assistant/u);
  assert.ok(
    page.indexOf("n8n AI Assistant companion") < page.indexOf("data-install-toolbox"),
    "the AI Assistant launcher must be visible before the general installer toolbox",
  );
  assert.match(
    styles,
    /\.assistantLaunch\s*\{[^}]*background:\s*var\(--color-on-light\);[^}]*color:\s*var\(--color-on-dark\);/su,
  );
});

test("uses a two-row method grid at 375px without page overflow", async () => {
  const styles = await appFile("install/install.module.css");
  const mobile = styles.slice(styles.indexOf("@media (max-width: 48rem)"));

  assert.match(styles, /\.page\s*\{[^}]*overflow-x:\s*clip;/su);
  assert.match(mobile, /\.methodTabs\s*\{[^}]*grid-template-columns:\s*repeat\(6,/su);
  assert.match(mobile, /\.methodTab:nth-child\(-n \+ 3\)\s*\{[^}]*grid-column:\s*span 2;/su);
  assert.match(mobile, /\.methodTab:nth-child\(n \+ 4\)\s*\{[^}]*grid-column:\s*span 3;/su);
  assert.match(styles, /\.commandLine code\s*\{[^}]*overflow-wrap:\s*anywhere;/su);
  assert.match(styles, /\.commandLine code\s*\{[^}]*word-break:\s*break-word;/su);
});
