import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The local wizard owns the shared UI kit, its fonts and the logo files in
// src/ui. The hosted app uses copies so both apps render the same components.
// `--check` fails when a copy differs from its source.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(webRoot, "..");
const sourceRoot = resolve(repositoryRoot, "src/ui");

const generatedStylesheetHeader =
  "/* Generated from src/ui/relmio-ui.css by web/scripts/sync-ui-kit.mjs. Edit the source, then run npm run ui:sync. */\n";

const copies = [
  { source: "relmio-ui.css", target: "app/relmio-ui.css", kind: "text", header: generatedStylesheetHeader },
  { source: "fonts/geist-latin.woff2", target: "public/fonts/geist-latin.woff2", kind: "binary" },
  { source: "fonts/Geist-OFL.txt", target: "public/fonts/Geist-OFL.txt", kind: "text" },
  { source: "fonts/bricolage-grotesque-latin.woff2", target: "public/fonts/bricolage-grotesque-latin.woff2", kind: "binary" },
  { source: "fonts/BricolageGrotesque-OFL.txt", target: "public/fonts/BricolageGrotesque-OFL.txt", kind: "text" },
  { source: "relmio-icon.png", target: "public/relmio-icon.png", kind: "binary" },
  { source: "relmio-icon-96.png", target: "public/relmio-icon-96.png", kind: "binary" },
  { source: "relmio-icon-rounded.svg", target: "public/relmio-icon-rounded.svg", kind: "text" },
];

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/gu, "\n");
}

async function expectedContents(copy) {
  const sourcePath = resolve(sourceRoot, copy.source);
  if (copy.kind === "binary") return await readFile(sourcePath);
  const text = normalizeLineEndings(await readFile(sourcePath, "utf8"));
  return Buffer.from(`${copy.header ?? ""}${text}`, "utf8");
}

async function currentContents(copy) {
  const targetPath = resolve(webRoot, copy.target);
  try {
    const contents = await readFile(targetPath);
    return copy.kind === "binary"
      ? contents
      : Buffer.from(normalizeLineEndings(contents.toString("utf8")), "utf8");
  } catch {
    return null;
  }
}

const checkOnly = process.argv.includes("--check");
const drifted = [];

for (const copy of copies) {
  const expected = await expectedContents(copy);
  const current = await currentContents(copy);
  if (current && current.equals(expected)) continue;

  if (checkOnly) {
    drifted.push(copy.target);
    continue;
  }

  const targetPath = resolve(webRoot, copy.target);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, expected);
  process.stdout.write(`Updated ${relative(repositoryRoot, targetPath)}\n`);
}

if (drifted.length > 0) {
  process.stderr.write(
    `The shared UI kit copy is out of date: ${drifted.join(", ")}. Run npm run ui:sync.\n`,
  );
  process.exitCode = 1;
}
