// Pure Markdown helpers shared by the docs and changelog pages. The outline
// and the release list build their links from these functions, and the
// renderer builds heading ids from the same slugify(), so every link matches
// its heading.

export type OutlineItem = {
  id: string;
  label: string;
  level: 2 | 3;
};

export type Release = {
  id: string;
  version: string;
  date: string | null;
  /** Label inside its series: ".5" for 0.17.5, "exp.4" for 0.18.0-experimental.4. */
  short: string;
};

export type ReleaseSeries = {
  series: string;
  releases: Release[];
};

/** Lowercase words joined by hyphens: the id of a rendered heading. */
export function slugify(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

/** Visible text of inline Markdown: link text without targets, no code or
    emphasis markers. Matches what the renderer shows. */
function inlineText(markdown: string) {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/gu, "$1")
    .replace(/[`*]/gu, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .trim();
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})/u;
const headingPattern = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u;

type MarkdownLine = {
  text: string;
  /** Inside a fenced code block. */
  code: boolean;
  heading?: { level: number; text: string };
};

/** Lines in document order without the fences of code blocks. Lines outside
    code blocks carry their ATX heading. */
function markdownLines(markdown: string) {
  const lines: MarkdownLine[] = [];
  let fence: string | null = null;

  for (const text of markdown.split("\n")) {
    const fenceMatch = fencePattern.exec(text);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      lines.push({ text, code: true });
      continue;
    }

    const headingMatch = headingPattern.exec(text);
    lines.push(
      headingMatch
        ? { text, code: false, heading: { level: headingMatch[1].length, text: headingMatch[2] } }
        : { text, code: false },
    );
  }

  return lines;
}

const outlineLimit = 14;

/** Section links for "On this page". Long guides list only their h2 sections
    so the outline stays short. */
export function markdownOutline(markdown: string): OutlineItem[] {
  const items = markdownLines(markdown)
    .flatMap((line) => line.heading ?? [])
    .filter((heading) => heading.level === 2 || heading.level === 3)
    .map((heading) => {
      const label = inlineText(heading.text);
      return { id: slugify(label), label, level: heading.level as 2 | 3 };
    })
    .filter((item) => item.id !== "");

  return items.length > outlineLimit ? items.filter((item) => item.level === 2) : items;
}

const releasePattern = /^\[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?/u;

/** Anchor id for a changelog release heading, from its rendered or raw text:
    "[0.17.5] - 2026-09-26" and "0.17.5 - 2026-09-26" both give "v0-17-5". */
export function releaseId(headingText: string) {
  const version = releasePattern.exec(headingText.trim())?.[1];
  if (!version) return undefined;
  return /^\d/u.test(version) ? `v${slugify(version)}` : slugify(version);
}

function shortReleaseLabel(version: string, series: string) {
  const rest = version.slice(series.length + 1);
  const separator = rest.indexOf("-");
  if (separator < 0) return `.${rest}`;

  const patch = rest.slice(0, separator);
  const prerelease = rest.slice(separator + 1).replace(/^experimental(?=\.|$)/u, "exp");
  return patch === "0" ? prerelease : `.${patch}-${prerelease}`;
}

/** Published versions from the changelog, grouped by major.minor series in
    file order. Headings without a version number, such as Unreleased, are
    left out. */
export function changelogReleases(markdown: string): ReleaseSeries[] {
  const groups: ReleaseSeries[] = [];

  for (const heading of markdownLines(markdown).flatMap((line) => line.heading ?? [])) {
    if (heading.level !== 2) continue;
    const match = releasePattern.exec(heading.text.trim());
    const version = match?.[1];
    const id = releaseId(heading.text);
    if (!version || !id || !/^\d+\.\d+\.\d+/u.test(version)) continue;

    const series = version.split(".").slice(0, 2).join(".");
    const release: Release = {
      id,
      version,
      date: match?.[2] ?? null,
      short: shortReleaseLabel(version, series),
    };
    const group = groups.at(-1);
    if (group?.series === series) {
      group.releases.push(release);
    } else {
      groups.push({ series, releases: [release] });
    }
  }

  return groups;
}

const summaryLength = 160;

/** First prose paragraph of a guide, as plain text: the full sentences that
    fit in 160 characters, or a word cut with an ellipsis when none fits. */
export function guideSummary(markdown: string) {
  let paragraph: string[] = [];
  let fence: string | null = null;
  let summary = "";

  for (const rawLine of [...markdown.split("\n"), ""]) {
    const line = rawLine.trim();
    const fenceMatch = fencePattern.exec(rawLine);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1] : null;
      paragraph = [];
      continue;
    }
    if (fence !== null) continue;

    if (line === "") {
      const text = paragraph.join(" ");
      paragraph = [];
      if (text.length > 40) {
        summary = text;
        break;
      }
    } else if (paragraph.length > 0 || !/^(?:#|\||-|\*|>|\d+\.)/u.test(line)) {
      paragraph.push(line);
    }
  }

  const text = inlineText(summary || "Open the main Relmio guide.");
  if (text.length <= summaryLength) return text;

  const sentences = text.slice(0, summaryLength + 1).match(/^.*[.!?](?=\s)/u)?.[0];
  if (sentences) return sentences;
  const cut = text.lastIndexOf(" ", summaryLength);
  return `${text.slice(0, cut > 0 ? cut : summaryLength).replace(/[,;:.]$/u, "")}…`;
}

export type DocumentationSection = {
  /** Slug of the guide the section belongs to. */
  slug: string;
  /** Id the renderer gives the heading that starts the section. */
  id: string;
  heading: string;
  /** Everything the section shows, as plain text on one line. */
  text: string;
};

const tableRulePattern = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;
const linkDefinitionPattern = /^ {0,3}\[[^\]]+\]:\s/u;

/** A prose line as the reader sees it: no heading, quote, list or table
    markers and no link targets. */
function plainLine(line: string) {
  if (tableRulePattern.test(line) || linkDefinitionPattern.test(line)) return "";
  return inlineText(
    line
      .replace(/^ {0,3}#{1,6}[ \t]+/u, "")
      .replace(/^\s*(?:>\s*)*/u, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/u, "")
      .replaceAll("|", " "),
  );
}

/** A guide's sections for the docs search: one per h1, h2 and h3 heading,
    with the plain text up to the next of them. Deeper headings and code
    blocks stay in their section's text. */
export function markdownSections(markdown: string): Array<Omit<DocumentationSection, "slug">> {
  const sections: Array<{ id: string; heading: string; lines: string[] }> = [];

  for (const line of markdownLines(markdown)) {
    if (line.heading && line.heading.level <= 3) {
      const heading = inlineText(line.heading.text);
      sections.push({ id: slugify(heading), heading, lines: [] });
    } else {
      sections.at(-1)?.lines.push(line.code ? line.text : plainLine(line.text));
    }
  }

  return sections.map(({ id, heading, lines }) => ({
    id,
    heading,
    text: lines.join(" ").replace(/\s+/gu, " ").trim(),
  }));
}

/** Sections whose heading or text contains the query, ignoring case and extra
    spaces: heading matches first, then text matches, each in guide order. */
export function matchingSections(sections: readonly DocumentationSection[], query: string) {
  const needle = query.trim().toLowerCase().replace(/\s+/gu, " ");
  const inHeading: DocumentationSection[] = [];
  const inText: DocumentationSection[] = [];
  if (!needle) return inHeading;

  for (const section of sections) {
    if (section.heading.toLowerCase().includes(needle)) inHeading.push(section);
    else if (section.text.toLowerCase().includes(needle)) inText.push(section);
  }
  return [...inHeading, ...inText];
}

/** Link to the heading that starts a section, on its guide page. */
export function sectionHref({ slug, id }: Pick<DocumentationSection, "slug" | "id">) {
  return id ? `/docs/${slug}#${id}` : `/docs/${slug}`;
}
