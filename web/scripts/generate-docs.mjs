import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(webRoot, "..");
const outputPath = resolve(webRoot, "app/docs/generated-content.ts");

const pages = [
  {
    slug: "getting-started",
    title: "Getting started",
    sourcePath: "docs/getting-started.md",
  },
  {
    slug: "local-endpoints",
    title: "Local endpoints",
    sourcePath: "docs/local-endpoints.md",
  },
  {
    slug: "vps-and-n8n",
    title: "VPS and n8n",
    sourcePath: "docs/vps-and-n8n.md",
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

function renderGeneratedModule(entries) {
  return `/*
 * @generated from repository Markdown by web/scripts/generate-docs.mjs.
 * DO NOT EDIT. Edit the listed docs/*.md source and run npm run docs:generate.
 */

export const documentationPages = ${JSON.stringify(entries, null, 2)} as const;

export type DocumentationSlug = (typeof documentationPages)[number]["slug"];

export const documentationBySlug: ReadonlyMap<string, (typeof documentationPages)[number]> = new Map(
  documentationPages.map((page) => [page.slug, page]),
);
`;
}

async function generate() {
  const entries = await Promise.all(
    pages.map(async (page) => ({
      ...page,
      content: rewriteRepositoryLinks(
        await readFile(resolve(repositoryRoot, page.sourcePath), "utf8"),
      ),
    })),
  );
  return renderGeneratedModule(entries);
}

const output = await generate();
if (process.argv.includes("--check")) {
  let checkedIn = "";
  try {
    checkedIn = await readFile(outputPath, "utf8");
  } catch {
    // The comparison below reports the same clear generated-output drift.
  }
  if (checkedIn !== output) {
    process.stderr.write(
      "Generated documentation is out of date. Run npm run docs:generate.\n",
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, "utf8");
}
