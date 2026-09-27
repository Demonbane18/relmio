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
        "local-dashboard.md",
        "local-endpoints.md",
        "local-models.md",
        "hosting-compatibility.md",
        "local-n8n-stack.md",
        "vps-and-n8n.md",
        "vps-supergrok.md",
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
