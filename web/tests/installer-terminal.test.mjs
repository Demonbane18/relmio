import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextTabIndex } from "../app/components/tabKeys.ts";

const appFile = (path) =>
  readFile(new URL(`../app/${path}`, import.meta.url), "utf8");

test("keeps every supported installer method and exact public command", async () => {
  const picker = await appFile("components/CopyCommand.tsx");

  for (const [id, label, command] of [
    ["posix", "macOS / Linux", "curl -fsSL https://relmio.jpfusin.tech/install.sh | sh"],
    ["homebrew", "Homebrew", "brew tap Demonbane18/relmio && brew trust --formula Demonbane18/relmio/relmio && brew install relmio"],
    ["powershell", "PowerShell", "irm https://relmio.jpfusin.tech/install.ps1 | iex"],
    ["cmd", "CMD", "https://relmio.jpfusin.tech/install.cmd"],
    ["npx", "NPX", "npx --yes --ignore-scripts relmio@latest"],
  ]) {
    assert.match(picker, new RegExp(`id: "${id}"`, "u"));
    assert.match(picker, new RegExp(`label: "${label.replace("/", "\\/")}"`, "u"));
    assert.ok(picker.includes(command), `missing installer command: ${command}`);
  }

  assert.doesNotMatch(picker, /winget install/iu);
  assert.doesNotMatch(picker, /brew trust Demonbane18\/relmio(?:\s|$)/u);
});

test("keeps the exact AI Assistant launcher command", async () => {
  const page = await appFile("install/page.tsx");

  assert.ok(page.includes('"npx --yes --ignore-scripts relmio@latest assistant"'));
});

test("moves between installation method tabs with wrapping arrows, Home and End", () => {
  assert.equal(nextTabIndex("ArrowRight", 0, 5), 1);
  assert.equal(nextTabIndex("ArrowRight", 4, 5), 0);
  assert.equal(nextTabIndex("ArrowLeft", 0, 5), 4);
  assert.equal(nextTabIndex("ArrowLeft", 3, 5), 2);
  assert.equal(nextTabIndex("Home", 3, 5), 0);
  assert.equal(nextTabIndex("End", 1, 5), 4);
  assert.equal(nextTabIndex("Enter", 2, 5), null);
  assert.equal(nextTabIndex("ArrowDown", 2, 5), null);
});

test("opens every new-tab link on the install, docs and changelog pages without an opener", async () => {
  const sources = await Promise.all(
    [
      "install/page.tsx",
      "components/CopyCommand.tsx",
      "docs/DocumentPage.tsx",
      "changelog/page.tsx",
    ].map(appFile),
  );

  for (const source of sources) {
    for (const anchor of source.match(/<a\b[^>]*target="_blank"[^>]*>/gsu) ?? []) {
      assert.match(anchor, /rel="noopener noreferrer"/u, anchor);
    }
  }
});
