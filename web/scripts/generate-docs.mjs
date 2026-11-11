import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownSections } from "../app/docs/markdownText.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(webRoot, "..");
const outputPath = resolve(webRoot, "app/docs/generated-content.ts");
// The docs search loads this index on first use, so it stays out of the pages.
const sectionsPath = resolve(webRoot, "app/docs/generated-sections.json");

const pages = [
  {
    slug: "getting-started",
    title: "Getting started",
    sourcePath: "docs/getting-started.md",
  },
  {
    slug: "local-dashboard",
    title: "Local dashboard",
    sourcePath: "docs/local-dashboard.md",
  },
  {
    slug: "local-endpoints",
    title: "Local endpoints",
    sourcePath: "docs/local-endpoints.md",
  },
  {
    slug: "local-models",
    title: "Local models",
    sourcePath: "docs/local-models.md",
  },
  {
    slug: "hosting-compatibility",
    title: "Hosting compatibility",
    sourcePath: "docs/hosting-compatibility.md",
  },
  {
    slug: "local-n8n-stack",
    title: "New local n8n + ngrok",
    sourcePath: "docs/local-n8n-stack.md",
  },
  {
    slug: "vps-and-n8n",
    title: "VPS and n8n",
    sourcePath: "docs/vps-and-n8n.md",
  },
  {
    slug: "n8n-configuration",
    title: "Configure n8n",
    sourcePath: "docs/n8n-configuration.md",
  },
  {
    slug: "vps-supergrok",
    title: "SuperGrok on a VPS",
    sourcePath: "docs/vps-supergrok.md",
  },
  {
    slug: "claude-subscription",
    title: "Claude subscription",
    sourcePath: "docs/claude-subscription.md",
    // Shown as a badge beside the title wherever the guide is listed.
    status: "Experimental",
  },
  {
    slug: "ai-assistant",
    title: "n8n AI Assistant",
    sourcePath: "docs/ai-assistant.md",
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    sourcePath: "docs/troubleshooting.md",
    // Index card text and meta description when the first paragraph does not
    // suit a newcomer. Plain text, at most about 160 characters.
    summary:
      "How to fix common problems: Docker not running, failed sign-ins, image build errors, VPS checks and model errors. A symptom table lists more.",
  },
  {
    slug: "faq",
    title: "FAQ",
    sourcePath: "docs/faq.md",
  },
  {
    slug: "security",
    title: "Security",
    sourcePath: "docs/security.md",
    summary:
      "How Relmio stores and separates provider sign-ins and tokens, what the wizard changes on your computer or server, and its known limits.",
  },
  {
    slug: "reference",
    title: "Reference",
    sourcePath: "docs/reference.md",
  },
];

const routeByDocument = new Map(
  pages.map((page) => [page.sourcePath.replace(/^docs\//u, ""), page.slug]),
);

function rewriteRepositoryLinks(markdown) {
  return markdown.replace(
    /\]\((?:\.\/)?([^/#)]+\.md)(#[^)]+)?\)/gu,
    (match, documentName, hash = "") => {
      const slug = routeByDocument.get(documentName);
      return slug
        ? `](/docs/${slug}${hash})`
        : `](https://github.com/Demonbane18/relmio/blob/main/docs/${documentName}${hash})`;
    },
  );
}

function normalizeLineEndings(markdown) {
  return markdown.replace(/\r\n?/gu, "\n");
}

function renderGeneratedModule(entries, changelogContent) {
  return `/*
 * @generated from repository Markdown by web/scripts/generate-docs.mjs.
 * DO NOT EDIT. Edit the listed docs/*.md source and run npm run docs:generate.
 */

export const documentationPages = ${JSON.stringify(entries, null, 2)} as const;

export const changelogContent = ${JSON.stringify(changelogContent)};

export type DocumentationSlug = (typeof documentationPages)[number]["slug"];

export const documentationBySlug: ReadonlyMap<string, (typeof documentationPages)[number]> = new Map(
  documentationPages.map((page) => [page.slug, page]),
);
`;
}

/** One section per line, so a docs edit shows as a small diff. */
function renderSectionIndex(entries) {
  const sections = entries.flatMap((page) =>
    markdownSections(page.content).map((section) => JSON.stringify({ slug: page.slug, ...section })),
  );
  return `[\n${sections.join(",\n")}\n]\n`;
}

async function generate() {
  const [entries, changelogContent] = await Promise.all([
    Promise.all(
      pages.map(async (page) => ({
        ...page,
        content: rewriteRepositoryLinks(
          normalizeLineEndings(
            await readFile(resolve(repositoryRoot, page.sourcePath), "utf8"),
          ),
        ),
      })),
    ),
    readFile(resolve(repositoryRoot, "CHANGELOG.md"), "utf8").then(
      normalizeLineEndings,
    ),
  ]);
  return new Map([
    [outputPath, renderGeneratedModule(entries, changelogContent)],
    [sectionsPath, renderSectionIndex(entries)],
  ]);
}

const outputs = await generate();
if (process.argv.includes("--check")) {
  for (const [path, output] of outputs) {
    let checkedIn = "";
    try {
      checkedIn = await readFile(path, "utf8");
    } catch {
      // The comparison below reports the same clear generated-output drift.
    }
    if (normalizeLineEndings(checkedIn) !== output) {
      process.exitCode = 1;
    }
  }
  if (process.exitCode === 1) {
    process.stderr.write(
      "Generated documentation is out of date. Run npm run docs:generate.\n",
    );
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([...outputs].map(([path, output]) => writeFile(path, output, "utf8")));
}
