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
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  changelogReleases,
  guideSummary,
  markdownOutline,
  releaseId,
} from "../app/docs/markdownText.ts";

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
    const generated = await import(
      pathToFileURL(join(fixtureRoot, "web", "app", "docs", "generated-content.ts")).href
    );

    assert.equal(
      generated.documentationBySlug.get("getting-started").content,
      "# getting-started.md\n\nSee [Getting started](/docs/getting-started).\n",
    );
    assert.equal(generated.changelogContent, "# Changelog\n\n- Fixture entry\n");
    await execFileAsync(process.execPath, [generatorPath, "--check"]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Markdown components forbid unsafe raw HTML rendering", async () => {
  const sources = await Promise.all(
    [
      "../app/docs/MarkdownContent.tsx",
      "../app/docs/DocumentPage.tsx",
      "../app/docs/CopyableCodeBlock.tsx",
      "../app/changelog/page.tsx",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );

  // AGENTS.md forbids rendering untrusted text through HTML injection.
  for (const source of sources) {
    assert.doesNotMatch(source, /rehypeRaw|rehype-raw|dangerouslySetInnerHTML|innerHTML/u);
  }
});

test("builds the outline from h2 and h3 headings outside code blocks", () => {
  const markdown = [
    "# Guide",
    "## Use `relmio_start` with [the dashboard](https://example.com/x) ##",
    "```sh",
    "## not a heading",
    "```",
    "### Second **part**",
    "#### Too deep",
  ].join("\n");

  assert.deepEqual(markdownOutline(markdown), [
    { id: "use-relmio-start-with-the-dashboard", label: "Use relmio_start with the dashboard", level: 2 },
    { id: "second-part", label: "Second part", level: 3 },
  ]);
});

test("lists only h2 sections in a long guide outline", () => {
  const markdown = Array.from({ length: 10 }, (_, index) => `## Part ${index}\n### Detail ${index}`).join("\n");
  const outline = markdownOutline(markdown);

  assert.equal(outline.length, 10);
  assert.ok(outline.every((item) => item.level === 2));
});

test("links every changelog release to the id its rendered heading gets", () => {
  const groups = changelogReleases(
    [
      "# Changelog",
      "## Unreleased",
      "## [0.18.0-experimental.2] - 2026-09-28",
      "## [0.17.1] - 2026-09-20",
      "## [0.17.0] - 2026-09-18",
      "## [0.9.1] - 2026-08-01",
      "[0.17.1]: https://github.com/Demonbane18/relmio/compare/v0.17.0...v0.17.1",
    ].join("\n"),
  );

  assert.deepEqual(
    groups.map((group) => [group.series, group.releases.map((release) => [release.short, release.id])]),
    [
      ["0.18", [["exp.2", "v0-18-0-experimental-2"]]],
      ["0.17", [[".1", "v0-17-1"], [".0", "v0-17-0"]]],
      ["0.9", [[".1", "v0-9-1"]]],
    ],
  );
  // Linked versions render without brackets; unlinked ones keep them.
  assert.equal(releaseId("0.17.1 - 2026-09-20"), "v0-17-1");
  assert.equal(releaseId("[0.18.0-experimental.2] - 2026-09-28"), "v0-18-0-experimental-2");
});

test("summarizes a guide from its first prose paragraph at a word boundary", () => {
  const summary = guideSummary(
    [
      "# Guide",
      "",
      "| a | b |",
      "",
      `Relmio connects [local tools](./x.md) to \`n8n\`. ${"More words follow here. ".repeat(10)}`,
      "continues on the next line.",
    ].join("\n"),
  );

  assert.ok(summary.startsWith("Relmio connects local tools to n8n."));
  assert.ok(summary.endsWith("…"));
  assert.ok(summary.length <= 161);
  assert.doesNotMatch(summary, / …$/u);
});
