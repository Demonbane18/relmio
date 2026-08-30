import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appFile = (path) =>
  readFile(new URL(`../app/${path}`, import.meta.url), "utf8");

function readThemeTokens(source) {
  return new Map(
    [...source.matchAll(/^\s*"(?<name>--color-[^"]+)":\s*"(?<value>[^"]+)"/gmu)].map(
      ({ groups }) => [groups.name, groups.value],
    ),
  );
}

function themeColor(tokens, name, mode) {
  const value = tokens.get(name);
  assert.ok(value, `missing theme token: ${name}`);

  const pair = value.match(
    /^light-dark\((?<light>#[\da-f]+),\s*(?<dark>#[\da-f]+)\)$/iu,
  );
  return pair?.groups?.[mode] ?? value;
}

function parseHexColor(value) {
  assert.match(value, /^#[\da-f]{3,8}$/iu, `expected a hex theme color: ${value}`);
  const hex = value.slice(1);
  const channels = hex.length <= 4 ? [...hex].map((channel) => channel.repeat(2)) : hex.match(/../gu);
  const [red, green, blue] = channels.slice(0, 3).map((channel) => parseInt(channel, 16));
  const alpha = channels[3] ? parseInt(channels[3], 16) / 255 : 1;
  return { red, green, blue, alpha };
}

function composite(color, backdrop) {
  const alpha = color.alpha + backdrop.alpha * (1 - color.alpha);
  return {
    red: (color.red * color.alpha + backdrop.red * backdrop.alpha * (1 - color.alpha)) / alpha,
    green: (color.green * color.alpha + backdrop.green * backdrop.alpha * (1 - color.alpha)) / alpha,
    blue: (color.blue * color.alpha + backdrop.blue * backdrop.alpha * (1 - color.alpha)) / alpha,
    alpha,
  };
}

function relativeLuminance({ red, green, blue }) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

test("uses an editorial homepage without decorative status or marquee patterns", async () => {
  const [home, hashLink] = await Promise.all([
    appFile("page.tsx"),
    appFile("components/HashLink.tsx"),
  ]);

  assert.match(home, /className="editorial-home"/u);
  assert.match(home, /id="chat-section"/u);
  assert.match(home, /className="editorial-chat-console" id="chat"/u);
  assert.match(home, /id="security"/u);
  assert.match(home, /id="top"/u);
  assert.match(home, /href="\/install"/u);
  assert.match(home, /href="\/docs"/u);
  assert.match(home, /<HashLink targetId="chat">Chat<\/HashLink>/u);
  assert.match(hashLink, /target\.scrollIntoView/u);
  assert.match(hashLink, /target\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(hashLink, /prefers-reduced-motion:\s*reduce/u);
  assert.match(hashLink, /history\.(?:pushState|replaceState)/u);
  assert.doesNotMatch(home, /marquee|status-dot|index:\s*"0[123]"/u);
});

test("makes the real installer command the first interactive toolbox", async () => {
  const [installPage, copyCommand] = await Promise.all([
    appFile("install/page.tsx"),
    appFile("components/CopyCommand.tsx"),
  ]);

  assert.match(installPage, /data-install-toolbox/u);
  assert.match(installPage, /Self-hosted n8n/u);
  assert.doesNotMatch(installPage, /Hostinger VPS/u);
  assert.ok(
    installPage.indexOf("<CopyCommand") < installPage.indexOf("<details"),
    "the command selector must precede progressive disclosure",
  );
  assert.match(copyCommand, /role="tablist"/u);
  assert.match(copyCommand, /aria-orientation="horizontal"/u);
  assert.match(copyCommand, /selectedMethod.*"posix"/su);
  assert.match(copyCommand, /ArrowRight|ArrowLeft/u);
  assert.match(copyCommand, /navigator\.clipboard\.writeText/u);
  assert.match(copyCommand, /document\.execCommand\("copy"\)/u);

  for (const command of [
    "curl -fsSL https://relmio.vercel.app/install.sh | sh",
    "brew tap Demonbane18/relmio && brew install relmio",
    "irm https://relmio.vercel.app/install.ps1 | iex",
    "https://relmio.vercel.app/install.cmd",
    "npx --yes --ignore-scripts relmio@latest",
  ]) {
    assert.ok(copyCommand.includes(command), `missing install command: ${command}`);
  }
  assert.doesNotMatch(copyCommand, /winget install/u);
});

test("keeps hosted chat as a focused request-only console", async () => {
  const [home, chatConsole, styles] = await Promise.all([
    appFile("page.tsx"),
    appFile("components/ChatConsole.tsx"),
    appFile("globals.css"),
  ]);

  assert.match(chatConsole, /aria-label="Hosted chat console"/u);
  assert.match(chatConsole, /aria-live="polite"/u);
  assert.match(chatConsole, /aria-label="Suggested prompts"/u);
  assert.match(chatConsole, /fetch\("\/api\/chat"/u);
  assert.match(chatConsole, /openaiAuthHeaders/u);
  assert.match(chatConsole, /readRelmioEvents/u);
  assert.match(chatConsole, /activeRequestRef/u);
  assert.match(chatConsole, /maxLength=\{3000\}/u);
  assert.match(
    styles,
    /\.editorial-chat-grid\s*\{[^}]*grid-template-columns:\s*minmax\(20rem,\s*0\.62fr\)\s*minmax\(0,\s*1\.38fr\);/su,
  );
  assert.match(
    styles,
    /#chat\.editorial-chat-console\s*\{[^}]*min-width:\s*0;[^}]*scroll-margin-top:\s*5\.5rem;/su,
  );
  assert.ok(
    home.indexOf('className="editorial-chat-console" id="chat"') >
      home.indexOf('className="editorial-chat-copy"'),
    "the chat deep link must land on the console after the mobile explanation",
  );
  assert.doesNotMatch(chatConsole, /conversation history|persistent history|<svg/iu);
});

test("keeps the mobile chat lane below the wrapped sticky header", async () => {
  const [styles, chatStyles, docsStyles, installStyles] = await Promise.all([
    appFile("globals.css"),
    appFile("components/ChatConsole.module.css"),
    appFile("docs/docs.module.css"),
    appFile("install/install.module.css"),
  ]);
  const mobileStyles = styles.slice(styles.lastIndexOf("@media (max-width: 48rem)"));
  const mobileChatStyles = chatStyles.slice(
    chatStyles.indexOf("@media (max-width: 48rem)"),
  );

  assert.match(
    mobileStyles,
    /#chat\.editorial-chat-console\s*\{[^}]*scroll-margin-top:\s*12\.75rem;/su,
  );
  assert.match(
    mobileChatStyles,
    /\.shell\s*\{[^}]*height:\s*min\(42rem,\s*max\(34rem,\s*calc\(100dvh - 12\.75rem\)\)\);/su,
  );
  assert.match(
    mobileStyles,
    /#content-start,[\s\S]*#how-it-works,[\s\S]*#security\s*\{[^}]*scroll-margin-top:\s*12\.75rem;/u,
  );
  assert.match(
    docsStyles.slice(docsStyles.indexOf("@media (max-width: 52rem)")),
    /\.article\s*\{[^}]*scroll-margin-top:\s*12\.75rem;/su,
  );
  assert.match(
    docsStyles.slice(docsStyles.indexOf("@media (max-width: 52rem)")),
    /\.article\s+:where\(h1,\s*h2,\s*h3\)\s*\{[^}]*scroll-margin-top:\s*7\.5rem;/su,
  );
  assert.match(
    installStyles.slice(installStyles.indexOf("@media (max-width: 48rem)")),
    /\.toolbox\s*\{[^}]*scroll-margin-top:\s*12\.75rem;/su,
  );
});

test("never animates documentation layout dimensions or padding", async () => {
  const styles = await appFile("docs/docs.module.css");
  const sidebarHover = styles.match(
    /\.sidebar a:hover,[\s\S]*?\.sidebar a\[aria-current="page"\]\s*\{(?<declarations>[^}]*)\}/u,
  )?.groups?.declarations;
  const pageListHover = styles.match(
    /\.pageList a:hover,[\s\S]*?\.pageList a:focus-visible\s*\{(?<declarations>[^}]*)\}/u,
  )?.groups?.declarations;

  assert.doesNotMatch(styles, /transition:[^;}]*\bpadding\b/su);
  assert.doesNotMatch(styles, /transition-property:[^;}]*\bpadding\b/su);
  assert.ok(sidebarHover, "missing documentation sidebar hover rule");
  assert.ok(pageListHover, "missing documentation page-list hover rule");
  assert.doesNotMatch(sidebarHover, /\bpadding(?:-inline)?\s*:/u);
  assert.doesNotMatch(pageListHover, /\bpadding(?:-inline-start)?\s*:/u);
});

test("keeps global metadata neutral across separate credential routes", async () => {
  const layout = await appFile("layout.tsx");

  assert.match(layout, /Relmio \| AI routes with visible boundaries/u);
  assert.match(layout, /without collapsing their credential boundaries/u);
  assert.doesNotMatch(layout, /Your ChatGPT plan, relayed/u);
  assert.doesNotMatch(layout, /private path from ChatGPT sign-in/iu);
});

test("keeps mobile installer steps full width with one-child markup", async () => {
  const styles = await appFile("install/install.module.css");
  const editorialMobileStyles = styles.slice(styles.indexOf("@media (max-width: 48rem)"));

  assert.match(
    editorialMobileStyles,
    /\.steps\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*\}/su,
  );
  assert.match(
    editorialMobileStyles,
    /\.steps li,[\s\S]*\.steps li \+ li\s*\{[^}]*border-left:\s*0;[^}]*\}/u,
  );
});

