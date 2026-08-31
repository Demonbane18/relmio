import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const appFile = (path) => readFile(new URL(`../app/${path}`, import.meta.url), "utf8");

test("persists the product-grounded Signal Plotter design system", async () => {
  const [master, home, chat, install, docs] = await Promise.all([
    rootFile("design-system/relmio/MASTER.md"),
    rootFile("design-system/relmio/pages/home.md"),
    rootFile("design-system/relmio/pages/chat.md"),
    rootFile("design-system/relmio/pages/install.md"),
    rootFile("design-system/relmio/pages/docs.md"),
  ]);

  assert.match(master, /Signal Plotter/u);
  assert.match(master, /concept seed:[^\n]*`95cdc256`/iu);
  assert.match(master, /n8n with ChatGPT sign-in/u);
  assert.match(master, /OpenAI API/u);
  assert.match(master, /n8n Code Sandbox/u);
  assert.match(master, /Codex Chat Adapter/u);
  assert.match(master, /Codex App Server/u);
  assert.match(master, /one transcript scroll owner/iu);
  assert.doesNotMatch(master, /#7C3AED|AI purple \+ generation pink/u);
  assert.match(home, /interactive connection map/iu);
  assert.match(chat, /one transcript/iu);
  assert.match(install, /black\/graphite terminal/iu);
  assert.match(docs, /field manual/iu);
});

test("embeds the Impeccable direction contract in the root layout", async () => {
  const layout = await appFile("layout.tsx");

  assert.match(layout, /id="impeccable-direction-contract"/u);
  assert.match(layout, /type="text\/plain"/u);
  assert.match(layout, /THESIS[\s\S]*OWN-WORLD[\s\S]*STORY[\s\S]*FIRST VIEWPORT[\s\S]*FORM[\s\S]*FINISH/u);
  assert.match(layout, /concept seed 95cdc256/u);
  assert.match(
    layout,
    /unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN\.md/u,
  );
});

test("keeps Signal Plotter tokens paired across light and dark modes", async () => {
  const [theme, packageSource] = await Promise.all([
    appFile("globals.css"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);

  for (const token of [
    "--relay-canvas",
    "--relay-surface",
    "--relay-ink",
    "--relay-muted",
    "--relay-teal",
    "--relay-amber",
    "--relay-danger",
    "--relay-line",
    "--relay-focus",
  ]) {
    assert.ok(
      [...theme.matchAll(new RegExp(`${token}:\\s*#[0-9a-f]+`, "giu"))].length >= 2,
      `expected light and dark values for ${token}`,
    );
  }

  assert.equal(packageJson.dependencies.motion, "13.1.1");
});

test("gives documentation an editorial field-manual hierarchy", async () => {
  const [page, styles] = await Promise.all([
    appFile("docs/DocumentPage.tsx"),
    appFile("docs/docs.module.css"),
  ]);

  assert.match(page, /Field manual/u);
  assert.match(page, /aria-label="Relmio setup guides"/u);
  assert.match(page, /n8n \+ ChatGPT/u);
  assert.match(page, /OpenAI API/u);
  assert.match(page, /Code Sandbox/u);
  assert.match(page, /Chat Adapter/u);
  assert.match(page, /App Server/u);
  assert.match(styles, /\.article pre\s*\{[\s\S]*background:\s*#09100f;/u);
  assert.match(styles, /@media \(max-width: 52rem\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
});
