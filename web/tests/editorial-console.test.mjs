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
  const home = await appFile("page.tsx");

  assert.match(home, /className="editorial-home"/u);
  assert.match(home, /id="chat"/u);
  assert.match(home, /id="security"/u);
  assert.match(home, /id="top"/u);
  assert.match(home, /href="\/install"/u);
  assert.match(home, /href="\/docs"/u);
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
  const chatConsole = await appFile("components/ChatConsole.tsx");

  assert.match(chatConsole, /aria-label="Hosted chat console"/u);
  assert.match(chatConsole, /aria-live="polite"/u);
  assert.match(chatConsole, /aria-label="Suggested prompts"/u);
  assert.match(chatConsole, /fetch\("\/api\/chat"/u);
  assert.match(chatConsole, /openaiAuthHeaders/u);
  assert.match(chatConsole, /readRelmioEvents/u);
  assert.match(chatConsole, /abortRef/u);
  assert.match(chatConsole, /maxLength=\{3000\}/u);
  assert.doesNotMatch(chatConsole, /conversation history|persistent history|<svg/iu);
});

test("keeps mobile installer steps full width with one-child markup", async () => {
  const styles = await appFile("globals.css");
  const editorialMobileStyles = styles.slice(
    styles.lastIndexOf("@media (max-width: 48rem)"),
  );

  assert.match(
    editorialMobileStyles,
    /\.install-steps li\s*\{[^}]*display:\s*block;[^}]*grid-template-columns:\s*none;[^}]*gap:\s*0;[^}]*\}/su,
  );
});

