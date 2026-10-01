import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const kit = await readFile(new URL("../src/ui/relmio-ui.css", import.meta.url), "utf8");

function blockAfter(marker, closing) {
  const start = kit.indexOf(marker);
  assert.notEqual(start, -1, `missing block ${marker}`);
  const end = kit.indexOf(closing, start + marker.length);
  assert.notEqual(end, -1, `unterminated block ${marker}`);
  return kit.slice(start + marker.length, end);
}

function colorTokens(declarations) {
  return new Map(
    [...declarations.matchAll(/^\s*(--rm-[a-z0-9-]+):\s*(#[0-9a-f]{6});/gimu)].map(
      ([, name, value]) => [name, value.toLowerCase()],
    ),
  );
}

const lightTokens = colorTokens(blockAfter(":root {", "\n}"));
const explicitDarkTokens = colorTokens(blockAfter(':root[data-theme="dark"] {', "\n}"));
const systemDarkTokens = colorTokens(
  blockAfter(':root:not([data-theme="light"]) {', "\n  }"),
);
const terminalFocus = colorTokens(blockAfter(".rm-terminal {", "\n}")).get("--rm-focus");

function luminance(hex) {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const textPairs = [
  ["--rm-ink", "--rm-canvas"],
  ["--rm-ink", "--rm-surface"],
  ["--rm-ink", "--rm-surface-muted"],
  ["--rm-ink", "--rm-accent-soft"],
  ["--rm-ink-muted", "--rm-canvas"],
  ["--rm-ink-muted", "--rm-surface"],
  ["--rm-ink-muted", "--rm-surface-muted"],
  ["--rm-ink-subtle", "--rm-canvas"],
  ["--rm-ink-subtle", "--rm-surface"],
  ["--rm-on-accent", "--rm-accent"],
  ["--rm-on-accent", "--rm-accent-hover"],
  ["--rm-accent-ink", "--rm-canvas"],
  ["--rm-accent-ink", "--rm-surface"],
  ["--rm-accent-ink", "--rm-accent-soft"],
  ["--rm-success", "--rm-success-soft"],
  ["--rm-warning", "--rm-warning-soft"],
  ["--rm-danger", "--rm-danger-soft"],
  ["--rm-danger", "--rm-surface"],
  ["--rm-terminal-fg", "--rm-terminal-bg"],
  ["--rm-terminal-muted", "--rm-terminal-bg"],
  ["--rm-terminal-prompt", "--rm-terminal-bg"],
];

const controlPairs = [
  ["--rm-field-line", "--rm-surface"],
  ["--rm-field-line", "--rm-canvas"],
  ["--rm-accent", "--rm-surface"],
  ["--rm-focus", "--rm-canvas"],
  ["--rm-focus", "--rm-surface"],
];


test("text and controls keep WCAG AA contrast in light and dark themes", () => {
  const themes = {
    light: lightTokens,
    dark: new Map([...lightTokens, ...explicitDarkTokens]),
    systemDark: new Map([...lightTokens, ...systemDarkTokens]),
  };

  for (const [theme, tokens] of Object.entries(themes)) {
    for (const [pairs, minimum] of [[textPairs, 4.5], [controlPairs, 3]]) {
      for (const [foreground, background] of pairs) {
        assert.ok(tokens.has(foreground) && tokens.has(background), `${theme}: missing ${foreground} or ${background}`);
        const ratio = contrast(tokens.get(foreground), tokens.get(background));
        assert.ok(
          ratio >= minimum,
          `${theme}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, below ${minimum}:1`,
        );
      }
    }
  }

  assert.ok(terminalFocus, "the terminal sets its own focus color");
  assert.ok(contrast(terminalFocus, lightTokens.get("--rm-terminal-bg")) >= 3);
});