test("keeps Focus Mode send and stop icons at accessible hover contrast", async () => {
  const [styles, themeSource] = await Promise.all([
    appFile("components/ChatConsole.module.css"),
    appFile("relmio.js"),
  ]);
  const themeTokens = readThemeTokens(themeSource);
  assert.match(styles, /--chat-teal:\s*var\(--relay-teal,\s*var\(--color-accent\)\)/u);
  assert.match(styles, /\.submitButton\s*\{[^}]*background:\s*var\(--chat-teal\);[^}]*color:\s*var\(--color-on-accent\);/su);
  assert.match(styles, /\.stopButton\s*\{[^}]*background:\s*var\(--chat-raised\);[^}]*color:\s*var\(--chat-teal\);/su);
  assert.match(styles, /\.suggestions button,[\s\S]*\.jumpToLatest\s*\{[^}]*background:\s*var\(--chat-raised\);[^}]*color:\s*var\(--chat-ink\);/u);

  for (const mode of ["light", "dark"]) {
    const sendBackground = parseHexColor(
      themeColor(themeTokens, "--color-accent", mode),
    );
    const sendForeground = parseHexColor(
      themeColor(themeTokens, "--color-on-accent", mode),
    );
    const stopBackground = parseHexColor(
      themeColor(themeTokens, "--color-background-card", mode),
    );
    const stopForeground = parseHexColor(
      themeColor(themeTokens, "--color-accent", mode),
    );
    const suggestionBackground = parseHexColor(
      themeColor(themeTokens, "--color-background-card", mode),
    );
    const suggestionForeground = parseHexColor(
      themeColor(themeTokens, "--color-text-primary", mode),
    );

    assert.ok(
      contrastRatio(sendForeground, sendBackground) >= 3,
      `send icon contrast is below 3:1 in ${mode} mode`,
    );
    assert.ok(
      contrastRatio(stopForeground, stopBackground) >= 3,
      `stop icon contrast is below 3:1 in ${mode} mode`,
    );
    assert.ok(
      contrastRatio(suggestionForeground, suggestionBackground) >= 4.5,
      `suggestion text contrast is below 4.5:1 in ${mode} mode`,
    );
  }
});

