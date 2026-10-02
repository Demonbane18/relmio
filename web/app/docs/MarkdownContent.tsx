import type { Root as HastRoot, Element as HastElement } from "hast";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyableCodeBlock } from "./CopyableCodeBlock";
import { releaseId, slugify } from "./markdownText";
import { nodeText } from "./nodeText";

// Raw HTML inside the Markdown is not rendered. Do not add an HTML plugin.

const LINK_BLOCKS: Record<string, true> = { li: true, p: true, td: true, th: true };

/** A link that is the whole content of a list item, paragraph or table cell
    stands alone, so it gets the kit's 24 px standalone target. Links inside a
    sentence stay inline. */
function markStandaloneLinks() {
  const visit = (parent: HastRoot | HastElement) => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      if (LINK_BLOCKS[child.tagName]) {
        const content = child.children.filter((node) => node.type !== "text" || node.value.trim() !== "");
        const [only] = content;
        if (content.length === 1 && only.type === "element" && only.tagName === "a") {
          only.properties = { ...only.properties, className: ["rm-link--standalone"] };
        }
      }
      visit(child);
    }
  };
  return (tree: HastRoot) => visit(tree);
}

function headingId(children: ReactNode) {
  return slugify(nodeText(children)) || undefined;
}

/** Header cells of a Markdown table, joined into the name of its scroll
    region, so several tables on one page get distinct names. */
function tableLabel(table: HastElement | undefined) {
  const cells: string[] = [];
  const text = (node: HastElement["children"][number]): string =>
    node.type === "text" ? node.value : node.type === "element" ? node.children.map(text).join("") : "";
  const visit = (parent: HastElement) => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "th") cells.push(text(child).trim());
      else visit(child);
    }
  };
  if (table) visit(table);
  return cells.length > 0 ? `Table: ${cells.join(", ")}` : "Table";
}

const sharedComponents: Components = {
  pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock>,
  // Wide tables scroll sideways; the region takes focus so keyboards can scroll it.
  table: ({ node, children }) => (
    <div className="rm-table-wrap" tabIndex={0} role="region" aria-label={tableLabel(node)}>
      <table className="rm-table">{children}</table>
    </div>
  ),
};

const guideComponents: Components = {
  ...sharedComponents,
  h1: ({ children }) => (
    <h1 className="rm-h1" id={headingId(children)}>
      {children}
    </h1>
  ),
  h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
  h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
};

const changelogComponents: Components = {
  ...sharedComponents,
  // The page supplies its own title.
  h1: () => null,
  h2: ({ children }) => <h2 id={releaseId(nodeText(children))}>{children}</h2>,
};

/** A repository guide. Headings get the ids the outline links to. */
export function GuideMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[markStandaloneLinks]} components={guideComponents}>
      {content}
    </ReactMarkdown>
  );
}

/** CHANGELOG.md. Release headings get the ids the release list links to. */
export function ChangelogMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[markStandaloneLinks]} components={changelogComponents}>
      {content}
    </ReactMarkdown>
  );
}