test("keeps Focus Mode send and stop icons at accessible hover contrast", async () => {
  const [styles, themeSource] = await Promise.all([
    appFile("globals.css"),
    appFile("relmio.js"),
  ]);
  const themeTokens = readThemeTokens(themeSource);
  const sendHover = styles.match(
    /\.editorial-home \.send-button:hover:not\(:disabled\)\s*\{(?<declarations>[^}]*)\}/u,
  )?.groups?.declarations;
  const stopHover = styles.match(
    /\.editorial-home \.stop-button:hover:not\(:disabled\)\s*\{(?<declarations>[^}]*)\}/u,
  )?.groups?.declarations;
  const suggestionHover = styles.match(
    /\.editorial-home \.suggestion-row button:hover:not\(:disabled\)\s*\{(?<declarations>[^}]*)\}/u,
  )?.groups?.declarations;

  assert.ok(sendHover, "missing Focus Mode send hover override");
  assert.ok(stopHover, "missing Focus Mode stop hover override");
  assert.ok(suggestionHover, "missing Focus Mode suggestion hover override");
  assert.doesNotMatch(sendHover, /#[\da-f]{3,8}/iu);
  assert.doesNotMatch(stopHover, /#[\da-f]{3,8}/iu);
  assert.doesNotMatch(suggestionHover, /#[\da-f]{3,8}/iu);

  const tokenFor = (declarations, property) =>
    declarations.match(
      new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*var\\((--color-[^)]+)\\)`, "u"),
    )?.[1];
  const sendBackgroundToken = tokenFor(sendHover, "background");
  const sendForegroundToken = tokenFor(sendHover, "color");
  const stopBackgroundToken = tokenFor(stopHover, "background");
  const stopForegroundToken = tokenFor(stopHover, "color");
  const suggestionBackgroundToken = tokenFor(suggestionHover, "background");
  const suggestionForegroundToken = tokenFor(suggestionHover, "color");

  assert.equal(sendBackgroundToken, "--color-accent");
  assert.equal(sendForegroundToken, "--color-on-accent");
  assert.equal(stopBackgroundToken, "--color-background-card");
  assert.equal(stopForegroundToken, "--color-text-accent");
  assert.equal(suggestionBackgroundToken, "--color-background-card");
  assert.equal(suggestionForegroundToken, "--color-text-primary");

  for (const mode of ["light", "dark"]) {
    const sendBackground = parseHexColor(
      themeColor(themeTokens, sendBackgroundToken, mode),
    );
    const sendForeground = parseHexColor(
      themeColor(themeTokens, sendForegroundToken, mode),
    );
    const stopBackground = parseHexColor(
      themeColor(themeTokens, stopBackgroundToken, mode),
    );
    const stopForeground = parseHexColor(
      themeColor(themeTokens, stopForegroundToken, mode),
    );
    const suggestionBackground = parseHexColor(
      themeColor(themeTokens, suggestionBackgroundToken, mode),
    );
    const suggestionForeground = parseHexColor(
      themeColor(themeTokens, suggestionForegroundToken, mode),
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
  const styles = await appFile("globals.css");
  const composeControl = styles.match(
    /\.editorial-home \.send-button\s*\{(?<declarations>[^}]*)\}/u,
  )?.groups?.declarations;

  assert.ok(composeControl, "missing Focus Mode compose control override");
  assert.match(composeControl, /position:\s*static;/u);
  assert.match(composeControl, /inset:\s*auto;/u);
  assert.match(composeControl, /right:\s*auto;/u);
  assert.match(composeControl, /bottom:\s*auto;/u);
  assert.match(composeControl, /flex:\s*0\s+0\s+auto;/u);
  assert.doesNotMatch(composeControl, /position:\s*absolute/u);
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
  const [styles, themeSource] = await Promise.all([
    appFile("globals.css"),
    appFile("relmio.js"),
  ]);
  const terminalStart = styles.indexOf(".install-command {\n  display: grid;");
  const terminalEnd = styles.indexOf(".install-command.copied {", terminalStart);
  const terminalStyles = styles.slice(terminalStart, terminalEnd);
  const themeTokens = readThemeTokens(themeSource);

  assert.ok(
    terminalStart >= 0 && terminalEnd > terminalStart,
    "missing terminal command styles",
  );
  assert.match(terminalStyles, /--terminal-background:\s*var\(--color-on-light\)/u);
  assert.match(terminalStyles, /--terminal-foreground:\s*var\(--color-on-dark\)/u);
  assert.match(terminalStyles, /--terminal-accent:\s*var\(--color-on-dark\)/u);
  assert.match(terminalStyles, /--terminal-muted:\s*var\(--color-on-dark\)/u);
  assert.doesNotMatch(terminalStyles, /#[\da-f]{3,8}/iu);

  for (const mode of ["light", "dark"]) {
    const terminalBackground = parseHexColor(
      themeColor(themeTokens, "--color-on-light", mode),
    );
    for (const role of ["foreground", "accent", "muted"]) {
      const terminalColor = parseHexColor(
        themeColor(
          themeTokens,
          terminalStyles.match(
            new RegExp(`--terminal-${role}:\\s*var\\((--color-[^)]+)\\)`, "u"),
          )?.[1],
          mode,
        ),
      );
      assert.ok(
        contrastRatio(terminalColor, terminalBackground) >= 4.5,
        `${role} terminal contrast is below 4.5:1 in ${mode} mode`,
      );
    }
  }

  const incompleteRules = [
    ...styles.matchAll(/\.message-incomplete p\s*\{([^}]*)\}/gu),
  ];
  const incompleteDeclarations = incompleteRules.at(-1)?.[1] ?? "";
  assert.match(incompleteDeclarations, /color:\s*var\(--color-text-orange\)/u);
  assert.doesNotMatch(incompleteDeclarations, /color:\s*var\(--color-border-orange\)/u);

  for (const mode of ["light", "dark"]) {
    const orangeBackdrop = parseHexColor(
      themeColor(themeTokens, "--color-background-muted", mode),
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
  assert.doesNotMatch(documentPage, /dangerouslySetInnerHTML|rehypeRaw|innerHTML/u);
});