test("keeps Focus Mode compose controls in flow beside long prompts", async () => {
  const styles = await appFile("components/ChatConsole.module.css");
  const composeControl = styles.match(
    /\.submitButton\s*\{(?<declarations>[^}]*)\}/u,
  )?.groups?.declarations;

  assert.ok(composeControl, "missing Focus Mode compose control override");
  assert.match(composeControl, /position:\s*static;/u);
  assert.doesNotMatch(composeControl, /position:\s*absolute/u);
});

test("keeps a three-pixel visible focus ring across editorial controls", async () => {
  const [styles, chatStyles] = await Promise.all([
    appFile("globals.css"),
    appFile("components/ChatConsole.module.css"),
  ]);

  assert.match(
    styles,
    /:where\(\.editorial-home,\s*\.editorial-install\) :focus-visible\s*\{[^}]*outline:\s*3px solid var\(--relay-focus,[^;]+;[^}]*outline-offset:\s*2px;/su,
  );
  assert.match(
    chatStyles,
    /\.composerRow textarea:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--relay-focus,[^;]+;[^}]*outline-offset:\s*2px;/su,
  );
});

test("keeps mobile editorial visual order aligned with DOM focus order", async () => {
  const [styles, home, install] = await Promise.all([
    appFile("globals.css"),
    appFile("page.tsx"),
    appFile("install/page.tsx"),
  ]);
  const editorialMobileStyles = styles.slice(
    styles.lastIndexOf("@media (max-width: 48rem)"),
  );
  const mobileNav = editorialMobileStyles.match(
    /\.editorial-nav\s*\{(?<declarations>[^}]*)\}/u,
  )?.groups?.declarations;

  assert.ok(mobileNav, "missing mobile editorial navigation rule");
  assert.doesNotMatch(mobileNav, /order\s*:/u);
  assert.match(mobileNav, /width:\s*100%;/u);
  assert.match(mobileNav, /overflow-x:\s*auto;/u);

  for (const source of [home, install]) {
    const brandIndex = source.indexOf('className="editorial-brand"');
    const navIndex = source.indexOf('className="editorial-nav"');
    const actionsIndex = source.indexOf('className="editorial-header-actions"');

    assert.ok(brandIndex >= 0, "missing editorial brand in header");
    assert.ok(navIndex >= 0, "missing editorial nav in header");
    assert.ok(actionsIndex >= 0, "missing editorial actions in header");
    assert.ok(
      brandIndex < navIndex && navIndex < actionsIndex,
      "header DOM order must remain brand, navigation, then actions",
    );
  }
});

