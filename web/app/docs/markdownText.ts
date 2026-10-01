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

/** ATX headings outside fenced code blocks, in document order. */
function markdownHeadings(markdown: string) {
  const headings: Array<{ level: number; text: string }> = [];
  let fence: string | null = null;

  for (const line of markdown.split("\n")) {
    const fenceMatch = fencePattern.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const headingMatch = headingPattern.exec(line);
    if (headingMatch) {
      headings.push({ level: headingMatch[1].length, text: headingMatch[2] });
    }
  }

  return headings;
}

const outlineLimit = 14;

/** Section links for "On this page". Long guides list only their h2 sections
    so the outline stays short. */
export function markdownOutline(markdown: string): OutlineItem[] {
  const items = markdownHeadings(markdown)
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

  for (const heading of markdownHeadings(markdown)) {
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

/** First prose paragraph of a guide, as plain text, cut at a word boundary. */
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

  const cut = text.lastIndexOf(" ", summaryLength);
  return `${text.slice(0, cut > 0 ? cut : summaryLength).replace(/[,;:.]$/u, "")}…`;
}
