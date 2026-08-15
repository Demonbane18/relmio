import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedRoutes = [
  "getting-started",
  "local-endpoints",
  "vps-and-n8n",
  "troubleshooting",
  "faq",
  "security",
  "reference",
];

test("generates the hosted docs from the canonical root Markdown page map", async () => {
  const [packageSource, generator, generated] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/generate-docs.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/docs/generated-content.ts", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts["docs:generate"], "node scripts/generate-docs.mjs");
  assert.equal(packageJson.scripts["docs:check"], "node scripts/generate-docs.mjs --check");
  assert.ok(packageJson.dependencies["react-markdown"]);
  assert.ok(packageJson.dependencies["remark-gfm"]);
  for (const route of expectedRoutes) {
    assert.match(generator, new RegExp(`slug: "${route}"`, "u"));
    assert.match(generated, new RegExp(`"${route}"`, "u"));
  }
  assert.match(generated, /@generated from repository Markdown/u);
  assert.match(generator, /--check/u);
  assert.doesNotMatch(generator, /readFile\([^)]*README\.md/u);
});

test("renders a responsive, safe documentation route with project controls", async () => {
  const [indexPage, slugPage, documentPage, styles] = await Promise.all([
    readFile(new URL("../app/docs/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/docs/[slug]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/docs/DocumentPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/docs/docs.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(indexPage, /DocumentationPage/u);
  assert.match(slugPage, /generateStaticParams/u);
  assert.match(documentPage, /ReactMarkdown/u);
  assert.match(documentPage, /remarkGfm/u);
  assert.match(documentPage, /ThemeModeControl/u);
  assert.match(documentPage, /SupportButton/u);
  assert.match(documentPage, /RepositoryButton/u);
  assert.match(documentPage, /aria-label="Documentation navigation"/u);
  assert.doesNotMatch(documentPage, /rehypeRaw|dangerouslySetInnerHTML|innerHTML/u);
  assert.match(styles, /@media \(max-width: 48rem\)/u);
});