test("lets editorial footers span the desktop footer over the legacy grid", async () => {
  const styles = await appFile("globals.css");
  const editorialFooter = styles.match(/\.editorial-footer\s*\{[^}]*\}/u)?.[0];
  const editorialFooterInner = styles.match(
    /\.editorial-footer\s*>\s*\.editorial-footer-inner\s*\{[^}]*\}/u,
  )?.[0];

  assert.ok(editorialFooter, "missing editorial footer rule");
  assert.match(editorialFooter, /grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.ok(editorialFooterInner, "missing editorial footer inner reset");
  assert.match(editorialFooterInner, /grid-column:\s*1\s*\/\s*-1/u);
  assert.match(editorialFooterInner, /justify-self:\s*stretch/u);

  const editorialMobileStyles = styles.slice(
    styles.lastIndexOf("@media (max-width: 48rem)"),
  );
  assert.match(
    editorialMobileStyles,
    /\.editorial-footer-inner[\s\S]*padding-inline:\s*var\(--spacing-4\)/u,
  );
});

test("keeps terminal and incomplete response colors accessible in both themes", async () => {
  const [terminalStyles, chatStyles, themeSource] = await Promise.all([
    appFile("install/install.module.css"),
    appFile("components/ChatConsole.module.css"),
    appFile("relmio.js"),
  ]);
  const themeTokens = readThemeTokens(themeSource);
  const terminalColor = (name) =>
    terminalStyles.match(new RegExp(`--terminal-${name}:\\s*(#[0-9a-f]+)`, "iu"))?.[1];
  const terminalBackground = parseHexColor(terminalColor("background"));

  assert.doesNotMatch(terminalStyles, /data-theme/iu);
  assert.doesNotMatch(terminalStyles, /:root\[data-theme[^}]*--terminal/iu);
  for (const role of ["foreground", "accent", "muted"]) {
    assert.ok(
      contrastRatio(parseHexColor(terminalColor(role)), terminalBackground) >= 4.5,
      `${role} terminal contrast is below 4.5:1`,
    );
  }

  assert.match(chatStyles, /\.messageIncomplete\s*\{[^}]*background:\s*var\(--color-background-orange\);/su);
  assert.match(chatStyles, /\.messageIncomplete p,[\s\S]*color:\s*var\(--color-text-orange\);/u);

  for (const mode of ["light", "dark"]) {
    const orangeBackdrop = parseHexColor(
      themeColor(themeTokens, "--color-background-surface", mode),
    );
    const orangeBackground = composite(
      parseHexColor(themeColor(themeTokens, "--color-background-orange", mode)),
      orangeBackdrop,
    );
    const orangeText = parseHexColor(
      themeColor(themeTokens, "--color-text-orange", mode),
    );
    assert.ok(
      contrastRatio(orangeText, orangeBackground) >= 4.5,
      `incomplete response contrast is below 4.5:1 in ${mode} mode`,
    );
  }
});

test("keeps Focus Mode speaker labels out of legacy message bubbles", async () => {
  const chatConsole = await appFile("components/ChatConsole.tsx");

  assert.match(
    chatConsole,
    /<Text\s+as="span"\s+type="code"\s+color="secondary">\s*You\s*<\/Text>/su,
  );
  assert.match(
    chatConsole,
    /<Text\s+as="span"\s+type="code"\s+color="accent">\s*\{isIncomplete\s*\?/su,
  );
  assert.match(
    chatConsole,
    /<Text\s+as="p"\s+type="body">\s*\{lastPrompt\}\s*<\/Text>/su,
  );
  assert.match(
    chatConsole,
    /<Text\s+as="p"\s+type="body">\s*\{completion\s*\|\|/su,
  );
});

test("gives documentation the same editorial console framing", async () => {
  const [documentPage, docsStyles] = await Promise.all([
    appFile("docs/DocumentPage.tsx"),
    appFile("docs/docs.module.css"),
  ]);

  assert.match(documentPage, /styles\.editorialPage/u);
  assert.match(documentPage, /aria-label="Documentation navigation"/u);
  assert.match(documentPage, /DocumentOutline/u);
  assert.match(docsStyles, /\.editorialPage/u);
  assert.match(
    docsStyles,
    /\.routeLegend li > strong\s*\{[^}]*color:\s*#eff9f6;/su,
  );
  assert.doesNotMatch(documentPage, /dangerouslySetInnerHTML|rehypeRaw|innerHTML/u);
});
