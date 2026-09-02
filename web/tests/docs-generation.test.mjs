import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

const expectedRoutes = [
  "getting-started",
  "local-endpoints",
  "local-n8n-stack",
  "vps-and-n8n",
  "ai-assistant",
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
  const renderedDocumentation = generated.replaceAll("\\n", "\n");

  assert.equal(packageJson.scripts["docs:generate"], "node scripts/generate-docs.mjs");
  assert.equal(packageJson.scripts["docs:check"], "node scripts/generate-docs.mjs --check");
  assert.ok(packageJson.dependencies["react-markdown"]);
  assert.ok(packageJson.dependencies["remark-gfm"]);
  for (const route of expectedRoutes) {
    assert.match(generator, new RegExp(`slug: "${route}"`, "u"));
    assert.match(generated, new RegExp(`"${route}"`, "u"));
  }
  assert.match(generated, /@generated from repository Markdown/u);
  assert.match(generator, /CHANGELOG\.md/u);
  assert.match(generated, /export const changelogContent/u);
  assert.match(renderedDocumentation, /## \[0\.10\.0\] - 2026-08-31/u);
  assert.match(
    renderedDocumentation,
    /Native Windows with Docker Desktop's `desktop-linux` engine/u,
  );
  assert.match(
    renderedDocumentation,
    /separately confirmed credential refresh[\s\S]*freezer fail closed without a stop fallback/u,
  );
  assert.doesNotMatch(
    renderedDocumentation,
    /Native Windows is not supported/u,
  );
  assert.doesNotMatch(
    renderedDocumentation,
    /The n8n bridge is create\/remove-only in this release/u,
  );
  assert.match(renderedDocumentation, /N8N_ENABLED_MODULES=instance-ai/u);
  assert.match(
    renderedDocumentation,
    /append\s+`instance-ai`\s+as\s+a\s+distinct comma-delimited token[\s\S]*preserving existing\s+module entries/u,
  );
  assert.match(
    renderedDocumentation,
    /redeploy or restart n8n[\s\S]*healthy[\s\S]*reconnect to Relmio[\s\S]*discovery/u,
  );
  assert.match(
    renderedDocumentation,
    /will not edit the existing\s+n8n Compose file,\s+image, or environment;[\s\S]*restart or recreate n8n; or\s+exec into n8n/u,
  );
  assert.match(generator, /--check/u);
  assert.doesNotMatch(generator, /readFile\([^)]*README\.md/u);
});

test("normalizes generated Markdown content to LF across host checkouts", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "relmio-docs-generation-"));

  try {
    const generatorPath = join(fixtureRoot, "web", "scripts", "generate-docs.mjs");
    const sourceGenerator = await readFile(
      new URL("../scripts/generate-docs.mjs", import.meta.url),
      "utf8",
    );
    await mkdir(dirname(generatorPath), { recursive: true });
    await mkdir(join(fixtureRoot, "docs"), { recursive: true });
    await writeFile(generatorPath, sourceGenerator, "utf8");
    await Promise.all(
      [
        "getting-started.md",
        "local-endpoints.md",
        "local-n8n-stack.md",
        "vps-and-n8n.md",
        "ai-assistant.md",
        "troubleshooting.md",
        "faq.md",
        "security.md",
        "reference.md",
      ].map((documentName) =>
        writeFile(
          join(fixtureRoot, "docs", documentName),
          `# ${documentName}\r\n\r\nSee [Getting started](./getting-started.md).\r\n`,
          "utf8",
        ),
      ),
    );
    await writeFile(
      join(fixtureRoot, "CHANGELOG.md"),
      "# Changelog\r\n\r\n- Fixture entry\r\n",
      "utf8",
    );

    await execFileAsync(process.execPath, [generatorPath]);
    const generated = await readFile(
      join(fixtureRoot, "web", "app", "docs", "generated-content.ts"),
      "utf8",
    );

    assert.match(generated, /# getting-started\.md\\n\\n/u);
    assert.match(generated, /# Changelog\\n\\n/u);
    assert.doesNotMatch(generated, /\\r/u);
    await execFileAsync(process.execPath, [generatorPath, "--check"]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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
  assert.match(documentPage, /DocumentationSearch/u);
  assert.match(documentPage, /DocumentOutline/u);
  assert.match(documentPage, /Browse documentation/u);
  assert.match(documentPage, /Adjacent documentation/u);
  assert.doesNotMatch(documentPage, /rehypeRaw|dangerouslySetInnerHTML|innerHTML/u);
  assert.match(styles, /\.layoutDetail/u);
  assert.match(styles, /\.mobileNavigation/u);
  assert.match(styles, /@media \(max-width: 52rem\)/u);
});

test("keeps a hosted changelog page linked to the generated repository changelog", async () => {
  const [page, documentPage, copyableCodeBlock, styles] = await Promise.all([
    readFile(new URL("../app/changelog/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/docs/DocumentPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/docs/CopyableCodeBlock.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/docs/docs.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /changelogContent/u);
  assert.match(page, /ReactMarkdown/u);
  assert.match(page, /Release notes/u);
  assert.match(page, /targetId="changelog-content"/u);
  assert.match(page, /Skip to release notes/u);
  assert.match(page, /id="changelog-content"/u);
  assert.match(documentPage, /href="\/changelog"/u);
  assert.match(documentPage, /CopyableCodeBlock/u);
  assert.match(copyableCodeBlock, /aria-label=\{label\}/u);
  assert.match(copyableCodeBlock, /title=\{label\}/u);
  assert.match(copyableCodeBlock, /aria-live="polite"/u);
  assert.match(copyableCodeBlock, /document\.execCommand\("copy"\)/u);
  assert.match(styles, /\.copyCodeButton/u);
  assert.match(styles, /\.copyCodeButton\s*\{[^}]*width:\s*2\.75rem;[^}]*height:\s*2\.75rem;/su);
  assert.match(styles, /\.changelogArticle/u);
});
